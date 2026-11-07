// B-A1 fixed training entry: `trainBA1UnifiedRelationDecision`
// (design: b-a1-fixed-training-entry-design.md, subject revision 3).
//
// This entry prepares and implements the fixed B-A1 route:
//   - route/encoder = browser / R / nnanything.browser.b-a1-search-input-host.encoder.v1
//   - loss           = absolute-threshold soft-margin group loss (b-a1-group-loss)
//   - optimizer      = full_batch_sgd, lr 0.01, maxEpochs 200, seed 20261104, xavier_uniform
//
// It reuses the unified tensor shape and forward/backward numerics, but it owns
// its own route package type: the shared unified model package pins
// `encoderVersion` to the generic TS/JS step encoder and rejects any other, so a
// B-A1 package must declare the B-A1 encoder version. Nothing here adopts a
// package, trains against gold, or wires into a product entry.

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertUnifiedTensors,
  cloneTensors,
  createXavierTensors,
  UNIFIED_PARAMETER_COUNTS,
  type MutableUnifiedTensors,
  type UnifiedTensors,
} from "./unified-forward.js";
import type { EncodedCandidate, EncodedGroup } from "./group-loss.js";
import {
  BA1_LOSS_KIND,
  BA1_MARGIN,
  BA1_THETA,
  bA1FullBatchEpochStep,
  bA1ThresholdDiagnosis,
} from "./b-a1-group-loss.js";
import {
  BA1_ARCHITECTURE,
  BA1_ENCODER_VERSION,
  BA1_INPUT_SCHEMA,
  BA1_ROUTE_DECISION_KIND,
  BA1_ROUTE_DOMAIN,
} from "./b-a1-route-encoder.js";

export const BA1_TRAIN_CONFIG_SCHEMA = "nnanything.b-a1-unified.train-config.v1" as const;
export const BA1_STUDENT_ROW_SCHEMA = "nnanything.b-a1-unified.student-row.v1" as const;
export const BA1_SUPERVISION_ROW_SCHEMA = "nnanything.b-a1-unified.supervision-row.v1" as const;
export const BA1_MODEL_PACKAGE_SCHEMA = "nnanything.b-a1-unified.model-package.v1" as const;
export const BA1_CHECKPOINT_SCHEMA = "nnanything.b-a1-unified.training-checkpoint.v1" as const;

export const BA1_LEARNING_RATE = 0.01;
export const BA1_MAX_EPOCHS = 200;
export const BA1_SEED = 20261104;

export type BA1StopReason = "epoch_limit_exhausted" | "non_finite" | "data_invalid";

export interface BA1TrainResources {
  readonly thresholdsRef: string;
  readonly missingModeTableRef: string;
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
  readonly candidates: readonly BA1StudentCandidateRow[];
}

export interface BA1SupervisionRow {
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: string;
  readonly supervisionStatus: string;
  readonly goldAllowedCandidateRefs: readonly string[];
  readonly trainingEligible: boolean;
  readonly evaluationClass: string;
}

export class BA1TrainDataError extends Error {
  readonly code = "DATA_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "BA1TrainDataError";
  }
}

