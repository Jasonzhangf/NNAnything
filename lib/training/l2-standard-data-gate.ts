/**
 * Standard pre-optimizer data gate and sample structural migration converter.
 *
 * Implements the exact validation order from `standard-runner-owner-audit.md`:
 *   1. parse schema / partition
 *   2. map source fields by declared names
 *   3. retain fact knownness (`receiptFact`)
 *   4. reconcile fixed Handwired rule (pre -> MLP -> post) and semantic gold
 *   5. check learned-row denominator and identical-feature gold conflicts
 *   6. emit `READY`, `NO_LEARNED_ROWS`, or `DATA_INVALID` (with offending source/row/reason)
 *
 * Coverage boundary:
 * Static schema, knownness, and rule-vs-gold reconciliation cannot by itself prove
 * physical shell truth; Alice-approved source provenance audit remains a separate
 * prerequisite and is reported in `coverageLimits`.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { L2_HEADS } from "../adapters/l2/contracts.js";
import type { L2Head, L2TrainingRow } from "../adapters/l2/contracts.js";
import {
  E19_FEATURES,
  E_LABELS,
  LITERAL_GOAL_KINDS,
  READ_GOAL_KINDS,
  type HybridGoalFamily,
  type HybridPackageResource,
  type HybridReceiptFact,
} from "./l2-hybrid-package.js";

export const OLD_READ_12_COLUMNS = [
  "goal.head",
  "goal.tail",
  "goal.N/16",
  "receipt.present",
  "actual.head",
  "actual.tail",
  "execution.succeeded",
  "execution.failed",
  "execution.unknown",
  "output.linesKnown",
  "output.logicalLines/16",
  "actual.N/16",
] as const;

export const NEW_LITERAL_7_COLUMNS = [
  "goal.isLiteral",
  "grep.present",
  "grep.normalCompleted",
  "grep.execFailed",
  "grep.queryMatches",
  "grep.rawHitValid",
  "grep.rawCompleteNoMatch",
] as const;

export type StandardSourceFormat =
  | "curated-read-json"
  | "incremental-read-json"
  | "g3-derived-jsonl"
  | "hybrid-unified-jsonl"
  | "head-rows-jsonl";

export interface StandardDataSourceDecl {
  readonly name: string;
  readonly path: string;
  readonly format: StandardSourceFormat;
  readonly expectedPartition: "TRAIN" | "DEV";
  readonly ruleProfile?: string;
  /**
   * Whether the source contract establishes explicit receipt knownness on the
   * receipt presence column (`3` for read, `13` for literal). If `false`, rows
   * without explicit `receiptFact.known === true` remain `unresolved`.
   */
  readonly sourceContractSupportsReceiptKnownness?: boolean;
}

export interface UnifiedMigratedSampleRow {
  readonly sourceRef: {
    readonly file: string;
    readonly rowIndex: number;
    readonly originalId: string;
  };
  readonly head: L2Head;
  readonly partition: "TRAIN" | "DEV";
  readonly originalRow: unknown;
  readonly originalFeatures: readonly number[];
  readonly mlpFeatures19: readonly number[];
  readonly semanticGold: string;
  readonly ruleProfile: string;
  readonly family: HybridGoalFamily;
  readonly receiptFact: HybridReceiptFact;
  readonly expectedGate: {
    readonly read: 0 | 1;
    readonly literal: 0 | 1;
  };
  readonly supervisionRoute: "fixed" | "learned";
  readonly unresolvedReason: string | null;
}

export interface DataInvalidViolation {
  readonly code: "DATA_INVALID";
  readonly source: string;
  readonly rowIndex: number | null;
  readonly rowId: string | null;
  readonly reason: string;
}

export interface SourceValidationSummary {
  readonly sourceName: string;
  readonly file: string;
  readonly partition: "TRAIN" | "DEV";
  readonly totalRows: number;
  readonly originalUniqueProjections: number;
  readonly hybridUniqueProjections: number;
  readonly fixedRows: number;
  readonly learnedRows: number;
  readonly learnedUniqueProjections: number;
  readonly contradictoryGoldCount: number;
  readonly unresolvedCount: number;
}

