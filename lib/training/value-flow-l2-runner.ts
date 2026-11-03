// `nn-code value-flow` H_R training runner skeleton. This file defines the
// fixed 15 -> 16 -> 16 -> 3 model, train/dev-only early stopping, candidate
// locking, new-process reload, and the single-use verification boundary. A
// normal product request never loads this module.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  extractUnreadSearchCandidateFeatures,
  type SearchMatch,
} from "../filters/cli-value-flow-policy.js";
import {
  VALUE_FLOW_FEATURE_NAMES,
  VALUE_FLOW_HR_ARCHITECTURE,
  VALUE_FLOW_HR_PARAMETER_COUNT,
  VALUE_FLOW_LABELS,
  type ValueFlowLabel,
  type ValueFlowPartition,
} from "../adapters/cli/value-flow-contract.js";

export {
  VALUE_FLOW_FEATURE_NAMES,
  VALUE_FLOW_HR_ARCHITECTURE,
  VALUE_FLOW_HR_PARAMETER_COUNT,
  VALUE_FLOW_LABELS,
};
export type { ValueFlowLabel, ValueFlowPartition };

export const VALUE_FLOW_CANDIDATE_SCHEMA = "nnanything.cli-value-flow-l2-candidate.v1" as const;

export type ValueFlowTrainingSample = Readonly<{
  id: string;
  episodeId: string;
  familyId: string;
  partition: ValueFlowPartition;
  direction: "origin" | "sink";
  targetParamIndex: number;
  exportedModulePath: string;
  searchMatch: SearchMatch;
  label: ValueFlowLabel;
  unknownMask: false;
}>;

export type ValueFlowPartitionFamilySource = Readonly<{
  partition: ValueFlowPartition;
  familyIds: readonly string[];
}>;

export type ValueFlowHrCandidate = Readonly<{
  schema: typeof VALUE_FLOW_CANDIDATE_SCHEMA;
  candidateId: string;
  architecture: typeof VALUE_FLOW_HR_ARCHITECTURE;
  featureNames: typeof VALUE_FLOW_FEATURE_NAMES;
  labels: typeof VALUE_FLOW_LABELS;
  parameters: readonly number[];
  calibration: "uncalibrated";
  adoption: "not_applied";
  locked: true;
  verificationEvaluated: false;
}>;

export type ValueFlowPrediction = Readonly<{
  label: ValueFlowLabel;
  probabilities: readonly number[];
  logits: readonly number[];
}>;

export type ValueFlowMetrics = Readonly<{
  count: number;
  loss: number;
  correct: number;
  accuracy: number;
  fullPairwiseCount: number;
  fullPairwiseCorrect: number;
  fullPairwiseAccuracy: number | null;
  crossClusterPairCount: number;
  crossClusterPairCorrect: number;
  crossClusterAccuracy: number | null;
}>;

export const VALUE_FLOW_HOLDS_INDEX = 0 as const;
export const VALUE_FLOW_INSUFFICIENT_INDEX = 1 as const;
export const VALUE_FLOW_REFUTED_INDEX = 2 as const;

export type ValueFlowEarlyStopReport = Readonly<{
  status: "locked" | "gate_failed";
  initialTrainLoss: number;
  initialDevLoss: number;
  bestEpoch: number;
  trainLoss: number;
  devLoss: number;
  trainMetrics: ValueFlowMetrics;
  devMetrics: ValueFlowMetrics;
  gradientProbe: ValueFlowGradientProbeResult;
  gates: Readonly<{
    trainRelativeLoss: boolean;
    trainAbsoluteLoss: boolean;
    devRelativeLoss: boolean;
    devAbsoluteLoss: boolean;
    fullPairwise: boolean;
    passed: boolean;
  }>;
  stopReason: "plateau" | "divergence" | "max_epochs";
  epochsRun: number;
  trajectory: readonly Readonly<{ epoch: number; trainLoss: number; devLoss: number }>[];
  candidatePath: string | null;
  candidate: ValueFlowHrCandidate | null;
}>;

export type ValueFlowAdmissionGates = Readonly<{
  trainRelativeLoss: boolean;
  trainAbsoluteLoss: boolean;
  devRelativeLoss: boolean;
  devAbsoluteLoss: boolean;
  fullPairwise: boolean;
  passed: boolean;
}>;

export type ValueFlowGradientProbeResult = Readonly<{
  parameterIndices: readonly number[];
  maxAbsoluteError: number;
  tolerance: number;
  passed: boolean;
}>;

type Forward = Readonly<{
  a1: readonly number[];
  a2: readonly number[];
  logits: readonly number[];
  probabilities: readonly number[];
}>;

const execFileAsync = promisify(execFile);
const LABEL_INDEX = new Map<ValueFlowLabel, number>(
  VALUE_FLOW_LABELS.map((label, index) => [label, index]),
);
const SAMPLE_KEYS = new Set([
  "id",
  "episodeId",
  "familyId",
  "partition",
  "direction",
  "targetParamIndex",
  "exportedModulePath",
  "searchMatch",
  "label",
  "unknownMask",
]);
const SEARCH_MATCH_KEYS = new Set(["path", "line", "column", "preview"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unread-input leakage field ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  }
}

