// B-A1 m2 R2: search-input-host usage-relation member contract.
//
// learnable:  two linear heads over the 27 declared form features, each closed
//             by tanh, so querySupport / fieldSupport lie in (-1, 1).
// deterministic: the four-state guard, including the unmeasured interval rule of
//             ruling 3, and the mapping from two scores to one typed state.
//
// Layer boundary (Alice, explicit): this member is NOT the binder. The binder
// has its own 36 wires, its own threshold and its own verdicts. No margin,
// reachability or pass conclusion may be borrowed between the two layers.

import { expectRecord } from "../../core/schema.js";
import {
  USAGE_FORM_FEATURE_NAMES,
  USAGE_RELATION_CONTRACT,
  usageFormFeatureVector,
  validateUsageTokenTable,
  type UsageFormFeatureName,
  type UsageObservation,
  type UsageTokenTable,
} from "./search-input-host-usage-contract.js";

/** Support threshold of each head. Frozen: the guard below is defined on it. */
export const USAGE_RELATION_THRESHOLD = 0.5;

/**
 * The inference boundary in z space: tanh(z) >= theta  <=>  z >= atanh(theta).
 * Same constant the binder uses, but a different layer with a different gate.
 */
export const USAGE_RELATION_BOUNDARY = Math.atanh(USAGE_RELATION_THRESHOLD);

export type UsageRelationState = "query_action" | "field_description" | "ambiguous" | "unmeasured";
export type UsageRelationReason = "conflicting_support" | "unsupported_relation" | null;

export interface UsageRelationProfile {
  readonly contract: typeof USAGE_RELATION_CONTRACT;
  /** Feature names in declared order. A saved profile is self-describing. */
  readonly features: readonly UsageFormFeatureName[];
  readonly queryWeights: readonly number[];
  readonly fieldWeights: readonly number[];
  readonly threshold: number;
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface UsageRelationInference {
  readonly state: UsageRelationState;
  /** Null exactly when the head is undetermined; never a fabricated point. */
  readonly querySupport: number | null;
  readonly fieldSupport: number | null;
  readonly reason: UsageRelationReason;
  readonly observedRevision: number;
  readonly evidenceRefs: readonly string[];
}

/** Per-head result of the interval rule. */
type HeadVerdict = "reaches" | "below" | "undetermined";

export interface UsageRelationHeadInterval {
  readonly lo: number;
  readonly hi: number;
  readonly point: number;
  readonly verdict: HeadVerdict;
}

function expectWeightVector(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length !== USAGE_FORM_FEATURE_NAMES.length) {
    throw new TypeError(`${label} must have ${USAGE_FORM_FEATURE_NAMES.length} values`);
  }
  return value.map((weight, index) => {
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new TypeError(`${label}[${index}] must be finite`);
    }
    return weight;
  });
}

