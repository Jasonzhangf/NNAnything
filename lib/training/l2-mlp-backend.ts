/**
 * Explicit batched compute backends for the experimental L2 four-head MLP.
 *
 * This module adds a batch-CPU and a GPU path next to the existing per-row
 * Handwired reference path without changing it. `runBackendFit` accepts the same
 * fit input as `fitL2Mlp` plus an explicit backend choice, so a caller cannot
 * fall into a faster path by accident:
 *
 *   reference-cpu  the existing per-row Handwired circuit (baseline, delegated)
 *   batch-cpu      batched float32 tensors on the CPU through the torch bridge
 *   gpu            batched float32 tensors on Apple MPS through the same bridge
 *
 * Every head keeps its own three dense layers, parameter layout, label order,
 * ReLU, allowed-set loss, SGD update and frozen-head rule. Identical
 * `(features, allowed)` rows on a trained head are merged into one weighted
 * group: the group is evaluated once, its loss and gradient are weighted by the
 * original repeat count, and the loss denominator stays the original row count.
 * That merge is mathematically equal to the expanded loop and never becomes the
 * equal-group reweighting experiment.
 *
 * The bridge is a resident Python process per fit. It performs a real device
 * self check (allocate, multiply, synchronize, read finite values back). When
 * the requested device is unavailable the call rejects with a message starting
 * `L2 GPU backend unavailable:`; it never falls back to another device.
 *
 * Synchronous inference cannot spawn a process per decision, so `inferHead`
 * keeps a small float32 matrix forward pass in JS. It is forward-only: no
 * gradient, no optimizer, no training state.
 */

import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { L2_HEADS } from "../adapters/l2/contracts.js";
import type {
  L2FitInput,
  L2FitResult,
  L2Head,
  L2HeadSpec,
  L2MlpHeadProfile,
  L2MlpProfile,
  L2Prediction,
  L2Specs,
} from "../adapters/l2/contracts.js";
import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import { fitL2Mlp, readWarmStartProfile } from "./l2-mlp.js";

export type L2ComputeBackend = "reference-cpu" | "batch-cpu" | "gpu";

export interface L2BackendOptions {
  /** Explicit backend selection; defaults to `batch-cpu`. */
  readonly computeBackend?: L2ComputeBackend;
  /** Merge identical `(features, allowed)` rows on a trained head. Default true. */
  readonly deduplicateIdenticalRows?: boolean;
  /** Python interpreter holding torch; defaults to NN_L2_PYTHON_BIN or python3.13. */
  readonly pythonBin?: string;
  /** Path of the bridge script; defaults to the sibling l2-gpu-bridge.py. */
  readonly bridgePath?: string;
  /** Hard limit for one bridge process, in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
  /** Absolute checkpoint path. Omitted means this run is not restartable. */
  readonly checkpointPath?: string;
  /** Persist a complete update-boundary checkpoint every N updates. */
  readonly checkpointEverySteps?: number;
  /** Restore the committed checkpoint at `checkpointPath` and continue its budget. */
  readonly resume?: boolean;
  /**
   * Bounded run: perform at most this many updates in this process while keeping
   * the declared `epochs` budget. Used to prove J-then-K resumption.
   */
  readonly updatesThisRun?: number;
  /** Explicit training-material reference stored in the checkpoint. */
  readonly dataRef?: Readonly<Record<string, unknown>>;
  /** Explicit recipe reference stored in the checkpoint. */
  readonly recipeRef?: Readonly<Record<string, unknown>>;
  /** Receives every typed progress/state/error event while the fit runs. */
  readonly onProgress?: (event: L2TrainingEvent) => void;
  /**
   * External event stream (recovery-observability-amendment.md §3.4): when set,
   * the JS host appends every raw `L2TrainingEvent` to this path as NDJSON while
   * the fit runs. The file grows before the fit promise resolves. `onProgress`
   * and this stream both carry the complete per-step events; display throttling,
   * if any, never drops raw events here.
   */
  readonly eventLogPath?: string;
  /**
   * Programmable cancellation. On abort the bridge receives SIGTERM, commits the
   * last complete update boundary, reports `paused_or_cancelled` and settles the
   * fit with its checkpoint intact. Never interrupts a single update in flight.
   */
  readonly signal?: AbortSignal | undefined;
}
export type L2BackendFitInput = L2FitInput & L2BackendOptions;

/** Explicit training states. Nothing is inferred from logs. */
export type L2TrainingState =
  | "init"
  | "running"
  | "saving"
  | "paused_or_cancelled"
  | "completed"
  | "failed";

export type L2TrainingPhase =
  | "initialize"
  | "data_prepare"
  | "device_load"
  | "first_compute"
  | "update"
  | "save_checkpoint"
  | "evaluate"
  | "reload"
  | "complete"
  | "cancelled";

export interface L2TrainingError {
  readonly kind: "numeric" | "device" | "save" | "resume" | "protocol" | "cancelled" | "internal";
  readonly message: string;
  readonly phase: L2TrainingPhase;
  readonly completedUpdates: number;
  readonly lastPersistedStep: number | null;
  /**
   * Present only when a boundary save attempted while reporting this failure did
   * not succeed. The reported failure is the original one; this keeps the save
   * failure from being mistaken for it.
   */
  readonly boundarySaveError?: string;
}