function readSearchMatch(value: unknown, label: string): SearchMatch {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  exactKeys(value, SEARCH_MATCH_KEYS, label);
  return Object.freeze({
    path: nonEmpty(value.path, `${label}.path`),
    line: nonNegativeInteger(value.line, `${label}.line`),
    column: nonNegativeInteger(value.column, `${label}.column`),
    preview: typeof value.preview === "string" ? value.preview : (() => {
      throw new TypeError(`${label}.preview must be a string`);
    })(),
  });
}

function readSample(value: unknown, index: number): ValueFlowTrainingSample {
  if (!isRecord(value)) throw new TypeError(`sample[${index}] must be an object`);
  exactKeys(value, SAMPLE_KEYS, `sample[${index}]`);
  if (value.partition !== "train" && value.partition !== "dev" && value.partition !== "verification") {
    throw new TypeError(`sample[${index}].partition is invalid`);
  }
  if (value.direction !== "origin" && value.direction !== "sink") {
    throw new TypeError(`sample[${index}].direction is invalid`);
  }
  if (!VALUE_FLOW_LABELS.includes(value.label as ValueFlowLabel)) {
    throw new TypeError(`sample[${index}].label is invalid`);
  }
  if (value.unknownMask !== false) {
    throw new TypeError(`sample[${index}].unknownMask must be false`);
  }
  return Object.freeze({
    id: nonEmpty(value.id, `sample[${index}].id`),
    episodeId: nonEmpty(value.episodeId, `sample[${index}].episodeId`),
    familyId: nonEmpty(value.familyId, `sample[${index}].familyId`),
    partition: value.partition,
    direction: value.direction,
    targetParamIndex: nonNegativeInteger(value.targetParamIndex, `sample[${index}].targetParamIndex`),
    exportedModulePath: nonEmpty(value.exportedModulePath, `sample[${index}].exportedModulePath`),
    searchMatch: readSearchMatch(value.searchMatch, `sample[${index}].searchMatch`),
    label: value.label as ValueFlowLabel,
    unknownMask: false,
  });
}

function readSamples(value: unknown): readonly ValueFlowTrainingSample[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("samples must be a non-empty array");
  const samples = value.map(readSample);
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new TypeError(`duplicate sample id ${sample.id}`);
    ids.add(sample.id);
  }
  return Object.freeze(samples);
}

export function sampleFeatures(sample: ValueFlowTrainingSample): readonly number[] {
  const features = extractUnreadSearchCandidateFeatures(
    sample.direction,
    sample.targetParamIndex,
    sample.exportedModulePath,
    sample.searchMatch,
  );
  if (features.length !== VALUE_FLOW_HR_ARCHITECTURE[0]) {
    throw new Error(`H_R feature extractor returned ${features.length} values`);
  }
  return features;
}

export function verifyNoTeacherAstLeakage(value: unknown): Readonly<{
  sampleCount: number;
  featureCount: typeof VALUE_FLOW_HR_ARCHITECTURE[0];
  unknownMaskAllFalse: true;
}> {
  const samples = readSamples(value);
  for (const sample of samples) sampleFeatures(sample);
  return Object.freeze({
    sampleCount: samples.length,
    featureCount: VALUE_FLOW_HR_ARCHITECTURE[0],
    unknownMaskAllFalse: true,
  });
}

export function verifyDisjointFamilyPartitions(
  value: unknown,
): Readonly<Record<ValueFlowPartition, readonly string[]>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("partition family sources must be a non-empty array");
  }
  const byPartition = new Map<ValueFlowPartition, Set<string>>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) throw new TypeError(`partition source[${index}] must be an object`);
    const keys = Object.keys(raw);
    if (keys.length !== 2 || !keys.includes("partition") || !keys.includes("familyIds")) {
      throw new TypeError(`partition source[${index}] must contain only partition and familyIds`);
    }
    if (raw.partition !== "train" && raw.partition !== "dev" && raw.partition !== "verification") {
      throw new TypeError(`partition source[${index}].partition is invalid`);
    }
    if (byPartition.has(raw.partition)) throw new TypeError(`partition ${raw.partition} is repeated`);
    if (!Array.isArray(raw.familyIds) || raw.familyIds.length === 0) {
      throw new TypeError(`partition source[${index}].familyIds must be non-empty`);
    }
    const families = new Set<string>();
    for (const [familyIndex, familyValue] of raw.familyIds.entries()) {
      const family = nonEmpty(familyValue, `partition source[${index}].familyIds[${familyIndex}]`);
      if (families.has(family)) throw new TypeError(`partition ${raw.partition} repeats family ${family}`);
      families.add(family);
    }
    byPartition.set(raw.partition, families);
  }
  for (const [leftName, left] of byPartition) {
    for (const [rightName, right] of byPartition) {
      if (leftName >= rightName) continue;
      for (const family of left) {
        if (right.has(family)) throw new TypeError(`family ${family} crosses ${leftName}/${rightName}`);
      }
    }
  }
  return Object.freeze({
    train: Object.freeze([...(byPartition.get("train") ?? [])]),
    dev: Object.freeze([...(byPartition.get("dev") ?? [])]),
    verification: Object.freeze([...(byPartition.get("verification") ?? [])]),
  });
}