export interface BA1TrainEpochRecord {
  readonly epoch: number;
  readonly epochLoss: number;
  readonly finite: boolean;
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

export interface BA1ModelPackage {
  readonly schema: typeof BA1_MODEL_PACKAGE_SCHEMA;
  readonly modelId: string;
  readonly version: string;
  readonly route: { readonly domain: typeof BA1_ROUTE_DOMAIN; readonly decisionKind: typeof BA1_ROUTE_DECISION_KIND };
  readonly inputSchema: typeof BA1_INPUT_SCHEMA;
  readonly encoderVersion: typeof BA1_ENCODER_VERSION;
  readonly architecture: typeof BA1_ARCHITECTURE;
  readonly tensors: UnifiedTensors;
  readonly outputContract: { readonly kind: "scalar-score"; readonly groupNormalization: "outside-model" };
  readonly resources: BA1TrainResources;
  readonly fixedStages: readonly string[];
}

export interface BA1TrainingCheckpoint {
  readonly schema: typeof BA1_CHECKPOINT_SCHEMA;
  readonly modelId: string;
  readonly version: string;
  readonly route: { readonly domain: typeof BA1_ROUTE_DOMAIN; readonly decisionKind: typeof BA1_ROUTE_DECISION_KIND };
  readonly encoderVersion: typeof BA1_ENCODER_VERSION;
  readonly architecture: typeof BA1_ARCHITECTURE;
  readonly resources: BA1TrainResources;
  readonly recipe: {
    readonly optimizer: "full_batch_sgd";
    readonly learningRate: number;
    readonly maxEpochs: number;
    readonly seed: number;
    readonly init: "xavier_uniform";
    readonly loss: { readonly kind: typeof BA1_LOSS_KIND; readonly theta: number; readonly margin: number };
  };
  readonly completedEpochs: number;
  readonly epochRecords: readonly BA1TrainEpochRecord[];
  readonly violations: readonly string[];
  readonly tensors: UnifiedTensors;
}

export interface BA1TrainReceipt {
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly packageOutPath: string;
  readonly checkpointOutPath: string | null;
  readonly packageReload: {
    readonly tensorsMatch: boolean;
    readonly route: { readonly domain: string; readonly decisionKind: string };
    readonly encoderVersion: string;
    readonly resourcesMatch: boolean;
  };
}

export interface BA1TrainResult {
  readonly report: BA1TrainReport;
  readonly package: BA1ModelPackage;
  readonly receipt: BA1TrainReceipt;
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
  if (!Number.isFinite(config.learningRate) || config.learningRate <= 0) {
    throw new TypeError("learningRate must be positive and finite");
  }
  if (!Number.isInteger(config.maxEpochs) || config.maxEpochs <= 0) throw new TypeError("maxEpochs must be a positive integer");
  if (!Number.isInteger(config.seed)) throw new TypeError("seed must be an integer");
  if (typeof config.modelId !== "string" || config.modelId.length === 0) throw new TypeError("modelId must be a non-empty string");
  if (typeof config.version !== "string" || config.version.length === 0) throw new TypeError("version must be a non-empty string");
  for (const key of ["thresholdsRef", "missingModeTableRef", "slotMapRef"] as const) {
    const ref = config.resources[key];
    if (typeof ref !== "string" || ref.length === 0) throw new TypeError(`resources.${key} must be a non-empty string`);
  }
}

function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const groups = new Map<string, { group_id: string; sampleId: string; sourceGroup: string; partition: string; candidates: BA1StudentCandidateRow[] }>();
  for (const raw of records) {
    if (!isRecord(raw)) throw new BA1TrainDataError("student row is not an object");
    if (raw.schema !== BA1_STUDENT_ROW_SCHEMA) throw new BA1TrainDataError(`student row ${String(raw.group_id)} has a wrong schema`);
    const groupId = raw.group_id;
    if (typeof groupId !== "string" || groupId.length === 0) throw new BA1TrainDataError("student row is missing group_id");
    const forbidden = forbiddenStudentFields(raw);
    if (forbidden.length > 0) throw new BA1TrainDataError(`student row ${groupId} carries forbidden field(s): ${forbidden.join(", ")}`);
    if (raw.candidateKind !== "relation") throw new BA1TrainDataError(`student row ${groupId} candidateKind must be relation`);
    if (raw.optionSemantics !== "select") throw new BA1TrainDataError(`student row ${groupId} optionSemantics must be select`);
    if (!Array.isArray(raw.x) || raw.x.length !== 64) throw new BA1TrainDataError(`student row ${groupId} does not carry x[64]`);
    if (!raw.x.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new BA1TrainDataError(`student row ${groupId} x[64] must be strictly finite`);
    }
    const missingMode = Array.isArray(raw.missingMode) ? raw.missingMode : [];
    const candidateRef = raw.candidateRef;
    if (typeof candidateRef !== "string" || candidateRef.length === 0) {
      throw new BA1TrainDataError(`student row ${groupId} is missing candidateRef`);
    }
    let group = groups.get(groupId);
    if (!group) {
      group = {
        group_id: groupId,
        sampleId: String(raw.sampleId ?? ""),
        sourceGroup: String(raw.sourceGroup ?? ""),
        partition: String(raw.partition ?? ""),
        candidates: [],
      };
      groups.set(groupId, group);
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
  for (const raw of records) {
    if (!isRecord(raw)) throw new BA1TrainDataError("supervision row is not an object");
    if (raw.schema !== BA1_SUPERVISION_ROW_SCHEMA) throw new BA1TrainDataError(`supervision row ${String(raw.group_id)} has a wrong schema`);
    const groupId = raw.group_id;
    if (typeof groupId !== "string" || groupId.length === 0) throw new BA1TrainDataError("supervision row is missing group_id");
    const forbidden = forbiddenSupervisionFields(raw);
    if (forbidden.length > 0) throw new BA1TrainDataError(`supervision row ${groupId} carries forbidden field(s): ${forbidden.join(", ")}`);
    if (!Array.isArray(raw.goldAllowedCandidateRefs) || !raw.goldAllowedCandidateRefs.every(ref => typeof ref === "string")) {
      throw new BA1TrainDataError(`supervision row ${groupId} goldAllowedCandidateRefs must be an array of strings`);
    }
    rows.push({
      group_id: groupId,
      sampleId: String(raw.sampleId ?? ""),
      sourceGroup: String(raw.sourceGroup ?? ""),
      partition: String(raw.partition ?? ""),
      supervisionStatus: String(raw.supervisionStatus ?? ""),
      goldAllowedCandidateRefs: raw.goldAllowedCandidateRefs as readonly string[],
      trainingEligible: raw.trainingEligible === true,
      evaluationClass: String(raw.evaluationClass ?? ""),
    });
  }
  return rows;
}

export function buildBA1EncodedGroups(
  studentGroups: readonly BA1StudentGroup[],
  supervisionRows: readonly BA1SupervisionRow[],
): readonly EncodedGroup[] {
  const supervisionByGroup = new Map(supervisionRows.map(row => [row.group_id, row]));
  const groups: EncodedGroup[] = [];
  const seen = new Set<string>();
  for (const group of studentGroups) {
    if (seen.has(group.group_id)) throw new BA1TrainDataError(`duplicate group ${group.group_id}`);
    seen.add(group.group_id);
    const supervision = supervisionByGroup.get(group.group_id);
    if (!supervision) throw new BA1TrainDataError(`missing supervision for ${group.group_id}`);
    if (group.partition !== "TRAIN" || supervision.partition !== "TRAIN") {
      throw new BA1TrainDataError(`group ${group.group_id} must be partition=TRAIN on both student and supervision rows`);
    }
    if (supervision.trainingEligible !== true) {
      throw new BA1TrainDataError(`group ${group.group_id} is not training-eligible`);
    }
    const candidates: EncodedCandidate[] = group.candidates.map(candidate => ({
      candidateRef: candidate.candidateRef,
      input: candidate.x,
      optionSemantics: candidate.optionSemantics,
      candidateKind: "relation",
    }));
    const refs = new Set(candidates.map(candidate => candidate.candidateRef));
    if (refs.size !== candidates.length) throw new BA1TrainDataError(`group ${group.group_id} has duplicate candidate refs`);
    if (supervision.goldAllowedCandidateRefs.length === 0) throw new BA1TrainDataError(`empty A_g for ${group.group_id}`);
    for (const ref of supervision.goldAllowedCandidateRefs) {
      if (!refs.has(ref)) throw new BA1TrainDataError(`A_g ref ${ref} outside S_g for ${group.group_id}`);
    }
    groups.push({ groupRef: group.group_id, candidates, allowedCandidateRefs: supervision.goldAllowedCandidateRefs });
  }
  if (groups.length === 0) throw new BA1TrainDataError("no trainable groups");
  return groups;
}

function cloneMutable(tensors: UnifiedTensors): MutableUnifiedTensors {
  return {
    W1: [...tensors.W1], b1: [...tensors.b1], W2: [...tensors.W2],
    b2: [...tensors.b2], W3: [...tensors.W3], b3: [...tensors.b3],
  };
}

function assertTensorsShape(tensors: UnifiedTensors, label: string): void {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const values = tensors[key];
    if (!Array.isArray(values) || values.length !== UNIFIED_PARAMETER_COUNTS[key]) {
      throw new BA1TrainDataError(`${label}.tensors.${key} has the wrong length`);
    }
    if (!values.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new BA1TrainDataError(`${label}.tensors.${key} must be finite`);
    }
  }
}

function buildReport(
  status: BA1TrainReport["status"],
  stopReason: BA1StopReason,
  epochs: readonly BA1TrainEpochRecord[],
  groups: readonly EncodedGroup[],
  tensors: UnifiedTensors,
  violations: readonly string[],
): BA1TrainReport {
  const losses = epochs.filter(record => record.finite).map(record => record.epochLoss);
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
    initialLoss: losses.length > 0 ? (losses[0] as number) : null,
    finalLoss: losses.length > 0 ? (losses[losses.length - 1] as number) : null,
    epochs,
    violations,
  };
}

