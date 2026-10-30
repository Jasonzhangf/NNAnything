import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {runRecursiveGoal} from '../../workflow/recursive-goal/module.js';
import {readAtomicReceipt,type RecursiveGoalAdapter,type EnabledSkill,type AdapterDiagnostic,
  type EvaluationReceipt,type ProgressReceipt} from '../../workflow/recursive-goal/contracts.js';
import {resolveBrowserSearchDecision,runBrowserSearchEpisode} from '../../nodes/browser-search.js';
import {assertSearchBindings,captureSubmissionBaseline,readBrowserSearchObservation,readBrowserSearchRequest,
  readBrowserSearchState,searchPhaseFact} from './search-observation.js';
import type {BrowserSearchAction,BrowserSearchGoal,BrowserSearchState,BrowserSearchBindings,
  BrowserSearchResources,BrowserSearchEpisode} from './search-contract.js';

const evaluator='browser.search.fact.v1',selector='browser.search.phase.v1';
type Evidence={originalId:string;observationId:string;source:string;fact:unknown};
type Effect={action:string;source:string};
type Adapter=RecursiveGoalAdapter<BrowserSearchGoal,BrowserSearchState,BrowserSearchBindings,Evidence,Effect,BrowserSearchEpisode,null>;
function evidenceFor(state:BrowserSearchState,stateId:string){return state.observation.evidence.map(item=>({id:`${state.observation.observationId}:${item.id}`,stateRef:stateId,
  payload:{originalId:item.id,observationId:state.observation.observationId,source:item.source,fact:item.fact},validity:'valid' as const}));}
const skillId=(phase:string)=>`browser.search.${phase}`;

export function measureBrowserSearchProgress(input:{
  goal:BrowserSearchGoal;before:BrowserSearchState;after:BrowserSearchState;
  previousEvaluation:EvaluationReceipt;currentEvaluation:EvaluationReceipt;
}):ProgressReceipt{
  const newlySatisfied=input.currentEvaluation.result==='satisfied'&&input.previousEvaluation.result!=='satisfied';
  const beforeChecked=input.before.checkedObservationId===input.before.observation.observationId;
  const afterChecked=input.after.checkedObservationId===input.after.observation.observationId;
  const beforeBatch=input.before.observation.collection.batch.status==='observed'?input.before.observation.collection.batch.value:null;
  const afterBatch=input.after.observation.collection.batch.status==='observed'?input.after.observation.collection.batch.value:null;
  const batchCheckAdvanced=input.goal.phase==='results'&&afterChecked&&(!beforeChecked
    ||(beforeBatch!==null&&afterBatch!==null&&afterBatch!==beforeBatch));
  const improved=newlySatisfied||batchCheckAdvanced;
  return {improved,reason:improved?'facts_improved':'none',comparable:true};
}