function parameterOffset(): Readonly<{
  w1: number;
  b1: number;
  w2: number;
  b2: number;
  w3: number;
  b3: number;
}> {
  const [input, hidden1, hidden2, labels] = VALUE_FLOW_HR_ARCHITECTURE;
  const w1 = 0;
  const b1 = w1 + hidden1 * input;
  const w2 = b1 + hidden1;
  const b2 = w2 + hidden2 * hidden1;
  const w3 = b2 + hidden2;
  const b3 = w3 + labels * hidden2;
  return Object.freeze({ w1, b1, w2, b2, w3, b3 });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function initializeParameters(seed: number): Float64Array {
  const random = mulberry32(seed);
  const [input, hidden1, hidden2, labels] = VALUE_FLOW_HR_ARCHITECTURE;
  const parameters = new Float64Array(VALUE_FLOW_HR_PARAMETER_COUNT);
  const offsets = parameterOffset();
  const fill = (start: number, count: number, fanIn: number, fanOut: number): void => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    for (let index = 0; index < count; index += 1) {
      parameters[start + index] = Math.fround((random() * 2 - 1) * limit);
    }
  };
  fill(offsets.w1, hidden1 * input, input, hidden1);
  fill(offsets.b1, hidden1, input, hidden1);
  fill(offsets.w2, hidden2 * hidden1, hidden1, hidden2);
  fill(offsets.b2, hidden2, hidden1, hidden2);
  fill(offsets.w3, labels * hidden2, hidden2, labels);
  fill(offsets.b3, labels, hidden2, labels);
  return parameters;
}

function readParameters(value: unknown): Float64Array {
  if (!Array.isArray(value) || value.length !== VALUE_FLOW_HR_PARAMETER_COUNT) {
    throw new TypeError(`parameters must contain ${VALUE_FLOW_HR_PARAMETER_COUNT} values`);
  }
  return Float64Array.from(value.map((entry, index) => finite(entry, `parameters[${index}]`)));
}

function forward(parameters: ArrayLike<number>, features: readonly number[]): Forward {
  const [input, hidden1, hidden2, labels] = VALUE_FLOW_HR_ARCHITECTURE;
  if (features.length !== input) throw new TypeError(`features must contain ${input} values`);
  const offsets = parameterOffset();
  const z1 = new Array<number>(hidden1).fill(0);
  const a1 = new Array<number>(hidden1).fill(0);
  for (let row = 0; row < hidden1; row += 1) {
    let value = parameters[offsets.b1 + row]!;
    for (let column = 0; column < input; column += 1) {
      value += parameters[offsets.w1 + row * input + column]! * features[column]!;
    }
    z1[row] = value;
    a1[row] = Math.max(0, value);
  }
  const z2 = new Array<number>(hidden2).fill(0);
  const a2 = new Array<number>(hidden2).fill(0);
  for (let row = 0; row < hidden2; row += 1) {
    let value = parameters[offsets.b2 + row]!;
    for (let column = 0; column < hidden1; column += 1) {
      value += parameters[offsets.w2 + row * hidden1 + column]! * a1[column]!;
    }
    z2[row] = value;
    a2[row] = Math.max(0, value);
  }
  const logits = new Array<number>(labels).fill(0);
  let maxLogit = -Infinity;
  for (let row = 0; row < labels; row += 1) {
    let value = parameters[offsets.b3 + row]!;
    for (let column = 0; column < hidden2; column += 1) {
      value += parameters[offsets.w3 + row * hidden2 + column]! * a2[column]!;
    }
    logits[row] = value;
    maxLogit = Math.max(maxLogit, value);
  }
  const exponentials = logits.map(value => Math.exp(value - maxLogit));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  const probabilities = exponentials.map(value => value / denominator);
  return Object.freeze({
    a1: Object.freeze(a1),
    a2: Object.freeze(a2),
    logits: Object.freeze(logits),
    probabilities: Object.freeze(probabilities),
  });
}

function predict(parameters: ArrayLike<number>, features: readonly number[]): ValueFlowPrediction {
  const result = forward(parameters, features);
  let best = 0;
  for (let index = 1; index < result.probabilities.length; index += 1) {
    if (result.probabilities[index]! > result.probabilities[best]!) best = index;
  }
  return Object.freeze({
    label: VALUE_FLOW_LABELS[best]!,
    probabilities: result.probabilities,
    logits: result.logits,
  });
}

function sampleLoss(parameters: ArrayLike<number>, sample: ValueFlowTrainingSample): number {
  const result = forward(parameters, sampleFeatures(sample));
  const probability = result.probabilities[LABEL_INDEX.get(sample.label)!]!;
  return -Math.log(Math.max(Number.MIN_VALUE, probability));
}

