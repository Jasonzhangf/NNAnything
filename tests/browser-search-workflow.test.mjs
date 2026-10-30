import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runBrowserSearchGoal,runBrowserSearchEpisode,handwiredBrowserSearchDecision,searchPhaseFact,captureSubmissionBaseline,
  createBrowserInputPolicyProfile,createBrowserQueryRelationProfile,createBrowserStepPolicyProfile,
  predictBrowserInputPolicy,predictBrowserQueryRelation,predictBrowserSearchStepPolicy} from 'nnanything/browser-search';

const INPUT_WEIGHTS = [
  [-9, 0, 2, 0, 2, 0, 2, 2, -4, 2, -6, 0, 2],
  [-3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];
const RELATION_WEIGHTS = [
  [-5.0, 0, 2, 2, -6, 0, 0, 0, 0, 0, 0, 2, 0, 0],
  [-9.5, 0, 0, 0, 4, 1, 0, 0, 1, 2, 0, 4, 0, -10],
  [-2.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];
const STEP_WEIGHTS = [
  [-5, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-5, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-5, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 4],
  [-5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, -4, 0, 4, -4, 0],
  [-5, 4, 4, -2, 0, 4, 0, 0, 4, 4, 0, 0, 0, 6, 0, 0, 6, 0],
  [1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0],
];
// Plan §3.3 witness matrix W_s13 (6×18) for B-S1.3 pure-forward gate tests.
const STEP_PROFILE = createBrowserStepPolicyProfile(STEP_WEIGHTS);
const RELATION_PROFILE = createBrowserQueryRelationProfile(RELATION_WEIGHTS);
const INPUT_PROFILE = createBrowserInputPolicyProfile(INPUT_WEIGHTS);

// Minimal synthetic observation builder scoped to B-S1.3 forward inputs.
function stepObservation(options = {}) {
  const observationId = options.observationId ?? 'observation-step';
  const id = `${observationId}:evidence`;
  const geo = options.geometry ?? 'unknown';
  const hasMore = options.hasMore ?? 'unknown';
  const terminal = options.terminal ?? false;
  return {
    documentRef: 'search-doc',
    scopeRef: 'search-scope',
    observationId,
    revision: 2,
    input: { ref: 'query', tag: 'input', type: 'text',
      value: { status: 'observed', value: options.inputValue ?? '露营', evidenceRefs: [id] },
      editable: { status: 'observed', value: true, evidenceRefs: [id] } },
    submitRef: 'submit',
    submittedQuery: { status: 'observed', value: '露营', evidenceRefs: [id] },
    resultsFor: { status: 'observed', value: '露营', evidenceRefs: [id] },
    submittedRequestRef: { status: 'observed', value: 'request-new', evidenceRefs: [id] },
    resultsRequestRef: { status: 'observed', value: 'request-new', evidenceRefs: [id] },
    request: 'settled',
    display: 'current',
    access: 'available',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: { status: 'observed', value: 'request-new', evidenceRefs: [id] },
      batch: { status: 'observed', value: 'batch-new', evidenceRefs: [id] },
      items: [{ ref: 'item-1', collectionRef: 'main', role: 'main',
        text: { status: 'observed', value: options.text ?? '露营装备清单', evidenceRefs: [id] } }],
    },
    rangeExpansion: {
      actionMechanicalEffect: 'not_attempted',
      atGeometryBoundary: geo === 'unknown' ? { status: 'unknown', reason: 'not_measured' }
        : { status: 'observed', value: geo === 'true', evidenceRefs: [id] },
      requestState: { status: 'observed', value: 'settled', evidenceRefs: [id] },
      hasMore: hasMore === 'unknown' ? { status: 'unknown', reason: 'no_positive_terminal_control_source' }
        : { status: 'observed', value: hasMore === 'true', evidenceRefs: [id] },
      collectionTerminal: terminal,
    },
    evidence: [{ id, source: 'synthetic.search-step', fact: {} }],
  };
}

function stepState(options = {}) {
  const observation = stepObservation(options);
  return {
    observation,
    checkedObservationId: observation.observationId,
    submissionBaseline: {
      submittedRequestRef: 'request-old',
      resultsRequestRef: 'request-old',
      batchRef: 'batch-old',
      observedSubmission: true,
    },
  };
}

function stepGoal(phase) {
  return { kind: 'BrowserSearch', query: '露营', collectionRef: 'main',
    containsText: '装备', minimumMatches: 1, coverage: 'visible_batch', phase };
}

test('B-S1.3 pure forward: loading stays read_or_reobserve', () => {
  const state = stepState({text: '无关内容'});
  state.observation.request = 'loading';
  state.observation.rangeExpansion.requestState = { status: 'observed', value: 'loading', evidenceRefs: [state.observation.evidence[0].id] };
  const head = predictBrowserSearchStepPolicy(state, stepGoal('results'), null,
    'submitted_pending_or_stale', STEP_PROFILE).head;
  assert.equal(head, 'read_or_reobserve');
});

test('B-S1.3 pure forward: hasMore true expands the range', () => {
  const state = stepState({ hasMore: 'true', text: '无关内容' });
  const head = predictBrowserSearchStepPolicy(state, stepGoal('results'), null,
    'results_associated_active', STEP_PROFILE).head;
  assert.equal(head, 'expand_range');
});

test('B-S1.3 pure forward: BP11b non-geometry terminal NOOP', () => {
  const state = stepState({ geometry: 'false', hasMore: 'false', terminal: true });
  const head = predictBrowserSearchStepPolicy(state, stepGoal('results'), null,
    'results_associated_active', STEP_PROFILE).head;
  assert.equal(head, 'NOOP');
});

test('B-S1.3 pure forward: BP10 unknown terminal defers', () => {
  const state = stepState({ geometry: 'true', hasMore: 'unknown', terminal: false, text: '无关内容' });
  const head = predictBrowserSearchStepPolicy(state, stepGoal('results'), null,
    'results_associated_active', STEP_PROFILE).head;
  assert.equal(head, 'DEFER');
});

test('B-S1.3 pure forward: upstream wrong prediction passed unchanged', () => {
  // The relation head is wrong (insufficient_or_conflict instead of
  // results_associated_active). The step policy must consume it as-is,
  // never replace it with teacher gold.
  const state = stepState({ hasMore: 'true' });
  const wrong = predictBrowserSearchStepPolicy(state, stepGoal('results'), null,
    'insufficient_or_conflict', STEP_PROFILE).head;
  assert.equal(wrong, 'DEFER');
});

const rangeFacts = (overrides = {}) => ({
  actionMechanicalEffect: 'not_attempted',
  atGeometryBoundary: {status: 'unknown', reason: 'not_attempted'},
  requestState: {status: 'unknown', reason: 'no_positive_request_state_source'},
  hasMore: {status: 'unknown', reason: 'no_positive_terminal_control_source'},
  collectionTerminal: false,
  ...overrides,
});

function makeObservation(options = {}, sequence = 2) {
  const id = `observation-${sequence}:evidence`;
  return {
    documentRef: 'search-doc',
    scopeRef: 'search-scope',
    observationId: `observation-${sequence}`,
    revision: sequence,
    input: {
      ref: 'query',
      tag: options.tag ?? 'input',
      type: options.type ?? 'text',
      value: {status: 'observed', value: options.inputValue ?? '露营', evidenceRefs: [id]},
      editable: {status: 'observed', value: true, evidenceRefs: [id]},
    },
    submitRef: 'submit',
    submittedQuery: {status: 'observed', value: options.submittedQuery ?? '露营', evidenceRefs: [id]},
    resultsFor: {status: 'observed', value: options.resultsFor ?? '露营', evidenceRefs: [id]},
    submittedRequestRef: {status: 'observed', value: options.submittedRequestRef ?? 'request-new', evidenceRefs: [id]},
    resultsRequestRef: {status: 'observed', value: options.resultsRequestRef ?? 'request-new', evidenceRefs: [id]},
    request: options.request ?? 'settled',
    display: options.display ?? 'current',
    access: options.access ?? 'available',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: {status: 'observed', value: options.collectionRequestRef ?? 'request-new', evidenceRefs: [id]},
      batch: {status: 'observed', value: options.batch ?? 'batch-new', evidenceRefs: [id]},
      items: options.items ?? [
        {ref: 'item-1', collectionRef: 'main', role: 'main',
          text: {status: 'observed', value: options.text ?? '露营装备清单', evidenceRefs: [id]}},
      ],
    },
    rangeExpansion: rangeFacts(options.rangeExpansion),
    evidence: [{id, source: 'synthetic.search-model', fact: {}}],
  };
}

