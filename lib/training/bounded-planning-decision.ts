import {
  PLANNING_DECISION_CONTRACT,
  PLANNING_DECISION_WIRE_SCHEMA_VERSION,
  PLANNING_DECISION_WIRES,
  PlanningDecisionTrainingNotImplementedError,
  type PlanningDecisionBinding,
  type PlanningDecisionHandwiredResources,
  type PlanningDecisionInferenceResources,
  type PlanningDecisionInput,
  type PlanningDecisionInputCandidate,
  type PlanningDecisionProfile,
  type PlanningDecisionTrainingInput,
  type PlanningDecisionTrainingResources,
  type PlanningDecisionUnit,
  type PlanningDecisionWire,
  type PlanningDecisionWeightCandidate,
  type PlanningDecisionReloadResource,
  type PlanningDecisionComparisonResult,
  createPlanningDecisionBinding,
  validatePlanningDecisionInput,
} from "../workflow/recursive-goal/decision-contracts.js";
import {
  readVersionedRef,
  sameVersionedRef,
  type VersionedRef,
} from "../workflow/recursive-goal/planning-contracts.js";
import {
  expectFiniteNumber,
  expectNonEmptyString,
  expectRecord,
  isRecord,
} from "../core/schema.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";
import {
  buildLinearPolicyCircuit,
  type LinearPolicyCircuit,
} from "../nodes/trainable/linear-policy.js";
import type { PathRanking } from "../workflow/recursive-goal/planning-contracts.js";

const PROFILE_KEYS = [
  "contract",
  "providerRef",
  "unitRef",
  "wireSchemaVersion",
  "wires",
  "featureRange",
  "weights",
  "normalization",
  "calibration",
  "adoption",
] as const;

const NORMALIZATION_KEYS = [
  "satisfaction",
  "risk",
  "cost",
  "rankOrder",
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function sameSequence(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new TypeError(`${label} must be exactly ${expected.join(", ")}`);
  }
}