export function validateUsageRelationProfile(value: unknown): UsageRelationProfile {
  const profile = expectRecord(value, "usage relation profile");
  if (profile.contract !== USAGE_RELATION_CONTRACT) {
    throw new TypeError(`usage relation profile contract must be ${USAGE_RELATION_CONTRACT}`);
  }
  if (!Array.isArray(profile.features) || profile.features.length !== USAGE_FORM_FEATURE_NAMES.length
    || profile.features.some((name, index) => name !== USAGE_FORM_FEATURE_NAMES[index])) {
    throw new TypeError("usage relation profile features must match the declared feature order");
  }
  const queryWeights = expectWeightVector(profile.queryWeights, "usage relation queryWeights");
  const fieldWeights = expectWeightVector(profile.fieldWeights, "usage relation fieldWeights");
  if (profile.threshold !== USAGE_RELATION_THRESHOLD) {
    throw new TypeError(`usage relation threshold is frozen at ${USAGE_RELATION_THRESHOLD}`);
  }
  if (profile.calibration !== "uncalibrated") throw new TypeError("usage relation calibration must be uncalibrated");
  if (profile.adoption !== "not_applied") throw new TypeError("usage relation adoption must be not_applied");
  return Object.freeze({
    contract: USAGE_RELATION_CONTRACT,
    features: Object.freeze([...USAGE_FORM_FEATURE_NAMES]),
    queryWeights: Object.freeze([...queryWeights]),
    fieldWeights: Object.freeze([...fieldWeights]),
    threshold: USAGE_RELATION_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/** Neutral start: both heads are flat, so the fit decides every value. */
export function neutralUsageRelationProfile(): UsageRelationProfile {
  return validateUsageRelationProfile({
    contract: USAGE_RELATION_CONTRACT,
    features: [...USAGE_FORM_FEATURE_NAMES],
    queryWeights: USAGE_FORM_FEATURE_NAMES.map(() => 0),
    fieldWeights: USAGE_FORM_FEATURE_NAMES.map(() => 0),
    threshold: USAGE_RELATION_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/**
 * The unmeasured-interval rule (ruling 3), made executable.
 *
 * A measured feature is a fixed 0 or 1. An unmeasured feature may be anywhere in
 * [0, 1], so its contribution can be pushed to whichever end the weight sign
 * allows. A zero weight therefore cannot be an actual dependency: it moves
 * neither end. The head is decided only when every completion lands on the same
 * side of the threshold; otherwise it is undetermined and reports null.
 *
 * `point` uses the measured contributions only, which is numerically the same as
 * scoring an unmeasured feature as 0. It is reported only for a decided head,
 * where it is guaranteed to sit inside the interval on the decided side.
 */
export function usageRelationHeadInterval(
  weights: readonly number[],
  vector: readonly (boolean | null)[],
): UsageRelationHeadInterval {
  let point = 0;
  let lo = 0;
  let hi = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0;
    const value = vector[index];
    if (value === null || value === undefined) {
      // Unmeasured: the completion is free in [0, 1].
      if (weight < 0) lo += weight;
      else if (weight > 0) hi += weight;
      continue;
    }
    const contribution = value ? weight : 0;
    point += contribution;
    lo += contribution;
    hi += contribution;
  }
  const verdict: HeadVerdict = lo >= USAGE_RELATION_BOUNDARY
    ? "reaches"
    : hi < USAGE_RELATION_BOUNDARY ? "below" : "undetermined";
  return Object.freeze({ lo, hi, point, verdict });
}

/**
 * Infer the typed relation state of one observation.
 *
 * Deterministic: the same observation and profile always give the same result.
 * Output carries no execution permission; a high support score is evidence.
 */
export function inferUsageRelation(
  input: {
    readonly observation: UsageObservation;
    readonly tokens: UsageTokenTable;
  },
  resources: { readonly profile: UsageRelationProfile },
): UsageRelationInference {
  const profile = validateUsageRelationProfile(resources.profile);
  const tokens = validateUsageTokenTable(input.tokens);
  const vector = usageFormFeatureVector(input.observation, tokens);
  const query = usageRelationHeadInterval(profile.queryWeights, vector);
  const field = usageRelationHeadInterval(profile.fieldWeights, vector);

  const base = {
    observedRevision: input.observation.revision,
    evidenceRefs: Object.freeze([input.observation.ref]),
  };

  if (query.verdict === "undetermined" || field.verdict === "undetermined") {
    // An unknown completion could flip a head, so no four-state verdict is
    // determined. Reporting a point score here would hide the missing evidence.
    return Object.freeze({
      ...base,
      state: "unmeasured" as const,
      querySupport: null,
      fieldSupport: null,
      reason: null,
    });
  }

  const querySupport = Math.tanh(query.point);
  const fieldSupport = Math.tanh(field.point);
  const queryOn = query.verdict === "reaches";
  const fieldOn = field.verdict === "reaches";

  if (queryOn && !fieldOn) {
    return Object.freeze({ ...base, state: "query_action" as const, querySupport, fieldSupport, reason: null });
  }
  if (fieldOn && !queryOn) {
    return Object.freeze({ ...base, state: "field_description" as const, querySupport, fieldSupport, reason: null });
  }
  // Both heads agree, in either direction: this is not a usable relation.
  return Object.freeze({
    ...base,
    state: "ambiguous" as const,
    querySupport,
    fieldSupport,
    reason: queryOn && fieldOn ? "conflicting_support" as const : "unsupported_relation" as const,
  });
}