function makeState(options = {}, sequence = 2) {
  const observation = makeObservation(options, sequence);
  return {
    observation,
    checkedObservationId: options.checkedObservationId ?? (options.phase === 'results' ? observation.observationId : null),
    submissionBaseline: {
      submittedRequestRef: 'request-old',
      resultsRequestRef: 'request-old',
      batchRef: 'batch-old',
      observedSubmission: true,
    },
  };
}

function modelResources(base, options = {}) {
  return {
    ...base,
    decision: {
      id: 'browser.search-model.v1',
      source: 'model',
      inputPolicyProfile: createBrowserInputPolicyProfile(INPUT_WEIGHTS),
      queryRelationProfile: createBrowserQueryRelationProfile(RELATION_WEIGHTS),
      stepPolicyProfile: createBrowserStepPolicyProfile(STEP_WEIGHTS),
      select: () => ({kind: 'defer', action: null}),
    },
    ...options,
  };
}

function fixture(options={}){
  let revision=0,current,input=options.initialInput??'',submitted=options.previousSubmission?'旧查询':null,
    forQuery=options.previousSubmission?'旧查询':null,request=options.previousSubmission?'settled':'unknown',display='none';
  let submittedRequest=options.previousSubmission?'request-old':null,
    resultsRequest=options.previousSubmission?'request-old':null,
    batchRef=options.previousSubmission?'batch-old':null,submissions=0,firstObservation=null;
  const actions=[],episodes=[],rangeActions=[];
  const bindings={documentRef:'search-doc',scopeRef:'search-scope',inputRef:'query',submitRef:'submit',resultScopeRef:'results',collectionRef:'main'};
  const fact=(value,id)=>value===null?{status:'unknown',reason:'not_observed'}:{status:'observed',value,evidenceRefs:[id]};
  const observe=async()=>{
    const observationId=`observation-${++revision}`,id=observationId+':evidence';
    const observedFact=value=>({status:'observed',value,evidenceRefs:[id]});
    const rangeRequestState=['loading','settled','error'].includes(request)
      ? observedFact(request)
      : {status:'unknown',reason:'no_positive_request_state_source'};
    const target=options.target?{
      ref:bindings.inputRef,
      connected:observedFact(true),
      currentRef:observedFact(bindings.inputRef),
      host:observedFact(options.tag??'input'),
      contentEditable:observedFact(null),
      type:observedFact(options.type??'text'),
      value:fact(input,id),
      placeholder:observedFact(null),
      nativeDisabled:observedFact(false),
      ariaDisabled:observedFact(false),
      nativeReadonly:observedFact(options.readonly===true),
      ariaReadonly:observedFact(null),
      readonlyState:observedFact(options.readonly?'readonly':'editable'),
      editable:observedFact(!options.readonly),
      activeElementRef:observedFact(bindings.inputRef),
      activeElementFocus:observedFact(true),
      executableHit:options.hitUnknown?{status:'unknown',reason:'native_hit_unassessed'}:observedFact(options.hit??true),
      point:observedFact({x:10,y:10}),
    }:undefined;
    current={documentRef:bindings.documentRef,scopeRef:bindings.scopeRef,observationId,revision,
      ...(target===undefined?{}:{target}),
      input:{ref:'query',tag:options.tag??'input',type:options.type??'text',value:fact(input,id),editable:fact(!options.readonly,id)},submitRef:'submit',
      submittedQuery:fact(submitted,id),resultsFor:fact(forQuery,id),
      submittedRequestRef:fact(submittedRequest,id),resultsRequestRef:fact(resultsRequest,id),request,display,
      access:options.blocked?'login_required':'available',
      collection:{ref:'main',scopeRef:'results',requestRef:fact(resultsRequest,id),batch:fact(batchRef,id),
        items:submitted===null?[]:[{ref:'item-1',collectionRef:'main',role:'main',text:fact(options.text??'露营装备清单',id)}]},
      rangeExpansion:{...rangeFacts(options.rangeExpansion),requestState:rangeRequestState,
        ...(options.rangeHasMore===undefined?{}:{hasMore:observedFact(options.rangeHasMore)})},
      evidence:[{id,source:'synthetic.search-fixture',fact:{input,submitted,forQuery,submittedRequest,resultsRequest,batchRef}}]};
    firstObservation??=current;
    return current;
  };
  const resources={grantedEffects:new Set(['browser.read','browser.nativeInputText','browser.nativeSubmit','browser.nativeExpandRange','filesystem.write']),
    decision:options.decision??handwiredBrowserSearchDecision,observe,readResults:observe,currentControl:()=>current,
    nativeInputText:async invocation=>{actions.push('input');if(!options.ignoreInput)input=invocation.value;return {dispatched:true,ok:true,effectKnowledge:'known',source:'synthetic',error:null};},
    nativeSubmit:async()=>{actions.push('submit');submitted=input;submissions+=1;submittedRequest=`request-${submissions}`;
      if(options.oldResult){forQuery='old query';resultsRequest='request-old';batchRef='batch-old';request='settled';display='current';}
      else{forQuery=input;resultsRequest=submittedRequest;batchRef=`batch-${submissions}`;request=options.loading?'loading':'settled';display=options.loading?'partial':'current';}
      return {dispatched:true,ok:true,effectKnowledge:'known',source:'synthetic',error:null};},
    nativeExpandRange:async()=>{rangeActions.push('expand_range');return {dispatched:true,ok:true,effectKnowledge:'known',source:'synthetic',error:null};},
    collect:async episode=>{episodes.push(episode);if(options.collectFails)throw new Error('sink failed');},collectRoot:async()=>{},
  };
  return {bindings,resources,actions,rangeActions,episodes,observe,initialObservation:()=>firstObservation};
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
test('model decision dispatches native expand_range and reads back scroll change',async()=>{
  let expanded=false;
  const base=fixture({target:true,text:'无关内容',rangeHasMore:true,previousSubmission:true});
  const initial=await base.observe();
  const baseline=captureSubmissionBaseline(initial);
  await base.resources.nativeInputText({value:'露营'});
  await base.resources.nativeSubmit();
  const current=await base.observe();
  let first=true;
  const resources=modelResources({...base.resources,
    observe:async obligation=>{
      if(first){first=false;return current;}
      return base.resources.observe(obligation);
    },
  },{
    nativeExpandRange:async()=>{expanded=true;return {dispatched:true,ok:true,effectKnowledge:'known',error:null,source:'synthetic'};},
  });
  const r=request(base.bindings);
  const result=await runBrowserSearchEpisode({goal:{...r.goal,phase:'results'},bindings:r.bindings,maxResultReads:1,
    submissionBaseline:baseline,checkedObservationId:current.observationId},resources);
  assert.equal(result.action,'expand_range');
  assert.equal(expanded,true);
  assert.equal(result.executionErrors.length,0,JSON.stringify(result.executionErrors));
  assert.equal(expanded,true,JSON.stringify({actions:base.actions,rangeActions:base.rangeActions,
    episodes:base.episodes.map(episode=>({action:episode.action,errors:episode.executionErrors,
      decision:episode.decision?.step?.head??null,relation:episode.decision?.queryRelation?.head??null,
      feedback:episode.observationFeedback.status}))}));
});
test('public direct call without grantedEffects ceiling still requires nativeExpandRange',async()=>{
  let expanded=false;
  const base=fixture({target:true,text:'无关内容',rangeHasMore:true,previousSubmission:true});
  const initial=await base.observe();
  const baseline=captureSubmissionBaseline(initial);
  await base.resources.nativeInputText({value:'露营'});
  await base.resources.nativeSubmit();
  const current=await base.observe();
  let first=true;
  const resources=modelResources({...base.resources,
    grantedEffects:new Set(['browser.read','browser.nativeInputText','browser.nativeSubmit','filesystem.write']),
    observe:async obligation=>{
      if(first){first=false;return current;}
      return base.resources.observe(obligation);
    },
  },{
    nativeExpandRange:async()=>{expanded=true;return {dispatched:true,ok:true,effectKnowledge:'known',error:null,source:'synthetic'};},
  });
  const r=request(base.bindings);
  const result=await runBrowserSearchEpisode({goal:{...r.goal,phase:'results'},bindings:r.bindings,maxResultReads:1,
    submissionBaseline:baseline,checkedObservationId:current.observationId},resources);
  assert.equal(result.executionErrors.some(error=>error.code==='permission_denied'),true,
    JSON.stringify({executionErrors:result.executionErrors,invocation:result.invocation,
      dispatchState:result.dispatchState,expanded,rangeActions:base.rangeActions}));
  assert.equal(result.invocation,null);
  assert.equal(result.dispatchState,'not_dispatched');
  assert.equal(expanded,false);
  assert.equal(base.rangeActions.length,0);
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
  const baseline=captureSubmissionBaseline(f.initialObservation());
  assert.equal(searchPhaseFact({...request(f.bindings).goal,phase:'root'},observation,observation.observationId,baseline),'satisfied');
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
    const withUnknown=async obligation=>{const o=await observe(obligation);return {...o,collection:{...o.collection,
      items:[...o.collection.items,{ref:'unread-neighbor',collectionRef:'main',role:'main',text:{status:'unknown',reason:'not_read'}}]}};};
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

// Explicit engineering profile only: caller-supplied, uncalibrated/not_applied.
// It maps the real pre-submit search state (input equals query, no new
// submission yet) to input_only_unsubmitted so B-S1.3 can dispatch submit,
// while a settled associated batch maps to results_associated_active.
const ENGINEERING_RELATION_WEIGHTS = [
  [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];
function engineeringModelResources(base, options = {}) {
  return {
    ...base,
    ...(options.resources ?? {}),
    decision: {
      id: 'browser.search.engineering-p1.v1',
      source: 'model',
      inputPolicyProfile: createBrowserInputPolicyProfile(INPUT_WEIGHTS),
      queryRelationProfile: createBrowserQueryRelationProfile(ENGINEERING_RELATION_WEIGHTS),
      stepPolicyProfile: createBrowserStepPolicyProfile(STEP_WEIGHTS),
      select: () => ({ kind: 'defer', action: null }),
      ...(options.decision ?? {}),
    },
  };
}

test('model input branch drives empty input -> native input -> submit through the public consumer', async () => {
  const f = fixture({ target: true });
  const response = await runBrowserSearchGoal(request(f.bindings), engineeringModelResources(f.resources));
  assert.equal(response.kind, 'run_result');
  assert.equal(response.report.rootEvaluation.result, 'satisfied');
  assert.deepEqual(f.actions, ['input', 'submit']);
  const inputEpisode = f.episodes.find(episode => episode.action === 'input');
  assert.ok(inputEpisode, 'input episode must be collected');
  assert.equal(inputEpisode.decision.input.head, 'INPUT');
  assert.equal(inputEpisode.decision.step.head, 'input');
  assert.equal(inputEpisode.dispatchState, 'dispatched');
});

test('input NOOP with already-equal value forms a satisfied result State without dispatch', async () => {
  const f = fixture({ target: true, initialInput: '露营' });
  const observation = await f.observe();
  const resources = engineeringModelResources(f.resources, {
    resources: {
      observe: async () => observation,
      readResults: async () => observation,
      currentControl: () => ({ documentRef: observation.documentRef,
        observationId: observation.observationId, revision: observation.revision }),
    },
  });
  const dispatched = f.actions.length;
  const goal = { ...request(f.bindings).goal, phase: 'input' };
  const episode = await runBrowserSearchEpisode({ goal, bindings: f.bindings, maxResultReads: 1,
    submissionBaseline: null, checkedObservationId: null }, resources);
  assert.equal(episode.decision.input.head, 'NOOP');
  assert.equal(episode.decision.step.head, 'NOOP');
  assert.ok(episode.state, 'input NOOP must form an explicit result State');
  assert.equal(episode.observationFeedback.status, 'satisfied');
  assert.equal(episode.dispatchState, 'not_dispatched');
  assert.equal(f.actions.length, dispatched, 'NOOP must not dispatch a native input');
  assert.equal(searchPhaseFact(goal, episode.state.observation, null, null), 'satisfied');
});

for (const variant of [{ label: 'readonly', readonly: true }, { label: 'occluded', hit: false },
  { label: 'unknown hit', hitUnknown: true }]) {
  test(`equal-value NOOP stays satisfied with ${variant.label} target`, async () => {
    const f = fixture({ target: true, initialInput: '露营', ...variant });
    const observation = await f.observe();
    const resources = engineeringModelResources(f.resources, {
      resources: {
        observe: async () => observation,
        readResults: async () => observation,
        currentControl: () => ({ documentRef: observation.documentRef,
          observationId: observation.observationId, revision: observation.revision }),
      },
    });
    const goal = { ...request(f.bindings).goal, phase: 'input' };
    const episode = await runBrowserSearchEpisode({ goal, bindings: f.bindings, maxResultReads: 1,
      submissionBaseline: null, checkedObservationId: null }, resources);
    assert.equal(episode.decision.input.head, 'NOOP');
    assert.equal(episode.decision.step.head, 'NOOP');
    assert.equal(episode.observationFeedback.status, 'satisfied');
    assert.equal(episode.dispatchState, 'not_dispatched');
    assert.deepEqual(f.actions, []);
  });
}

test('submitted NOOP with a confirmed new submission forms a satisfied result State', async () => {
  const id = 'observation-2:evidence';
  const observation = makeObservation({ rangeExpansion: {
    requestState: { status: 'observed', value: 'settled', evidenceRefs: [id] },
  } }, 2);
  const bindings = { documentRef: 'search-doc', scopeRef: 'search-scope', inputRef: 'query',
    submitRef: 'submit', resultScopeRef: 'results', collectionRef: 'main' };
  const baseline = { submittedRequestRef: 'request-old', resultsRequestRef: 'request-old',
    batchRef: 'batch-old', observedSubmission: true };
  let dispatches = 0;
  const resources = engineeringModelResources({
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
    observe: async () => observation,
    readResults: async () => observation,
    currentControl: () => ({ documentRef: observation.documentRef,
      observationId: observation.observationId, revision: observation.revision }),
    nativeInputText: async () => { dispatches += 1; throw new Error('unexpected input'); },
    nativeSubmit: async () => { dispatches += 1; throw new Error('unexpected submit'); },
    collect: async () => {},
  });
  const goal = { ...request(bindings).goal, phase: 'submitted' };
  const episode = await runBrowserSearchEpisode({ goal, bindings, maxResultReads: 1,
    submissionBaseline: baseline, checkedObservationId: observation.observationId }, resources);
  assert.equal(episode.decision.queryRelation.head, 'results_associated_active');
  assert.equal(episode.decision.step.head, 'NOOP');
  assert.ok(episode.state, 'submitted NOOP must form an explicit result State');
  assert.equal(episode.observationFeedback.status, 'satisfied');
  assert.equal(episode.dispatchState, 'not_dispatched');
  assert.equal(dispatches, 0, 'NOOP must not dispatch any native action');
  assert.equal(searchPhaseFact(goal, episode.state.observation, null, baseline), 'satisfied');
});

test('a wrong NOOP prediction never becomes goal satisfaction', async () => {
  const f = fixture({ target: true, initialInput: '登山' });
  const noopHeavy = createBrowserStepPolicyProfile([
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]);
  const response = await runBrowserSearchGoal(request(f.bindings), engineeringModelResources(f.resources, {
    decision: { stepPolicyProfile: noopHeavy },
  }));
  const root = response.kind === 'run_result' ? response.report.rootEvaluation.result : null;
  assert.notEqual(root, 'satisfied');
  assert.deepEqual(f.actions, []);
  const episode = f.episodes[0];
  assert.ok(episode, 'input episode must be collected');
  assert.equal(episode.decision.input.head, 'INPUT', 'the input unit still predicts a real write');
  assert.equal(episode.decision.step.head, 'NOOP', 'the wrong step prediction cascades unchanged');
});

function stalledOldResultFixture() {
  const bindings = { documentRef: 'search-doc', scopeRef: 'search-scope', inputRef: 'query',
    submitRef: 'submit', resultScopeRef: 'results', collectionRef: 'main' };
  let revision = 0;
  let current = null;
  let input = '';
  let submitted = '旧查询';
  let forQuery = '旧查询';
  let submittedRequest = 'request-old';
  let resultsRequest = 'request-old';
  let batchRef = 'batch-old';
  let request = 'settled';
  let display = 'none';
  const actions = [];
  const episodes = [];
  const fact = (value, id) => value === null ? { status: 'unknown', reason: 'not_observed' }
    : { status: 'observed', value, evidenceRefs: [id] };
  function observe() {
    const observationId = `stalled-observation-${++revision}`;
    const id = `${observationId}:evidence`;
    const observedFact = (value) => ({ status: 'observed', value, evidenceRefs: [id] });
    const rangeRequestState = ['loading', 'settled', 'error'].includes(request)
      ? observedFact(request)
      : { status: 'unknown', reason: 'no_positive_request_state_source' };
    const target = {
      ref: bindings.inputRef, connected: observedFact(true), currentRef: observedFact(bindings.inputRef),
      host: observedFact('input'), contentEditable: observedFact(null), type: observedFact('text'),
      value: fact(input, id), placeholder: observedFact(null),
      nativeDisabled: observedFact(false), ariaDisabled: observedFact(false),
      nativeReadonly: observedFact(false), ariaReadonly: observedFact(null),
      readonlyState: observedFact('editable'), editable: observedFact(true),
      activeElementRef: observedFact(bindings.inputRef), activeElementFocus: observedFact(true),
      executableHit: observedFact(true), point: observedFact({ x: 10, y: 10 }),
    };
    current = {
      documentRef: bindings.documentRef, scopeRef: bindings.scopeRef, observationId, revision,
      target,
      input: { ref: 'query', tag: 'input', type: 'text', value: fact(input, id), editable: observedFact(true) },
      submitRef: 'submit',
      submittedQuery: fact(submitted, id), resultsFor: fact(forQuery, id),
      submittedRequestRef: fact(submittedRequest, id), resultsRequestRef: fact(resultsRequest, id),
      request, display, access: 'available',
      collection: { ref: 'main', scopeRef: 'results', requestRef: fact(resultsRequest, id),
        batch: fact(batchRef, id),
        items: submitted === null ? [] : [{ ref: 'item-1', collectionRef: 'main', role: 'main',
          text: observedFact('露营装备清单') }] },
      rangeExpansion: { ...rangeFacts(), requestState: rangeRequestState },
      evidence: [{ id, source: 'synthetic.stalled-old-result',
        fact: { input, submitted, forQuery, submittedRequest, resultsRequest, batchRef } }],
    };
    return current;
  }
  const resources = {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit',
      'browser.nativeExpandRange', 'filesystem.write']),
    observe, readResults: observe, currentControl: () => current,
    nativeInputText: async (invocation) => {
      actions.push('input');
      input = invocation.value;
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null };
    },
    nativeSubmit: async () => {
      actions.push('submit');
      submitted = input;
      submittedRequest = 'request-new';
      resultsRequest = 'request-old';
      batchRef = 'batch-old';
      forQuery = input;
      request = 'loading';
      display = 'old';
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null };
    },
    nativeExpandRange: async () => { throw new Error('unexpected expand_range'); },
    collect: async (episode) => { episodes.push(episode); },
  };
  return { bindings, resources, actions, episodes };
}

