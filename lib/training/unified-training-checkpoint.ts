// Independent training checkpoint state for the unified 64-slot route.
//
// The inference package (`nnanything.unified.model-package.v1`) never carries
// optimizer or resume state. This module owns that separate typed state: the
// fixed recipe, completed epochs, epoch loss history, prior violations and the
// parameter tensors at the committed boundary. A checkpoint only restores a fit
// boundary under an identical recipe; it never adopts anything and never
// derives gold from model scores.

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UNIFIED_PARAMETER_COUNTS, type UnifiedTensors } from "./unified-forward.js";
import type {
  ModelRoute,
  UnifiedModelPackageResources,
} from "./unified-model-package.js";
import type { UnifiedTrainConfig, UnifiedTrainEpochRecord } from "./unified-train-config.js";
import { monotonicSeconds, type UnifiedCheckpointIoTiming } from "./unified-timing.js";
import type {
  UnifiedCumulativeTiming,
  UnifiedTimingCutPoint,
} from "./unified-timing.js";

export const UNIFIED_TRAINING_CHECKPOINT_SCHEMA =
  "nnanything.unified.training-checkpoint.v1" as const;

export interface UnifiedTrainingCheckpointRecipe {
  readonly optimizer: "full_batch_sgd";
  readonly momentum: 0;
  readonly learningRate: number;
  readonly seed: number;
  readonly init: "xavier_uniform";
  readonly maxEpochs: number;
}

export interface UnifiedTrainingCheckpoint {
  readonly schema: typeof UNIFIED_TRAINING_CHECKPOINT_SCHEMA;
  readonly modelId: string;
  readonly version: string;
  readonly route: ModelRoute;
  readonly inputSchema: "nnanything.unified-step.v1";
  readonly encoderVersion: string;
  /** The typed resources the checkpoint was trained against; resume must reuse them. */
  readonly resources: UnifiedModelPackageResources;
  readonly architecture: {
    readonly input: 64;
    readonly hidden: readonly [64, 64];
    readonly output: 1;
    readonly activation: "relu";
  };
  readonly recipe: UnifiedTrainingCheckpointRecipe;
  readonly completedEpochs: number;
  /** The fixed recipe has no DEV early stop; this typed slot prevents guessing. */
  readonly earlyStop: { readonly devEarlyStopEnabled: false };
  /**
   * Backwards-compatible committed wall summary. New checkpoints carry the full
   * committed cumulative; historical checkpoints stay null (unrecorded).
   */
  readonly cumulativeTimingSeconds: number | null;
  /** Committed timing ledger; null/unrecorded for historical checkpoints. */
  readonly timing: UnifiedPersistedTiming | null;
  readonly epochRecords: readonly UnifiedTrainEpochRecord[];
  readonly violations: readonly string[];
  readonly tensors: UnifiedTensors;
}

interface UnifiedPersistedTiming {
  readonly cumulative: UnifiedCumulativeTiming;
  readonly timingCutPoint: UnifiedTimingCutPoint;
}

export class UnifiedTrainingCheckpointError extends Error {
  readonly code = "CHECKPOINT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnifiedTrainingCheckpointError";
  }
}

export interface UnifiedTrainingCheckpointInput {
  readonly config: UnifiedTrainConfig;
  readonly completedEpochs: number;
  readonly epochRecords: readonly UnifiedTrainEpochRecord[];
  readonly violations: readonly string[];
  readonly tensors: UnifiedTensors;
  readonly timing?: UnifiedPersistedTiming;
}

export interface UnifiedTrainingCheckpointReloadReceipt {
  readonly checkpointPath: string;
  readonly tensorsMatch: boolean;
  readonly completedEpochs: number;
  readonly epochRecordCount: number;
}

