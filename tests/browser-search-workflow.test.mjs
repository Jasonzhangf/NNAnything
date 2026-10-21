import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runBrowserSearchGoal,handwiredBrowserSearchDecision,searchPhaseFact} from 'nnanything/browser-search';

function fixture(options={}){
  let revision=0,current,input='',submitted=null,forQuery=null,request='unknown',display='none';
  const actions=[],episodes=[];
  const bindings={documentRef:'search-doc',scopeRef:'search-scope',inputRef:'query',submitRef:'submit',resultScopeRef:'results',collectionRef:'main'};
  const fact=(value,id)=>value===null?{status:'unknown',reason:'not_observed'}:{status:'observed',value,evidenceRefs:[id]};
  const observe=async()=>{
    const observationId=`observation-${++revision}`,id=observationId+':evidence';
    current={documentRef:bindings.documentRef,scopeRef:bindings.scopeRef,observationId,revision,
      input:{ref:'query',tag:options.tag??'input',type:options.type??'text',value:fact(input,id),editable:fact(true,id)},submitRef:'submit',
      submittedQuery:fact(submitted,id),resultsFor:fact(forQuery,id),request,display,access:options.blocked?'login_required':'available',
      collection:{ref:'main',scopeRef:'results',batch:fact('batch-1',id),items:submitted===null?[]:[{ref:'item-1',text:fact(options.text??'露营装备清单',id)}]},
      evidence:[{id,source:'synthetic.search-fixture',fact:{input,submitted,forQuery}}]};return current;
  };
  const resources={grantedEffects:new Set(['browser.read','browser.nativeInputText','browser.nativeSubmit','filesystem.write']),
    decision:options.decision??handwiredBrowserSearchDecision,observe,readResults:observe,currentControl:()=>current,
    nativeInputText:async invocation=>{actions.push('input');if(!options.ignoreInput)input=invocation.value;return {dispatched:true,ok:true,effectKnowledge:'known',source:'synthetic',error:null};},
    nativeSubmit:async()=>{actions.push('submit');submitted=input;forQuery=options.oldResult?'old query':input;request=options.loading?'loading':'settled';display=options.loading?'partial':'current';return {dispatched:true,ok:true,effectKnowledge:'known',source:'synthetic',error:null};},
    collect:async episode=>{episodes.push(episode);if(options.collectFails)throw new Error('sink failed');},collectRoot:async()=>{},
  };
  return {bindings,resources,actions,episodes,observe};
}
function request(bindings){return {requestId:'search-test',satisfactionThreshold:100,bindings,
  goal:{kind:'BrowserSearch',query:'露营',collectionRef:'main',containsText:'装备',minimumMatches:1,coverage:'visible_batch'},maxResultReads:3};}
