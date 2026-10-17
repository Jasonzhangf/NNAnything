import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,symlink,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileWorkflow,createWorkflowInputEvent,loadWorkflow,runWorkflow} from 'nnanything';
import {evaluateSemanticRules,sampleMatchNode,sampleAssembleNode,createSampleSaveNode} from 'nnanything/browser';

const config={ruleId:'semantic.v1',rules:[
  {semanticLabel:'post.card',match:[{tag:'article',classIncludes:['card']}]},
  {semanticLabel:'post.content',match:[{tag:'div',classIncludes:['content']}]},
]};
const task={taskId:'card-task',supervisionMap:{'post.card':'positive','post.content':'negative'},expectedLabels:{positive:'card',negative:'not-card'}};
const group={snapshotRefs:['snap'],postRefs:['post','post'],adAssetRefs:['asset']};
const raw=(records)=>({snapshotRef:'snap',sourceGroup:group,records:records.map((r,i)=>({nodeRef:String(i),provenanceRef:`archive#/nodes/${i}`,...r}))});
const selector={include:[],exclude:[]};
function one(def,config){
  return compileWorkflow({graph:{id:'one',version:'1',inputs:[{id:'in',schema:'Object'}],nodes:[{id:'node',operator:def.operator,operator_version:def.version,inputs:['in'],output:{id:'out',schema:'Object'},input_selector:selector,output_selector:selector,iterator:'Whole'}],edges:[],outputs:['out']},bindings:config?{node:{config}}:{}},{nodeDefinitions:[def],grantedEffects:['filesystem.write']});
}
async function run(compiled,payload,type,status='ok'){
  return runWorkflow(compiled,createWorkflowInputEvent({runId:'sampling-test',eventId:'input',port:compiled.entryArc.id,type,payload,status}));
}
async function nodeResult(def,cfg,payload){
  const result=await run(one(def,cfg),payload,def.inputPorts[0].eventType);
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.outputEvent.status,'ok');
  return result.outputEvent.payload;
}
const match=(payload,cfg=config)=>nodeResult(sampleMatchNode,cfg,payload);
const assemble=(payload,cfg=task)=>nodeResult(sampleAssembleNode,cfg,payload);

test('semantic filter works without training config; same class OR and distinct class conflict',()=>{
  const cfg={ruleId:'r',rules:[{semanticLabel:'A',match:[{tag:'article'},{classIncludes:['yes']}]},{semanticLabel:'A',match:[{role:'article'}]}]};
  const [r]=evaluateSemanticRules([{tag:'article',classList:['yes'],role:'article'}],cfg);
  assert.equal(r.semanticLabel,'A');assert.equal(r.matchStatus,'matched');assert.equal(r.matchedRuleIds.length,3);
  assert.equal('matchPolarity' in r,false);assert.equal('expectedLabel' in r,false);
  const [conflict]=evaluateSemanticRules([{tag:'article',classList:['card','content']}],{ruleId:'r',rules:[{semanticLabel:'A',match:[{classIncludes:['card']}]},{semanticLabel:'B',match:[{classIncludes:['content']}]}]});
  assert.equal(conflict.matchStatus,'conflict');assert.equal(conflict.semanticLabel,null);
});

test('three-valued AND/OR is order independent; unresolved competing class stays unknown',()=>{
  for(const condition of [{tag:'div',classIncludes:['x']},{classIncludes:['x'],tag:'div'}]){
    const [r]=evaluateSemanticRules([{tag:'article'}],{ruleId:'r',rules:[{semanticLabel:'A',match:[condition]}]});
    assert.equal(r.matchStatus,'unmatched');
  }
  const [same]=evaluateSemanticRules([{tag:'article'}],{ruleId:'r',rules:[{semanticLabel:'A',match:[{tag:'article'},{classIncludes:['x']}]}]});
  assert.equal(same.semanticLabel,'A');
  const [other]=evaluateSemanticRules([{tag:'article'}],{ruleId:'r',rules:[{semanticLabel:'A',match:[{tag:'article'}]},{semanticLabel:'B',match:[{classIncludes:['x']}]}]});
  assert.equal(other.matchStatus,'unknown');assert.equal(other.semanticLabel,null);
  const [attrs]=evaluateSemanticRules([{attributes:{hidden:false},classList:[],id:'x',role:'button'}],{ruleId:'r',rules:[{semanticLabel:'control',match:[{attributes:{hidden:false},classExcludes:['bad'],idEquals:'x',role:'button'}]}]});
  assert.equal(attrs.semanticLabel,'control');
});

