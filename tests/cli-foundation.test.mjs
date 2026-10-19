import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, stat, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';

const cli = () => import('../dist/cli.js');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnanything-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function observation(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.observation;
}

test('paths: explicit cwd, absolute/relative, parent/join, missing path, no expansion', async () => {
  const { interpretCliPath } = await cli();
  const cwd = '/workspace/代码 with spaces';
  const relative = interpretCliPath(cwd, {kind:'path',path:'./lib/../future.ts'});
  assert.equal(relative.inputForm, 'relative');
  assert.equal(relative.absolute, join(cwd, 'future.ts'));
  assert.equal(relative.parent, cwd);
  assert.equal(interpretCliPath(cwd,{kind:'path',path:'/a/../b'}).absolute, '/b');
  assert.equal(interpretCliPath(cwd,{kind:'path',path:'a',join:['b','..','c']}).absolute,join(cwd,'a/c'));
  assert.equal(interpretCliPath(cwd,{kind:'path',path:'/'}).parent, parse(cwd).root);
  assert.equal(interpretCliPath(cwd,{kind:'path',path:'~/$HOME/*.ts'}).absolute,join(cwd,'~/$HOME/*.ts'));
  for (const path of ['', 'x\0y']) assert.throws(() => interpretCliPath(cwd,{kind:'path',path}));
  assert.throws(() => interpretCliPath('relative',{kind:'path',path:'x'}));
});

test('pwd: actual fixed native command, isolated sessions, physical symlink cwd, parent cwd unchanged', async t => {
  const { createCliSession } = await cli();
  const root = await fixture(t), dir = join(root,'actual space '), link = join(root,'link');
  await mkdir(dir); await symlink(dir, link);
  const parent = process.cwd(), grants = ['filesystem.read','process.exec'];
  const a = createCliSession({cwd:link,grantedEffects:grants});
  const b = createCliSession({cwd:root,grantedEffects:grants});
  const [ra,rb] = await Promise.all([a.observe({kind:'pwd'}),b.observe({kind:'pwd'})]);
  const pa = observation(ra), pb = observation(rb);
  assert.equal(pa.executable, '/bin/pwd'); assert.deepEqual(pa.argv,['-P']);
  assert.equal(pa.configuredCwd,link); assert.equal(pa.physicalCwd, await realpath(dir));
  assert.equal(pa.stdout, pa.physicalCwd+'\n'); assert.equal(pa.exitCode,0);
  assert.equal(pb.physicalCwd,await realpath(root)); assert.equal(process.cwd(),parent);
  assert.equal(a.cwd,link);
});

test('attributes: real file bytes, directory, mode and OS timestamps', async t => {
  const { createCliSession } = await cli();
  const root = await fixture(t), file = join(root,'文档.txt');
  await writeFile(file,'你好\n'); await chmod(file,0o640);
  const session = createCliSession({cwd:root,grantedEffects:['filesystem.read']});
  const actual = observation(await session.observe({kind:'attributes',path:'文档.txt',followSymlinks:false}));
  const expected = await lstat(file);
  assert.equal(actual.type,'file'); assert.equal(actual.sizeBytes,Buffer.byteLength('你好\n'));
  for (const key of ['mode','uid','gid','atimeMs','mtimeMs','ctimeMs']) assert.equal(actual[key],expected[key],key);
  assert.equal(actual.observedWith,'lstat'); assert.equal(actual.absolutePath,file);
  assert.equal(observation(await session.observe({kind:'attributes',path:'.',followSymlinks:true})).type,'directory');
});

test('attributes: symlink versus target, dangling links and lexical path distinction', async t => {
  const { createCliSession, interpretCliPath } = await cli();
  const root = await fixture(t);
  await writeFile(join(root,'target'),'data');
  await symlink('target',join(root,'link')); await symlink('missing',join(root,'dangling'));
  const session = createCliSession({cwd:root,grantedEffects:['filesystem.read']});
  const own = observation(await session.observe({kind:'attributes',path:'link',followSymlinks:false}));
  assert.equal(own.type,'symlink'); assert.equal(own.linkTarget,'target');
  const target = observation(await session.observe({kind:'attributes',path:'link',followSymlinks:true}));
  assert.equal(target.type,'file'); assert.equal(target.sizeBytes,4); assert.equal(target.observedWith,'stat');
  assert.equal(observation(await session.observe({kind:'attributes',path:'dangling',followSymlinks:false})).type,'symlink');
  const failure = await session.observe({kind:'attributes',path:'dangling',followSymlinks:true});
  assert.equal(failure.ok,false); assert.equal(failure.error.code,'ENOENT');
  // Path interpretation is lexical, even though an OS lookup via link/.. may differ.
  assert.equal(interpretCliPath(root,{kind:'path',path:'link/../target'}).absolute,join(root,'target'));
});

test('failure: invalid requests, effect denial, OS failures, later requests unaffected', async t => {
  const { createCliSession } = await cli();
  const root = await fixture(t), pathOnly = createCliSession({cwd:root,grantedEffects:[]});
  assert.equal(observation(await pathOnly.observe({kind:'path',path:'not-created'})).absolute,join(root,'not-created'));
  for (const request of [{kind:'pwd'}, {kind:'attributes',path:'.',followSymlinks:false}]) {
    const result = await pathOnly.observe(request); assert.equal(result.ok,false); assert.equal(result.error.stage,'authorize');
  }
  const session = createCliSession({cwd:root,grantedEffects:['filesystem.read','process.exec']});
  for (const request of [{kind:'pwd',executable:'/bin/sh'}, {kind:'attributes',path:'.'}, {kind:'path',path:''}, {kind:'search',path:'.'}]) {
    const result = await session.observe(request); assert.equal(result.ok,false); assert.equal(result.error.stage,'validate');
  }
  const missing = await session.observe({kind:'attributes',path:'missing',followSymlinks:false});
  assert.equal(missing.ok,false); assert.equal(missing.error.code,'ENOENT');
  await writeFile(join(root,'file'),'a');
  const badCwd = createCliSession({cwd:join(root,'file'),grantedEffects:['filesystem.read','process.exec']});
  const bad = await badCwd.observe({kind:'pwd'}); assert.equal(bad.ok,false); assert.equal(bad.error.code,'ENOTDIR');
  assert.equal(observation(await session.observe({kind:'pwd'})).physicalCwd,await realpath(root));
  assert.throws(()=>createCliSession({cwd:'relative',grantedEffects:[]}));
});

test('public workflow: no shell injection, no target writes or cwd mutation', async t => {
  const { createCliSession } = await cli();
  const root = await fixture(t), child = join(root, '$(touch SENTINEL); literal "quotes"');
  await mkdir(child); await writeFile(join(child,'file'),'keep\0bytes');
  const before = await readdir(child), contents = await readFile(join(child,'file')), cwd = process.cwd();
  const session = createCliSession({cwd:child,grantedEffects:['filesystem.read','process.exec']});
  assert.equal(observation(await session.observe({kind:'pwd'})).physicalCwd,await realpath(child));
  observation(await session.observe({kind:'attributes',path:'file',followSymlinks:false}));
  assert.deepEqual(await readdir(child),before); assert.deepEqual(await readFile(join(child,'file')),contents);
  assert.deepEqual(await readdir(root),[child.slice(root.length+1)]); assert.equal(process.cwd(),cwd);
});
