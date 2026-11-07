// Real unified 64-slot train config and fitter core (launch contract §2.2/§2.3/§4.4.1).
//
// This module implements the declared fixed recipe and stop/failure exits. It
// does not adopt anything: saving a package is explicit and the caller decides
// where it goes. Missing student/supervision groups, empty A_g, or A_g outside
// S_g fail explicitly before any optimizer step.

import { readFile } from "node:fs/promises";
import type { EncoderMissingMode } from "./unified-encoder.js";
import {
  applyFullBatchSgd,
  cloneTensors,
  createXavierTensors,
  type MutableUnifiedTensors,
  type UnifiedTensors,
} from "./unified-forward.js";
import { fullBatchEpochStep, type EncodedCandidate, type EncodedGroup, type EpochResult } from "./group-loss.js";
import type { StudentGroup } from "./unified-student-converter.js";
import type { SupervisionRow } from "./unified-supervision-converter.js";
import {
  createUnifiedModelPackage,
  loadUnifiedModelPackageFromFile,
  saveUnifiedModelPackageAtomic,
  type ModelRoute,
  type UnifiedModelPackage,
  type UnifiedModelPackageResources,
} from "./unified-model-package.js";
import {
  assertResumeRecipeCompatible,
  createUnifiedTrainingCheckpoint,
  saveUnifiedTrainingCheckpointAtomic,
  type UnifiedTrainingCheckpoint,
} from "./unified-training-checkpoint.js";
import { UNIFIED_STUDENT_ROW_SCHEMA, type StudentCandidateRow } from "./unified-student-converter.js";
import { UNIFIED_SUPERVISION_ROW_SCHEMA } from "./unified-supervision-converter.js";
import { validateMissingModeConsistency } from "./unified-missing-mode.js";

export const UNIFIED_TRAIN_CONFIG_SCHEMA = "nnanything.unified.train-config.v1" as const;

export type UnifiedStopReason =
  | "epoch_limit_exhausted"
  | "non_finite"
  | "invocation_budget_exhausted"
  | "data_invalid";

export interface UnifiedTrainConfig {
  readonly schema: typeof UNIFIED_TRAIN_CONFIG_SCHEMA;
  readonly route: ModelRoute;
  readonly architecture: { readonly input: 64; readonly hidden: readonly [64, 64]; readonly output: 1 };
  readonly optimizer: "full_batch_sgd";
  readonly learningRate: number;
  readonly maxEpochs: number;
  readonly seed: number;
  readonly init: "xavier_uniform";
  readonly resources: UnifiedModelPackageResources;
  readonly modelId: string;
  readonly version: string;
}

export const DEFAULT_UNIFIED_TRAIN_RECIPE = Object.freeze({
  optimizer: "full_batch_sgd" as const,
  learningRate: 0.01,
  maxEpochs: 200,
  seed: 20261104,
  init: "xavier_uniform" as const,
});

export interface UnifiedTrainEpochRecord {
  readonly epoch: number;
  readonly epochLoss: number;
  readonly finite: boolean;
  readonly maxAbsGrad: number;
}

export interface UnifiedTrainReport {
  readonly schema: "nnanything.unified.train-report.v1";
  readonly status: "completed" | "paused" | "failed" | "DATA_INVALID";
  readonly stopReason: UnifiedStopReason;
  readonly completedEpochs: number;
  readonly initialLoss: number | null;
  readonly finalLoss: number | null;
  readonly lastDecileMeanAbsDelta: number | null;
  readonly monotonicViolations: number;
  readonly firstMonotonicViolationEpoch: number | null;
  readonly groupCount: number;
  readonly epochs: readonly UnifiedTrainEpochRecord[];
  readonly violations: readonly string[];
}

export interface UnifiedTrainStudentDataset {
  readonly rowsPath: string;
  readonly groups: readonly StudentGroup[];
}

export interface UnifiedTrainSupervisionDataset {
  readonly rowsPath: string;
  readonly rows: readonly SupervisionRow[];
}

export interface UnifiedTrainRunOptions {
  readonly config: UnifiedTrainConfig;
  readonly student: UnifiedTrainStudentDataset;
  readonly supervision: UnifiedTrainSupervisionDataset;
  readonly packageOutPath: string;
}

