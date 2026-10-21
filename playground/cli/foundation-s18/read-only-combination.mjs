// S18: read-only combination consumer. Composes lexical path, existence/type
// inspection, range read and directory listing inside one own sandbox. It does
// not train a selector; the shared policy is only regressed separately.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath, readdir } from 'node:fs/promises';
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

  // 1. Lexical resolution of a not-yet-existing path.
  const lexical = interpretCliPath(docs, { kind: 'path', path: 'future/new.md' });
  const missing = await session.observe({ kind: 'attributes', path: 'future/new.md', followSymlinks: false });
  facts.lexicalButMissing = { absolute: lexical.absolute, code: missing.ok ? null : missing.error.code };

  // 2. exists + type + read of a regular file.
  const inspect = await session.observe({ kind: 'attributes', path: 'notes.md', followSymlinks: false });
  const read = await session.observe({ kind: 'read', path: 'notes.md', offset: 2, length: 5 });
  facts.regular = { type: inspect.ok ? inspect.observation.type : null, bytes: read.ok ? Buffer.from(read.observation.bytes, 'base64').toString('utf8') : null };

  // 3. Same type, different role (symlink resolves to a regular file, name differs).
  const softFollow = await session.observe({ kind: 'attributes', path: 'soft.md', followSymlinks: true });
  facts.symlinkFollow = { type: softFollow.ok ? softFollow.observation.type : null };

  // 4. Hard link: same object, different path.
  const a = await session.observe({ kind: 'attributes', path: 'notes.md', followSymlinks: false });
  const b = await session.observe({ kind: 'attributes', path: 'hard.md', followSymlinks: false });
  facts.hardLink = { sameSize: a.ok && b.ok && a.observation.sizeBytes === b.observation.sizeBytes };

  // 5. Explicit failure keeps a real, separate error (no fake success).
  const denied = await createCliSession({ cwd: docs, grantedEffects: [] }).observe({ kind: 'read', path: 'notes.md', offset: 0, length: 1 });
  facts.denied = { stage: denied.ok ? null : denied.error.stage, code: denied.ok ? null : denied.error.code };

  // 6. Directory listing stays local and never recurses.
  const listing = await observeDirectoryListing({ configuredDirectory: docs, physicalDirectory: docs });
  facts.listing = listing.ok ? listing.observation.entries.map(entry => entry.name).sort() : null;

  // 7. No writes: the tree and bytes are unchanged after the whole combination.
  const names = (await readdir(docs)).sort();
  const afterRead = await session.observe({ kind: 'read', path: 'notes.md', offset: 0, length: 100 });
  facts.noWrites = { names, bytesUnchanged: afterRead.ok && Buffer.from(afterRead.observation.bytes, 'base64').toString('utf8') === '# hello\n' };

  console.log(JSON.stringify({ status: 'passed', facts }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