function sampleGradient(
  parameters: ArrayLike<number>,
  sample: ValueFlowTrainingSample,
): Float64Array {
  const [input, hidden1, hidden2, labels] = VALUE_FLOW_HR_ARCHITECTURE;
  const features = sampleFeatures(sample);
  const result = forward(parameters, features);
  const offsets = parameterOffset();
  const gradient = new Float64Array(VALUE_FLOW_HR_PARAMETER_COUNT);
  const dlogits = [...result.probabilities];
  const labelIndex = LABEL_INDEX.get(sample.label)!;
  dlogits[labelIndex] = dlogits[labelIndex]! - 1;
  const da2 = new Array<number>(hidden2).fill(0);
  for (let row = 0; row < labels; row += 1) {
    gradient[offsets.b3 + row] = dlogits[row]!;
    for (let column = 0; column < hidden2; column += 1) {
      gradient[offsets.w3 + row * hidden2 + column] = dlogits[row]! * result.a2[column]!;
      da2[column] = da2[column]! + parameters[offsets.w3 + row * hidden2 + column]! * dlogits[row]!;
    }
  }
  const da1 = new Array<number>(hidden1).fill(0);
  for (let row = 0; row < hidden2; row += 1) {
    const dz2 = result.a2[row]! > 0 ? da2[row]! : 0;
    gradient[offsets.b2 + row] = dz2;
    for (let column = 0; column < hidden1; column += 1) {
      gradient[offsets.w2 + row * hidden1 + column] = dz2 * result.a1[column]!;
      da1[column] = da1[column]! + parameters[offsets.w2 + row * hidden1 + column]! * dz2;
    }
  }
  for (let row = 0; row < hidden1; row += 1) {
    const dz1 = result.a1[row]! > 0 ? da1[row]! : 0;
    gradient[offsets.b1 + row] = dz1;
    for (let column = 0; column < input; column += 1) {
      gradient[offsets.w1 + row * input + column] = dz1 * features[column]!;
    }
  }
  return gradient;
}

/**
 * The single fixed evaluator score: `s(c) = P(holds) + 0.5 * P(insufficient)`.
 * It never collapses to an argmax `0/1` label, so two candidates that both
 * predict `holds` but rank differently are compared by their continuous score.
 */
export function computeContinuousRelevanceScore(probabilities: readonly number[]): number {
  if (probabilities.length !== VALUE_FLOW_LABELS.length) {
    throw new TypeError(`probabilities must contain ${VALUE_FLOW_LABELS.length} values`);
  }
  return probabilities[VALUE_FLOW_HOLDS_INDEX]!
    + 0.5 * probabilities[VALUE_FLOW_INSUFFICIENT_INDEX]!;
}

export function evaluateEpisodePairwiseRanking(
  entries: readonly Readonly<{
    episodeId: string;
    label: ValueFlowLabel;
    clusterKey: string;
    relevance: number;
  }>[],
): Readonly<{
  fullPairwiseCount: number;
  fullPairwiseCorrect: number;
  fullPairwiseAccuracy: number | null;
  crossClusterPairCount: number;
  crossClusterPairCorrect: number;
  crossClusterAccuracy: number | null;
}> {
  const byEpisode = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const list = byEpisode.get(entry.episodeId) ?? [];
    list.push(entry);
    byEpisode.set(entry.episodeId, list);
  }
  let fullPairwiseCount = 0;
  let fullPairwiseCorrect = 0;
  let crossClusterPairCount = 0;
  let crossClusterPairCorrect = 0;
  for (const list of byEpisode.values()) {
    const positives = list.filter(entry => entry.label === "holds");
    const negatives = list.filter(entry => entry.label === "refuted");
    for (const positive of positives) {
      for (const negative of negatives) {
        fullPairwiseCount += 1;
        if (positive.relevance > negative.relevance) fullPairwiseCorrect += 1;
        if (positive.clusterKey !== negative.clusterKey) {
          crossClusterPairCount += 1;
          if (positive.relevance > negative.relevance) crossClusterPairCorrect += 1;
        }
      }
    }
  }
  return Object.freeze({
    fullPairwiseCount,
    fullPairwiseCorrect,
    fullPairwiseAccuracy: fullPairwiseCount === 0 ? null : fullPairwiseCorrect / fullPairwiseCount,
    crossClusterPairCount,
    crossClusterPairCorrect,
    crossClusterAccuracy: crossClusterPairCount === 0 ? null : crossClusterPairCorrect / crossClusterPairCount,
  });
}

export function evaluateValueFlowAdmissionGates(
  trainMetrics: ValueFlowMetrics,
  devMetrics: ValueFlowMetrics,
  initialTrainLoss: number,
  initialDevLoss: number,
): ValueFlowAdmissionGates {
  const gates = Object.freeze({
    trainRelativeLoss: trainMetrics.loss <= 0.35 * initialTrainLoss,
    trainAbsoluteLoss: trainMetrics.loss <= 0.35,
    devRelativeLoss: devMetrics.loss <= 0.45 * initialDevLoss,
    devAbsoluteLoss: devMetrics.loss <= 0.40,
    fullPairwise: (devMetrics.fullPairwiseAccuracy ?? 0) >= 0.90,
  });
  return Object.freeze({
    ...gates,
    passed: gates.trainRelativeLoss
      && gates.trainAbsoluteLoss
      && gates.devRelativeLoss
      && gates.devAbsoluteLoss
      && gates.fullPairwise,
  });
}

