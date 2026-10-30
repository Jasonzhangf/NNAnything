import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BASE_GRANTS = Object.freeze([
  'filesystem.read',
  'process.exec',
  'session.write',
]);

function typeOf(attributes) {
  if (attributes.isFile()) return 'file';
  if (attributes.isDirectory()) return 'directory';
  if (attributes.isSymbolicLink()) return 'symlink';
  if (attributes.isFIFO()) return 'fifo';
  if (attributes.isSocket()) return 'socket';
  if (attributes.isCharacterDevice()) return 'character_device';
  if (attributes.isBlockDevice()) return 'block_device';
  return 'other';
}

export async function treeSnapshot(root, prefix = '') {
  const rows = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = join(prefix, name);
    const attributes = await lstat(join(root, relative));
    rows.push({
      path: relative,
      type: typeOf(attributes),
      size: attributes.size,
      mode: attributes.mode,
    });
    if (attributes.isDirectory()) rows.push(...await treeSnapshot(root, relative));
  }
  return rows;
}

export async function createIndependentScene(api, t, options = {}) {
  const root = await realpath(await mkdtemp('/tmp/nn-i7-'));
  const scenarioId = `i7-${randomUUID()}`;
  const grants = options.grants ?? BASE_GRANTS;
  const server = createServer();
  let socketListening = false;
  let socketAvailable = false;
  let cleaned = false;
  let sandbox;

  try {
    sandbox = await api.createCliFilesystemSandbox({
      root,
      ownerGrantedEffects: ['filesystem.write'],
      ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
      recipe: {
        scenarioId,
        entries: [
          { path: 'start', kind: 'directory' },
          { path: 'start/dir', kind: 'directory' },
          { path: 'start/nested', kind: 'directory' },
          { path: 'sibling', kind: 'directory' },
          { path: 'sibling/select-sandbox', kind: 'directory' },
          { path: 'sibling/select-sandbox/alpha-dir', kind: 'directory' },
          { path: 'sibling/select-sandbox/humanagent', kind: 'directory' },
          { path: 'sibling/select-sandbox/with space dir', kind: 'directory' },
          { path: "sibling/select-sandbox/quote'dir", kind: 'directory' },
          { path: 'sibling/select-sandbox/.hidden-dir', kind: 'directory' },
          { path: 'sibling/select-sandbox/notes.txt', kind: 'file', contents: 'opaque notes' },
          { path: 'sibling/select-sandbox/empty.bin', kind: 'file', contents: '' },
          { path: 'sibling/select-sandbox/with space.txt', kind: 'file', contents: 'space file' },
          { path: "sibling/select-sandbox/quote'file.txt", kind: 'file', contents: 'quote file' },
          { path: 'sibling/select-sandbox/.hidden-file', kind: 'file', contents: 'hidden file' },
          { path: 'start/file.txt', kind: 'file', contents: 'payload' },
          { path: 'start/nested/deep.txt', kind: 'file', contents: 'deep' },
        ],
        sessions: [
          { id: 'primary', cwd: 'start', grantedEffects: grants },
          { id: 'secondary', cwd: 'sibling', grantedEffects: BASE_GRANTS },
        ],
      },
    });

    const primary = sandbox.bindSession('primary');
    const secondary = sandbox.bindSession('secondary');
    const start = sandbox.getSession(primary).cwd;
    const sibling = sandbox.getSession(secondary).cwd;
    const selectSandbox = join(sibling, 'select-sandbox');
    const paths = {
      start,
      sibling,
      selectSandbox,
      directory: join(start, 'dir'),
      file: join(start, 'file.txt'),
      nested: join(start, 'nested'),
      deepFile: join(start, 'nested', 'deep.txt'),
      missing: join(start, 'missing.txt'),
      link: join(start, 'file-link'),
      hopLink: join(start, 'hop-link'),
      dirLink: join(start, 'dir-link'),
      brokenLink: join(start, 'broken-link'),
      loopA: join(start, 'loop-a'),
      loopB: join(start, 'loop-b'),
      fifo: join(start, 'named-pipe'),
      socket: join(start, 'local.sock'),
      bigFile: join(start, 'big.bin'),
      selectLinkToDir: join(selectSandbox, 'link-to-dir'),
      selectLinkToFile: join(selectSandbox, 'link-to-file'),
      selectDanglingLink: join(selectSandbox, 'dangling-link'),
      selectFifo: join(selectSandbox, 'select-fifo'),
    };

    await symlink('file.txt', paths.link);
    await symlink('file-link', paths.hopLink);
    await symlink('nested', paths.dirLink);
    await symlink('missing-target', paths.brokenLink);
    await symlink('loop-b', paths.loopA);
    await symlink('loop-a', paths.loopB);
    await execFileAsync('mkfifo', [paths.fifo]);
    await symlink('alpha-dir', paths.selectLinkToDir);
    await symlink('notes.txt', paths.selectLinkToFile);
    await symlink('missing-select-target', paths.selectDanglingLink);
    await execFileAsync('mkfifo', [paths.selectFifo]);

    try {
      await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(paths.socket, () => {
          server.off('error', onError);
          socketListening = true;
          socketAvailable = true;
          resolve();
        });
      });
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
    }

    const scene = {
      root,
      sandbox,
      scenarioId,
      primary,
      secondary,
      paths,
      socketAvailable,
      async makeSparseFile(size) {
        await writeFile(paths.bigFile, '');
        await execFileAsync('truncate', ['-s', String(size), paths.bigFile]);
        return paths.bigFile;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (socketListening) await new Promise(resolve => server.close(resolve));
        if (sandbox) await sandbox.cleanup();
        await rm(root, { recursive: true, force: true });
      },
    };
    t.after(() => scene.cleanup());
    return scene;
  } catch (error) {
    if (socketListening) await new Promise(resolve => server.close(resolve));
    if (sandbox) await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function pathRef(sandbox, session, path) {
  return sandbox.bindPath(session, path);
}

export function entryQuery(ref, followSymlinks) {
  return Object.freeze({ kind: 'cli.entry-query', ref, followSymlinks });
}