export interface L2TrainingEvent {
  readonly type: "phase" | "step" | "checkpoint" | "error";
  readonly runId: string;
  readonly state: L2TrainingState;
  readonly phase: L2TrainingPhase;
  /** `start`/`end`/`failed` for phase records; absent for step records. */
  readonly stageStatus?: "start" | "end" | "failed";
  readonly trainedHeads: readonly string[];
  /** Global completed updates (0..totalUpdates); resume continues from J. */
  readonly completedUpdates: number;
  readonly totalUpdates: number;
  /** `pre_update` = loss measured before this step's parameter update. */
  readonly lossWindow?: "pre_update" | "post_fit";
  readonly recentMeanLoss?: number | undefined;
  readonly recentLossByHead?: Readonly<Record<string, number | null>> | undefined;
  /** Duration of one step or one stage, milliseconds (MPS sync included). */
  readonly stepMs?: number | undefined;
  readonly elapsedMs: number;
  readonly device: string;
  readonly lastPersistedStep: number | null;
  readonly etaMs?: number | null | undefined;
  /**
   * Data the step was trained on, taken from the request `dataRef`: a compact
   * summary of source, partition and row/group counts. Never carries parameters.
   */
  readonly dataSource?: Readonly<Record<string, unknown>> | undefined;
  /** Declared save cadence in updates; null when checkpointing is off. */
  readonly persistInterval?: number | null | undefined;
  readonly checkpointPath?: string | undefined;
  readonly previousPath?: string | null | undefined;
  readonly restoredFrom?: string | null | undefined;
  /** Step the resumed run continues after; only on the reload stage. */
  readonly restoredStep?: number | null | undefined;
  readonly error?: L2TrainingError | undefined;
}

export interface L2GroupedHead {
  readonly head: L2Head;
  /** Expanded rows: one entry per original training row. */
  readonly rawRowCount: number;
  /** Merged rows: one entry per distinct `(features, sorted allowed)` group. */
  readonly uniqueGroupCount: number;
  readonly groups: readonly L2RowGroup[];
}
export interface L2RowGroup {
  /** Representative row id, used when reporting a non-finite value. */
  readonly id: string;
  /** Every merged row id, in input order. */
  readonly memberRowIds: readonly string[];
  readonly features: readonly number[];
  readonly allowed: readonly number[];
  /** Original repeat count; the group is weighted by this value. */
  readonly weight: number;
}

export interface L2BackendFitResult extends L2FitResult {
  readonly backend: L2ComputeBackend;
  readonly deduplicated: boolean;
  readonly device: string;
  /** Identifier shared by every event of this run. */
  readonly runId?: string | undefined;
  /** Measured phase durations from the backend, in milliseconds. */
  readonly timings?: Readonly<Record<string, number>> | undefined;
  /** Last update boundary committed to disk. */
  readonly lastPersistedStep?: number | null | undefined;
  readonly checkpointPath?: string | null | undefined;
  /** Epoch-zero scores are not recomputed on a resumed run. */
  readonly epochZeroAfterResume?: null;
  /** Committed step this run continued from; `null` for a fresh start. */
  readonly resumedFromStep?: number | null;
  readonly means: {
    readonly rawRowCount: Readonly<Record<L2Head, number>>;
    readonly uniqueGroupCount: Readonly<Record<L2Head, number>>;
  };
}

/** Committed checkpoint record, `nnanything.l2.mlp.checkpoint.v1`. */
export interface L2MlpCheckpointV1 {
  readonly schema: "nnanything.l2.mlp.checkpoint.v1";
  readonly runId: string;
  readonly parameters: Readonly<Record<L2Head, readonly number[]>>;
  readonly structure: Readonly<Record<L2Head, {
    readonly features: readonly string[];
    readonly labels: readonly string[];
    readonly hidden: readonly [number, number];
  }>>;
  readonly trainedHeads: readonly L2Head[];
  readonly completedUpdates: number;
  readonly totalBudget: number;
  readonly learningRate: number;
  readonly optimizer: { readonly kind: "full_batch_sgd"; readonly momentum: 0; readonly state: null };
  readonly randomness: { readonly usedInUpdateLoop: false; readonly seed: number | null };
  readonly dataRef: Readonly<Record<string, unknown>>;
  readonly recipeRef: Readonly<Record<string, unknown>>;
  readonly epochZero: Readonly<Record<L2Head, { readonly correct: number; readonly scored: number }>>;
  readonly trajectory: readonly {
    readonly epoch: number;
    readonly loss: Readonly<Record<string, number | null>>;
    readonly meanLoss: number;
  }[];
  readonly device: string;
  readonly savedAt: string;
}

/**
 * Read a committed checkpoint without touching any training state. Callers use
 * this to inspect a restorable record read-only.
 */
export async function readL2Checkpoint(path: string): Promise<L2MlpCheckpointV1> {
  const { readFile } = await import("node:fs/promises");
  const target = expectNonEmptyString(path, "path");
  const raw = await readFile(target, "utf8");
  const parsed = JSON.parse(raw) as L2MlpCheckpointV1;
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError(`L2 checkpoint at ${target} is not a JSON object`);
  }
  if (parsed.schema !== "nnanything.l2.mlp.checkpoint.v1") {
    throw new TypeError(`L2 checkpoint at ${target} has schema ${JSON.stringify(parsed.schema)}`);
  }
  return parsed;
}

const DEFAULT_PYTHON_BIN = "/opt/homebrew/bin/python3.13";
const DEFAULT_TIMEOUT_MS = 30_000;

function readComputeBackend(value: unknown): L2ComputeBackend {
  if (value === "reference-cpu" || value === "batch-cpu" || value === "gpu") return value;
  // No implicit default: the accelerated backends are experimental and must be
  // chosen explicitly by the caller. `fitL2Mlp` without a backend keeps the
  // handwired reference loop, so no call silently switches compute path.
  throw new TypeError(
    `computeBackend ${JSON.stringify(value)} is not an explicit backend; pass "reference-cpu", "batch-cpu" or "gpu"`,
  );
}

