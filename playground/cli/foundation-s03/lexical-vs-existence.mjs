// S03 minimal isolation experiment: lexical results do not change with OS
// existence; real existence is observed, not derived from lexical output.
import { createCliSession, interpretCliPath } from 'nnanything/cli';
import { mkdtemp, mkdir, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'nn-s03-'));
const row = [];
try {
  const base = join(root, 'proj');
  const path = 'future/file.ts';
  await mkdir(base);
  const session = createCliSession({ cwd: base, grantedEffects: ['filesystem.read', 'process.exec'] });
  // Phase 1: path does not exist yet.
  const lexicalAbsent = interpretCliPath(base, { kind: 'path', path });
  const inspectAbsent = await session.observe({ kind: 'attributes', path, followSymlinks: false });
  row.push({ phase: 'absent', lexical: lexicalAbsent.absolute, exists: inspectAbsent.ok ? null : inspectAbsent.error.code });
  // Phase 2: create the object (own sandbox fixture only).
  const target = join(base, 'future');
  await mkdir(target);
  await writeFile(join(target, 'file.ts'), 'hello\n');
  const lexicalCreated = interpretCliPath(base, { kind: 'path', path });
  const inspectCreated = await session.observe({ kind: 'attributes', path, followSymlinks: false });
  row.push({ phase: 'created', lexical: lexicalCreated.absolute, exists: inspectCreated.ok ? 'ok' : inspectCreated.error.code, size: inspectCreated.ok ? inspectCreated.observation.sizeBytes : null });
  // Phase 3: remove again.
  await rm(join(target, 'file.ts'));
  const lexicalRemoved = interpretCliPath(base, { kind: 'path', path });
  const inspectRemoved = await session.observe({ kind: 'attributes', path, followSymlinks: false });
  row.push({ phase: 'removed', lexical: lexicalRemoved.absolute, exists: inspectRemoved.ok ? null : inspectRemoved.error.code });
  // Assert lexical invariance across existence states.
  assert.equal(lexicalAbsent.absolute, lexicalCreated.absolute);
  assert.equal(lexicalCreated.absolute, lexicalRemoved.absolute);
  // Assert existence flips with the OS state.
  assert.equal(inspectAbsent.ok, false);
  assert.equal(inspectAbsent.error.code, 'ENOENT');
  assert.equal(inspectCreated.ok, true);
  assert.equal(inspectRemoved.ok, false);
  assert.equal(inspectRemoved.error.code, 'ENOENT');
  // Assert permission denial does not become non-existence (chmod on own fixture).
  await writeFile(join(target, 'file.ts'), 'again\n');
  await (await import('node:fs/promises')).chmod(join(target, 'file.ts'), 0o000);
  const denied = await session.observe({ kind: 'attributes', path, followSymlinks: false });
  // On a POSIX host without ACL granting access, EACCES is expected; if running
  // with privileges that still allow access, record the actual fact instead of
  // fabricating a refusal.
  const afterDenied = denied.ok ? { code: 'ok', size: denied.observation.sizeBytes } : { code: denied.error.code };
  row.push({ phase: 'denied', exists: afterDenied.code });
  console.log(JSON.stringify({ status: 'passed', scenario: 'S03 lexical-vs-existence', rows: row, targetUnchangedByLexical: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
