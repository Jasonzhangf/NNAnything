// B-A1 fixed training entry: `trainBA1UnifiedRelationDecision`
// (design: b-a1-fixed-training-entry-design.md, subject revision 3).
//
// This entry implements the fixed B-A1 route:
//   - route/encoder = browser / R / nnanything.browser.b-a1-search-input-host.encoder.v1
//   - loss           = absolute-threshold soft-margin group loss (b-a1-group-loss)
//   - optimizer      = full_batch_sgd, lr 0.01, maxEpochs 200, seed 20261104, xavier_uniform
//
// Package and checkpoint artifacts use the shared unified route-aware schemas.
// Nothing here adopts a package, trains against gold, or wires into a product entry.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertUnifiedTensors,
  cloneTensors,
  createXavierTensors,
  type MutableUnifiedTensors,
  type UnifiedTensors,
} from "./unified-forward.js";
import type { EncodedCandidate, EncodedGroup } from "./group-loss.js";
import {
  BA1_LOSS_KIND,
  BA1_MARGIN,
  BA1_THETA,
  BA1GroupLossError,
  BA1NonFiniteLossError,
  bA1FullBatchEpochStep,
  bA1ParameterLoss,
  bA1ThresholdDiagnosis,
} from "./b-a1-group-loss.js";
import {
  BA1_ARCHITECTURE,
  BA1_ENCODER_VERSION,
  BA1_INPUT_SCHEMA,
  BA1_ROUTE_DECISION_KIND,
  BA1_ROUTE_DOMAIN,
  BA1_RESERVED_SLOTS,
  BA1_SLOT_CONTRACT,
  assertBA1EncodedRouteGroup,
} from "./b-a1-route-encoder.js";
import { validateMissingModeConsistency } from "./unified-missing-mode.js";
import {
  createUnifiedModelPackage,
  loadUnifiedModelPackageFromFile,
  saveUnifiedModelPackageAtomic,
  type UnifiedModelPackage,
  type UnifiedModelPackageResource,
  type UnifiedModelPackageResources,
} from "./unified-model-package.js";
import {
  createUnifiedTrainingCheckpoint,
  saveUnifiedTrainingCheckpointAtomicWithTiming,
  verifyUnifiedTrainingCheckpointReload,
  type UnifiedTrainingCheckpoint,
  type UnifiedTrainingCheckpointReloadReceipt,
  type UnifiedWarmStartLineage,
} from "./unified-training-checkpoint.js";
import {
  UNIFIED_TRAIN_CONFIG_SCHEMA,
  checkWarmStartEpochZeroEquality,
  verifyUnifiedTrainPackageReload,
  type UnifiedPackageReloadReceipt,
  type UnifiedTrainConfig,
  type UnifiedWarmStartSource,
} from "./unified-train-config.js";
import {
  addCheckpointIoTiming,
  addPackageReloadSeconds,
  emptyCheckpointIoTiming,
  monotonicSeconds,
  type UnifiedPersistedTiming,
  type UnifiedThisRunTiming,
} from "./unified-timing.js";
import {
  BA1_SEMANTIC_SUPERVISION_STATUSES,
  classifyBA1TrainingEligibility,
  type BA1SemanticSupervisionStatus,
  type BA1SampleFamily,
} from "./b-a1-sample-evaluator-skeleton.js";
import {
  validateMissingModeTable,
} from "./unified-thresholds.js";

const execFileAsync = promisify(execFile);

export const BA1_TRAIN_CONFIG_SCHEMA = "nnanything.b-a1-unified.train-config.v1" as const;
export const BA1_STUDENT_ROW_SCHEMA = "nnanything.b-a1-unified.student-row.v1" as const;
export const BA1_SUPERVISION_ROW_SCHEMA = "nnanything.b-a1-unified.supervision-row.v1" as const;

export const BA1_LEARNING_RATE = 0.01;
export const BA1_MAX_EPOCHS = 200;
export const BA1_SEED = 20261104;

export type BA1StopReason = "epoch_limit_exhausted" | "non_finite" | "data_invalid";

export interface BA1TrainResources {
  readonly thresholdsRef: string;
  readonly thresholdsSchema: "nnanything.feature-thresholds.v1";
  readonly missingModeTableRef: string;
  readonly missingModeSchema: "nnanything.unified.missing-mode.v1";
  readonly slotMapRef: string;
}

export interface BA1TrainConfig {
  readonly schema: typeof BA1_TRAIN_CONFIG_SCHEMA;
  readonly route: { readonly domain: typeof BA1_ROUTE_DOMAIN; readonly decisionKind: typeof BA1_ROUTE_DECISION_KIND };
  readonly inputSchema: typeof BA1_INPUT_SCHEMA;
  readonly encoderVersion: typeof BA1_ENCODER_VERSION;
  readonly architecture: typeof BA1_ARCHITECTURE;
  readonly loss: { readonly kind: typeof BA1_LOSS_KIND; readonly theta: number; readonly margin: number };
  readonly optimizer: "full_batch_sgd";
  readonly learningRate: number;
  readonly maxEpochs: number;
  readonly seed: number;
  readonly init: "xavier_uniform";
  readonly resources: BA1TrainResources;
  readonly modelId: string;
  readonly version: string;
  /** Synthetic numeric tests may opt out of the fixed recipe; production runs use the default strict recipe. */
  readonly fixedRecipe?: boolean;
}

export interface BA1StudentCandidateRow {
  readonly candidateRef: string;
  readonly x: readonly number[];
  readonly missingMode: readonly unknown[];
  readonly optionSemantics: string;
  readonly candidateKind: string;
}

export interface BA1StudentGroup {
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: string;
  readonly family: BA1SampleFamily;
  readonly candidates: readonly BA1StudentCandidateRow[];
}

export interface BA1SupervisionRow {
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: string;
  readonly supervisionStatus: BA1SemanticSupervisionStatus;
  readonly goldAllowedCandidateRefs: readonly string[];
  readonly trainingEligible: boolean;
  readonly evaluationClass: string;
  readonly family: BA1SampleFamily;
}

export class BA1TrainDataError extends Error {
  readonly code = "DATA_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "BA1TrainDataError";
  }
}

