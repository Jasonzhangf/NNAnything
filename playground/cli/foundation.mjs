import { createCliSession, interpretCliPath } from 'nnanything/cli';
import { mkdtemp, mkdir, writeFile, symlink, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'nnanything-cli-consumer-'));
try {
  const directory = join(root, 'docs 资料');
  await mkdir(directory);
  await writeFile(join(directory, 'example.txt'), 'CLI foundation\n');
  await symlink('example.txt', join(directory, 'link'));
  const session = createCliSession({ cwd: directory, grantedEffects: ['filesystem.read', 'process.exec'] });
  const requests = [{ kind: 'pwd' }, { kind: 'path', path: '../future/file.txt' },
    { kind: 'attributes', path: 'example.txt', followSymlinks: false },
    { kind: 'attributes', path: 'link', followSymlinks: false },
    { kind: 'attributes', path: 'link', followSymlinks: true }];
  const before = await readFile(join(directory,'example.txt'));
  const entries = await readdir(directory), parentCwd = process.cwd();
  const results = [];
  for (const request of requests) {
    const result = await session.observe(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    results.push(result.observation);
  }
  assert.equal(results[0].physicalCwd,await realpath(directory));
  assert.equal(results[1].absolute,join(root,'future/file.txt'));
  assert.equal(results[2].sizeBytes,15);
  assert.equal(results[3].type,'symlink'); assert.equal(results[4].type,'file');
  assert.equal(interpretCliPath(directory,{kind:'path',path:'not-created'}).absolute,join(directory,'not-created'));
  const missing = await session.observe({kind:'attributes',path:'missing',followSymlinks:false});
  assert.equal(missing.ok,false); assert.equal(missing.error.code,'ENOENT');
  const denied = await createCliSession({cwd:directory,grantedEffects:[]}).observe({kind:'pwd'});
  assert.equal(denied.ok,false); assert.equal(denied.error.stage,'authorize');
  assert.deepEqual(await readFile(join(directory,'example.txt')),before);
  assert.deepEqual(await readdir(directory),entries); assert.equal(process.cwd(),parentCwd);
  console.log(JSON.stringify({status:'passed',capabilities:['pwd','path','attributes'],observations:results,missing,denied,noTargetWrites:true,parentCwdUnchanged:true},null,2));
} finally { await rm(root,{recursive:true,force:true}); }
