import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {NodeDefinition} from '../core/contracts.js';
import {expectRecord} from '../core/schema.js';
import {createWorkflowInputEvent} from '../core/events.js';
import {loadWorkflow} from '../workflow/loader.js';
import {compileWorkflow} from '../workflow/compiler.js';
import {runWorkflow} from '../workflow/runner.js';
import type {BrowserSearchAction, BrowserSearchBindings, BrowserSearchDecision, BrowserSearchDecisionBinding,
  BrowserSearchGoal, BrowserSearchResources, BrowserSearchEpisode, BrowserSearchInvocation, BrowserSearchObservation,
  BrowserSearchState, BrowserSearchSubmissionBaseline} from '../adapters/browser/search-contract.js';
import {assertSearchBindings,captureSubmissionBaseline,isSameCheckedResultBatch,knownEqual,readBrowserSearchObservation,searchContentFact} from '../adapters/browser/search-observation.js';
import {predictBrowserInputPolicy,predictBrowserQueryRelation,predictBrowserSearchStepPolicy,
  readBrowserInputPolicyProfile,readBrowserQueryRelationProfile,readBrowserStepPolicyProfile,
  type BrowserInputPolicyPrediction,type BrowserQueryRelationPrediction} from '../filters/browser-stage1-policy.js';

interface Input {goal:BrowserSearchGoal;bindings:BrowserSearchBindings;maxResultReads:number;
  submissionBaseline?:BrowserSearchSubmissionBaseline|null;checkedObservationId?:string|null;
  checkedObservation?:BrowserSearchObservation|null;grantedEffects?:ReadonlySet<string>;
  expectedSkillAction?:BrowserSearchAction|'noop'}
type Mode='dispatch'|'noop'|'defer';
interface Stage extends BrowserSearchEpisode {input:Input;before:BrowserSearchObservation|null;phaseAction:BrowserSearchAction;mode:Mode;
  queryRelation?:BrowserQueryRelationPrediction;checkedObservationId:string|null}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const ports=['request','observed','recognized','decision','receipt','reobserved','verified','ended'].map(name=>({
  name:`${name}_event`,schemaId:`browser.search/${name}/v1`,eventType:`browser.search.${name}.v1`,
  validate:(value:unknown)=>expectRecord(value,'browser search stage'),
}));
const names=['dom.observeState','dom.recognizeWorkflow','operation.decide','operation.apply','dom.reobserve','operation.verify','operation.report'];
const sameControl=(a:BrowserSearchObservation,b:{documentRef:string;observationId:string;revision:number})=>a.documentRef===b.documentRef&&a.observationId===b.observationId&&a.revision===b.revision;
const failed=(s:Stage,code:string,text:string):Stage=>({...s,executionErrors:[...s.executionErrors,{code,message:text}]});
function observationFailure(s:Stage,code:string,text:string):Stage{return {...s,state:null,observationFeedback:{...s.observationFeedback,status:'failed',errors:[{code,message:text}]}};}
function episode(s:Stage):BrowserSearchEpisode {const {input:_,before:___,phaseAction:____,mode:_____,...result}=s;return result;}
function actionForHead(head:string):BrowserSearchAction|null{
  return head==='input'?'input':head==='submit'?'submit':head==='read_or_reobserve'?'read':
    head==='expand_range'?'expand_range':null;
}
function phaseActionOf(goal:BrowserSearchGoal):BrowserSearchAction{
  return goal.phase==='input'?'input':goal.phase==='submitted'?'submit':'read';
}
function obligationFor(input:Input,action:BrowserSearchAction){
  const method=action==='input'?'input-value':action==='submit'?'submitted-query':'result-content';
  return {conditionRef:input.goal.phase,method,
    subjectRef:action==='input'?input.bindings.inputRef:action==='submit'?input.bindings.submitRef:input.bindings.collectionRef,
    scopeRef:action==='read'?input.bindings.resultScopeRef:input.bindings.scopeRef,
    requiredFacts:action==='input'?['value','editable']:action==='submit'?['submittedQuery','submittedRequestRef']:
      ['resultsFor','submittedRequestRef','resultsRequestRef','collection.requestRef','content','batch'],freshness:'after_action' as const};
}

