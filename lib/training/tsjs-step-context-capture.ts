// Public diagnostic entry for TS/JS retention step-context capture.
//
// This entry runs the real `runTsJsUnifiedMultiStepDecision` selection boundary
// and records the actual `StepContext` plus every legal candidate vector. It is
// a read-only observer: the default product path never depends on it, and it
// never writes weights, gold, adoption, or product wiring.

import type {
  TsJsStepSelectionCapture,
  TsJsUnifiedMultiStepDecisionResult,
} from "../adapters/tsjs-unified-recursive.js";
import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../adapters/tsjs-unified-recursive.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadStepwiseEpisodeFamily } from "./unified-student-converter.js";

export const TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA =
  "nnanything.tsjs.step-context-capture-config.v1" as const;
export const TSJS_STEP_CONTEXT_CAPTURE_RECEIPT_SCHEMA =
  "nnanything.tsjs.step-context-capture-receipt.v1" as const;

export interface TsJsStepContextCaptureLimits {
  readonly maxTransitions?: number;
  readonly maxDepth?: number;
  readonly maxDerivedGoals?: number;
}

export interface TsJsStepContextCaptureConfig {
  readonly schema: typeof TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA;
  readonly packagePath: string;
  readonly familyPath: string;
  readonly sampleId: string;
  readonly outputPath: string;
  readonly sourceRoot?: string;
  readonly limits?: TsJsStepContextCaptureLimits;
}

export interface TsJsStepContextCaptureStepLink {
  readonly stepId: string;
  readonly optionSemantics: string;
  readonly candidateRef: string;
  readonly score: number;
  readonly receiptId: string;
  readonly postStateRef: string;
  readonly previousActionRef: string | null;
  readonly nextStepId: string | null;
}

export interface TsJsStepContextCaptureSuccess {
  readonly status: "completed";
  readonly requestId: string;
  readonly sampleId: string;
  readonly packagePath: string;
  readonly familyPath: string;
  readonly outputPath: string;
  readonly captureCount: number;
  readonly modelBinding: TsJsUnifiedMultiStepDecisionResult["modelBinding"];
  readonly stepCount: number;
  readonly stepLinks: readonly TsJsStepContextCaptureStepLink[];
}

export interface TsJsStepContextCaptureFailure {
  readonly status: "failed";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: unknown;
  };
}

export type TsJsStepContextCaptureResult =
  | TsJsStepContextCaptureSuccess
  | TsJsStepContextCaptureFailure;

function failure(
  code: string,
  message: string,
  detail: unknown = null,
): TsJsStepContextCaptureFailure {
  return { status: "failed", error: { code, message, detail } };
}

function errorDetail(error: unknown): Readonly<{
  readonly code: string | null;
  readonly message: string;
}> {
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`config.${field} must be a non-empty string`);
  }
  return value;
}

function parseLimits(raw: unknown): TsJsStepContextCaptureLimits {
  if (!isRecord(raw)) {
    throw new TypeError("config.limits must be an object when provided");
  }
  const limits: {
    maxTransitions?: number;
    maxDepth?: number;
    maxDerivedGoals?: number;
  } = {};
  for (const field of ["maxTransitions", "maxDepth", "maxDerivedGoals"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new TypeError(`config.limits.${field} must be a positive integer`);
    }
    limits[field] = value;
  }
  return limits;
}

function parseConfig(raw: unknown): TsJsStepContextCaptureConfig {
  if (!isRecord(raw)) {
    throw new TypeError("config must be a JSON object");
  }
  if (raw.schema !== TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA) {
    throw new TypeError(`config.schema must be ${TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA}`);
  }
  const config: {
    schema: typeof TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA;
    packagePath: string;
    familyPath: string;
    sampleId: string;
    outputPath: string;
    sourceRoot?: string;
    limits?: TsJsStepContextCaptureLimits;
  } = {
    schema: TSJS_STEP_CONTEXT_CAPTURE_CONFIG_SCHEMA,
    packagePath: requireNonEmptyString(raw.packagePath, "packagePath"),
    familyPath: requireNonEmptyString(raw.familyPath, "familyPath"),
    sampleId: requireNonEmptyString(raw.sampleId, "sampleId"),
    outputPath: requireNonEmptyString(raw.outputPath, "outputPath"),
  };
  if (raw.sourceRoot !== undefined) {
    config.sourceRoot = requireNonEmptyString(raw.sourceRoot, "sourceRoot");
  }
  if (raw.limits !== undefined) {
    config.limits = parseLimits(raw.limits);
  }
  return config;
}

