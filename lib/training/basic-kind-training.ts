import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  BASIC_KIND_FAMILIES,
  PRIORITY_BASIC_KIND_STAGES,
  classifyBasicKind,
  migrateBasicKindProfile,
  validateBasicKindProfile,
  type BasicKindConfig,
  type BasicKindJudgment,
  type BasicKindLabel,
  type BasicKindProfile,
  type BasicKindStageDecision,
} from "../filters/basic-kinds.js";
import {
  expectArray,
  expectFiniteNumber,
  expectNonEmptyString,
  expectRecord,
  expectStringArray,
} from "../core/schema.js";
import { onlyKeys } from "../filters/sample-match.js";
import {
  BASIC_KIND_LABELS,
  BASIC_KIND_TASK_ID,
  readBasicKindSamples,
  type BasicKindSamples,
  type PreparedBasicKindRow,
} from "./basic-kind-samples.js";
import {
  validateBasicKindTrainingConfig,
  type BasicKindFitTiming,
  type BasicKindTrainingConfig,
  type FitProgress,
} from "./basic-kind-numeric.js";

export interface BasicKindPartitionConfig {
  readonly mode: "source_group_holdout" | "development_only";
  readonly seed: number;
  readonly evalFraction: number;
  readonly allowInSampleEval: boolean;
}

export interface BasicKindSourceCluster {
  readonly clusterId: string;
  readonly rowIndices: readonly number[];
  readonly usage: "train" | "eval" | "development_only";
}

export interface BasicKindPartitions {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly inputScope: BasicKindSamples["inputScope"];
  readonly rows: readonly PreparedBasicKindRow[];
  readonly includedIndices: readonly number[];
  readonly sourceClusters: readonly BasicKindSourceCluster[];
  readonly trainIndices: readonly number[];
  readonly evalIndices: readonly number[];
  readonly evaluationMode: "source_group_holdout" | "development_only_in_sample";
  readonly independentEvaluation: boolean;
  readonly warnings: readonly string[];
}

export type BasicKindPartitionResult =
  | { readonly ok: true; readonly partitions: BasicKindPartitions }
  | { readonly ok: false; readonly reason: string; readonly details: Readonly<Record<string, number | string>> };

export interface BasicKindCandidate {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly candidateId: string;
  readonly baseProfileId: string;
  readonly profile: BasicKindProfile;
  readonly trajectory: readonly FitProgress[];
  readonly timing?: BasicKindFitTiming;
  readonly stoppingReason?: "objective_feasible" | "epoch_limit";
  readonly lossBefore: number;
  readonly lossAfter: number;
  readonly sampleCoverage: {
    readonly trainRows: number;
    readonly labelCounts: Readonly<Partial<Record<BasicKindLabel, number>>>;
  };
}

export type BasicKindTransition = "fixed" | "regressed" | "retained" | "unresolved" | "unassessed";

export interface ComparisonJudgment {
  readonly familyStatus: BasicKindJudgment["familyStatus"];
  readonly family: BasicKindJudgment["family"];
  readonly judgmentStatus: BasicKindJudgment["judgmentStatus"];
  readonly basicKind: BasicKindLabel | null;
  readonly score: number | null;
  readonly margin: number | null;
  readonly path: readonly BasicKindStageDecision[];
}

export interface ComparedBasicKindRow {
  readonly index: number;
  readonly sampleId: string;
  readonly nodeRef: string;
  readonly expectedLabel: BasicKindLabel | null;
  readonly split: "train" | "eval" | null;
  readonly transition: BasicKindTransition;
  readonly old: ComparisonJudgment | null;
  readonly new: ComparisonJudgment | null;
}

export interface ClassMetric {
  readonly support: number;
  readonly predicted: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly uncovered: boolean;
}

export interface BasicKindSplitMetrics {
  readonly eligibleCount: number;
  readonly classMetrics: Readonly<Record<BasicKindLabel, ClassMetric>>;
  readonly transitions: Readonly<Record<BasicKindTransition, number>>;
  readonly otherDistribution: {
    readonly old: number;
    readonly new: number;
    readonly byExpectedLabel: Readonly<Partial<Record<BasicKindLabel, number>>>;
  };
  readonly unknownConflictCounts: {
    readonly old: { readonly unknown: number; readonly conflict: number };
    readonly new: { readonly unknown: number; readonly conflict: number };
  };
}

export interface BasicKindComparison {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly candidate: BasicKindCandidate;
  readonly evaluationMode: BasicKindPartitions["evaluationMode"];
  readonly independentEvaluation: boolean;
  readonly inference: {
    readonly minScore: number;
    readonly minMargin: number;
  };
  readonly rows: readonly ComparedBasicKindRow[];
  readonly splits: {
    readonly train: BasicKindSplitMetrics;
    readonly eval: BasicKindSplitMetrics;
  };
  readonly summary: Readonly<Record<BasicKindTransition, number>>;
}

export interface BasicKindAssessConfig {
  readonly forbidGoldRegression: boolean;
}

export interface BasicKindAssessment {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly candidate: BasicKindCandidate | null;
  readonly comparison: BasicKindComparison | null;
  readonly evidenceInsufficient: boolean;
  readonly independentEvidence: boolean;
  readonly recommendation:
    | "candidate_recommended"
    | "candidate_recommended_with_coverage_limits"
    | "candidate_rejected_regression"
    | "no_observed_improvement"
    | "diagnostic_only"
    | "evidence_insufficient";
  readonly reasons: readonly string[];
}

export interface BasicKindReportConfig {
  readonly weightsDirectory: string;
  readonly resultsDirectory: string;
}

export interface BasicKindTrainingResult {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly runId: string;
  readonly persistStatus: "saved" | "evidence_insufficient";
  readonly reason: string | null;
  readonly weightFileRef: string | null;
  readonly resultFileRef: string;
  readonly candidateProfileId: string | null;
  readonly baseProfileId: string | null;
  readonly candidateAdoption: "not_applied";
  readonly calibrated: false;
  readonly inference: Pick<BasicKindTrainingConfig, "minScore" | "minMargin"> | null;
  readonly evaluationMode: BasicKindPartitions["evaluationMode"] | null;
  readonly recommendation: BasicKindAssessment["recommendation"];
  readonly summary: Readonly<Record<BasicKindTransition, number>>;
  readonly timing?: BasicKindFitTiming;
  readonly stoppingReason?: "objective_feasible" | "epoch_limit";
}