export async function resolveBrowserSearchDecision(input:{
  goal:BrowserSearchGoal;state:BrowserSearchState;bindings:BrowserSearchBindings;
  precomputedQueryRelation?:BrowserQueryRelationPrediction;
},binding:BrowserSearchDecisionBinding):Promise<BrowserSearchDecision>{
  if(!binding||typeof binding!=='object')throw new TypeError('search decision binding is required');
  if(binding.source==='handwired'){
    if(typeof binding.select!=='function')throw new TypeError('handwired search decision binding requires decision.select');
    return binding.select({goal:input.goal,state:input.state,bindings:input.bindings});
  }
  if(binding.source==='model'){
    if(binding.stepPolicyProfile===undefined)throw new TypeError('model search decision binding requires stepPolicyProfile');
    const inputPolicyProfile=binding.inputPolicyProfile===undefined?null:readBrowserInputPolicyProfile(binding.inputPolicyProfile);
    const stepProfile=readBrowserStepPolicyProfile(binding.stepPolicyProfile);
    let inputPrediction:BrowserInputPolicyPrediction|undefined;
    if(input.goal.phase==='input'&&inputPolicyProfile!==null&&input.state.observation.target!==undefined){
      inputPrediction=predictBrowserInputPolicy({documentRef:input.state.observation.documentRef,scopeRef:input.state.observation.scopeRef,
        observationId:input.state.observation.observationId,revision:input.state.observation.revision,
        target:input.state.observation.target,neighbors:[],evidence:input.state.observation.evidence},
        input.goal.query,false,inputPolicyProfile);
    }
    let queryRelation=input.precomputedQueryRelation;
    if(queryRelation===undefined&&input.goal.phase!=='input'&&binding.queryRelationProfile!==undefined){
      queryRelation=predictBrowserQueryRelation(input.state,input.goal,readBrowserQueryRelationProfile(binding.queryRelationProfile));
    }
    const inputHead=inputPrediction?.head??(input.goal.phase==='input'?'DEFER':null);
    const step=predictBrowserSearchStepPolicy(input.state,input.goal,inputHead,queryRelation?.head??null,stepProfile);
    return {kind:step.head==='DEFER'?'defer':'selected',action:actionForHead(step.head),
      ...(queryRelation===undefined?{}:{queryRelation}),...(inputPrediction===undefined?{}:{input:inputPrediction}),step};
  }
  throw new TypeError(`unsupported decision source: ${String((binding as {source?:unknown}).source)}`);
}

