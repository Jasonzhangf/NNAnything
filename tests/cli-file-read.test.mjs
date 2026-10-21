import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliSession } from '../dist/cli.js';
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
