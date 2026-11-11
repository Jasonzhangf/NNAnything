// B-A1 seen-source diagnostic result accounting.
//
// A future custody-gated entry resolves and approves the source before it
// produces evaluation rows. This module is the separate accounting half: it
// persists diagnostic-family rows without treating them as held-out evidence.

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  summarizeBA1Evaluations,
  type BA1EvaluationRow,
  type BA1EvaluationSummary,
} from "../../training/b-a1-evaluator.js";

export const BA1_REAL_SITE_DIAGNOSTIC_FAMILY = "seen-source-diagnostics" as const;
export const BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE = "UNVERIFIED" as const;
export const BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_SCHEMA =
  "nnanything.b-a1.seen-source-diagnostic-accounting.v1" as const;
export const BA1_SEEN_SOURCE_DIAGNOSTIC_SUMMARY_SCHEMA =
  "nnanything.b-a1.seen-source-diagnostic-summary.v1" as const;

const EVALUATION_ROWS_FILE = "seen-source-diagnostic-accounting.jsonl";
const SUMMARY_FILE = "seen-source-diagnostic-summary.json";

export interface BA1SeenSourceDiagnosticUnresolvedRow {
  readonly sourceGroupId: string;
  readonly unresolvedObligation: string;
}

export interface BA1SeenSourceDiagnosticAccountingRequest {
  readonly outputDir: string;
  readonly evaluationRows: readonly BA1EvaluationRow[];
  readonly unresolvedRows: readonly BA1SeenSourceDiagnosticUnresolvedRow[];
}

export interface BA1SeenSourceDiagnosticAccountingResult {
  readonly schema: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_SCHEMA;
  readonly exposureLabel: typeof BA1_REAL_SITE_DIAGNOSTIC_FAMILY;
  readonly modelTrainingExposure: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE;
  readonly evaluationRows: readonly BA1EvaluationRow[];
  readonly summary: BA1EvaluationSummary;
  readonly accounting: {
    readonly diagnosticRows: number;
    readonly heldOutRows: 0;
    readonly unresolvedRows: number;
  };
  readonly unresolvedRows: readonly BA1SeenSourceDiagnosticUnresolvedRow[];
  readonly artifacts: {
    readonly evaluationRows: string;
    readonly summary: string;
  };
}

interface PersistedDiagnosticRow {
  readonly schema: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_SCHEMA;
  readonly exposureLabel: typeof BA1_REAL_SITE_DIAGNOSTIC_FAMILY;
  readonly modelTrainingExposure: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE;
  readonly evaluationRow: BA1EvaluationRow;
}

interface PersistedSummary {
  readonly schema: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_SUMMARY_SCHEMA;
  readonly exposureLabel: typeof BA1_REAL_SITE_DIAGNOSTIC_FAMILY;
  readonly modelTrainingExposure: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE;
  readonly summary: BA1EvaluationSummary;
  readonly accounting: BA1SeenSourceDiagnosticAccountingResult["accounting"];
  readonly unresolvedRows: readonly BA1SeenSourceDiagnosticUnresolvedRow[];
}

interface PersistedFile {
  readonly name: string;
  readonly content: string;
}

export class BA1SeenSourceDiagnosticAccountingExistsError extends Error {
  readonly code = "BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_EXISTS";
  readonly path: string;

