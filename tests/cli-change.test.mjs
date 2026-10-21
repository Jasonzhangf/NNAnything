import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from '../dist/filters/cli-change.js';

// S17: reproducible change comparison. Key counterexamples:
// - identical mtime never proves byte equality;
// - object replacement with no byte coverage is unknown, not changed;
// - different references are unknown.

function snap(over = {}) {
  return {
    path: '/a/f.txt',
    size: 5,
    mtimeMs: 100,
    dev: '1',
    ino: '2',
    bytes: 'aGVsbG8=', // "hello"
    coverageComplete: true,
    ...over,
  };
}

test('S17 unchanged when nothing observed differs', () => {
  const r = compareSnapshots('/a/f.txt', snap(), snap());
  assert.equal(r.status, 'unchanged');
  assert.equal(r.changed, false);
  assert.equal(r.bytesSame, true);
  assert.equal(r.identitySame, true);
});

test('S17 bytes changed with same size and same mtime is still changed', () => {
  const before = snap({ bytes: Buffer.from('hello').toString('base64'), size: 5, mtimeMs: 100 });
  const after = snap({ bytes: Buffer.from('olleh').toString('base64'), size: 5, mtimeMs: 100 });
  const r = compareSnapshots('/a/f.txt', before, after);
  assert.equal(r.status, 'changed');
  assert.equal(r.mtimeSame, true);
  assert.equal(r.bytesSame, false);
  assert.ok(r.reasons.includes('bytes_changed'));
});

test('S17 mtime changed but bytes same is changed by mtime, bytes not proof of unimpaired', () => {
  const before = snap({ bytes: Buffer.from('hello').toString('base64') });
  const after = snap({ bytes: Buffer.from('hello').toString('base64'), mtimeMs: 200 });
  const r = compareSnapshots('/a/f.txt', before, after);
  assert.equal(r.status, 'changed');
  assert.equal(r.mtimeSame, false);
  assert.equal(r.bytesSame, true);
});

test('S17 identical mtime does not prove bytes unchanged (partial coverage unknown)', () => {
  const before = snap({ bytes: Buffer.from('hello').toString('base64'), coverageComplete: true });
  const after = snap({ bytes: Buffer.from('hello').toString('base64'), coverageComplete: false, mtimeMs: 100 });
  const r = compareSnapshots('/a/f.txt', before, after);
  // mtime same and identity same, but after has no full byte coverage: the
  // claim "bytes unchanged" cannot be established from mtime alone.
  assert.equal(r.bytesSame, null);
  assert.ok(r.reasons.includes('bytes_not_fully_observed'));
  assert.equal(r.status, 'unknown');
});

test('S17 object replaced without byte coverage is unknown', () => {
  const before = snap({ dev: '1', ino: '2', bytes: null, coverageComplete: false });
  const after = snap({ dev: '1', ino: '9', bytes: null, coverageComplete: false });
  const r = compareSnapshots('/a/f.txt', before, after);
  assert.equal(r.status, 'unknown');
  assert.ok(r.reasons.includes('object_replaced'));
  assert.ok(r.reasons.includes('bytes_not_fully_observed'));
});

test('S17 object replaced with full byte coverage is changed', () => {
  const before = snap({ dev: '1', ino: '2' });
  const after = snap({ dev: '1', ino: '9', bytes: Buffer.from('world').toString('base64') });
  const r = compareSnapshots('/a/f.txt', before, after);
  assert.equal(r.status, 'changed');
  assert.equal(r.bytesSame, false);
});

test('S17 identity unobserved and no other fact is unknown', () => {
  const before = snap({ dev: null, ino: null });
  const after = snap({ dev: null, ino: null });
  const r = compareSnapshots('/a/f.txt', before, after);
  assert.equal(r.status, 'unknown');
  assert.ok(r.reasons.includes('identity_unobserved'));
});

test('S17 different references are unknown', () => {
  const r = compareSnapshots('/a/f.txt', snap(), snap({ path: '/a/g.txt' }));
  assert.equal(r.status, 'unknown');
  assert.ok(r.reasons.includes('reference_mismatch'));
});
