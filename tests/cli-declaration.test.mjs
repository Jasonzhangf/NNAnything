import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeclaredReferences } from '../dist/filters/cli-declaration.js';

// S15: declaration-based reference edges. Deterministic (D). Only explicit
// declared fields count; same-named strings elsewhere are not references.
// No script execution; partial coverage never claims "no references".

const manifest = JSON.stringify({
  name: 'demo',
  references: ['src/a.ts', 'src/b.ts'],
  notes: ['src/a.ts'],
});

test('S15 only the declared field yields reference edges', () => {
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from(manifest), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.references.map(ref => ref.target), ['/pkg/src/a.ts', '/pkg/src/b.ts']);
  assert.equal(result.references.length, 2); // notes[] not counted
  assert.equal(result.coverage, 'complete');
});

test('S15 partial coverage does not claim no references', () => {
  const truncated = manifest.slice(0, 20);
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from(truncated), complete: false, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.coverage, 'partial');
  assert.equal(result.status, 'unknown');
});

test('S15 out-of-scope target is rejected', () => {
  const body = JSON.stringify({ references: ['/etc/passwd'] });
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.references, []);
});

test('S15 non-json bytes keep unknown, no execution', () => {
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from('%PDF-1.7'), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.references, []);
});

test('S15 missing declared field keeps unknown without guessing', () => {
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from('{}'), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.references, []);
});
