// B-A1 m2 R2: search-input-host usage-relation member fitter.
//
// The member is two linear heads over the 27 declared form features, each closed
// by tanh. This file owns the supervised fit only; the numeric contract, the
// four-state guard and the unmeasured interval rule live in
// adapters/browser/search-input-host-usage-relation.ts.
//
// Why the loss is interval-shaped rather than a plain point margin: an
// unmeasured feature is free in [0, 1] at inference, so a head is only decided
// when every completion agrees. Training the point value would report success at
// a point the inference guard can still abstain on — a train/infer mismatch. The
// fix is to push the positive worst case (lo) and the negative worst case (hi),
// which is the same guard expressed as a margin.
//
// Hyperparameters are not free: they are written once by the independent training
// planner and passed in explicitly. Nothing here defaults them, so a caller
// cannot silently fit with an unapproved budget.

import { expectRecord } from "../../core/schema.js";
import {
  USAGE_FORM_FEATURE_NAMES,
  extractUsageFormFeatures,
  validateUsageTokenTable,
  type UsageFormFeatureName,
  type UsageObservation,
  type UsageTokenTable,
} from "../../adapters/browser/search-input-host-usage-contract.js";
import {
  USAGE_RELATION_BOUNDARY,
  USAGE_RELATION_THRESHOLD,
  validateUsageRelationProfile,
  type UsageRelationProfile,
} from "../../adapters/browser/search-input-host-usage-relation.js";

/** Weights are bounded so one saturated row cannot dominate the fit. */
export const USAGE_RELATION_WEIGHT_BOUND = 8;

/** One supervised row: a real observation plus its independent gold. */
export interface UsageRelationTrainRow {
  readonly id: string;
  readonly observation: UsageObservation;
  /** `ambiguous` is a real gold value but carries no learnable polarity. */
  readonly judgment: "search" | "edit" | "ambiguous";
}

export interface UsageRelationTrainResources {
  readonly tokens: UsageTokenTable;
  /** Written once by the independent planner; never defaulted here. */
  readonly learningRate: number;
  readonly maxEpochs: number;
  readonly margin: number;
  readonly checkpointInterval: number;
}

export interface UsageRelationRowReport {
  readonly id: string;
  readonly judgment: UsageRelationTrainRow["judgment"];
  readonly queryLo: number;
  readonly queryHi: number;
  readonly fieldLo: number;
  readonly fieldHi: number;
  readonly queryViolation: number;
  readonly fieldViolation: number;
  readonly inGradient: boolean;
  readonly undeterminedHead: boolean;
}

export interface UsageRelationTrainResult {
  readonly profile: UsageRelationProfile;
  readonly fit: {
    readonly lossBefore: number;
    readonly lossAfter: number;
    readonly stopEpoch: number | null;
    readonly epochs: number;
    readonly learningRate: number;
    readonly margin: number;
    readonly worstViolation: number;
    readonly positiveRowCount: number;
    readonly negativeRowCount: number;
    readonly excludedRowCount: number;
    readonly boundHitFeatures: readonly string[];
    readonly changedWeightCount: number;
    readonly rows: readonly UsageRelationRowReport[];
  };
}

function softplus(value: number): number {
  return Math.max(value, 0) + Math.log1p(Math.exp(-Math.abs(value)));
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A training row resolved into the 27-dim vector plus its polarity. */
interface PreparedRow {
  readonly id: string;
  readonly judgment: UsageRelationTrainRow["judgment"];
  readonly vector: readonly (boolean | null)[];
  /** Supervised polarity, or null when the row is excluded from the gradient. */
  readonly querySign: 1 | -1 | null;
  readonly fieldSign: 1 | -1 | null;
}

function prepareRow(
  row: UsageRelationTrainRow,
  tokens: UsageTokenTable,
): PreparedRow {
  const features = extractUsageFormFeatures(row.observation, tokens);
  const vector = USAGE_FORM_FEATURE_NAMES.map(name => features[name] ?? null);
  // Multi-label mapping: one gold row teaches both heads, with opposite signs.
  // `ambiguous` is a guard outcome, not a fourth learnable class.
  const querySign = row.judgment === "search" ? 1 : row.judgment === "edit" ? -1 : null;
  const fieldSign = row.judgment === "edit" ? 1 : row.judgment === "search" ? -1 : null;
  return { id: row.id, judgment: row.judgment, vector, querySign, fieldSign };
}

/** Endpoints of one head for one row, under the ruling-3 interval rule. */
function endpoints(weights: readonly number[], vector: readonly (boolean | null)[]) {
  let point = 0;
  let lo = 0;
  let hi = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0;
    const value = vector[index];
    if (value === null || value === undefined) {
      if (weight < 0) lo += weight;
      else if (weight > 0) hi += weight;
      continue;
    }
    const contribution = value ? weight : 0;
    point += contribution;
    lo += contribution;
    hi += contribution;
  }
  return { point, lo, hi };
}

