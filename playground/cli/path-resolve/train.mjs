import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { preparePathDataset, runPathTraining } from 'nnanything/cli-training';

const values=new Map();
const args=process.argv.slice(2),allowed=['--handwired-root','--output-root','--samples','--epochs','--learning-rate'];
for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||args[i+1]===undefined||values.has(args[i]))throw new Error('Usage: train.mjs --handwired-root PATH [--output-root PATH] [--samples FILE] [--epochs N] [--learning-rate N]');values.set(args[i],args[i+1]);}
if(!values.has('--handwired-root'))throw new Error('--handwired-root is required; no implicit or copied backend');
const source=values.get('--samples')??fileURLToPath(new URL('./samples.fixture.json',import.meta.url));
const dataset=JSON.parse(await readFile(source,'utf8'));
const prepared=preparePathDataset(dataset);
const outputRoot=values.get('--output-root')??fileURLToPath(new URL('../../../training/',import.meta.url));
const started=performance.now();
try{
  const receipt=await runPathTraining({dataset,epochs:Number(values.get('--epochs')??200),learningRate:Number(values.get('--learning-rate')??0.1)},
    {handwiredRoot:values.get('--handwired-root'),outputRoot,grantedEffects:['filesystem.read','filesystem.write']});
  const trainingWorkflowMs=performance.now()-started;
  const reloadStarted=performance.now();
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./reload.mjs',import.meta.url)),receipt.paths.profile,receipt.paths.samples],{shell:false,maxBuffer:16*1024*1024});
  const reloaded=JSON.parse(stdout),reloadMs=performance.now()-reloadStarted;
  const actual=[...receipt.comparison.train.trained.rows,...receipt.comparison.development.trained.rows,...receipt.comparison.holdout.trained.rows];
  assert.deepEqual(reloaded.rows,actual,'Fresh-process scores, actions and autonomous results must match saved candidate');
  assert.equal(reloaded.sampleCount,prepared.dataset.samples.length);
  const partitions=Object.fromEntries(Object.entries(receipt.comparison).map(([name,value])=>[name,{
    samples:value.trained.sampleCount,families:value.trained.familyCount,teacherSteps:value.trained.teacherStepCount,
    baselineExact:value.baseline.exactPaths,trainedExact:value.trained.exactPaths,
    correctTeacherSteps:value.trained.correctTeacherSteps,invalidRollouts:value.trained.invalidRollouts,
    fixed:value.fixed,regressed:value.regressed,retained:value.retained,unresolved:value.unresolved,
  }]));
  const summary={status:receipt.accepted?'passed':'learning_incomplete',paths:receipt.paths,partitions,timing:receipt.timing,
    trainingWorkflowMs,reloadMs,totalConsumerMs:performance.now()-started,freshProcessReloadIdentical:true,
    gradientRowsPerSecond:receipt.timing.trainEpochGradMs>0?receipt.timing.gradientRowEpochs/(receipt.timing.trainEpochGradMs/1000):null,
    trainingRowsPerWorkflowSecond:prepared.rows.length/(trainingWorkflowMs/1000),
    calibration:'uncalibrated',adoption:'not_applied',limits:['synthetic POSIX lexical function','handwritten tokenizer/stack/name copying','learned action choices','no filesystem or general CLI understanding']};
  const summaryPath=receipt.paths.report.replace(/report\.json$/,'consumer-summary.json');
  await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...summary,summaryPath},null,2));
  if(!receipt.accepted)process.exitCode=1;
}catch(error){
  console.error(JSON.stringify({status:'failed',message:error.message,partialReceipt:error.partialReceipt??null,timing:error.timing??null,consumerMs:performance.now()-started},null,2));
  process.exitCode=1;
}
