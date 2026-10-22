// S19: second, independently written sandbox family for the S10 read range
// capability. Construction and checking logic intentionally differ from
// tests/cli-file-read.test.mjs: random byte payloads are rebuilt from a seeded
// generator and compared against the original Buffer, not against literals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliSession } from '../dist/cli.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function payload(length, seed) {
  const buffer = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) buffer[index] = (seed * 31 + index * 17) % 251;
  return buffer;
}

async function scene(t) {
  const root = await mkdtemp(join(tmpdir(), 'nn-s19-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, session: createCliSession({ cwd: root, grantedEffects: ['filesystem.read'] }) };
}

test('S19 independent family: windows across a random payload reproduce the source bytes', async t => {
  const { root, session } = await scene(t);
  const original = payload(1000, 7);
  await writeFile(join(root, 'payload.bin'), original);
  for (const window of [[0, 1000], [7, 300], [999, 1], [1000, 0]]) {
    const result = await session.observe({ kind: 'read', path: 'payload.bin', offset: window[0], length: window[1] });
    assert.equal(result.ok, true);
    const actual = Buffer.from(result.observation.bytes, 'base64');
    assert.deepEqual(actual, original.subarray(window[0], window[0] + window[1]));
    assert.equal(result.observation.eof, false);
  }
});

test('S19 independent family: truncation between reads is observable, not silent', async t => {
  const { root, session } = await scene(t);
  await writeFile(join(root, 'grow.bin'), payload(500, 3));
  const first = await session.observe({ kind: 'read', path: 'grow.bin', offset: 0, length: 400 });
  assert.equal(first.ok, true);
  assert.equal(first.observation.eof, false);
  await writeFile(join(root, 'grow.bin'), payload(200, 4));
  const second = await session.observe({ kind: 'read', path: 'grow.bin', offset: 0, length: 400 });
  assert.equal(second.ok, true);
  assert.equal(second.observation.bytesRead, 200);
  assert.equal(second.observation.eof, true);
  assert.deepEqual(Buffer.from(second.observation.bytes, 'base64'), payload(200, 4));
});

test('S19 independent family: empty file and offset at EOF', async t => {
  const { root, session } = await scene(t);
  await writeFile(join(root, 'empty.bin'), Buffer.alloc(0));
  const empty = await session.observe({ kind: 'read', path: 'empty.bin', offset: 0, length: 10 });
  assert.equal(empty.ok, true);
  assert.equal(empty.observation.bytesRead, 0);
  assert.equal(empty.observation.eof, true);
  assert.equal(empty.observation.size, 0);
});

test('S19 independent family: authorization is required for reads', async t => {
  const { root } = await scene(t);
  await writeFile(join(root, 'f.bin'), 'x');
  const denied = await createCliSession({ cwd: root, grantedEffects: [] }).observe({ kind: 'read', path: 'f.bin', offset: 0, length: 1 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.stage, 'authorize');
  assert.equal(denied.error.code, 'EFFECT_DENIED');
});