export interface BasicKindArtifactReceipt {
  readonly taskId: string;
  readonly persistStatus: "saved" | "evidence_insufficient";
  readonly weightFileRef: string | null;
  readonly resultFileRef: string;
  readonly candidateProfileId: string | null;
  readonly candidateAdoption: "not_applied";
  readonly calibrated: false;
  readonly summary: Readonly<Record<BasicKindTransition, number>>;
  readonly evaluationMode: BasicKindPartitions["evaluationMode"] | null;
  readonly recommendation: BasicKindAssessment["recommendation"];
}

const LABEL_SET = new Set<BasicKindLabel>(BASIC_KIND_LABELS);
const TRANSITIONS: readonly BasicKindTransition[] = ["fixed", "regressed", "retained", "unresolved", "unassessed"];

function emptyTransitions(): Record<BasicKindTransition, number> {
  return { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 };
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${field} has an invalid value`);
  return value as T;
}

function indexValue(value: unknown, field: string): number {
  const index = expectFiniteNumber(value, field);
  if (!Number.isInteger(index) || index < 0) throw new TypeError(`${field} must be a nonnegative integer`);
  return index;
}

function integer(value: unknown, field: string): number {
  const result = expectFiniteNumber(value, field);
  if (!Number.isInteger(result) || result < 0) throw new TypeError(`${field} must be a nonnegative integer`);
  return result;
}

function nonNegativeFinite(value: unknown, field: string): number {
  const result = expectFiniteNumber(value, field);
  if (result < 0) throw new TypeError(`${field} must be nonnegative`);
  return result;
}

function safeRelativePath(value: unknown, field: string): string {
  const path = expectNonEmptyString(value, field);
  if (isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("\0")) {
    throw new TypeError(`${field} must be a relative local directory`);
  }
  const normalized = resolve("/", path);
  if (normalized === "/" || path.split(/[\\/]+/).includes("..")) throw new TypeError(`${field} cannot escape its allowed root`);
  return path;
}

function within(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("path is outside allowedRoot");
}

export function readBasicKindPartitionConfig(value: unknown): BasicKindPartitionConfig {
  const input = expectRecord(value, "partition config");
  onlyKeys(input, ["mode", "seed", "evalFraction", "allowInSampleEval"], "partition config");
  const seed = expectFiniteNumber(input.seed, "partition config.seed");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new TypeError("partition config.seed must be a uint32");
  const evalFraction = expectFiniteNumber(input.evalFraction, "partition config.evalFraction");
  if (evalFraction <= 0 || evalFraction >= 1) throw new TypeError("partition config.evalFraction must be between 0 and 1");
  if (input.allowInSampleEval !== undefined && typeof input.allowInSampleEval !== "boolean") throw new TypeError("partition config.allowInSampleEval must be boolean");
  return {
    mode: oneOf(input.mode, ["source_group_holdout", "development_only"] as const, "partition config.mode"),
    seed,
    evalFraction,
    allowInSampleEval: input.allowInSampleEval ?? false,
  };
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  add(value: number): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: number): number {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error(`unknown union-find value ${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left), rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    this.parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values], random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

function sourceClusters(rows: readonly PreparedBasicKindRow[], includedIndices: readonly number[]): BasicKindSourceCluster[] {
  const union = new UnionFind(), firstByReference = new Map<string, number>();
  const included = new Set(includedIndices);
  for (let index = 0; index < rows.length; index += 1) union.add(index);
  for (let index = 0; index < rows.length; index += 1) {
    const associations = rows[index]!.sourceAssociations;
    const refs = [
      ...associations.snapshotRefs.map(ref => `snapshot:${ref}`),
      ...associations.postRefs.map(ref => `post:${ref}`),
      ...associations.assetRefs.map(ref => `asset:${ref}`),
    ];
    for (const ref of refs) {
      const first = firstByReference.get(ref);
      if (first === undefined) firstByReference.set(ref, index);
      else union.union(first, index);
    }
  }
  const groups = new Map<number, number[]>();
  for (const index of includedIndices) {
    const root = union.find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }
  return [...groups.values()]
    .sort((left, right) => left[0]! - right[0]!)
    .map((includedRows, index) => {
      const root = union.find(includedRows[0]!);
      const rowIndices = Array.from({ length: rows.length }, (_, rowIndex) => rowIndex)
        .filter(rowIndex => included.has(rowIndex) && union.find(rowIndex) === root);
      return { clusterId: `source-cluster-${index + 1}`, rowIndices, usage: "train" };
    });
}

export function partitionBasicKindSamples(value: unknown, rawConfig: unknown): BasicKindPartitionResult {
  const samples = readBasicKindSamples(value), config = readBasicKindPartitionConfig(rawConfig);
  if (!samples.includedIndices.length) {
    return { ok: false, reason: "no_included_samples", details: { rows: samples.rows.length } };
  }
  const baseClusters = sourceClusters(samples.rows, samples.includedIndices);
  if (config.mode === "development_only" || (config.allowInSampleEval && baseClusters.length < 2)) {
    const indices = [...samples.includedIndices];
    return {
      ok: true,
      partitions: {
        schemaVersion: 1,
        taskId: BASIC_KIND_TASK_ID,
        inputScope: samples.inputScope,
        rows: samples.rows,
        includedIndices: samples.includedIndices,
        sourceClusters: baseClusters.map(cluster => ({ ...cluster, usage: "development_only" })),
        trainIndices: indices,
        evalIndices: indices,
        evaluationMode: "development_only_in_sample",
        independentEvaluation: false,
        warnings: ["development_only_in_sample", "no_independent_validation_claim"],
      },
    };
  }
  if (baseClusters.length < 2) {
    return {
      ok: false,
      reason: "insufficient_independent_source_clusters",
      details: { sourceClusters: baseClusters.length, includedSamples: samples.includedIndices.length },
    };
  }

  const shuffled = shuffle(baseClusters, config.seed);
  const evalCount = Math.max(1, Math.min(shuffled.length - 1, Math.round(shuffled.length * config.evalFraction)));
  const evalClusters = shuffled.slice(0, evalCount), trainClusters = shuffled.slice(evalCount);
  const usage = new Map<string, BasicKindSourceCluster["usage"]>();
  for (const cluster of evalClusters) usage.set(cluster.clusterId, "eval");
  for (const cluster of trainClusters) usage.set(cluster.clusterId, "train");
  const flatten = (clusters: readonly BasicKindSourceCluster[]) =>
    clusters.flatMap(cluster => [...cluster.rowIndices]).sort((left, right) => left - right);
  return {
    ok: true,
    partitions: {
      schemaVersion: 1,
      taskId: BASIC_KIND_TASK_ID,
      inputScope: samples.inputScope,
      rows: samples.rows,
      includedIndices: samples.includedIndices,
      sourceClusters: baseClusters.map(cluster => ({ ...cluster, usage: usage.get(cluster.clusterId)! })),
      trainIndices: flatten(trainClusters),
      evalIndices: flatten(evalClusters),
      evaluationMode: "source_group_holdout",
      independentEvaluation: true,
      warnings: [],
    },
  };
}

