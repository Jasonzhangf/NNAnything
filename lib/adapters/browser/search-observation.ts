import {expectRecord} from '../../core/schema.js';
import type {ActionObservation} from './single-action-contract.js';
import type {BrowserSearchBindings, BrowserSearchGoal, BrowserSearchObservation, BrowserSearchRequest,
  BrowserSearchState, BrowserSearchSubmissionBaseline} from './search-contract.js';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function fact(value: unknown, kind: 'string' | 'boolean', ids: ReadonlySet<string>): void {
  const row = expectRecord(value, 'search observed fact');
  if (row.status === 'unknown' && text(row.reason)) return;
  if (row.status !== 'observed' || typeof row.value !== kind || !Array.isArray(row.evidenceRefs)
    || row.evidenceRefs.length === 0 || row.evidenceRefs.some(id => typeof id !== 'string' || !ids.has(id))) {
    throw new TypeError('Search fact requires typed value and local evidence');
  }
}
function refFact(value: unknown, ids: ReadonlySet<string>): void {
  fact(value, 'string', ids);
  const row = expectRecord(value, 'search reference fact');
  if (row.status === 'observed' && !text(row.value)) throw new TypeError('Search reference must be non-empty');
}
export function captureSubmissionBaseline(observation: BrowserSearchObservation): BrowserSearchSubmissionBaseline {
  const submittedRequestRef=observation.submittedRequestRef.status==='observed'?observation.submittedRequestRef.value:null;
  const resultsRequestRef=observation.resultsRequestRef.status==='observed'?observation.resultsRequestRef.value:null;
  const batchRef=observation.collection.batch.status==='observed'?observation.collection.batch.value:null;
  const observedSubmission=submittedRequestRef!==null||observation.submittedQuery.status==='observed'
    ?true:observation.display==='none'?false:null;
  return {submittedRequestRef,resultsRequestRef,batchRef,observedSubmission};
}
export function readBrowserSearchSubmissionBaseline(value: unknown): BrowserSearchSubmissionBaseline {
  const row=expectRecord(value,'browser search submission baseline');
  for(const key of ['submittedRequestRef','resultsRequestRef','batchRef']){
    if(row[key]!==null&&!text(row[key]))throw new TypeError('Invalid search submission baseline reference');
  }
  if(row.observedSubmission!==null&&typeof row.observedSubmission!=='boolean')throw new TypeError('Invalid search submission baseline presence');
  return {submittedRequestRef:row.submittedRequestRef as string|null,resultsRequestRef:row.resultsRequestRef as string|null,
    batchRef:row.batchRef as string|null,observedSubmission:row.observedSubmission as boolean|null};
}
export function readBrowserSearchObservation(value: unknown): BrowserSearchObservation {
  const row = expectRecord(value, 'browser search observation');
  if (![row.documentRef,row.scopeRef,row.observationId,row.submitRef].every(text)
    || !Number.isSafeInteger(row.revision) || Number(row.revision)<0 || !Array.isArray(row.evidence)) {
    throw new TypeError('Invalid search observation identity');
  }
  const ids = new Set<string>();
  for (const raw of row.evidence) {
    const e = expectRecord(raw,'search evidence');
    if (!text(e.id) || ids.has(e.id) || !text(e.source) || !Object.hasOwn(e,'fact')) throw new TypeError('Invalid search evidence');
    ids.add(e.id);
  }
  const host = expectRecord(row.input,'search input');
  if (!text(host.ref) || !['input','textarea','contenteditable','unknown'].includes(String(host.tag)) || !text(host.type)) throw new TypeError('Invalid search host');
  fact(host.value,'string',ids);fact(host.editable,'boolean',ids);
  fact(row.submittedQuery,'string',ids);fact(row.resultsFor,'string',ids);
  refFact(row.submittedRequestRef,ids);refFact(row.resultsRequestRef,ids);
  if (!['loading','settled','error','unknown'].includes(String(row.request))
    || !['none','old','current','empty','partial','unknown'].includes(String(row.display))
    || !['available','login_required','challenge','unknown'].includes(String(row.access))) throw new TypeError('Invalid search states');
  const collection = expectRecord(row.collection,'search collection');
  if (![collection.ref,collection.scopeRef].every(text) || !Array.isArray(collection.items)) throw new TypeError('Invalid search collection');
  refFact(collection.requestRef,ids);refFact(collection.batch,ids);
  const members = new Set<string>();
  for (const raw of collection.items) {
    const item=expectRecord(raw,'search item');
    if (!text(item.ref)||members.has(item.ref)||!text(item.collectionRef)
      ||!['main','auxiliary','unknown'].includes(String(item.role))) {
      throw new TypeError('Search item identity or ownership is invalid');
    }
    members.add(item.ref);fact(item.text,'string',ids);
  }
  return value as BrowserSearchObservation;
}
export function readBrowserSearchState(value: unknown): BrowserSearchState {
  const row=expectRecord(value,'browser search state');
  const observation=readBrowserSearchObservation(row.observation);
  const checked=row.checkedObservationId===null?null:row.checkedObservationId;
  if(checked!==null&&!text(checked))throw new TypeError('Invalid search checked observation');
  const submissionBaseline=row.submissionBaseline===null?null:readBrowserSearchSubmissionBaseline(row.submissionBaseline);
  return {observation,checkedObservationId:checked,submissionBaseline};
}
export function readBrowserSearchRequest(value: unknown): BrowserSearchRequest {
  const row=expectRecord(value,'browser search request');
  const goal=expectRecord(row.goal,'search goal'),bindings=expectRecord(row.bindings,'search bindings');
  if (!text(row.requestId) || row.satisfactionThreshold!==100 || goal.kind!=='BrowserSearch'
    || ![goal.query,goal.collectionRef,goal.containsText].every(text)
    || !Number.isSafeInteger(goal.minimumMatches)||Number(goal.minimumMatches)<1
    || !['matched_items','visible_batch'].includes(String(goal.coverage))
    || ['documentRef','scopeRef','inputRef','submitRef','resultScopeRef','collectionRef'].some(k=>!text(bindings[k]))
    || goal.collectionRef!==bindings.collectionRef
    || (row.maxResultReads!==undefined&&(!Number.isSafeInteger(row.maxResultReads)||Number(row.maxResultReads)<1))) throw new TypeError('Invalid typed search request');
  return value as BrowserSearchRequest;
}
export function assertSearchBindings(observation: BrowserSearchObservation, bindings: BrowserSearchBindings): void {
  if (observation.documentRef!==bindings.documentRef||observation.scopeRef!==bindings.scopeRef
    ||observation.input.ref!==bindings.inputRef||observation.submitRef!==bindings.submitRef
    ||observation.collection.ref!==bindings.collectionRef||observation.collection.scopeRef!==bindings.resultScopeRef) {
    throw new TypeError('Search observation changed explicit logical bindings');
  }
}
export function knownEqual(fact: ActionObservation<string>, value: string): boolean { return fact.status==='observed'&&fact.value===value; }
function submittedFact(goal: BrowserSearchGoal, observation: BrowserSearchObservation,
  baseline: BrowserSearchSubmissionBaseline|null): 'satisfied'|'unsatisfied'|'unknown' {
  if(!knownEqual(observation.submittedQuery,goal.query)) return observation.submittedQuery.status==='unknown'?'unknown':'unsatisfied';
  if(observation.submittedRequestRef.status==='unknown'||baseline===null||baseline.observedSubmission===null)return 'unknown';
  if(baseline.observedSubmission&&baseline.submittedRequestRef===null)return 'unknown';
  if(baseline.submittedRequestRef===observation.submittedRequestRef.value)return 'unknown';
  return 'satisfied';
}
export function searchPhaseFact(goal: BrowserSearchGoal, observation: BrowserSearchObservation, checked: string|null,
  baseline: BrowserSearchSubmissionBaseline|null=null): 'satisfied'|'unsatisfied'|'unknown' {
  if (observation.collection.ref!==goal.collectionRef) return 'unknown';
  if (goal.phase==='input') return observation.input.value.status==='unknown'?'unknown':knownEqual(observation.input.value,goal.query)?'satisfied':'unsatisfied';
  const submitted = submittedFact(goal,observation,baseline);
  if (goal.phase==='submitted') return submitted;
  if (observation.access!=='available'||observation.request!=='settled'||!['current','empty'].includes(observation.display)
    || observation.resultsFor.status==='unknown'||observation.resultsRequestRef.status==='unknown'
    || observation.collection.requestRef.status==='unknown'||checked!==observation.observationId
    ||observation.submittedRequestRef.status==='unknown'||observation.collection.batch.status==='unknown') return 'unknown';
  if(submitted==='unknown')return 'unknown';
  if(submitted==='unsatisfied'||observation.resultsRequestRef.value!==observation.submittedRequestRef.value
    ||observation.collection.requestRef.value!==observation.submittedRequestRef.value
    ||!knownEqual(observation.resultsFor,goal.query)) return 'unsatisfied';
  if(baseline?.batchRef!==null&&baseline?.batchRef!==undefined
    &&observation.collection.batch.value===baseline.batchRef) return 'unsatisfied';
  return searchContentFact(goal,observation);
}
/** Observation completeness follows the caller's declared coverage obligation. */
export function searchContentFact(goal:BrowserSearchGoal,observation:BrowserSearchObservation):'satisfied'|'unsatisfied'|'unknown'{
  const relevant=observation.collection.items.filter(item=>item.collectionRef===goal.collectionRef);
  const main=relevant.filter(item=>item.role==='main');
  const unknownRole=relevant.some(item=>item.role==='unknown');
  if (goal.coverage==='visible_batch'&&(unknownRole||main.some(item=>item.text.status!=='observed'))) return 'unknown';
  const matches=main.filter(item=>item.text.status==='observed'&&item.text.value.includes(goal.containsText));
  return matches.length>=goal.minimumMatches?'satisfied':
    unknownRole||main.some(item=>item.text.status==='unknown')?'unknown':'unsatisfied';
}