export async function runBrowserSearchGoal(raw:unknown,resources:BrowserSearchResources){
  const request=readBrowserSearchRequest(raw);
  if(!(resources.grantedEffects instanceof Set)||!resources.decision||!['handwired','model'].includes(resources.decision.source)
    ||typeof resources.decision.id!=='string'||!resources.decision.id||typeof resources.decision.select!=='function'
    ||[resources.observe,resources.readResults,resources.currentControl,resources.nativeInputText,resources.nativeSubmit,resources.collect].some(fn=>typeof fn!=='function'))throw new TypeError('Explicit search resources required');
  if(!resources.grantedEffects.has('browser.read'))throw Error('browser.read permission required');
  const initial=readBrowserSearchObservation(await resources.observe({conditionRef:'root',method:'search-binding',subjectRef:request.bindings.inputRef,scopeRef:request.bindings.scopeRef,requiredFacts:['value','editable'],freshness:'current'}));
  assertSearchBindings(initial,request.bindings);
  const control=await resources.currentControl();
  if(control.documentRef!==initial.documentRef||control.observationId!==initial.observationId||control.revision!==initial.revision)throw Error('Initial search observation is stale');
  const rootGoal:BrowserSearchGoal={...request.goal,phase:'root'};
  const state:BrowserSearchState={observation:initial,checkedObservationId:null,submissionBaseline:captureSubmissionBaseline(initial)};
  const rootAllowed=['browser.read','browser.nativeInputText','browser.nativeSubmit','browser.nativeExpandRange','filesystem.write']
    .filter(effect=>resources.grantedEffects.has(effect));
  const isModel=resources.decision.source==='model';
  // Explicit range-expansion permission boundary: expansion is only enabled when
  // the caller actually granted browser.nativeExpandRange AND a real executor
  // exists. An authorized-but-missing executor is a resource/capability gap and
  // must never be silently collapsed into a single-batch unsatisfied conclusion.
  const expandGranted=resources.grantedEffects.has('browser.nativeExpandRange');
  const expandExecutor=typeof resources.nativeExpandRange==='function';
  if(expandGranted&&!expandExecutor){
    throw Error('browser.nativeExpandRange was granted but resources.nativeExpandRange executor is missing');
  }
  const canExpandRange=isModel&&expandGranted&&expandExecutor;
  const skills:EnabledSkill[]=[
    {id:'browser.search.root',version:'0.1.0',mode:'composite',capability:'browser.search.root',evaluatorId:evaluator,
      requiredEffects:[],allowedEffects:rootAllowed,retry:'never',effectClass:'none'},
    {id:'browser.search.input',version:'0.1.0',mode:'atomic',capability:'browser.search.input',evaluatorId:evaluator,
      requiredEffects:['browser.read','browser.nativeInputText','filesystem.write'],
      allowedEffects:['browser.read','browser.nativeInputText','filesystem.write'],retry:'never',effectClass:'mutating'},
    {id:'browser.search.submitted',version:'0.1.0',mode:'atomic',capability:'browser.search.submitted',evaluatorId:evaluator,
      requiredEffects:['browser.read','browser.nativeSubmit','filesystem.write'],
      allowedEffects:['browser.read','browser.nativeSubmit','filesystem.write'],retry:'never',effectClass:'mutating'},
    {id:'browser.search.results',version:'0.1.0',mode:'atomic',capability:'browser.search.results',evaluatorId:evaluator,
      requiredEffects:['browser.read','filesystem.write'],allowedEffects:['browser.read','filesystem.write'],
      retry:canExpandRange?'completed_no_effect':'never',effectClass:'read_only'},
    ...(canExpandRange?[{
      id:'browser.search.results.expand',version:'0.1.0',mode:'atomic',capability:'browser.search.results',evaluatorId:evaluator,
      requiredEffects:['browser.read','browser.nativeExpandRange','filesystem.write'],
      allowedEffects:['browser.read','browser.nativeExpandRange','filesystem.write'],retry:'completed_no_effect' as const,effectClass:'mutating' as const,
    } satisfies EnabledSkill]:[]),
    {id:'browser.search.results.noop',version:'0.1.0',mode:'atomic',capability:'browser.search.results',evaluatorId:evaluator,
      requiredEffects:['browser.read','filesystem.write'],allowedEffects:['browser.read','filesystem.write'],retry:'never',effectClass:'none'},
  ];
  const adapter:Adapter={
    async validateRequest(envelope){return {requestId:envelope.requestId,rootGoal,satisfactionThreshold:100,rootBindings:request.bindings,state,
      rootEvaluatorId:evaluator,rootSelectorId:selector,...(envelope.limits===undefined?{}:{limits:envelope.limits}),initialObservation:{stateId:initial.observationId,evidence:evidenceFor(state,initial.observationId)},continuation:null};},
    supports:input=>input.goal.kind==='BrowserSearch'&&input.skill.capability===skillId(input.goal.phase),
    async evaluate(input){
      const refs=input.evidence.filter(item=>item.validity==='valid'&&item.payload.observationId===input.state.observation.observationId).map(item=>item.id);
      let fact=searchPhaseFact(input.goal,input.state.observation,input.state.checkedObservationId,input.state.submissionBaseline);
      if(refs.length===0)fact='unknown';
      if(input.goal.phase==='root'&&input.conditions.length>0){
        const facts=input.conditions.map(condition=>condition.fact);
        fact=facts.some(value=>value==='unknown'||value==='not_evaluated')?'unknown':
          facts.some(value=>value==='unsatisfied')?'unsatisfied':'satisfied';
      }
      return {evaluatorId:evaluator,result:fact,satisfaction:fact==='unknown'?null:fact==='satisfied'?100:0,necessaryConditionsMet:fact!=='unknown',evidenceRefs:refs};
    },
    async select(input){
      if(input.goal.phase==='root')return input.candidates.some(skill=>skill.id==='browser.search.root')
        ?{kind:'selected',skillId:'browser.search.root'}:{kind:'no_capability',searchedSkillIds:input.candidates.map(skill=>skill.id)};
      if(!isModel){
        const id=skillId(input.goal.phase);
        return input.candidates.some(skill=>skill.id===id)?{kind:'selected',skillId:id}
          :{kind:'no_capability',searchedSkillIds:input.candidates.map(skill=>skill.id)};
      }
      const decision=await resolveBrowserSearchDecision({goal:input.goal,state:input.state,bindings:input.bindings},resources.decision);
      if(decision.kind==='defer'||decision.step?.head==='DEFER')
        return {kind:'defer',reason:decision.step?`model:${decision.step.head}`:'policy_deferred'};
      const targetSkillId=input.goal.phase==='input'?'browser.search.input':
        input.goal.phase==='submitted'?'browser.search.submitted':
        decision.step?.head==='NOOP'?'browser.search.results.noop':
        decision.action==='expand_range'?'browser.search.results.expand':'browser.search.results';
      return input.candidates.some(skill=>skill.id===targetSkillId)?{kind:'selected',skillId:targetSkillId}
        :{kind:'no_capability',searchedSkillIds:input.candidates.map(skill=>skill.id)};
    },
    async derive(input){return {conditions:(['input','submitted','results'] as const).map((phase,index)=>({id:phase,goal:{...input.goal,phase},
      bindings:input.bindings,satisfactionThreshold:100,evaluatorId:evaluator,selectorId:selector,mode:'atomic',
      dependsOn:index===0?[]:[index===1?'input':'submitted'],lifetime:'stage',activation:'required',
      allowedEffects:(phase==='input'?['browser.read','browser.nativeInputText','filesystem.write']:
        phase==='submitted'?['browser.read','browser.nativeSubmit','filesystem.write']:
        ['browser.read','browser.nativeExpandRange','filesystem.write']).filter(effect=>input.skill.allowedEffects.includes(effect))})),
      nextCursor:null,expansion:'closed'};},
    async executeAtomic(input){
      const expectedSkillAction:BrowserSearchAction|'noop'=input.skill.id==='browser.search.input'?'input':
        input.skill.id==='browser.search.submitted'?'submit':
        input.skill.id==='browser.search.results.expand'?'expand_range':
        input.skill.id==='browser.search.results.noop'?'noop':'read';
      const checkedObservation=input.state.checkedObservationId===input.state.observation.observationId
        ?input.state.observation:null;
      const result=await runBrowserSearchEpisode({goal:input.goal,bindings:input.bindings,maxResultReads:request.maxResultReads??3,
        submissionBaseline:input.state.submissionBaseline,checkedObservationId:null,checkedObservation,
        grantedEffects:new Set(input.skill.allowedEffects.filter(effect=>resources.grantedEffects.has(effect))),
        expectedSkillAction},resources);
      const valid=result.observationFeedback.status==='satisfied'&&result.state!==null;
      const post=valid?{id:result.state!.observation.observationId,value:result.state!}:null;
      const diagnostic=(error:{code:string;message:string},stage:'execution'|'observation'):AdapterDiagnostic=>({diagnosticId:randomUUID(),code:stage==='execution'?'execution_failed':'evidence_unavailable',stage,
        sourceCategory:'browser_search',message:error.message,nativeCode:error.code,refs:[]});
      const isNoopStep=result.decision?.step?.head==='NOOP'&&result.dispatchState==='not_dispatched';
      return {runId:randomUUID(),executorInvoked:result.dispatchState==='unknown'?'unknown':isNoopStep?false:
        result.dispatchState==='dispatched'||(result.action==='read'&&result.executionErrors.length===0),
        outcome:result.executionErrors.length?'failed':valid?'succeeded':'failed',sourceResult:{tag:'browser.search.episode.v1',value:result},newState:post,
        evidence:post===null?[]:evidenceFor(post.value,post.id),executionErrors:result.executionErrors.map(error=>diagnostic(error,'execution')),
        verificationErrors:valid?[]:(result.observationFeedback.errors.length?result.observationFeedback.errors:[{code:'observation_incomplete',message:`Missing ${result.observationFeedback.unmetFacts.join(', ')}`}]).map(error=>diagnostic(error,'observation')),
        effect:{knowledge:result.effectKnowledge,confirmedEffects:result.effectKnowledge==='known'?[{action:result.action,source:result.receipt!.source}]:[],receiptRef:result.receipt===null?null:`search-native:${randomUUID()}`}};
    },
    validateAtomicReceipt:raw=>readAtomicReceipt(raw,{
      state:value=>{const state=readBrowserSearchState(value);assertSearchBindings(state.observation,request.bindings);return state;},
      evidencePayload:value=>value as Evidence,effectFact:value=>value as Effect,receiptPayload:value=>value as BrowserSearchEpisode,
    }),
    measureProgress:input=>measureBrowserSearchProgress(input),
    async collect(input){await resources.collectRoot?.(input);return {receiptId:`search-collection:${randomUUID()}`};},
  };
  const limits=request.limits;
  return runRecursiveGoal({schema:'nnanything.recursive-goal.request.v1',requestId:request.requestId,rootGoal,satisfactionThreshold:100,rootBindings:request.bindings,state,rootEvaluatorId:evaluator,rootSelectorId:selector,...(limits===undefined?{}:{limits}),
    initialObservation:{stateId:initial.observationId,evidence:evidenceFor(state,initial.observationId)}},
    {adapter,enabledSkills:skills,enabledEvaluators:[{id:evaluator,goalType:'BrowserSearch',thresholdContract:'0..100',allowsPartialSatisfaction:false}],selectors:[{id:selector,skillIds:skills.map(skill=>skill.id)}],
      comparators:{sameGoal:isDeepStrictEqual,sameBindings:isDeepStrictEqual,sameFacts:(left,right)=>isDeepStrictEqual({state:businessFacts(left.state),conditions:left.conditions.map(c=>c.fact)},{state:businessFacts(right.state),conditions:right.conditions.map(c=>c.fact)})},
      grantedEffects:resources.grantedEffects,...(resources.signal===undefined?{}:{signal:resources.signal})});
}
function businessFacts(state:BrowserSearchState){const o=state.observation;return {value:o.input.value.status==='observed'?o.input.value.value:null,
  submitted:o.submittedQuery.status==='observed'?o.submittedQuery.value:null,
  resultsFor:o.resultsFor.status==='observed'?o.resultsFor.value:null,
  submittedRequestRef:o.submittedRequestRef.status==='observed'?o.submittedRequestRef.value:null,
  resultsRequestRef:o.resultsRequestRef.status==='observed'?o.resultsRequestRef.value:null,
  collectionRequestRef:o.collection.requestRef.status==='observed'?o.collection.requestRef.value:null,
  batch:o.collection.batch.status==='observed'?o.collection.batch.value:null,
  baseline:state.submissionBaseline,request:o.request,display:o.display,access:o.access,
  items:o.collection.items.map(item=>[item.ref,item.collectionRef,item.role,item.text.status==='observed'?item.text.value:null]),
  checked:state.checkedObservationId===o.observationId};}