function batchMetrics(parameters: ArrayLike<number>, samples: readonly ValueFlowTrainingSample[]): ValueFlowMetrics {
  let loss = 0;
  let correct = 0;
  const scored: { episodeId: string; label: ValueFlowLabel; clusterKey: string; relevance: number }[] = [];
  for (const sample of samples) {
    loss += sampleLoss(parameters, sample);
    const features = sampleFeatures(sample);
    const prediction = predict(parameters, features);
    if (prediction.label === sample.label) correct += 1;
    scored.push({
      episodeId: sample.episodeId,
      label: sample.label,
      clusterKey: JSON.stringify(features),
      relevance: computeContinuousRelevanceScore(prediction.probabilities),
    });
  }
  const pairwise = evaluateEpisodePairwiseRanking(scored);
  return Object.freeze({
    count: samples.length,
    loss: loss / samples.length,
    correct,
    accuracy: correct / samples.length,
    ...pairwise,
  });
}

function argmaxIndex(probabilities: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    if (probabilities[index]! > probabilities[best]!) best = index;
  }
  return best;
}

/**
 * Fixed evaluator self-check. It must run before any training so a regression
 * back to argmax `0/1` ranking or cross-episode pairing fails loudly. The three
 * checks mirror `emma-valueflow-r7-ruling.md` ruling 3 and use the same
 * continuous relevance score as `batchMetrics`.
 */
export function verifyEvaluatorContinuousRankingSelfCheck(): Readonly<{
  passed: boolean;
  checks: readonly Readonly<{ id: string; passed: boolean; detail: string }>[];
}> {
  const checks: { id: string; passed: boolean; detail: string }[] = [];

  const strongHolds = [0.9, 0.05, 0.05];
  const weakHolds = [0.55, 0.4, 0.05];
  const strongRefuted = [0.05, 0.35, 0.6];
  const weakRefuted = [0.02, 0.08, 0.9];

  // Check 1: continuous score equals P(holds) + 0.5 * P(insufficient).
  const scoreCheck = Math.abs(computeContinuousRelevanceScore([0.55, 0.05, 0.4]) - 0.575) < 1e-12
    && Math.abs(computeContinuousRelevanceScore([0.51, 0.48, 0.01]) - 0.75) < 1e-12;
  checks.push({
    id: "continuous_relevance_formula",
    passed: scoreCheck,
    detail: "s(c) = P(holds) + 0.5 * P(insufficient)",
  });

  // Check 2: two candidates share the argmax class `holds` yet rank differently.
  // A hard 0/1 evaluator returns a tie; the continuous evaluator ranks them.
  const sameClass = argmaxIndex(strongHolds) === argmaxIndex(weakHolds)
    && argmaxIndex(strongHolds) === VALUE_FLOW_HOLDS_INDEX
    && computeContinuousRelevanceScore(strongHolds) > computeContinuousRelevanceScore(weakHolds);
  checks.push({
    id: "same_predicted_class_continuous_ranking",
    passed: sameClass,
    detail: "two holds predictions ranked by continuous score, not argmax",
  });

  // Check 3: same-episode positive/negative pairing, with equal feature clusters
  // included in the full denominator and excluded from the cross-cluster one.
  const sameEpisode = evaluateEpisodePairwiseRanking([
    { episodeId: "ep", label: "holds", clusterKey: "a", relevance: 0.9 },
    { episodeId: "ep", label: "refuted", clusterKey: "a", relevance: 0.2 },
    { episodeId: "ep", label: "refuted", clusterKey: "b", relevance: 0.4 },
  ]);
  const expectedPairCount = 2;
  const expectedCrossClusterCount = 1;
  checks.push({
    id: "same_episode_pairing",
    passed: sameEpisode.fullPairwiseCount === expectedPairCount
      && sameEpisode.fullPairwiseCorrect === 2
      && sameEpisode.crossClusterPairCount === expectedCrossClusterCount
      && sameEpisode.crossClusterPairCorrect === 1,
    detail: "pairs are formed only inside an episode; equal clusters stay in the full denominator",
  });

  // Check 4: different episodes never pair.
  const crossEpisode = evaluateEpisodePairwiseRanking([
    { episodeId: "ep1", label: "holds", clusterKey: "a", relevance: 0.9 },
    { episodeId: "ep2", label: "refuted", clusterKey: "b", relevance: 0.1 },
  ]);
  checks.push({
    id: "no_cross_episode_pairs",
    passed: crossEpisode.fullPairwiseCount === 0,
    detail: "holds/refuted from different episodes are not paired",
  });

  // Check 5: a reversed continuous order is detected as a failure even when both
  // argmax classes are `holds`.
  const reversed = evaluateEpisodePairwiseRanking([
    { episodeId: "ep", label: "holds", clusterKey: "a", relevance: 0.575 },
    { episodeId: "ep", label: "refuted", clusterKey: "a", relevance: 0.75 },
  ]);
  checks.push({
    id: "reversed_continuous_order_detected",
    passed: reversed.fullPairwiseCount === 1 && reversed.fullPairwiseCorrect === 0,
    detail: "same-argmax-class reversed continuous order is a pairwise failure",
  });

  // Keep the strong refuted/weak refuted probes exercised so a future label
  // index regression (holds <-> refuted) is also caught.
  const refutedOrder = argmaxIndex(strongRefuted) === VALUE_FLOW_REFUTED_INDEX
    && argmaxIndex(weakRefuted) === VALUE_FLOW_REFUTED_INDEX
    && computeContinuousRelevanceScore(strongRefuted) > computeContinuousRelevanceScore(weakRefuted);
  checks.push({
    id: "refuted_class_order",
    passed: refutedOrder,
    detail: "refuted candidates still order by continuous relevance",
  });

  return Object.freeze({
    passed: checks.every(check => check.passed),
    checks: Object.freeze(checks.map(check => Object.freeze(check))),
  });
}

