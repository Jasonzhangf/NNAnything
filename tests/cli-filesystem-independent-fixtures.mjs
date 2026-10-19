import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Independent fixture author. These recipes are not imported by fitting code.
export const VERIFICATION_RECIPES = [
  {
    id: 'v-four-depth-trailing', start: 'start', target: 'deep/a/b/c/target trailing ',
    files: ['line\nbreak', 'a"quote'], directories: ['child.one', 'child.two', 'third'], links: [],
  },
  {
    id: 'v-ancestor-alias-unicode', start: 'different/start/place', target: 'branch/x/y/z/中文',
    files: ['甲.txt', '同名', 'name with space'], directories: ['一', '二', '三', '四'], links: [],
    alias: 'ancestor alias', aliasTarget: 'branch/x',
  },
  {
    id: 'v-session-trajectory-links', start: 'trajectory/begin', target: 'trajectory/other/leaf \';$(touch injected-marker)',
    files: ['one', 'two', 'three', 'four'], directories: ['looks-like-file.ts', 'nested'],
    links: [['file-link', 'one'], ['dir-link', 'nested']],
  },
  {
    id: 'v-foreign-stale-two-branches', start: 'foreign/branch/a', target: 'current/branch/b/deep',
    files: ['looks-like-directory', 'same'], directories: ['folder.txt'], links: [],
    second: { path: 'second/branch/c', files: ['same'], directories: ['one', 'two'] },
  },
  {
    id: 'fresh-five-level-cd', start: 'origin/a', target: 'alternate/b/c/d/e/f/goal with quote "',
    files: ['fresh.txt', 'end '], directories: ['one', 'two'], links: [],
  },
  {
    id: 'fresh-multibranch-alias', start: 'source/left/deep', target: 'destination/right/deeper/终点',
    files: ['alpha', 'beta', 'gamma'], directories: ['四'], links: [],
    alias: 'fresh alias', aliasTarget: 'destination/right',
  },
  {
    id: 'fresh-rebound-trajectory', start: 'begin/level/one', target: 'finish/leaf $(touch injected-marker)',
    files: ['one', 'two'], directories: ['child', 'file.ts', 'nested'], links: [['fresh-link', 'one']],
  },
  {
    id: 'fresh-session-identity', start: 'left/branch/one/two', target: 'right/deep/three/four',
    files: ['same'], directories: ['a', 'b', 'c'], links: [],
    second: { path: 'middle/isolated', files: ['same', 'other'], directories: ['one'] },
  },
];

export async function createIndependentScene(index) {
  const recipe = VERIFICATION_RECIPES[index];
  const raw = await mkdtemp(join(tmpdir(), `nn-cli-independent-${index}-`));
  const root = await realpath(raw);
  try {
    const start = join(root, recipe.start), target = join(root, recipe.target);
    await mkdir(start, { recursive: true });
    await mkdir(target, { recursive: true });
    const expected = [];
    for (const name of recipe.files) {
      await writeFile(join(target, name), 'fixture bytes; model must not read this text');
      expected.push({ name, type: 'file' });
    }
    for (const name of recipe.directories) {
      await mkdir(join(target, name));
      await writeFile(join(target, name, 'not-a-direct-child'), 'descendant');
      expected.push({ name, type: 'directory' });
    }
    for (const [name, destination] of recipe.links) {
      await symlink(join(target, destination), join(target, name));
      expected.push({ name, type: 'symlink' });
    }
    let ancestorAlias;
    if (recipe.alias) {
      ancestorAlias = join(root, recipe.alias);
      await symlink(join(root, recipe.aliasTarget), ancestorAlias);
    }
    let second;
    if (recipe.second) {
      second = join(root, recipe.second.path);
      await mkdir(second, { recursive: true });
      for (const name of recipe.second.files) await writeFile(join(second, name), 'second fixture');
      for (const name of recipe.second.directories) await mkdir(join(second, name));
    } else {
      second = join(root, 'isolated/session/two');
      await mkdir(second, { recursive: true });
    }
    const file = join(root, 'ordinary-file');
    await writeFile(file, 'not a directory');
    const directLink = join(root, 'direct-target-link');
    await symlink(target, directLink);
    return { recipe, root, start, target, second, expected, ancestorAlias, file, directLink,
      cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
