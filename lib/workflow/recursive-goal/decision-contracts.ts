import {
  type PathAttemptStep,
  type PathPreferencePolicy,
  type PathProjection,
  type PathRanking,
  readPathPreferencePolicy,
  readVersionedRef,
  type VersionedRef,
} from "./planning-contracts.js";
import type { TrainableSemanticUnit } from "../../core/trainable-unit.js";
import {
  expectArray,
  expectFiniteNumber,
  expectNonEmptyString,
  expectRecord,
  expectStringArray,
  isRecord,
} from "../../core/schema.js";

export const PLANNING_DECISION_CONTRACT = "planning.decision-policy.v1" as const;
export const PLANNING_DECISION_WIRE_SCHEMA_VERSION =
  "planning.decision-wire.v1" as const;
export const PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED =
  "PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED" as const;
export const DEFAULT_PLANNING_DECISION_RULE_REF = Object.freeze({
  id: "planning.decision.default-rule",
  version: "planning.decision-rule.v1",
});

/** A parameter version, separate from the unit/provider contract versions. */
export interface PlanningDecisionWeightCandidate {
  readonly ref: VersionedRef;
  readonly profile: PlanningDecisionProfile;
}

export interface PlanningDecisionReloadResource {
  reload(candidate: PlanningDecisionWeightCandidate): Promise<VersionedRef>;
  capture(): PlanningDecisionBinding;
}

export interface PlanningDecisionComparisonRow {
  readonly pathId: string;
  readonly features: readonly number[];
  readonly known: readonly boolean[];
  readonly missing: readonly PlanningDecisionWire[];
  readonly utility: number | null;
}

export type PlanningDecisionComparisonResult = {
  readonly ref: VersionedRef;
  readonly profile: PlanningDecisionProfile;
  readonly kind: "evaluated";
  readonly rows: readonly PlanningDecisionComparisonRow[];
  readonly ranking: PathRanking;
} | {
  readonly ref: VersionedRef;
  readonly kind: "error";
  readonly message: string;
};

export const PLANNING_DECISION_WIRES = [
  "bias",
  "satisfaction.known",
  "satisfaction.value",
  "risk.known",
  "risk.value",
  "cost.known",
  "cost.value",
  "rankOrder.known",
  "rankOrder.value",
  "coverage.covered",
  "coverage.truncated",
  "coverage.unknown",
  "prior.deprioritized",
  "unknown.present",
  "preference.score_first",
  "preference.order_first",
  "preference.conservative",
  "preference.aggressive",
] as const;

export type PlanningDecisionWire = typeof PLANNING_DECISION_WIRES[number];

export interface PlanningDecisionInputCandidate {
  readonly pathId: string;
  readonly rankOrder: number | null;
  readonly projection: PathProjection;
  readonly attemptOrder: readonly PathAttemptStep[];
}

export interface PlanningDecisionPriorInfluence {
  readonly priorRef: string;
  readonly pathRef: string;
  readonly transitionRefs: readonly string[];
}

export interface PlanningDecisionInput {
  readonly preference: PathPreferencePolicy;
  readonly candidates: readonly PlanningDecisionInputCandidate[];
  readonly priorInfluences: readonly PlanningDecisionPriorInfluence[];
  readonly unknown: readonly {
    readonly ref: string;
    readonly reason: string;
  }[];
}

export interface PlanningDecisionFeatureRange {
  readonly min: 0;
  readonly max: 1;
}

export interface PlanningDecisionNormalization {
  readonly satisfaction: {
    readonly min: number;
    readonly max: number;
  };
  readonly risk: {
    readonly scaleRef: VersionedRef;
    readonly maxOrdinal: number;
  };
  readonly cost: {
    readonly unit: string;
    readonly min: number;
    readonly max: number;
  };
  readonly rankOrder: {
    readonly min: number;
    readonly max: number;
  };
}

