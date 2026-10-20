import { expectRecord } from "../core/schema.js";
import {
  SINGLE_ACTION_CAPABILITY_HEADS,
  SINGLE_ACTION_CAPABILITY_WIRES,
  SINGLE_ACTION_RELATION_HEADS,
  SINGLE_ACTION_RELATION_WIRES,
  type BrowserSingleActionProfile,
  type SingleActionCapability,
  type SingleActionElement,
  type SingleActionPrediction,
  type SingleActionRegion,
  type SingleActionRelationPrediction,
  type SingleActionRequest,
} from "../adapters/browser/single-action-contract.js";

type SingleActionRelationHead = typeof SINGLE_ACTION_RELATION_HEADS[number];
type SingleActionRelationWire = typeof SINGLE_ACTION_RELATION_WIRES[number];
type SingleActionCapabilityWire = typeof SINGLE_ACTION_CAPABILITY_WIRES[number];

const PROFILE_KEYS = [
  "adoption",
  "calibration",
  "capabilityHeads",
  "capabilityWeights",
  "capabilityWires",
  "contract",
  "relationHeads",
  "relationWeights",
  "relationWires",
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function sameSequence(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new TypeError(`${label} must be exactly ${expected.join(", ")}`);
  }
}

function finiteMatrix(value: unknown, rows: number, columns: number, label: string): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== rows) throw new TypeError(`${label} must have ${rows} rows`);
  return Object.freeze(value.map((raw, rowIndex) => {
    if (!Array.isArray(raw) || raw.length !== columns || raw.some(weight => typeof weight !== "number" || !Number.isFinite(weight))) {
      throw new TypeError(`${label} row ${rowIndex} must contain ${columns} finite values`);
    }
    return Object.freeze([...raw] as number[]);
  }));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function readObservation(value: unknown, label: string): { readonly status: "observed" | "unknown"; readonly value?: unknown; readonly reason?: string } {
  const observation = expectRecord(value, label);
  if (observation.status === "observed") {
    if (!Object.hasOwn(observation, "value")) throw new TypeError(`${label}.value is required`);
    return observation as { readonly status: "observed"; readonly value: unknown };
  }
  if (observation.status === "unknown") {
    nonEmptyString(observation.reason, `${label}.reason`);
    return observation as { readonly status: "unknown"; readonly reason: string };
  }
  throw new TypeError(`${label}.status must be observed or unknown`);
}

function readBooleanObservation(value: unknown, label: string): { readonly status: "observed" | "unknown"; readonly value?: boolean } {
  const observation = readObservation(value, label);
  if (observation.status === "observed" && typeof observation.value !== "boolean") {
    throw new TypeError(`${label}.value must be a boolean`);
  }
  return observation as { readonly status: "observed" | "unknown"; readonly value?: boolean };
}

function readControlsObservation(value: unknown, label: string): { readonly status: "observed" | "unknown"; readonly value?: readonly string[] } {
  const observation = readObservation(value, label);
  if (observation.status === "observed") {
    if (!Array.isArray(observation.value) || observation.value.some(item => typeof item !== "string" || item.length === 0)) {
      throw new TypeError(`${label}.value must be an array of non-empty references`);
    }
    return observation as { readonly status: "observed"; readonly value: readonly string[] };
  }
  return observation as { readonly status: "unknown" };
}

function readRequest(value: unknown): SingleActionRequest {
  const request = expectRecord(value, "single action request");
  const goal = expectRecord(request.goal, "single action request.goal");
  if (goal.kind !== "SetExpanded" || goal.desired !== true) {
    throw new TypeError("single action request goal must be SetExpanded with desired true");
  }
  nonEmptyString(goal.regionRef, "single action request.goal.regionRef");
  if (request.satisfactionThreshold !== 100) throw new TypeError("single action request.satisfactionThreshold must be 100");
  const state = expectRecord(request.state, "single action request.state");
  if (!Array.isArray(state.elements)) throw new TypeError("single action request.state.elements must be an array");
  if (!Array.isArray(state.regions)) throw new TypeError("single action request.state.regions must be an array");
  const refs = new Set<string>();
  for (const [index, raw] of state.elements.entries()) {
    const element = expectRecord(raw, `single action element ${index}`);
    const ref = nonEmptyString(element.ref, `single action element ${index}.ref`);
    if (refs.has(ref)) throw new TypeError(`single action element reference ${ref} is duplicated`);
    refs.add(ref);
    readControlsObservation(element.controls, `single action element ${ref}.controls`);
    readBooleanObservation(element.enabled, `single action element ${ref}.enabled`);
    readBooleanObservation(element.hit, `single action element ${ref}.hit`);
    readBooleanObservation(element.buttonSemantics, `single action element ${ref}.buttonSemantics`);
  }
  const regionRefs = new Set<string>();
  for (const [index, raw] of state.regions.entries()) {
    const region = expectRecord(raw, `single action region ${index}`);
    const ref = nonEmptyString(region.ref, `single action region ${index}.ref`);
    if (regionRefs.has(ref)) throw new TypeError(`single action region reference ${ref} is duplicated`);
    regionRefs.add(ref);
    readBooleanObservation(region.expanded, `single action region ${ref}.expanded`);
    readBooleanObservation(region.rendered, `single action region ${ref}.rendered`);
  }
  return request as unknown as SingleActionRequest;
}

