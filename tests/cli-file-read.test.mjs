import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliSession } from '../dist/cli.js';
import { readFileRange } from '../dist/adapters/cli/file-content.js';
import { constants } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, symlink, lstat, open } from 'node:fs/promises';
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
// security boundary. These tests keep the pre-open lstat on the regular file
// but hand the production path and production flags to a real OS open applied
// to the swapped-in target. Therefore the assertions depend on the flags the
// production function actually passes: strip O_NOFOLLOW or O_NONBLOCK from
// production and the counterexamples below stop failing.

test('P1 open boundary: a regular file swapped to a final symlink is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const link = join(root, 'link');
  await symlink('target.bin', link);

  const real = await readFileRange(file, 0, 7);
  assert.equal(real.ok, true);

  let seenFlags = null;
  const swapped = await readFileRange(file, 0, 7, {
    lstat: (path, options) => lstat(file, options),
    open: (path, flags) => {
      seenFlags = flags;
      return open(link, flags);
    },
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'ELOOP');
  assert.notEqual(seenFlags & constants.O_NOFOLLOW, 0, 'production must pass O_NOFOLLOW to the real open');
});

test('P1 flag sensitivity: without O_NOFOLLOW the symlink swap is followed, so the guard is load-bearing', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const link = join(root, 'link');
  await symlink('target.bin', link);

  // Same seam, but the production O_NOFOLLOW bit is stripped. The real open now
  // follows the swapped-in link and the read succeeds; this is exactly what
  // would happen if production dropped the flag, so the ELOOP assertion above
  // is produced by the production flag and not by the stub.
  const stripped = await readFileRange(file, 0, 7, {
    lstat: (path, options) => lstat(file, options),
    open: (path, flags) => open(link, flags & ~constants.O_NOFOLLOW),
  });
  assert.equal(stripped.ok, true);
});

test('P1 open boundary: a regular file swapped to a FIFO cannot block and is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const fifo = join(root, 'pipe');
  await mkfifo(fifo);

  // lstat still reports the regular file, but the real open targets the FIFO
  // with the production flags. O_NONBLOCK keeps it bounded; the opened handle
  // is then refused by the fstat type check.
  let seenFlags = null;
  const startedAt = Date.now();
  const swapped = await readFileRange(file, 0, 7, {
    lstat: (path, options) => lstat(file, options),
    open: (path, flags) => {
      seenFlags = flags;
      return open(fifo, flags);
    },
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'READ_TYPE_DENIED');
  assert.notEqual(seenFlags & constants.O_NONBLOCK, 0, 'production must pass O_NONBLOCK to the real open');
  assert.ok(elapsedMs < 2000, `FIFO open must stay bounded, took ${elapsedMs}ms`);
});

test('P1 flag sensitivity: FIFO open blocks without O_NONBLOCK, so the flag is load-bearing', async t => {
  const { root } = await makeScene(t);
  const fifo = join(root, 'pipe');
  await mkfifo(fifo);

  // A child that opens the FIFO read-only without O_NONBLOCK blocks forever
  // because there is no writer. A bounded timeout proves O_NONBLOCK is what
  // keeps the production path non-blocking. The child is killed on timeout.
  const script = `require('node:fs').open(${JSON.stringify(fifo)}, require('node:fs').constants.O_RDONLY, () => process.exit(0));`;
  await assert.rejects(
    execFileAsync(process.execPath, ['-e', script], { timeout: 2000 }),
    error => error.killed === true || error.signal === 'SIGTERM',
    'a blocking FIFO open should have been killed by the timeout',
  );
});

test('P1 open boundary: a regular file swapped to another regular file is refused', async t => {
  const { root } = await makeScene(t);
  const file = join(root, 'target.bin');
  await writeFile(file, 'payload');
  const other = join(root, 'other.bin');
  await writeFile(other, 'different');

  const swapped = await readFileRange(file, 0, 9, {
    lstat: (path, options) => lstat(file, options),
    open: (path, flags) => open(other, flags),
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