export interface DataGateValidationResult {
  readonly status: "READY" | "NO_LEARNED_ROWS" | "DATA_INVALID";
  readonly head: L2Head;
  readonly expectedPartition: "TRAIN" | "DEV";
  readonly rows: readonly UnifiedMigratedSampleRow[];
  readonly fixedRows: readonly UnifiedMigratedSampleRow[];
  readonly learnedRows: readonly UnifiedMigratedSampleRow[];
  readonly unresolvedRows: readonly UnifiedMigratedSampleRow[];
  readonly learnedTrainingRows: readonly L2TrainingRow[];
  readonly counts: {
    readonly totalRows: number;
    readonly fixedRows: number;
    readonly learnedRows: number;
    readonly unresolvedRows: number;
    readonly originalUniqueProjections: number;
    readonly hybridUniqueProjections: number;
    readonly learnedUniqueProjections: number;
    readonly contradictoryGoldCount: number;
  };
  readonly perSource: readonly SourceValidationSummary[];
  readonly violations: readonly DataInvalidViolation[];
  readonly firstViolation: DataInvalidViolation | null;
  readonly coverageLimits: readonly string[];
}

const COVERAGE_LIMITS = [
  "Static data-gate validation checks source/partition, feature schema/order, finite values, receipt knownness consistency, fixed Handwired rule agreement with semantic gold, and identical-feature gold conflicts.",
  "Static JSON/JSONL schema checks cannot by themselves prove physical shell execution truth; Alice-approved source provenance audit remains a prerequisite.",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalFeatureKey(values: readonly number[]): string {
  return values.map(v => `${Math.fround(v)}`).join(",");
}

function defaultGoalForFamily(family: HybridGoalFamily): { readonly kind: string } {
  return {
    kind: family === "read" ? READ_GOAL_KINDS[0] : LITERAL_GOAL_KINDS[0],
  };
}

function parseRawSourceItems(rawText: string, format: StandardSourceFormat, filePath: string): {
  readonly items: readonly unknown[];
  readonly parseViolation: DataInvalidViolation | null;
} {
  try {
    if (format === "curated-read-json" || format === "incremental-read-json") {
      const parsed = JSON.parse(rawText) as unknown;
      if (!Array.isArray(parsed)) {
        return {
          items: [],
          parseViolation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex: null,
            rowId: null,
            reason: `expected top-level JSON array for format ${format}`,
          },
        };
      }
      return { items: parsed, parseViolation: null };
    }
    const lines = rawText.split(/\r?\n/);
    const items: unknown[] = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]!.trim();
      if (line.length === 0) continue;
      try {
        items.push(JSON.parse(line));
      } catch (err) {
        return {
          items: [],
          parseViolation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex: idx,
            rowId: null,
            reason: `invalid JSONL at line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }
    return { items, parseViolation: null };
  } catch (err) {
    return {
      items: [],
      parseViolation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex: null,
        rowId: null,
        reason: `failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

function normalizePartition(raw: unknown): "TRAIN" | "DEV" | "VERIFY" | "INVALID" {
  if (typeof raw !== "string") return "INVALID";
  const upper = raw.toUpperCase();
  if (upper === "TRAIN") return "TRAIN";
  if (upper === "DEV" || upper === "DEVELOPMENT") return "DEV";
  if (upper === "VERIFY" || upper === "VERIFICATION" || upper === "TEST") return "VERIFY";
  return "INVALID";
}

function validateAndConvertSingleRow(params: {
  readonly rawItem: unknown;
  readonly rowIndex: number;
  readonly sourceDecl: StandardDataSourceDecl;
  readonly head: L2Head;
  readonly hybridResource: HybridPackageResource;
  readonly filterToExpectedPartition: boolean;
}): {
  readonly skippedOtherPartition: boolean;
  readonly row: UnifiedMigratedSampleRow | null;
  readonly violation: DataInvalidViolation | null;
  readonly contradictoryGold: boolean;
} {
  const { rawItem, rowIndex, sourceDecl, head, hybridResource, filterToExpectedPartition } = params;
  const filePath = sourceDecl.path;
  const ruleProfile = sourceDecl.ruleProfile ?? "cli.hybrid-package.v1#default-e-pre-post";
  const supportsKnownness = sourceDecl.sourceContractSupportsReceiptKnownness !== false;

  if (!isRecord(rawItem)) {
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: null,
        reason: "row is not a JSON object",
      },
    };
  }

  const rawPartition = normalizePartition(rawItem.partition);
  if (rawPartition === "INVALID") {
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: String(rawItem.id ?? rawItem.sampleId ?? rawItem.stateId ?? `row-${rowIndex}`),
        reason: `invalid or missing partition ${JSON.stringify(rawItem.partition)}`,
      },
    };
  }
  if (rawPartition === "VERIFY") {
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: String(rawItem.id ?? rawItem.sampleId ?? rawItem.stateId ?? `row-${rowIndex}`),
        reason: "VERIFY partition is strictly forbidden in standard converter and training data gate",
      },
    };
  }

  if (rawPartition !== sourceDecl.expectedPartition) {
    if (
      filterToExpectedPartition
      && (sourceDecl.format === "curated-read-json" || sourceDecl.format === "incremental-read-json")
    ) {
      return {
        skippedOtherPartition: true,
        row: null,
        contradictoryGold: false,
        violation: null,
      };
    }
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: String(rawItem.id ?? rawItem.sampleId ?? rawItem.stateId ?? `row-${rowIndex}`),
        reason: `row partition ${rawPartition} does not match expected ${sourceDecl.expectedPartition}`,
      },
    };
  }

  const format = sourceDecl.format;
  const spec = hybridResource.profile.heads[head].spec;

  // Non-E head rows (`R`, `D`, `A`)
  if (head !== "E") {
    const rowId =
      typeof rawItem.id === "string" && rawItem.id.length > 0
        ? rawItem.id
        : typeof rawItem.sampleId === "string" && rawItem.sampleId.length > 0
          ? rawItem.sampleId
          : `${sourceDecl.name}:${rowIndex}`;
    if (format !== "head-rows-jsonl") {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `head ${head} only supports format "head-rows-jsonl", got ${JSON.stringify(format)}`,
        },
      };
    }
    if (typeof rawItem.head === "string" && rawItem.head !== head) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `row head ${rawItem.head} does not match declared head ${head}`,
        },
      };
    }
    if (!Array.isArray(rawItem.features) || rawItem.features.length !== spec.features.length) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `head ${head} expects ${spec.features.length} features, got ${Array.isArray(rawItem.features) ? rawItem.features.length : "non-array"}`,
        },
      };
    }
    if (
      Array.isArray(rawItem.featureNames)
      && (rawItem.featureNames.length !== spec.features.length
        || rawItem.featureNames.some((n, idx) => n !== spec.features[idx]))
    ) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `head ${head} featureNames order mismatch`,
        },
      };
    }
    const features: number[] = [];
    for (let i = 0; i < rawItem.features.length; i += 1) {
      const val = rawItem.features[i];
      if (typeof val !== "number" || !Number.isFinite(val)) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId,
            reason: `non-finite feature at index ${i}`,
          },
        };
      }
      features.push(val);
    }
    const rawGold =
      typeof rawItem.semanticGold === "string"
        ? rawItem.semanticGold
        : typeof rawItem.gold === "string"
          ? rawItem.gold
          : typeof rawItem.labelName === "string"
            ? rawItem.labelName
            : typeof rawItem.label === "string"
              ? rawItem.label
              : Array.isArray(rawItem.allowed) && typeof rawItem.allowed[0] === "string"
                ? rawItem.allowed[0]
                : null;
    if (rawGold === null || !spec.labels.includes(rawGold)) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `invalid or unsupported gold label ${JSON.stringify(rawGold)} for head ${head}`,
        },
      };
    }
    if (rawItem.supervisionRoute !== undefined && rawItem.supervisionRoute !== "learned") {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `head ${head} has no Handwired fixed rule stage; supervisionRoute=${JSON.stringify(rawItem.supervisionRoute)} is not permitted without rule basis`,
        },
      };
    }
    const row: UnifiedMigratedSampleRow = {
      sourceRef: { file: filePath, rowIndex, originalId: rowId },
      head,
      partition: rawPartition,
      originalRow: structuredClone(rawItem),
      originalFeatures: [...features],
      mlpFeatures19: [...features],
      semanticGold: rawGold,
      ruleProfile,
      family: "read",
      receiptFact: { known: true, present: true },
      expectedGate: { read: 0, literal: 0 },
      supervisionRoute: "learned",
      unresolvedReason: typeof rawItem.unresolvedReason === "string" ? rawItem.unresolvedReason : null,
    };
    if (row.unresolvedReason !== null) {
      return {
        skippedOtherPartition: false,
        row,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId,
          reason: `unresolved provenance: ${row.unresolvedReason}`,
        },
      };
    }
    return {
      skippedOtherPartition: false,
      row,
      contradictoryGold: false,
      violation: null,
    };
  }

  // Head E conversion and validation across the 4 E formats:
  let originalId = "";
  let originalFeatures: number[] = [];
  let mlpFeatures19: number[] = [];
  let semanticGold = "";
  let family: HybridGoalFamily = "read";
  let receiptFact: HybridReceiptFact = { known: false, present: null };
  let unresolvedReason: string | null = null;

  if (format === "curated-read-json") {
    originalId = typeof rawItem.stateId === "string" && rawItem.stateId.length > 0
      ? rawItem.stateId
      : `curated-${rowIndex}`;
    const inputObj = rawItem.input;
    if (!isRecord(inputObj)) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: "curated row.input must be an object with the 12 ordered read columns",
        },
      };
    }
    const keys = Object.keys(inputObj);
    if (
      keys.length !== OLD_READ_12_COLUMNS.length
      || !OLD_READ_12_COLUMNS.every(col => Object.prototype.hasOwnProperty.call(inputObj, col))
    ) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `curated row.input keys mismatch expected 12 read columns: got ${JSON.stringify(keys)}`,
        },
      };
    }
    for (const col of OLD_READ_12_COLUMNS) {
      const v = inputObj[col];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `curated column ${col} is not a finite number`,
          },
        };
      }
      originalFeatures.push(v);
    }
    mlpFeatures19 = [...originalFeatures, 0, 0, 0, 0, 0, 0, 0];
    const sup = isRecord(rawItem.supervision) ? rawItem.supervision.E : undefined;
    if (typeof sup !== "string" || !(E_LABELS as readonly string[]).includes(sup)) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `curated supervision.E is invalid: ${JSON.stringify(sup)}`,
        },
      };
    }
    semanticGold = sup;
    family = "read";
    if (!supportsKnownness) {
      receiptFact = { known: false, present: null };
      unresolvedReason = "source contract does not establish receipt knownness";
    } else {
      const rVal = originalFeatures[3]!;
      if (rVal !== 0 && rVal !== 1) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `receipt.present column[3] must be 0 or 1, got ${rVal}`,
          },
        };
      }
      receiptFact = { known: true, present: rVal === 1 };
    }
  } else if (format === "incremental-read-json") {
    originalId =
      typeof rawItem.episode === "string" && rawItem.episode.length > 0
        ? rawItem.episode
        : typeof rawItem.goal === "string" && typeof rawItem.phase === "string"
          ? `${rawItem.goal}/${rawItem.phase}#${rowIndex}`
          : `incremental-${rowIndex}`;
    const inputArr = rawItem.input;
    if (!Array.isArray(inputArr) || inputArr.length !== OLD_READ_12_COLUMNS.length) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `incremental row.input must be an array of 12 numbers, got ${Array.isArray(inputArr) ? inputArr.length : "non-array"}`,
        },
      };
    }
    for (let i = 0; i < inputArr.length; i += 1) {
      const v = inputArr[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `incremental input[${i}] is not a finite number`,
          },
        };
      }
      originalFeatures.push(v);
    }
    mlpFeatures19 = [...originalFeatures, 0, 0, 0, 0, 0, 0, 0];
    const sup = rawItem.E;
    if (typeof sup !== "string" || !(E_LABELS as readonly string[]).includes(sup)) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `incremental E label is invalid: ${JSON.stringify(sup)}`,
        },
      };
    }
    semanticGold = sup;
    family = "read";
    if (!supportsKnownness) {
      receiptFact = { known: false, present: null };
      unresolvedReason = "source contract does not establish receipt knownness";
    } else {
      const rVal = originalFeatures[3]!;
      if (rVal !== 0 && rVal !== 1) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `receipt.present column[3] must be 0 or 1, got ${rVal}`,
          },
        };
      }
      receiptFact = { known: true, present: rVal === 1 };
    }
  } else if (format === "g3-derived-jsonl") {
    originalId =
      typeof rawItem.sampleId === "string" && rawItem.sampleId.length > 0
        ? rawItem.sampleId
        : `g3-${rowIndex}`;
    const featArr = rawItem.features;
    if (!Array.isArray(featArr) || featArr.length !== E19_FEATURES.length) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `g3-derived row.features must have length 19, got ${Array.isArray(featArr) ? featArr.length : "non-array"}`,
        },
      };
    }
    if (
      Array.isArray(rawItem.featureNames)
      && (rawItem.featureNames.length !== E19_FEATURES.length
        || rawItem.featureNames.some((n, idx) => n !== E19_FEATURES[idx]))
    ) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: "g3-derived featureNames do not match E19_FEATURES order",
        },
      };
    }
    for (let i = 0; i < featArr.length; i += 1) {
      const v = featArr[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `g3-derived features[${i}] is not a finite number`,
          },
        };
      }
      originalFeatures.push(v);
    }
    mlpFeatures19 = [...originalFeatures];

    let labelIndex: number | null = null;
    if (typeof rawItem.label === "number" && Number.isInteger(rawItem.label)) {
      labelIndex = rawItem.label;
    } else if (typeof rawItem.label === "string" && (E_LABELS as readonly string[]).includes(rawItem.label)) {
      labelIndex = E_LABELS.indexOf(rawItem.label as typeof E_LABELS[number]);
    } else if (typeof rawItem.labelIndex === "number" && Number.isInteger(rawItem.labelIndex)) {
      labelIndex = rawItem.labelIndex;
    }
    if (labelIndex === null || labelIndex < 0 || labelIndex >= E_LABELS.length) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `g3-derived label/labelIndex is invalid: label=${JSON.stringify(rawItem.label)}, labelIndex=${JSON.stringify(rawItem.labelIndex)}`,
        },
      };
    }
    const expectedLabelName = E_LABELS[labelIndex]!;
    if (typeof rawItem.labelName === "string" && rawItem.labelName !== expectedLabelName) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `g3-derived labelName ${rawItem.labelName} disagrees with label index ${labelIndex} (${expectedLabelName})`,
        },
      };
    }
    if (
      typeof rawItem.label === "string"
      && typeof rawItem.labelIndex === "number"
      && E_LABELS[rawItem.labelIndex] !== rawItem.label
    ) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `g3-derived string label ${rawItem.label} disagrees with labelIndex ${rawItem.labelIndex}`,
        },
      };
    }
    semanticGold = expectedLabelName;
    family = "literal";
    if (!supportsKnownness) {
      receiptFact = { known: false, present: null };
      unresolvedReason = "source contract does not establish literal receipt knownness";
    } else {
      const gVal = mlpFeatures19[13]!;
      if (gVal !== 0 && gVal !== 1) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `grep.present column[13] must be 0 or 1, got ${gVal}`,
          },
        };
      }
      receiptFact = { known: true, present: gVal === 1 };
    }
  } else if (format === "hybrid-unified-jsonl") {
    const sourceRef = isRecord(rawItem.sourceRef) ? rawItem.sourceRef : null;
    originalId =
      sourceRef !== null && typeof sourceRef.originalId === "string" && sourceRef.originalId.length > 0
        ? sourceRef.originalId
        : typeof rawItem.id === "string" && rawItem.id.length > 0
          ? rawItem.id
          : `unified-${rowIndex}`;
    const feat19 = rawItem.mlpFeatures19;
    if (!Array.isArray(feat19) || feat19.length !== E19_FEATURES.length) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `hybrid-unified mlpFeatures19 must have length 19`,
        },
      };
    }
    for (let i = 0; i < feat19.length; i += 1) {
      const v = feat19[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `hybrid-unified mlpFeatures19[${i}] is not finite`,
          },
        };
      }
      mlpFeatures19.push(v);
    }
    originalFeatures = Array.isArray(rawItem.originalFeatures)
      ? rawItem.originalFeatures.map(Number)
      : [...mlpFeatures19];
    if (typeof rawItem.semanticGold !== "string" || !(E_LABELS as readonly string[]).includes(rawItem.semanticGold)) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `hybrid-unified semanticGold is invalid: ${JSON.stringify(rawItem.semanticGold)}`,
        },
      };
    }
    semanticGold = rawItem.semanticGold;
    if (rawItem.family !== "read" && rawItem.family !== "literal") {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `hybrid-unified family must be "read" or "literal", got ${JSON.stringify(rawItem.family)}`,
        },
      };
    }
    family = rawItem.family;
    if (!isRecord(rawItem.receiptFact) || typeof rawItem.receiptFact.known !== "boolean") {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: "hybrid-unified receiptFact.known must be boolean",
        },
      };
    }
    const rfPresent = rawItem.receiptFact.present;
    if (rfPresent !== null && typeof rfPresent !== "boolean") {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: "hybrid-unified receiptFact.present must be boolean or null",
        },
      };
    }
    receiptFact = { known: rawItem.receiptFact.known, present: rfPresent };
    unresolvedReason =
      typeof rawItem.unresolvedReason === "string" && rawItem.unresolvedReason.length > 0
        ? rawItem.unresolvedReason
        : !receiptFact.known
          ? "receiptFact.known is false (unresolved provenance)"
          : null;
  } else {
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: String(rawItem.id ?? rawItem.sampleId ?? rawItem.stateId ?? `row-${rowIndex}`),
        reason: `head E does not support generic format ${JSON.stringify(format)}; use a dedicated E format (curated-read-json, incremental-read-json, g3-derived-jsonl, or hybrid-unified-jsonl)`,
      },
    };
  }

  // Reconcile with the actual Handwired pre/MLP/post stage in hybridResource!
  let inferResult;
  try {
    inferResult = hybridResource.inferE({
      goal: defaultGoalForFamily(family),
      features19: mlpFeatures19,
      receiptFact,
    });
  } catch (err) {
    return {
      skippedOtherPartition: false,
      row: null,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: originalId,
        reason: `hybrid contract check failed on row: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const readGate: 0 | 1 = inferResult.readGate === 1 ? 1 : 0;
  const literalGate: 0 | 1 = inferResult.literalGate === 1 ? 1 : 0;
  const supervisionRoute: "fixed" | "learned" = inferResult.fixed ? "fixed" : "learned";

  if (format === "hybrid-unified-jsonl") {
    if (
      typeof rawItem.supervisionRoute === "string"
      && rawItem.supervisionRoute !== supervisionRoute
    ) {
      return {
        skippedOtherPartition: false,
        row: null,
        contradictoryGold: false,
        violation: {
          code: "DATA_INVALID",
          source: filePath,
          rowIndex,
          rowId: originalId,
          reason: `declared supervisionRoute ${rawItem.supervisionRoute} conflicts with Handwired stage route ${supervisionRoute}`,
        },
      };
    }
    if (isRecord(rawItem.expectedGate)) {
      if (rawItem.expectedGate.read !== readGate || rawItem.expectedGate.literal !== literalGate) {
        return {
          skippedOtherPartition: false,
          row: null,
          contradictoryGold: false,
          violation: {
            code: "DATA_INVALID",
            source: filePath,
            rowIndex,
            rowId: originalId,
            reason: `declared expectedGate ${JSON.stringify(rawItem.expectedGate)} conflicts with Handwired stage gate {read:${readGate},literal:${literalGate}}`,
          },
        };
      }
    }
  }

  const migratedRow: UnifiedMigratedSampleRow = {
    sourceRef: {
      file: filePath,
      rowIndex,
      originalId,
    },
    head,
    partition: rawPartition,
    originalRow: structuredClone(rawItem),
    originalFeatures,
    mlpFeatures19,
    semanticGold,
    ruleProfile,
    family,
    receiptFact,
    expectedGate: {
      read: readGate,
      literal: literalGate,
    },
    supervisionRoute,
    unresolvedReason,
  };

  if (unresolvedReason !== null) {
    return {
      skippedOtherPartition: false,
      row: migratedRow,
      contradictoryGold: false,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: originalId,
        reason: `unresolved row provenance: ${unresolvedReason}`,
      },
    };
  }

  // Step 4 of owner-audit: reconcile fixed Handwired rule and semanticGold!
  if (supervisionRoute === "fixed" && inferResult.label !== semanticGold) {
    return {
      skippedOtherPartition: false,
      row: migratedRow,
      contradictoryGold: true,
      violation: {
        code: "DATA_INVALID",
        source: filePath,
        rowIndex,
        rowId: originalId,
        reason: `fixed Handwired rule output "${inferResult.label}" contradicts semanticGold "${semanticGold}" (family=${family}, receiptFact=${JSON.stringify(receiptFact)})`,
      },
    };
  }

  return {
    skippedOtherPartition: false,
    row: migratedRow,
    contradictoryGold: false,
    violation: null,
  };
}

export async function validateStandardTrainingData(params: {
  readonly head: L2Head;
  readonly expectedPartition: "TRAIN" | "DEV";
  readonly sources: readonly StandardDataSourceDecl[];
  readonly hybridResource: HybridPackageResource;
  /**
   * When true (`curated` / `incremental` multi-partition files), rows belonging
   * to the other legal partition (`TRAIN` vs `DEV`) are filtered out while
   * preserving original zero-based `rowIndex`. For dedicated partition files,
   * set false so any wrong-partition row triggers `DATA_INVALID`.
   */
  readonly filterMultiPartitionJson?: boolean;
  /**
   * When true (used by `evaluate`), rows with `unresolvedReason !== null` are
   * retained in `unresolvedRows` and counted in the behavioral evaluation
   * denominator rather than aborting with `DATA_INVALID`. For `validate-data`,
   * `train`, `resume`, and `convert-samples`, unresolved rows trigger `DATA_INVALID`.
   */
  readonly allowUnresolvedForEvaluation?: boolean;
}): Promise<DataGateValidationResult> {
  const {
    head,
    expectedPartition,
    sources,
    hybridResource,
    filterMultiPartitionJson = true,
    allowUnresolvedForEvaluation = false,
  } = params;

  const violations: DataInvalidViolation[] = [];
  if (!L2_HEADS.includes(head)) {
    violations.push({
      code: "DATA_INVALID",
      source: "<config>",
      rowIndex: null,
      rowId: null,
      reason: `unsupported head ${String(head)}`,
    });
  }
  if (sources.length === 0) {
    violations.push({
      code: "DATA_INVALID",
      source: "<config>",
      rowIndex: null,
      rowId: null,
      reason: "no data sources declared",
    });
  }

  const allRows: UnifiedMigratedSampleRow[] = [];
  const fixedRows: UnifiedMigratedSampleRow[] = [];
  const learnedRows: UnifiedMigratedSampleRow[] = [];
  const unresolvedRows: UnifiedMigratedSampleRow[] = [];
  const perSource: SourceValidationSummary[] = [];

  const globalOriginalProjections = new Set<string>();
  const globalHybridProjections = new Set<string>();
  const globalLearnedFeatureGold = new Map<
    string,
    { readonly gold: string; readonly source: string; readonly rowIndex: number; readonly rowId: string }
  >();
  let totalContradictoryGold = 0;

  for (const sourceDecl of sources) {
    if (sourceDecl.expectedPartition !== expectedPartition) {
      violations.push({
        code: "DATA_INVALID",
        source: sourceDecl.path,
        rowIndex: null,
        rowId: null,
        reason: `source ${sourceDecl.name} declares expectedPartition=${sourceDecl.expectedPartition}, but command requires ${expectedPartition}`,
      });
      continue;
    }

    const resolvedPath = resolve(sourceDecl.path);
    let rawText: string;
    try {
      rawText = await readFile(resolvedPath, "utf8");
    } catch (err) {
      violations.push({
        code: "DATA_INVALID",
        source: sourceDecl.path,
        rowIndex: null,
        rowId: null,
        reason: `cannot read source file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const { items, parseViolation } = parseRawSourceItems(rawText, sourceDecl.format, sourceDecl.path);
    if (parseViolation !== null) {
      violations.push(parseViolation);
      continue;
    }

    const srcOrigProj = new Set<string>();
    const srcHybridProj = new Set<string>();
    const srcLearnedProj = new Set<string>();
    let srcTotal = 0;
    let srcFixed = 0;
    let srcLearned = 0;
    let srcContradictory = 0;
    let srcUnresolved = 0;

    for (let rowIndex = 0; rowIndex < items.length; rowIndex += 1) {
      const converted = validateAndConvertSingleRow({
        rawItem: items[rowIndex],
        rowIndex,
        sourceDecl,
        head,
        hybridResource,
        filterToExpectedPartition: filterMultiPartitionJson,
      });
      if (converted.skippedOtherPartition) continue;

      srcTotal += 1;
      if (converted.contradictoryGold) {
        srcContradictory += 1;
        totalContradictoryGold += 1;
      }

      if (converted.row !== null) {
        const row = converted.row;
        const origKey = canonicalFeatureKey(row.originalFeatures);
        const hybridKey = `${row.family}|${row.receiptFact.known ? (row.receiptFact.present ? "1" : "0") : "u"}|${canonicalFeatureKey(row.mlpFeatures19)}`;
        srcOrigProj.add(origKey);
        srcHybridProj.add(hybridKey);
        globalOriginalProjections.add(origKey);
        globalHybridProjections.add(hybridKey);

        allRows.push(row);
        if (row.unresolvedReason !== null) {
          srcUnresolved += 1;
          unresolvedRows.push(row);
          if (!allowUnresolvedForEvaluation && converted.violation !== null) {
            violations.push(converted.violation);
          }
          continue;
        }

        if (converted.violation !== null && !(allowUnresolvedForEvaluation && converted.contradictoryGold)) {
          violations.push(converted.violation);
          continue;
        }

        if (row.supervisionRoute === "fixed") {
          srcFixed += 1;
          fixedRows.push(row);
        } else {
          srcLearned += 1;
          learnedRows.push(row);
          const featureOnlyKey = canonicalFeatureKey(row.mlpFeatures19);
          srcLearnedProj.add(`${featureOnlyKey}|${row.semanticGold}`);
          const prev = globalLearnedFeatureGold.get(featureOnlyKey);
          if (prev !== undefined && prev.gold !== row.semanticGold && !allowUnresolvedForEvaluation) {
            violations.push({
              code: "DATA_INVALID",
              source: sourceDecl.path,
              rowIndex,
              rowId: row.sourceRef.originalId,
              reason: `conflicting learned gold for identical features: row ${row.sourceRef.originalId} has "${row.semanticGold}" vs earlier row ${prev.rowId} (${prev.source}:${prev.rowIndex}) with "${prev.gold}"`,
            });
          } else if (prev === undefined) {
            globalLearnedFeatureGold.set(featureOnlyKey, {
              gold: row.semanticGold,
              source: sourceDecl.path,
              rowIndex,
              rowId: row.sourceRef.originalId,
            });
          }
        }
      } else if (converted.violation !== null) {
        violations.push(converted.violation);
      }
    }

    perSource.push({
      sourceName: sourceDecl.name,
      file: sourceDecl.path,
      partition: expectedPartition,
      totalRows: srcTotal,
      originalUniqueProjections: srcOrigProj.size,
      hybridUniqueProjections: srcHybridProj.size,
      fixedRows: srcFixed,
      learnedRows: srcLearned,
      learnedUniqueProjections: srcLearnedProj.size,
      contradictoryGoldCount: srcContradictory,
      unresolvedCount: srcUnresolved,
    });
  }

  if (allRows.length === 0 && violations.length === 0) {
    violations.push({
      code: "DATA_INVALID",
      source: sources[0]?.path ?? "<config>",
      rowIndex: null,
      rowId: null,
      reason: `sources produced 0 rows for partition ${expectedPartition}`,
    });
  }

  const learnedTrainingRows: L2TrainingRow[] = learnedRows.map((row, idx) => ({
    id: `${row.sourceRef.file}#${row.sourceRef.rowIndex}:${row.sourceRef.originalId}:${idx}`,
    sourceGroup: row.sourceRef.file,
    partition: expectedPartition === "TRAIN" ? "train" : "dev",
    head: row.head,
    features: [...row.mlpFeatures19],
    allowed: [row.semanticGold],
  }));

  const status: "READY" | "NO_LEARNED_ROWS" | "DATA_INVALID" =
    violations.length > 0
      ? "DATA_INVALID"
      : learnedRows.length === 0
        ? "NO_LEARNED_ROWS"
        : "READY";

  return {
    status,
    head,
    expectedPartition,
    rows: allRows,
    fixedRows,
    learnedRows,
    unresolvedRows,
    learnedTrainingRows,
    counts: {
      totalRows: allRows.length,
      fixedRows: fixedRows.length,
      learnedRows: learnedRows.length,
      unresolvedRows: unresolvedRows.length,
      originalUniqueProjections: globalOriginalProjections.size,
      hybridUniqueProjections: globalHybridProjections.size,
      learnedUniqueProjections: globalLearnedFeatureGold.size,
      contradictoryGoldCount: totalContradictoryGold,
    },
    perSource,
    violations,
    firstViolation: violations[0] ?? null,
    coverageLimits: [...COVERAGE_LIMITS],
  };
}