test('ordered semantic slots preserve duplicates and evidence; nested teacher fields are projected',async()=>{
  const obs={tag:'article',parentRef:'parent',classList:['secret'],rect:{x:-10,y:-20,width:100,height:100,text:'secret'},fragments:[{x:1,y:2,width:3,height:4,id:'secret'}]};
  const input=raw([{nodeRef:'same',tag:'article',classList:['card'],id:'secret',text:'secret',studentObservation:obs},{nodeRef:'same',tag:'div',classList:['content']},{tag:'span',classList:[]}]);
  const result=await match(input);
  assert.deepEqual(result.matchedRefs,[{index:0,nodeRef:'same'},{index:1,nodeRef:'same'}]);
  assert.deepEqual(result.slots.map(x=>x.index),[0,1,2]);
  assert.deepEqual(result.slots[0].sourceGroup,group);
  assert.deepEqual(result.slots[0].inputRef,{snapshotRef:'snap',nodeRef:'same',index:0});
  assert.equal(result.slots[0].provenanceRef,'archive#/nodes/0');
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.equal(result.slots[0].studentObservation.rect.y,-20);
  assert.equal(result.slots[2].matchStatus,'unmatched');
  assert.deepEqual((await match(raw([]))).slots,[]);
});

test('supervision mapping changes only task output; semantics and unmapped classes remain intact',async()=>{
  const input=await match(raw([{tag:'article',classList:['card']},{tag:'div',classList:['content']},{tag:'span',classList:[]}]));
  const original=structuredClone(input);
  const first=await assemble(input);
  const second=await assemble(input,{taskId:'content-task',supervisionMap:{'post.card':'negative','post.content':'positive'},expectedLabels:{positive:'content',negative:'not-content'}});
  assert.deepEqual(input,original);
  assert.deepEqual(first.items.map(x=>x.labelState),['positive','negative','unlabeled']);
  assert.deepEqual(second.items.map(x=>x.labelState),['negative','positive','unlabeled']);
  assert.deepEqual(first.items.map(x=>x.semanticLabel),second.items.map(x=>x.semanticLabel));
  assert.deepEqual(first.items.map(x=>x.matchedRuleIds),second.items.map(x=>x.matchedRuleIds));
  const unmapped=await assemble(input,{...task,supervisionMap:{'post.card':'positive'}});
  assert.equal(unmapped.items[1].semanticLabel,'post.content');assert.equal(unmapped.items[1].expectedLabel,null);
  const excluded=await assemble(input,{...task,supervisionMap:{},unmappedPolicy:'excluded'});
  assert.equal(excluded.items[0].labelState,'excluded');
  assert.equal(first.items.every(x=>x.labelProvenance==='rule_proposed'),true);
});

test('candidate restrictions take precedence over semantic hits; unknown and conflict are not negatives',async()=>{
  const input=await match(raw(['filtered_out','skipped','unknown',undefined].map(candidateStatus=>({tag:'article',classList:['card'],...(candidateStatus?{candidateStatus}:{})}))));
  const out=await assemble(input);
  assert.deepEqual(out.items.map(x=>x.labelState),['excluded','excluded','unlabeled','positive']);
  assert.equal(out.items[0].semanticLabel,'post.card');
  const unresolved=await match(raw([{tag:'article'},{tag:'article',classList:['card','content']}]),{ruleId:'r',rules:[{semanticLabel:'A',match:[{classIncludes:['card']}]},{semanticLabel:'B',match:[{classIncludes:['content']}]}]});
  assert.deepEqual((await assemble(unresolved)).items.map(x=>x.labelState),['unlabeled','conflict']);
});

