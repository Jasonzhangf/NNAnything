import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliSession } from '../dist/cli.js';
import { readFileRange } from '../dist/adapters/cli/file-content.js';
import { constants } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const mkfifo = path => execFileAsync('/usr/bin/mkfifo', [path]);

// S10: content.bytes read range contract. Red test first (no read request kind yet).

async function makeScene(t) {
  const root = await mkdtemp(join(tmpdir(), 'nn-s10-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, session: createCliSession({ cwd: root, grantedEffects: ['filesystem.read', 'process.exec'] }) };
}

test('S10 read returns base64 bytes for an explicit range of a regular file', async t => {
  const { root, session } = await makeScene(t);
  const file = join(root, 'bin.dat');
  await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const result = await session.observe({ kind: 'read', path: 'bin.dat', offset: 1, length: 3 });
  assert.equal(result.ok, true);
  const observation = result.observation;
  assert.equal(observation.kind, 'read');
  assert.equal(observation.bytesRead, 3);
  assert.equal(observation.eof, false);
  assert.deepEqual(Buffer.from(observation.bytes, 'base64'), Buffer.from([0x01, 0x02, 0xff]));
});

test('S10 read past EOF reports eof and fewer bytes', async t => {
  const { root, session } = await makeScene(t);
  await writeFile(join(root, 'small.txt'), 'abc');
  const result = await session.observe({ kind: 'read', path: 'small.txt', offset: 1, length: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.observation.bytesRead, 2);
  assert.equal(result.observation.eof, true);
  assert.equal(result.observation.bytes, Buffer.from('bc').toString('base64'));
});

test('S10 zero-length read is legal and does not claim EOF by itself', async t => {
  const { root, session } = await makeScene(t);
  await writeFile(join(root, 'zero.txt'), 'abc');
  const result = await session.observe({ kind: 'read', path: 'zero.txt', offset: 0, length: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.observation.bytesRead, 0);
  assert.equal(result.observation.bytes, '');
});

test('S10 refuses non-regular entries (fifo/socket/device) and final symlinks', async t => {
  const { root, session } = await makeScene(t);
  await mkfifo(join(root, 'pipe'));
  const fifo = await session.observe({ kind: 'read', path: 'pipe', offset: 0, length: 1 });
  assert.equal(fifo.ok, false);
  await symlink('real.txt', join(root, 'link'));
  const link = await session.observe({ kind: 'read', path: 'link', offset: 0, length: 1 });
  assert.equal(link.ok, false);
  const missing = await session.observe({ kind: 'read', path: 'missing', offset: 0, length: 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'ENOENT');
});

test('S10 refuses invalid offset/length', async t => {
  const { root, session } = await makeScene(t);
  await writeFile(join(root, 'f.txt'), 'x');
  for (const bad of [{ offset: -1, length: 1 }, { offset: 0, length: -1 }]) {
    const result = await session.observe({ kind: 'read', path: 'f.txt', offset: bad.offset, length: bad.length });
    assert.equal(result.ok, false);
    assert.equal(result.error.stage, 'validate');
  }
});

// P1 fix: open boundary counterexamples. The pre-open lstat is not the
// security boundary; the fixed open strategy (O_NOFOLLOW, O_NONBLOCK,
// dev/ino comparison) must refuse every swap between lstat and open.

test('P1 open boundary: a regular file swapped to a final symlink is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const link = join(root, 'link');
  await symlink('target.bin', link);

  // Real OS: lstat sees the regular file, O_NOFOLLOW rejects the link.
  const real = await readFileRange(file, 0, 7);
  assert.equal(real.ok, true);

  const swapped = await readFileRange(file, 0, 7, {
    lstat: async (path, options) => (await import('node:fs/promises')).lstat(file, options),
    open: async () => {
      const error = Object.assign(new Error('ELOOP: too many symbolic links encountered'), { code: 'ELOOP' });
      throw error;
    },
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'ELOOP');
});

test('P1 open boundary: a regular file swapped to a FIFO cannot block and is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const fifo = join(root, 'pipe');
  await mkfifo(fifo);

  // lstat still reports the regular file, but the open target is a FIFO.
  const swapped = await readFileRange(file, 0, 7, {
    lstat: async (path, options) => (await import('node:fs/promises')).lstat(file, options),
    open: async () => (await import('node:fs/promises')).open(fifo, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'READ_TYPE_DENIED');
});

test('P1 open boundary: a regular file swapped to another regular file is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const other = join(root, 'other.bin');
  await writeFile(other, 'different');

  const swapped = await readFileRange(file, 0, 9, {
    lstat: async (path, options) => (await import('node:fs/promises')).lstat(file, options),
    open: async () => (await import('node:fs/promises')).open(other, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'READ_TARGET_CHANGED');
});

test('P1 open boundary: the real open refuses a final symlink end-to-end', async t => {
  const { root, session } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  await symlink('target.bin', join(root, 'final-link'));
  const result = await session.observe({ kind: 'read', path: 'final-link', offset: 0, length: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.stage, 'observe');
  assert.equal(result.error.code, 'ELOOP');
});