function fullGradient(
  parameters: ArrayLike<number>,
  samples: readonly ValueFlowTrainingSample[],
): Float64Array {
  const gradient = new Float64Array(VALUE_FLOW_HR_PARAMETER_COUNT);
  for (const sample of samples) {
    const current = sampleGradient(parameters, sample);
    for (let index = 0; index < gradient.length; index += 1) {
      gradient[index] = gradient[index]! + current[index]!;
    }
  }
  for (let index = 0; index < gradient.length; index += 1) {
    gradient[index] = gradient[index]! / samples.length;
  }
  return gradient;
}

export function gradientProbe(
  value: unknown,
  options: Readonly<{ seed?: number; step?: number; parameterIndices?: readonly number[] }> = {},
): ValueFlowGradientProbeResult {
  const samples = readSamples(value);
  const train = samples.filter(sample => sample.partition === "train");
  if (train.length === 0) throw new TypeError("gradientProbe requires train samples");
  if (samples.some(sample => sample.partition === "verification")) {
    throw new TypeError("gradientProbe must not access verification samples");
  }
  const seed = options.seed ?? 20261031;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative safe integer");
  const step = options.step ?? 1e-4;
  if (!Number.isFinite(step) || step <= 0) throw new TypeError("step must be positive");
  const parameters = initializeParameters(seed);
  const analytic = fullGradient(parameters, train);
  const indices = options.parameterIndices === undefined
    ? Object.freeze([0, parameterOffset().b3])
    : Object.freeze([...options.parameterIndices]);
  if (indices.length === 0) throw new TypeError("parameterIndices must not be empty");
  let maxAbsoluteError = 0;
  for (const index of indices) {
    nonNegativeInteger(index, "parameter index");
    if (index >= VALUE_FLOW_HR_PARAMETER_COUNT) throw new TypeError("parameter index is out of range");
    const positive = Float64Array.from(parameters);
    const negative = Float64Array.from(parameters);
    positive[index] = positive[index]! + step;
    negative[index] = negative[index]! - step;
    const numeric = (
      train.reduce((sum, sample) => sum + sampleLoss(positive, sample), 0)
      - train.reduce((sum, sample) => sum + sampleLoss(negative, sample), 0)
    ) / (2 * step * train.length);
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(analytic[index]! - numeric));
  }
  const tolerance = 1e-5;
  return Object.freeze({
    parameterIndices: indices,
    maxAbsoluteError,
    tolerance,
    passed: maxAbsoluteError < tolerance,
  });
}