function invalid(message: string): UnifiedTrainingCheckpointError {
  return new UnifiedTrainingCheckpointError(message);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function assertFiniteArray(
  value: unknown,
  label: string,
  expectedLength: number,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw invalid(`${label} must have ${expectedLength} entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw invalid(`${label}[${index}] must be finite`);
    }
  }
  return value as readonly number[];
}

function validateTensors(raw: unknown): UnifiedTensors {
  const tensors = assertObject(raw, "tensors");
  return {
    W1: assertFiniteArray(tensors.W1, "tensors.W1", UNIFIED_PARAMETER_COUNTS.W1),
    b1: assertFiniteArray(tensors.b1, "tensors.b1", UNIFIED_PARAMETER_COUNTS.b1),
    W2: assertFiniteArray(tensors.W2, "tensors.W2", UNIFIED_PARAMETER_COUNTS.W2),
    b2: assertFiniteArray(tensors.b2, "tensors.b2", UNIFIED_PARAMETER_COUNTS.b2),
    W3: assertFiniteArray(tensors.W3, "tensors.W3", UNIFIED_PARAMETER_COUNTS.W3),
    b3: assertFiniteArray(tensors.b3, "tensors.b3", UNIFIED_PARAMETER_COUNTS.b3),
  };
}

function validateRoute(raw: unknown): ModelRoute {
  const route = assertObject(raw, "route");
  const domain = assertNonEmptyString(route.domain, "route.domain");
  const decisionKind = route.decisionKind;
  if (
    decisionKind !== "R"
    && decisionKind !== "D"
    && decisionKind !== "E"
    && decisionKind !== "A"
  ) {
    throw invalid("route.decisionKind must be one of R/D/E/A");
  }
  return { domain, decisionKind };
}

function validateResources(raw: unknown): UnifiedModelPackageResources {
  const resources = assertObject(raw, "resources");
  const thresholdsSchema = assertNonEmptyString(resources.thresholdsSchema, "resources.thresholdsSchema");
  const missingModeSchema = assertNonEmptyString(resources.missingModeSchema, "resources.missingModeSchema");
  if (thresholdsSchema !== "nnanything.feature-thresholds.v1") {
    throw invalid("resources.thresholdsSchema must be nnanything.feature-thresholds.v1");
  }
  if (missingModeSchema !== "nnanything.unified.missing-mode.v1") {
    throw invalid("resources.missingModeSchema must be nnanything.unified.missing-mode.v1");
  }
  const validated = {
    thresholdsRef: assertNonEmptyString(resources.thresholdsRef, "resources.thresholdsRef"),
    thresholdsSchema,
    missingModeTableRef: assertNonEmptyString(
      resources.missingModeTableRef,
      "resources.missingModeTableRef",
    ),
    missingModeSchema,
  };
  if (resources.slotMapRef === undefined) return validated;
  return {
    ...validated,
    slotMapRef: assertNonEmptyString(resources.slotMapRef, "resources.slotMapRef"),
  };
}

function validateArchitecture(
  raw: unknown,
): UnifiedTrainingCheckpoint["architecture"] {
  const architecture = assertObject(raw, "architecture");
  const hidden = architecture.hidden;
  if (!Array.isArray(hidden) || hidden.length !== 2) {
    throw invalid("architecture.hidden must have two entries");
  }
  if (
    architecture.input !== 64
    || architecture.output !== 1
    || architecture.activation !== "relu"
    || hidden[0] !== 64
    || hidden[1] !== 64
  ) {
    throw invalid("architecture must stay 64 -> 64 -> 64 -> 1 (ReLU)");
  }
  return { input: 64, hidden: [64, 64], output: 1, activation: "relu" };
}

function validateRecipe(raw: unknown): UnifiedTrainingCheckpointRecipe {
  const recipe = assertObject(raw, "recipe");
  const optimizer = recipe.optimizer;
  if (optimizer !== "full_batch_sgd") {
    throw invalid("recipe.optimizer must be full_batch_sgd");
  }
  if (recipe.momentum !== 0) {
    throw invalid("recipe.momentum must be 0");
  }
  const learningRate = recipe.learningRate;
  if (typeof learningRate !== "number" || !Number.isFinite(learningRate) || learningRate <= 0) {
    throw invalid("recipe.learningRate must be positive and finite");
  }
  const seed = recipe.seed;
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    throw invalid("recipe.seed must be an integer");
  }
  const init = recipe.init;
  if (init !== "xavier_uniform") {
    throw invalid("recipe.init must be xavier_uniform");
  }
  const maxEpochs = recipe.maxEpochs;
  if (typeof maxEpochs !== "number" || !Number.isInteger(maxEpochs) || maxEpochs <= 0) {
    throw invalid("recipe.maxEpochs must be a positive integer");
  }
  return { optimizer, momentum: 0, learningRate, seed, init, maxEpochs };
}

function validateEarlyStop(raw: unknown): UnifiedTrainingCheckpoint["earlyStop"] {
  const earlyStop = assertObject(raw, "earlyStop");
  if (earlyStop.devEarlyStopEnabled !== false) {
    throw invalid("earlyStop.devEarlyStopEnabled must be false");
  }
  return { devEarlyStopEnabled: false };
}

function validateCumulativeTimingSeconds(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw invalid("cumulativeTimingSeconds must be null or a nonnegative finite number");
  }
  return raw;
}

function validateUnifiedPersistedTiming(raw: unknown): UnifiedPersistedTiming | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("timing must be an object or null");
  }
  const timing = raw as Record<string, unknown>;
  const cumulative = validateCumulativeTiming(timing.cumulative);
  const timingCutPoint = validateTimingCutPoint(timing.timingCutPoint);
  return { cumulative, timingCutPoint };
}

function validateNonnegativeFinite(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw invalid(`${label} must be a nonnegative finite number`);
  }
  return raw;
}

function validateNonnegativeInteger(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw invalid(`${label} must be a nonnegative integer`);
  }
  return raw;
}

function validateCumulativeTiming(raw: unknown): UnifiedCumulativeTiming {
  const cumulative = assertObject(raw, "timing.cumulative");
  const loadSeconds = validateNonnegativeFinite(cumulative.loadSeconds, "timing.cumulative.loadSeconds");
  const dataValidationSeconds = validateNonnegativeFinite(
    cumulative.dataValidationSeconds,
    "timing.cumulative.dataValidationSeconds",
  );
  const optimizationSeconds = validateNonnegativeFinite(
    cumulative.optimizationSeconds,
    "timing.cumulative.optimizationSeconds",
  );
  const totalWallSeconds = validateNonnegativeFinite(
    cumulative.totalWallSeconds,
    "timing.cumulative.totalWallSeconds",
  );
  const optimizerSteps = validateNonnegativeInteger(
    cumulative.optimizerSteps,
    "timing.cumulative.optimizerSteps",
  );
  const processedRows = validateNonnegativeInteger(
    cumulative.processedRows,
    "timing.cumulative.processedRows",
  );
  return {
    loadSeconds,
    dataValidationSeconds,
    optimizationSeconds,
    checkpointIoSecs: validateCheckpointIoTiming(
      cumulative.checkpointIoSecs,
      "timing.cumulative.checkpointIoSecs",
    ),
    totalWallSeconds,
    optimizerSteps,
    processedRows,
  };
}

function validateCheckpointIoTiming(
  raw: unknown,
  label: string,
): UnifiedCheckpointIoTiming {
  const io = assertObject(raw, label);
  const serializeSeconds = validateNonnegativeFinite(io.serializeSeconds, `${label}.serializeSeconds`);
  const atomicReplaceSeconds = validateNonnegativeFinite(
    io.atomicReplaceSeconds,
    `${label}.atomicReplaceSeconds`,
  );
  const packageReloadSeconds = validateNonnegativeFinite(
    io.packageReloadSeconds,
    `${label}.packageReloadSeconds`,
  );
  const totalSeconds = validateNonnegativeFinite(io.totalSeconds, `${label}.totalSeconds`);
  return { serializeSeconds, atomicReplaceSeconds, packageReloadSeconds, totalSeconds };
}

function validateTimingCutPoint(raw: unknown): UnifiedTimingCutPoint {
  const cutPoint = assertObject(raw, "timing.timingCutPoint");
  const committedOptimizerSteps = validateNonnegativeInteger(
    cutPoint.committedOptimizerSteps,
    "timing.timingCutPoint.committedOptimizerSteps",
  );
  const committedProcessedRows = validateNonnegativeInteger(
    cutPoint.committedProcessedRows,
    "timing.timingCutPoint.committedProcessedRows",
  );
  const reason = cutPoint.reason;
  if (reason !== "epoch_commit" && reason !== "paused") {
    throw invalid("timing.timingCutPoint.reason must be epoch_commit or paused");
  }
  return { committedOptimizerSteps, committedProcessedRows, reason };
}

function validateEpochRecords(
  raw: unknown,
): readonly UnifiedTrainEpochRecord[] {
  if (!Array.isArray(raw)) {
    throw invalid("epochRecords must be an array");
  }
  return raw.map((entry, index) => {
    const record = assertObject(entry, `epochRecords[${index}]`);
    const epoch = record.epoch;
    const epochLoss = record.epochLoss;
    const finite = record.finite;
    const maxAbsGrad = record.maxAbsGrad;
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      throw invalid(`epochRecords[${index}].epoch must be a nonnegative integer`);
    }
    if (typeof epochLoss !== "number" || !Number.isFinite(epochLoss)) {
      throw invalid(`epochRecords[${index}].epochLoss must be finite`);
    }
    if (finite !== true) {
      throw invalid(`epochRecords[${index}].finite must be true`);
    }
    if (typeof maxAbsGrad !== "number" || !Number.isFinite(maxAbsGrad)) {
      throw invalid(`epochRecords[${index}].maxAbsGrad must be finite`);
    }
    if (epoch !== index) {
      throw invalid(`epochRecords[${index}].epoch must equal its index ${index}`);
    }
    return { epoch, epochLoss, finite: true, maxAbsGrad };
  });
}

function validateViolations(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw invalid("violations must be an array");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string") {
      throw invalid(`violations[${index}] must be a string`);
    }
    return entry;
  });
}

export function validateUnifiedTrainingCheckpoint(
  raw: unknown,
): UnifiedTrainingCheckpoint {
  const checkpoint = assertObject(raw, "checkpoint");
  if (checkpoint.schema !== UNIFIED_TRAINING_CHECKPOINT_SCHEMA) {
    throw invalid("training checkpoint schema mismatch");
  }
  const completedEpochs = checkpoint.completedEpochs;
  const recipe = validateRecipe(checkpoint.recipe);
  if (
    typeof completedEpochs !== "number"
    || !Number.isInteger(completedEpochs)
    || completedEpochs < 0
    || completedEpochs > recipe.maxEpochs
  ) {
    throw invalid("completedEpochs must be an integer between 0 and recipe.maxEpochs");
  }
  const epochRecords = validateEpochRecords(checkpoint.epochRecords);
  if (epochRecords.length !== completedEpochs) {
    throw invalid("epochRecords must have exactly completedEpochs entries");
  }
  const timing = validateUnifiedPersistedTiming(checkpoint.timing);
  const cumulativeTimingSeconds = validateCumulativeTimingSeconds(
    checkpoint.cumulativeTimingSeconds,
  );
  if (timing === null && cumulativeTimingSeconds !== null) {
    throw invalid("cumulativeTimingSeconds requires a committed timing object");
  }
  if (
    timing !== null
    && cumulativeTimingSeconds !== timing.cumulative.totalWallSeconds
  ) {
    throw invalid("cumulativeTimingSeconds must equal timing.cumulative.totalWallSeconds");
  }
  return {
    schema: UNIFIED_TRAINING_CHECKPOINT_SCHEMA,
    modelId: assertNonEmptyString(checkpoint.modelId, "modelId"),
    version: assertNonEmptyString(checkpoint.version, "version"),
    route: validateRoute(checkpoint.route),
    inputSchema: checkpoint.inputSchema === "nnanything.unified-step.v1"
      ? "nnanything.unified-step.v1"
      : (() => { throw invalid("checkpoint.inputSchema must be nnanything.unified-step.v1"); })(),
    encoderVersion: assertNonEmptyString(checkpoint.encoderVersion, "encoderVersion"),
    resources: validateResources(checkpoint.resources),
    architecture: validateArchitecture(checkpoint.architecture),
    recipe,
    completedEpochs,
    earlyStop: validateEarlyStop(checkpoint.earlyStop),
    cumulativeTimingSeconds,
    timing,
    epochRecords,
    violations: validateViolations(checkpoint.violations),
    tensors: validateTensors(checkpoint.tensors),
  };
}

export function createUnifiedTrainingCheckpoint(
  input: UnifiedTrainingCheckpointInput,
): UnifiedTrainingCheckpoint {
  const config = input.config;
  return validateUnifiedTrainingCheckpoint({
    schema: UNIFIED_TRAINING_CHECKPOINT_SCHEMA,
    modelId: config.modelId,
    version: config.version,
    route: config.route,
    inputSchema: config.inputSchema,
    encoderVersion: config.encoderVersion,
    resources: config.resources,
    architecture: { input: 64, hidden: [64, 64], output: 1, activation: "relu" },
    recipe: {
      optimizer: config.optimizer,
      momentum: 0,
      learningRate: config.learningRate,
      seed: config.seed,
      init: config.init,
      maxEpochs: config.maxEpochs,
    },
    completedEpochs: input.completedEpochs,
    earlyStop: { devEarlyStopEnabled: false },
    cumulativeTimingSeconds: input.timing?.cumulative.totalWallSeconds ?? null,
    timing: input.timing ?? null,
    epochRecords: input.epochRecords,
    violations: input.violations,
    tensors: input.tensors,
  });
}

export interface UnifiedTrainingCheckpointAtomicSaveReceipt {
  readonly checkpointPath: string;
  readonly io: UnifiedCheckpointIoTiming;
}

export async function saveUnifiedTrainingCheckpointAtomicWithTiming(
  checkpointPath: string,
  checkpoint: UnifiedTrainingCheckpoint,
): Promise<UnifiedTrainingCheckpointAtomicSaveReceipt> {
  const startedNs = process.hrtime.bigint();
  const validated = validateUnifiedTrainingCheckpoint(checkpoint);
  const resolved = resolve(checkpointPath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const serializeSeconds = monotonicSeconds(startedNs);
  const atomicStartedNs = process.hrtime.bigint();
  await rename(tempPath, resolved);
  const atomicReplaceSeconds = monotonicSeconds(atomicStartedNs);
  return {
    checkpointPath: resolved,
    io: {
      serializeSeconds,
      atomicReplaceSeconds,
      packageReloadSeconds: 0,
      totalSeconds: serializeSeconds + atomicReplaceSeconds,
    },
  };
}

export async function saveUnifiedTrainingCheckpointAtomic(
  checkpointPath: string,
  checkpoint: UnifiedTrainingCheckpoint,
): Promise<string> {
  const receipt = await saveUnifiedTrainingCheckpointAtomicWithTiming(checkpointPath, checkpoint);
  return receipt.checkpointPath;
}

export async function loadUnifiedTrainingCheckpointFromFile(
  checkpointPath: string,
): Promise<UnifiedTrainingCheckpoint> {
  const resolved = resolve(checkpointPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  } catch (error) {
    throw invalid(
      `training checkpoint is missing or unreadable: ${
        (error as NodeJS.ErrnoException).code ?? String(error)
      }`,
    );
  }
  return validateUnifiedTrainingCheckpoint(raw);
}

export function assertResumeRecipeCompatible(
  checkpoint: UnifiedTrainingCheckpoint,
  config: UnifiedTrainConfig,
): void {
  const mismatch = (field: string, expected: unknown, actual: unknown): void => {
    throw invalid(
      `resume ${field} mismatch: checkpoint=${JSON.stringify(actual)} config=${JSON.stringify(expected)}`,
    );
  };
  if (checkpoint.modelId !== config.modelId) mismatch("modelId", config.modelId, checkpoint.modelId);
  if (checkpoint.version !== config.version) mismatch("version", config.version, checkpoint.version);
  if (
    checkpoint.route.domain !== config.route.domain
    || checkpoint.route.decisionKind !== config.route.decisionKind
  ) {
    mismatch("route", config.route, checkpoint.route);
  }
  if (checkpoint.inputSchema !== config.inputSchema) {
    mismatch("inputSchema", config.inputSchema, checkpoint.inputSchema);
  }
  if (checkpoint.encoderVersion !== config.encoderVersion) {
    mismatch("encoderVersion", config.encoderVersion, checkpoint.encoderVersion);
  }
  const ckptResources = checkpoint.resources;
  const configResources = config.resources;
  if (
    ckptResources.thresholdsRef !== configResources.thresholdsRef
    || ckptResources.thresholdsSchema !== configResources.thresholdsSchema
    || ckptResources.missingModeTableRef !== configResources.missingModeTableRef
    || ckptResources.missingModeSchema !== configResources.missingModeSchema
    || ckptResources.slotMapRef !== configResources.slotMapRef
  ) {
    mismatch("resources", configResources, ckptResources);
  }
  if (checkpoint.recipe.optimizer !== config.optimizer) {
    mismatch("optimizer", config.optimizer, checkpoint.recipe.optimizer);
  }
  if (checkpoint.recipe.learningRate !== config.learningRate) {
    mismatch("learningRate", config.learningRate, checkpoint.recipe.learningRate);
  }
  if (checkpoint.recipe.maxEpochs !== config.maxEpochs) {
    mismatch("maxEpochs", config.maxEpochs, checkpoint.recipe.maxEpochs);
  }
  if (checkpoint.recipe.seed !== config.seed) {
    mismatch("seed", config.seed, checkpoint.recipe.seed);
  }
  if (checkpoint.recipe.init !== config.init) {
    mismatch("init", config.init, checkpoint.recipe.init);
  }
}

function tensorsEqual(left: UnifiedTensors, right: UnifiedTensors): boolean {
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

export async function verifyUnifiedTrainingCheckpointReload(
  checkpointPath: string,
  expected: UnifiedTrainingCheckpoint,
): Promise<UnifiedTrainingCheckpointReloadReceipt> {
  const loaded = await loadUnifiedTrainingCheckpointFromFile(checkpointPath);
  const tensorsMatch = tensorsEqual(expected.tensors, loaded.tensors);
  if (
    !tensorsMatch
    || loaded.completedEpochs !== expected.completedEpochs
    || loaded.epochRecords.length !== expected.epochRecords.length
  ) {
    throw invalid("reloaded training checkpoint differs from the saved checkpoint");
  }
  return {
    checkpointPath: resolve(checkpointPath),
    tensorsMatch,
    completedEpochs: loaded.completedEpochs,
    epochRecordCount: loaded.epochRecords.length,
  };
}