export function readBasicKindPartitions(value: unknown): BasicKindPartitions {
  const input = expectRecord(value, "partitions");
  onlyKeys(input, [
    "schemaVersion",
    "taskId",
    "inputScope",
    "rows",
    "includedIndices",
    "sourceClusters",
    "trainIndices",
    "evalIndices",
    "evaluationMode",
    "independentEvaluation",
    "warnings",
  ], "partitions");
  const samples = readBasicKindSamples({
    schemaVersion: input.schemaVersion,
    taskId: input.taskId,
    inputScope: input.inputScope,
    rows: input.rows,
    includedIndices: input.includedIndices,
  });
  const clusters = expectArray(input.sourceClusters, "sourceClusters").map((entry, clusterIndex) => {
    const cluster = expectRecord(entry, `sourceClusters[${clusterIndex}]`);
    onlyKeys(cluster, ["clusterId", "rowIndices", "usage"], `sourceClusters[${clusterIndex}]`);
    return {
      clusterId: expectNonEmptyString(cluster.clusterId, "sourceClusters.clusterId"),
      rowIndices: expectArray(cluster.rowIndices, "sourceClusters.rowIndices").map((item, index) => indexValue(item, `sourceClusters.rowIndices[${index}]`)),
      usage: oneOf(cluster.usage, ["train", "eval", "development_only"] as const, "sourceClusters.usage"),
    };
  });
  const trainIndices = expectArray(input.trainIndices, "trainIndices").map((item, index) => indexValue(item, `trainIndices[${index}]`));
  const evalIndices = expectArray(input.evalIndices, "evalIndices").map((item, index) => indexValue(item, `evalIndices[${index}]`));
  if (typeof input.independentEvaluation !== "boolean") throw new TypeError("independentEvaluation must be boolean");
  const evaluationMode = oneOf(input.evaluationMode, ["source_group_holdout", "development_only_in_sample"] as const, "evaluationMode");
  const included = new Set(samples.includedIndices);
  const seenClusterIds = new Set<string>(), clusteredIndices = new Set<number>();
  for (const cluster of clusters) {
    if (seenClusterIds.has(cluster.clusterId)) throw new TypeError(`duplicate source cluster ${cluster.clusterId}`);
    seenClusterIds.add(cluster.clusterId);
    if (!cluster.rowIndices.length) throw new TypeError(`source cluster ${cluster.clusterId} is empty`);
    for (const index of cluster.rowIndices) {
      if (!included.has(index) || clusteredIndices.has(index)) throw new TypeError("source clusters must partition included rows exactly once");
      clusteredIndices.add(index);
    }
    if (cluster.usage === "development_only" && evaluationMode !== "development_only_in_sample") {
      throw new TypeError("development-only source cluster requires development-only evaluation");
    }
    if (cluster.usage !== "development_only" && evaluationMode === "development_only_in_sample") {
      throw new TypeError("development-only evaluation cannot claim a holdout source cluster");
    }
  }
  if (clusteredIndices.size !== included.size) throw new TypeError("source clusters do not cover all included rows");
  const setFrom = (indices: readonly number[], field: string): Set<number> => {
    const result = new Set<number>();
    for (const index of indices) {
      if (!included.has(index) || result.has(index)) throw new TypeError(`${field} contains an excluded or duplicate index`);
      result.add(index);
    }
    return result;
  };
  const trainSet = setFrom(trainIndices, "trainIndices"), evalSet = setFrom(evalIndices, "evalIndices");
  if (!trainSet.size || !evalSet.size) throw new TypeError("trainIndices and evalIndices must be nonempty");
  if (evaluationMode === "development_only_in_sample") {
    if (input.independentEvaluation) throw new TypeError("development-only partitions cannot claim independent evaluation");
    if (trainIndices.length !== samples.includedIndices.length || evalIndices.length !== samples.includedIndices.length
      || samples.includedIndices.some(index => !trainSet.has(index) || !evalSet.has(index))) {
      throw new TypeError("development-only partitions must replay all included rows");
    }
  } else {
    if (!input.independentEvaluation) throw new TypeError("source-group holdout must claim independent evaluation");
    for (const index of trainSet) if (evalSet.has(index)) throw new TypeError("train and eval partitions overlap");
    if (trainSet.size + evalSet.size !== included.size) throw new TypeError("source-group holdout must partition every included row");
    for (const cluster of clusters) {
      const expected = cluster.usage === "eval" ? evalSet : trainSet;
      if (cluster.rowIndices.some(index => !expected.has(index))) throw new TypeError("source cluster usage disagrees with partition indices");
    }
  }
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    inputScope: samples.inputScope,
    rows: samples.rows,
    includedIndices: samples.includedIndices,
    sourceClusters: clusters,
    trainIndices,
    evalIndices,
    evaluationMode,
    independentEvaluation: input.independentEvaluation,
    warnings: expectStringArray(input.warnings, "warnings"),
  };
}

function readLabelCounts(value: unknown): Partial<Record<BasicKindLabel, number>> {
  const input = expectRecord(value, "labelCounts");
  const result: Partial<Record<BasicKindLabel, number>> = {};
  for (const [label, count] of Object.entries(input)) {
    if (!LABEL_SET.has(label as BasicKindLabel)) throw new TypeError(`unknown labelCounts label ${label}`);
    result[label as BasicKindLabel] = integer(count, `labelCounts.${label}`);
  }
  return result;
}

function readTrajectory(value: unknown): FitProgress[] {
  return expectArray(value, "trajectory").map((entry, index) => {
    const progress = expectRecord(entry, `trajectory[${index}]`);
    onlyKeys(progress, [
      "epoch",
      "totalEpochs",
      "loss",
      "knownLoss",
      "otherLoss",
      "anchorLoss",
      "sampleCount",
      "projectedWeightCount",
    ], `trajectory[${index}]`);
    return {
      epoch: integer(progress.epoch, "trajectory.epoch"),
      totalEpochs: integer(progress.totalEpochs, "trajectory.totalEpochs"),
      loss: nonNegativeFinite(progress.loss, "trajectory.loss"),
      knownLoss: nonNegativeFinite(progress.knownLoss, "trajectory.knownLoss"),
      otherLoss: nonNegativeFinite(progress.otherLoss, "trajectory.otherLoss"),
      anchorLoss: nonNegativeFinite(progress.anchorLoss, "trajectory.anchorLoss"),
      sampleCount: integer(progress.sampleCount, "trajectory.sampleCount"),
      projectedWeightCount: integer(progress.projectedWeightCount, "trajectory.projectedWeightCount"),
    };
  });
}

