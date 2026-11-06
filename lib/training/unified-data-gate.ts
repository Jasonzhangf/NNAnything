// 64-slot unified data gate.
//
// This gate is additive and independent of the frozen R/D/A/E standard runner
// path. It consumes typed 64-slot rows plus an explicit threshold resource and
// refuses to emit training rows when a dependency is missing. Empty A_g,
// A_g not a subset of S_g, teacher-chain leakage, and filled missing slots are
// DATA_INVALID; a truncated candidate enumeration is UNASSESSED with an open
// coverage cursor, never a model miss.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadFeatureThresholdsFromFile } from "./unified-thresholds.js";
import { UNIFIED_ENCODER_VERSION } from "./unified-encoder.js";
import { validateMissingModeConsistency } from "./unified-missing-mode.js";

export const UNIFIED_DATA_GATE_SCHEMA = "nnanything.unified.data-gate.v1" as const;
export const UNIFIED_DATA_ROW_SCHEMA = "nnanything.unified.data-row.v1" as const;

export type UnifiedDataGateStatus = "READY" | "NO_LEARNED_ROWS" | "DATA_INVALID";
export type UnifiedDecisionKind = "R" | "D" | "E" | "A";

export interface UnifiedDataGateViolation {
  readonly code: "DATA_INVALID";
  readonly reasonCode:
    | "THRESHOLD_MISSING"
    | "THRESHOLD_INVALID"
    | "ROW_SCHEMA_INVALID"
    | "INPUT_SHAPE_INVALID"
    | "MISSING_FILLED"
    | "CANDIDATE_SET_EMPTY"
    | "ALLOWED_NOT_SUBSET"
    | "ALLOWED_EMPTY"
    | "GOLD_NOT_IN_CANDIDATES"
    | "SUPERVISION_CONFLICT"
    | "TEACHER_LEAKAGE";
  readonly rowId: string | null;
  readonly message: string;
}

export interface UnifiedUnassessedRow {
  readonly rowId: string;
  readonly reason: "candidate_truncated" | "candidate_enumeration_failed";
  readonly openCursorRef: string;
  readonly missingFieldRefs: readonly string[];
}

export interface UnifiedDataGateRow {
  readonly schema: typeof UNIFIED_DATA_ROW_SCHEMA;
  readonly rowId: string;
  readonly partition: "TRAIN" | "DEV";
  readonly route: Readonly<{ domain: string; decisionKind: UnifiedDecisionKind }>;
  readonly input: readonly number[];
  readonly candidateInputs?: readonly {
    readonly candidateRef: string;
    readonly input: readonly number[];
  }[];
  readonly missingMode: readonly Readonly<{ slotIndex: number; reason: string; fill: -1 }>[];
  readonly candidates: readonly string[];
  readonly allowed: readonly string[];
  readonly gold: string;
  readonly labelMissing: boolean;
  readonly enumeration: "complete" | "truncated" | "enumeration_failed";
  readonly teacherChain?: readonly string[];
}

export interface UnifiedDataGateConfig {
  readonly schema: typeof UNIFIED_DATA_GATE_SCHEMA;
  readonly partition: "TRAIN" | "DEV";
  readonly encoderVersion: string;
  readonly thresholdsPath: string;
  readonly rowsPath: string;
}

export interface UnifiedDataGateCounts {
  readonly totalRows: number;
  readonly learnedRows: number;
  readonly labelMissingExcluded: number;
  readonly unknownGoldRows: number;
  readonly unassessedRows: number;
  readonly candidateGaps: number;
}

export interface UnifiedDataGateResult {
  readonly schema: typeof UNIFIED_DATA_GATE_SCHEMA;
  readonly status: UnifiedDataGateStatus;
  readonly partition: "TRAIN" | "DEV";
  readonly encoderVersion: string;
  readonly thresholdsRoute: string;
  readonly rows: readonly UnifiedDataGateRow[];
  readonly unassessed: readonly UnifiedUnassessedRow[];
  readonly violations: readonly UnifiedDataGateViolation[];
  readonly firstViolation: UnifiedDataGateViolation | null;
  readonly counts: UnifiedDataGateCounts;
}