function familySources(...groups: readonly (readonly ValueFlowTrainingSample[])[]): readonly ValueFlowPartitionFamilySource[] {
  const byPartition = new Map<ValueFlowPartition, Set<string>>();
  for (const group of groups) {
    for (const sample of group) {
      const families = byPartition.get(sample.partition) ?? new Set<string>();
      families.add(sample.familyId);
      byPartition.set(sample.partition, families);
    }
  }
  return Object.freeze([...byPartition].map(([partition, families]) => Object.freeze({
    partition,
    familyIds: Object.freeze([...families]),
  })));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function readValueFlowHrCandidate(value: unknown): ValueFlowHrCandidate {
  if (!isRecord(value)) throw new TypeError("candidate must be an object");
  if (value.schema !== VALUE_FLOW_CANDIDATE_SCHEMA) throw new TypeError("candidate schema is invalid");
  if (JSON.stringify(value.architecture) !== JSON.stringify(VALUE_FLOW_HR_ARCHITECTURE)) {
    throw new TypeError("candidate architecture is invalid");
  }
  if (JSON.stringify(value.featureNames) !== JSON.stringify(VALUE_FLOW_FEATURE_NAMES)) {
    throw new TypeError("candidate feature names are invalid");
  }
  if (JSON.stringify(value.labels) !== JSON.stringify(VALUE_FLOW_LABELS)) {
    throw new TypeError("candidate labels are invalid");
  }
  if (value.calibration !== "uncalibrated" || value.adoption !== "not_applied") {
    throw new TypeError("candidate must remain uncalibrated and not_applied");
  }
  if (value.locked !== true || value.verificationEvaluated !== false) {
    throw new TypeError("candidate is not locked for an unseen verification run");
  }
  readParameters(value.parameters);
  return Object.freeze({
    schema: VALUE_FLOW_CANDIDATE_SCHEMA,
    candidateId: nonEmpty(value.candidateId, "candidate.candidateId"),
    architecture: VALUE_FLOW_HR_ARCHITECTURE,
    featureNames: VALUE_FLOW_FEATURE_NAMES,
    labels: VALUE_FLOW_LABELS,
    parameters: Object.freeze([...(value.parameters as readonly number[])]),
    calibration: "uncalibrated",
    adoption: "not_applied",
    locked: true,
    verificationEvaluated: false,
  });
}

export async function loadValueFlowHrCandidate(path: string): Promise<ValueFlowHrCandidate> {
  return readValueFlowHrCandidate(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
}

export function predictValueFlowHrCandidate(
  candidate: ValueFlowHrCandidate,
  features: readonly number[],
): ValueFlowPrediction {
  return predict(readParameters(candidate.parameters), features);
}

export async function trainValueFlowL2WithEarlyStopping(
  input: Readonly<{
    train: unknown;
    dev: unknown;
    candidatePath?: string;
    seed?: number;
    learningRate?: number;
    maxEpochs?: number;
    patience?: number;
    minDelta?: number;
  }>,
): Promise<ValueFlowEarlyStopReport> {
  const train = readSamples(input.train);
  const dev = readSamples(input.dev);
  if (train.some(sample => sample.partition !== "train")) throw new TypeError("train contains non-train samples");
  if (dev.some(sample => sample.partition !== "dev")) throw new TypeError("dev contains non-dev samples");
  verifyNoTeacherAstLeakage(train);
  verifyNoTeacherAstLeakage(dev);
  verifyDisjointFamilyPartitions(familySources(train, dev));
  const evaluatorSelfCheck = verifyEvaluatorContinuousRankingSelfCheck();
  if (!evaluatorSelfCheck.passed) {
    throw new Error(
      `fixed evaluator self-check failed: ${evaluatorSelfCheck.checks.filter(check => !check.passed).map(check => check.id).join(", ")}`,
    );
  }

  const seed = input.seed ?? 20261031;
  const learningRate = input.learningRate ?? 0.05;
  const maxEpochs = input.maxEpochs ?? 200;
  const patience = input.patience ?? 15;
  const minDelta = input.minDelta ?? 1e-4;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative safe integer");
  if (!Number.isFinite(learningRate) || learningRate <= 0) throw new TypeError("learningRate must be positive");
  if (!Number.isSafeInteger(maxEpochs) || maxEpochs < 0) throw new TypeError("maxEpochs must be a non-negative safe integer");
  if (!Number.isSafeInteger(patience) || patience <= 0) throw new TypeError("patience must be a positive safe integer");
  if (!Number.isFinite(minDelta) || minDelta < 0) throw new TypeError("minDelta must be non-negative");

  const probe = gradientProbe(train, { seed });
  if (!probe.passed) throw new Error(`gradient probe failed: ${probe.maxAbsoluteError} >= ${probe.tolerance}`);
  let parameters = initializeParameters(seed);
  const initialTrainLoss = batchMetrics(parameters, train).loss;
  const initialDevLoss = batchMetrics(parameters, dev).loss;
  let bestParameters = Float64Array.from(parameters);
  let bestDevLoss = initialDevLoss;
  let bestEpoch = 0;
  let stopReason: ValueFlowEarlyStopReport["stopReason"] = "max_epochs";
  const trajectory: { epoch: number; trainLoss: number; devLoss: number }[] = [];
  let epochsRun = 0;

  for (let epoch = 0; epoch <= maxEpochs; epoch += 1) {
    const trainMetrics = batchMetrics(parameters, train);
    const devMetrics = batchMetrics(parameters, dev);
    trajectory.push(Object.freeze({ epoch, trainLoss: trainMetrics.loss, devLoss: devMetrics.loss }));
    if (devMetrics.loss < bestDevLoss) {
      bestDevLoss = devMetrics.loss;
      bestEpoch = epoch;
      bestParameters = Float64Array.from(parameters);
    }
    if (epoch === maxEpochs) {
      stopReason = "max_epochs";
      break;
    }
    const reference = trajectory[Math.max(0, trajectory.length - 1 - patience)];
    if (reference !== undefined && epoch > 0 && epoch - reference.epoch >= patience) {
      if (devMetrics.loss > reference.devLoss) stopReason = "divergence";
      else if (reference.devLoss - devMetrics.loss < minDelta) stopReason = "plateau";
    }
    if (stopReason !== "max_epochs") break;

    const gradient = fullGradient(parameters, train);
    for (let index = 0; index < parameters.length; index += 1) {
      parameters[index] = Math.fround(parameters[index]! - learningRate * gradient[index]!);
    }
    if (!parameters.every(Number.isFinite)) throw new Error("training produced non-finite parameters");
    epochsRun = epoch + 1;
  }

  parameters = bestParameters;
  const trainMetrics = batchMetrics(parameters, train);
  const devMetrics = batchMetrics(parameters, dev);
  const gates = Object.freeze({
    trainRelativeLoss: trainMetrics.loss <= 0.35 * initialTrainLoss,
    trainAbsoluteLoss: trainMetrics.loss <= 0.35,
    devRelativeLoss: devMetrics.loss <= 0.45 * initialDevLoss,
    devAbsoluteLoss: devMetrics.loss <= 0.40,
    fullPairwise: (devMetrics.fullPairwiseAccuracy ?? 0) >= 0.90,
    passed: false,
  });
  const admission = evaluateValueFlowAdmissionGates(trainMetrics, devMetrics, initialTrainLoss, initialDevLoss);
  const finalGates = Object.freeze({ ...gates, ...admission });
  const candidate = admission.passed
    ? Object.freeze({
        schema: VALUE_FLOW_CANDIDATE_SCHEMA,
        candidateId: `value-flow-hr-${seed}-${Date.now().toString(36)}`,
        architecture: VALUE_FLOW_HR_ARCHITECTURE,
        featureNames: VALUE_FLOW_FEATURE_NAMES,
        labels: VALUE_FLOW_LABELS,
        parameters: Object.freeze([...parameters]),
        calibration: "uncalibrated" as const,
        adoption: "not_applied" as const,
        locked: true as const,
        verificationEvaluated: false as const,
      })
    : null;
  let candidatePath: string | null = null;
  if (candidate !== null && input.candidatePath !== undefined) {
    candidatePath = resolve(input.candidatePath);
    await writeJsonAtomic(candidatePath, candidate);
  }
  return Object.freeze({
    status: admission.passed ? "locked" : "gate_failed",
    initialTrainLoss,
    initialDevLoss,
    bestEpoch,
    trainLoss: trainMetrics.loss,
    devLoss: devMetrics.loss,
    trainMetrics,
    devMetrics,
    gradientProbe: probe,
    gates: finalGates,
    stopReason,
    epochsRun,
    trajectory: Object.freeze(trajectory),
    candidatePath,
    candidate,
  });
}

async function childPredictions(candidatePath: string, features: readonly (readonly number[])[]): Promise<ValueFlowPrediction[]> {
  const modulePath = fileURLToPath(import.meta.url);
  const script = [
    "const moduleUrl = process.argv[1];",
    "const candidatePath = process.argv[2];",
    "const vectors = JSON.parse(process.argv[3]);",
    "const mod = await import(moduleUrl);",
    "const candidate = await mod.loadValueFlowHrCandidate(candidatePath);",
    "process.stdout.write(JSON.stringify(vectors.map((features) => mod.predictValueFlowHrCandidate(candidate, features))));",
  ].join("\n");
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    pathToFileURL(modulePath).href,
    resolve(candidatePath),
    JSON.stringify(features),
  ], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout) as ValueFlowPrediction[];
}

