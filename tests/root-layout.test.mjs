import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = new URL('../', import.meta.url);
async function fixture(t, { gitDirectory = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nnanything-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  await copyFile(new URL('AGENTS.md', repo), join(root, 'AGENTS.md'));
  const pkg = JSON.parse(await readFile(new URL('package.json', repo), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: pkg.scripts.build } }));
  await writeFile(join(root, 'node_modules/.bin/tsc'), '#!/usr/bin/env node\nrequire("node:fs").mkdirSync("dist",{recursive:true});require("node:fs").writeFileSync("dist/compiler-ran","yes");\n', { mode: 0o755 });
  if (gitDirectory) await mkdir(join(root, '.git'));
  else await writeFile(join(root, '.git'), 'gitdir: fixture');
  try { await copyFile(new URL('scripts/check-layout.mjs', repo), join(root, 'scripts/check-layout.mjs')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return root;
}
const build = root => spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });

test('registered root subsets compile with git file or directory', async t => {
  for (const gitDirectory of [false, true]) {
    const root = await fixture(t, { gitDirectory });
    await mkdir(join(root, 'artifacts'));
    const result = build(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(join(root, 'dist/compiler-ran'), 'utf8'), 'yes');
  }
});

test('build rejects unregistered root entries before compilation without deleting them', async t => {
  for (const [name, directory] of [['unexpected.txt', false], ['unregistered-output', true], ['.unregistered', false]]) {
    const root = await fixture(t);
    if (directory) await mkdir(join(root, name));
    else await writeFile(join(root, name), 'preserve');
    const result = build(root);
    assert.notEqual(result.status, 0, 'unregistered root entry must reject the real npm build');
    assert.ok((result.stdout + result.stderr).includes(join(root, name)));
    assert.match(result.stdout + result.stderr, /AGENTS\.md/);
    await access(join(root, name));
    await assert.rejects(access(join(root, 'dist/compiler-ran')), { code: 'ENOENT' });
  }
});

test('build rejects missing or empty registration instead of compiling', async t => {
  for (const text of ['# No registration', '<!-- root-layout:start -->\n```text\n```\n<!-- root-layout:end -->']) {
    const root = await fixture(t);
    await writeFile(join(root, 'AGENTS.md'), text);
    const result = build(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /root-layout|registration/);
    await assert.rejects(access(join(root, 'dist/compiler-ran')), { code: 'ENOENT' });
  }
});