test('C02/C11 stalled loading with stale results stops after one read without checking the batch', async () => {
  const f = stalledOldResultFixture();
  const resources = modelResources(f.resources);
  const response = await runBrowserSearchGoal({ ...request(f.bindings), maxResultReads: 2 }, resources);
  const readEpisodes = f.episodes.filter((episode) => episode.action === 'read');
  assert.equal(readEpisodes.length, 1);
  const resultEpisode = readEpisodes[0];
  assert.notEqual(resultEpisode.observationFeedback.status, 'satisfied');
  assert.ok(resultEpisode.observationFeedback.unmetFacts.includes('requestSettled'),
    JSON.stringify(resultEpisode.observationFeedback));
  assert.equal(resultEpisode.state.checkedObservationId, null);
  assert.equal(response.kind, 'run_result');
  assert.equal(response.report.control.outcome, 'error');
  const phases = {};
  for (const frame of response.report.frames ?? []) {
    if (frame.depth === 1 && ['input', 'submitted', 'results'].includes(frame.goal.phase)) {
      phases[frame.goal.phase] = frame.execution === 'not_started' ? 'not_evaluated' : frame.fact;
    }
  }
  assert.equal(phases.results, 'unknown');
  assert.equal(response.report.rootEvaluation.result, 'unknown');
});