export interface UnifiedTrainRunReceipt {
  readonly report: UnifiedTrainReport;
  readonly packagePath: string;
  readonly package: UnifiedModelPackage;
  readonly modelId: string;
  readonly version: string;
  readonly resources: UnifiedModelPackageResources;
}

export interface UnifiedTrainingRunOptions {
  /** Continue from this committed checkpoint boundary instead of Xavier init. */
  readonly resumeFrom?: UnifiedTrainingCheckpoint;
  /** Bounded invocation: run at most this many epochs in this call. */
  readonly epochsThisRun?: number;
}

export class UnifiedTrainDataError extends Error {
  readonly code = "DATA_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnifiedTrainDataError";
  }
}

export function validateUnifiedTrainConfig(config: UnifiedTrainConfig): void {
  if (config.schema !== UNIFIED_TRAIN_CONFIG_SCHEMA) throw new TypeError("train config schema mismatch");
  if (config.optimizer !== "full_batch_sgd") throw new TypeError("optimizer must be full_batch_sgd");
  if (!Number.isFinite(config.learningRate) || config.learningRate <= 0) {
    throw new TypeError("learningRate must be positive and finite");
  }
  if (!Number.isInteger(config.maxEpochs) || config.maxEpochs <= 0) {
    throw new TypeError("maxEpochs must be a positive integer");
  }
  if (!Number.isInteger(config.seed)) throw new TypeError("seed must be an integer");
  if (config.init !== "xavier_uniform") throw new TypeError("init must be xavier_uniform");
}

export function buildEncodedGroups(
  studentGroups: readonly StudentGroup[],
  supervisionRows: readonly SupervisionRow[],
): readonly EncodedGroup[] {
  const supervisionByGroup = new Map(supervisionRows.map(row => [row.group_id, row]));
  const groups: EncodedGroup[] = [];
  const seen = new Set<string>();
  for (const group of studentGroups) {
    if (seen.has(group.group_id)) throw new UnifiedTrainDataError(`duplicate group ${group.group_id}`);
    seen.add(group.group_id);
    const supervision = supervisionByGroup.get(group.group_id);
    if (!supervision) throw new UnifiedTrainDataError(`missing supervision for ${group.group_id}`);
    if (group.partition !== "TRAIN" || supervision.partition !== "TRAIN") {
      throw new UnifiedTrainDataError(
        `group ${group.group_id} has student=${group.partition} supervision=${supervision.partition}; both partitions must be TRAIN`,
      );
    }
    const candidates: EncodedCandidate[] = group.candidates.map(candidate => ({
      candidateRef: candidate.candidateRef,
      input: candidate.input,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
    }));
    const refs = new Set(candidates.map(candidate => candidate.candidateRef));
    if (!supervision.labelMissing) {
      if (supervision.goldAllowedCandidateRefs.length === 0) {
        throw new UnifiedTrainDataError(`empty A_g for ${group.group_id}`);
      }
      for (const ref of supervision.goldAllowedCandidateRefs) {
        if (!refs.has(ref)) throw new UnifiedTrainDataError(`A_g ref ${ref} outside S_g for ${group.group_id}`);
      }
    } else {
      continue;
    }
    groups.push({ groupRef: group.group_id, candidates, allowedCandidateRefs: supervision.goldAllowedCandidateRefs });
  }
  if (groups.length === 0) throw new UnifiedTrainDataError("no trainable groups");
  return groups;
}

function maxAbsGrad(previous: UnifiedTensors, next: UnifiedTensors, learningRate: number): number {
  let max = 0;
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const a = previous[key];
    const b = next[key];
    for (let i = 0; i < a.length; i += 1) {
      const delta = Math.abs((b[i] ?? 0) - (a[i] ?? 0)) / learningRate;
      if (delta > max) max = delta;
    }
  }
  return max;
}

function cloneMutable(tensors: UnifiedTensors): MutableUnifiedTensors {
  return {
    W1: [...tensors.W1],
    b1: [...tensors.b1],
    W2: [...tensors.W2],
    b2: [...tensors.b2],
    W3: [...tensors.W3],
    b3: [...tensors.b3],
  };
}

