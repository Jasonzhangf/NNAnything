// B-A1 E2: minimal real-site consumer and first-result persistence.
//
// The consumer owns the Node-side freshness ordering around package loading,
// synchronous encode/forward, acceptance, and create-only persistence. It never
// accepts a live DOM observation or derives current control from the projection.

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  projectBA1RealSiteEvaluationInput,
  type BA1RealSiteEvaluationProjection,
  type BA1ScoredCandidate,
} from "./b-a1-real-site-evaluation.js";
import {
  evaluateBA1Sample,
  summarizeBA1Evaluations,
  type BA1EvaluationRow,
  type BA1EvaluationSummary,
  type BA1Identity,
} from "../../training/b-a1-evaluator.js";
import type { BA1EvaluatorGold } from "../../training/b-a1-sample-evaluator-skeleton.js";
import {
  validateSearchInputHostCandidate,
  validateSearchInputHostCoverage,
} from "./search-input-host-contract.js";
import type { BA1RealSiteProjectedObservation } from "./b-a1-real-site-browser-projection.js";
import type { BA1RealSiteControlRead } from "./b-a1-real-site-cdp-runtime.js";
import {
  loadUnifiedModelPackageFromFile,
  type UnifiedModelPackage,
} from "../../training/unified-model-package.js";

const FIRST_PROJECTION_SCHEMA = "nnanything.b-a1.real-site-first-projection.v1";
const FAILURE_RECEIPT_SCHEMA = "nnanything.b-a1.real-site-failure-receipt.v1";
const FIRST_PROJECTION_FILE = "first-projection.json";
const EVALUATION_ROWS_FILE = "real-site-evaluation.jsonl";
const SUMMARY_FILE = "summary.json";
const FAILURE_RECEIPT_FILE = "failure-receipt.json";
const FIRST_RESULT_FILES = [
  FIRST_PROJECTION_FILE,
  EVALUATION_ROWS_FILE,
  SUMMARY_FILE,
  FAILURE_RECEIPT_FILE,
] as const;

export const BA1_REAL_SITE_FAMILY = "real-site-held-out" as const;
export const BA1_REAL_SITE_SAMPLE_KIND = "model-semantic" as const;

export type BA1RealSiteForwardStatus =
  | { readonly status: "completed"; readonly noForwardReason: null }
  | { readonly status: "not_run"; readonly noForwardReason: string };

export interface BA1RealSiteAttemptEvidence {
  readonly forward: BA1RealSiteForwardStatus;
  readonly scores: readonly BA1ScoredCandidate[];
  readonly projection: BA1RealSiteEvaluationProjection;
  readonly evaluation: ReturnType<typeof evaluateBA1Sample>;
  readonly evaluationRow: BA1EvaluationRow;
  readonly summary: BA1EvaluationSummary;
}

export class BA1FirstResultExistsError extends Error {
  readonly code = "BA1_FIRST_RESULT_EXISTS";
  readonly path: string;

  constructor(path: string) {
    super(`first result already exists: ${path}`);
    this.name = "BA1FirstResultExistsError";
    this.path = path;
  }
}

export class BA1RealSiteFreshnessError extends Error {
  readonly code: "stale_candidate" | "stale_forward_gate";
  readonly observed: BA1Identity;
  readonly current: BA1Identity;
  readonly stage: "admission" | "forward_gate";

  constructor(
    code: "stale_candidate" | "stale_forward_gate",
    stage: "admission" | "forward_gate",
    observed: BA1Identity,
    current: BA1Identity,
  ) {
    super(code);
    this.name = "BA1RealSiteFreshnessError";
    this.code = code;
    this.observed = observed;
    this.current = current;
    this.stage = stage;
  }
}

export class BA1RealSiteAcceptanceChangedError extends Error {
  readonly code = "current_control_changed_before_acceptance";
  readonly attempt: BA1RealSiteAttemptEvidence;

  constructor(attempt: BA1RealSiteAttemptEvidence) {
    super("current control changed before acceptance");
    this.name = "BA1RealSiteAcceptanceChangedError";
    this.attempt = attempt;
  }
}

export interface BA1RealSiteFirstResultRequest {
  readonly observation: BA1RealSiteProjectedObservation;
  readonly packagePath: string;
  readonly currentControl: () => BA1RealSiteControlRead;
  /** Independent supervision supplied only to the evaluator, never to projection. */
  readonly gold: BA1EvaluatorGold;
  readonly sampleId: string;
  readonly outputDir: string;
}

