import {
  STRATEGY_HEADS,
  STRATEGY_WIRES,
  type BrowserExpansionStrategy,
  type BrowserStrategyPrediction,
  type BrowserStrategyProfile,
  type BrowserStrategyRequest,
  type StrategyCandidatePrediction,
  type StrategyHistory,
  type StrategyInferenceResources,
} from "../adapters/browser/strategy-contract.js";
import {
  predictFeedback,
  readFeedbackInput,
  validateFeedbackProfile,
} from "./browser-feedback.js";
import {
  predictBrowserSingleAction,
  validateBrowserSingleActionProfile,
} from "./browser-single-action-policy.js";
import { expectRecord } from "../core/schema.js";
import { readSingleActionRequest } from "../adapters/browser/single-action-observation.js";

const PROFILE_KEYS = ["contract", "heads", "wires", "weights", "calibration", "adoption"] as const;
const REGISTRY_KEYS = [
  "strategyRef",
  "skillId",
  "targetRef",
  "goalRegionRef",
  "equivalenceSetRef",
  "documentRef",
  "scopeRef",
  "operation",
  "evidenceRefs",
] as const;
const SELECTION_KEYS = [
  "eligibleSkillIds",
  "lockedSkillId",
  "exhaustedSkillIds",
  "remainingAtomicAttempts",
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function uniqueStrings(value: unknown, label: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const strings = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} contains duplicate values`);
  if (!allowEmpty && strings.length === 0) throw new TypeError(`${label} must not be empty`);
  return Object.freeze(strings);
}

function sameSequence(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])) {
    throw new TypeError(`${label} must be exactly ${expected.join(", ")}`);
  }
}

function finiteMatrix(value: unknown): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== STRATEGY_HEADS.length) {
    throw new TypeError(`browser strategy weights must have ${STRATEGY_HEADS.length} rows`);
  }
  return Object.freeze(value.map((raw, rowIndex) => {
    if (!Array.isArray(raw) || raw.length !== STRATEGY_WIRES.length
      || raw.some(weight => typeof weight !== "number" || !Number.isFinite(weight))) {
      throw new TypeError(`browser strategy weights row ${rowIndex} must contain ${STRATEGY_WIRES.length} finite values`);
    }
    return Object.freeze([...raw] as number[]);
  }));
}

export function validateBrowserStrategyProfile(value: unknown): BrowserStrategyProfile {
  const profile = expectRecord(value, "browser strategy profile");
  exactKeys(profile, PROFILE_KEYS, "browser strategy profile");
  if (profile.contract !== "browser.strategy-policy.v1") {
    throw new TypeError("Browser strategy profile contract is invalid");
  }
  sameSequence(profile.heads, STRATEGY_HEADS, "browser strategy heads");
  sameSequence(profile.wires, STRATEGY_WIRES, "browser strategy wires");
  if (profile.calibration !== "uncalibrated") throw new TypeError("Browser strategy calibration must be uncalibrated");
  if (profile.adoption !== "not_applied") throw new TypeError("Browser strategy adoption must be not_applied");
  return Object.freeze({
    contract: "browser.strategy-policy.v1",
    heads: Object.freeze([...STRATEGY_HEADS]),
    wires: Object.freeze([...STRATEGY_WIRES]),
    weights: finiteMatrix(profile.weights),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function createZeroBrowserStrategyProfile(): BrowserStrategyProfile {
  return validateBrowserStrategyProfile({
    contract: "browser.strategy-policy.v1",
    heads: [...STRATEGY_HEADS],
    wires: [...STRATEGY_WIRES],
    weights: STRATEGY_HEADS.map(() => STRATEGY_WIRES.map(() => 0)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function readHistory(value: unknown, index: number): StrategyHistory {
  const row = expectRecord(value, `browser strategy history ${index}`);
  exactKeys(row, ["strategyRef", "skillId", "targetRef", "equivalenceSetRef", "input"],
    `browser strategy history ${index}`);
  const input = readFeedbackInput(row.input);
  if (input.result.invocation !== null && input.result.invocation.targetRef !== row.targetRef) {
    throw new TypeError("Strategy history invocation target does not match the declared candidate target");
  }
  return Object.freeze({
    strategyRef: nonEmptyString(row.strategyRef, `browser strategy history ${index}.strategyRef`),
    skillId: nonEmptyString(row.skillId, `browser strategy history ${index}.skillId`),
    targetRef: nonEmptyString(row.targetRef, `browser strategy history ${index}.targetRef`),
    equivalenceSetRef: nonEmptyString(row.equivalenceSetRef, `browser strategy history ${index}.equivalenceSetRef`),
    input,
  });
}

export function readBrowserStrategyRequest(value: unknown): BrowserStrategyRequest {
  const input = expectRecord(value, "browser strategy request");
  exactKeys(input, ["request", "history"], "browser strategy request");
  if (!Array.isArray(input.history)) throw new TypeError("browser strategy request.history must be an array");
  return Object.freeze({
    request: readSingleActionRequest(input.request),
    history: Object.freeze(input.history.map(readHistory)),
  });
}

function readRegistry(value: unknown): readonly BrowserExpansionStrategy[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("browser strategy registry must be a nonempty array");
  }
  const strategies = value.map((raw, index) => {
    const row = expectRecord(raw, `browser strategy registry ${index}`);
    exactKeys(row, REGISTRY_KEYS, `browser strategy registry ${index}`);
    if (row.operation !== "CLICK") throw new TypeError(`browser strategy registry ${index}.operation must be CLICK`);
    return Object.freeze({
      strategyRef: nonEmptyString(row.strategyRef, `browser strategy registry ${index}.strategyRef`),
      skillId: nonEmptyString(row.skillId, `browser strategy registry ${index}.skillId`),
      targetRef: nonEmptyString(row.targetRef, `browser strategy registry ${index}.targetRef`),
      goalRegionRef: nonEmptyString(row.goalRegionRef, `browser strategy registry ${index}.goalRegionRef`),
      equivalenceSetRef: nonEmptyString(row.equivalenceSetRef, `browser strategy registry ${index}.equivalenceSetRef`),
      documentRef: nonEmptyString(row.documentRef, `browser strategy registry ${index}.documentRef`),
      scopeRef: nonEmptyString(row.scopeRef, `browser strategy registry ${index}.scopeRef`),
      operation: "CLICK" as const,
      evidenceRefs: uniqueStrings(row.evidenceRefs, `browser strategy registry ${index}.evidenceRefs`, false),
    });
  });
  if (new Set(strategies.map(strategy => strategy.strategyRef)).size !== strategies.length) {
    throw new TypeError("browser strategy registry contains duplicate strategyRef values");
  }
  if (new Set(strategies.map(strategy => strategy.skillId)).size !== strategies.length) {
    throw new TypeError("browser strategy registry contains duplicate skillId values");
  }
  return Object.freeze(strategies);
}

interface ReadSelection {
  readonly eligibleSkillIds: readonly string[];
  readonly lockedSkillId: string | null;
  readonly exhaustedSkillIds: readonly string[];
  readonly remainingAtomicAttempts: number;
}

function readSelection(value: unknown): ReadSelection {
  const selection = expectRecord(value, "browser strategy selection");
  exactKeys(selection, SELECTION_KEYS, "browser strategy selection");
  const eligibleSkillIds = uniqueStrings(selection.eligibleSkillIds, "browser strategy selection.eligibleSkillIds", true);
  const exhaustedSkillIds = uniqueStrings(selection.exhaustedSkillIds, "browser strategy selection.exhaustedSkillIds", true);
  const lockedSkillId = selection.lockedSkillId === null
    ? null
    : nonEmptyString(selection.lockedSkillId, "browser strategy selection.lockedSkillId");
  if (typeof selection.remainingAtomicAttempts !== "number"
    || !Number.isSafeInteger(selection.remainingAtomicAttempts) || selection.remainingAtomicAttempts < 0) {
    throw new TypeError("browser strategy selection.remainingAtomicAttempts must be a nonnegative integer");
  }
  return Object.freeze({
    eligibleSkillIds,
    lockedSkillId,
    exhaustedSkillIds,
    remainingAtomicAttempts: selection.remainingAtomicAttempts,
  });
}

function defer(reason: string, candidates: readonly StrategyCandidatePrediction[] = []): BrowserStrategyPrediction {
  return Object.freeze({ kind: "DEFER", skillId: null, strategyRef: null, targetRef: null, reason,
    candidates: Object.freeze([...candidates]) });
}

function selectionConflict(selection: ReadSelection, registry: readonly BrowserExpansionStrategy[]): string | null {
  const known = new Set(registry.map(strategy => strategy.skillId));
  const eligible = new Set(selection.eligibleSkillIds);
  if (selection.exhaustedSkillIds.some(skillId => eligible.has(skillId))) {
    return "invalid selection: an exhausted strategy cannot remain eligible";
  }
  if ([...selection.eligibleSkillIds, ...selection.exhaustedSkillIds].some(skillId => !known.has(skillId))) {
    return "invalid selection: strategy skill is absent from the explicit registry";
  }
  if (selection.lockedSkillId !== null
    && (selection.eligibleSkillIds.length !== 1 || selection.eligibleSkillIds[0] !== selection.lockedSkillId)) {
    return "invalid selection: a locked strategy must be the unique eligible strategy";
  }
  return null;
}

function historyMatches(
  history: StrategyHistory,
  strategy: BrowserExpansionStrategy,
  request: BrowserStrategyRequest["request"],
): boolean {
  return history.strategyRef === strategy.strategyRef
    && history.skillId === strategy.skillId
    && history.targetRef === strategy.targetRef
    && history.equivalenceSetRef === strategy.equivalenceSetRef
    && history.input.request.state.documentRef === request.state.documentRef
    && history.input.request.state.scopeRef === request.state.scopeRef
    && history.input.request.goal.kind === request.goal.kind
    && history.input.request.goal.regionRef === strategy.goalRegionRef
    && request.goal.regionRef === strategy.goalRegionRef;
}

function latestHistory(
  input: BrowserStrategyRequest,
  strategy: BrowserExpansionStrategy,
): StrategyHistory | null {
  const matches = input.history.filter(history => historyMatches(history, strategy, input.request));
  if (matches.length === 0) return null;
  const revision = (history: StrategyHistory) => history.input.result.newState?.documentRef === input.request.state.documentRef
    ? history.input.result.newState.revision : history.input.request.state.revision;
  if (matches.some(history => history.input.request.state.revision > input.request.state.revision || revision(history) > input.request.state.revision)) {
    throw new TypeError("Strategy history is newer than the current observation; future feedback is not an input");
  }
  const maxRevision = Math.max(...matches.map(revision));
  const latest = matches.filter(history => revision(history) === maxRevision);
  if (latest.length !== 1) {
    throw new Error(`Ambiguous strategy history for ${strategy.strategyRef} at revision ${maxRevision}`);
  }
  return latest[0]!;
}

function feedbackWires(
  history: StrategyHistory | null,
  resources: StrategyInferenceResources,
): readonly [number, number, number, number, number, number] {
  if (history === null) return [0, 0, 0, 0, 0, 0];
  const prediction = predictFeedback(history.input, resources.feedbackProfile);
  if (!prediction.scores.every(Number.isFinite)) throw new TypeError("Non-finite strategy feedback scores");
  const result = history.input.result;
  const facts = prediction.features;
  const executed = result.invocation?.targetRef === history.targetRef && result.receipt?.dispatched === true && result.dispatchState === "dispatched";
  const observedGoal = facts[6] === 1 && facts[7] === 1 && facts[9] === 1;
  const goalTrue = facts[8] === 1 && facts[10] === 1;
  const goalConsistent = goalTrue ? result.achieved && result.satisfaction === 100 : !result.achieved && result.satisfaction === 0;
  const known = executed && observedGoal && goalConsistent
    || (result.receipt?.ok === false && result.receipt.dispatched === false && result.dispatchState === "not_dispatched");
  const succeeded = executed && observedGoal && goalConsistent && goalTrue;
  if (prediction.status === "goal_achieved") return [1, 0, 0, 0, Number(known), Number(succeeded)];
  if (prediction.status === "unknown") return [1, 0, 0, 1, Number(known), Number(succeeded)];
  if (prediction.head === "completed_without_goal") return [1, 1, 0, 0, Number(known), Number(succeeded)];
  if (prediction.head === "execution_rejected") return [1, 0, 1, 0, Number(known), Number(succeeded)];
  return [1, 0, 0, 1, Number(known), Number(succeeded)];
}

function feature(
  strategy: BrowserExpansionStrategy,
  element: BrowserStrategyRequest["request"]["state"]["elements"][number],
  relationMargin: number,
  history: StrategyHistory | null,
  resources: StrategyInferenceResources,
): readonly number[] {
  const nativeButton = element.tag === "button";
  const explicitRoleButton = element.tag !== "button" && element.role === "button";
  const feedback = feedbackWires(history, resources);
  const values = {
    "bias": 1,
    "nativeButton": Number(nativeButton),
    "explicitRoleButton": Number(explicitRoleButton),
    "relation.providerMargin": relationMargin,
    "feedback.present": feedback[0],
    "feedback.completedWithoutGoal": feedback[1],
    "feedback.executionRejected": feedback[2],
    "feedback.indeterminate": feedback[3],
    "verifiedSuccess.known": feedback[4],
    "verifiedSuccess.value": feedback[5],
  } satisfies Record<typeof STRATEGY_WIRES[number], number>;
  return Object.freeze(STRATEGY_WIRES.map(wire => values[wire]));
}

function dot(weights: readonly number[], features: readonly number[]): number {
  return weights.reduce((sum, weight, index) => sum + weight * features[index]!, 0);
}

interface Projected {
  readonly candidates: readonly StrategyCandidatePrediction[];
  readonly issue: string | null;
}

function projectForRequest(
  input: BrowserStrategyRequest,
  resources: StrategyInferenceResources,
  profile: BrowserStrategyProfile,
): Projected {
  const registry = readRegistry(resources.registry);
  const selection = readSelection(resources.selection);
  const conflict = selectionConflict(selection, registry);
  if (conflict !== null) return { candidates: [], issue: conflict };
  if (selection.eligibleSkillIds.length === 0) {
    return { candidates: [], issue: "no eligible strategy remains" };
  }
  const bySkill = new Map(registry.map(strategy => [strategy.skillId, strategy]));
  const eligible = selection.eligibleSkillIds.map(skillId => bySkill.get(skillId)!);
  const identity = eligible[0]!;
  if (eligible.some(strategy =>
    strategy.equivalenceSetRef !== identity.equivalenceSetRef
    || strategy.documentRef !== input.request.state.documentRef
    || strategy.scopeRef !== input.request.state.scopeRef
    || strategy.goalRegionRef !== input.request.goal.regionRef
    || strategy.operation !== "CLICK")) {
    return { candidates: [], issue: "eligible strategies do not share one explicit effect, document, scope, and goal binding" };
  }
  const region = input.request.state.regions.find(item => item.ref === input.request.goal.regionRef);
  if (!region || region.expanded.status !== "observed" || region.rendered.status !== "observed") {
    return { candidates: [], issue: "goal state observation is insufficient" };
  }
  if (region.expanded.value !== region.rendered.value) {
    return { candidates: [], issue: "goal state observations conflict" };
  }
  if (region.expanded.value && region.rendered.value) {
    return { candidates: [], issue: "goal is already satisfied" };
  }
  const atomic = predictBrowserSingleAction(input.request, validateBrowserSingleActionProfile(resources.atomicProfile));
  const relations = new Map(atomic.relations.map(relation => [relation.ref, relation]));
  const candidates: StrategyCandidatePrediction[] = [];
  for (const strategy of eligible) {
    const element = input.request.state.elements.find(item => item.ref === strategy.targetRef);
    if (element === undefined) return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} is absent` };
    if (strategy.documentRef !== input.request.state.documentRef || strategy.scopeRef !== input.request.state.scopeRef
      || strategy.goalRegionRef !== input.request.goal.regionRef) {
      return { candidates: Object.freeze(candidates), issue: `strategy ${strategy.strategyRef} has an invalid current binding` };
    }
    if (element.candidateStatus !== "ok") {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} is not an eligible candidate` };
    }
    if (element.controls.status !== "observed") {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} controls are unknown` };
    }
    if (!element.controls.value.includes(strategy.goalRegionRef)) {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} controls another goal` };
    }
    if (element.enabled.status !== "observed" || !element.enabled.value) {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} enabled is not observed true` };
    }
    if (element.hit.status !== "observed" || !element.hit.value) {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} hit is not observed true` };
    }
    if (element.buttonSemantics.status !== "observed" || !element.buttonSemantics.value) {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} button semantics are not observed true` };
    }
    const nativeButton = element.tag === "button";
    const explicitRoleButton = element.tag !== "button" && element.role === "button";
    if (!nativeButton && !explicitRoleButton) {
      return { candidates: Object.freeze(candidates), issue: `strategy target ${strategy.targetRef} is neither native nor explicit role button` };
    }
    const relation = relations.get(strategy.targetRef);
    if (relation === undefined || relation.judgment !== "actionable_provider") {
      return { candidates: Object.freeze(candidates), issue: `atomic relation does not confirm strategy target ${strategy.targetRef}` };
    }
    if (relation.scores.length !== 2 || !relation.scores.every(Number.isFinite)) {
      throw new Error(`Non-finite atomic relation scores for ${strategy.targetRef}`);
    }
    const difference = relation.scores[0]! - relation.scores[1]!;
    if (!Number.isFinite(difference)) throw new Error(`Non-finite atomic provider margin for ${strategy.targetRef}`);
    const providerMargin = 0.5 + 0.5 * difference / (1 + Math.abs(difference));
    const history = latestHistory(input, strategy);
    const features = feature(strategy, element, providerMargin, history, resources);
    const logits = profile.weights.map(weights => dot(weights, features));
    if (!logits.every(Number.isFinite)) throw new Error(`Non-finite browser strategy logits for ${strategy.strategyRef}`);
    candidates.push(Object.freeze({
      strategyRef: strategy.strategyRef,
      skillId: strategy.skillId,
      targetRef: strategy.targetRef,
      features,
      logits: Object.freeze(logits),
      margin: logits[STRATEGY_HEADS.indexOf("choose")]! - logits[STRATEGY_HEADS.indexOf("defer")]!,
      feedback: history === null ? null : predictFeedback(history.input, resources.feedbackProfile),
    }));
  }
  return { candidates: Object.freeze(candidates), issue: null };
}

