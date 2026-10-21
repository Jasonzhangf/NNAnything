// S18: read-only combination consumer. Composes lexical path, existence/type
// inspection, range read and directory listing inside one own sandbox. It does
// not train a selector; the shared policy is only regressed separately.
//
// P1 fix: every observation is asserted against exact values (bytes, error
// stages, listing coverage, unchanged bytes), the hard-link check compares
// dev/ino (same object), and any failure exits non-zero via assert.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliSession, interpretCliPath } from 'nnanything/cli';
import { observeDirectoryListing } from '../../../dist/adapters/cli/directory-listing.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-s18-')));
const facts = {};
try {
  const docs = join(root, 'docs');
  await mkdir(docs);
  await writeFile(join(docs, 'notes.md'), '# hello\n');
  await writeFile(join(docs, '.hidden'), 'h');
  await symlink('notes.md', join(docs, 'soft.md'));
  await link(join(docs, 'notes.md'), join(docs, 'hard.md'));
  const session = createCliSession({ cwd: docs, grantedEffects: ['filesystem.read', 'process.exec'] });

  // 1. Lexical resolution of a not-yet-existing path: exists must be ENOENT.
  const lexical = interpretCliPath(docs, { kind: 'path', path: 'future/new.md' });
  assert.equal(lexical.absolute, join(docs, 'future/new.md'));
  const missing = await session.observe({ kind: 'attributes', path: 'future/new.md', followSymlinks: false });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'ENOENT');
  facts.lexicalButMissing = { absolute: lexical.absolute, code: missing.error.code };

  // 2. exists + type + read of a regular file: exact bytes and metadata.
  const inspect = await session.observe({ kind: 'attributes', path: 'notes.md', followSymlinks: false });
  assert.equal(inspect.ok, true);
  assert.equal(inspect.observation.type, 'file');
  assert.equal(inspect.observation.sizeBytes, 8); // '# hello\n'
  const read = await session.observe({ kind: 'read', path: 'notes.md', offset: 2, length: 5 });
  assert.equal(read.ok, true);
  assert.equal(read.observation.bytesRead, 5);
  assert.equal(Buffer.from(read.observation.bytes, 'base64').toString('utf8'), 'hello');
  facts.regular = { type: inspect.observation.type, sizeBytes: inspect.observation.sizeBytes, bytes: 'hello' };

  // 3. Symlink follows to the same regular object: type is file.
  const softFollow = await session.observe({ kind: 'attributes', path: 'soft.md', followSymlinks: true });
  assert.equal(softFollow.ok, true);
  assert.equal(softFollow.observation.type, 'file');
  assert.equal(softFollow.observation.sizeBytes, 8);
  facts.symlinkFollow = { type: softFollow.observation.type, sizeBytes: softFollow.observation.sizeBytes };

  // 4. Hard link: same object, different path — identity by dev/ino, not by name.
  const a = await session.observe({ kind: 'attributes', path: 'notes.md', followSymlinks: false });
  const b = await session.observe({ kind: 'attributes', path: 'hard.md', followSymlinks: false });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // attributes does not expose dev/ino; verify identity at the OS level.
  const sa = await lstat(join(docs, 'notes.md'));
  const sb = await lstat(join(docs, 'hard.md'));
  assert.equal(sa.dev, sb.dev);
  assert.equal(sa.ino, sb.ino);
  assert.equal(a.observation.sizeBytes, b.observation.sizeBytes);
  facts.hardLink = { sameDev: sa.dev === sb.dev, sameIno: sa.ino === sb.ino, sameSize: a.observation.sizeBytes === b.observation.sizeBytes };

  // 5. Explicit failure keeps a real, separate error (no fake success).
  const denied = await createCliSession({ cwd: docs, grantedEffects: [] }).observe({ kind: 'read', path: 'notes.md', offset: 0, length: 1 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.stage, 'authorize');
  assert.equal(denied.error.code, 'EFFECT_DENIED');
  facts.denied = { stage: denied.error.stage, code: denied.error.code };

  // 6. Directory listing stays local and never recurses: exact direct names.
  const listing = await observeDirectoryListing({ configuredDirectory: docs, physicalDirectory: docs });
  assert.equal(listing.ok, true);
  assert.equal(listing.observation.coverage, 'complete');
  const names = listing.observation.entries.map(entry => entry.name).sort();
  assert.deepEqual(names, ['.hidden', 'hard.md', 'notes.md', 'soft.md']);
  facts.listing = { names, coverage: listing.observation.coverage };

  // 7. No writes: exact tree and exact bytes after the whole combination.
  const diskNames = (await readdir(docs)).sort();
  assert.deepEqual(diskNames, ['.hidden', 'hard.md', 'notes.md', 'soft.md']);
  const afterRead = await session.observe({ kind: 'read', path: 'notes.md', offset: 0, length: 100 });
  assert.equal(afterRead.ok, true);
  assert.equal(afterRead.observation.bytesRead, 8);
  assert.equal(Buffer.from(afterRead.observation.bytes, 'base64').toString('utf8'), '# hello\n');
  facts.noWrites = { names: diskNames, bytesUnchanged: true, bytesRead: afterRead.observation.bytesRead };

  console.log(JSON.stringify({ status: 'passed', facts }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