  constructor(path: string) {
    super(`seen-source diagnostic accounting already exists: ${path}`);
    this.name = "BA1SeenSourceDiagnosticAccountingExistsError";
    this.path = path;
  }
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

function parseUnresolvedRows(raw: unknown): readonly BA1SeenSourceDiagnosticUnresolvedRow[] {
  if (!Array.isArray(raw)) throw new TypeError("unresolvedRows must be an array");
  const sourceGroupIds = new Set<string>();
  return Object.freeze(raw.map((entry, index) => {
    const row = requireRecord(entry, `unresolvedRows[${index}]`);
    const sourceGroupId = requireNonEmptyString(row.sourceGroupId, `unresolvedRows[${index}].sourceGroupId`);
    if (sourceGroupIds.has(sourceGroupId)) {
      throw new TypeError(`unresolvedRows sourceGroupId ${sourceGroupId} appears twice`);
    }
    sourceGroupIds.add(sourceGroupId);
    return Object.freeze({
      sourceGroupId,
      unresolvedObligation: requireNonEmptyString(
        row.unresolvedObligation,
        `unresolvedRows[${index}].unresolvedObligation`,
      ),
    });
  }));
}

function validateEvaluationRows(raw: unknown): readonly BA1EvaluationRow[] {
  if (!Array.isArray(raw)) throw new TypeError("evaluationRows must be an array");
  const sampleIds = new Set<string>();
  const rows = raw.map((entry, index) => {
    const row = requireRecord(entry, `evaluationRows[${index}]`);
    if (row.family !== BA1_REAL_SITE_DIAGNOSTIC_FAMILY) {
      throw new TypeError(
        `evaluationRows[${index}].family must be ${BA1_REAL_SITE_DIAGNOSTIC_FAMILY}`,
      );
    }
    if (row.sampleKind !== "model-semantic") {
      throw new TypeError(`evaluationRows[${index}].sampleKind must be model-semantic`);
    }
    const gold = requireRecord(row.gold, `evaluationRows[${index}].gold`);
    if (gold.family !== BA1_REAL_SITE_DIAGNOSTIC_FAMILY) {
      throw new TypeError(
        `evaluationRows[${index}].gold.family must be ${BA1_REAL_SITE_DIAGNOSTIC_FAMILY}`,
      );
    }
    const group = requireNonEmptyString(row.group, `evaluationRows[${index}].group`);
    if (gold.group !== group) {
      throw new TypeError(`evaluationRows[${index}].gold.group must equal evaluationRows[${index}].group`);
    }
    const sampleId = requireNonEmptyString(row.sampleId, `evaluationRows[${index}].sampleId`);
    if (sampleIds.has(sampleId)) {
      throw new TypeError(`evaluationRows sampleId ${sampleId} appears twice`);
    }
    sampleIds.add(sampleId);
    return entry as BA1EvaluationRow;
  });
  return Object.freeze(rows);
}

async function writeCreateOnly(outputDir: string, files: readonly PersistedFile[]): Promise<void> {
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
          throw new BA1SeenSourceDiagnosticAccountingExistsError(target);
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

/**
 * Persist already-admitted seen-source diagnostic rows. This function does not
 * resolve custody, approve gold, or read live control. Those decisions must
 * complete in the future custody-gated entry before it calls this boundary.
 */
export async function persistBA1SeenSourceDiagnosticAccounting(
  request: BA1SeenSourceDiagnosticAccountingRequest,
): Promise<BA1SeenSourceDiagnosticAccountingResult> {
  const outputDir = resolve(requireNonEmptyString(request.outputDir, "outputDir"));
  const evaluationRows = validateEvaluationRows(request.evaluationRows);
  const unresolvedRows = parseUnresolvedRows(request.unresolvedRows);
  const evaluationGroups = new Set(evaluationRows.map(row => row.group));
  for (const unresolved of unresolvedRows) {
    if (evaluationGroups.has(unresolved.sourceGroupId)) {
      throw new TypeError(
        `sourceGroupId ${unresolved.sourceGroupId} cannot be both evaluated and unresolved`,
      );
    }
  }

  const summary = summarizeBA1Evaluations(evaluationRows);
  const accounting: BA1SeenSourceDiagnosticAccountingResult["accounting"] = Object.freeze({
    diagnosticRows: evaluationRows.length,
    heldOutRows: 0,
    unresolvedRows: unresolvedRows.length,
  });
  const persistedRows = evaluationRows.map<PersistedDiagnosticRow>(evaluationRow => ({
    schema: BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_SCHEMA,
    exposureLabel: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    modelTrainingExposure: BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE,
    evaluationRow,
  }));
  const persistedSummary: PersistedSummary = {
    schema: BA1_SEEN_SOURCE_DIAGNOSTIC_SUMMARY_SCHEMA,
    exposureLabel: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    modelTrainingExposure: BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE,
    summary,
    accounting,
    unresolvedRows,
  };

  await mkdir(outputDir, { recursive: true });
  await writeCreateOnly(outputDir, [
    {
      name: EVALUATION_ROWS_FILE,
      content: persistedRows.length === 0
        ? ""
        : `${persistedRows.map(row => JSON.stringify(row)).join("\n")}\n`,
    },
    {
      name: SUMMARY_FILE,
      content: `${JSON.stringify(persistedSummary, null, 2)}\n`,
    },
  ]);

  return Object.freeze({
    schema: BA1_SEEN_SOURCE_DIAGNOSTIC_ACCOUNTING_SCHEMA,
    exposureLabel: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    modelTrainingExposure: BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE,
    evaluationRows,
    summary,
    accounting,
    unresolvedRows,
    artifacts: Object.freeze({
      evaluationRows: join(outputDir, EVALUATION_ROWS_FILE),
      summary: join(outputDir, SUMMARY_FILE),
    }),
  });
}