// === C05/C13 r4 RED/GREEN tests: explicit range-expansion permission boundary + honest unknown ===

function c05fixture(options = {}) {
  // Single-batch page: settled empty result, no expansion container, no hasMore.
  const bindings = { documentRef: 'search-doc', scopeRef: 'search-scope', inputRef: 'query',
    submitRef: 'submit', resultScopeRef: 'results', collectionRef: 'main' };
  let revision = 0;
  let current = null;
  let input = '';
  let submitted = null;
  let forQuery = null;
  let submittedRequest = null;
  let resultsRequest = null;
  let batchRef = null;
  let request = 'unknown';
  let display = 'none';
  const actions = [];
  const episodes = [];
  const fact = (value, id) => value === null ? { status: 'unknown', reason: 'not_observed' }
    : { status: 'observed', value, evidenceRefs: [id] };
  const observe = async () => {
    const observationId = `c05-observation-${++revision}`;
    const id = `${observationId}:evidence`;
    const observedFact = (value) => ({ status: 'observed', value, evidenceRefs: [id] });
    const rangeRequestState = ['loading', 'settled', 'error'].includes(request)
      ? observedFact(request)
      : { status: 'unknown', reason: 'no_positive_request_state_source' };
    const atGeometry = options.atGeometryBoundary === undefined ? { status: 'unknown', reason: options.geometryReason ?? 'not_measured' }
      : { status: 'observed', value: options.atGeometryBoundary, evidenceRefs: [id] };
    const hasMore = options.hasMore === undefined ? { status: 'unknown', reason: 'no_positive_terminal_control_source' }
      : { status: 'observed', value: options.hasMore, evidenceRefs: [id] };
    const target = options.target === false ? undefined : {
      ref: bindings.inputRef, connected: observedFact(true), currentRef: observedFact(bindings.inputRef),
      host: observedFact('input'), contentEditable: observedFact(null), type: observedFact('text'),
      value: fact(input, id), placeholder: observedFact(null), nativeDisabled: observedFact(false),
      ariaDisabled: observedFact(null), nativeReadonly: observedFact(false), ariaReadonly: observedFact(null),
      readonlyState: observedFact('editable'), editable: observedFact(true),
      activeElementRef: observedFact(bindings.inputRef), activeElementFocus: observedFact(true),
      executableHit: observedFact(true), point: observedFact({ x: 10, y: 10 }),
    };
    current = {
      documentRef: bindings.documentRef, scopeRef: bindings.scopeRef, observationId, revision,
      ...(target === undefined ? {} : { target }),
      input: { ref: 'query', tag: 'input', type: 'text', value: fact(input, id), editable: observedFact(true) },
      submitRef: 'submit',
      submittedQuery: fact(submitted, id), resultsFor: fact(forQuery, id),
      submittedRequestRef: fact(submittedRequest, id), resultsRequestRef: fact(resultsRequest, id),
      request, display, access: options.access ?? 'available',
      collection: { ref: 'main', scopeRef: 'results', requestRef: fact('request-new', id),
        batch: fact(batchRef, id),
        items: [] },
      rangeExpansion: { actionMechanicalEffect: 'not_attempted', atGeometryBoundary: atGeometry,
        requestState: rangeRequestState, hasMore,
        collectionTerminal: request === 'settled' && hasMore.status === 'observed' && hasMore.value === false },
      evidence: [{ id, source: 'synthetic.c05', fact: {} }],
    };
    return current;
  };
  const resources = options.resources ?? {
    grantedEffects: options.grantedEffects ?? new Set(['browser.read', 'browser.nativeInputText',
      'browser.nativeSubmit', 'filesystem.write']),
    decision: options.decision ?? handwiredBrowserSearchDecision,
    observe, readResults: observe, currentControl: () => ({ documentRef: current.documentRef,
      observationId: current.observationId, revision: current.revision }),
    nativeInputText: async (invocation) => {
      actions.push('input');
      input = invocation.value;
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null };
    },
    nativeSubmit: async () => {
      actions.push('submit');
      submitted = input;
      submittedRequest = 'request-new';
      resultsRequest = 'request-new';
      batchRef = 'batch-new';
      forQuery = input;
      request = 'settled';
      display = options.display ?? 'empty';
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null };
    },
    nativeExpandRange: async () => { return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null }; },
    collect: async (episode) => { episodes.push(episode); },
  };
  return { bindings, resources, actions, episodes, observe, request: () => request };
}

