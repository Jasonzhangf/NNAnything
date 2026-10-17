import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadWorkflow,compileWorkflow,runWorkflow,createWorkflowInputEvent} from 'nnanything';
import {sampleMatchNode,sampleAssembleNode,createSampleSaveNode,readTaskDataset} from 'nnanything/browser';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const flags=new Map();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!['--input','--config','--workflow-root','--output-root'].includes(key)||!value||value.startsWith('--')||flags.has(key)) throw new Error('Use --input <json> --config <workflow.json> --workflow-root <dir> --output-root <existing-dir>');
  flags.set(key,value);
}
const inputPath=resolve(flags.get('--input')??join(repo,'playground/sampling/raw-records.fixture.json'));
const configPath=resolve(flags.get('--config')??join(repo,'workflows/dom-rule-sampling.workflow.json'));
const workflowRoot=resolve(flags.get('--workflow-root')??repo);
let outputRoot=flags.get('--output-root');
if(!outputRoot){
  const base=join(repo,'training/samples');await mkdir(base,{recursive:true});
  outputRoot=await mkdtemp(join(base,'sampling-'));
}
outputRoot=resolve(outputRoot);
const payload=JSON.parse(await readFile(inputPath,'utf8'));
const definition=await loadWorkflow({configPath,allowedRoot:workflowRoot});
const compiled=compileWorkflow(definition,{nodeDefinitions:[sampleMatchNode,sampleAssembleNode,createSampleSaveNode({allowedRoot:outputRoot})],grantedEffects:['filesystem.write']});
const result=await runWorkflow(compiled,createWorkflowInputEvent({runId:'sampling-consumer',eventId:'sampling-consumer:input',port:compiled.entryArc.id,type:'sample.raw-records.v1',payload}));
if(result.status!=='completed') throw new Error(`${result.error.category}: ${result.error.message}`);
if(result.outputEvent.status!=='ok') throw new Error(`Sampling did not save: ${result.outputEvent.status}`);
const receipt=result.outputEvent.payload;
const content=await readFile(receipt.savedPath,'utf8');
const rows=content?content.trimEnd().split('\n').map(line=>JSON.parse(line)):[];
readTaskDataset({taskId:receipt.taskId,ruleId:receipt.ruleId,items:rows});
assert.equal(rows.length,payload.records.length);
assert.equal(rows.length,receipt.totalSlots);
const counts={positive:0,negative:0,unlabeled:0,conflict:0,excluded:0};
const semanticCounts={};
rows.forEach((row,index)=>{
  assert.equal(row.inputRef.index,index);assert.equal(row.inputRef.nodeRef,payload.records[index].nodeRef);
  assert.equal(row.provenanceRef,payload.records[index].provenanceRef);
  counts[row.labelState]++;
  if(row.semanticLabel!==null) semanticCounts[row.semanticLabel]=(semanticCounts[row.semanticLabel]??0)+1;
});
assert.deepEqual(counts,receipt.counts);
console.log(JSON.stringify({status:'completed',receipt,semanticCounts},null,2));
