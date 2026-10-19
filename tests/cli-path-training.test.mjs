import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {makePathFixture,preparePathDataset,zeroPathProfile,fitPathController,runPathTraining,createPathResolver,
  createPathTrainingNodes} from '../dist/cli-training.js';
import {loadWorkflow,compileWorkflow,runWorkflow,createWorkflowInputEvent} from '../dist/index.js';

const backend='/Volumes/extension/code/handwired';
async function root(t){const dir=await mkdtemp(join(tmpdir(),'nnanything-path-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const resources=outputRoot=>({handwiredRoot:backend,outputRoot,grantedEffects:['filesystem.read','filesystem.write']});
const request=()=>({dataset:makePathFixture(),epochs:200,learningRate:0.1});

test('prepared fixture is reproducible and splits whole structure families, not renamed copies',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../playground/cli/path-resolve/samples.fixture.json',import.meta.url),'utf8'));
  assert.deepEqual(fixture,makePathFixture());
  const prepared=preparePathDataset(fixture);
  assert.deepEqual([prepared.train.length,prepared.development.length,prepared.holdout.length],[64,16,32]);
  assert.equal(new Set(prepared.dataset.samples.map(row=>row.sourceGroup)).size,14);
  const changed=structuredClone(fixture);changed.samples[0].expected='/wrong';
  assert.throws(()=>preparePathDataset(changed),/expected path/);
});

test('real Handwired fit improves autonomous paths; frozen parameters do not move; missing backend retains timing',async t=>{
  const prepared=preparePathDataset(makePathFixture()),initial=zeroPathProfile(),before=structuredClone(initial);
  const fit=await fitPathController({rows:prepared.rows,initial,handwiredRoot:backend,epochs:200,learningRate:0.1});
  assert.deepEqual(initial,before);assert.notDeepEqual(fit.profile.weights,initial.weights);
  assert.equal(fit.timing.completedEpochs,200);assert.equal(fit.timing.gradientRowEpochs,200*prepared.rows.length);
  const resolver=createPathResolver({profile:fit.profile});
  // Only train+development here. Formal holdout remains a separate one-shot consumer evaluation.
  for(const sample of [...prepared.train,...prepared.development]){
    const output=await resolver.resolve({cwd:sample.cwd,input:sample.input});
    assert.equal(output.ok,true,JSON.stringify(output));assert.equal(output.absolute,sample.expected);
  }
  const frozen=await fitPathController({rows:prepared.rows,initial,handwiredRoot:backend,epochs:0,learningRate:0.1});
  assert.deepEqual(frozen.profile,initial);assert.equal(frozen.timing.gradientRowEpochs,0);
  await assert.rejects(fitPathController({rows:prepared.rows,initial,handwiredRoot:'/definitely/missing/handwired',epochs:1,learningRate:0.1}),error=>{
    assert.match(error.message,/missing/i);assert.equal(error.timing.completedEpochs,0);assert.ok(error.timing.fitTotalMs>=0);return true;
  });
});

test('public training workflow fits, saves and reloads in a fresh process without model auto-adoption',async t=>{
  const outputRoot=await root(t),original=process.cwd();
  const receipt=await runPathTraining(request(),resources(outputRoot));
  assert.equal(receipt.accepted,true);
  for(const partition of Object.values(receipt.comparison)){
    assert.equal(partition.trained.exactPaths,partition.trained.sampleCount);
    assert.equal(partition.trained.correctTeacherSteps,partition.trained.teacherStepCount);
    assert.equal(partition.regressed,0);
  }
  const profile=JSON.parse(await readFile(receipt.paths.profile,'utf8'));
  assert.equal(profile.adoption,'not_applied');assert.equal(profile.calibration,'uncalibrated');
  const report=JSON.parse(await readFile(receipt.paths.report,'utf8'));
  assert.equal(report.frozen.parametersUnchanged,true);
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../playground/cli/path-resolve/reload.mjs',import.meta.url)),receipt.paths.profile,receipt.paths.samples],{shell:false,maxBuffer:16*1024*1024});
  const reload=JSON.parse(stdout);
  assert.equal(reload.exactPaths,112);
  assert.deepEqual(reload.rows,Object.values(receipt.comparison).flatMap(partition=>partition.trained.rows));
  assert.equal(process.cwd(),original);
});

test('effect authorization happens before fit and artifact roots cannot escape through symlinks',async t=>{
  const outputRoot=await root(t);
  await assert.rejects(runPathTraining(request(),{...resources(outputRoot),grantedEffects:['filesystem.read']}),/Unauthorized effect/);
  assert.deepEqual(await readdir(outputRoot),[]);
  const outside=await root(t);await symlink(outside,join(outputRoot,'samples'));
  await assert.rejects(runPathTraining({...request(),epochs:0},resources(outputRoot)),/not a link/);
  assert.deepEqual(await readdir(outside),[]);
});

test('create-new save refuses overwrite and reports already-written sample artifact',async t=>{
  const outputRoot=await root(t),runId='reused-run';
  const existing=join(outputRoot,'weights','path-resolve',runId);await mkdir(existing,{recursive:true});
  await writeFile(join(existing,'candidate.json'),'keep');
  const diagnostics={partialPaths:{}};
  const definitions=createPathTrainingNodes(resources(outputRoot),profile=>createPathResolver({profile}).resolve,diagnostics);
  const definition=await loadWorkflow({configPath:fileURLToPath(new URL('../workflows/cli-path-training.workflow.json',import.meta.url)),allowedRoot:fileURLToPath(new URL('../workflows/',import.meta.url))});
  const compiled=compileWorkflow(definition,{nodeDefinitions:definitions,grantedEffects:['filesystem.read','filesystem.write']});
  const result=await runWorkflow(compiled,createWorkflowInputEvent({runId,eventId:'input',port:'path_training_request',type:'cli.path.training-request.v1',payload:{...request(),epochs:0}}));
  assert.equal(result.status,'failed');assert.match(result.error.message,/EEXIST/);
  assert.equal(await readFile(join(existing,'candidate.json'),'utf8'),'keep');
  assert.ok(diagnostics.partialPaths.samples);assert.equal(diagnostics.partialPaths.profile,undefined);
});