test('C05 single-batch: no granted expand settles one read, unsatisfied, control error', async () => {
  const f = c05fixture({ display: 'empty' });
  const response = await runBrowserSearchGoal(request(f.bindings), f.resources);
  const readEpisodes = f.episodes.filter(e => e.action === 'read');
  assert.equal(readEpisodes.length, 1, JSON.stringify(f.actions));
  assert.ok(!f.actions.includes('expand_range'));
  assert.equal(response.kind, 'run_result');
  assert.equal(response.report.rootEvaluation.result, 'unsatisfied');
  assert.equal(response.report.control.outcome, 'error');
  const phases = {};
  for (const frame of response.report.frames ?? []) {
    if (frame.depth === 1 && ['input', 'submitted', 'results'].includes(frame.goal.phase)) {
      phases[frame.goal.phase] = frame.execution === 'not_started' ? 'not_evaluated' : frame.fact;
    }
  }
  assert.equal(phases.results, 'unsatisfied');
});

test('C05 model-mode single-batch via run.mjs path: grantedEffects stays without auto-appended expand', async () => {
  // Mirror run.mjs: caller passes no nativeExpandRange in grantedEffects.
  const f = c05fixture({ display: 'empty', grantedEffects: new Set(['browser.read', 'browser.nativeInputText',
    'browser.nativeSubmit', 'filesystem.write']) });
  const modelRes = engineeringModelResources(f.resources);
  const response = await runBrowserSearchGoal(request(f.bindings), modelRes);
  const readEpisodes = f.episodes.filter(e => e.action === 'read');
  assert.equal(readEpisodes.length, 1, JSON.stringify(f.actions));
  assert.ok(!f.actions.includes('expand_range'));
  assert.equal(response.report.rootEvaluation.result, 'unsatisfied');
  assert.equal(response.report.control.outcome, 'error');
});