export type BA1WarmStartErrorCode =
  | "WARMSTART_PATH_CONFLICT"
  | "WARMSTART_SOURCE_INVALID"
  | "WARMSTART_SOURCE_INCOMPATIBLE";

export class BA1WarmStartError extends Error {
  readonly code: BA1WarmStartErrorCode;
  readonly optimizerSteps = 0 as const;

  constructor(code: BA1WarmStartErrorCode, message: string) {
    super(message);
    this.name = "BA1WarmStartError";
    this.code = code;
  }
}

export interface BA1TrainEpochRecord {
  readonly epoch: number;
  readonly epochLoss: number;
  readonly finite: boolean;
  readonly maxAbsGrad: number;
}

export interface BA1TrainReport {
  readonly schema: "nnanything.b-a1-unified.train-report.v1";
  readonly status: "completed" | "failed" | "DATA_INVALID";
  readonly stopReason: BA1StopReason;
  readonly completedEpochs: number;
  readonly lossKind: typeof BA1_LOSS_KIND;
  readonly theta: number;
  readonly margin: number;
  readonly groupCount: number;
  readonly lossGoal: "all eligible TRAIN groups margin_satisfied";
  readonly groupMarginSatisfiedCount: number;
  readonly groupDecisionSatisfiedCount: number;
  readonly not_converged: boolean;
  readonly initialLoss: number | null;
  readonly finalLoss: number | null;
  readonly epochs: readonly BA1TrainEpochRecord[];
  readonly violations: readonly string[];
}

export type BA1ModelPackage = UnifiedModelPackage;
export type BA1TrainingCheckpoint = UnifiedTrainingCheckpoint;

export interface BA1PackageReloadReceipt extends UnifiedPackageReloadReceipt {
  readonly route: { readonly domain: string; readonly decisionKind: string };
  readonly encoderVersion: string;
  readonly resourcesMatch: boolean;
  readonly resourceFilesRead: boolean;
  readonly resourceContentValidated: boolean;
  readonly newProcessVerified: boolean;
}

export interface BA1TrainReceipt {
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly packageOutPath: string;
  readonly checkpointOutPath: string | null;
  readonly packageReload: BA1PackageReloadReceipt;
  readonly checkpointReload: UnifiedTrainingCheckpointReloadReceipt | null;
  readonly timing: UnifiedThisRunTiming;
}

export interface BA1TrainResult {
  readonly report: BA1TrainReport;
  readonly package: BA1ModelPackage;
  readonly receipt: BA1TrainReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BA1TrainDataError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireKnownSupervisionStatus(value: unknown, groupId: string): BA1SemanticSupervisionStatus {
  if (
    typeof value !== "string"
    || !(BA1_SEMANTIC_SUPERVISION_STATUSES as readonly string[]).includes(value)
  ) {
    throw new BA1TrainDataError(`supervision row ${groupId} has unknown supervisionStatus=${String(value)}`);
  }
  return value as BA1SemanticSupervisionStatus;
}

function requireKnownSampleFamily(value: unknown, label: string): BA1SampleFamily {
  if (
    value !== "model-semantic"
    && value !== "contract-gate"
    && value !== "aggregator-test"
  ) {
    throw new BA1TrainDataError(`${label} must be model-semantic, contract-gate, or aggregator-test; got ${String(value)}`);
  }
  return value;
}

export function validateBA1TrainConfig(config: BA1TrainConfig): void {
  if (config.schema !== BA1_TRAIN_CONFIG_SCHEMA) throw new TypeError("B-A1 train config schema mismatch");
  if (config.route.domain !== BA1_ROUTE_DOMAIN || config.route.decisionKind !== BA1_ROUTE_DECISION_KIND) {
    throw new TypeError(`B-A1 route must be ${BA1_ROUTE_DOMAIN}/${BA1_ROUTE_DECISION_KIND}`);
  }
  if (config.inputSchema !== BA1_INPUT_SCHEMA) throw new TypeError(`inputSchema must be ${BA1_INPUT_SCHEMA}`);
  if (config.encoderVersion !== BA1_ENCODER_VERSION) {
    throw new TypeError(`encoderVersion must be ${BA1_ENCODER_VERSION}; the generic step encoder is not compatible`);
  }
  if (
    config.architecture.input !== 64
    || config.architecture.output !== 1
    || config.architecture.activation !== "relu"
    || config.architecture.hidden[0] !== 64
    || config.architecture.hidden[1] !== 64
  ) {
    throw new TypeError("B-A1 architecture must be 64/64x64/1 relu");
  }
  if (
    config.loss.kind !== BA1_LOSS_KIND
    || config.loss.theta !== BA1_THETA
    || config.loss.margin !== BA1_MARGIN
  ) {
    throw new TypeError(`B-A1 loss must be ${BA1_LOSS_KIND} with theta=${BA1_THETA}, margin=${BA1_MARGIN}`);
  }
  if (config.optimizer !== "full_batch_sgd") throw new TypeError("optimizer must be full_batch_sgd");
  if (config.init !== "xavier_uniform") throw new TypeError("init must be xavier_uniform");
  if (config.fixedRecipe !== false) {
    if (config.learningRate !== BA1_LEARNING_RATE) {
      throw new TypeError(`learningRate must be the fixed value ${BA1_LEARNING_RATE}`);
    }
    if (config.maxEpochs !== BA1_MAX_EPOCHS) {
      throw new TypeError(`maxEpochs must be the fixed value ${BA1_MAX_EPOCHS}`);
    }
    if (config.seed !== BA1_SEED) throw new TypeError(`seed must be the fixed value ${BA1_SEED}`);
  } else {
    if (!Number.isFinite(config.learningRate) || config.learningRate <= 0) {
      throw new TypeError("synthetic learningRate must be positive and finite");
    }
    if (!Number.isInteger(config.maxEpochs) || config.maxEpochs <= 0) {
      throw new TypeError("synthetic maxEpochs must be a positive integer");
    }
    if (!Number.isInteger(config.seed)) throw new TypeError("synthetic seed must be an integer");
  }
  if (typeof config.modelId !== "string" || config.modelId.length === 0) throw new TypeError("modelId must be a non-empty string");
  if (typeof config.version !== "string" || config.version.length === 0) throw new TypeError("version must be a non-empty string");
  for (const key of ["thresholdsRef", "missingModeTableRef", "slotMapRef"] as const) {
    const ref = config.resources[key];
    if (typeof ref !== "string" || ref.length === 0) throw new TypeError(`resources.${key} must be a non-empty string`);
  }
  if (config.resources.thresholdsSchema !== "nnanything.feature-thresholds.v1") {
    throw new TypeError("resources.thresholdsSchema must be nnanything.feature-thresholds.v1");
  }
  if (config.resources.missingModeSchema !== "nnanything.unified.missing-mode.v1") {
    throw new TypeError("resources.missingModeSchema must be nnanything.unified.missing-mode.v1");
  }
}

function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line) as unknown);
}