function readFitTiming(value: unknown): BasicKindFitTiming {
  const input = expectRecord(value, "fit timing");
  onlyKeys(input, [
    "backendLoadMs",
    "circuitBuildMs",
    "baselineEvalMs",
    "trainEpochGradMs",
    "postEpochEvalMs",
    "finalEvalMs",
    "fitTotalMs",
    "completedEpochs",
    "processedRowCount",
    "gradientRowEpochs",
    "totalRowPasses",
    "trainableParamCount",
    "totalSparseCells",
  ], "fit timing");
  return {
    backendLoadMs: nonNegativeFinite(input.backendLoadMs, "fit timing.backendLoadMs"),
    circuitBuildMs: nonNegativeFinite(input.circuitBuildMs, "fit timing.circuitBuildMs"),
    baselineEvalMs: nonNegativeFinite(input.baselineEvalMs, "fit timing.baselineEvalMs"),
    trainEpochGradMs: nonNegativeFinite(input.trainEpochGradMs, "fit timing.trainEpochGradMs"),
    postEpochEvalMs: nonNegativeFinite(input.postEpochEvalMs, "fit timing.postEpochEvalMs"),
    finalEvalMs: nonNegativeFinite(input.finalEvalMs, "fit timing.finalEvalMs"),
    fitTotalMs: nonNegativeFinite(input.fitTotalMs, "fit timing.fitTotalMs"),
    completedEpochs: integer(input.completedEpochs, "fit timing.completedEpochs"),
    processedRowCount: integer(input.processedRowCount, "fit timing.processedRowCount"),
    gradientRowEpochs: integer(input.gradientRowEpochs, "fit timing.gradientRowEpochs"),
    totalRowPasses: integer(input.totalRowPasses, "fit timing.totalRowPasses"),
    trainableParamCount: integer(input.trainableParamCount, "fit timing.trainableParamCount"),
    ...(input.totalSparseCells === undefined ? {} : {
      totalSparseCells: integer(input.totalSparseCells, "fit timing.totalSparseCells"),
    }),
  };
}

export function readBasicKindCandidate(value: unknown): BasicKindCandidate {
  const input = expectRecord(value, "candidate");
  onlyKeys(input, [
    "schemaVersion",
    "taskId",
    "candidateId",
    "baseProfileId",
    "profile",
    "trajectory",
    "lossBefore",
    "lossAfter",
    "sampleCoverage",
    "timing",
    "stoppingReason",
  ], "candidate");
  if (input.schemaVersion !== 1 || input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError("candidate schema/task mismatch");
  const coverage = expectRecord(input.sampleCoverage, "sampleCoverage");
  onlyKeys(coverage, ["trainRows", "labelCounts"], "sampleCoverage");
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidateId: expectNonEmptyString(input.candidateId, "candidateId"),
    baseProfileId: expectNonEmptyString(input.baseProfileId, "baseProfileId"),
    profile: validateBasicKindProfile(input.profile),
    trajectory: readTrajectory(input.trajectory),
    ...(input.stoppingReason === undefined ? {} : { stoppingReason: oneOf(input.stoppingReason, ["objective_feasible", "epoch_limit"] as const, "candidate.stoppingReason") }),
    ...(input.timing === undefined ? {} : { timing: readFitTiming(input.timing) }),
    lossBefore: nonNegativeFinite(input.lossBefore, "lossBefore"),
    lossAfter: nonNegativeFinite(input.lossAfter, "lossAfter"),
    sampleCoverage: {
      trainRows: integer(coverage.trainRows, "sampleCoverage.trainRows"),
      labelCounts: readLabelCounts(coverage.labelCounts),
    },
  };
}

function validateCandidateIdentity(candidate: BasicKindCandidate): void {
  if (candidate.profile.id !== candidate.candidateId) throw new TypeError("candidate profile id must equal candidateId");
}

function inferenceConfig(config: BasicKindTrainingConfig): BasicKindConfig {
  return { taskId: config.taskId, minScore: config.minScore, minMargin: config.minMargin };
}

function comparisonJudgment(judgment: BasicKindJudgment): ComparisonJudgment {
  return {
    familyStatus: judgment.familyStatus,
    family: judgment.family,
    judgmentStatus: judgment.judgmentStatus,
    basicKind: judgment.basicKind,
    score: judgment.score,
    margin: judgment.margin,
    path: judgment.evidence.path,
  };
}

function correct(label: BasicKindLabel, judgment: BasicKindJudgment): boolean {
  return label === "other"
    ? judgment.judgmentStatus === "judged" && judgment.basicKind === "other"
    : judgment.judgmentStatus === "judged" && judgment.basicKind === label;
}

function transition(oldCorrect: boolean, newCorrect: boolean): BasicKindTransition {
  if (oldCorrect && newCorrect) return "retained";
  if (!oldCorrect && newCorrect) return "fixed";
  if (oldCorrect && !newCorrect) return "regressed";
  return "unresolved";
}

function emptyClassMetrics(): Record<BasicKindLabel, ClassMetric> {
  return Object.fromEntries(BASIC_KIND_LABELS.map(label => [label, {
    support: 0,
    predicted: 0,
    precision: null,
    recall: null,
    f1: null,
    uncovered: true,
  }])) as Record<BasicKindLabel, ClassMetric>;
}