function observationValue(observation: { readonly status: "observed" | "unknown"; readonly value?: unknown }): number {
  return observation.status === "observed" && observation.value === true ? 1 : 0;
}

function observationKnown(observation: { readonly status: "observed" | "unknown" }): number {
  return observation.status === "observed" ? 1 : 0;
}

function wireIndex<Wire extends string>(wires: readonly Wire[], name: Wire): number {
  const index = wires.indexOf(name);
  if (index < 0) throw new Error(`Wire ${name} is absent from the shared contract`);
  return index;
}

const CONTROLS_KNOWN = wireIndex(SINGLE_ACTION_RELATION_WIRES, "controls.known");
const CONTROLS_TARGET = wireIndex(SINGLE_ACTION_RELATION_WIRES, "controls.target");
const ENABLED_KNOWN = wireIndex(SINGLE_ACTION_RELATION_WIRES, "enabled.known");
const ENABLED_VALUE = wireIndex(SINGLE_ACTION_RELATION_WIRES, "enabled.value");
const HIT_KNOWN = wireIndex(SINGLE_ACTION_RELATION_WIRES, "hit.known");
const HIT_VALUE = wireIndex(SINGLE_ACTION_RELATION_WIRES, "hit.value");
const IS_GOAL_REGION = wireIndex(SINGLE_ACTION_RELATION_WIRES, "candidate.isGoalRegion");
const BUTTON_SEMANTICS_KNOWN = wireIndex(SINGLE_ACTION_RELATION_WIRES, "buttonSemantics.known");
const BUTTON_SEMANTICS_VALUE = wireIndex(SINGLE_ACTION_RELATION_WIRES, "buttonSemantics.value");

function relationFeatures(request: SingleActionRequest, element: SingleActionElement): readonly number[] {
  const controls = readControlsObservation(element.controls, `single action element ${element.ref}.controls`);
  const enabled = readBooleanObservation(element.enabled, `single action element ${element.ref}.enabled`);
  const hit = readBooleanObservation(element.hit, `single action element ${element.ref}.hit`);
  const buttonSemantics = readBooleanObservation(element.buttonSemantics, `single action element ${element.ref}.buttonSemantics`);
  const controlsTarget = controls.status === "observed" && controls.value!.includes(request.goal.regionRef) ? 1 : 0;
  const enabledValue = observationValue(enabled);
  const hitValue = observationValue(hit);
  const values = {
    "bias": 1,
    "controls.known": observationKnown(controls),
    "controls.target": controlsTarget,
    "enabled.known": observationKnown(enabled),
    "enabled.value": enabledValue,
    "hit.known": observationKnown(hit),
    "hit.value": hitValue,
    "candidate.isGoalRegion": element.ref === request.goal.regionRef ? 1 : 0,
    "buttonSemantics.known": observationKnown(buttonSemantics),
    "buttonSemantics.value": observationValue(buttonSemantics),
    "controls.target*enabled.value": controlsTarget * enabledValue,
    "controls.target*hit.value": controlsTarget * hitValue,
    "controls.target*enabled.value*hit.value": controlsTarget * enabledValue * hitValue,
  } satisfies Record<SingleActionRelationWire, number>;
  return Object.freeze(SINGLE_ACTION_RELATION_WIRES.map(wire => values[wire]));
}