const FORBIDDEN_STUDENT_FIELD_PATTERN = /^(?:gold|allowed|teacher|label|oracle|unknownReason)/i;

function forbiddenStudentFields(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).filter(field => FORBIDDEN_STUDENT_FIELD_PATTERN.test(field));
}

function forbiddenSupervisionFields(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).filter(field => field === "x" || field === "input");
}

export async function loadBA1StudentRowsFile(rowsPath: string): Promise<readonly BA1StudentGroup[]> {
  const records = parseJsonl(await readFile(rowsPath, "utf8"));
  const groups = new Map<string, {
    group_id: string;
    sampleId: string;
    sourceGroup: string;
    partition: string;
    family: BA1SampleFamily;
    candidates: BA1StudentCandidateRow[];
  }>();
  for (const raw of records) {
    if (!isRecord(raw)) throw new BA1TrainDataError("student row is not an object");
    if (raw.schema !== BA1_STUDENT_ROW_SCHEMA) throw new BA1TrainDataError(`student row ${String(raw.group_id)} has a wrong schema`);
    const groupId = requireNonEmptyString(raw.group_id, "student row group_id");
    const sampleId = requireNonEmptyString(raw.sampleId, `student row ${groupId} sampleId`);
    const sourceGroup = requireNonEmptyString(raw.sourceGroup, `student row ${groupId} sourceGroup`);
    const partition = requireNonEmptyString(raw.partition, `student row ${groupId} partition`);
    const family = requireKnownSampleFamily(raw.family, `student row ${groupId} family`);
    if (family !== "model-semantic") {
      throw new BA1TrainDataError(
        `student row ${groupId} has family=${family}; the training entry only admits model-semantic rows`,
      );
    }
    const forbidden = forbiddenStudentFields(raw);
    if (forbidden.length > 0) throw new BA1TrainDataError(`student row ${groupId} carries forbidden field(s): ${forbidden.join(", ")}`);
    if (raw.candidateKind !== "relation") throw new BA1TrainDataError(`student row ${groupId} candidateKind must be relation`);
    if (raw.optionSemantics !== "select") throw new BA1TrainDataError(`student row ${groupId} optionSemantics must be select`);
    if (!Array.isArray(raw.x) || raw.x.length !== 64) throw new BA1TrainDataError(`student row ${groupId} does not carry x[64]`);
    if (!raw.x.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new BA1TrainDataError(`student row ${groupId} x[64] must be strictly finite`);
    }
    const missingMode = Array.isArray(raw.missingMode) ? raw.missingMode : [];
    const missingModeCheck = validateMissingModeConsistency(raw.x as readonly number[], missingMode);
    if (!missingModeCheck.ok) {
      throw new BA1TrainDataError(
        `student row ${groupId} candidate ${String(raw.candidateRef)} invalid missingMode: ${missingModeCheck.message}`,
      );
    }
    const candidateRef = requireNonEmptyString(raw.candidateRef, `student row ${groupId} candidateRef`);
    let group = groups.get(groupId);
    if (!group) {
      group = { group_id: groupId, sampleId, sourceGroup, partition, family, candidates: [] };
      groups.set(groupId, group);
    } else if (
      group.sampleId !== sampleId
      || group.sourceGroup !== sourceGroup
      || group.partition !== partition
      || group.family !== family
    ) {
      throw new BA1TrainDataError(
        `student group ${groupId} has inconsistent sampleId/sourceGroup/partition/family across rows`,
      );
    }
    group.candidates.push({
      candidateRef,
      x: raw.x as readonly number[],
      missingMode,
      optionSemantics: "select",
      candidateKind: "relation",
    });
  }
  return [...groups.values()];
}

export async function loadBA1SupervisionRowsFile(rowsPath: string): Promise<readonly BA1SupervisionRow[]> {
  const records = parseJsonl(await readFile(rowsPath, "utf8"));
  const rows: BA1SupervisionRow[] = [];
  const seen = new Set<string>();
  for (const raw of records) {
    if (!isRecord(raw)) throw new BA1TrainDataError("supervision row is not an object");
    if (raw.schema !== BA1_SUPERVISION_ROW_SCHEMA) throw new BA1TrainDataError(`supervision row ${String(raw.group_id)} has a wrong schema`);
    const groupId = requireNonEmptyString(raw.group_id, "supervision row group_id");
    if (seen.has(groupId)) throw new BA1TrainDataError(`duplicate supervision row for group ${groupId}`);
    seen.add(groupId);
    const forbidden = forbiddenSupervisionFields(raw);
    if (forbidden.length > 0) throw new BA1TrainDataError(`supervision row ${groupId} carries forbidden field(s): ${forbidden.join(", ")}`);
    const supervisionStatus = requireKnownSupervisionStatus(raw.supervisionStatus, groupId);
    const family = requireKnownSampleFamily(raw.family, `supervision row ${groupId} family`);
    if (family !== "model-semantic") {
      throw new BA1TrainDataError(
        `supervision row ${groupId} has family=${family}; the training entry only admits model-semantic rows`,
      );
    }
    const eligibility = classifyBA1TrainingEligibility(supervisionStatus);
    if (raw.trainingEligible !== eligibility.trainingEligible) {
      throw new BA1TrainDataError(
        `supervision row ${groupId} trainingEligible=${String(raw.trainingEligible)} conflicts with status=${supervisionStatus}`,
      );
    }
    if (raw.evaluationClass !== eligibility.evaluationClass) {
      throw new BA1TrainDataError(
        `supervision row ${groupId} evaluationClass=${String(raw.evaluationClass)} conflicts with status=${supervisionStatus}`,
      );
    }
    if (!Array.isArray(raw.goldAllowedCandidateRefs) || !raw.goldAllowedCandidateRefs.every(ref => typeof ref === "string")) {
      throw new BA1TrainDataError(`supervision row ${groupId} goldAllowedCandidateRefs must be an array of strings`);
    }
    rows.push({
      group_id: groupId,
      sampleId: requireNonEmptyString(raw.sampleId, `supervision row ${groupId} sampleId`),
      sourceGroup: requireNonEmptyString(raw.sourceGroup, `supervision row ${groupId} sourceGroup`),
      partition: requireNonEmptyString(raw.partition, `supervision row ${groupId} partition`),
      supervisionStatus,
      goldAllowedCandidateRefs: raw.goldAllowedCandidateRefs as readonly string[],
      trainingEligible: eligibility.trainingEligible,
      evaluationClass: eligibility.evaluationClass,
      family,
    });
  }
  return rows;
}