/**
 * Loss and gradient for one head.
 *
 * Class-balanced: the positive and the negative term are each averaged over
 * their own class, so an unbalanced train set cannot be won by predicting the
 * majority class. Both classes must be non-empty; a fit with one class is a
 * construction error and throws rather than quietly fitting a constant.
 */
function headLossAndGradient(
  weights: readonly number[],
  rows: readonly PreparedRow[],
  signOf: (row: PreparedRow) => 1 | -1 | null,
  margin: number,
): { loss: number; gradient: number[] } {
  const positives = rows.filter(row => signOf(row) === 1);
  const negatives = rows.filter(row => signOf(row) === -1);
  if (positives.length === 0 || negatives.length === 0) {
    throw new TypeError(
      `usage relation fit needs both classes, got ${positives.length} positive and ${negatives.length} negative`,
    );
  }
  const gradient = USAGE_FORM_FEATURE_NAMES.map(() => 0);
  let loss = 0;
  const target = USAGE_RELATION_BOUNDARY;

  for (const row of positives) {
    const { lo } = endpoints(weights, row.vector);
    const violation = margin + target - lo;
    loss += softplus(violation) / positives.length;
    const slope = sigmoid(violation) / positives.length;
    for (let index = 0; index < weights.length; index += 1) {
      const weight = weights[index] ?? 0;
      const value = row.vector[index];
      if (value === null || value === undefined) {
        // d(lo)/dw is 1 only when the weight is already negative; at zero it is 0,
        // so an unmeasured feature at zero weight stays zero and never becomes an
        // actual dependency by accident.
        if (weight < 0) gradient[index]! -= slope;
        continue;
      }
      if (value) gradient[index]! -= slope;
    }
  }

  for (const row of negatives) {
    const { hi } = endpoints(weights, row.vector);
    const violation = margin + hi - target;
    loss += softplus(violation) / negatives.length;
    const slope = sigmoid(violation) / negatives.length;
    for (let index = 0; index < weights.length; index += 1) {
      const weight = weights[index] ?? 0;
      const value = row.vector[index];
      if (value === null || value === undefined) {
        if (weight > 0) gradient[index]! += slope;
        continue;
      }
      if (value) gradient[index]! += slope;
    }
  }

  return { loss, gradient };
}

function worstViolationOf(
  queryWeights: readonly number[],
  fieldWeights: readonly number[],
  rows: readonly PreparedRow[],
  margin: number,
): number {
  let worst = 0;
  for (const row of rows) {
    const query = endpoints(queryWeights, row.vector);
    const field = endpoints(fieldWeights, row.vector);
    if (row.querySign === 1) worst = Math.max(worst, margin + USAGE_RELATION_BOUNDARY - query.lo);
    if (row.querySign === -1) worst = Math.max(worst, margin + query.hi - USAGE_RELATION_BOUNDARY);
    if (row.fieldSign === 1) worst = Math.max(worst, margin + USAGE_RELATION_BOUNDARY - field.lo);
    if (row.fieldSign === -1) worst = Math.max(worst, margin + field.hi - USAGE_RELATION_BOUNDARY);
  }
  return worst;
}