function readRegion(request: SingleActionRequest): SingleActionRegion | null {
  return request.state.regions.find(region => region.ref === request.goal.regionRef) ?? null;
}

function validateRelations(
  request: SingleActionRequest,
  relations: readonly SingleActionRelationPrediction[],
): void {
  if (!Array.isArray(relations) || relations.length !== request.state.elements.length) {
    throw new TypeError("single action relations must preserve one entry per request element");
  }
  for (const [index, relation] of relations.entries()) {
    const record = expectRecord(relation, `single action relation ${index}`);
    if (record.ref !== request.state.elements[index]!.ref) {
      throw new TypeError(`single action relation ${index} must preserve request element order`);
    }
    if (!Array.isArray(record.features) || record.features.length !== SINGLE_ACTION_RELATION_WIRES.length
      || record.features.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new TypeError(`single action relation ${index} features are invalid`);
    }
    if (!Array.isArray(record.scores) || record.scores.length !== SINGLE_ACTION_RELATION_HEADS.length
      || record.scores.some(value => typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError(`single action relation ${index} scores are invalid`);
    }
    if (record.judgment !== "actionable_provider" && record.judgment !== "not_provider" && record.judgment !== "unknown") {
      throw new TypeError(`single action relation ${index} judgment is invalid`);
    }
  }
}

function capabilityFeatures(request: SingleActionRequest, relations: readonly SingleActionRelationPrediction[]): readonly number[] {
  readRequest(request);
  validateRelations(request, relations);
  const region = readRegion(request);
  const expanded = region === null
    ? { status: "unknown" as const }
    : readBooleanObservation(region.expanded, `single action region ${region.ref}.expanded`);
  const providers = relations.filter(relation => relation.judgment === "actionable_provider").length;
  const relationComplete = relations.every(relation => relation.features[CONTROLS_KNOWN] === 1);
  const actionabilityComplete = relations.every(relation =>
    relation.features[CONTROLS_TARGET] === 0
    || (relation.features[ENABLED_KNOWN] === 1 && relation.features[HIT_KNOWN] === 1));
  const values = {
    "bias": 1,
    "regionExpanded.known": observationKnown(expanded),
    "regionExpanded.value": observationValue(expanded),
    "providers.zero": providers === 0 ? 1 : 0,
    "providers.one": providers === 1 ? 1 : 0,
    "providers.many": providers > 1 ? 1 : 0,
    "relationCoverage.complete": relationComplete ? 1 : 0,
    "actionabilityCoverage.complete": actionabilityComplete ? 1 : 0,
  } satisfies Record<SingleActionCapabilityWire, number>;
  return Object.freeze(SINGLE_ACTION_CAPABILITY_WIRES.map(wire => values[wire]));
}

function dot(weights: readonly number[], features: readonly number[]): number {
  return weights.reduce((sum, weight, index) => sum + weight * features[index]!, 0);
}

function relationJudgment(scores: readonly number[], features: readonly number[]): SingleActionRelationHead | "unknown" {
  if (features[CONTROLS_KNOWN] !== 1 || features[ENABLED_KNOWN] !== 1 || features[HIT_KNOWN] !== 1) return "unknown";
  if (scores[0] === scores[1]) return "unknown";
  return scores[0]! > scores[1]! ? "actionable_provider" : "not_provider";
}

function capabilityHead(scores: readonly number[], heads: readonly SingleActionCapability[]): SingleActionCapability {
  const maximum = Math.max(...scores);
  const winners = scores.filter(score => score === maximum).length;
  // A tied capability head is insufficient or ambiguous evidence, so retain DEFER.
  if (winners !== 1) return "DEFER";
  return heads[scores.indexOf(maximum)]!;
}

export function createZeroBrowserSingleActionProfile(): BrowserSingleActionProfile {
  return validateBrowserSingleActionProfile({
    contract: "browser.single-action-policy.v1",
    relationHeads: [...SINGLE_ACTION_RELATION_HEADS],
    relationWires: [...SINGLE_ACTION_RELATION_WIRES],
    capabilityHeads: [...SINGLE_ACTION_CAPABILITY_HEADS],
    capabilityWires: [...SINGLE_ACTION_CAPABILITY_WIRES],
    relationWeights: Array.from({ length: SINGLE_ACTION_RELATION_HEADS.length }, () =>
      Array(SINGLE_ACTION_RELATION_WIRES.length).fill(0)),
    capabilityWeights: Array.from({ length: SINGLE_ACTION_CAPABILITY_HEADS.length }, () =>
      Array(SINGLE_ACTION_CAPABILITY_WIRES.length).fill(0)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function validateBrowserSingleActionProfile(value: unknown): BrowserSingleActionProfile {
  const profile = expectRecord(value, "browser single action profile");
  exactKeys(profile, PROFILE_KEYS, "browser single action profile");
  if (profile.contract !== "browser.single-action-policy.v1") {
    throw new TypeError("Browser single action profile contract is invalid");
  }
  sameSequence(profile.relationHeads, SINGLE_ACTION_RELATION_HEADS, "browser single action relation heads");
  sameSequence(profile.relationWires, SINGLE_ACTION_RELATION_WIRES, "browser single action relation wires");
  sameSequence(profile.capabilityHeads, SINGLE_ACTION_CAPABILITY_HEADS, "browser single action capability heads");
  sameSequence(profile.capabilityWires, SINGLE_ACTION_CAPABILITY_WIRES, "browser single action capability wires");
  if (profile.calibration !== "uncalibrated") throw new TypeError("Browser single action calibration must be uncalibrated");
  if (profile.adoption !== "not_applied") throw new TypeError("Browser single action adoption must be not_applied");
  return Object.freeze({
    contract: "browser.single-action-policy.v1",
    relationHeads: Object.freeze([...SINGLE_ACTION_RELATION_HEADS]),
    relationWires: Object.freeze([...SINGLE_ACTION_RELATION_WIRES]),
    capabilityHeads: Object.freeze([...SINGLE_ACTION_CAPABILITY_HEADS]),
    capabilityWires: Object.freeze([...SINGLE_ACTION_CAPABILITY_WIRES]),
    relationWeights: finiteMatrix(profile.relationWeights, SINGLE_ACTION_RELATION_HEADS.length, SINGLE_ACTION_RELATION_WIRES.length, "browser single action relation weights"),
    capabilityWeights: finiteMatrix(profile.capabilityWeights, SINGLE_ACTION_CAPABILITY_HEADS.length, SINGLE_ACTION_CAPABILITY_WIRES.length, "browser single action capability weights"),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function singleActionRelationFeatures(request: SingleActionRequest, element: SingleActionElement): readonly number[] {
  return relationFeatures(readRequest(request), element);
}

export function singleActionCapabilityFeatures(
  request: SingleActionRequest,
  relations: readonly SingleActionRelationPrediction[],
): readonly number[] {
  return capabilityFeatures(request, relations);
}

export function predictBrowserSingleAction(request: SingleActionRequest, profile: BrowserSingleActionProfile): SingleActionPrediction {
  const validated = validateBrowserSingleActionProfile(profile);
  const validatedRequest = readRequest(request);
  const relations = validatedRequest.state.elements.map(element => {
    const features = relationFeatures(validatedRequest, element);
    const scores = validated.relationWeights.map(weights => dot(weights, features));
    if (!scores.every(Number.isFinite)) throw new Error("Non-finite browser single action relation logits");
    return Object.freeze({
      ref: element.ref,
      features,
      scores: Object.freeze(scores),
      judgment: relationJudgment(scores, features),
    }) satisfies SingleActionRelationPrediction;
  });
  const features = capabilityFeatures(validatedRequest, relations);
  const scores = validated.capabilityWeights.map(weights => dot(weights, features));
  if (!scores.every(Number.isFinite)) throw new Error("Non-finite browser single action capability logits");
  const capability = capabilityHead(scores, SINGLE_ACTION_CAPABILITY_HEADS);
  const providers = relations.filter(relation => relation.judgment === "actionable_provider");
  return Object.freeze({
    relations: Object.freeze(relations),
    capability,
    capabilityFeatures: features,
    capabilityScores: Object.freeze(scores),
    proposedTargetRef: capability === "CLICK" && providers.length === 1 ? providers[0]!.ref : null,
  });
}

export function createBrowserSingleActionPolicy(input: Readonly<{ profile: BrowserSingleActionProfile }>) {
  const value = expectRecord(input, "browser single action policy request");
  const profile = validateBrowserSingleActionProfile(value.profile);
  return Object.freeze({
    profile,
    predict: (request: SingleActionRequest) => predictBrowserSingleAction(request, profile),
  });
}