function violation(
  reasonCode: UnifiedDataGateViolation["reasonCode"],
  rowId: string | null,
  message: string,
): UnifiedDataGateViolation {
  return { code: "DATA_INVALID", reasonCode, rowId, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRows(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function isFiniteVector(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  return value.every(entry => typeof entry === "number" && Number.isFinite(entry));
}

function conflictInputKey(row: UnifiedDataGateRow): string {
  if (row.candidateInputs !== undefined) {
    const candidateInputs = [...row.candidateInputs]
      .map(({ candidateRef, input }) => ({ candidateRef, input }))
      .sort((left, right) => left.candidateRef.localeCompare(right.candidateRef));
    return JSON.stringify({ candidateInputs });
  }
  return JSON.stringify({ input: row.input, candidates: row.candidates });
}

function validateRow(
  raw: unknown,
  partition: "TRAIN" | "DEV",
  violations: UnifiedDataGateViolation[],
): UnifiedUnassessedRow | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    violations.push(violation("ROW_SCHEMA_INVALID", null, "row must be an object"));
    return null;
  }
  const row = raw as Record<string, unknown>;
  const rowId = typeof row.rowId === "string" ? row.rowId : null;
  if (row.schema !== UNIFIED_DATA_ROW_SCHEMA) {
    violations.push(violation("ROW_SCHEMA_INVALID", rowId, "row schema mismatch"));
    return null;
  }
  if (row.partition !== partition) {
    violations.push(
      violation("ROW_SCHEMA_INVALID", rowId, `row partition ${String(row.partition)} != ${partition}`),
    );
    return null;
  }
  if (!isFiniteVector(row.input, 64)) {
    violations.push(violation("INPUT_SHAPE_INVALID", rowId, "input must be 64 finite values"));
    return null;
  }
  if (Array.isArray(row.teacherChain) && row.teacherChain.length > 0) {
    violations.push(violation("TEACHER_LEAKAGE", rowId, "teacher chain must not enter a student row"));
    return null;
  }

  const missingCheck = validateMissingModeConsistency(row.input, row.missingMode);
  if (!missingCheck.ok) {
    if (missingCheck.kind === "not_array" || missingCheck.kind === "bad_entry") {
      violations.push(
        violation("ROW_SCHEMA_INVALID", rowId, missingCheck.message),
      );
    } else {
      violations.push(
        violation("MISSING_FILLED", rowId, missingCheck.message),
      );
    }
  }

  if (row.candidateInputs !== undefined) {
    const candidateInputs = row.candidateInputs;
    const valid =
      Array.isArray(candidateInputs)
      && candidateInputs.length > 0
      && candidateInputs.every(
        candidate =>
          isRecord(candidate)
          && typeof candidate.candidateRef === "string"
          && isFiniteVector(candidate.input, 64),
      );
    if (!valid) {
      violations.push(
        violation("ROW_SCHEMA_INVALID", rowId, "candidateInputs must carry one finite 64-slot input per candidate"),
      );
    }
  }

  const enumeration = row.enumeration;
  if (enumeration === "truncated" || enumeration === "enumeration_failed") {
    const openCursorRef =
      typeof row.openCursorRef === "string" ? row.openCursorRef : `cursor:${String(rowId)}`;
    return {
      rowId: rowId ?? "(unknown)",
      reason:
        enumeration === "truncated"
          ? "candidate_truncated"
          : "candidate_enumeration_failed",
      openCursorRef,
      missingFieldRefs: ["candidates"],
    };
  }

  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const allowed = Array.isArray(row.allowed) ? row.allowed : [];
  if (candidates.length === 0) {
    violations.push(violation("CANDIDATE_SET_EMPTY", rowId, "candidate set S_g must not be empty"));
  }
  if (allowed.length === 0) {
    violations.push(violation("ALLOWED_EMPTY", rowId, "allowed set A_g must not be empty"));
  }
  const candidateSet = new Set(candidates);
  for (const value of allowed) {
    if (!candidateSet.has(value)) {
      violations.push(
        violation("ALLOWED_NOT_SUBSET", rowId, `allowed value ${String(value)} is not in S_g`),
      );
    }
  }
  const gold = row.gold;
  if (typeof gold !== "string") {
    violations.push(violation("ROW_SCHEMA_INVALID", rowId, "gold must be a string"));
  } else if (gold !== "unknown" && !candidateSet.has(gold)) {
    violations.push(violation("GOLD_NOT_IN_CANDIDATES", rowId, `gold ${gold} is not in S_g`));
  }
  return null;
}

export async function validateUnified64SlotTrainingData(
  config: UnifiedDataGateConfig,
): Promise<UnifiedDataGateResult> {
  const violations: UnifiedDataGateViolation[] = [];
  if (config.schema !== UNIFIED_DATA_GATE_SCHEMA) {
    violations.push(violation("ROW_SCHEMA_INVALID", null, "config schema mismatch"));
  }
  if (config.encoderVersion !== UNIFIED_ENCODER_VERSION) {
    violations.push(
      violation("ROW_SCHEMA_INVALID", null, `encoder version ${config.encoderVersion} is incompatible`),
    );
  }

  let thresholdsRoute = "(missing)";
  try {
    const thresholds = await loadFeatureThresholdsFromFile(resolve(config.thresholdsPath));
    thresholdsRoute = thresholds.route;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    violations.push(
      violation("THRESHOLD_MISSING", null, `threshold resource is required: ${message}`),
    );
  }

  let rows: UnifiedDataGateRow[] = [];
  const unassessed: UnifiedUnassessedRow[] = [];
  try {
    const text = await readFile(resolve(config.rowsPath), "utf8");
    for (const raw of parseRows(text)) {
      const pending = validateRow(raw, config.partition, violations);
      if (pending !== null) unassessed.push(pending);
      else rows.push(raw as UnifiedDataGateRow);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    violations.push(violation("ROW_SCHEMA_INVALID", null, `rows resource is required: ${message}`));
  }

  const learnedInputs = new Map<string, {
    readonly rowId: string;
    readonly allowed: string;
    readonly gold: string;
  }>();
  for (const row of rows) {
    if (row.labelMissing) continue;
    const inputKey = conflictInputKey(row);
    const allowed = [...row.allowed].sort().join("|");
    const prior = learnedInputs.get(inputKey);
    if (prior !== undefined && (prior.allowed !== allowed || prior.gold !== row.gold)) {
      violations.push(
        violation(
          "SUPERVISION_CONFLICT",
          row.rowId,
          `same student input has conflicting gold rows ${prior.rowId} and ${row.rowId}; awaiting adjudication`,
        ),
      );
    } else if (prior === undefined) {
      learnedInputs.set(inputKey, { rowId: row.rowId, allowed, gold: row.gold });
    }
  }

  const rejected = violations.length > 0;
  const learnedRows = rejected ? [] : rows.filter(row => !row.labelMissing);
  const labelMissingExcluded = rejected ? 0 : rows.length - learnedRows.length;
  const unknownGoldRows = rejected
    ? 0
    : learnedRows.filter(row => row.gold === "unknown").length;
  const candidateGaps = unassessed.length;
  const status: UnifiedDataGateStatus =
    violations.length > 0
      ? "DATA_INVALID"
      : learnedRows.length === 0
        ? "NO_LEARNED_ROWS"
        : "READY";

  return {
    schema: UNIFIED_DATA_GATE_SCHEMA,
    status,
    partition: config.partition,
    encoderVersion: config.encoderVersion,
    thresholdsRoute,
    rows,
    unassessed,
    violations,
    firstViolation: violations[0] ?? null,
    counts: {
      totalRows: rows.length,
      learnedRows: learnedRows.length,
      labelMissingExcluded,
      unknownGoldRows,
      unassessedRows: unassessed.length,
      candidateGaps,
    },
  };
}