export async function runBrowserSearchEpisode(input:Input,resources:BrowserSearchResources):Promise<BrowserSearchEpisode>{
  if(input.grantedEffects!==undefined&&!(input.grantedEffects instanceof Set))throw new TypeError('grantedEffects override must be a Set when provided');
  const effectiveGrantedEffects=new Set([...resources.grantedEffects].filter(effect=>
    input.grantedEffects===undefined||input.grantedEffects.has(effect)));
  if(!effectiveGrantedEffects.has('browser.read'))throw new Error('browser.read permission required');
  const phaseAction=phaseActionOf(input.goal);
  const obligation=obligationFor(input,phaseAction);
  const model=resources.decision.source==='model';
  const declaredApplyEffects=(input.expectedSkillAction==='noop'?[]:
    input.expectedSkillAction==='expand_range'?['browser.nativeExpandRange']:
    input.expectedSkillAction==='input'?['browser.nativeInputText']:
    input.expectedSkillAction==='submit'?['browser.nativeSubmit']:
    input.expectedSkillAction==='read'?['browser.read']:
    phaseAction==='input'?['browser.nativeInputText']:
    phaseAction==='submit'?['browser.nativeSubmit']:
    effectiveGrantedEffects.has('browser.nativeExpandRange')?['browser.read','browser.nativeExpandRange']:['browser.read'])
    .filter(effect=>effectiveGrantedEffects.has(effect));
  const definitions:NodeDefinition[]=names.map((operator,index)=>({operator,version:'0.1.0-design',inputPorts:[ports[index]!],outputPort:ports[index+1]!,
    effects:index===0||index===4?['browser.read']:index===3?declaredApplyEffects:index===6?['filesystem.write']:[],
    acceptNonOkInputs:true,
    async execute(context){
      let s=context.inputs[0]!.payload as Stage;
      if(index===0){
        s={input,before:null,action:phaseAction,phaseAction,mode:'dispatch',decisionSource:{id:resources.decision.id,source:resources.decision.source},decision:null,invocation:null,receipt:null,
          dispatchState:'not_dispatched',effectKnowledge:'none',state:null,executionErrors:[],collectionError:null,
          checkedObservationId:input.checkedObservationId??null,
          submissionBaseline:input.submissionBaseline??null,
          observationFeedback:{obligation,status:'incomplete',observationId:null,evidenceRefs:[],unmetFacts:obligation.requiredFacts,errors:[]}};
        try {const before=readBrowserSearchObservation(await resources.observe({...obligation,freshness:'current'}));assertSearchBindings(before,input.bindings);
          if(!sameControl(before,await resources.currentControl()))throw Error('Initial search reference is stale');
          const resolvedCheckedObservationId=input.checkedObservationId!==undefined&&input.checkedObservationId!==null
            ?input.checkedObservationId
            :input.checkedObservation!==undefined&&input.checkedObservation!==null
              &&isSameCheckedResultBatch(input.checkedObservation,before,input.goal)
              ?before.observationId:null;
          s={...s,before,checkedObservationId:resolvedCheckedObservationId,
            submissionBaseline:input.submissionBaseline===undefined?captureSubmissionBaseline(before):input.submissionBaseline};
        }catch(error){s=observationFailure(s,'observation_failed',message(error));}
      }else if(index===1&&s.before!==null){
        // checkedObservationId reflects the recursive controller's already-read
        // batch. It is observed state, not a model prediction, so it must be
        // threaded through unchanged (BP11b relies on it for a checked terminal).
        const checked=s.checkedObservationId;
        let nextStage=s;
        if(model){
          if(input.goal.phase!=='input'&&resources.decision.queryRelationProfile!==undefined){
            try{
              const profile=readBrowserQueryRelationProfile(resources.decision.queryRelationProfile);
              nextStage={...s,queryRelation:predictBrowserQueryRelation({observation:s.before,checkedObservationId:checked,
                submissionBaseline:s.submissionBaseline},input.goal,profile)};
            }catch(error){nextStage=failed(s,'recognize_failed',message(error));}
          }
        }else{
          const host=s.before.input;
          if(host.tag!=='input'||host.type!=='text')nextStage=failed(s,'unsupported_host','Only ordinary text input is enabled');
          else if(phaseAction!=='read'&&s.before.access!=='available')nextStage=failed(s,'precondition_unsatisfied',`Search access is ${s.before.access}`);
          else if(phaseAction!=='read'&&(host.editable.status!=='observed'||host.editable.value!==true))nextStage=failed(s,'precondition_unsatisfied','Input editability is not confirmed');
        }
        s=nextStage;
      }else if(index===2&&s.before!==null&&s.executionErrors.length===0){
        const state={observation:s.before,checkedObservationId:s.checkedObservationId,submissionBaseline:s.submissionBaseline};
        try{
          if(model){
            const decision=await resolveBrowserSearchDecision({goal:input.goal,state,bindings:input.bindings,
              ...(s.queryRelation===undefined?{}:{precomputedQueryRelation:s.queryRelation})},resources.decision);
            s={...s,decision};
            const stepHead=decision.step?.head;
            const mapped=decision.action;
            const freshSkillAction=stepHead==='DEFER'||decision.kind==='defer'?'defer':stepHead==='NOOP'?'noop':mapped;
            const skillMatches=input.expectedSkillAction===undefined||freshSkillAction===input.expectedSkillAction
              ||((input.goal.phase==='input'||input.goal.phase==='submitted')&&freshSkillAction==='noop');
            if(!skillMatches){
              s=failed({...s,mode:'defer',action:phaseAction,invocation:null},'stale_skill_selection',
                `Observation changed before dispatch: selected skill expected ${input.expectedSkillAction} but fresh observation requires ${String(freshSkillAction)}`);
            }else if(stepHead==='NOOP'){
              s={...s,mode:'noop',action:phaseAction};
            }else if(stepHead==='DEFER'||decision.kind==='defer'){
              s={...s,mode:'defer',action:phaseAction};
            }else if(mapped!==null){
              const expectedActions:readonly BrowserSearchAction[]=input.goal.phase==='input'?['input']:
                input.goal.phase==='submitted'?['submit']:['read','expand_range'];
              const requiredEffect=mapped==='input'?'browser.nativeInputText':mapped==='submit'?'browser.nativeSubmit':
                mapped==='expand_range'?'browser.nativeExpandRange':'browser.read';
              s={...s,mode:'dispatch',action:mapped};
              if(!expectedActions.includes(mapped)){
                s=failed({...s,invocation:null},'wrong_phase_action',`Action ${mapped} is invalid for phase ${input.goal.phase}`);
              }else if(!effectiveGrantedEffects.has(requiredEffect)){
                s=failed({...s,invocation:null},'permission_denied',`${requiredEffect} permission required`);
              }else if(mapped==='expand_range'&&typeof resources.nativeExpandRange!=='function'){
                s=failed({...s,invocation:null},'capability_missing','nativeExpandRange resource required for expand_range');
              }else if(mapped==='submit'&&!knownEqual(s.before!.input.value,input.goal.query)){
                s=failed(s,'precondition_unsatisfied','Fresh input value differs from query; submit denied');
              }else if(mapped==='input'||mapped==='submit'||mapped==='expand_range'){
                s={...s,invocation:{kind:mapped,
                  targetRef:mapped==='input'?input.bindings.inputRef:mapped==='submit'?input.bindings.submitRef:input.bindings.collectionRef,
                  value:mapped==='input'?input.goal.query:null,documentRef:s.before!.documentRef,
                  observationId:s.before!.observationId,revision:s.before!.revision}};
              }
            }
          }else{
            const decision=await resolveBrowserSearchDecision({goal:input.goal,state:{observation:s.before,
              checkedObservationId:null,submissionBaseline:s.submissionBaseline},bindings:input.bindings},resources.decision);
            s={...s,decision};
            const requiredEffect=phaseAction==='input'?'browser.nativeInputText':phaseAction==='submit'?'browser.nativeSubmit':'browser.read';
            if(!decision||decision.kind!=='selected'||decision.action!==phaseAction)s=failed(s,'policy_deferred','Decision did not select the enabled current action');
            else if(!effectiveGrantedEffects.has(requiredEffect))s=failed(s,'permission_denied',`${requiredEffect} permission required`);
            else if(phaseAction==='submit'&&!knownEqual(s.before!.input.value,input.goal.query))s=failed(s,'precondition_unsatisfied','Fresh input value differs from query; submit denied');
            else if(phaseAction!=='read')s={...s,invocation:{kind:phaseAction,targetRef:phaseAction==='input'?input.bindings.inputRef:input.bindings.submitRef,value:phaseAction==='input'?input.goal.query:null,
              documentRef:s.before!.documentRef,observationId:s.before!.observationId,revision:s.before!.revision}};
          }
        }catch(error){s=failed(s,'decision_failed',message(error));}
      }else if(index===3&&s.invocation!==null&&s.before!==null&&s.executionErrors.length===0){
        try{
          if(resources.signal?.aborted)throw Error('Search cancelled before dispatch');
          if(!sameControl(s.before!,await resources.currentControl()))throw Error('Search reference changed before dispatch');
        }catch(error){s=failed(s,'stale_reference',message(error));return context.emit(s);}
        const invocation=s.invocation;
        s={...s,dispatchState:'unknown',effectKnowledge:'unknown'};
        try{const receipt=await (s.action==='input'?resources.nativeInputText(invocation):
          s.action==='expand_range'?resources.nativeExpandRange!(invocation):resources.nativeSubmit(invocation));
          if(!receipt||typeof receipt.dispatched!=='boolean'||typeof receipt.ok!=='boolean'||!['none','known','unknown'].includes(receipt.effectKnowledge)
            ||typeof receipt.source!=='string'||!receipt.source||(!receipt.dispatched&&receipt.effectKnowledge!=='none')
            ||(receipt.error!==null&&(!receipt.error||typeof receipt.error.code!=='string'||typeof receipt.error.message!=='string')))throw Error('Malformed native search receipt');
          s={...s,receipt,dispatchState:receipt.dispatched?'dispatched':'not_dispatched',effectKnowledge:receipt.effectKnowledge};
          if(receipt.error||!receipt.ok)s=failed(s,receipt.error?.code??'execution_rejected',receipt.error?.message??'Executor rejected current action');
        }catch(error){s=failed(s,'native_action_failed',message(error));}
      }else if(index===4&&s.before!==null){
        const readPhase=phaseAction==='read';
        const noop=s.mode==='noop';
        if(noop){
          // NOOP never invokes an executor. Preserve only a checked results
          // batch so index5 can verify the real target; an unread batch keeps
          // checkedObservationId=null and cannot establish satisfaction.
          s={...s,state:{observation:s.before,checkedObservationId:readPhase?s.checkedObservationId:null,
            submissionBaseline:s.submissionBaseline}};
        }else{
          const shouldRead=readPhase&&s.action==='read'&&s.executionErrors.length===0&&s.mode==='dispatch';
          const shouldObserve=s.mode==='defer'?false:(s.dispatchState!=='not_dispatched'||shouldRead);
          if(shouldObserve){
            try{
              let post:BrowserSearchObservation|null=null;
              const max=shouldRead&&s.mode==='dispatch'?input.maxResultReads:1;
              for(let count=0;count<max;count++){
                if(resources.signal?.aborted)throw Error('Search cancelled during observation');
                post=readBrowserSearchObservation(await (shouldRead?resources.readResults(obligation):resources.observe(obligation)));
                assertSearchBindings(post,input.bindings);
                if(!sameControl(post,await resources.currentControl())||post.revision<=s.before.revision||post.observationId===s.before.observationId)throw Error('Post-action observation is stale');
                if(!shouldRead||post.request!=='loading')break;
              }
              s={...s,state:{observation:post!,checkedObservationId:shouldRead&&post!.request==='settled'?post!.observationId:null,
                submissionBaseline:s.submissionBaseline}};
            }catch(error){s=observationFailure(s,'post_observation_failed',message(error));}
          }
        }
      }else if(index===5&&s.state!==null){
        const post=s.state.observation;
        const action=phaseAction;
        const unmet=action==='input'?['value','editable'].filter(key=>post.input[key as 'value'|'editable'].status!=='observed'):
          action==='submit'?[...(post.submittedQuery.status==='observed'?[]:['submittedQuery']),
            ...(post.submittedRequestRef.status==='observed'?[]:['submittedRequestRef'])]:
          [...(post.resultsFor.status==='observed'?[]:['resultsFor']),
            ...(post.submittedRequestRef.status==='observed'?[]:['submittedRequestRef']),
            ...(post.resultsRequestRef.status==='observed'?[]:['resultsRequestRef']),
            ...(post.collection.requestRef.status==='observed'?[]:['collection.requestRef']),
            ...(post.collection.batch.status==='observed'?[]:['batch']),
            ...(post.request==='settled'?[]:['requestSettled']),
            ...(searchContentFact(input.goal,post)==='unknown'?['content']:[])];
        s={...s,observationFeedback:{...s.observationFeedback,status:unmet.length?'incomplete':'satisfied',observationId:post.observationId,
          evidenceRefs:post.evidence.map(item=>item.id),unmetFacts:unmet,errors:[]}};
      }else if(index===6){
        let result=episode(s);try{await resources.collect(result);}catch(error){result={...result,collectionError:message(error)};}
        return context.emit(result);
      }
      return context.emit(s);
    },
  }));
  const configPath=fileURLToPath(new URL('../../workflows/browser-search.workflow.json',import.meta.url));
  const definition=await loadWorkflow({configPath,allowedRoot:fileURLToPath(new URL('../../workflows/',import.meta.url))});
  const compiled=compileWorkflow(definition,{nodeDefinitions:definitions,grantedEffects:[...effectiveGrantedEffects]});
  const runId=randomUUID();const result=await runWorkflow(compiled,createWorkflowInputEvent({runId,eventId:`${runId}:input`,port:'request_event',type:'browser.search.request.v1',payload:input}));
  if(result.status==='failed')throw Error(result.error.message);
  return result.outputEvent.payload as BrowserSearchEpisode;
}