export function runUnifiedTraining(
  groups: readonly EncodedGroup[],
  config: UnifiedTrainConfig,
  options: UnifiedTrainingRunOptions = {},
): { readonly report: UnifiedTrainReport; readonly tensors: UnifiedTensors } {
  validateUnifiedTrainConfig(config);
  if (groups.length === 0) throw new UnifiedTrainDataError("no trainable groups");
  const epochsThisRun = options.epochsThisRun;
  if (
    epochsThisRun !== undefined
    && (!Number.isInteger(epochsThisRun) || epochsThisRun <= 0)
  ) {
    throw new TypeError("epochsThisRun must be a positive integer");
  }
  const tensors: MutableUnifiedTensors = options.resumeFrom !== undefined
    ? cloneTensors(options.resumeFrom.tensors)
    : createXavierTensors(config.seed);
  const epochs: UnifiedTrainEpochRecord[] = [];
  const violations: string[] = [];
  let startEpoch = 0;
  if (options.resumeFrom !== undefined) {
    assertResumeRecipeCompatible(options.resumeFrom, config);
    startEpoch = options.resumeFrom.completedEpochs;
    if (startEpoch >= config.maxEpochs) {
      throw new UnifiedTrainDataError(
        `checkpoint is already at completedEpochs=${startEpoch} of maxEpochs=${config.maxEpochs}`,
      );
    }
    epochs.push(...options.resumeFrom.epochRecords);
    violations.push(...options.resumeFrom.violations);
  }
  const endEpoch = epochsThisRun === undefined
    ? config.maxEpochs
    : Math.min(config.maxEpochs, startEpoch + epochsThisRun);
  let stopReason: UnifiedStopReason =
    endEpoch >= config.maxEpochs ? "epoch_limit_exhausted" : "invocation_budget_exhausted";

  for (let epoch = startEpoch; epoch < endEpoch; epoch += 1) {
    const before = cloneMutable(tensors);
    let result: EpochResult;
    try {
      result = fullBatchEpochStep(tensors, groups, config.learningRate);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      epochs.push({ epoch, epochLoss: Number.NaN, finite: false, maxAbsGrad: Number.NaN });
      violations.push(`epoch ${epoch} produced non-finite scores: ${message}`);
      stopReason = "non_finite";
      break;
    }
    const finite = Number.isFinite(result.loss);
    const grad = finite ? maxAbsGrad(before, tensors, config.learningRate) : Number.NaN;
    epochs.push({ epoch, epochLoss: result.loss, finite, maxAbsGrad: grad });
    if (!finite || !Number.isFinite(grad)) {
      violations.push(`epoch ${epoch} produced a non-finite loss or gradient`);
      stopReason = "non_finite";
      break;
    }
  }

  const losses = epochs.filter(record => record.finite).map(record => record.epochLoss);
  let monotonicViolations = 0;
  let firstMonotonicViolationEpoch: number | null = null;
  for (let i = 1; i < losses.length; i += 1) {
    if ((losses[i] as number) > (losses[i - 1] as number)) {
      monotonicViolations += 1;
      if (firstMonotonicViolationEpoch === null) firstMonotonicViolationEpoch = epochs[i]?.epoch ?? null;
    }
  }
  const decileStart = Math.max(0, losses.length - Math.max(1, Math.ceil(losses.length * 0.1)));
  let deltaSum = 0;
  let deltaCount = 0;
  for (let i = Math.max(1, decileStart); i < losses.length; i += 1) {
    deltaSum += Math.abs((losses[i] as number) - (losses[i - 1] as number));
    deltaCount += 1;
  }
  const report: UnifiedTrainReport = {
    schema: "nnanything.unified.train-report.v1",
    status:
      stopReason === "non_finite"
        ? "failed"
        : stopReason === "invocation_budget_exhausted"
          ? "paused"
          : "completed",
    stopReason,
    completedEpochs: epochs.length,
    initialLoss: losses.length > 0 ? (losses[0] as number) : null,
    finalLoss: losses.length > 0 ? (losses[losses.length - 1] as number) : null,
    lastDecileMeanAbsDelta: deltaCount > 0 ? deltaSum / deltaCount : null,
    monotonicViolations,
    firstMonotonicViolationEpoch,
    groupCount: groups.length,
    epochs,
    violations,
  };
  return { report, tensors: tensors as UnifiedTensors };
}

