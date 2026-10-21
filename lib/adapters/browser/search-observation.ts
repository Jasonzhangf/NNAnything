import {expectRecord} from '../../core/schema.js';
import type {ActionObservation} from './single-action-contract.js';
import type {BrowserSearchBindings, BrowserSearchGoal, BrowserSearchObservation, BrowserSearchRequest} from './search-contract.js';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function fact(value: unknown, kind: 'string' | 'boolean', ids: ReadonlySet<string>): void {
  const row = expectRecord(value, 'search observed fact');
  if (row.status === 'unknown' && text(row.reason)) return;
  if (row.status !== 'observed' || typeof row.value !== kind || !Array.isArray(row.evidenceRefs)
    || row.evidenceRefs.length === 0 || row.evidenceRefs.some(id => typeof id !== 'string' || !ids.has(id))) {
    throw new TypeError('Search fact requires typed value and local evidence');
  }
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
  if (!['loading','settled','error','unknown'].includes(String(row.request))
    || !['none','old','current','empty','partial','unknown'].includes(String(row.display))
    || !['available','login_required','challenge','unknown'].includes(String(row.access))) throw new TypeError('Invalid search states');
  const collection = expectRecord(row.collection,'search collection');
  if (![collection.ref,collection.scopeRef].every(text) || !Array.isArray(collection.items)) throw new TypeError('Invalid search collection');
  fact(collection.batch,'string',ids);
  const members = new Set<string>();
  for (const raw of collection.items) {
    const item=expectRecord(raw,'search item');
    if (!text(item.ref)||members.has(item.ref)) throw new TypeError('Search item refs must be unique');
    members.add(item.ref);fact(item.text,'string',ids);
  }
  return value as BrowserSearchObservation;
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
export function searchPhaseFact(goal: BrowserSearchGoal, observation: BrowserSearchObservation, checked: string|null): 'satisfied'|'unsatisfied'|'unknown' {
  if (observation.collection.ref!==goal.collectionRef) return 'unknown';
  if (goal.phase==='input') return observation.input.value.status==='unknown'?'unknown':knownEqual(observation.input.value,goal.query)?'satisfied':'unsatisfied';
  const submitted = knownEqual(observation.submittedQuery,goal.query);
  if (goal.phase==='submitted') return submitted?'satisfied':observation.submittedQuery.status==='unknown'?'unknown':'unsatisfied';
  if (observation.access!=='available'||observation.request!=='settled'||!['current','empty'].includes(observation.display)
    || observation.resultsFor.status==='unknown'||!submitted||checked!==observation.observationId
    ||observation.collection.batch.status==='unknown') return 'unknown';
  if (!knownEqual(observation.resultsFor,goal.query)) return 'unsatisfied';
  return searchContentFact(goal,observation);
}
/** Observation completeness follows the caller's declared coverage obligation. */
export function searchContentFact(goal:BrowserSearchGoal,observation:BrowserSearchObservation):'satisfied'|'unsatisfied'|'unknown'{
  const items=observation.collection.items;
  if (goal.coverage==='visible_batch'&&items.some(item=>item.text.status!=='observed')) return 'unknown';
  const matches=items.filter(item=>item.text.status==='observed'&&item.text.value.includes(goal.containsText));
  return matches.length>=goal.minimumMatches?'satisfied':items.some(item=>item.text.status==='unknown')?'unknown':'unsatisfied';
}