export function trainUsageRelation(
  input: { readonly rows: readonly UsageRelationTrainRow[] },
  resources: UsageRelationTrainResources,
): UsageRelationTrainResult {
  const tokens = validateUsageTokenTable(resources.tokens);
  const { learningRate, maxEpochs, margin, checkpointInterval } = resources;
  for (const [label, value] of [
    ["learningRate", learningRate], ["maxEpochs", maxEpochs],
    ["margin", margin], ["checkpointInterval", checkpointInterval],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`usage relation ${label} must be finite`);
    }
  }
  if (maxEpochs < 1 || checkpointInterval < 1) {
    throw new TypeError("usage relation budget and checkpoint interval must be positive");
  }
  const rows = input.rows.map(row => prepareRow(expectRecord(row, "usage relation train row") as
    unknown as UsageRelationTrainRow, tokens));
  if (rows.length === 0) throw new TypeError("usage relation fit needs at least one row");

  let queryWeights = USAGE_FORM_FEATURE_NAMES.map(() => 0);
  let fieldWeights = USAGE_FORM_FEATURE_NAMES.map(() => 0);
  const lossAt = (q: readonly number[], f: readonly number[]) => headLossAndGradient(q, rows, r => r.querySign, margin).loss
    + headLossAndGradient(f, rows, r => r.fieldSign, margin).loss;
  const lossBefore = lossAt(queryWeights, fieldWeights);

  let stopEpoch: number | null = null;
  let epoch = 0;
  while (epoch < maxEpochs) {
    const query = headLossAndGradient(queryWeights, rows, r => r.querySign, margin);
    const field = headLossAndGradient(fieldWeights, rows, r => r.fieldSign, margin);
    queryWeights = queryWeights.map((weight, index) => clamp(weight - learningRate * query.gradient[index]!, -USAGE_RELATION_WEIGHT_BOUND, USAGE_RELATION_WEIGHT_BOUND));
    fieldWeights = fieldWeights.map((weight, index) => clamp(weight - learningRate * field.gradient[index]!, -USAGE_RELATION_WEIGHT_BOUND, USAGE_RELATION_WEIGHT_BOUND));
    epoch += 1;
    for (const weight of [...queryWeights, ...fieldWeights]) {
      if (!Number.isFinite(weight)) throw new TypeError("usage relation fit produced a non-finite weight");
    }
    if (epoch % checkpointInterval === 0 && worstViolationOf(queryWeights, fieldWeights, rows, margin) <= 0) {
      stopEpoch = epoch;
      break;
    }
  }

  const profile = validateUsageRelationProfile({
    contract: "browser.search-input-usage-relation.v1",
    features: [...USAGE_FORM_FEATURE_NAMES],
    queryWeights,
    fieldWeights,
    threshold: USAGE_RELATION_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });

  const reports: UsageRelationRowReport[] = rows.map(row => {
    const query = endpoints(queryWeights, row.vector);
    const field = endpoints(fieldWeights, row.vector);
    const queryViolation = row.querySign === 1 ? margin + USAGE_RELATION_BOUNDARY - query.lo
      : row.querySign === -1 ? margin + query.hi - USAGE_RELATION_BOUNDARY : 0;
    const fieldViolation = row.fieldSign === 1 ? margin + USAGE_RELATION_BOUNDARY - field.lo
      : row.fieldSign === -1 ? margin + field.hi - USAGE_RELATION_BOUNDARY : 0;
    return {
      id: row.id,
      judgment: row.judgment,
      queryLo: query.lo,
      queryHi: query.hi,
      fieldLo: field.lo,
      fieldHi: field.hi,
      queryViolation,
      fieldViolation,
      inGradient: row.querySign !== null,
      undeterminedHead: query.lo < USAGE_RELATION_BOUNDARY && query.hi >= USAGE_RELATION_BOUNDARY
        || field.lo < USAGE_RELATION_BOUNDARY && field.hi >= USAGE_RELATION_BOUNDARY,
    };
  });

  const boundHit: UsageFormFeatureName[] = [];
  USAGE_FORM_FEATURE_NAMES.forEach((name, index) => {
    if (Math.abs(queryWeights[index]!) >= USAGE_RELATION_WEIGHT_BOUND
      || Math.abs(fieldWeights[index]!) >= USAGE_RELATION_WEIGHT_BOUND) boundHit.push(name);
  });

  return {
    profile,
    fit: {
      lossBefore,
      lossAfter: lossAt(queryWeights, fieldWeights),
      stopEpoch,
      epochs: epoch,
      learningRate,
      margin,
      worstViolation: worstViolationOf(queryWeights, fieldWeights, rows, margin),
      positiveRowCount: rows.filter(row => row.judgment === "search").length,
      negativeRowCount: rows.filter(row => row.judgment === "edit").length,
      excludedRowCount: rows.filter(row => row.judgment === "ambiguous").length,
      boundHitFeatures: Object.freeze(boundHit),
      changedWeightCount: [...queryWeights, ...fieldWeights].filter(weight => weight !== 0).length,
      rows: Object.freeze(reports),
    },
  };
}
