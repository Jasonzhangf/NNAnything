import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {NodeDefinition} from '../core/contracts.js';
import {expectRecord} from '../core/schema.js';
import {createWorkflowInputEvent} from '../core/events.js';
import {loadWorkflow} from '../workflow/loader.js';
import {compileWorkflow} from '../workflow/compiler.js';
import {runWorkflow} from '../workflow/runner.js';
import type {BrowserSearchBindings, BrowserSearchGoal, BrowserSearchResources, BrowserSearchEpisode, BrowserSearchObservation} from '../adapters/browser/search-contract.js';
import {assertSearchBindings,knownEqual,readBrowserSearchObservation,searchContentFact} from '../adapters/browser/search-observation.js';

interface Input {goal:BrowserSearchGoal;bindings:BrowserSearchBindings;maxResultReads:number}
interface Stage extends BrowserSearchEpisode {input:Input;before:BrowserSearchObservation|null}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const ports=['request','observed','recognized','decision','receipt','reobserved','verified','ended'].map(name=>({
  name:`${name}_event`,schemaId:`browser.search/${name}/v1`,eventType:`browser.search.${name}.v1`,
  validate:(value:unknown)=>expectRecord(value,'browser search stage'),
}));
const names=['dom.observeState','dom.recognizeWorkflow','operation.decide','operation.apply','dom.reobserve','operation.verify','operation.report'];
const sameControl=(a:BrowserSearchObservation,b:{documentRef:string;observationId:string;revision:number})=>a.documentRef===b.documentRef&&a.observationId===b.observationId&&a.revision===b.revision;
const failed=(s:Stage,code:string,text:string):Stage=>({...s,executionErrors:[...s.executionErrors,{code,message:text}]});
function observationFailure(s:Stage,code:string,text:string):Stage{return {...s,state:null,observationFeedback:{...s.observationFeedback,status:'failed',errors:[{code,message:text}]}};}
function episode(s:Stage):BrowserSearchEpisode {const {input:_,before:__,...result}=s;return result;}