export interface PlanningDecisionProfile {
  readonly contract: typeof PLANNING_DECISION_CONTRACT;
  readonly providerRef: VersionedRef;
  readonly unitRef: VersionedRef;
  readonly wireSchemaVersion: typeof PLANNING_DECISION_WIRE_SCHEMA_VERSION;
  readonly wires: readonly PlanningDecisionWire[];
  readonly featureRange: PlanningDecisionFeatureRange;
  readonly weights: readonly number[];
  readonly normalization: PlanningDecisionNormalization;
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface PlanningDecisionRuleResources {
  readonly kind: "planning_decision.rule.v1";
  readonly ref: VersionedRef;
}

export interface PlanningDecisionHandwiredResources {
  readonly kind: "planning_decision.handwired.v1";
  readonly profile: PlanningDecisionProfile;
  readonly handwiredRoot: string;
}

export type PlanningDecisionInferenceResources =
  | PlanningDecisionRuleResources
  | PlanningDecisionHandwiredResources;

/**
 * Training types are surfaced so `PlanningDecisionUnit` matches the shared
 * lifecycle. Training is explicitly not implemented in this batch.
 */
export interface PlanningDecisionTrainingInput {
  readonly kind: "planning_decision.training.v1";
  readonly episodes: readonly {
    readonly input: PlanningDecisionInput;
    readonly supervision:
      | {readonly kind:"preferred_paths"; readonly acceptableFirstPathRefs:readonly string[]}
      | {readonly kind:"defer"; readonly reason:string};
    readonly source: "human" | "teacher" | "verified_rule";
    readonly sourceRefs: readonly string[];
    readonly family: string;
    readonly partition: "train" | "dev" | "verification";
    readonly executionRefs: readonly string[];
    readonly feedback: {
      readonly stageOutcome:"achieved"|"unmet"|"wrong_selection"|"environment_error"|"observation_unknown";
      readonly attribution:"model"|"environment"|"unknown";
      readonly reward:number|null;
      readonly evidenceRefs:readonly string[];
    } | null;
  }[];
}

export interface PlanningDecisionCandidate {
  readonly kind: "planning_decision.candidate.v1";
  readonly profile: PlanningDecisionProfile;
}

export interface PlanningDecisionTrainingResources {
  readonly kind: "planning_decision.training.v1";
  readonly initial: PlanningDecisionProfile;
  readonly handwiredRoot: string;
}

export type PlanningDecisionUnit = TrainableSemanticUnit<
  PlanningDecisionInput,
  PathRanking,
  PlanningDecisionInferenceResources,
  PlanningDecisionTrainingInput,
  PlanningDecisionCandidate,
  PlanningDecisionTrainingResources
>;

export interface PlanningDecisionBinding {
  readonly ref: VersionedRef;
  infer(input: PlanningDecisionInput): Promise<PathRanking>;
}

export class PlanningDecisionTrainingNotImplementedError extends Error {
  readonly code: typeof PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED =
    PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED;