function finiteWeights(value: unknown, length: number, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must contain ${length} finite values`);
  }
  const weights = value.map((entry, index) => {
    const weight = expectFiniteNumber(entry, `${label}[${index}]`);
    if (!Number.isFinite(Math.fround(weight))) {
      throw new TypeError(`${label}[${index}] overflows Float32`);
    }
    return weight;
  });
  return Object.freeze(weights);
}

function readRange(
  value: unknown,
  label: string,
): { readonly min: number; readonly max: number } {
  const range = expectRecord(value, label);
  exactKeys(range, ["min", "max"], label);
  const min = expectFiniteNumber(range.min, `${label}.min`);
  const max = expectFiniteNumber(range.max, `${label}.max`);
  if (min >= max) throw new TypeError(`${label}.min must be below max`);
  return Object.freeze({ min, max });
}

export function validatePlanningDecisionProfile(
  value: unknown,
  label = "planning decision profile",
): PlanningDecisionProfile {
  const profile = expectRecord(value, label);
  exactKeys(profile, PROFILE_KEYS, label);
  if (profile.contract !== PLANNING_DECISION_CONTRACT) {
    throw new TypeError(`${label}.contract must be ${PLANNING_DECISION_CONTRACT}`);
  }
  const providerRef = readVersionedRef(profile.providerRef, `${label}.providerRef`);
  const unitRef = readVersionedRef(profile.unitRef, `${label}.unitRef`);
  if (profile.wireSchemaVersion !== PLANNING_DECISION_WIRE_SCHEMA_VERSION) {
    throw new TypeError(
      `${label}.wireSchemaVersion must be ${PLANNING_DECISION_WIRE_SCHEMA_VERSION}`,
    );
  }
  sameSequence(profile.wires, PLANNING_DECISION_WIRES, `${label}.wires`);
  const featureRange = expectRecord(profile.featureRange, `${label}.featureRange`);
  exactKeys(featureRange, ["min", "max"], `${label}.featureRange`);
  if (featureRange.min !== 0 || featureRange.max !== 1) {
    throw new TypeError(`${label}.featureRange must be [0,1]`);
  }
  const weights = finiteWeights(profile.weights, PLANNING_DECISION_WIRES.length, `${label}.weights`);
  const normalization = expectRecord(profile.normalization, `${label}.normalization`);
  exactKeys(normalization, NORMALIZATION_KEYS, `${label}.normalization`);
  const satisfaction = readRange(normalization.satisfaction, `${label}.normalization.satisfaction`);
  const risk = expectRecord(normalization.risk, `${label}.normalization.risk`);
  exactKeys(risk, ["scaleRef", "maxOrdinal"], `${label}.normalization.risk`);
  const maxOrdinal = expectFiniteNumber(risk.maxOrdinal, `${label}.normalization.risk.maxOrdinal`);
  if (!Number.isInteger(maxOrdinal) || maxOrdinal <= 0) {
    throw new TypeError(
      `${label}.normalization.risk.maxOrdinal must be a positive integer`,
    );
  }
  const cost = expectRecord(normalization.cost, `${label}.normalization.cost`);
  exactKeys(cost, ["unit", "min", "max"], `${label}.normalization.cost`);
  const costUnit = expectNonEmptyString(cost.unit, `${label}.normalization.cost.unit`);
  const costMin = expectFiniteNumber(cost.min, `${label}.normalization.cost.min`);
  const costMax = expectFiniteNumber(cost.max, `${label}.normalization.cost.max`);
  if (costMin < 0 || costMin >= costMax) {
    throw new TypeError(`${label}.normalization.cost.min must be nonnegative and below max`);
  }
  const rankOrder = readRange(normalization.rankOrder, `${label}.normalization.rankOrder`);
  if (rankOrder.min < 0) {
    throw new TypeError(`${label}.normalization.rankOrder.min must be nonnegative`);
  }
  if (profile.calibration !== "uncalibrated") {
    throw new TypeError(`${label}.calibration must be uncalibrated`);
  }
  if (profile.adoption !== "not_applied") {
    throw new TypeError(`${label}.adoption must be not_applied`);
  }
  return Object.freeze({
    contract: PLANNING_DECISION_CONTRACT,
    providerRef,
    unitRef,
    wireSchemaVersion: PLANNING_DECISION_WIRE_SCHEMA_VERSION,
    wires: Object.freeze([...PLANNING_DECISION_WIRES]),
    featureRange: Object.freeze({ min: 0, max: 1 }),
    weights,
    normalization: Object.freeze({
      satisfaction,
      risk: Object.freeze({
        scaleRef: readVersionedRef(risk.scaleRef, `${label}.normalization.risk.scaleRef`),
        maxOrdinal,
      }),
      cost: Object.freeze({ unit: costUnit, min: costMin, max: costMax }),
      rankOrder,
    }),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export interface PlanningDecisionFeatureRow {
  readonly pathId: string;
  readonly values: readonly number[];
  readonly known: readonly boolean[];
  readonly missing: readonly PlanningDecisionWire[];
}

export function extractPlanningDecisionFeatures(
  input: PlanningDecisionInput,
  profile: PlanningDecisionProfile,
  candidate: PlanningDecisionInputCandidate,
): PlanningDecisionFeatureRow {
  const validatedInput = validatePlanningDecisionInput(input);
  const validatedProfile = validatePlanningDecisionProfile(profile);
  const row = validatedInput.candidates.find(item => item.pathId === candidate.pathId);
  if (row === undefined) {
    throw new TypeError(`decision feature extraction requires candidate ${candidate.pathId}`);
  }
  const values: Record<PlanningDecisionWire, number> = {
    "bias": 1,
    "satisfaction.known": 0,
    "satisfaction.value": 0,
    "risk.known": 0,
    "risk.value": 0,
    "cost.known": 0,
    "cost.value": 0,
    "rankOrder.known": 0,
    "rankOrder.value": 0,
    "coverage.covered": row.projection.coverage === "covered" ? 1 : 0,
    "coverage.truncated": row.projection.coverage === "truncated" ? 1 : 0,
    "coverage.unknown": row.projection.coverage === "unknown" ? 1 : 0,
    "prior.deprioritized": validatedInput.priorInfluences.some(
      influence => influence.pathRef === row.pathId,
    )
      ? 1
      : 0,
    "unknown.present":
      row.projection.unknownRefs.length > 0 || validatedInput.unknown.length > 0 ? 1 : 0,
    "preference.score_first": validatedInput.preference.kind === "score_first" ? 1 : 0,
    "preference.order_first": validatedInput.preference.kind === "order_first" ? 1 : 0,
    "preference.conservative": validatedInput.preference.kind === "conservative" ? 1 : 0,
    "preference.aggressive": validatedInput.preference.kind === "aggressive" ? 1 : 0,
  };
  const known: Record<PlanningDecisionWire, boolean> = {
    "bias": true,
    "satisfaction.known": true,
    "satisfaction.value": row.projection.terminalSatisfaction !== null,
    "risk.known": true,
    "risk.value": false,
    "cost.known": true,
    "cost.value": false,
    "rankOrder.known": true,
    "rankOrder.value": row.rankOrder !== null,
    "coverage.covered": true,
    "coverage.truncated": true,
    "coverage.unknown": true,
    "prior.deprioritized": true,
    "unknown.present": true,
    "preference.score_first": true,
    "preference.order_first": true,
    "preference.conservative": true,
    "preference.aggressive": true,
  };

  if (row.projection.terminalSatisfaction !== null) {
    values["satisfaction.value"] = normalizeInRange(
      row.projection.terminalSatisfaction,
      validatedProfile.normalization.satisfaction.min,
      validatedProfile.normalization.satisfaction.max,
      "terminalSatisfaction",
    );
    values["satisfaction.known"] = 1;
  }

  const matchingRisk = row.projection.riskLevels.filter(level =>
    sameVersionedRef(level.scaleRef, validatedProfile.normalization.risk.scaleRef),
  );
  if (matchingRisk.length > 1) {
    throw new TypeError("path projection contains duplicate risk levels for one declared scale");
  }
  if (matchingRisk.length === 1) {
    const risk = matchingRisk[0];
    if (risk === undefined) throw new TypeError("risk level is undefined");
    if (
      !Number.isInteger(risk.ordinal) ||
      risk.ordinal < 0 ||
      risk.ordinal > validatedProfile.normalization.risk.maxOrdinal
    ) {
      throw new TypeError("risk ordinal is outside the declared scale bounds");
    }
    values["risk.known"] = 1;
    values["risk.value"] =
      risk.ordinal / validatedProfile.normalization.risk.maxOrdinal;
    known["risk.value"] = true;
  }

  if (row.projection.maximumCost !== null) {
    if (
      row.projection.costUnit !== validatedProfile.normalization.cost.unit
    ) {
      known["cost.value"] = false;
    } else {
      values["cost.known"] = 1;
      values["cost.value"] = normalizeInRange(
        row.projection.maximumCost,
        validatedProfile.normalization.cost.min,
        validatedProfile.normalization.cost.max,
        "maximumCost",
      );
      known["cost.value"] = true;
    }
  }

  if (row.rankOrder !== null) {
    values["rankOrder.known"] = 1;
    values["rankOrder.value"] = normalizeInRange(
      row.rankOrder,
      validatedProfile.normalization.rankOrder.min,
      validatedProfile.normalization.rankOrder.max,
      "rankOrder",
    );
    known["rankOrder.value"] = true;
  }

  const wireValues = Object.freeze(
    PLANNING_DECISION_WIRES.map(wire => values[wire] ?? 0),
  );
  const wireKnown = Object.freeze(
    PLANNING_DECISION_WIRES.map(wire => known[wire] ?? false),
  );
  const missing = Object.freeze(
    PLANNING_DECISION_WIRES.filter(
      (wire, index) =>
        (validatedProfile.weights[index] ?? 0) !== 0 &&
        !(wireKnown[index] ?? false),
    ),
  );
  return Object.freeze({
    pathId: row.pathId,
    values: wireValues,
    known: wireKnown,
    missing,
  });
}

export function planningDecisionFeatureRows(
  input: PlanningDecisionInput,
  profile: PlanningDecisionProfile,
): readonly PlanningDecisionFeatureRow[] {
  const validated = validatePlanningDecisionInput(input);
  const validatedProfile = validatePlanningDecisionProfile(profile);
  return Object.freeze(
    validated.candidates.map(candidate =>
      extractPlanningDecisionFeatures(validated, validatedProfile, candidate),
    ),
  );
}

export function buildPlanningDecisionCircuit(
  module: HandwiredModule,
  profile: PlanningDecisionProfile,
): LinearPolicyCircuit {
  const validated = validatePlanningDecisionProfile(profile);
  return buildLinearPolicyCircuit(module, 1, validated.wires.length);
}

export interface PlanningDecisionRowEvaluation {
  readonly pathId: string;
  readonly features: readonly number[];
  readonly utility: number;
}

export interface PlanningDecisionEvaluation {
  readonly rows: readonly PlanningDecisionRowEvaluation[];
  readonly ranking: PathRanking;
}

export function evaluatePlanningDecision(
  input: PlanningDecisionInput,
  profile: PlanningDecisionProfile,
  circuit: LinearPolicyCircuit,
): PlanningDecisionEvaluation {
  const validated = validatePlanningDecisionInput(input);
  const validatedProfile = validatePlanningDecisionProfile(profile);
  if (circuit.features.length !== validatedProfile.wires.length) {
    throw new TypeError("planning decision circuit feature count disagrees with profile");
  }
  if (circuit.logits.length !== 1) {
    throw new TypeError("planning decision circuit must expose exactly one utility head");
  }
  if (validated.candidates.length === 0) {
    return {
      rows: Object.freeze([]),
      ranking: {
        kind: "defer",
        missingKeys: ["candidate"],
        reason: "no legal path candidate is available",
      },
    };
  }
  if (validated.candidates.some(candidate => candidate.projection.coverage !== "covered")) {
    return {
      rows: Object.freeze([]),
      ranking: {
        kind: "defer",
        missingKeys: ["coverage"],
        reason: "planning decision requires covered path projections",
      },
    };
  }

  const rows = planningDecisionFeatureRows(validated, validatedProfile);
  const missing = new Set<string>();
  for (const row of rows) {
    for (const wire of row.missing) missing.add(wire);
  }
  if (missing.size > 0) {
    return {
      rows: Object.freeze([]),
      ranking: {
        kind: "defer",
        missingKeys: Object.freeze([...missing]),
        reason: "planning decision features are unknown for a required wire",
      },
    };
  }

  const evaluations = rows.map(row => {
    const source = sourceFor(circuit, validatedProfile.weights, row.values);
    const values = circuit.circuit.evaluateReference(source);
    const logit = values[circuit.logits[0] ?? -1];
    if (logit === undefined || !Number.isFinite(logit)) {
      throw new TypeError("planning decision utility is non-finite");
    }
    return Object.freeze({
      pathId: row.pathId,
      features: row.values,
      utility: logit,
    });
  });
  const sorted = [...evaluations].sort((left, right) => right.utility - left.utility);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.utility === current.utility
    ) {
      return {
        rows: Object.freeze(evaluations),
        ranking: {
          kind: "defer",
          missingKeys: ["utility.tie"],
          reason: "planning decision utilities are tied",
        },
      };
    }
  }
  return {
    rows: Object.freeze(evaluations),
    ranking: {
      kind: "ranked",
      pathRefs: Object.freeze(sorted.map(row => row.pathId)),
    },
  };
}

export function createHandwiredPlanningDecisionUnit(): PlanningDecisionUnit {
  return Object.freeze({
    infer: async (
      input: PlanningDecisionInput,
      resources: PlanningDecisionInferenceResources,
    ) => {
      if (resources.kind !== "planning_decision.handwired.v1") {
        throw new TypeError("handwired planning decision unit requires handwired resources");
      }
      const prepared = readPlanningDecisionHandwiredResources(resources);
      const module = await loadHandwired(prepared.handwiredRoot);
      const circuit = buildPlanningDecisionCircuit(module, prepared.profile);
      return evaluatePlanningDecision(input, prepared.profile, circuit).ranking;
    },
    train: async (
      _input: PlanningDecisionTrainingInput,
      _resources: PlanningDecisionTrainingResources,
    ) => {
      throw new PlanningDecisionTrainingNotImplementedError();
    },
  });
}

export async function preparePlanningDecisionHandwiredResources(
  value: unknown,
): Promise<PlanningDecisionHandwiredResources> {
  const resources = readPlanningDecisionHandwiredResources(value);
  await loadHandwired(resources.handwiredRoot);
  return resources;
}

export function readPlanningDecisionHandwiredResources(
  value: unknown,
): PlanningDecisionHandwiredResources {
  const resources = expectRecord(value, "planning decision handwired resources");
  exactKeys(
    resources,
    ["kind", "profile", "handwiredRoot"],
    "planning decision handwired resources",
  );
  if (resources.kind !== "planning_decision.handwired.v1") {
    throw new TypeError("planning decision handwired resources kind is invalid");
  }
  const profile = validatePlanningDecisionProfile(resources.profile);
  const handwiredRoot = expectNonEmptyString(
    resources.handwiredRoot,
    "planning decision handwired resources.handwiredRoot",
  );
  return Object.freeze({
    kind: "planning_decision.handwired.v1",
    profile,
    handwiredRoot,
  });
}

export async function createHandwiredPlanningDecisionBinding(
  resources: PlanningDecisionHandwiredResources,
): Promise<PlanningDecisionBinding> {
  const prepared = await preparePlanningDecisionHandwiredResources(resources);
  return createPlanningDecisionBinding(
    createHandwiredPlanningDecisionUnit(),
    prepared,
  );
}

/** Explicit candidate resource. Publishing here is not production adoption. */
export function createPlanningDecisionReloadResource(
  handwiredRoot: string,
): PlanningDecisionReloadResource {
  expectNonEmptyString(handwiredRoot, "handwiredRoot");
  let binding: PlanningDecisionBinding | null = null;
  let loading = false;
  const published: VersionedRef[] = [];
  return Object.freeze({
    async reload(candidate: PlanningDecisionWeightCandidate): Promise<VersionedRef> {
      if (loading) throw new Error("reload_in_progress");
      loading = true;
      // A failed attempt must not expose an older candidate as the new version.
      binding = null;
      try {
        const ref = readVersionedRef(candidate.ref, "candidate.ref");
        if (published.some(previous => sameVersionedRef(previous, ref))) {
          throw new TypeError("parameter version ref has already been published");
        }
        const profile = validatePlanningDecisionProfile(candidate.profile);
        const module = await loadHandwired(handwiredRoot);
        const circuit = buildPlanningDecisionCircuit(module, profile);
        binding = Object.freeze({
          ref,
          infer: async (input: PlanningDecisionInput) =>
            evaluatePlanningDecision(input, profile, circuit).ranking,
        });
        published.push(ref);
        return ref;
      } finally {
        loading = false;
      }
    },
    capture(): PlanningDecisionBinding {
      if (loading) throw new Error("reload_in_progress");
      if (binding === null) throw new Error("planning decision candidate is not loaded");
      return binding;
    },
  });
}

/** Numeric counterfactuals only. No executor, observation or adoption authority. */
export async function comparePlanningDecisionCandidates(
  value: PlanningDecisionInput,
  candidates: readonly PlanningDecisionWeightCandidate[],
  handwiredRoot: string,
): Promise<readonly PlanningDecisionComparisonResult[]> {
  const input = validatePlanningDecisionInput(value);
  const refs = candidates.map(candidate => readVersionedRef(candidate.ref, "candidate.ref"));
  if (refs.some((ref, index) => refs.slice(0, index).some(previous => sameVersionedRef(previous, ref)))) {
    throw new TypeError("comparison candidate refs must be unique");
  }
  // Prepare all snapshots before the first await, including per-candidate errors.
  const prepared = candidates.map((candidate, index) => {
    const ref = refs[index]!;
    try {
      return { ref, profile: validatePlanningDecisionProfile(candidate.profile), error: null };
    } catch (error) {
      return { ref, profile: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const results: PlanningDecisionComparisonResult[] = [];
  for (const candidate of prepared) {
    try {
      if (candidate.profile === null) throw new TypeError(candidate.error!);
      const profile = candidate.profile;
      const module = await loadHandwired(handwiredRoot);
      const circuit = buildPlanningDecisionCircuit(module, profile);
      const features = planningDecisionFeatureRows(input, profile);
      const evaluation = evaluatePlanningDecision(input, profile, circuit);
      results.push(Object.freeze({
        kind: "evaluated", ref: candidate.ref, profile,
        rows: Object.freeze(features.map(row => Object.freeze({
          pathId: row.pathId, features: row.values, known: row.known, missing: row.missing,
          utility: evaluation.rows.find(result => result.pathId === row.pathId)?.utility ?? null,
        }))),
        ranking: evaluation.ranking,
      }));
    } catch (error) {
      results.push(Object.freeze({ kind: "error", ref: candidate.ref,
        message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return Object.freeze(results);
}

function normalizeInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} is outside the declared normalization bounds`);
  }
  const normalized = (value - min) / (max - min);
  if (!Number.isFinite(normalized)) {
    throw new TypeError(`${label} cannot be normalized to the declared scale`);
  }
  return normalized;
}

function sourceFor(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  features: readonly number[],
): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, index) => {
    source[wire] = Math.fround(weights[index] ?? 0);
  });
  circuit.features.forEach((wire, index) => {
    source[wire] = Math.fround(features[index] ?? 0);
  });
  return source;
}