test('C05 granted-but-missing-executor: explicit resource/capability error, not silent unsatisfied', async () => {
  const f = c05fixture({ display: 'empty' });
  const granted = new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit',
    'browser.nativeExpandRange', 'filesystem.write']);
  const withoutExecutor = { ...f.resources, grantedEffects: granted };
  delete withoutExecutor.nativeExpandRange;
  let threw = false;
  try {
    await runBrowserSearchGoal(request(f.bindings), withoutExecutor);
  } catch (error) {
    threw = true;
    assert.ok(/nativeExpandRange|range|expand|capability|resource/i.test(error.message), error.message);
  }
  assert.ok(threw, 'must reject with explicit resource/capability error');
});

test('C05 geometry-failure stays unknown/DEFER when expand is granted and container geometry is invalid', async () => {
  // #result-scroll-box exists but clientHeight is invalid, and hasMore is
  // unknown. This must not become unsatisfied and must not fabricate a
  // no-expansion surface. B-S1.3 DEFER => root unknown / control stalled.
  const f = c05fixture({ display: 'empty', geometryReason: 'scroll_container_geometry_measurement_failed',
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit',
      'browser.nativeExpandRange', 'filesystem.write']) });
  const modelRes = engineeringModelResources(f.resources);
  const response = await runBrowserSearchGoal(request(f.bindings), modelRes);
  assert.ok(!f.actions.includes('expand_range'));
  assert.equal(response.kind, 'run_result');
  assert.equal(response.report.rootEvaluation.result, 'unknown');
  assert.equal(response.report.control.outcome, 'stalled');
});