export interface BA1RealSiteFirstResultArtifacts {
  readonly projection: string;
  readonly evaluationRows: string;
  readonly summary: string;
  readonly failureReceipt: string | null;
}

export interface BA1RealSiteFirstResult {
  readonly projection: BA1RealSiteEvaluationProjection;
  readonly evaluation: ReturnType<typeof evaluateBA1Sample>;
  readonly evaluationRow: BA1EvaluationRow;
  readonly summary: BA1EvaluationSummary;
  readonly artifacts: BA1RealSiteFirstResultArtifacts;
}

interface PersistedFile {
  readonly name: string;
  readonly content: string;
}

interface FirstProjectionFile {
  readonly schema: typeof FIRST_PROJECTION_SCHEMA;
  readonly package: {
    readonly path: string;
    readonly modelId: string;
    readonly version: string;
    readonly route: Readonly<{ readonly domain: string; readonly decisionKind: string }>;
    readonly encoderVersion: string;
  };
  readonly forward: BA1RealSiteForwardStatus;
  readonly acceptance: {
    readonly status: "accepted";
    readonly operation: BA1RealSiteControlRead;
    readonly observed: BA1RealSiteControlRead;
  };
  readonly projection: BA1RealSiteEvaluationProjection;
}

type FailureReceiptFailure =
  | { readonly kind: "reject"; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | {
      readonly kind: "bound";
      readonly state: string;
      readonly selectedRef: string | null;
      readonly evidenceRefs: readonly string[];
      readonly noForwardReason: string | null;
    }
  | {
      readonly kind: "freshness";
      readonly code: "stale_candidate" | "stale_forward_gate";
      readonly observed: BA1Identity;
      readonly current: BA1Identity;
      readonly forward: BA1RealSiteForwardStatus;
      readonly scores: readonly BA1ScoredCandidate[];
    }
  | {
      readonly kind: "current_control_changed_before_acceptance";
      readonly observed: BA1Identity;
      readonly current: BA1Identity;
      readonly forward: BA1RealSiteForwardStatus;
      readonly scores: readonly BA1ScoredCandidate[];
    };

interface FailureReceipt {
  readonly schema: typeof FAILURE_RECEIPT_SCHEMA;
  readonly ok: false;
  readonly stage:
    | "input"
    | "admission"
    | "package"
    | "projection"
    | "forward_gate"
    | "evaluation"
    | "summary"
    | "acceptance"
    | "save";
  readonly identity: {
    readonly observed: BA1Identity;
    readonly currentControl: BA1Identity;
    readonly sampleId: string;
    readonly family: string;
    readonly group: string;
  };
  readonly packagePath: string;
  readonly failure?: FailureReceiptFailure;
  readonly attempt?: BA1RealSiteAttemptEvidence;
  readonly expectedCount?: number;
  readonly evaluatedCount?: number;
  readonly error?: Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${label} must contain exactly ${keys.join(", ")}`
      + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "")
      + (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<unknown>()): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "function" || typeof value === "undefined" || typeof value === "symbol"
    || typeof value === "bigint") {
    throw new TypeError(`${label} must be JSON-safe; got ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(value);
    value.forEach((entry, index) => assertJsonSafe(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("nodeType" in record || "ownerDocument" in record || "tagName" in record) {
      throw new TypeError(`${label} must not contain a DOM-like object`);
    }
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(value);
    for (const [key, entry] of Object.entries(record)) {
      assertJsonSafe(entry, `${label}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new TypeError(`${label} must be JSON-safe`);
}

function parseIdentity(raw: unknown, label: string): BA1Identity {
  const identity = requireRecord(raw, label);
  exactKeys(identity, ["documentRef", "observationId", "revision"], label);
  const revision = identity.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new TypeError(`${label}.revision must be an integer`);
  }
  return {
    documentRef: requireNonEmptyString(identity.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(identity.observationId, `${label}.observationId`),
    revision,
  };
}

function assertProjectedObservation(raw: unknown): asserts raw is BA1RealSiteProjectedObservation {
  assertJsonSafe(raw, "observation");
  const observation = requireRecord(raw, "observation");
  exactKeys(
    observation,
    ["identity", "scopeRef", "requestedRole", "candidates", "outsideScopeRefs", "coverage"],
    "observation",
  );
  parseIdentity(observation.identity, "observation.identity");
  requireNonEmptyString(observation.scopeRef, "observation.scopeRef");
  requireNonEmptyString(observation.requestedRole, "observation.requestedRole");
  if (!Array.isArray(observation.candidates)) {
    throw new TypeError("observation.candidates must be an array");
  }
  if (!Array.isArray(observation.outsideScopeRefs)) {
    throw new TypeError("observation.outsideScopeRefs must be an array");
  }
  const refs = new Set<string>();
  observation.candidates.forEach((candidate, index) => {
    const parsed = validateSearchInputHostCandidate(candidate, `observation.candidates[${index}]`);
    if (refs.has(parsed.ref)) {
      throw new TypeError(`observation.candidates ref ${parsed.ref} appears twice`);
    }
    refs.add(parsed.ref);
  });
  observation.outsideScopeRefs.forEach((ref, index) => {
    const value = requireNonEmptyString(ref, `observation.outsideScopeRefs[${index}]`);
    if (!refs.has(value)) {
      throw new TypeError(`observation.outsideScopeRefs contains unknown ref ${value}`);
    }
  });
  validateSearchInputHostCoverage(observation.coverage);
}

function sameIdentity(left: BA1Identity, right: BA1Identity): boolean {
  return left.documentRef === right.documentRef
    && left.observationId === right.observationId
    && left.revision === right.revision;
}

function sameRead(left: BA1RealSiteControlRead, right: BA1RealSiteControlRead): boolean {
  return left.generation === right.generation && sameIdentity(left.identity, right.identity);
}

function copyRead(read: BA1RealSiteControlRead): BA1RealSiteControlRead {
  return Object.freeze({
    identity: Object.freeze({ ...read.identity }),
    generation: read.generation,
  });
}

function identityOf(observation: BA1RealSiteProjectedObservation): BA1Identity {
  return observation.identity;
}

function errorFact(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown; detail?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(details.code === undefined ? {} : { code: details.code }),
      ...(details.detail === undefined ? {} : { detail: details.detail }),
    };
  }
  return { name: "UnknownError", message: String(error), stack: null };
}

function noForwardReason(projection: BA1RealSiteEvaluationProjection): string | null {
  const output = projection.output;
  if (output.kind === "reject") return `reject:${output.reason}`;
  if (output.state === "insufficient_observation") {
    const record = projection.evidenceRecords.find(
      entry => entry.type === "insufficient_observation",
    );
    const reason = record?.payload.insufficientReason;
    return typeof reason === "string" ? reason : "insufficient_observation";
  }
  if (output.state === "none") return "fixed_non_search_branch";
  return null;
}

function typedFailure(projection: BA1RealSiteEvaluationProjection): FailureReceiptFailure | null {
  const output = projection.output;
  if (output.kind === "reject") {
    return {
      kind: "reject",
      reason: output.reason,
      evidenceRefs: output.evidenceRefs,
    };
  }
  if (output.state === "insufficient_observation") {
    return {
      kind: "bound",
      state: output.state,
      selectedRef: output.selectedRef ?? null,
      evidenceRefs: output.evidenceRefs,
      noForwardReason: noForwardReason(projection),
    };
  }
  return null;
}

function forwardExecutionStatus(projection: BA1RealSiteEvaluationProjection): BA1RealSiteForwardStatus {
  if (projection.scoredCandidates.length > 0) {
    return { status: "completed", noForwardReason: null };
  }
  return { status: "not_run", noForwardReason: noForwardReason(projection) ?? "no_forward" };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findFirstResult(outputDir: string): Promise<string | null> {
  for (const name of FIRST_RESULT_FILES) {
    const path = join(outputDir, name);
    if (await pathExists(path)) return path;
  }
  return null;
}

async function assertNoFirstResult(outputDir: string): Promise<void> {
  const existing = await findFirstResult(outputDir);
  if (existing !== null) throw new BA1FirstResultExistsError(existing);
}

async function writeFirstResultFiles(
  outputDir: string,
  files: readonly PersistedFile[],
): Promise<void> {
  const reserved = new Set<string>();
  const temporary = new Set<string>();
  try {
    for (const file of files) {
      const target = join(outputDir, file.name);
      try {
        const handle = await open(target, "wx");
        reserved.add(target);
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new BA1FirstResultExistsError(target);
        }
        throw error;
      }
    }

    for (const file of files) {
      const target = join(outputDir, file.name);
      const tempPath = join(outputDir, `.${file.name}.${randomUUID()}.tmp`);
      const handle = await open(tempPath, "wx");
      temporary.add(tempPath);
      try {
        await handle.writeFile(file.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, target);
      temporary.delete(tempPath);
    }
  } catch (error) {
    await Promise.all([
      Promise.all([...temporary].map(path => rm(path, { force: true }))),
      Promise.all([...reserved].map(path => rm(path, { force: true }))),
    ]);
    throw error;
  }
}

async function saveFailureReceipt(
  outputDir: string,
  receipt: FailureReceipt,
): Promise<unknown | null> {
  if (await findFirstResult(outputDir) !== null) return null;
  try {
    await writeFirstResultFiles(outputDir, [{
      name: FAILURE_RECEIPT_FILE,
      content: `${JSON.stringify(receipt, null, 2)}\n`,
    }]);
    return null;
  } catch (receiptError) {
    if (receiptError instanceof BA1FirstResultExistsError) return null;
    return receiptError;
  }
}

function modelReference(pkg: UnifiedModelPackage) {
  return {
    modelId: pkg.modelId,
    version: pkg.version,
    route: { ...pkg.route },
    encoderVersion: pkg.encoderVersion,
  };
}

function firstProjectionFile(
  pkg: UnifiedModelPackage,
  packagePath: string,
  projection: BA1RealSiteEvaluationProjection,
  operation: BA1RealSiteControlRead,
  accepted: BA1RealSiteControlRead,
): FirstProjectionFile {
  return {
    schema: FIRST_PROJECTION_SCHEMA,
    package: { path: packagePath, ...modelReference(pkg) },
    forward: forwardExecutionStatus(projection),
    acceptance: {
      status: "accepted",
      operation: copyRead(operation),
      observed: copyRead(accepted),
    },
    projection,
  };
}

function baseReceipt(
  request: BA1RealSiteFirstResultRequest,
  stage: FailureReceipt["stage"],
  currentControl: BA1Identity,
): FailureReceipt {
  return {
    schema: FAILURE_RECEIPT_SCHEMA,
    ok: false,
    stage,
    identity: {
      observed: identityOf(request.observation),
      currentControl,
      sampleId: request.sampleId,
      family: request.gold.family,
      group: request.gold.group,
    },
    packagePath: resolve(request.packagePath),
  };
}

function typedFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  projection: BA1RealSiteEvaluationProjection,
  operation: BA1RealSiteControlRead,
): FailureReceipt {
  return {
    ...baseReceipt(request, "projection", operation.identity),
    failure: typedFailure(projection)!,
    expectedCount: projection.expectedCount,
    evaluatedCount: projection.evaluatedCount,
  };
}

function runtimeFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  stage: FailureReceipt["stage"],
  error: unknown,
  currentControl: BA1Identity,
): FailureReceipt {
  return {
    ...baseReceipt(request, stage, currentControl),
    error: errorFact(error),
  };
}

function freshnessFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  error: BA1RealSiteFreshnessError,
): FailureReceipt {
  return {
    ...baseReceipt(request, error.stage, error.current),
    failure: {
      kind: "freshness",
      code: error.code,
      observed: error.observed,
      current: error.current,
      forward: { status: "not_run", noForwardReason: error.code },
      scores: [],
    },
  };
}

function acceptanceFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  operation: BA1RealSiteControlRead,
  accepted: BA1RealSiteControlRead,
  attempt: BA1RealSiteAttemptEvidence,
): FailureReceipt {
  return {
    ...baseReceipt(request, "acceptance", accepted.identity),
    failure: {
      kind: "current_control_changed_before_acceptance",
      observed: operation.identity,
      current: accepted.identity,
      forward: attempt.forward,
      scores: attempt.scores,
    },
    attempt,
    expectedCount: attempt.projection.expectedCount,
    evaluatedCount: attempt.projection.evaluatedCount,
  };
}

/**
 * The one consumer entry: execute the accepted pipeline and create the first
 * result exactly once. The current-control reader is called at admission,
 * immediately before synchronous forward, and once at acceptance.
 */
export async function runBA1RealSiteFirstResult(
  request: BA1RealSiteFirstResultRequest,
): Promise<BA1RealSiteFirstResult> {
  requireNonEmptyString(request.packagePath, "packagePath");
  requireNonEmptyString(request.sampleId, "sampleId");
  requireNonEmptyString(request.outputDir, "outputDir");
  const outputDir = resolve(request.outputDir);
  await mkdir(outputDir, { recursive: true });

  let stage: FailureReceipt["stage"] = "input";
  let currentControl = identityOf(request.observation);
  try {
    await assertNoFirstResult(outputDir);
    assertProjectedObservation(request.observation);
    if (request.gold.family !== BA1_REAL_SITE_FAMILY) {
      throw new TypeError(
        `real-site gold.family must be ${BA1_REAL_SITE_FAMILY}, got ${request.gold.family}`,
      );
    }

    stage = "admission";
    const admitted = request.currentControl();
    if (!Number.isInteger(admitted.generation) || admitted.generation < 0) {
      throw new TypeError("currentControl.generation must be a nonnegative integer");
    }
    currentControl = admitted.identity;
    if (!sameIdentity(identityOf(request.observation), admitted.identity)) {
      throw new BA1RealSiteFreshnessError(
        "stale_candidate",
        "admission",
        identityOf(request.observation),
        admitted.identity,
      );
    }
    const operation: BA1RealSiteControlRead = copyRead(admitted);

    stage = "package";
    const loaded = await loadUnifiedModelPackageFromFile(request.packagePath);

    stage = "forward_gate";
    const beforeForward = request.currentControl();
    currentControl = beforeForward.identity;
    if (!sameRead(operation, beforeForward)) {
      throw new BA1RealSiteFreshnessError(
        "stale_forward_gate",
        "forward_gate",
        operation.identity,
        beforeForward.identity,
      );
    }

    stage = "projection";
    const projection = projectBA1RealSiteEvaluationInput({
      observation: request.observation,
      modelPackage: loaded.package,
      currentControl: operation.identity,
    });

    stage = "evaluation";
    const evaluationRow: BA1EvaluationRow = {
      sampleId: request.sampleId,
      sampleKind: BA1_REAL_SITE_SAMPLE_KIND,
      family: BA1_REAL_SITE_FAMILY,
      group: request.gold.group,
      gold: request.gold,
      output: projection.output,
      allowedScopeRef: projection.allowedScopeRef,
      candidates: projection.candidates,
      coverage: projection.coverage,
      currentControl: projection.currentControl,
      evidenceRecords: projection.evidenceRecords,
    };
    const evaluation = evaluateBA1Sample(evaluationRow);

    stage = "summary";
    const summary = summarizeBA1Evaluations([evaluationRow]);

    stage = "acceptance";
    const accepted = request.currentControl();
    currentControl = accepted.identity;
    if (!sameRead(operation, accepted)) {
      const attempt: BA1RealSiteAttemptEvidence = {
        forward: forwardExecutionStatus(projection),
        scores: projection.scoredCandidates,
        projection,
        evaluation,
        evaluationRow,
        summary,
      };
      const receiptError = await saveFailureReceipt(
        outputDir,
        acceptanceFailureReceipt(request, operation, accepted, attempt),
      );
      const error = new BA1RealSiteAcceptanceChangedError(attempt);
      if (receiptError !== null) {
        throw new Error(`${error.message}; failure receipt write error: ${String(receiptError)}`);
      }
      throw error;
    }

    stage = "save";
    const projectionFile = firstProjectionFile(
      loaded.package,
      loaded.packagePath,
      projection,
      operation,
      accepted,
    );
    const files: PersistedFile[] = [
      {
        name: FIRST_PROJECTION_FILE,
        content: `${JSON.stringify(projectionFile, null, 2)}\n`,
      },
      {
        name: EVALUATION_ROWS_FILE,
        content: `${JSON.stringify(evaluationRow)}\n`,
      },
      {
        name: SUMMARY_FILE,
        content: `${JSON.stringify(summary, null, 2)}\n`,
      },
    ];
    const failure = typedFailure(projection);
    const failureReceipt = failure === null
      ? null
      : {
          ...typedFailureReceipt(request, projection, operation),
          failure,
        };
    if (failureReceipt !== null) {
      files.push({
        name: FAILURE_RECEIPT_FILE,
        content: `${JSON.stringify(failureReceipt, null, 2)}\n`,
      });
    }

    await writeFirstResultFiles(outputDir, files);
    return {
      projection,
      evaluation,
      evaluationRow,
      summary,
      artifacts: {
        projection: join(outputDir, FIRST_PROJECTION_FILE),
        evaluationRows: join(outputDir, EVALUATION_ROWS_FILE),
        summary: join(outputDir, SUMMARY_FILE),
        failureReceipt: failureReceipt === null
          ? null
          : join(outputDir, FAILURE_RECEIPT_FILE),
      },
    };
  } catch (error) {
    if (error instanceof BA1FirstResultExistsError || error instanceof BA1RealSiteAcceptanceChangedError) {
      throw error;
    }
    const receipt = error instanceof BA1RealSiteFreshnessError
      ? freshnessFailureReceipt(request, error)
      : runtimeFailureReceipt(request, stage, error, currentControl);
    const receiptError = await saveFailureReceipt(outputDir, receipt);
    if (receiptError !== null && error instanceof Error && Object.isExtensible(error)) {
      (error as Error & { receiptError?: unknown }).receiptError = receiptError;
    }
    throw error;
  }
}