export async function verifyValueFlowCandidateReloadInNewProcess(
  candidatePath: string,
  featureVectors: readonly (readonly number[])[],
): Promise<Readonly<{ identical: boolean; predictions: readonly ValueFlowPrediction[] }>> {
  if (featureVectors.length === 0) throw new TypeError("featureVectors must not be empty");
  for (const [index, features] of featureVectors.entries()) {
    if (!Array.isArray(features) || features.length !== VALUE_FLOW_HR_ARCHITECTURE[0]) {
      throw new TypeError(`featureVectors[${index}] must contain ${VALUE_FLOW_HR_ARCHITECTURE[0]} values`);
    }
  }
  const candidate = await loadValueFlowHrCandidate(candidatePath);
  const local = featureVectors.map(features => predictValueFlowHrCandidate(candidate, features));
  const child = await childPredictions(candidatePath, featureVectors);
  return Object.freeze({
    identical: JSON.stringify(local) === JSON.stringify(child),
    predictions: Object.freeze(local),
  });
}

export async function evaluateLockedValueFlowCandidateOnce(
  candidatePath: string,
  verification: unknown,
): Promise<Readonly<{ candidate: ValueFlowHrCandidate; metrics: ValueFlowMetrics }>> {
  const samples = readSamples(verification);
  if (samples.some(sample => sample.partition !== "verification")) {
    throw new TypeError("verification evaluation accepts only verification samples");
  }
  verifyNoTeacherAstLeakage(samples);
  const candidate = await loadValueFlowHrCandidate(candidatePath);
  const marker = `${resolve(candidatePath)}.verification.used`;
  const lock = await open(marker, "wx");
  await lock.close();
  return Object.freeze({
    candidate,
    metrics: batchMetrics(readParameters(candidate.parameters), samples),
  });
}