export async function saveUnifiedTrainPackage(
  packagePath: string,
  config: UnifiedTrainConfig,
  tensors: UnifiedTensors,
): Promise<UnifiedModelPackage> {
  const pkg = createUnifiedModelPackage({
    modelId: config.modelId,
    version: config.version,
    route: config.route,
    tensors,
    resources: config.resources,
  });
  await saveUnifiedModelPackageAtomic(packagePath, pkg);
  return pkg;
}

export async function saveUnifiedTrainingCheckpoint(
  checkpointPath: string,
  config: UnifiedTrainConfig,
  report: UnifiedTrainReport,
  tensors: UnifiedTensors,
): Promise<UnifiedTrainingCheckpoint> {
  const checkpoint = createUnifiedTrainingCheckpoint({
    config,
    completedEpochs: report.completedEpochs,
    epochRecords: report.epochs,
    violations: report.violations,
    tensors,
  });
  await saveUnifiedTrainingCheckpointAtomic(checkpointPath, checkpoint);
  return checkpoint;
}

export interface UnifiedPackageReloadReceipt {
  readonly packagePath: string;
  readonly modelId: string;
  readonly version: string;
  readonly tensorsMatch: boolean;
  readonly thresholdsPath: string;
  readonly missingModeTablePath: string;
}

export async function verifyUnifiedTrainPackageReload(
  packagePath: string,
  expected: UnifiedModelPackage,
): Promise<UnifiedPackageReloadReceipt> {
  const loaded = await loadUnifiedModelPackageFromFile(packagePath);
  let tensorsMatch = true;
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const a = expected.tensors[key];
    const b = loaded.package.tensors[key];
    if (a.length !== b.length) {
      tensorsMatch = false;
      break;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        tensorsMatch = false;
        break;
      }
    }
    if (!tensorsMatch) break;
  }
  if (!tensorsMatch) throw new UnifiedTrainDataError("reloaded package tensors differ from the saved package");
  return {
    packagePath: loaded.packagePath,
    modelId: loaded.package.modelId,
    version: loaded.package.version,
    tensorsMatch,
    thresholdsPath: loaded.resolvedResources.thresholdsPath,
    missingModeTablePath: loaded.resolvedResources.missingModeTablePath,
  };
}

function parseJsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as unknown);
}

const FORBIDDEN_STUDENT_FIELD_PATTERN = /^(?:gold|allowed|teacher|label|oracle|unknownReason)/i;

function forbiddenStudentFields(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).filter(field => FORBIDDEN_STUDENT_FIELD_PATTERN.test(field));
}

function forbiddenSupervisionFields(record: Readonly<object>): readonly string[] {
  return Object.keys(record).filter(field => field === "x" || field === "input");
}

