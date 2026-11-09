// B-A1 E2: minimal real-site consumer and first-result persistence.
//
// This module only wires the existing runtime observation envelope, the saved
// model package, the gold-free projection, the independent evaluator and the
// summary into one public call. It adds no model, threshold, evaluator, gold or
// adapter semantics.

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  projectBA1RealSiteEvaluationInput,
  type BA1RealSiteEvaluationProjection,
  type BA1RealSiteObservation,
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

export class BA1FirstResultExistsError extends Error {
  readonly code = "BA1_FIRST_RESULT_EXISTS";
  readonly path: string;

  constructor(path: string) {
    super(`first result already exists: ${path}`);
    this.name = "BA1FirstResultExistsError";
    this.path = path;
  }
}

export interface BA1RealSiteFirstResultRequest {
  readonly observation: BA1RealSiteObservation;
  readonly packagePath: string;
  readonly currentControl: BA1Identity;
  /** Independent supervision supplied only to the evaluator, never to the projection. */
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
  readonly forward: {
    readonly status: "completed" | "not_run";
    readonly noForwardReason: string | null;
  };
  readonly projection: BA1RealSiteEvaluationProjection;
}

interface FailureReceipt {
  readonly schema: typeof FAILURE_RECEIPT_SCHEMA;
  readonly ok: false;
  readonly stage: "input" | "package" | "projection" | "evaluation" | "summary" | "save";
  readonly identity: {
    readonly observed: BA1Identity;
    readonly currentControl: BA1Identity;
    readonly sampleId: string;
    readonly family: string;
    readonly group: string;
  };
  readonly packagePath: string;
  readonly failure?:
    | { readonly kind: "reject"; readonly reason: string; readonly evidenceRefs: readonly string[] }
    | {
        readonly kind: "bound";
        readonly state: string;
        readonly selectedRef: string | null;
        readonly evidenceRefs: readonly string[];
        readonly noForwardReason: string | null;
      };
  readonly expectedCount?: number;
  readonly evaluatedCount?: number;
  readonly error?: Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRuntimeElement(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be a runtime Element`);
  }
  const element = value as Partial<Element>;
  if (typeof element.tagName !== "string" || element.tagName.length === 0) {
    throw new TypeError(`${label} must be a runtime Element`);
  }
  for (const method of [
    "closest",
    "getAttribute",
    "querySelector",
    "querySelectorAll",
    "getBoundingClientRect",
  ] as const) {
    if (typeof element[method] !== "function") {
      throw new TypeError(`${label}.${method} must be a runtime Element method`);
    }
  }
}

/**
 * Refuse a serialized observation. A real envelope carries live Elements and a
 * `propertiesOf` function; JSON cannot reproduce either fact.
 */
function assertRuntimeObservation(observation: BA1RealSiteObservation): void {
  assertRuntimeElement(observation.scopeRoot, "observation.scopeRoot");
  if (!Array.isArray(observation.nodes)) {
    throw new TypeError("observation.nodes must be an array");
  }
  observation.nodes.forEach((node, index) => {
    if (typeof node !== "object" || node === null) {
      throw new TypeError(`observation.nodes[${index}] must be an object`);
    }
    requireNonEmptyString(node.nodeRef, `observation.nodes[${index}].nodeRef`);
    assertRuntimeElement(node.element, `observation.nodes[${index}].element`);
  });
  if (typeof observation.propertiesOf !== "function") {
    throw new TypeError("observation.propertiesOf must be a function");
  }
}

function identityOf(observation: BA1RealSiteObservation): BA1Identity {
  return {
    documentRef: observation.documentRef,
    observationId: observation.observationId,
    revision: observation.revision,
  };
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

function typedFailure(projection: BA1RealSiteEvaluationProjection): FailureReceipt["failure"] | null {
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

/**
 * Reserve every target with `wx`, write a same-directory temporary file, sync
 * it, then atomically rename it over the reservation. A failed attempt removes
 * only the files this call created.
 */
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

function forwardExecutionStatus(projection: BA1RealSiteEvaluationProjection): {
  readonly status: "completed" | "not_run";
  readonly noForwardReason: string | null;
} {
  if (projection.scoredCandidates.length > 0) {
    return { status: "completed", noForwardReason: null };
  }
  return { status: "not_run", noForwardReason: noForwardReason(projection) };
}

function firstProjectionFile(
  pkg: UnifiedModelPackage,
  packagePath: string,
  projection: BA1RealSiteEvaluationProjection,
): FirstProjectionFile {
  const forward = forwardExecutionStatus(projection);
  return {
    schema: FIRST_PROJECTION_SCHEMA,
    package: { path: packagePath, ...modelReference(pkg) },
    forward,
    projection,
  };
}

function typedFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  projection: BA1RealSiteEvaluationProjection,
): FailureReceipt {
  return {
    schema: FAILURE_RECEIPT_SCHEMA,
    ok: false,
    stage: "projection",
    identity: {
      observed: identityOf(request.observation),
      currentControl: request.currentControl,
      sampleId: request.sampleId,
      family: request.gold.family,
      group: request.gold.group,
    },
    packagePath: resolve(request.packagePath),
    failure: typedFailure(projection)!,
    expectedCount: projection.expectedCount,
    evaluatedCount: projection.evaluatedCount,
  };
}

function runtimeFailureReceipt(
  request: BA1RealSiteFirstResultRequest,
  stage: FailureReceipt["stage"],
  error: unknown,
): FailureReceipt {
  return {
    schema: FAILURE_RECEIPT_SCHEMA,
    ok: false,
    stage,
    identity: {
      observed: identityOf(request.observation),
      currentControl: request.currentControl,
      sampleId: request.sampleId,
      family: request.gold.family,
      group: request.gold.group,
    },
    packagePath: resolve(request.packagePath),
    error: errorFact(error),
  };
}

/**
 * The one consumer entry: execute the accepted pipeline and create the first
 * result exactly once. `currentControl` and `gold` stay caller-owned inputs.
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
  try {
    await assertNoFirstResult(outputDir);
    assertRuntimeObservation(request.observation);
    if (request.gold.family !== BA1_REAL_SITE_FAMILY) {
      throw new TypeError(
        `real-site gold.family must be ${BA1_REAL_SITE_FAMILY}, got ${request.gold.family}`,
      );
    }

    stage = "package";
    const loaded = await loadUnifiedModelPackageFromFile(request.packagePath);

    stage = "projection";
    const projection = await projectBA1RealSiteEvaluationInput({
      observation: request.observation,
      packagePath: loaded.packagePath,
      currentControl: request.currentControl,
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

    stage = "save";
    const projectionFile = firstProjectionFile(
      loaded.package,
      loaded.packagePath,
      projection,
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
          ...typedFailureReceipt(request, projection),
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
    if (error instanceof BA1FirstResultExistsError) throw error;
    const receiptError = await saveFailureReceipt(
      outputDir,
      runtimeFailureReceipt(request, stage, error),
    );
    if (receiptError !== null && error instanceof Error && Object.isExtensible(error)) {
      (error as Error & { receiptError?: unknown }).receiptError = receiptError;
    }
    throw error;
  }
}