  constructor() {
    super("Planning decision training is not implemented in this batch");
    this.name = "PlanningDecisionTrainingNotImplementedError";
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function assertUniqueStrings(
  values: readonly string[],
  label: string,
): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${label} contains duplicate values`);
    seen.add(value);
  }
  return Object.freeze([...values]);
}

function readDecisionUnknowns(
  value: unknown,
  label: string,
): readonly { readonly ref: string; readonly reason: string }[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const unknowns = value.map((entry, index) => {
    const row = expectRecord(entry, `${label}[${index}]`);
    exactKeys(row, ["ref", "reason"], `${label}[${index}]`);
    return Object.freeze({
      ref: expectNonEmptyString(row.ref, `${label}[${index}].ref`),
      reason: expectNonEmptyString(row.reason, `${label}[${index}].reason`),
    });
  });
  assertUniqueStrings(
    unknowns.map(item => item.ref),
    `${label}.ref`,
  );
  return Object.freeze(unknowns);
}

function readDecisionAttemptOrder(
  value: unknown,
  label: string,
): readonly PathAttemptStep[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const steps = value.map((entry, index) => {
    const row = expectRecord(entry, `${label}[${index}]`);
    exactKeys(row, ["order", "nodeRef", "skillRef"], `${label}[${index}]`);
    const order = expectFiniteNumber(row.order, `${label}[${index}].order`);
    if (!Number.isInteger(order) || order < 0) {
      throw new TypeError(`${label}[${index}].order must be a nonnegative integer`);
    }
    return Object.freeze({
      order,
      nodeRef: expectNonEmptyString(row.nodeRef, `${label}[${index}].nodeRef`),
      skillRef: readVersionedRef(row.skillRef, `${label}[${index}].skillRef`),
    });
  });
  return Object.freeze(steps);
}

function readDecisionProjection(value: unknown, label: string): PathProjection {
  const projection = expectRecord(value, label);
  exactKeys(
    projection,
    [
      "terminalSatisfaction",
      "riskLevels",
      "maximumCost",
      "costUnit",
      "unknownRefs",
      "coverage",
    ],
    label,
  );
  const terminalSatisfaction =
    projection.terminalSatisfaction === null
      ? null
      : expectFiniteNumber(
          projection.terminalSatisfaction,
          `${label}.terminalSatisfaction`,
        );
  const riskLevels = projection.riskLevels;
  if (!Array.isArray(riskLevels)) {
    throw new TypeError(`${label}.riskLevels must be an array`);
  }
  const levels = riskLevels.map((entry, index) => {
    const row = expectRecord(entry, `${label}.riskLevels[${index}]`);
    exactKeys(row, ["scaleRef", "level", "ordinal"], `${label}.riskLevels[${index}]`);
    const ordinal = expectFiniteNumber(row.ordinal, `${label}.riskLevels[${index}].ordinal`);
    if (!Number.isInteger(ordinal) || ordinal < 0) {
      throw new TypeError(`${label}.riskLevels[${index}].ordinal must be a nonnegative integer`);
    }
    return Object.freeze({
      scaleRef: readVersionedRef(row.scaleRef, `${label}.riskLevels[${index}].scaleRef`),
      level: expectNonEmptyString(row.level, `${label}.riskLevels[${index}].level`),
      ordinal,
    });
  });
  const maximumCost =
    projection.maximumCost === null
      ? null
      : expectFiniteNumber(projection.maximumCost, `${label}.maximumCost`);
  const costUnit =
    projection.costUnit === null
      ? null
      : expectNonEmptyString(projection.costUnit, `${label}.costUnit`);
  const unknownRefs = expectStringArray(projection.unknownRefs, `${label}.unknownRefs`);
  const coverage = projection.coverage;
  if (coverage !== "covered" && coverage !== "truncated" && coverage !== "unknown") {
    throw new TypeError(`${label}.coverage must be covered, truncated, or unknown`);
  }
  return Object.freeze({
    terminalSatisfaction,
    riskLevels: Object.freeze(levels),
    maximumCost,
    costUnit,
    unknownRefs: Object.freeze(unknownRefs),
    coverage,
  });
}

export function validatePlanningDecisionInput(
  value: unknown,
  label = "planning decision input",
): PlanningDecisionInput {
  const input = expectRecord(value, label);
  exactKeys(input, ["preference", "candidates", "priorInfluences", "unknown"], label);
  const preference = readPathPreferencePolicy(input.preference, `${label}.preference`);
  if (!Array.isArray(input.candidates)) {
    throw new TypeError(`${label}.candidates must be an array`);
  }
  const candidates = input.candidates.map((entry, index) => {
    const row = expectRecord(entry, `${label}.candidates[${index}]`);
    exactKeys(row, ["pathId", "rankOrder", "projection", "attemptOrder"], `${label}.candidates[${index}]`);
    const pathId = expectNonEmptyString(row.pathId, `${label}.candidates[${index}].pathId`);
    const rankOrder =
      row.rankOrder === null
        ? null
        : expectFiniteNumber(row.rankOrder, `${label}.candidates[${index}].rankOrder`);
    return Object.freeze({
      pathId,
      rankOrder,
      projection: readDecisionProjection(row.projection, `${label}.candidates[${index}].projection`),
      attemptOrder: readDecisionAttemptOrder(row.attemptOrder, `${label}.candidates[${index}].attemptOrder`),
    });
  });
  assertUniqueStrings(
    candidates.map(candidate => candidate.pathId),
    `${label}.candidates.pathId`,
  );
  if (!Array.isArray(input.priorInfluences)) {
    throw new TypeError(`${label}.priorInfluences must be an array`);
  }
  const priorInfluences = input.priorInfluences.map((entry, index) => {
    const row = expectRecord(entry, `${label}.priorInfluences[${index}]`);
    exactKeys(
      row,
      ["priorRef", "pathRef", "transitionRefs"],
      `${label}.priorInfluences[${index}]`,
    );
    const priorRef = expectNonEmptyString(row.priorRef, `${label}.priorInfluences[${index}].priorRef`);
    const pathRef = expectNonEmptyString(row.pathRef, `${label}.priorInfluences[${index}].pathRef`);
    if (!candidates.some(candidate => candidate.pathId === pathRef)) {
      throw new TypeError(
        `${label}.priorInfluences[${index}].pathRef is outside the legal candidate set`,
      );
    }
    const transitionRefs = expectStringArray(
      row.transitionRefs,
      `${label}.priorInfluences[${index}].transitionRefs`,
    );
    assertUniqueStrings(
      transitionRefs,
      `${label}.priorInfluences[${index}].transitionRefs`,
    );
    return Object.freeze({
      priorRef,
      pathRef,
      transitionRefs: Object.freeze(transitionRefs),
    });
  });
  const unknown = readDecisionUnknowns(input.unknown, `${label}.unknown`);
  return Object.freeze({
    preference,
    candidates: Object.freeze(candidates),
    priorInfluences: Object.freeze(priorInfluences),
    unknown,
  });
}

export function readPlanningDecisionRanking(
  input: PlanningDecisionInput,
  value: unknown,
  label = "planning decision ranking",
): PathRanking {
  const ranking = expectRecord(value, label);
  if (ranking.kind === "defer") {
    exactKeys(ranking, ["kind", "missingKeys", "reason"], label);
    const missingKeys = expectStringArray(ranking.missingKeys, `${label}.missingKeys`);
    const reason = expectNonEmptyString(ranking.reason, `${label}.reason`);
    return Object.freeze({
      kind: "defer",
      missingKeys: assertUniqueStrings(missingKeys, `${label}.missingKeys`),
      reason,
    });
  }
  if (ranking.kind === "ranked") {
    exactKeys(ranking, ["kind", "pathRefs"], label);
    const pathRefs = expectStringArray(ranking.pathRefs, `${label}.pathRefs`);
    assertUniqueStrings(pathRefs, `${label}.pathRefs`);
    const expectedPaths = input.candidates.map(candidate => candidate.pathId);
    const expectedSet = new Set(expectedPaths);
    const rankedSet = new Set(pathRefs);
    if (pathRefs.length !== expectedPaths.length) {
      throw new TypeError(
        `${label}.pathRefs must contain every input candidate exactly once`,
      );
    }
    for (const pathRef of pathRefs) {
      if (!expectedSet.has(pathRef)) {
        throw new TypeError(`${label}.pathRefs contains an unknown path ${pathRef}`);
      }
    }
    for (const pathRef of expectedPaths) {
      if (!rankedSet.has(pathRef)) {
        throw new TypeError(`${label}.pathRefs omits candidate ${pathRef}`);
      }
    }
    return Object.freeze({
      kind: "ranked",
      pathRefs: Object.freeze(pathRefs),
    });
  }
  throw new TypeError(`${label}.kind must be ranked or defer`);
}

export function createPlanningDecisionBinding(
  unit: PlanningDecisionUnit,
  resources: PlanningDecisionInferenceResources,
): PlanningDecisionBinding {
  if (!isRecord(unit) || typeof unit.infer !== "function" || typeof unit.train !== "function") {
    throw new TypeError("planning decision unit must expose infer and train");
  }
  const ref = decisionBindingRef(resources);
  return Object.freeze({
    ref,
    infer: (input: PlanningDecisionInput) =>
      unit.infer(validatePlanningDecisionInput(input), resources),
  });
}

export async function resolvePlanningDecision(
  binding: PlanningDecisionBinding,
  value: unknown,
): Promise<PathRanking> {
  if (!isRecord(binding) || typeof binding.infer !== "function") {
    throw new TypeError("planning decision binding must expose infer");
  }
  const input = validatePlanningDecisionInput(value);
  const ranking = await binding.infer(input);
  return readPlanningDecisionRanking(input, ranking);
}

function decisionBindingRef(resources: PlanningDecisionInferenceResources): VersionedRef {
  if (resources.kind === "planning_decision.rule.v1") {
    return resources.ref;
  }
  if (resources.kind === "planning_decision.handwired.v1") {
    return resources.profile.unitRef;
  }
  throw new TypeError("planning decision resources kind is unsupported");
}