function splitMetrics(rows: readonly ComparedBasicKindRow[]): BasicKindSplitMetrics {
  const metrics = emptyClassMetrics(), transitions = emptyTransitions();
  let oldOther = 0, newOther = 0;
  const byExpectedLabel: Partial<Record<BasicKindLabel, number>> = {};
  const oldUnknownConflict = { unknown: 0, conflict: 0 };
  const newUnknownConflict = { unknown: 0, conflict: 0 };
  const truePositive = Object.fromEntries(BASIC_KIND_LABELS.map(label => [label, 0])) as Record<BasicKindLabel, number>;
  for (const row of rows) {
    transitions[row.transition] += 1;
    if (row.expectedLabel === null || row.old === null || row.new === null) continue;
    metrics[row.expectedLabel] = { ...metrics[row.expectedLabel], support: metrics[row.expectedLabel].support + 1 };
    if (row.new.basicKind !== null) {
      metrics[row.new.basicKind] = { ...metrics[row.new.basicKind], predicted: metrics[row.new.basicKind].predicted + 1 };
    }
    if (row.transition === "retained" || row.transition === "fixed") truePositive[row.expectedLabel] += 1;
    if (row.old.basicKind === "other") oldOther += 1;
    if (row.new.basicKind === "other") {
      newOther += 1;
      byExpectedLabel[row.expectedLabel] = (byExpectedLabel[row.expectedLabel] ?? 0) + 1;
    }
    if (row.old.judgmentStatus === "unknown") oldUnknownConflict.unknown += 1;
    if (row.old.judgmentStatus === "conflict") oldUnknownConflict.conflict += 1;
    if (row.new.judgmentStatus === "unknown") newUnknownConflict.unknown += 1;
    if (row.new.judgmentStatus === "conflict") newUnknownConflict.conflict += 1;
  }
  for (const label of BASIC_KIND_LABELS) {
    const metric = metrics[label], tp = truePositive[label];
    const precision = metric.predicted === 0 ? null : tp / metric.predicted;
    const recall = metric.support === 0 ? null : tp / metric.support;
    const f1 = precision === null || recall === null
      ? null
      : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    metrics[label] = { ...metric, precision, recall, f1, uncovered: metric.support === 0 };
  }
  return {
    eligibleCount: rows.filter(row => row.expectedLabel !== null && row.old !== null && row.new !== null).length,
    classMetrics: metrics,
    transitions,
    otherDistribution: { old: oldOther, new: newOther, byExpectedLabel },
    unknownConflictCounts: { old: oldUnknownConflict, new: newUnknownConflict },
  };
}

function readComparisonJudgment(value: unknown): ComparisonJudgment | null {
  if (value === null) return null;
  const input = expectRecord(value, "comparison judgment");
  onlyKeys(input, ["familyStatus", "family", "judgmentStatus", "basicKind", "score", "margin", "path"], "comparison judgment");
  const basicKind = input.basicKind === null ? null : oneOf(input.basicKind, BASIC_KIND_LABELS, "comparison judgment.basicKind");
  const path = expectArray(input.path, "comparison judgment.path").map((entry, index) => {
    const stage = expectRecord(entry, `comparison judgment.path[${index}]`);
    onlyKeys(stage, ["stage", "status", "selected", "score", "margin", "reasons"], `comparison judgment.path[${index}]`);
    return {
      stage: oneOf(stage.stage, [
        "family",
        "leaf",
        ...PRIORITY_BASIC_KIND_STAGES.map(item => item.id),
      ] as const, "path.stage"),
      status: oneOf(stage.status, ["judged", "unknown", "conflict", "skip", "weak"] as const, "path.status"),
      selected: stage.selected === null ? null : expectNonEmptyString(stage.selected, "path.selected"),
      score: expectFiniteNumber(stage.score, "path.score"),
      margin: expectFiniteNumber(stage.margin, "path.margin"),
      reasons: expectStringArray(stage.reasons, "path.reasons"),
    };
  });
  return {
    familyStatus: oneOf(input.familyStatus, ["judged", "unknown", "conflict", "excluded"] as const, "familyStatus"),
    family: input.family === null ? null : oneOf(input.family, Object.keys(BASIC_KIND_FAMILIES) as (keyof typeof BASIC_KIND_FAMILIES)[], "family"),
    judgmentStatus: oneOf(input.judgmentStatus, ["judged", "unknown", "conflict", "excluded"] as const, "judgmentStatus"),
    basicKind,
    score: input.score === null ? null : expectFiniteNumber(input.score, "score"),
    margin: input.margin === null ? null : expectFiniteNumber(input.margin, "margin"),
    path,
  };
}

function readTransition(value: unknown): BasicKindTransition {
  return oneOf(value, TRANSITIONS, "transition");
}

function readTransitionCounts(value: unknown): Record<BasicKindTransition, number> {
  const input = expectRecord(value, "transition counts");
  onlyKeys(input, TRANSITIONS, "transition counts");
  return Object.fromEntries(TRANSITIONS.map(key => [key, integer(input[key], `transition counts.${key}`)])) as Record<BasicKindTransition, number>;
}

function readClassMetrics(value: unknown): Record<BasicKindLabel, ClassMetric> {
  const input = expectRecord(value, "classMetrics");
  onlyKeys(input, BASIC_KIND_LABELS, "classMetrics");
  return Object.fromEntries(BASIC_KIND_LABELS.map(label => {
    const metric = expectRecord(input[label], `classMetrics.${label}`);
    onlyKeys(metric, ["support", "predicted", "precision", "recall", "f1", "uncovered"], `classMetrics.${label}`);
    const nullableMetric = (key: string) => metric[key] === null ? null : expectFiniteNumber(metric[key], `classMetrics.${label}.${key}`);
    if (typeof metric.uncovered !== "boolean") throw new TypeError(`classMetrics.${label}.uncovered must be boolean`);
    return [label, {
      support: integer(metric.support, `classMetrics.${label}.support`),
      predicted: integer(metric.predicted, `classMetrics.${label}.predicted`),
      precision: nullableMetric("precision"),
      recall: nullableMetric("recall"),
      f1: nullableMetric("f1"),
      uncovered: metric.uncovered,
    }];
  })) as Record<BasicKindLabel, ClassMetric>;
}

function readSplitMetrics(value: unknown): BasicKindSplitMetrics {
  const input = expectRecord(value, "split metrics");
  onlyKeys(input, ["eligibleCount", "classMetrics", "transitions", "otherDistribution", "unknownConflictCounts"], "split metrics");
  const other = expectRecord(input.otherDistribution, "otherDistribution");
  onlyKeys(other, ["old", "new", "byExpectedLabel"], "otherDistribution");
  const unknownConflict = expectRecord(input.unknownConflictCounts, "unknownConflictCounts");
  onlyKeys(unknownConflict, ["old", "new"], "unknownConflictCounts");
  const counts = (raw: unknown, field: string) => {
    const entry = expectRecord(raw, field);
    onlyKeys(entry, ["unknown", "conflict"], field);
    return { unknown: integer(entry.unknown, `${field}.unknown`), conflict: integer(entry.conflict, `${field}.conflict`) };
  };
  return {
    eligibleCount: integer(input.eligibleCount, "eligibleCount"),
    classMetrics: readClassMetrics(input.classMetrics),
    transitions: readTransitionCounts(input.transitions),
    otherDistribution: {
      old: integer(other.old, "otherDistribution.old"),
      new: integer(other.new, "otherDistribution.new"),
      byExpectedLabel: readLabelCounts(other.byExpectedLabel),
    },
    unknownConflictCounts: { old: counts(unknownConflict.old, "unknownConflictCounts.old"), new: counts(unknownConflict.new, "unknownConflictCounts.new") },
  };
}