export function predictBrowserStrategy(
  value: unknown,
  resources: StrategyInferenceResources,
): BrowserStrategyPrediction {
  const input = readBrowserStrategyRequest(value);
  const profile = validateBrowserStrategyProfile(resources.profile);
  validateBrowserSingleActionProfile(resources.atomicProfile);
  validateFeedbackProfile(resources.feedbackProfile);
  const projected = projectForRequest(input, resources, profile);
  if (projected.issue !== null) return defer(projected.issue, projected.candidates);
  const selection = readSelection(resources.selection);
  if (selection.remainingAtomicAttempts === 0) {
    return defer("atomic attempt budget is exhausted", projected.candidates);
  }
  if (projected.candidates.length === 0) return defer("no policy candidate can be scored");
  const maximum = Math.max(...projected.candidates.map(candidate => candidate.margin));
  const winners = projected.candidates.filter(candidate => candidate.margin === maximum);
  if (winners.length !== 1) return defer("candidate margins tie at the maximum", projected.candidates);
  if (maximum <= 0) return defer("maximum candidate margin is not strictly positive", projected.candidates);
  const winner = winners[0]!;
  return Object.freeze({
    kind: "SELECT",
    skillId: winner.skillId,
    strategyRef: winner.strategyRef,
    targetRef: winner.targetRef,
    reason: null,
    candidates: projected.candidates,
  });
}

export function projectStrategyCandidates(
  value: unknown,
  resources: StrategyInferenceResources,
): readonly StrategyCandidatePrediction[] {
  return predictBrowserStrategy(value, resources).candidates;
}