test('public recursive search runs input/readback, submit, and scoped result check',async()=>{
  const f=fixture();const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.equal(response.kind,'run_result');assert.equal(response.report.rootEvaluation.result,'satisfied');
  assert.deepEqual(f.actions,['input','submit']);assert.equal(f.episodes.length,3);
  assert.ok(f.episodes.every(e=>e.observationFeedback.status==='satisfied'));
  assert.ok(f.episodes.every(e=>e.decisionSource.source==='handwired'));
});
for(const options of [{ignoreInput:true},{oldResult:true},{text:'无关内容'},{blocked:true},{loading:true},{tag:'textarea'},{type:'search'}]){
  test(`search does not fabricate success: ${JSON.stringify(options)}`,async()=>{
    const f=fixture(options);const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
    assert.notEqual(response.kind==='run_result'?response.report.rootEvaluation.result:null,'satisfied');
    if(options.ignoreInput)assert.deepEqual(f.actions,['input']);
    if(options.tag||options.type)assert.deepEqual(f.actions,[]);
  });
}
test('wrong current decision is rejected without corrective input or submit',async()=>{
  const f=fixture({decision:{id:'wrong-model',source:'model',select:()=>({kind:'selected',action:'submit'})}});
  const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.notEqual(response.kind==='run_result'?response.report.rootEvaluation.result:null,'satisfied');assert.deepEqual(f.actions,[]);
});
test('root evaluation is pure and scoped; collection failure stays separate',async()=>{
  const f=fixture({collectFails:true});const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.equal(response.report.rootEvaluation.result,'satisfied');assert.ok(f.episodes.length>0);
  const observation=await f.observe();const count=f.actions.length;
  assert.equal(searchPhaseFact({...request(f.bindings).goal,phase:'root'},observation,observation.observationId),'satisfied');
  assert.equal(searchPhaseFact({...request(f.bindings).goal,collectionRef:'foreign',phase:'root'},observation,observation.observationId),'unknown');
  assert.equal(f.actions.length,count);
});
test('input dispatch exception still reads actual value and preserves uncertainty',async()=>{
  const f=fixture();const input=f.resources.nativeInputText;
  f.resources.nativeInputText=async invocation=>{await input(invocation);throw new Error('transport after dispatch');};
  const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.deepEqual(f.actions,['input']);
  assert.notEqual(response.report.rootEvaluation.result,'satisfied');
  assert.equal(f.episodes.length,1);
  assert.equal(f.episodes[0].state.observation.input.value.value,'露营');
  assert.equal(f.episodes[0].effectKnowledge,'unknown');
  assert.equal(f.episodes[0].dispatchState,'unknown');
  assert.ok(f.episodes[0].executionErrors.length>0);
});
test('stale input post is not trusted and cannot enable submit',async()=>{
  const f=fixture();const observe=f.resources.observe;let before,dispatched=false;
  const input=f.resources.nativeInputText;
  f.resources.nativeInputText=async invocation=>{const receipt=await input(invocation);dispatched=true;return receipt;};
  f.resources.observe=async obligation=>{if(dispatched)return before;before=await observe(obligation);return before;};
  const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.deepEqual(f.actions,['input']);assert.notEqual(response.report.rootEvaluation.result,'satisfied');
  assert.notEqual(f.episodes[0].observationFeedback.status,'satisfied');
});
test('observation failure after dispatch stays separate from execution failure',async()=>{
  const f=fixture();const observe=f.resources.observe;let dispatched=false;
  f.resources.nativeInputText=async()=>{f.actions.push('input');dispatched=true;throw new Error('dispatch uncertain');};
  f.resources.observe=async obligation=>{if(dispatched)throw new Error('read failed');return observe(obligation);};
  const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.deepEqual(f.actions,['input']);assert.notEqual(response.report.rootEvaluation.result,'satisfied');
  assert.ok(f.episodes[0].executionErrors.some(e=>e.message.includes('dispatch uncertain')));
  assert.ok(f.episodes[0].observationFeedback.errors.some(e=>e.message.includes('read failed')));
  assert.equal(f.episodes[0].effectKnowledge,'unknown');
});
test('bounded response reads wait for current main results and stop at the declared limit',async()=>{
  const f=fixture({loading:true});let reads=0;const observe=f.resources.readResults;
  f.resources.readResults=async obligation=>{reads++;const observation=await observe(obligation);return reads===2?{...observation,request:'settled',display:'current'}:observation;};
  const response=await runBrowserSearchGoal(request(f.bindings),f.resources);
  assert.equal(response.report.rootEvaluation.result,'satisfied');assert.equal(reads,2);assert.deepEqual(f.actions,['input','submit']);
  const stuck=fixture({loading:true});let stuckReads=0;const read=stuck.resources.readResults;
  stuck.resources.readResults=async obligation=>{stuckReads++;return read(obligation);};
  const stopped=await runBrowserSearchGoal({...request(stuck.bindings),maxResultReads:2},stuck.resources);
  assert.notEqual(stopped.report.rootEvaluation.result,'satisfied');assert.equal(stuckReads,2);
});
test('matched_items accepts sufficient known matches while visible_batch retains unknown content',async()=>{
  for(const coverage of ['matched_items','visible_batch']){
    const f=fixture();const observe=f.resources.observe;
    const withUnknown=async obligation=>{const o=await observe(obligation);return {...o,collection:{...o.collection,items:[...o.collection.items,{ref:'unread-neighbor',text:{status:'unknown',reason:'not_read'}}]}};};
    f.resources.observe=withUnknown;f.resources.readResults=withUnknown;
    const r=request(f.bindings);const response=await runBrowserSearchGoal({...r,goal:{...r.goal,coverage}},f.resources);
    assert.deepEqual(f.actions,['input','submit']);
    if(coverage==='matched_items'){
      assert.equal(response.report.rootEvaluation.result,'satisfied');
      assert.equal(f.episodes.at(-1).observationFeedback.status,'satisfied');
      assert.equal(f.episodes.at(-1).state.observation.collection.items.at(-1).text.status,'unknown');
    }else{
      assert.notEqual(response.report.rootEvaluation.result,'satisfied');
      assert.ok(f.episodes.at(-1).observationFeedback.unmetFacts.includes('content'));
    }
  }
});