export function readBasicKindComparison(value: unknown): BasicKindComparison {
  const input = expectRecord(value, "comparison");
  onlyKeys(input, ["schemaVersion", "taskId", "candidate", "evaluationMode", "independentEvaluation", "inference", "rows", "splits", "summary"], "comparison");
  if (input.schemaVersion !== 1 || input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError("comparison schema/task mismatch");
  if (typeof input.independentEvaluation !== "boolean") throw new TypeError("comparison.independentEvaluation must be boolean");
  const rows = expectArray(input.rows, "comparison.rows").map((entry, index) => {
    const row = expectRecord(entry, `comparison.rows[${index}]`);
    onlyKeys(row, ["index", "sampleId", "nodeRef", "expectedLabel", "split", "transition", "old", "new"], `comparison.rows[${index}]`);
    return {
      index: indexValue(row.index, "comparison row.index"),
      sampleId: expectNonEmptyString(row.sampleId, "comparison row.sampleId"),
      nodeRef: expectNonEmptyString(row.nodeRef, "comparison row.nodeRef"),
      expectedLabel: row.expectedLabel === null ? null : oneOf(row.expectedLabel, BASIC_KIND_LABELS, "comparison row.expectedLabel"),
      split: row.split === null ? null : oneOf(row.split, ["train", "eval"] as const, "comparison row.split"),
      transition: readTransition(row.transition),
      old: readComparisonJudgment(row.old),
      new: readComparisonJudgment(row.new),
    };
  });
  const splits = expectRecord(input.splits, "comparison.splits");
  onlyKeys(splits, ["train", "eval"], "comparison.splits");
  const inference = expectRecord(input.inference, "comparison.inference");
  onlyKeys(inference, ["minScore", "minMargin"], "comparison.inference");
  const candidate = readBasicKindCandidate(input.candidate);
  validateCandidateIdentity(candidate);
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidate,
    evaluationMode: oneOf(input.evaluationMode, ["source_group_holdout", "development_only_in_sample"] as const, "comparison.evaluationMode"),
    independentEvaluation: input.independentEvaluation,
    inference: {
      minScore: expectFiniteNumber(inference.minScore, "comparison.inference.minScore"),
      minMargin: expectFiniteNumber(inference.minMargin, "comparison.inference.minMargin"),
    },
    rows,
    splits: { train: readSplitMetrics(splits.train), eval: readSplitMetrics(splits.eval) },
    summary: readTransitionCounts(input.summary),
  };
}

export function readBasicKindAssessment(value: unknown): BasicKindAssessment {
  const input = expectRecord(value, "assessment");
  onlyKeys(input, [
    "schemaVersion",
    "taskId",
    "candidate",
    "comparison",
    "evidenceInsufficient",
    "independentEvidence",
    "recommendation",
    "reasons",
  ], "assessment");
  if (input.schemaVersion !== 1 || input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError("assessment schema/task mismatch");
  if (typeof input.evidenceInsufficient !== "boolean" || typeof input.independentEvidence !== "boolean") throw new TypeError("assessment evidence flags must be boolean");
  const candidate = input.candidate === null ? null : readBasicKindCandidate(input.candidate);
  const comparison = input.comparison === null ? null : readBasicKindComparison(input.comparison);
  if (comparison && (!candidate || comparison.candidate.candidateId !== candidate.candidateId)) {
    throw new TypeError("assessment candidate and comparison candidate must agree");
  }
  if (candidate && !comparison) throw new TypeError("candidate assessment requires its comparison");
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidate,
    comparison,
    evidenceInsufficient: input.evidenceInsufficient,
    independentEvidence: input.independentEvidence,
    recommendation: oneOf(input.recommendation, [
      "candidate_recommended",
      "candidate_recommended_with_coverage_limits",
      "candidate_rejected_regression",
      "no_observed_improvement",
      "diagnostic_only",
      "evidence_insufficient",
    ] as const, "assessment.recommendation"),
    reasons: expectStringArray(input.reasons, "assessment.reasons"),
  };
}

export function compareBasicKindCandidates(input: {
  readonly candidate: unknown;
  readonly partitions: unknown;
  readonly baseProfile: unknown;
  readonly config: unknown;
}): BasicKindComparison {
  const candidate = readBasicKindCandidate(input.candidate);
  validateCandidateIdentity(candidate);
  const partitions = readBasicKindPartitions(input.partitions);
  const baseProfile = validateBasicKindProfile(input.baseProfile);
  const config = validateBasicKindTrainingConfig(input.config);
  if (config.taskId !== BASIC_KIND_TASK_ID || candidate.taskId !== partitions.taskId || candidate.baseProfileId !== baseProfile.id) {
    throw new TypeError("candidate, partitions and base profile do not share one training task/run contract");
  }
  const coverage = candidate.sampleCoverage;
  const expectedLabelCounts: Partial<Record<BasicKindLabel, number>> = {};
  for (const index of partitions.trainIndices) {
    const label = partitions.rows[index]!.review.expectedLabel;
    if (label === null) throw new TypeError("training partition contains an unverified label");
    expectedLabelCounts[label] = (expectedLabelCounts[label] ?? 0) + 1;
  }
  if (coverage.trainRows !== partitions.trainIndices.length
    || Object.values(coverage.labelCounts).reduce((sum, count) => sum + (count ?? 0), 0) !== coverage.trainRows) {
    throw new TypeError("candidate sample coverage disagrees with the supplied training partition");
  }
  for (const label of BASIC_KIND_LABELS) {
    if ((coverage.labelCounts[label] ?? 0) !== (expectedLabelCounts[label] ?? 0)) {
      throw new TypeError("candidate label coverage disagrees with the supplied training partition");
    }
  }
  const inference = inferenceConfig(config);
  const trainSet = new Set(partitions.trainIndices), evalSet = new Set(partitions.evalIndices);
  const active = new Set(partitions.includedIndices);
  const rows = partitions.rows.map((row): ComparedBasicKindRow => {
    const expectedLabel = row.review.expectedLabel;
    if (!active.has(row.index)) {
      return {
        index: row.index,
        sampleId: row.sampleId,
        nodeRef: row.inputRef.nodeRef,
        expectedLabel,
        split: null,
        transition: "unassessed",
        old: null,
        new: null,
      };
    }
    const oldJudgment = classifyBasicKind(row.properties, inference, baseProfile);
    const newJudgment = classifyBasicKind(row.properties, inference, candidate.profile);
    if (expectedLabel === null) throw new TypeError("active sample lost its expected label");
    const split = evalSet.has(row.index) ? "eval" : trainSet.has(row.index) ? "train" : null;
    if (split === null) throw new TypeError("active sample is absent from both partitions");
    return {
      index: row.index,
      sampleId: row.sampleId,
      nodeRef: row.inputRef.nodeRef,
      expectedLabel,
      split,
      transition: transition(correct(expectedLabel, oldJudgment), correct(expectedLabel, newJudgment)),
      old: comparisonJudgment(oldJudgment),
      new: comparisonJudgment(newJudgment),
    };
  });
  const trainRows = rows.filter(row => row.split === "train" || (partitions.evaluationMode === "development_only_in_sample" && row.split !== null));
  const evalRows = rows.filter(row => row.split === "eval" || (partitions.evaluationMode === "development_only_in_sample" && row.split !== null));
  const summary = emptyTransitions();
  for (const row of rows) summary[row.transition] += 1;
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidate,
    evaluationMode: partitions.evaluationMode,
    independentEvaluation: partitions.independentEvaluation,
    inference: { minScore: config.minScore, minMargin: config.minMargin },
    rows,
    splits: { train: splitMetrics(trainRows), eval: splitMetrics(evalRows) },
    summary,
  };
}