test('C05 explicit terminal NOOP keeps unsatisfied and control error', async () => {
  // hasMore observed false with a settled complete batch is an explicit
  // terminal; the model must NOOP and the single-batch goal stays unsatisfied
  // (empty page), control error, with no extra reads or expand.
  const f = c05fixture({ display: 'empty', hasMore: false,
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit',
      'browser.nativeExpandRange', 'filesystem.write']) });
  const modelRes = engineeringModelResources(f.resources);
  const response = await runBrowserSearchGoal(request(f.bindings), modelRes);
  // A read-or-reobserve episode is a real observation read; the NOOP episode
  // carries action 'read' too because phaseAction for results is read, so
  // distinguish by the model step head.
  const readEpisodes = f.episodes.filter(e => e.action === 'read' && e.decision?.step?.head !== 'NOOP');
  assert.equal(readEpisodes.length, 1, JSON.stringify(f.episodes.map(e => e.decision?.step?.head ?? null)));
  assert.ok(!f.actions.includes('expand_range'));
  assert.equal(response.kind, 'run_result');
  assert.equal(response.report.rootEvaluation.result, 'unsatisfied');
  assert.equal(response.report.control.outcome, 'error');
  assert.ok(f.episodes.some(e => e.decision?.step?.head === 'NOOP'), 'explicit terminal must select the NOOP step');
});