/**
 * Merge identical rows on each trained head. Equality is exact on the float32
 * representation of every feature plus the sorted allowed label index set, and
 * the merged group keeps the original repeat count so the objective and
 * gradient stay identical to the expanded loop.
 */
export function groupTrainingRows(
  input: Pick<L2BackendFitInput, "specs" | "rows" | "trainHeads" | "deduplicateIdenticalRows">,
): readonly L2GroupedHead[] {
  const specs = expectRecord(input.specs, "specs") as unknown as L2Specs;
  const rows = expectArray(input.rows, "rows");
  const trainedHeads = input.trainHeads === undefined ? [...L2_HEADS] : expectArray(input.trainHeads, "trainHeads");
  const deduplicate = input.deduplicateIdenticalRows !== false;
  const buckets = new Map<L2Head, Map<string, { id: string; memberRowIds: string[]; features: number[]; allowed: number[]; weight: number }>>();
  const rawCounts = { R: 0, D: 0, E: 0, A: 0 } as Record<L2Head, number>;
  for (const head of L2_HEADS) buckets.set(head, new Map());
  const trained = new Set<L2Head>(trainedHeads as L2Head[]);
  const seenIds = new Set<string>();

  for (const value of rows) {
    const row = expectRecord(value, "training row");
    const id = expectNonEmptyString(row.id, "row id");
    if (seenIds.has(id)) throw new TypeError(`duplicate training row id ${id}`);
    seenIds.add(id);
    if (row.partition !== "train") throw new TypeError(`row ${id} is not a train partition row`);
    const head = expectNonEmptyString(row.head, `row ${id} head`) as L2Head;
    if (!L2_HEADS.includes(head)) throw new TypeError(`row ${id} head ${head} is not an L2 head`);
    if (!trained.has(head)) throw new TypeError(`row ${id} belongs to frozen head ${head}`);
    const spec = specs[head];
    const features = expectArray(row.features, `row ${id} features`).map((item, index) =>
      expectFiniteNumber(item, `row ${id} feature[${index}]`),
    );
    if (features.length !== spec.features.length) {
      throw new TypeError(`row ${id} head ${head} expects ${spec.features.length} features, received ${features.length}`);
    }
    const allowed = expectArray(row.allowed, `row ${id} allowed`).map((item, index) =>
      expectNonEmptyString(item, `row ${id} allowed[${index}]`),
    );
    if (allowed.length === 0) throw new TypeError(`row ${id} has an empty allowed set`);
    const allowedIndices = allowed.map(label => {
      const index = spec.labels.indexOf(label);
      if (index < 0) throw new TypeError(`row ${id} allowed label ${label} is not a ${head} label`);
      return index;
    }).sort((left, right) => left - right);
    if (new Set(allowedIndices).size !== allowedIndices.length) {
      throw new TypeError(`row ${id} has a duplicate allowed label`);
    }
    rawCounts[head] += 1;
    const key = `${features.map(value => Math.fround(value)).join(",")}|${allowedIndices.join(",")}`;
    const bucket = buckets.get(head)!;
    const existing = bucket.get(key);
    if (existing === undefined) {
      bucket.set(key, { id, memberRowIds: [id], features, allowed: allowedIndices, weight: 1 });
    } else {
      existing.memberRowIds.push(id);
      existing.weight += 1;
    }
  }

  const grouped: L2GroupedHead[] = [];
  for (const head of L2_HEADS) {
    const bucket = buckets.get(head)!;
    const groups = [...bucket.values()].map(entry => ({
      id: entry.id,
      memberRowIds: entry.memberRowIds,
      features: entry.features,
      allowed: entry.allowed,
      weight: entry.weight,
    }));
    if (!deduplicate) {
      const expanded: L2RowGroup[] = [];
      for (const group of groups) {
        for (let repeat = 0; repeat < group.weight; repeat += 1) {
          expanded.push({ ...group, id: group.memberRowIds[repeat]!, weight: 1 });
        }
      }
      grouped.push({ head, rawRowCount: rawCounts[head], uniqueGroupCount: groups.length, groups: expanded });
      continue;
    }
    grouped.push({ head, rawRowCount: rawCounts[head], uniqueGroupCount: groups.length, groups });
  }
  return grouped;
}

function parameterCountFor(spec: L2HeadSpec): number {
  const [hiddenOne, hiddenTwo] = spec.hidden;
  return hiddenOne * spec.features.length + hiddenOne
    + hiddenTwo * hiddenOne + hiddenTwo
    + spec.labels.length * hiddenTwo + spec.labels.length;
}