export function readBasicKindAssessConfig(value: unknown): BasicKindAssessConfig {
  const input = expectRecord(value, "assess config");
  onlyKeys(input, ["forbidGoldRegression"], "assess config");
  if (typeof input.forbidGoldRegression !== "boolean") throw new TypeError("forbidGoldRegression must be boolean");
  return { forbidGoldRegression: input.forbidGoldRegression };
}

function evidenceInsufficientAssessmentForTask(
  taskId: typeof BASIC_KIND_TASK_ID,
  reason: string,
): BasicKindAssessment {
  return { ...evidenceInsufficientAssessment(reason), taskId };
}

export function assessBasicKindComparison(comparison: BasicKindComparison, rawConfig: unknown): BasicKindAssessment {
  const config = readBasicKindAssessConfig(rawConfig);
  const uncovered = BASIC_KIND_LABELS.filter(label => comparison.splits.eval.classMetrics[label].uncovered);
  const reasons: string[] = [];
  let recommendation: BasicKindAssessment["recommendation"];
  if (comparison.evaluationMode === "development_only_in_sample") {
    recommendation = "diagnostic_only";
    reasons.push("development_only_in_sample", "independent_validation_absent");
  } else if (config.forbidGoldRegression && comparison.summary.regressed > 0) {
    recommendation = "candidate_rejected_regression";
    reasons.push("gold_regression_observed");
  } else if (comparison.splits.eval.transitions.fixed > 0) {
    recommendation = uncovered.length ? "candidate_recommended_with_coverage_limits" : "candidate_recommended";
    reasons.push("eval_fixed_cases_present");
  } else {
    recommendation = "no_observed_improvement";
    reasons.push("no_eval_fixed_cases");
  }
  if (uncovered.length) reasons.push("uncovered_eval_classes");
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidate: comparison.candidate,
    comparison,
    evidenceInsufficient: !comparison.independentEvaluation,
    independentEvidence: comparison.independentEvaluation,
    recommendation,
    reasons,
  };
}

export function evidenceInsufficientAssessment(reason: string): BasicKindAssessment {
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    candidate: null,
    comparison: null,
    evidenceInsufficient: true,
    independentEvidence: false,
    recommendation: "evidence_insufficient",
    reasons: [expectNonEmptyString(reason, "reason")],
  };
}

export function readBasicKindReportConfig(value: unknown): BasicKindReportConfig {
  const input = expectRecord(value, "report config");
  onlyKeys(input, ["weightsDirectory", "resultsDirectory"], "report config");
  return {
    weightsDirectory: safeRelativePath(input.weightsDirectory, "weightsDirectory"),
    resultsDirectory: safeRelativePath(input.resultsDirectory, "resultsDirectory"),
  };
}

export function loadTrainingProfiles(input: {
  readonly profileId: string;
  readonly profile: unknown;
}): Readonly<Record<string, BasicKindProfile>> {
  const profileId = expectNonEmptyString(input.profileId, "profileId");
  return { [profileId]: migrateBasicKindProfile(input.profile) };
}