test('native-io createResources default grant excludes expand; explicit pass includes it', async () => {
  // Exercise the real native-io.mjs createResources grant builder. The default
  // single-batch IO must be read/input/submit/write only and must NOT include
  // browser.nativeExpandRange; an explicit opt-in must add it. native-io reads
  // BSEARCH_CASE_DIR at import time, so give it a neutral case config.
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'bsearch-grant-'));
  await writeFile(join(dir, 'case.json'), JSON.stringify({selectors: {}, bindings: {}}));
  const previousCaseDir = process.env.BSEARCH_CASE_DIR;
  process.env.BSEARCH_CASE_DIR = dir;
  try {
    const {createGrantedEffects} = await import('../playground/browser/search/native-io.mjs');
    const granted = createGrantedEffects();
    assert.ok(!granted.has('browser.nativeExpandRange'),
      `default grant must not include browser.nativeExpandRange, got ${[...granted].join(',')}`);
    for (const effect of ['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']) {
      assert.ok(granted.has(effect), `default grant must include ${effect}`);
    }
    const explicit = createGrantedEffects({grantedEffects: ['browser.nativeExpandRange']});
    assert.ok(explicit.has('browser.nativeExpandRange'),
      'explicit grant must include browser.nativeExpandRange');
  } finally {
    if (previousCaseDir === undefined) delete process.env.BSEARCH_CASE_DIR;
    else process.env.BSEARCH_CASE_DIR = previousCaseDir;
    await rm(dir, {recursive: true, force: true});
  }
});