export function buildBA1EncodedGroups(
  studentGroups: readonly BA1StudentGroup[],
  supervisionRows: readonly BA1SupervisionRow[],
): readonly EncodedGroup[] {
  const supervisionByGroup = new Map(supervisionRows.map(row => [row.group_id, row]));
  if (supervisionByGroup.size !== supervisionRows.length) {
    throw new BA1TrainDataError("supervision rows contain duplicate group ids");
  }
  const groups: EncodedGroup[] = [];
  const seen = new Set<string>();
  for (const group of studentGroups) {
    if (seen.has(group.group_id)) throw new BA1TrainDataError(`duplicate group ${group.group_id}`);
    seen.add(group.group_id);
    const supervision = supervisionByGroup.get(group.group_id);
    if (!supervision) throw new BA1TrainDataError(`missing supervision for ${group.group_id}`);
    if (
      supervision.sampleId !== group.sampleId
      || supervision.sourceGroup !== group.sourceGroup
      || supervision.family !== group.family
    ) {
      throw new BA1TrainDataError(
        `student/supervision source/family mismatch for ${group.group_id}`,
      );
    }
    if (group.family !== "model-semantic") {
      throw new BA1TrainDataError(
        `group ${group.group_id} family=${group.family} is not allowed to enter TRAIN optimization`,
      );
    }
    if (group.partition !== "TRAIN" || supervision.partition !== "TRAIN") {
      throw new BA1TrainDataError(`group ${group.group_id} must be partition=TRAIN on both student and supervision rows`);
    }
    if (!supervision.trainingEligible) {
      throw new BA1TrainDataError(
        `group ${group.group_id} is not training-eligible: status=${supervision.supervisionStatus}, evaluationClass=${supervision.evaluationClass}`,
      );
    }
    const candidates: EncodedCandidate[] = group.candidates.map(candidate => ({
      candidateRef: candidate.candidateRef,
      input: candidate.x,
      optionSemantics: candidate.optionSemantics,
      candidateKind: "relation",
    }));
    const refs = new Set(candidates.map(candidate => candidate.candidateRef));
    if (refs.size !== candidates.length) throw new BA1TrainDataError(`group ${group.group_id} has duplicate candidate refs`);
    const allowedRefs = [...new Set(supervision.goldAllowedCandidateRefs)];
    if (allowedRefs.length !== supervision.goldAllowedCandidateRefs.length) {
      throw new BA1TrainDataError(`group ${group.group_id} A_g contains duplicate refs`);
    }
    if (allowedRefs.length === 0) throw new BA1TrainDataError(`empty A_g for ${group.group_id}`);
    for (const ref of supervision.goldAllowedCandidateRefs) {
      if (!refs.has(ref)) throw new BA1TrainDataError(`A_g ref ${ref} outside S_g for ${group.group_id}`);
    }
    if (supervision.supervisionStatus === "labeled_selected" && allowedRefs.length !== 1) {
      throw new BA1TrainDataError(
        `labeled_selected group ${group.group_id} must have exactly one allowed candidate`,
      );
    }
    if (supervision.supervisionStatus === "labeled_ambiguous" && allowedRefs.length < 2) {
      throw new BA1TrainDataError(
        `labeled_ambiguous group ${group.group_id} must have at least two allowed candidates`,
      );
    }
    try {
      assertBA1EncodedRouteGroup({
        groupRef: group.group_id,
        candidates,
        allowedCandidateRefs: supervision.goldAllowedCandidateRefs,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new BA1TrainDataError(`route encoder rejected group ${group.group_id}: ${message}`);
    }
    groups.push({ groupRef: group.group_id, candidates, allowedCandidateRefs: supervision.goldAllowedCandidateRefs });
  }
  for (const supervision of supervisionRows) {
    if (!seen.has(supervision.group_id)) {
      throw new BA1TrainDataError(`orphan supervision row for group ${supervision.group_id}`);
    }
  }
  if (groups.length === 0) throw new BA1TrainDataError("no trainable groups");
  return groups;
}

function maxAbsGrad(previous: UnifiedTensors, next: UnifiedTensors, learningRate: number): number {
  let max = 0;
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const a = previous[key];
    const b = next[key];
    for (let index = 0; index < a.length; index += 1) {
      const delta = Math.abs((b[index] ?? 0) - (a[index] ?? 0)) / learningRate;
      if (delta > max) max = delta;
    }
  }
  return max;
}

function assertTensorsFinite(tensors: UnifiedTensors, label: string): void {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    if (!tensors[key].every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new BA1NonFiniteLossError(`${label}.${key} must be finite`);
    }
  }
}

function buildReport(
  status: BA1TrainReport["status"],
  stopReason: BA1StopReason,
  epochs: readonly BA1TrainEpochRecord[],
  groups: readonly EncodedGroup[],
  tensors: UnifiedTensors,
  initialLoss: number | null,
  finalLoss: number | null,
  violations: readonly string[],
): BA1TrainReport {
  let marginSatisfied = 0;
  let decisionSatisfied = 0;
  for (const group of groups) {
    const diagnosis = bA1ThresholdDiagnosis(group, tensors);
    if (diagnosis.marginSatisfied) marginSatisfied += 1;
    if (diagnosis.decisionSatisfied) decisionSatisfied += 1;
  }
  return {
    schema: "nnanything.b-a1-unified.train-report.v1",
    status,
    stopReason,
    completedEpochs: epochs.length,
    lossKind: BA1_LOSS_KIND,
    theta: BA1_THETA,
    margin: BA1_MARGIN,
    groupCount: groups.length,
    lossGoal: "all eligible TRAIN groups margin_satisfied",
    groupMarginSatisfiedCount: marginSatisfied,
    groupDecisionSatisfiedCount: decisionSatisfied,
    not_converged: marginSatisfied < groups.length,
    initialLoss,
    finalLoss,
    epochs,
    violations,
  };
}

