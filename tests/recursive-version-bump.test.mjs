import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('version bumper synchronizes the recursive graph with its actual shared module owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nn-recursive-bump-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['scripts','workflows','docs','lib/nodes','lib/workflow/recursive-goal']) await mkdir(join(root,dir),{recursive:true});
  await copyFile(new URL('../scripts/bump-version.mjs',import.meta.url),join(root,'scripts/bump-version.mjs'));
  const graph={id:'recursive-goal',version:'0.2.0',nodes:['bind','run','report'].map(id=>({operator:`goal.recursive.${id}`,operator_version:'0.2.0'}))};
  const graphPath=join(root,'workflows/recursive-goal.graph.json');
  const modulePath=join(root,'lib/workflow/recursive-goal/module.ts');
  await writeFile(graphPath,JSON.stringify(graph));
  await writeFile(modulePath,'const OPERATOR_VERSION = "0.2.0";\n');
  execFileSync(process.execPath,[join(root,'scripts/bump-version.mjs'),'workflows/recursive-goal.graph.json','--write']);
  const result=JSON.parse(await readFile(graphPath,'utf8'));
  assert.equal(result.version,'0.2.0.0001');
  assert.ok(result.nodes.every(n=>n.operator_version===result.version));
  assert.equal(await readFile(modulePath,'utf8'),'const OPERATOR_VERSION = "0.2.0.0001";\n');
});
