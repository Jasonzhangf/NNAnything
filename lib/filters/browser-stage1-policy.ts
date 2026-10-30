import { expectRecord } from "../core/schema.js";
import type { ActionObservation } from "../adapters/browser/single-action-contract.js";
import type { BrowserInputObservation } from "../adapters/browser/input-contract.js";
import type {
  BrowserSearchGoal,
  BrowserSearchState,
} from "../adapters/browser/search-contract.js";
import { searchContentFact } from "../adapters/browser/search-observation.js";

export const BROWSER_INPUT_POLICY_HEADS = ["INPUT", "NOOP", "DEFER"] as const;
export type BrowserInputPolicyHead = (typeof BROWSER_INPUT_POLICY_HEADS)[number];
export const BROWSER_INPUT_POLICY_WIRES = [
  "bias",
  "textType.known",
  "textType.value",
  "enabled.known",
  "enabled.value",
  "editable.known",
  "editable.value",
  "readOnly.known",
  "readOnly.value",
  "valueEqual.known",
  "valueEqual.value",
  "executableHit.known",
  "executableHit.value",
] as const;

export const BROWSER_QUERY_RELATION_HEADS = [
  "input_only_unsubmitted",
  "submitted_pending_or_stale",
  "results_associated_active",
  "insufficient_or_conflict",
] as const;
export type BrowserQueryRelationHead = (typeof BROWSER_QUERY_RELATION_HEADS)[number];
export const BROWSER_QUERY_RELATION_WIRES = [
  "bias",
  "inputQueryEqual.known",
  "inputQueryEqual.value",
  "newSubmissionInstance.known",
  "newSubmissionInstance.value",
  "responseMatchesSubmission.known",
  "responseMatchesSubmission.value",
  "requestState.known",
  "requestSettled.value",
  "requestLoading.value",
  "accessAvailable.known",
  "accessAvailable.value",
  "displayCurrentOrEmpty.value",
  "associatedAndSettledInteraction",
] as const;

export const BROWSER_STEP_POLICY_HEADS = [
  "input",
  "submit",
  "read_or_reobserve",
  "expand_range",
  "NOOP",
  "DEFER",
] as const;
export type BrowserStepPolicyHead = (typeof BROWSER_STEP_POLICY_HEADS)[number];
export const BROWSER_STEP_POLICY_WIRES = [
  "bias",
  "phase.input",
  "phase.submitted",
  "phase.results",
  "predInputPolicy.INPUT",
  "predInputPolicy.NOOP",
  "predInputPolicy.DEFER",
  "predQueryRelation.input_only_unsubmitted",
  "predQueryRelation.submitted_pending_or_stale",
  "predQueryRelation.results_associated_active",
  "predQueryRelation.insufficient_or_conflict",
  "batchCheckedCurrent",
  "contentConditionSatisfied.known",
  "contentConditionSatisfied.value",
  "canExpandRange.known",
  "canExpandRange.value",
  "collectionTerminalConfirmed",
  "unreadCurrentBatch",
] as const;