function buildUnifiedTrainConfig(config: BA1TrainConfig): UnifiedTrainConfig {
  return {
    schema: UNIFIED_TRAIN_CONFIG_SCHEMA,
    route: config.route,
    inputSchema: config.inputSchema,
    encoderVersion: config.encoderVersion,
    architecture: {
      input: 64,
      hidden: [64, 64],
      output: 1,
    },
    optimizer: config.optimizer,
    learningRate: config.learningRate,
    maxEpochs: config.maxEpochs,
    seed: config.seed,
    init: config.init,
    resources: config.resources,
    modelId: config.modelId,
    version: config.version,
  };
}

function tensorsMatch(left: UnifiedTensors, right: UnifiedTensors): boolean {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const a = left[key];
    const b = right[key];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
  }
  return true;
}

function assertBA1WarmStartPathsDistinct(
  sourcePackagePath: string,
  targetPackagePath: string,
  targetCheckpointPath: string | undefined,
): void {
  const pairs = [
    ["source package", resolve(sourcePackagePath), "target package", resolve(targetPackagePath)],
    ...(targetCheckpointPath === undefined
      ? []
      : [
          ["source package", resolve(sourcePackagePath), "target checkpoint", resolve(targetCheckpointPath)],
          ["target package", resolve(targetPackagePath), "target checkpoint", resolve(targetCheckpointPath)],
        ] as const),
  ] as const;
  for (const [leftLabel, leftPath, rightLabel, rightPath] of pairs) {
    if (leftPath === rightPath) {
      throw new BA1WarmStartError(
        "WARMSTART_PATH_CONFLICT",
        `${leftLabel} and ${rightLabel} resolve to the same path: ${leftPath}`,
      );
    }
  }
}

function assertBA1WarmStartCompatible(
  source: UnifiedModelPackageResource,
  config: BA1TrainConfig,
): void {
  const mismatches: string[] = [];
  if (
    source.package.route.domain !== config.route.domain
    || source.package.route.decisionKind !== config.route.decisionKind
  ) {
    mismatches.push(
      `route source=${JSON.stringify(source.package.route)} target=${JSON.stringify(config.route)}`,
    );
  }
  if (source.package.inputSchema !== config.inputSchema) {
    mismatches.push(
      `inputSchema source=${source.package.inputSchema} target=${config.inputSchema}`,
    );
  }
  if (source.package.encoderVersion !== config.encoderVersion) {
    mismatches.push(
      `encoderVersion source=${source.package.encoderVersion} target=${config.encoderVersion}`,
    );
  }
  const architecture = source.package.architecture;
  if (
    architecture.input !== config.architecture.input
    || architecture.hidden.length !== config.architecture.hidden.length
    || architecture.hidden[0] !== config.architecture.hidden[0]
    || architecture.hidden[1] !== config.architecture.hidden[1]
    || architecture.output !== config.architecture.output
    || architecture.activation !== config.architecture.activation
  ) {
    mismatches.push(
      `architecture source=${JSON.stringify(architecture)} target=${JSON.stringify(config.architecture)}`,
    );
  }
  if (source.package.resources.thresholdsSchema !== config.resources.thresholdsSchema) {
    mismatches.push(
      `thresholdsSchema source=${source.package.resources.thresholdsSchema} `
      + `target=${config.resources.thresholdsSchema}`,
    );
  }
  if (source.package.resources.missingModeSchema !== config.resources.missingModeSchema) {
    mismatches.push(
      `missingModeSchema source=${source.package.resources.missingModeSchema} `
      + `target=${config.resources.missingModeSchema}`,
    );
  }
  if (source.resolvedResources.slotMapPath === null) {
    mismatches.push("slotMap source=missing target=required");
  }
  if (mismatches.length > 0) {
    throw new BA1WarmStartError(
      "WARMSTART_SOURCE_INCOMPATIBLE",
      `B-A1 warm start source package ${source.packagePath} is incompatible: ${mismatches.join("; ")}`,
    );
  }
}

async function loadBA1WarmStartSource(
  sourcePackagePath: string,
  config: BA1TrainConfig,
): Promise<UnifiedWarmStartSource> {
  let source: UnifiedModelPackageResource;
  try {
    source = await loadUnifiedModelPackageFromFile(sourcePackagePath);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new BA1WarmStartError(
      "WARMSTART_SOURCE_INVALID",
      `B-A1 warm start source package at ${resolve(sourcePackagePath)} is missing or invalid: ${message}`,
    );
  }
  try {
    await validateBA1ResourceContent(source.package.resources, dirname(source.packagePath));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new BA1WarmStartError(
      "WARMSTART_SOURCE_INCOMPATIBLE",
      `B-A1 warm start source package ${source.packagePath} has an invalid resource contract: ${message}`,
    );
  }
  assertBA1WarmStartCompatible(source, config);
  return {
    tensors: source.package.tensors,
    modelId: source.package.modelId,
    version: source.package.version,
    route: { ...source.package.route },
    encoderVersion: source.package.encoderVersion,
    sourcePackagePath: source.packagePath,
  };
}