export async function trainBA1UnifiedRelationDecision(options: {
  readonly config: BA1TrainConfig;
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly packageOutPath: string;
  readonly checkpointOutPath?: string;
}): Promise<BA1TrainResult> {
  validateBA1TrainConfig(options.config);
  const studentGroups = await loadBA1StudentRowsFile(options.studentRowsPath);
  const supervisionRows = await loadBA1SupervisionRowsFile(options.supervisionRowsPath);
  const groups = buildBA1EncodedGroups(studentGroups, supervisionRows);

  const tensors = createXavierTensors(options.config.seed);
  const epochs: BA1TrainEpochRecord[] = [];
  const violations: string[] = [];
  let stopReason: BA1StopReason = "epoch_limit_exhausted";

  for (let epoch = 0; epoch < options.config.maxEpochs; epoch += 1) {
    let epochLoss: number;
    try {
      const result = bA1FullBatchEpochStep(tensors, groups, options.config.learningRate);
      epochLoss = result.loss;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      epochs.push({ epoch, epochLoss: Number.NaN, finite: false });
      violations.push(`epoch ${epoch} produced a non-finite loss: ${message}`);
      stopReason = "non_finite";
      break;
    }
    const finite = Number.isFinite(epochLoss);
    epochs.push({ epoch, epochLoss, finite });
    if (!finite) {
      violations.push(`epoch ${epoch} produced a non-finite loss`);
      stopReason = "non_finite";
      break;
    }
  }

  const stopReasonFinal: BA1StopReason = stopReason;
  const status: BA1TrainReport["status"] = stopReasonFinal === "non_finite" ? "failed" : "completed";
  const report = buildReport(status, stopReasonFinal, epochs, groups, tensors, violations);

  const pkg = createBA1ModelPackage({
    modelId: options.config.modelId,
    version: options.config.version,
    tensors,
    resources: options.config.resources,
  });
  const packageOutPath = await saveBA1ModelPackageAtomic(options.packageOutPath, pkg);
  let checkpointOutPath: string | null = null;
  if (options.checkpointOutPath !== undefined) {
    const checkpoint: BA1TrainingCheckpoint = {
      schema: BA1_CHECKPOINT_SCHEMA,
      modelId: options.config.modelId,
      version: options.config.version,
      route: { domain: BA1_ROUTE_DOMAIN, decisionKind: BA1_ROUTE_DECISION_KIND },
      encoderVersion: BA1_ENCODER_VERSION,
      architecture: BA1_ARCHITECTURE,
      resources: options.config.resources,
      recipe: {
        optimizer: "full_batch_sgd",
        learningRate: options.config.learningRate,
        maxEpochs: options.config.maxEpochs,
        seed: options.config.seed,
        init: "xavier_uniform",
        loss: { kind: BA1_LOSS_KIND, theta: BA1_THETA, margin: BA1_MARGIN },
      },
      completedEpochs: report.completedEpochs,
      epochRecords: report.epochs,
      violations: report.violations,
      tensors,
    };
    checkpointOutPath = await saveBA1CheckpointAtomic(options.checkpointOutPath, checkpoint);
  }

  const reload = await verifyBA1TrainPackageReload(packageOutPath, pkg);
  return {
    report,
    package: pkg,
    receipt: {
      studentRowsPath: resolve(options.studentRowsPath),
      supervisionRowsPath: resolve(options.supervisionRowsPath),
      packageOutPath,
      checkpointOutPath,
      packageReload: reload,
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
  return {
    schema: BA1_MODEL_PACKAGE_SCHEMA,
    modelId: input.modelId,
    version: input.version,
    route: { domain: BA1_ROUTE_DOMAIN, decisionKind: BA1_ROUTE_DECISION_KIND },
    inputSchema: BA1_INPUT_SCHEMA,
    encoderVersion: BA1_ENCODER_VERSION,
    architecture: BA1_ARCHITECTURE,
    tensors: input.tensors,
    outputContract: { kind: "scalar-score", groupNormalization: "outside-model" },
    resources: input.resources,
    fixedStages: input.fixedStages ?? [],
  };
}

export function validateBA1ModelPackage(raw: unknown): BA1ModelPackage {
  if (!isRecord(raw)) throw new BA1TrainDataError("model package must be an object");
  if (raw.schema !== BA1_MODEL_PACKAGE_SCHEMA) throw new BA1TrainDataError("model package schema mismatch");
  if (!isRecord(raw.route) || raw.route.domain !== BA1_ROUTE_DOMAIN || raw.route.decisionKind !== BA1_ROUTE_DECISION_KIND) {
    throw new BA1TrainDataError(`model package route must be ${BA1_ROUTE_DOMAIN}/${BA1_ROUTE_DECISION_KIND}`);
  }
  if (raw.inputSchema !== BA1_INPUT_SCHEMA) throw new BA1TrainDataError(`model package inputSchema must be ${BA1_INPUT_SCHEMA}`);
  if (raw.encoderVersion !== BA1_ENCODER_VERSION) {
    throw new BA1TrainDataError(`model package encoderVersion must be ${BA1_ENCODER_VERSION}; got ${String(raw.encoderVersion)}`);
  }
  if (!isRecord(raw.architecture)) throw new BA1TrainDataError("model package architecture must be an object");
  if (raw.architecture.input !== 64 || raw.architecture.output !== 1 || raw.architecture.activation !== "relu") {
    throw new BA1TrainDataError("model package architecture must be 64/…/1 relu");
  }
  if (!isRecord(raw.tensors)) throw new BA1TrainDataError("model package tensors must be an object");
  assertTensorsShape(raw.tensors as unknown as UnifiedTensors, "modelPackage");
  if (!isRecord(raw.resources)) throw new BA1TrainDataError("model package resources must be an object");
  return raw as unknown as BA1ModelPackage;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<string> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, resolved);
  return resolved;
}

export async function saveBA1ModelPackageAtomic(packagePath: string, pkg: BA1ModelPackage): Promise<string> {
  return writeJsonAtomic(packagePath, validateBA1ModelPackage(pkg));
}

export async function saveBA1CheckpointAtomic(checkpointPath: string, checkpoint: BA1TrainingCheckpoint): Promise<string> {
  return writeJsonAtomic(checkpointPath, checkpoint);
}

export async function loadBA1ModelPackageFromFile(packagePath: string): Promise<BA1ModelPackage> {
  const resolved = resolve(packagePath);
  const raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  return validateBA1ModelPackage(raw);
}

function tensorsMatch(left: UnifiedTensors, right: UnifiedTensors): boolean {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const a = left[key];
    const b = right[key];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function verifyBA1TrainPackageReload(
  packagePath: string,
  expected: BA1ModelPackage,
): Promise<BA1TrainReceipt["packageReload"]> {
  const loaded = await loadBA1ModelPackageFromFile(packagePath);
  const tensorsMatchResult = tensorsMatch(expected.tensors, loaded.tensors);
  if (!tensorsMatchResult) throw new BA1TrainDataError("reloaded package tensors differ from the saved package");
  const resourcesMatch = loaded.resources.thresholdsRef === expected.resources.thresholdsRef
    && loaded.resources.missingModeTableRef === expected.resources.missingModeTableRef
    && loaded.resources.slotMapRef === expected.resources.slotMapRef;
  if (!resourcesMatch) throw new BA1TrainDataError("reloaded package resources differ from the saved package");
  return {
    tensorsMatch: tensorsMatchResult,
    route: { domain: loaded.route.domain, decisionKind: loaded.route.decisionKind },
    encoderVersion: loaded.encoderVersion,
    resourcesMatch,
  };
}

export function cloneBA1Tensors(tensors: UnifiedTensors): UnifiedTensors {
  return cloneTensors(tensors);
}
