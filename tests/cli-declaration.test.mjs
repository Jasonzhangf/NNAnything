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

// P1 fix: source/scope association. The manifest source must be inside the
// scope, relative references resolve against the manifest directory, and the
// source endpoint is retained on each reference.

test('P1 declaration: manifest outside scope is rejected, not silently resolved', () => {
  const body = JSON.stringify({ references: ['src/a.ts'] });
  const result = readDeclaredReferences({ manifestPath: '/outside/manifest.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.references, []);
  assert.ok(result.notes.includes('manifest_out_of_scope'));
});

test('P1 declaration: relative references resolve against the manifest directory', () => {
  const body = JSON.stringify({ references: ['src/a.ts', 'b.ts'] });
  const result = readDeclaredReferences({ manifestPath: '/pkg/sub/manifest.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.references.map(ref => ref.target), ['/pkg/sub/src/a.ts', '/pkg/sub/b.ts']);
  assert.ok(result.references.every(ref => ref.source === '/pkg/sub/manifest.json'));
});

test('P1 declaration: absolute target inside scope keeps source', () => {
  const body = JSON.stringify({ references: ['/pkg/lib/util.ts'] });
  const result = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(result.status, 'ok');
  assert.equal(result.references[0].target, '/pkg/lib/util.ts');
  assert.equal(result.references[0].source, '/pkg/manifest.json');
});

test('P1 declaration: non-absolute manifest or scope is rejected', () => {
  const body = JSON.stringify({ references: [] });
  const badManifest = readDeclaredReferences({ manifestPath: 'relative.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: '/pkg' });
  assert.equal(badManifest.status, 'rejected');
  assert.ok(badManifest.notes.includes('manifest_not_absolute'));
  const badScope = readDeclaredReferences({ manifestPath: '/pkg/manifest.json', bytes: Buffer.from(body), complete: true, referencesField: 'references', scopePrefix: 'relative' });
  assert.equal(badScope.status, 'rejected');
  assert.ok(badScope.notes.includes('scope_not_absolute'));
});