async function verifyBA1PackageReloadInNewProcess(
  packagePath: string,
  expected: UnifiedModelPackage,
): Promise<{
  readonly tensorsMatch: boolean;
  readonly thresholdsPath: string;
  readonly missingModeTablePath: string;
  readonly slotMapPath: string | null;
  readonly resourceContentValidated: boolean;
}> {
  const resolvedPackagePath = resolve(packagePath);
  const loaderUrl = new URL("./unified-model-package.js", import.meta.url).href;
  const validatorUrl = new URL("./b-a1-training-entry.js", import.meta.url).href;
  const script = `
import { loadUnifiedModelPackageFromFile } from ${JSON.stringify(loaderUrl)};
import { validateBA1ResourceContent } from ${JSON.stringify(validatorUrl)};
import { dirname } from "node:path";
const loaded = await loadUnifiedModelPackageFromFile(${JSON.stringify(resolvedPackagePath)});
await validateBA1ResourceContent(loaded.package.resources, dirname(${JSON.stringify(resolvedPackagePath)}));
process.stdout.write(JSON.stringify({
  tensors: loaded.package.tensors,
  thresholdsPath: loaded.resolvedResources.thresholdsPath,
  missingModeTablePath: loaded.resolvedResources.missingModeTablePath,
  slotMapPath: loaded.resolvedResources.slotMapPath,
  resourceContentValidated: true
}));
`;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const loaded = JSON.parse(String(stdout)) as {
    readonly tensors: UnifiedTensors;
    readonly thresholdsPath: string;
    readonly missingModeTablePath: string;
    readonly slotMapPath: string | null;
    readonly resourceContentValidated: boolean;
  };
  const match = tensorsMatch(expected.tensors, loaded.tensors);
  if (!match) throw new BA1TrainDataError("new-process package reload tensors differ from the saved package");
  if (!loaded.resourceContentValidated) {
    throw new BA1TrainDataError("new-process package reload did not validate resource content");
  }
  return {
    tensorsMatch: match,
    thresholdsPath: loaded.thresholdsPath,
    missingModeTablePath: loaded.missingModeTablePath,
    slotMapPath: loaded.slotMapPath,
    resourceContentValidated: loaded.resourceContentValidated,
  };
}

async function verifyBA1CheckpointReloadInNewProcess(
  checkpointPath: string,
  expected: UnifiedTrainingCheckpoint,
): Promise<UnifiedTrainingCheckpointReloadReceipt> {
  const resolvedCheckpointPath = resolve(checkpointPath);
  const loaderUrl = new URL("./unified-training-checkpoint.js", import.meta.url).href;
  const script = `
import { loadUnifiedTrainingCheckpointFromFile } from ${JSON.stringify(loaderUrl)};
const loaded = await loadUnifiedTrainingCheckpointFromFile(${JSON.stringify(resolvedCheckpointPath)});
process.stdout.write(JSON.stringify({
  completedEpochs: loaded.completedEpochs,
  epochRecordCount: loaded.epochRecords.length,
  tensors: loaded.tensors
}));
`;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const loaded = JSON.parse(String(stdout)) as {
    readonly completedEpochs: number;
    readonly epochRecordCount: number;
    readonly tensors: UnifiedTensors;
  };
  const match = tensorsMatch(expected.tensors, loaded.tensors);
  if (
    !match
    || loaded.completedEpochs !== expected.completedEpochs
    || loaded.epochRecordCount !== expected.epochRecords.length
  ) {
    throw new BA1TrainDataError("new-process training checkpoint reload differs from the saved checkpoint");
  }
  return {
    checkpointPath: resolvedCheckpointPath,
    completedEpochs: loaded.completedEpochs,
    epochRecordCount: loaded.epochRecordCount,
    tensorsMatch: match,
  };
}

async function readJsonResource(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (caught) {
    const cause = (caught as NodeJS.ErrnoException).code ?? (caught instanceof Error ? caught.message : String(caught));
    throw new BA1TrainDataError(`${label} resource is missing or unreadable (${cause})`);
  }
}

function assertBA1SlotMapContent(raw: unknown): void {
  if (!isRecord(raw)) throw new BA1TrainDataError("slot map resource must be an object");
  if (raw.schema !== "nnanything.b-a1.slot-map.v1") {
    throw new BA1TrainDataError("slot map resource schema mismatch");
  }
  if (raw.route !== `${BA1_ROUTE_DOMAIN}/${BA1_ROUTE_DECISION_KIND}`) {
    throw new BA1TrainDataError(`slot map resource route must be ${BA1_ROUTE_DOMAIN}/${BA1_ROUTE_DECISION_KIND}`);
  }
  if (raw.encoderVersion !== BA1_ENCODER_VERSION) {
    throw new BA1TrainDataError(`slot map resource encoderVersion must be ${BA1_ENCODER_VERSION}`);
  }
  if (!Array.isArray(raw.slots) || raw.slots.length !== BA1_SLOT_CONTRACT.length) {
    throw new BA1TrainDataError(`slot map resource must define exactly ${BA1_SLOT_CONTRACT.length} slots`);
  }
  for (let slot = 0; slot < BA1_SLOT_CONTRACT.length; slot += 1) {
    const expected = BA1_SLOT_CONTRACT[slot];
    if (expected === undefined || expected.slot !== slot) {
      throw new BA1TrainDataError(`B-A1 slot contract is missing slot ${slot}`);
    }
    const entry = raw.slots[slot];
    if (!isRecord(entry) || entry.slot !== slot) {
      throw new BA1TrainDataError(`slot map entry ${slot} must have slot=${slot}`);
    }
    if (entry.field !== expected.field) {
      throw new BA1TrainDataError(
        `slot map entry ${slot} field must be ${expected.field}; got ${String(entry.field)}`,
      );
    }
    if (entry.kind !== expected.kind) {
      throw new BA1TrainDataError(
        `slot map entry ${slot} kind must be ${expected.kind}; got ${String(entry.kind)}`,
      );
    }
    if (expected.constant !== undefined) {
      if (entry.constant !== expected.constant) {
        throw new BA1TrainDataError(
          `slot map entry ${slot} constant must be ${expected.constant}; got ${String(entry.constant)}`,
        );
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, "constant")) {
      throw new BA1TrainDataError(`slot map entry ${slot} must not declare a constant`);
    }
  }
}