async function ensureDirectory(root: string, relativePath: string): Promise<string> {
  let current = root;
  for (const component of relativePath.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, component);
    within(root, current);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError(`artifact directory component is not a real directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  const actual = await realpath(current);
  within(root, actual);
  return actual;
}

function artifactKey(runId: string): string {
  const key = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "training-run";
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function reportAssessment(
  assessment: BasicKindAssessment,
  weightFileRef: string | null,
): unknown {
  const candidate = assessment.candidate
    ? (() => {
        const { profile: _profile, ...metadata } = assessment.candidate!;
        return {
          ...metadata,
          weightFileRef,
        };
      })()
    : null;
  const comparison = assessment.comparison
    ? (() => {
        const { candidate: comparisonCandidate, ...comparisonMetadata } = assessment.comparison!;
        const { profile: _profile, ...candidateMetadata } = comparisonCandidate;
        return {
          ...comparisonMetadata,
          candidate: {
            ...candidateMetadata,
            weightFileRef,
          },
        };
      })()
    : null;
  return { ...assessment, candidate, comparison, weightFileRef };
}

export function readBasicKindResult(value: unknown): BasicKindTrainingResult {
  const input = expectRecord(value, "training result");
  onlyKeys(input, [
    "schemaVersion",
    "taskId",
    "runId",
    "persistStatus",
    "reason",
    "weightFileRef",
    "resultFileRef",
    "candidateProfileId",
    "baseProfileId",
    "candidateAdoption",
    "calibrated",
    "inference",
    "evaluationMode",
    "recommendation",
    "summary",
    "timing",
    "stoppingReason",
  ], "training result");
  if (input.schemaVersion !== 1 || input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError("training result schema/task mismatch");
  if (input.candidateAdoption !== "not_applied" || input.calibrated !== false) throw new TypeError("training result cannot auto-adopt or claim calibration");
  const inference = input.inference === null
    ? null
    : (() => {
        const raw = expectRecord(input.inference, "training result.inference");
        onlyKeys(raw, ["minScore", "minMargin"], "training result.inference");
        return {
          minScore: expectFiniteNumber(raw.minScore, "training result.inference.minScore"),
          minMargin: expectFiniteNumber(raw.minMargin, "training result.inference.minMargin"),
        };
      })();
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    runId: expectNonEmptyString(input.runId, "training result.runId"),
    persistStatus: oneOf(input.persistStatus, ["saved", "evidence_insufficient"] as const, "training result.persistStatus"),
    reason: input.reason === null ? null : expectNonEmptyString(input.reason, "training result.reason"),
    weightFileRef: input.weightFileRef === null ? null : expectNonEmptyString(input.weightFileRef, "training result.weightFileRef"),
    resultFileRef: expectNonEmptyString(input.resultFileRef, "training result.resultFileRef"),
    candidateProfileId: input.candidateProfileId === null ? null : expectNonEmptyString(input.candidateProfileId, "training result.candidateProfileId"),
    baseProfileId: input.baseProfileId === null ? null : expectNonEmptyString(input.baseProfileId, "training result.baseProfileId"),
    candidateAdoption: "not_applied",
    calibrated: false,
    inference,
    evaluationMode: input.evaluationMode === null
      ? null
      : oneOf(input.evaluationMode, ["source_group_holdout", "development_only_in_sample"] as const, "training result.evaluationMode"),
    recommendation: oneOf(input.recommendation, [
      "candidate_recommended",
      "candidate_recommended_with_coverage_limits",
      "candidate_rejected_regression",
      "no_observed_improvement",
      "diagnostic_only",
      "evidence_insufficient",
    ] as const, "training result.recommendation"),
    summary: readTransitionCounts(input.summary),
    ...(input.stoppingReason === undefined ? {} : { stoppingReason: oneOf(input.stoppingReason, ["objective_feasible", "epoch_limit"] as const, "training result.stoppingReason") }),
    ...(input.timing === undefined ? {} : { timing: readFitTiming(input.timing) }),
  };
}

export async function writeBasicKindTrainingArtifacts(input: {
  readonly allowedRoot: string;
  readonly config: unknown;
  readonly runId: string;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly reason?: string;
  readonly assessment: BasicKindAssessment | null;
  readonly timing?: BasicKindFitTiming;
}): Promise<BasicKindTrainingResult> {
  if (input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError(`taskId must be ${BASIC_KIND_TASK_ID}`);
  const allowedRoot = expectNonEmptyString(input.allowedRoot, "allowedRoot");
  if (!isAbsolute(allowedRoot)) throw new TypeError("allowedRoot must be absolute");
  const config = readBasicKindReportConfig(input.config);
  const runId = expectNonEmptyString(input.runId, "runId");
  const assessment = input.assessment === null
    ? evidenceInsufficientAssessmentForTask(input.taskId, input.reason ?? "evidence_insufficient")
    : readBasicKindAssessment(input.assessment);
  if (assessment.taskId !== input.taskId) throw new TypeError("assessment taskId differs from report request");
  const inference = assessment.comparison?.inference ?? null;
  const timing = input.timing ?? assessment.candidate?.timing;
  const stoppingReason = assessment.candidate?.stoppingReason;
  const root = await realpath(resolve(allowedRoot));
  if (!(await stat(root)).isDirectory()) throw new TypeError("allowedRoot must be an existing directory");
  const weightsDirectory = await ensureDirectory(root, config.weightsDirectory);
  const resultsDirectory = await ensureDirectory(root, config.resultsDirectory);
  const key = artifactKey(runId);
  const weightPath = resolve(weightsDirectory, `${key}.weight.json`);
  const resultPath = resolve(resultsDirectory, `${key}.result.json`);
  within(root, weightPath); within(root, resultPath);

  let weightFileRef: string | null = null;
  if (assessment.candidate) {
    weightFileRef = weightPath;
    await writeNewJson(weightPath, {
      targetOperator: "dom.basic_kinds",
      operatorVersion: "0.1.0",
      contractVersion: assessment.candidate.profile.topology === "priority_staged_v1" ? 2 : 1,
      taskId: assessment.taskId,
      profileId: assessment.candidate.profile.id,
      baseProfileId: assessment.candidate.baseProfileId,
      calibrated: false,
      compatibility: {
        taskId: assessment.taskId,
        ...inference,
      },
      profile: assessment.candidate.profile,
    });
  }

  const summary = assessment.comparison?.summary ?? emptyTransitions();
  const persistStatus = assessment.evidenceInsufficient ? "evidence_insufficient" : "saved";
  const reason = input.reason ?? (persistStatus === "evidence_insufficient" ? assessment.reasons[0] ?? "evidence_insufficient" : null);
  const result: BasicKindTrainingResult = {
    schemaVersion: 1,
    taskId: input.taskId,
    runId,
    persistStatus,
    reason,
    weightFileRef,
    resultFileRef: resultPath,
    candidateProfileId: assessment.candidate?.profile.id ?? null,
    baseProfileId: assessment.candidate?.baseProfileId ?? null,
    candidateAdoption: "not_applied",
    calibrated: false,
    inference,
    evaluationMode: assessment.comparison?.evaluationMode ?? null,
    recommendation: assessment.recommendation,
    summary,
    ...(stoppingReason === undefined ? {} : { stoppingReason }),
    ...(timing === undefined ? {} : { timing }),
  };
  try {
    await writeNewJson(resultPath, {
      schemaVersion: 1,
      taskId: input.taskId,
      runId,
      persistStatus,
      reason,
      calibrated: false,
      candidateAdoption: "not_applied",
      recommendation: assessment.recommendation,
      evaluationMode: assessment.comparison?.evaluationMode ?? null,
      inference: result.inference,
      weightFileRef,
      summary,
      ...(stoppingReason === undefined ? {} : { stoppingReason }),
      ...(timing === undefined ? {} : { timing }),
      assessment: reportAssessment(assessment, weightFileRef),
    });
  } catch (error) {
    const suffix = weightFileRef ? `; weights were already written at ${weightFileRef}` : "";
    throw new Error(`report write failed${suffix}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return readBasicKindResult(result);
}

export const TRAINING_LABELS = BASIC_KIND_LABELS;
export const TRAINING_TRANSITIONS = TRANSITIONS;
export const TRAINING_FAMILIES = BASIC_KIND_FAMILIES;