/**
 * Convert declared source corpora into the unified migrated JSONL format per
 * `handwired-sample-migration-contract.md`. Refuses to write output JSONL if any
 * `DATA_INVALID` conflict or unresolved provenance is found, writing a conflict
 * report instead.
 */
export async function convertSamplesToUnifiedJsonl(params: {
  readonly head: L2Head;
  readonly expectedPartition: "TRAIN" | "DEV";
  readonly sources: readonly StandardDataSourceDecl[];
  readonly hybridResource: HybridPackageResource;
  readonly outputJsonlPath: string;
  readonly reportJsonPath: string;
  readonly filterMultiPartitionJson?: boolean;
}): Promise<{
  readonly validation: DataGateValidationResult;
  readonly outputWritten: boolean;
}> {
  const validation = await validateStandardTrainingData({
    head: params.head,
    expectedPartition: params.expectedPartition,
    sources: params.sources,
    hybridResource: params.hybridResource,
    ...(params.filterMultiPartitionJson !== undefined
      ? { filterMultiPartitionJson: params.filterMultiPartitionJson }
      : {}),
    allowUnresolvedForEvaluation: false,
  });

  const reportPayload = {
    schema: "nnanything.l2.sample-migration-report.v1",
    status: validation.status === "DATA_INVALID" ? "DATA_INVALID" : "CONVERTED",
    head: validation.head,
    partition: validation.expectedPartition,
    counts: validation.counts,
    perSource: validation.perSource,
    violations: validation.violations,
    firstViolation: validation.firstViolation,
    coverageLimits: validation.coverageLimits,
  };

  const resolvedReport = resolve(params.reportJsonPath);
  await mkdir(dirname(resolvedReport), { recursive: true });
  const tempReport = `${resolvedReport}.${process.pid}.${Date.now()}.tmp`;
  const rHandle = await open(tempReport, "w");
  try {
    await rHandle.writeFile(`${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");
    await rHandle.sync();
  } finally {
    await rHandle.close();
  }
  await rename(tempReport, resolvedReport);

  if (validation.status === "DATA_INVALID") {
    return { validation, outputWritten: false };
  }

  const resolvedJsonl = resolve(params.outputJsonlPath);
  await mkdir(dirname(resolvedJsonl), { recursive: true });
  const tempJsonl = `${resolvedJsonl}.${process.pid}.${Date.now()}.tmp`;
  const jHandle = await open(tempJsonl, "w");
  try {
    const body = validation.rows.map(row => JSON.stringify(row)).join("\n");
    await jHandle.writeFile(body.length > 0 ? `${body}\n` : "", "utf8");
    await jHandle.sync();
  } finally {
    await jHandle.close();
  }
  await rename(tempJsonl, resolvedJsonl);

  return { validation, outputWritten: true };
}