export async function validateBA1ResourceContent(
  resources: UnifiedModelPackageResources,
  baseDir: string,
): Promise<void> {
  if (resources.thresholdsSchema !== "nnanything.feature-thresholds.v1") {
    throw new BA1TrainDataError("thresholds resource schema mismatch");
  }
  if (resources.missingModeSchema !== "nnanything.unified.missing-mode.v1") {
    throw new BA1TrainDataError("missing mode resource schema mismatch");
  }
  if (typeof resources.slotMapRef !== "string" || resources.slotMapRef.length === 0) {
    throw new BA1TrainDataError("slot map resource ref must be a non-empty string");
  }
  const thresholdsPath = resolve(baseDir, resources.thresholdsRef);
  const missingModeTablePath = resolve(baseDir, resources.missingModeTableRef);
  const slotMapPath = resolve(baseDir, resources.slotMapRef);
  await readJsonResource(thresholdsPath, "thresholds");
  const missingModeRaw = await readJsonResource(missingModeTablePath, "missing mode");
  const slotMapRaw = await readJsonResource(slotMapPath, "slot map");
  try {
    validateMissingModeTable(missingModeRaw);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new BA1TrainDataError(`missing mode resource is invalid: ${message}`);
  }
  assertBA1SlotMapContent(slotMapRaw);
}

async function verifyBA1TrainPackageReload(
  packagePath: string,
  expected: UnifiedModelPackage,
): Promise<BA1PackageReloadReceipt> {
  const loaded = await loadUnifiedModelPackageFromFile(packagePath);
  const match = tensorsMatch(expected.tensors, loaded.package.tensors);
  if (!match) throw new BA1TrainDataError("reloaded package tensors differ from the saved package");
  const resourcesMatch = JSON.stringify(loaded.package.resources) === JSON.stringify(expected.resources);
  if (!resourcesMatch) throw new BA1TrainDataError("reloaded package resources differ from the saved package");
  if (
    loaded.package.route.domain !== expected.route.domain
    || loaded.package.route.decisionKind !== expected.route.decisionKind
    || loaded.package.encoderVersion !== expected.encoderVersion
  ) {
    throw new BA1TrainDataError("reloaded package route/encoder differs from the saved package");
  }
  await validateBA1ResourceContent(loaded.package.resources, dirname(loaded.packagePath));
  const newProcess = await verifyBA1PackageReloadInNewProcess(packagePath, expected);
  const unifiedReceipt = await verifyUnifiedTrainPackageReload(packagePath, expected);
  return {
    ...unifiedReceipt,
    tensorsMatch: match,
    route: { ...loaded.package.route },
    encoderVersion: loaded.package.encoderVersion,
    resourcesMatch,
    resourceFilesRead: true,
    resourceContentValidated: newProcess.resourceContentValidated,
    newProcessVerified: true,
  };
}