export async function runBrowserSearchEpisode(input:Input,resources:BrowserSearchResources):Promise<BrowserSearchEpisode>{
  const action=input.goal.phase==='input'?'input':input.goal.phase==='submitted'?'submit':'read';
  const obligation={conditionRef:input.goal.phase,method:action==='input'?'input-value':action==='submit'?'submitted-query':'result-content',
    subjectRef:action==='input'?input.bindings.inputRef:action==='submit'?input.bindings.submitRef:input.bindings.collectionRef,
    scopeRef:action==='read'?input.bindings.resultScopeRef:input.bindings.scopeRef,requiredFacts:action==='input'?['value','editable']:action==='submit'?['submittedQuery']:['resultsFor','content','batch'],freshness:'after_action' as const};
  const definitions:NodeDefinition[]=names.map((operator,index)=>({operator,version:'0.1.0-design',inputPorts:[ports[index]!],outputPort:ports[index+1]!,
    effects:index===0||index===4?['browser.read']:index===3?[action==='input'?'browser.nativeInputText':action==='submit'?'browser.nativeSubmit':'browser.read']:index===6?['filesystem.write']:[],
    acceptNonOkInputs:true,
    async execute(context){
      let s=context.inputs[0]!.payload as Stage;
      if(index===0){
        s={input,before:null,action,decisionSource:{id:resources.decision.id,source:resources.decision.source},decision:null,invocation:null,receipt:null,
          dispatchState:'not_dispatched',effectKnowledge:'none',state:null,executionErrors:[],collectionError:null,
          observationFeedback:{obligation,status:'incomplete',observationId:null,evidenceRefs:[],unmetFacts:obligation.requiredFacts,errors:[]}};
        try {const before=readBrowserSearchObservation(await resources.observe({...obligation,freshness:'current'}));assertSearchBindings(before,input.bindings);
          if(!sameControl(before,await resources.currentControl()))throw Error('Initial search reference is stale');
          s={...s,before};
        }catch(error){s=observationFailure(s,'observation_failed',message(error));}
      }else if(index===1&&s.before!==null){
        const host=s.before.input;
        if(host.tag!=='input'||host.type!=='text')s=failed(s,'unsupported_host','Only ordinary text input is enabled');
        else if(s.before.access!=='available')s=failed(s,'access_unavailable',`Search access is ${s.before.access}`);
        else if(action!=='read'&&(host.editable.status!=='observed'||host.editable.value!==true))s=failed(s,'precondition_unsatisfied','Input editability is not confirmed');
      }else if(index===2&&s.before!==null&&s.executionErrors.length===0){
        try{const decision=await resources.decision.select({goal:input.goal,state:{observation:s.before,checkedObservationId:null},bindings:input.bindings});
          s={...s,decision};
          if(!decision||decision.kind!=='selected'||decision.action!==action)s=failed(s,'policy_deferred','Decision did not select the enabled current action');
          else if(action==='submit'&&!knownEqual(s.before!.input.value,input.goal.query))s=failed(s,'precondition_unsatisfied','Fresh input value differs from query; submit denied');
          else if(action!=='read')s={...s,invocation:{kind:action,targetRef:action==='input'?input.bindings.inputRef:input.bindings.submitRef,value:action==='input'?input.goal.query:null,
            documentRef:s.before!.documentRef,observationId:s.before!.observationId,revision:s.before!.revision}};
        }catch(error){s=failed(s,'decision_failed',message(error));}
      }else if(index===3&&s.invocation!==null&&s.before!==null&&s.executionErrors.length===0){
        try{
          if(resources.signal?.aborted)throw Error('Search cancelled before dispatch');
          if(!sameControl(s.before!,await resources.currentControl()))throw Error('Search reference changed before dispatch');
        }catch(error){s=failed(s,'stale_reference',message(error));return context.emit(s);}
        const invocation=s.invocation;
        s={...s,dispatchState:'unknown',effectKnowledge:'unknown'};
        try{const receipt=await (action==='input'?resources.nativeInputText(invocation):resources.nativeSubmit(invocation));
          if(!receipt||typeof receipt.dispatched!=='boolean'||typeof receipt.ok!=='boolean'||!['none','known','unknown'].includes(receipt.effectKnowledge)
            ||typeof receipt.source!=='string'||!receipt.source||(!receipt.dispatched&&receipt.effectKnowledge!=='none')
            ||(receipt.error!==null&&(!receipt.error||typeof receipt.error.code!=='string'||typeof receipt.error.message!=='string')))throw Error('Malformed native search receipt');
          s={...s,receipt,dispatchState:receipt.dispatched?'dispatched':'not_dispatched',effectKnowledge:receipt.effectKnowledge};
          if(receipt.error||!receipt.ok)s=failed(s,receipt.error?.code??'execution_rejected',receipt.error?.message??'Executor rejected current action');
        }catch(error){s=failed(s,'native_action_failed',message(error));}
      }else if(index===4&&s.before!==null){
        const shouldRead=action==='read'&&s.executionErrors.length===0;
        if(s.dispatchState!=='not_dispatched'||shouldRead){
          try{
            let post:BrowserSearchObservation|null=null;
            for(let count=0;count<(shouldRead?input.maxResultReads:1);count++){
              if(resources.signal?.aborted)throw Error('Search cancelled during observation');
              post=readBrowserSearchObservation(await (shouldRead?resources.readResults(obligation):resources.observe(obligation)));
              assertSearchBindings(post,input.bindings);
              if(!sameControl(post,await resources.currentControl())||post.revision<=s.before.revision||post.observationId===s.before.observationId)throw Error('Post-action observation is stale');
              if(!shouldRead||post.request!=='loading')break;
            }
            s={...s,state:{observation:post!,checkedObservationId:shouldRead?post!.observationId:null}};
          }catch(error){s=observationFailure(s,'post_observation_failed',message(error));}
        }
      }else if(index===5&&s.state!==null){
        const post=s.state.observation;
        const unmet=action==='input'?['value','editable'].filter(key=>post.input[key as 'value'|'editable'].status!=='observed'):
          action==='submit'?(post.submittedQuery.status==='observed'?[]:['submittedQuery']):
          [...(post.resultsFor.status==='observed'?[]:['resultsFor']),...(post.collection.batch.status==='observed'?[]:['batch']),
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
  const compiled=compileWorkflow(definition,{nodeDefinitions:definitions,grantedEffects:[...resources.grantedEffects]});
  const runId=randomUUID();const result=await runWorkflow(compiled,createWorkflowInputEvent({runId,eventId:`${runId}:input`,port:'request_event',type:'browser.search.request.v1',payload:input}));
  if(result.status==='failed')throw Error(result.error.message);
  return result.outputEvent.payload as BrowserSearchEpisode;
}