function stepLinksOf(
  result: TsJsUnifiedMultiStepDecisionResult,
): readonly TsJsStepContextCaptureStepLink[] {
  return result.steps.map(step => ({
    stepId: step.stepId,
    optionSemantics: step.candidateChoice.optionSemantics,
    candidateRef: step.candidateChoice.candidateRef,
    score: step.candidateChoice.score,
    receiptId: step.executionReceipt.receiptId,
    postStateRef: step.observedPostState.postStateRef,
    previousActionRef: step.previousActionRef,
    nextStepId: step.nextStepId,
  }));
}

/**
 * Loads a single sample family, drives the real multi-step decision with the
 * file-backed executor, records the real selection-boundary captures, and
 * writes a typed receipt to `outputPath`. It never throws for expected input,
 * family, decision, or output errors; those return a typed `failed` result.
 */
export async function runTsjsStepContextCaptureFromFile(
  configPath: string,
): Promise<TsJsStepContextCaptureResult> {
  let config: TsJsStepContextCaptureConfig;
  try {
    const text = await readFile(resolve(configPath), "utf8");
    config = parseConfig(JSON.parse(text));
  } catch (error) {
    const detail = errorDetail(error);
    return failure("CONFIG_INVALID", "step-context capture config is invalid", detail);
  }

  const packagePath = resolve(config.packagePath);
  const familyPath = resolve(config.familyPath);
  const outputPath = resolve(config.outputPath);
  const sourceRoot = config.sourceRoot === undefined ? familyPath : resolve(config.sourceRoot);

  let episodes;
  try {
    episodes = await loadStepwiseEpisodeFamily(familyPath);
  } catch (error) {
    return failure("FAMILY_LOAD_FAILED", `cannot load family ${familyPath}`, errorDetail(error));
  }

  const sampleEpisodes = episodes.filter(episode => episode.sampleId === config.sampleId);
  if (sampleEpisodes.length === 0) {
    return failure(
      "SAMPLE_NOT_FOUND",
      `family ${familyPath} has no sample ${config.sampleId}`,
      { sampleId: config.sampleId, familyPath },
    );
  }

  const captures: TsJsStepSelectionCapture[] = [];
  let result: TsJsUnifiedMultiStepDecisionResult;
  try {
    result = await runTsJsUnifiedMultiStepDecision({
      requestId: sampleEpisodes[0]!.requestId,
      packagePath,
      episodes: sampleEpisodes,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
      onStepSelection: capture => {
        captures.push(capture);
      },
      ...(config.limits === undefined ? {} : { limits: config.limits }),
    });
  } catch (error) {
    return failure("DECISION_FAILED", "step-context capture decision run failed", errorDetail(error));
  }

  if (captures.length === 0) {
    return failure(
      "CAPTURE_EMPTY",
      "the decision reached no selection boundary, so no step context was captured",
      { sampleId: config.sampleId },
    );
  }

  const receipt = {
    schema: TSJS_STEP_CONTEXT_CAPTURE_RECEIPT_SCHEMA,
    status: "completed",
    requestId: sampleEpisodes[0]!.requestId,
    sampleId: config.sampleId,
    packagePath,
    familyPath,
    sourceRoot,
    captureCount: captures.length,
    modelBinding: result.modelBinding,
    captures,
    steps: result.steps,
  };

  try {
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } catch (error) {
    return failure("OUTPUT_WRITE_FAILED", `cannot write capture receipt ${outputPath}`, errorDetail(error));
  }

  return {
    status: "completed",
    requestId: sampleEpisodes[0]!.requestId,
    sampleId: config.sampleId,
    packagePath,
    familyPath,
    outputPath,
    captureCount: captures.length,
    modelBinding: result.modelBinding,
    stepCount: result.steps.length,
    stepLinks: stepLinksOf(result),
  };
}