test('invalid configs and malformed public records fail explicitly without echoing teacher data',async()=>{
  for(const bad of [{ruleId:'r',positiveMatch:[]},{ruleId:'r',rules:[{semanticLabel:'A',match:[{}]}]},{ruleId:'r',rules:[{semanticLabel:'A',match:[{classIncludes:[]}]}]}]) assert.throws(()=>one(sampleMatchNode,bad));
  assert.throws(()=>one(sampleAssembleNode,{...task,expectedLabels:{positive:'same',negative:'same'}}));
  for(const mutate of [x=>delete x.records[0].provenanceRef,x=>x.records[0].classList='secret',x=>x.records[0].candidateStatus='approved',x=>x.records[0].studentObservation={rect:{x:0,y:0,width:-1,height:3}}]){
    const payload=raw([{tag:'article',classList:['card']}]); mutate(payload);
    const out=await run(one(sampleMatchNode,config),payload,sampleMatchNode.inputPorts[0].eventType);
    assert.equal(out.status,'failed');assert.equal(out.error.message.includes('secret'),false);
  }
  const slots=await match(raw([{tag:'article',classList:['card']}])) ;slots.slots[0].inputRef.index=5;
  assert.equal((await run(one(sampleAssembleNode,task),slots,sampleAssembleNode.inputPorts[0].eventType)).status,'failed');
});

async function withDir(fn){const root=await mkdtemp(join(tmpdir(),'nnanything-sample-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('actual saved workflow persists complete rows and exact receipt; missing effect rejects before write',async()=>withDir(async root=>{
  const definition=await loadWorkflow({configPath:resolve('workflows/dom-rule-sampling.workflow.json'),allowedRoot:resolve('.')});
  const defs=[sampleMatchNode,sampleAssembleNode,createSampleSaveNode({allowedRoot:root})];
  assert.throws(()=>compileWorkflow(definition,{nodeDefinitions:defs}),e=>e.code==='COMPILE_EFFECT_UNAUTHORIZED');
  assert.deepEqual(await readdir(root),[]);
  const compiled=compileWorkflow(definition,{nodeDefinitions:defs,grantedEffects:['filesystem.write']});
  const payload=raw([{tag:'article',classList:['synthetic-feed-card']},{tag:'div',classList:['synthetic-post-content']},{tag:'div',classList:['synthetic-feed-toolbar']}]);
  const out=await run(compiled,payload,'sample.raw-records.v1');assert.equal(out.status,'completed',JSON.stringify(out));
  const receipt=out.outputEvent.payload;
  const rows=(await readFile(receipt.savedPath,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(rows.length,3);assert.deepEqual(rows.map(x=>x.labelState),['positive','negative','unlabeled']);
  assert.equal(receipt.totalSlots,3);assert.deepEqual(receipt.counts,{positive:1,negative:1,unlabeled:1,conflict:0,excluded:0});
  assert.equal(rows[2].semanticLabel,'feed.toolbar');assert.equal(rows[2].expectedLabel,null);
  const before=await readFile(receipt.savedPath,'utf8');assert.equal((await run(compiled,payload,'sample.raw-records.v1')).status,'failed');assert.equal(await readFile(receipt.savedPath,'utf8'),before);
}));

test('save rejects escape and symlinks; non-ok input does not write; empty dataset writes empty file',async()=>withDir(async root=>{
  const node=createSampleSaveNode({allowedRoot:root});
  const data=await assemble(await match(raw([])));
  for(const fileName of ['../escaped.jsonl',root+'/absolute.jsonl','https:escape','../'+root.split('/').at(-1)+'-other/escape.jsonl']) assert.throws(()=>one(node,{fileName,writeMode:'create_new'}));
  await mkdir(join(root,'outside'));await symlink(join(root,'outside'),join(root,'link'));
  const runSave=(fileName,payload=data,status='ok')=>run(one(node,{fileName,writeMode:'create_new'}),payload,'sample.task-dataset.v1',status);
  assert.equal((await runSave('link/escape.jsonl')).status,'failed');assert.deepEqual(await readdir(join(root,'outside')),[]);
  await writeFile(join(root,'existing'),'untouched');await symlink(join(root,'existing'),join(root,'final.jsonl'));
  assert.equal((await runSave('final.jsonl')).status,'failed');assert.equal(await readFile(join(root,'existing'),'utf8'),'untouched');
  assert.equal((await runSave('missing/out.jsonl')).status,'failed');
  const skip=await runSave('skip.jsonl',{reason:'missing_evidence'},'unknown');assert.equal(skip.outputEvent.status,'skipped');
  const done=await runSave('empty.jsonl');assert.equal(done.status,'completed');assert.equal(await readFile(join(root,'empty.jsonl'),'utf8'),'');
  const malformed={...data,items:[{taskId:'forged',text:'secret'}]};assert.equal((await runSave('bad.jsonl',malformed)).status,'failed');
  assert.equal((await readdir(root)).includes('bad.jsonl'),false);
}));