export interface BrowserInputPolicyProfile {
  readonly contract: "browser.input-text-policy.v1";
  readonly heads: typeof BROWSER_INPUT_POLICY_HEADS;
  readonly wires: typeof BROWSER_INPUT_POLICY_WIRES;
  readonly weights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface BrowserQueryRelationProfile {
  readonly contract: "browser.search-query-relation.v1";
  readonly heads: typeof BROWSER_QUERY_RELATION_HEADS;
  readonly wires: typeof BROWSER_QUERY_RELATION_WIRES;
  readonly weights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface BrowserStepPolicyProfile {
  readonly contract: "browser.search-step-policy.v1";
  readonly heads: typeof BROWSER_STEP_POLICY_HEADS;
  readonly wires: typeof BROWSER_STEP_POLICY_WIRES;
  readonly weights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface BrowserInputPolicyPrediction {
  readonly head: BrowserInputPolicyHead;
  readonly features: readonly number[];
  readonly scores: readonly number[];
}

export interface BrowserQueryRelationPrediction {
  readonly head: BrowserQueryRelationHead;
  readonly features: readonly number[];
  readonly scores: readonly number[];
}

export interface BrowserStepPolicyPrediction {
  readonly head: BrowserStepPolicyHead;
  readonly features: readonly number[];
  readonly scores: readonly number[];
}

const sameNames = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual)
  && actual.length === expected.length
  && actual.every((name, index) => name === expected[index]);

function validateProfile(
  value: unknown,
  contract: string,
  heads: readonly string[],
  wires: readonly string[],
  label: string,
): void {
  const row = expectRecord(value, `${label} profile`);
  if (row.contract !== contract) throw new TypeError(`Unknown ${label} profile contract`);
  if (!sameNames(row.heads, heads)) throw new TypeError(`${label} profile heads must match the fixed contract`);
  if (!sameNames(row.wires, wires)) throw new TypeError(`${label} profile wires must match the fixed contract`);
  if (row.calibration !== "uncalibrated") throw new TypeError(`${label} profile must stay uncalibrated`);
  if (row.adoption !== "not_applied") throw new TypeError(`${label} profile must not be adopted implicitly`);
  if (!Array.isArray(row.weights) || row.weights.length !== heads.length) {
    throw new TypeError(`${label} profile weights must be ${heads.length} x ${wires.length}`);
  }
  for (const weightRow of row.weights) {
    if (!Array.isArray(weightRow) || weightRow.length !== wires.length
      || weightRow.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new TypeError(`${label} profile weight row must contain ${wires.length} finite numbers`);
    }
  }
}

export function readBrowserInputPolicyProfile(value: unknown): BrowserInputPolicyProfile {
  validateProfile(value, "browser.input-text-policy.v1", BROWSER_INPUT_POLICY_HEADS,
    BROWSER_INPUT_POLICY_WIRES, "browser input policy");
  return value as BrowserInputPolicyProfile;
}

export function readBrowserQueryRelationProfile(value: unknown): BrowserQueryRelationProfile {
  validateProfile(value, "browser.search-query-relation.v1", BROWSER_QUERY_RELATION_HEADS,
    BROWSER_QUERY_RELATION_WIRES, "browser query relation");
  return value as BrowserQueryRelationProfile;
}

export function readBrowserStepPolicyProfile(value: unknown): BrowserStepPolicyProfile {
  validateProfile(value, "browser.search-step-policy.v1", BROWSER_STEP_POLICY_HEADS,
    BROWSER_STEP_POLICY_WIRES, "browser step policy");
  return value as BrowserStepPolicyProfile;
}

// Factories assemble an explicit, caller-supplied matrix. They never hold
// candidate weights themselves.
export function createBrowserInputPolicyProfile(weights: readonly (readonly number[])[]): BrowserInputPolicyProfile {
  const profile: BrowserInputPolicyProfile = {
    contract: "browser.input-text-policy.v1",
    heads: BROWSER_INPUT_POLICY_HEADS,
    wires: BROWSER_INPUT_POLICY_WIRES,
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  return readBrowserInputPolicyProfile(profile);
}

export function createBrowserQueryRelationProfile(weights: readonly (readonly number[])[]): BrowserQueryRelationProfile {
  const profile: BrowserQueryRelationProfile = {
    contract: "browser.search-query-relation.v1",
    heads: BROWSER_QUERY_RELATION_HEADS,
    wires: BROWSER_QUERY_RELATION_WIRES,
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  return readBrowserQueryRelationProfile(profile);
}

export function createBrowserStepPolicyProfile(weights: readonly (readonly number[])[]): BrowserStepPolicyProfile {
  const profile: BrowserStepPolicyProfile = {
    contract: "browser.search-step-policy.v1",
    heads: BROWSER_STEP_POLICY_HEADS,
    wires: BROWSER_STEP_POLICY_WIRES,
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  return readBrowserStepPolicyProfile(profile);
}

const observed = <T,>(fact: ActionObservation<T> | undefined): fact is Extract<ActionObservation<T>, { status: "observed" }> =>
  fact !== undefined && fact.status === "observed";

function forward<THead extends string>(
  heads: readonly THead[],
  profileWeights: readonly (readonly number[])[],
  wires: readonly number[],
): { readonly head: THead; readonly scores: readonly number[] } {
  const scores = profileWeights.map(weightRow =>
    weightRow.reduce((total, weight, index) => total + weight * (wires[index] ?? 0), 0));
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    // Ties fall through to the later head; each head list ends with its
    // conservative/abstaining option.
    if (scores[index]! >= scores[best]!) best = index;
  }
  return { head: heads[best]!, scores };
}

function checkedProfileWeights(weights: readonly (readonly number[])[], rows: number, columns: number,
  label: string): readonly (readonly number[])[] {
  if (weights.length !== rows || weights.some(row => row.length !== columns)) {
    throw new TypeError(`${label} profile weights must be ${rows} x ${columns}`);
  }
  return weights;
}

export function extractBrowserInputPolicyWires(
  observation: BrowserInputObservation,
  targetText: string,
  sensitive: boolean,
): readonly number[] {
  const target = observation.target;
  const textTypeKnown = observed(target.host) && observed(target.type);
  const textTypeValue = textTypeKnown && target.host.value === "input"
    && target.type.value === "text" && !sensitive;
  const enabledKnown = observed(target.nativeDisabled) && observed(target.ariaDisabled);
  const enabledValue = enabledKnown && target.nativeDisabled.value === false
    && target.ariaDisabled.value !== true;
  const editableKnown = observed(target.editable);
  const editableValue = editableKnown && target.editable.value === true;
  const readOnlyKnown = observed(target.readonlyState);
  const readOnlyValue = readOnlyKnown && target.readonlyState.value === "readonly";
  const valueKnown = observed(target.value) && !sensitive;
  const valueEqual = valueKnown && target.value.value === targetText;
  const hitKnown = observed(target.executableHit);
  const hitValue = hitKnown && target.executableHit.value === true;
  return [
    1,
    textTypeKnown ? 1 : 0,
    textTypeValue ? 1 : 0,
    enabledKnown ? 1 : 0,
    enabledValue ? 1 : 0,
    editableKnown ? 1 : 0,
    editableValue ? 1 : 0,
    readOnlyKnown ? 1 : 0,
    readOnlyValue ? 1 : 0,
    valueKnown ? 1 : 0,
    valueEqual ? 1 : 0,
    hitKnown ? 1 : 0,
    hitValue ? 1 : 0,
  ];
}

export function predictBrowserInputPolicy(
  observation: BrowserInputObservation,
  targetText: string,
  sensitive: boolean,
  profile: BrowserInputPolicyProfile,
): BrowserInputPolicyPrediction {
  const weights = checkedProfileWeights(profile.weights, BROWSER_INPUT_POLICY_HEADS.length,
    BROWSER_INPUT_POLICY_WIRES.length, "browser input policy");
  const features = extractBrowserInputPolicyWires(observation, targetText, sensitive);
  const { head, scores } = forward(BROWSER_INPUT_POLICY_HEADS, weights, features);
  return { head, features, scores };
}

export function extractBrowserQueryRelationWires(
  state: BrowserSearchState,
  goal: BrowserSearchGoal,
): readonly number[] {
  const o = state.observation;
  const baseline = state.submissionBaseline;
  const eq = (fact: ActionObservation<string>, value: string): boolean =>
    observed(fact) && fact.value === value;
  const submittedRefValue = observed(o.submittedRequestRef) ? o.submittedRequestRef.value : null;
  const resultsRefValue = observed(o.resultsRequestRef) ? o.resultsRequestRef.value : null;
  const collectionRequestValue = observed(o.collection.requestRef) ? o.collection.requestRef.value : null;
  const collectionBatchValue = observed(o.collection.batch) ? o.collection.batch.value : null;
  const w1 = observed(o.input.value) ? 1 : 0;
  const w2 = w1 === 1 && eq(o.input.value, goal.query) ? 1 : 0;
  const w3 = baseline !== null && observed(o.submittedQuery) && observed(o.submittedRequestRef) ? 1 : 0;
  const w4 = w3 === 1 && eq(o.submittedQuery, goal.query) && submittedRefValue !== null
    && baseline !== null && submittedRefValue !== baseline.submittedRequestRef ? 1 : 0;
  const w5 = w3 === 1 && observed(o.resultsFor) && observed(o.resultsRequestRef)
    && observed(o.collection.requestRef) && observed(o.collection.batch) ? 1 : 0;
  const w6 = w5 === 1 && w4 === 1 && eq(o.resultsFor, goal.query)
    && resultsRefValue !== null && collectionRequestValue !== null
    && resultsRefValue === submittedRefValue
    && collectionRequestValue === submittedRefValue
    && collectionBatchValue !== null && baseline !== null && collectionBatchValue !== baseline.batchRef ? 1 : 0;
  const requestStateValue = observed(o.rangeExpansion.requestState) ? o.rangeExpansion.requestState.value : null;
  const w7 = requestStateValue === null ? 0 : 1;
  const w8 = requestStateValue === "settled" ? 1 : 0;
  const w9 = requestStateValue === "loading" ? 1 : 0;
  const w10 = o.access !== "unknown" ? 1 : 0;
  const w11 = w10 === 1 && o.access === "available" ? 1 : 0;
  const w12 = w5 === 1 && o.display !== "unknown"
    && (o.display === "current" || o.display === "empty") ? 1 : 0;
  const w13 = w4 === 1 && w6 === 1 && w8 === 1 && w11 === 1 && w12 === 1 ? 1 : 0;
  return [1, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13];
}

export function predictBrowserQueryRelation(
  state: BrowserSearchState,
  goal: BrowserSearchGoal,
  profile: BrowserQueryRelationProfile,
): BrowserQueryRelationPrediction {
  const weights = checkedProfileWeights(profile.weights, BROWSER_QUERY_RELATION_HEADS.length,
    BROWSER_QUERY_RELATION_WIRES.length, "browser query relation");
  const features = extractBrowserQueryRelationWires(state, goal);
  const { head, scores } = forward(BROWSER_QUERY_RELATION_HEADS, weights, features);
  return { head, features, scores };
}

export function extractBrowserStepPolicyWires(
  state: BrowserSearchState,
  goal: BrowserSearchGoal,
  inputHead: BrowserInputPolicyHead | null,
  relationHead: BrowserQueryRelationHead | null,
): readonly number[] {
  const o = state.observation;
  const phaseInput = goal.phase === "input";
  const phaseSubmitted = goal.phase === "submitted";
  const phaseResults = goal.phase === "results";
  const w1 = phaseInput ? 1 : 0;
  const w2 = phaseSubmitted ? 1 : 0;
  const w3 = phaseResults ? 1 : 0;
  const w4 = w1 === 1 && inputHead === "INPUT" ? 1 : 0;
  const w5 = w1 === 1 && inputHead === "NOOP" ? 1 : 0;
  const w6 = w1 === 1 && inputHead === "DEFER" ? 1 : 0;
  const relationScope = w2 === 1 || w3 === 1 ? 1 : 0;
  const w7 = relationScope === 1 && relationHead === "input_only_unsubmitted" ? 1 : 0;
  const w8 = relationScope === 1 && relationHead === "submitted_pending_or_stale" ? 1 : 0;
  const w9 = relationScope === 1 && relationHead === "results_associated_active" ? 1 : 0;
  const w10 = relationScope === 1 && relationHead === "insufficient_or_conflict" ? 1 : 0;
  const checkedCurrent = phaseResults && o.observationId === state.checkedObservationId;
  const contentFact = searchContentFact(goal, o);
  const contentKnown = contentFact !== "unknown";
  const w11 = phaseResults && w9 === 1 && checkedCurrent ? 1 : 0;
  const w12 = w11 === 1 && contentKnown ? 1 : 0;
  const w13 = w12 === 1 && contentFact === "satisfied" ? 1 : 0;
  const geometry = o.rangeExpansion.atGeometryBoundary;
  const hasMore = o.rangeExpansion.hasMore;
  const terminal = o.rangeExpansion.collectionTerminal === true;
  const canExpandKnown = w12 === 1 && (
    (observed(geometry) && geometry.value === false)
    || (observed(hasMore) && hasMore.value === true)
    || (observed(geometry) && geometry.value === true && observed(hasMore) && hasMore.value === false)
  );
  const w14 = canExpandKnown ? 1 : 0;
  const w15 = w14 === 1 && w13 === 0 && terminal === false && (
    (observed(geometry) && geometry.value === false)
    || (observed(hasMore) && hasMore.value === true)
  ) ? 1 : 0;
  const w16 = w12 === 1 && terminal ? 1 : 0;
  const w17 = phaseResults && w9 === 1 && !checkedCurrent ? 1 : 0;
  return [1, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15, w16, w17];
}

export function predictBrowserSearchStepPolicy(
  state: BrowserSearchState,
  goal: BrowserSearchGoal,
  inputHead: BrowserInputPolicyHead | null,
  relationHead: BrowserQueryRelationHead | null,
  profile: BrowserStepPolicyProfile,
): BrowserStepPolicyPrediction {
  const weights = checkedProfileWeights(profile.weights, BROWSER_STEP_POLICY_HEADS.length,
    BROWSER_STEP_POLICY_WIRES.length, "browser step policy");
  const features = extractBrowserStepPolicyWires(state, goal, inputHead, relationHead);
  const { head, scores } = forward(BROWSER_STEP_POLICY_HEADS, weights, features);
  return { head, features, scores };
}