export async function loadStudentRowsFile(rowsPath: string): Promise<readonly StudentGroup[]> {
  const records = parseJsonl(await readFile(rowsPath, "utf8")) as readonly (Record<string, unknown> & {
    readonly group_id: string;
    readonly sampleId: string;
    readonly sourceGroup: string;
    readonly candidateRef: string;
    readonly optionSemantics: string;
    readonly candidateKind: StudentCandidateRow["candidateKind"];
    readonly x: readonly number[];
    readonly missingMode?: unknown;
  })[];
  const groups = new Map<string, {
    readonly group_id: string;
    readonly sampleId: string;
    readonly requestRef: string;
    readonly sourceGroup: string;
    readonly language: string;
    readonly adapterRef: string;
    readonly derivationFamily: string;
    readonly semanticStratum: string;
    readonly stepContextRef: string;
    readonly candidateGroupRef: string;
    readonly featureSchemaVersion: string;
    readonly encoderVersion: string;
    readonly partition: StudentGroup["partition"];
    readonly candidateEnumeration: StudentGroup["candidateEnumeration"];
    readonly coverageCursorRef: string;
    readonly evidenceRefs: readonly string[];
    readonly failureMode: string | null;
    candidates: StudentCandidateRow[];
  }>();
  for (const record of records) {
    if (record.schema !== UNIFIED_STUDENT_ROW_SCHEMA) {
      throw new UnifiedTrainDataError(`student row ${record.group_id} has a wrong schema`);
    }
    if (!record.group_id) throw new UnifiedTrainDataError("student row is missing group_id");
    const forbiddenFields = forbiddenStudentFields(record);
    if (forbiddenFields.length > 0) {
      throw new UnifiedTrainDataError(
        `student row ${record.group_id} carries forbidden field(s): ${forbiddenFields.join(", ")}`,
      );
    }
    if (!Array.isArray(record.x) || record.x.length !== 64) {
      throw new UnifiedTrainDataError(`student row ${record.group_id} does not carry x[64]`);
    }
    let group = groups.get(record.group_id);
    if (!group) {
      group = {
        group_id: record.group_id,
        sampleId: record.sampleId,
        requestRef: String(record.requestRef ?? ""),
        sourceGroup: record.sourceGroup,
        language: String(record.language ?? ""),
        adapterRef: String(record.adapterRef ?? ""),
        derivationFamily: String(record.derivationFamily ?? ""),
        semanticStratum: String(record.semanticStratum ?? ""),
        stepContextRef: String(record.stepContextRef ?? ""),
        candidateGroupRef: String(record.candidateGroupRef ?? ""),
        featureSchemaVersion: String(record.featureSchemaVersion ?? ""),
        encoderVersion: String(record.encoderVersion ?? ""),
        partition: record.partition as StudentGroup["partition"],
        candidateEnumeration:
          record.candidateEnumeration === "truncated" || record.candidateEnumeration === "enumeration_failed"
            ? record.candidateEnumeration
            : "complete",
        coverageCursorRef: String(record.coverageCursorRef ?? ""),
        evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs as readonly string[] : [],
        failureMode: (record.failureMode ?? null) as string | null,
        candidates: [],
      };
      groups.set(record.group_id, group);
    }
    // Historical compatibility path: derive missingMode from x's -1 slots.
    let missingMode: readonly EncoderMissingMode[];
    if (record.missingMode === undefined) {
      missingMode = record.x.flatMap((value, slotIndex): EncoderMissingMode[] =>
        value === -1
          ? [{
              block: `G${Math.floor(slotIndex / 8)}` as EncoderMissingMode["block"],
              fieldRef: `${record.candidateRef}:slot${slotIndex}`,
              reason: "not_requested" as const,
              slotIndex,
              fill: -1 as const,
            }]
          : []
      );
    } else {
      missingMode = record.missingMode as readonly EncoderMissingMode[];
      const check = validateMissingModeConsistency(record.x, missingMode);
      if (!check.ok) {
        throw new UnifiedTrainDataError(
          `student row ${record.group_id} candidate ${record.candidateRef} invalid missingMode: ${check.message}`,
        );
      }
    }
    group.candidates.push({
      candidateRef: record.candidateRef,
      optionSemantics: record.optionSemantics,
      candidateKind: record.candidateKind,
      input: record.x,
      missingMode,
    });
  }
  return [...groups.values()].map(group => ({ ...group, schema: "nnanything.unified.student-group.v1" })) as unknown as readonly StudentGroup[];
}

export async function loadSupervisionRowsFile(rowsPath: string): Promise<readonly SupervisionRow[]> {
  const records = parseJsonl(await readFile(rowsPath, "utf8")) as readonly SupervisionRow[];
  for (const record of records) {
    if (record.schema !== UNIFIED_SUPERVISION_ROW_SCHEMA) {
      throw new UnifiedTrainDataError(`supervision row ${record.group_id} has a wrong schema`);
    }
    if (!record.group_id) throw new UnifiedTrainDataError("supervision row is missing group_id");
    const forbiddenFields = forbiddenSupervisionFields(record);
    if (forbiddenFields.length > 0) {
      throw new UnifiedTrainDataError(
        `supervision row ${record.group_id} carries forbidden field(s): ${forbiddenFields.join(", ")}`,
      );
    }
  }
  return records;
}