function resolveBridgePath(explicit: string | undefined): string {
  if (explicit !== undefined) return expectNonEmptyString(explicit, "bridgePath");
  // The TypeScript build only emits JavaScript, so the Python bridge is looked up
  // next to the compiled module first (an installed layout that ships the asset)
  // and then in the source tree that this checkout builds from.
  const compiled = fileURLToPath(new URL("./l2-gpu-bridge.py", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL("../../lib/training/l2-gpu-bridge.py", import.meta.url));
  if (existsSync(source)) return source;
  return compiled;
}

interface BridgeRequest {
  op: "evaluate" | "fit";
  device: "cpu" | "mps";
  learningRate: number;
  epochs: number;
  seed?: number | undefined;
  runId?: string | undefined;
  checkpointPath?: string | null | undefined;
  checkpointEverySteps?: number | undefined;
  resume?: boolean | undefined;
  updatesThisRun?: number | undefined;
  trainedHeads?: readonly string[] | undefined;
  dataRef?: Readonly<Record<string, unknown>> | undefined;
  recipeRef?: Readonly<Record<string, unknown>> | undefined;
  heads: unknown[];
}

interface BridgeFinal {
  ok: boolean;
  device?: string;
  torch?: string;
  lossByHead?: Record<string, number>;
  meanLoss?: number;
  correctByHead?: Record<string, { correct: number; scored: number }>;
  gradient?: Record<string, number[]>;
  positiveActivation?: boolean;
  trajectory?: { epoch: number; loss: Record<string, number>; meanLoss: number }[];
  epochZero?: Record<string, { correct: number; scored: number }>;
  final?: Record<string, { correct: number; scored: number }>;
  finalWeights?: Record<string, number[]>;
  finalLossByHead?: Record<string, number>;
  finalMeanLoss?: number;
  epochsCompleted?: number;
  completedUpdates?: number;
  totalUpdates?: number;
  lastPersistedStep?: number | null;
  checkpointPath?: string;
  previousCheckpointPath?: string;
  selfCheck?: number[][];
  timings?: Readonly<Record<string, number>>;
  stepMsStats?: Readonly<Record<string, number | null>>;
  runId?: string;
  logitsByHead?: Record<string, number[][]>;
  cancelled?: boolean;
  stopReason?: string;
  cancelSignal?: string | null;
  remainingUpdates?: number;
}

interface BridgeErrorRecord {
  kind?: string;
  message?: string;
  phase?: string;
  completedUpdates?: number;
  lastPersistedStep?: number | null;
  boundarySaveError?: string;
}

interface BridgeEventRecord {
  type?: string;
  state?: string;
  phase?: string;
  stageStatus?: string;
  runId?: string;
  trainedHeads?: string[];
  completedUpdates?: number;
  totalUpdates?: number;
  lossWindow?: string;
  recentMeanLoss?: number;
  recentLossByHead?: Record<string, number | null>;
  correctByHead?: Record<string, { correct: number; scored: number }>;
  stepMs?: number;
  elapsedMs?: number;
  device?: string | null;
  lastPersistedStep?: number | null;
  etaMs?: number | null;
  step?: number;
  path?: string;
  previousPath?: string | null;
  writeMs?: number;
  restoredFrom?: string | null;
  restoredStep?: number | null;
  phaseMs?: number;
  error?: BridgeErrorRecord;
}

const L2_TRAINING_PHASES = new Set([
  "initialize", "data_prepare", "device_load", "first_compute", "update",
  "save_checkpoint", "evaluate", "reload", "complete", "cancelled",
]);

function coercePhase(value: string | undefined): L2TrainingPhase {
  if (value !== undefined && L2_TRAINING_PHASES.has(value)) return value as L2TrainingPhase;
  return "initialize";
}

function coerceState(value: string | undefined): L2TrainingState {
  if (value === "init" || value === "running" || value === "saving"
    || value === "paused_or_cancelled" || value === "completed" || value === "failed") {
    return value;
  }
  return "running";
}

function coerceErrorKind(value: string | undefined): L2TrainingError["kind"] {
  if (value === "numeric" || value === "device" || value === "save" || value === "resume"
    || value === "protocol" || value === "cancelled" || value === "internal") {
    return value;
  }
  return "internal";
}

function toTrainingError(record: BridgeErrorRecord | undefined, fallbackPhase: L2TrainingPhase, completed: number, persisted: number | null): L2TrainingError {
  const error = record ?? {};
  return {
    kind: coerceErrorKind(error.kind),
    message: error.message ?? error.kind ?? "L2 backend bridge reported an error",
    phase: coercePhase(error.phase) === "initialize" && error.phase !== undefined
      ? coercePhase(error.phase)
      : (L2_TRAINING_PHASES.has(error.phase ?? "") ? error.phase as L2TrainingPhase : fallbackPhase),
    completedUpdates: error.completedUpdates ?? completed,
    lastPersistedStep: error.lastPersistedStep ?? persisted,
    // Only a real save failure while reporting this error is surfaced; a saved
    // boundary contributes nothing.
    ...(typeof error.boundarySaveError === "string" ? { boundarySaveError: error.boundarySaveError } : {}),
  };
}

/** Per-run correlation fields attached to every step record. */
interface StepCorrelation {
  readonly dataSource: Readonly<Record<string, unknown>>;
  readonly persistInterval: number | null;
}

function toTrainingEvent(
  record: BridgeEventRecord,
  completed: number,
  persisted: number | null,
  correlation?: StepCorrelation,
): L2TrainingEvent {
  const base = {
    runId: record.runId ?? "unknown",
    state: coerceState(record.state),
    phase: coercePhase(record.phase),
    trainedHeads: record.trainedHeads ?? [],
    completedUpdates: record.completedUpdates ?? completed,
    totalUpdates: record.totalUpdates ?? 0,
    elapsedMs: record.elapsedMs ?? 0,
    device: record.device ?? "unknown",
    lastPersistedStep: record.lastPersistedStep ?? persisted,
  };
  if (record.type === "checkpoint") {
    return {
      ...base,
      type: "checkpoint",
      state: "saving",
      phase: "save_checkpoint",
      stageStatus: "end",
      completedUpdates: record.step ?? base.completedUpdates,
      lastPersistedStep: record.step ?? null,
      checkpointPath: record.path,
      previousPath: record.previousPath ?? null,
      stepMs: record.writeMs,
    };
  }
  if (record.type === "error") {
    return {
      ...base,
      type: "error",
      state: "failed",
      error: toTrainingError(record.error, base.phase, base.completedUpdates, base.lastPersistedStep),
    };
  }
  if (record.type === "step") {
    return {
      ...base,
      type: "step",
      state: "running",
      phase: "update",
      lossWindow: (record.lossWindow === "post_fit" ? "post_fit" : "pre_update"),
      recentMeanLoss: record.recentMeanLoss,
      recentLossByHead: record.recentLossByHead,
      stepMs: record.stepMs,
      etaMs: record.etaMs ?? null,
      // Data provenance and save cadence travel with every step so a consumer can
      // relate each update to its material and persistence schedule.
      dataSource: correlation?.dataSource,
      persistInterval: correlation?.persistInterval ?? null,
    };
  }
  // Default: a phase record with an explicit start/end/failed stage status.
  return {
    ...base,
    type: "phase",
    stageStatus: record.stageStatus === "end" || record.stageStatus === "failed" ? record.stageStatus : "start",
    restoredFrom: record.restoredFrom ?? null,
    restoredStep: record.restoredStep ?? null,
    checkpointPath: record.path,
  };
}

/**
 * Run one bridge process and consume its newline-delimited event stream. The
 * stream is the training source of truth: phase, step, checkpoint and error
 * events are forwarded to `onProgress` as they arrive, and the promise settles
 * on the terminal `final` or `error` record. Nothing waits for the process to
 * exit.
 */
function runBridge(
  request: BridgeRequest,
  options: {
    pythonBin: string;
    bridgePath: string;
    timeoutMs: number;
    onProgress?: ((event: L2TrainingEvent) => void) | undefined;
    stepCorrelation?: StepCorrelation | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<BridgeFinal> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.pythonBin, [options.bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    let settled = false;
    let lastCompleted = 0;
    let lastPersisted: number | null = null;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Every failure that leaves the owned child running must reap it, including
    // a malformed record: bounded SIGTERM then SIGKILL escalation, never a
    // fire-and-forget kill.
    const reapChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killer.unref?.();
    };
    const failWith = (kind: L2TrainingError["kind"], message: string, phase: L2TrainingPhase) => {
      if (settled) return;
      const error: L2TrainingError = {
        kind,
        message,
        phase,
        completedUpdates: lastCompleted,
        lastPersistedStep: lastPersisted,
      };
      try {
        options.onProgress?.({
          type: "error",
          runId: "unreported",
          state: "failed",
          phase,
          trainedHeads: [],
          completedUpdates: lastCompleted,
          totalUpdates: 0,
          elapsedMs: 0,
          device: "unknown",
          lastPersistedStep: lastPersisted,
          error,
        });
      } catch {
        // The consumer is already failing; the reject below still reports it.
      }
      settle(() => reject(Object.assign(new Error(`${kind}: ${message}`), { kind, phase })));
    };
    const timer = setTimeout(() => {
      // A watchdog expiry is a protocol failure: ask the bridge to persist its
      // last complete boundary, then force it if it does not exit.
      reapChild();
      failWith("protocol", `L2 backend bridge timed out after ${options.timeoutMs} ms`, "update");
    }, options.timeoutMs);
    // A consumer sink (the raw event log) writes synchronously. If that write
    // fails, the failure must surface as an explicit error and stop the child;
    // it must never escape this stdout handler and take the host down.
    const emitProgress = (event: L2TrainingEvent) => {
      try {
        options.onProgress?.(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reapChild();
        failWith(
          error instanceof Error && (error as { kind?: unknown }).kind === "save" ? "save" : "internal",
          `L2 progress consumer failed: ${message}`,
          coercePhase(event.phase),
        );
        return false;
      }
      return true;
    };
    const handleRecord = (record: BridgeEventRecord) => {
      if (record.completedUpdates !== undefined) lastCompleted = record.completedUpdates;
      if (record.lastPersistedStep !== undefined && record.lastPersistedStep !== null) lastPersisted = record.lastPersistedStep;
      if (record.type === "final") {
        settle(() => resolve(record as unknown as BridgeFinal));
        return;
      }
      if (record.type === "error") {
        const error = toTrainingError(record.error, coercePhase(record.phase), lastCompleted, lastPersisted);
        const delivered = emitProgress({
          ...toTrainingEvent(record, lastCompleted, lastPersisted, options.stepCorrelation),
          type: "error",
        });
        if (delivered) {
          settle(() => reject(Object.assign(new Error(`${error.kind}: ${error.message}`), {
            kind: error.kind,
            phase: error.phase,
          })));
        }
        return;
      }
      emitProgress(toTrainingEvent(record, lastCompleted, lastPersisted, options.stepCorrelation));
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        let record: BridgeEventRecord;
        try {
          record = JSON.parse(line) as BridgeEventRecord;
        } catch {
          // A malformed record is a protocol failure of this owned child: release
          // it before settling, so no orphaned bridge keeps running.
          reapChild();
          failWith("protocol", `L2 backend bridge produced invalid JSON: ${line.slice(0, 200)}`, "update");
          return;
        }
        handleRecord(record);
        if (settled) return;
      }
    });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", error => {
      failWith("device", `L2 GPU backend unavailable: cannot start ${options.pythonBin}: ${error.message}`, "device_load");
    });
    child.on("close", (code) => {
      // A terminal record has already settled this request (final or error), so
      // the close is just the process going away. Nothing more to report: the
      // outcome was decided when the record arrived.
      if (settled) return;
      // Decide the outcome before settling anything. Settling first would set
      // the guard and clear the watchdog, which turned every no-record exit into
      // a promise that never settled. A terminal record that arrived without a
      // trailing newline is the normal exit, so it is parsed here too.
      const trailing = buffer.trim();
      buffer = "";
      if (trailing.length > 0) {
        let record: BridgeEventRecord | null = null;
        try {
          record = JSON.parse(trailing) as BridgeEventRecord;
        } catch {
          record = null;
        }
        if (record !== null && (record.type === "final" || record.type === "error")) {
          handleRecord(record);
          return;
        }
      }
      if (settled) return;
      reapChild();
      failWith(
        /unavailable|MPS|cannot import torch/.test(stderr) ? "device" : "protocol",
        `L2 backend bridge exited ${code} without a final record: ${stderr.trim()}`,
        "update",
      );
    });
    const abortListener = () => {
      // A cancelled fit is a success: the bridge commits its last complete
      // boundary and returns a `final` record; only a missing record is an error.
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    child.on("close", () => {
      options.signal?.removeEventListener("abort", abortListener);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function profileFromParameters(specs: L2Specs, parameters: Readonly<Record<L2Head, readonly number[]>>): L2MlpProfile {
  const heads = {} as Record<L2Head, L2MlpHeadProfile>;
  for (const head of L2_HEADS) {
    heads[head] = { spec: specs[head], parameters: [...parameters[head]] };
  }
  return {
    schema: "nnanything.l2.mlp.v1",
    heads,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
}

/**
 * External raw event stream (recovery-observability-amendment.md §3.4). When
 * `path` is set the host appends every raw `L2TrainingEvent` as one NDJSON line,
 * synchronously, at the moment it is produced. Nothing is buffered until the fit
 * resolves, so an auditor can read steps while training is still running.
 *
 * The sink never truncates the file. A fresh run writes a `run_start` boundary
 * after creating an empty file; a resumed run reuses the existing content and
 * writes a `resume` boundary that names the restored checkpoint, so earlier
 * raw evidence and the resumption point stay readable in one file.
 */
function eventLogSink(path: string | undefined, options: { resume: boolean }): (event: L2TrainingEvent) => void {
  if (path === undefined) return () => {};
  const resolved = expectNonEmptyString(path, "eventLogPath");
  // A boundary line is a file-level record, not a training event: it tells a
  // reader where one run's raw stream starts or where a resumed run continues.
  const writeBoundary = (boundary: "run_start" | "resume", phase: L2TrainingPhase, note: string) => {
    try {
      appendFileSync(resolved, `${JSON.stringify({
        type: "log_boundary",
        boundary,
        phase,
        note,
        at: new Date().toISOString(),
      })}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`event log write failed: ${message}`),
        { kind: "save" as const, phase },
      );
    }
  };
  if (options.resume && existsSync(resolved)) {
    // A resumed run keeps the earlier raw evidence and marks the boundary.
    writeBoundary("resume", "reload",
      "resume on an existing event log: earlier events in this file are preserved");
  } else if (!options.resume && existsSync(resolved) && statSync(resolved).size > 0) {
    // A fresh run must not silently erase another run's raw evidence.
    throw Object.assign(
      new Error(
        `event log write failed: ${resolved} already holds events and this run is not a resume; pass a new path instead of overwriting it`,
      ),
      { kind: "save" as const, phase: "initialize" as const },
    );
  } else {
    // A fresh run starts from an empty file so the trace belongs to this run alone.
    try {
      writeFileSync(resolved, "", "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`event log write failed: ${message}`),
        { kind: "save" as const, phase: "initialize" as const },
      );
    }
    writeBoundary("run_start", "initialize",
      "fresh run: the event log was created empty for this run");
  }
  return event => {
    try {
      appendFileSync(resolved, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`event log write failed: ${message}`),
        { kind: "save" as const, phase: coercePhase(event.phase) },
      );
    }
  };
}

/**
 * Fit the four-head MLP through one explicit backend. The returned profile,
 * trajectory, epoch-zero scores and final scores line up with `fitL2Mlp` field
 * for field so the reference, batch-CPU and GPU runs are directly comparable.
 */
export async function runBackendFit(input: L2BackendFitInput): Promise<L2BackendFitResult> {
  const backend = readComputeBackend(input.computeBackend);
  const deduplicated = input.deduplicateIdenticalRows !== false;
  if (backend === "reference-cpu") {
    // The JS reference loop is the numerical baseline. It reports progress
    // events, but it does not own a checkpoint writer, so restartability is
    // refused explicitly instead of silently dropping the request.
    if (input.checkpointPath !== undefined || input.resume === true) {
      throw Object.assign(
        new Error(
          "L2 reference-cpu backend does not implement checkpoint/resume; pass computeBackend \"batch-cpu\" or \"gpu\"",
        ),
        { kind: "resume" as const, phase: "reload" as const },
      );
    }
    // The branch above refuses checkpoint/resume, so this sink is always fresh.
    const referenceSink = eventLogSink(input.eventLogPath, { resume: false });
    const referenceDataSource = input.dataRef ?? {
      source: "in-memory fit input",
      partition: "train",
      deduplicated,
    };
    const referencePersistInterval = input.checkpointEverySteps !== undefined
      && input.checkpointEverySteps > 0
      ? input.checkpointEverySteps
      : null;
    const result = await fitL2Mlp({
      ...input,
      onProgress: event => {
        // Step records carry data provenance and save cadence on every backend,
        // including this reference loop, so consumers read one schema.
        const enriched: L2TrainingEvent = event.type === "step"
          ? { ...event, dataSource: referenceDataSource, persistInterval: referencePersistInterval }
          : event;
        try {
          referenceSink(enriched);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(`event log write failed: ${message}`), { kind: "save" as const, phase: "init" as const });
        }
        input.onProgress?.(enriched);
      },
    });
    const means = { rawRowCount: { ...result.report.fittedByHead }, uniqueGroupCount: { ...result.report.fittedByHead } } as L2BackendFitResult["means"];
    return { ...result, backend, deduplicated, device: "handwired-reference", means };
  }

  const specs = expectRecord(input.specs, "specs") as unknown as L2Specs;
  const learningRate = expectFiniteNumber(input.learningRate, "learningRate");
  const epochs = expectFiniteNumber(input.epochs, "epochs");
  if (!Number.isInteger(epochs) || epochs < 0) throw new TypeError("epochs must be a nonnegative integer");
  const grouped = groupTrainingRows(input);
  const trained = grouped.filter(group => group.rawRowCount > 0);
  if (trained.length === 0) throw new Error("fit input has no training rows");
  const trainedHeads = trained.map(group => group.head);
  // The accelerated path must keep the same warm-start contract as the reference
  // loop: a profile whose ordered features, labels or hidden sizes differ from the
  // requested specs is refused instead of being reinterpreted as a continuation.
  const parameters = input.initialProfile === undefined
    ? null
    : (readWarmStartProfile(input.initialProfile, specs).heads as Record<L2Head, L2MlpHeadProfile>);
  if (parameters === null) throw new Error("L2 batch backend needs an explicit initial profile");

  const byHead = new Map(trained.map(group => [group.head, group]));
  // All four heads travel to the bridge so the checkpoint can hold complete
  // four-head parameters and real feature/label names. Only `trainedHeads`
  // receive rows and updates; frozen heads carry parameters only.
  const heads = L2_HEADS.map(head => {
    const spec = specs[head];
    const stored = parameters[head].parameters;
    if (stored.length !== parameterCountFor(spec)) {
      throw new TypeError(`head ${head} profile has ${stored.length} parameters, expected ${parameterCountFor(spec)}`);
    }
    const group = byHead.get(head);
    const base = {
      name: head,
      hidden: spec.hidden,
      labels: spec.labels.length,
      structure: {
        features: [...spec.features],
        labels: [...spec.labels],
        hidden: [...spec.hidden],
      },
      parameters: [...stored],
    };
    if (group === undefined) return base;
    return {
      ...base,
      features: group.groups.map(entry => entry.features),
      allowed: group.groups.map(entry => entry.allowed),
      weights: group.groups.map(entry => entry.weight),
      rowCount: group.rawRowCount,
    };
  });

  const rawRowCountByHead = {} as Record<L2Head, number>;
  const uniqueGroupCountByHead = {} as Record<L2Head, number>;
  for (const head of L2_HEADS) {
    const group = byHead.get(head);
    rawRowCountByHead[head] = group?.rawRowCount ?? 0;
    uniqueGroupCountByHead[head] = group?.uniqueGroupCount ?? 0;
  }
  // The material record is the ordered supervision a checkpointed run actually
  // trains on: per head, each deduplicated group's feature values in the float32
  // space the grouping uses, its allowed label indices and its repeat weight.
  // Row and group counts alone cannot separate two different materials, so they
  // stay informative without ever serving as the compatibility test.
  const materialByHead = {} as Record<
    L2Head,
    readonly { features: readonly number[]; allowed: readonly number[]; weight: number }[]
  >;
  for (const head of L2_HEADS) {
    const group = byHead.get(head);
    materialByHead[head] = group === undefined
      ? []
      : group.groups.map(entry => ({
        features: entry.features.map(value => Math.fround(value)),
        allowed: [...entry.allowed],
        weight: entry.weight,
      }));
  }
  const dataRef: Readonly<Record<string, unknown>> = {
    ...(input.dataRef ?? { source: "in-memory fit input", partition: "train" }),
    deduplicated,
    rawRowCountByHead,
    uniqueGroupCountByHead,
    materialByHead,
  };
  // Compact summary of the material each step is trained on. Only counts and
  // labels travel; no rows and no parameters go into a step record.
  const dataSource: Readonly<Record<string, unknown>> = {
    source: dataRef.source,
    partition: dataRef.partition,
    deduplicated: dataRef.deduplicated,
    rawRowCountByHead,
    uniqueGroupCountByHead,
  };
  const recipeRef: Readonly<Record<string, unknown>> = input.recipeRef ?? {
    id: `l2-mlp-four-head-${learningRate}-${epochs}`,
    computeBackend: backend,
  };
  const checkpointPath = input.checkpointPath === undefined
    ? null
    : expectNonEmptyString(input.checkpointPath, "checkpointPath");
  const checkpointEverySteps = input.checkpointEverySteps === undefined
    ? 0
    : expectFiniteNumber(input.checkpointEverySteps, "checkpointEverySteps");
  if (!Number.isInteger(checkpointEverySteps) || checkpointEverySteps < 0) {
    throw new TypeError("checkpointEverySteps must be a nonnegative integer");
  }
  const runId = `l2-fit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const request: BridgeRequest = {
    op: "fit",
    device: backend === "gpu" ? "mps" : "cpu",
    learningRate,
    epochs,
    runId,
    checkpointPath,
    checkpointEverySteps,
    seed: input.seed,
    resume: input.resume === true,
    updatesThisRun: input.updatesThisRun,
    trainedHeads,
    dataRef: dataRef,
    recipeRef: recipeRef,
    heads,
  };
  // The reload stage is the only place that knows the committed step a resumed
  // run continued from, so capture it while forwarding the stream.
  let resumedFromStep: number | null = null;
  const logEvent = eventLogSink(input.eventLogPath, { resume: input.resume === true });
  const stepCorrelation: StepCorrelation = {
    dataSource,
    persistInterval: checkpointEverySteps > 0 ? checkpointEverySteps : null,
  };
  const response = await runBridge(request, {
    pythonBin: input.pythonBin ?? process.env.NN_L2_PYTHON_BIN ?? DEFAULT_PYTHON_BIN,
    bridgePath: resolveBridgePath(input.bridgePath),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stepCorrelation,
    onProgress: event => {
      if (event.type === "phase" && event.phase === "reload" && event.stageStatus === "end") {
        resumedFromStep = event.restoredStep ?? null;
      }
      logEvent(event);
      input.onProgress?.(event);
    },
    signal: input.signal,
  });
  const finalWeights = response.finalWeights ?? {};
  const merged = {} as Record<L2Head, readonly number[]>;
  for (const head of L2_HEADS) {
    const updated = finalWeights[head];
    if (updated === undefined) {
      throw new Error(`L2 batch backend returned no parameters for head ${head}`);
    }
    merged[head] = updated;
  }
  const trajectory = (response.trajectory ?? []).map(entry => ({
    epoch: entry.epoch,
    loss: {
      R: entry.loss.R ?? null,
      D: entry.loss.D ?? null,
      E: entry.loss.E ?? null,
      A: entry.loss.A ?? null,
    } as Record<L2Head, number | null>,
  }));
  const epochZero = response.epochZero ?? {};
  const finalScores = response.final ?? {};
  const zero = {} as Record<L2Head, { correct: number; scored: number }>;
  const last = {} as Record<L2Head, { correct: number; scored: number }>;
  for (const head of L2_HEADS) {
    zero[head] = epochZero[head] ?? { correct: 0, scored: 0 };
    last[head] = finalScores[head] ?? { correct: 0, scored: 0 };
  }
  const changedParameters = (() => {
    let changed = 0;
    for (const head of L2_HEADS) {
      const before = parameters[head].parameters;
      const after = merged[head];
      for (let index = 0; index < before.length; index += 1) {
        if (Math.fround(before[index]!) !== Math.fround(after[index]!)) changed += 1;
      }
    }
    return changed;
  })();
  const means = {
    rawRowCount: Object.fromEntries(grouped.map(group => [group.head, group.rawRowCount])) as Record<L2Head, number>,
    uniqueGroupCount: Object.fromEntries(grouped.map(group => [group.head, group.uniqueGroupCount])) as Record<L2Head, number>,
  };
  return {
    profile: profileFromParameters(specs, merged),
    runId,
    timings: response.timings ?? {},
    lastPersistedStep: response.lastPersistedStep ?? null,
    checkpointPath: response.checkpointPath ?? checkpointPath ?? null,
    // A resumed run declares the boundary it continued from; a fresh run does not.
    resumedFromStep: input.resume === true ? resumedFromStep : null,
    epochZeroAfterResume: null,
    report: {
      trainedHeads,
      initialization: "warm_start",
      fittedRows: grouped.reduce((sum, group) => sum + group.rawRowCount, 0),
      fittedByHead: means.rawRowCount,
      epochZero: zero,
      final: last,
      epochsCompleted: response.epochsCompleted ?? epochs,
      stopped: "epochs_exhausted",
      trajectory,
      parameterCount: L2_HEADS.reduce((sum, head) => sum + parameterCountFor(specs[head]), 0),
      changedParameters,
      gradientProbe: { checked: 0, passed: true, maxAbsoluteError: 0 },
    },
    backend,
    deduplicated,
    device: response.device ?? (backend === "gpu" ? "mps" : "cpu"),
    means,
  };
}

/**
 * Forward-only float32 inference for one head. The unit's `infer` is a
 * synchronous contract, so this stays in JS; it holds no gradient, no optimizer
 * and no training state.
 */
export function inferHead(
  profile: L2MlpProfile,
  head: L2Head,
  features: readonly number[],
): L2Prediction {
  const spec = profile.heads[head].spec;
  const stored = profile.heads[head].parameters;
  if (features.length !== spec.features.length) {
    throw new TypeError(`head ${head} expects ${spec.features.length} features, received ${features.length}`);
  }
  const [hiddenOne, hiddenTwo] = spec.hidden;
  const labels = spec.labels.length;
  let cursor = 0;
  const take = (count: number): Float32Array => {
    const block = new Float32Array(count);
    for (let index = 0; index < count; index += 1) block[index] = stored[cursor + index]!;
    cursor += count;
    return block;
  };
  const firstWeights = take(hiddenOne * spec.features.length);
  const firstBias = take(hiddenOne);
  const secondWeights = take(hiddenTwo * hiddenOne);
  const secondBias = take(hiddenTwo);
  const readoutWeights = take(labels * hiddenTwo);
  const readoutBias = take(labels);
  const input = new Float32Array(spec.features.length);
  for (let index = 0; index < features.length; index += 1) input[index] = features[index]!;

  const accumulate = (weights: Float32Array, bias: Float32Array, width: number, values: Float32Array, applyRelu: boolean) => {
    const output = new Float32Array(weights.length / width);
    for (let unit = 0; unit < output.length; unit += 1) {
      let sum = bias[unit]!;
      for (let column = 0; column < width; column += 1) {
        sum = Math.fround(sum + Math.fround(weights[unit * width + column]! * values[column]!));
      }
      output[unit] = applyRelu && sum <= 0 ? 0 : sum;
    }
    return output;
  };

  const hiddenOneValues = accumulate(firstWeights, firstBias, input.length, input, true);
  const hiddenTwoValues = accumulate(secondWeights, secondBias, hiddenOne, hiddenOneValues, true);
  const logits = accumulate(readoutWeights, readoutBias, hiddenTwo, hiddenTwoValues, false);
  let best = 0;
  for (let index = 1; index < logits.length; index += 1) {
    if (logits[index]! > logits[best]!) best = index;
  }
  return { head, label: spec.labels[best]!, logits: [...logits] };
}