export async function trainBA1UnifiedRelationDecision(options: {
  readonly config: BA1TrainConfig;
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly packageOutPath: string;
  readonly checkpointOutPath?: string;
  readonly warmStartFrom?: UnifiedWarmStartSource;
}): Promise<BA1TrainResult> {
  const commandStartedNs = process.hrtime.bigint();
  validateBA1TrainConfig(options.config);

  if (options.warmStartFrom !== undefined) {
    assertBA1WarmStartPathsDistinct(
      options.warmStartFrom.sourcePackagePath,
      options.packageOutPath,
      options.checkpointOutPath,
    );
  }

  // Resource content is a fixed route-owned gate. It must be verified before
  // any optimizer step or artifact write, using the same validation that the
  // package reload re-applies.
  const packageDir = dirname(resolve(options.packageOutPath));
  await validateBA1ResourceContent(options.config.resources, packageDir);

  const loadStartedNs = process.hrtime.bigint();
  const warmStartSource = options.warmStartFrom === undefined
    ? undefined
    : await loadBA1WarmStartSource(options.warmStartFrom.sourcePackagePath, options.config);
  const studentGroups = await loadBA1StudentRowsFile(options.studentRowsPath);
  const supervisionRows = await loadBA1SupervisionRowsFile(options.supervisionRowsPath);
  const loadSeconds = monotonicSeconds(loadStartedNs);

  const validationStartedNs = process.hrtime.bigint();
  const groups = buildBA1EncodedGroups(studentGroups, supervisionRows);
  const dataValidationSeconds = monotonicSeconds(validationStartedNs);

  const trainConfig = buildUnifiedTrainConfig(options.config);
  const tensors = warmStartSource === undefined
    ? createXavierTensors(options.config.seed) as MutableUnifiedTensors
    : cloneTensors(warmStartSource.tensors) as MutableUnifiedTensors;
  assertTensorsFinite(tensors, "initial tensors");
  const warmStartLineage: UnifiedWarmStartLineage | undefined = warmStartSource === undefined
    ? undefined
    : {
        kind: "package-warm-start",
        sourceModelId: warmStartSource.modelId,
        sourceVersion: warmStartSource.version,
        sourcePackagePath: warmStartSource.sourcePackagePath,
        sourceRoute: { ...warmStartSource.route },
        sourceEncoderVersion: warmStartSource.encoderVersion,
        epochZero: checkWarmStartEpochZeroEquality(
          warmStartSource.tensors,
          tensors,
          groups.flatMap(group => group.candidates.map(candidate => candidate.input)),
        ),
      };
  const initialLoss = bA1ParameterLoss(groups, tensors);

  const epochs: BA1TrainEpochRecord[] = [];
  const violations: string[] = [];
  let stopReason: BA1StopReason = "epoch_limit_exhausted";
  let attemptOptimizerSteps = 0;
  let completedOptimizerSteps = 0;
  const optimizationStartedNs = process.hrtime.bigint();

  for (let epoch = 0; epoch < options.config.maxEpochs; epoch += 1) {
    attemptOptimizerSteps += 1;
    const before = cloneTensors(tensors) as UnifiedTensors;
    try {
      const result = bA1FullBatchEpochStep(tensors, groups, options.config.learningRate);
      assertTensorsFinite(tensors, `epoch ${epoch} tensors`);
      const grad = maxAbsGrad(before, tensors, options.config.learningRate);
      if (!Number.isFinite(result.loss) || !Number.isFinite(grad)) {
        throw new BA1NonFiniteLossError(`epoch ${epoch} produced a non-finite loss or gradient`);
      }
      epochs.push({ epoch, epochLoss: result.loss, finite: true, maxAbsGrad: grad });
      completedOptimizerSteps += 1;
    } catch (caught) {
      for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
        (tensors as MutableUnifiedTensors)[key] = [...before[key]];
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof BA1NonFiniteLossError) {
        violations.push(`epoch ${epoch} produced a non-finite loss or gradient: ${message}`);
        stopReason = "non_finite";
      } else {
        violations.push(`epoch ${epoch} failed with original cause: ${caught instanceof Error ? caught.name : typeof caught}: ${message}`);
        stopReason = "data_invalid";
      }
      break;
    }
  }
  const optimizationSeconds = monotonicSeconds(optimizationStartedNs);
  const finalLoss = bA1ParameterLoss(groups, tensors);
  const status: BA1TrainReport["status"] = stopReason === "non_finite"
    ? "failed"
    : stopReason === "data_invalid"
      ? "DATA_INVALID"
      : "completed";
  const report = buildReport(status, stopReason, epochs, groups, tensors, initialLoss, finalLoss, violations);

  const rowsPerEpoch = groups.reduce((sum, group) => sum + group.candidates.length, 0);
  const attemptProcessedRows = attemptOptimizerSteps * rowsPerEpoch;
  const completedProcessedRows = completedOptimizerSteps * rowsPerEpoch;
  const rowsPerSecond = completedProcessedRows > 0 && optimizationSeconds > 0
    ? completedProcessedRows / optimizationSeconds
    : null;

  let checkpointIo = emptyCheckpointIoTiming();
  const packageSaveStartedNs = process.hrtime.bigint();
  const pkg = createUnifiedModelPackage({
    modelId: options.config.modelId,
    version: options.config.version,
    route: options.config.route,
    encoderVersion: options.config.encoderVersion,
    tensors,
    resources: options.config.resources,
  });
  const packageOutPath = await saveUnifiedModelPackageAtomic(options.packageOutPath, pkg);
  const packageSaveSeconds = monotonicSeconds(packageSaveStartedNs);
  checkpointIo = addCheckpointIoTiming(checkpointIo, {
    serializeSeconds: packageSaveSeconds,
    atomicReplaceSeconds: 0,
    packageReloadSeconds: 0,
    totalSeconds: packageSaveSeconds,
  });

  let checkpointOutPath: string | null = null;
  let savedCheckpoint: UnifiedTrainingCheckpoint | null = null;
  if (options.checkpointOutPath !== undefined) {
    const totalWallSecondsBeforeCheckpoint = monotonicSeconds(commandStartedNs);
    const cumulativeTiming = {
      loadSeconds,
      dataValidationSeconds,
      optimizationSeconds,
      checkpointIoSecs: checkpointIo,
      totalWallSeconds: totalWallSecondsBeforeCheckpoint,
      optimizerSteps: completedOptimizerSteps,
      processedRows: completedProcessedRows,
    };
    const persistedTiming: UnifiedPersistedTiming = {
      cumulative: cumulativeTiming,
      timingCutPoint: {
        committedOptimizerSteps: completedOptimizerSteps,
        committedProcessedRows: completedProcessedRows,
        reason: status === "completed" ? "epoch_commit" : "paused",
      },
    };
    savedCheckpoint = createUnifiedTrainingCheckpoint({
      config: trainConfig,
      completedEpochs: epochs.length,
      epochRecords: epochs,
      violations,
      tensors,
      timing: persistedTiming,
      ...(warmStartLineage === undefined ? {} : { warmStart: warmStartLineage }),
    });
    const saved = await saveUnifiedTrainingCheckpointAtomicWithTiming(
      options.checkpointOutPath,
      savedCheckpoint,
    );
    checkpointOutPath = saved.checkpointPath;
    checkpointIo = addCheckpointIoTiming(checkpointIo, saved.io);
  }

  const packageReloadStartedNs = process.hrtime.bigint();
  const packageReload = await verifyBA1TrainPackageReload(packageOutPath, pkg);
  checkpointIo = addPackageReloadSeconds(checkpointIo, monotonicSeconds(packageReloadStartedNs));

  const checkpointReload = savedCheckpoint === null
    ? null
    : await verifyUnifiedTrainingCheckpointReload(checkpointOutPath as string, savedCheckpoint);
  if (savedCheckpoint !== null && checkpointOutPath !== null) {
    const newProcessCheckpointReload = await verifyBA1CheckpointReloadInNewProcess(
      checkpointOutPath,
      savedCheckpoint,
    );
    if (
      newProcessCheckpointReload.tensorsMatch !== checkpointReload?.tensorsMatch
      || newProcessCheckpointReload.completedEpochs !== checkpointReload?.completedEpochs
      || newProcessCheckpointReload.epochRecordCount !== checkpointReload?.epochRecordCount
    ) {
      throw new BA1TrainDataError("checkpoint reload differs between same-process and new-process checks");
    }
  }

  const totalWallSeconds = monotonicSeconds(commandStartedNs);
  const timing: UnifiedThisRunTiming = {
    loadSeconds,
    dataValidationSeconds,
    optimizationSeconds,
    checkpointIoSecs: checkpointIo,
    evaluationSeconds: null,
    totalWallSeconds,
    attemptOptimizerSteps,
    attemptProcessedRows,
    completedOptimizerSteps,
    completedProcessedRows,
    rowsPerSecond,
    throughputDenominator: optimizationSeconds > 0 ? "optimizationSeconds" : null,
  };

  return {
    report,
    package: pkg,
    receipt: {
      studentRowsPath: resolve(options.studentRowsPath),
      supervisionRowsPath: resolve(options.supervisionRowsPath),
      packageOutPath,
      checkpointOutPath,
      packageReload,
      checkpointReload,
      timing,
    },
  };
}

export function createBA1ModelPackage(input: {
  readonly modelId: string;
  readonly version: string;
  readonly tensors: UnifiedTensors;
  readonly resources: BA1TrainResources;
  readonly fixedStages?: readonly string[];
}): BA1ModelPackage {
  assertUnifiedTensors(input.tensors);
  return createUnifiedModelPackage({
    modelId: input.modelId,
    version: input.version,
    route: { domain: BA1_ROUTE_DOMAIN, decisionKind: BA1_ROUTE_DECISION_KIND },
    encoderVersion: BA1_ENCODER_VERSION,
    tensors: input.tensors,
    resources: input.resources,
    fixedStages: input.fixedStages ?? [],
  });
}

export function cloneBA1Tensors(tensors: UnifiedTensors): UnifiedTensors {
  return cloneTensors(tensors);
}
