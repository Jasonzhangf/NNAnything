import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FeatureThresholds } from "./unified-encoder.js";
import { UNIFIED_ENCODER_VERSION } from "./unified-encoder.js";

export const UNIFIED_FEATURE_THRESHOLDS_SCHEMA = "nnanything.feature-thresholds.v1";
export const UNIFIED_MISSING_MODE_SCHEMA = "nnanything.unified.missing-mode.v1";
export const THRESHOLD_INVALID = "THRESHOLD_INVALID" as const;

const REQUIRED_BUCKETS = [
  "constraints",
  "knownFacts",
  "missingFacts",
  "objectRefs",
  "requiredArgsRatio",
  "requiredMissing",
] as const;

const BLOCKS = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"] as const;

export interface MissingModeEntry {
  readonly caseRef: string;
  readonly block: (typeof BLOCKS)[number];
  readonly slotIndex: number;
  readonly fill: -1;
  readonly reason: string;
}

export interface UnifiedMissingModeTable {
  readonly schema: typeof UNIFIED_MISSING_MODE_SCHEMA;
  readonly entries: readonly MissingModeEntry[];
}

export class UnifiedThresholdError extends Error {
  readonly code = THRESHOLD_INVALID;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "UnifiedThresholdError";
    this.detail = { ...detail, code: THRESHOLD_INVALID };
  }
}

function thresholdError(message: string, detail: Readonly<Record<string, unknown>> = {}): UnifiedThresholdError {
  return new UnifiedThresholdError(message, detail);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw thresholdError(`${label} must be an object`, { label });
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw thresholdError(`${label} must be a non-empty string`, { label });
  }
  return value;
}

function assertBucket(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw thresholdError(`${label} must have exactly 4 entries`, { label });
  }
  const numbers = value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw thresholdError(`${label}[${index}] must be finite`, { label });
    }
    return entry;
  });
  const first = numbers[0];
  const second = numbers[1];
  const third = numbers[2];
  const fourth = numbers[3];
  if (
    first === undefined || second === undefined || third === undefined || fourth === undefined
  ) {
    throw thresholdError(`${label} entries must be defined`, { label });
  }
  if (!(second > first && third > second && fourth > third)) {
    throw thresholdError(`${label} must be strictly increasing`, { label, value: numbers });
  }
  return numbers;
}

export function validateFeatureThresholds(raw: unknown): FeatureThresholds {
  const resource = assertObject(raw, "featureThresholds");
  if (resource.schema !== UNIFIED_FEATURE_THRESHOLDS_SCHEMA) {
    throw thresholdError("feature thresholds schema mismatch", {
      expected: UNIFIED_FEATURE_THRESHOLDS_SCHEMA,
      actual: resource.schema,
    });
  }
  const route = assertString(resource.route, "route");
  const encoderVersion = assertString(resource.encoderVersion, "encoderVersion");
  if (encoderVersion !== UNIFIED_ENCODER_VERSION) {
    throw thresholdError("feature thresholds encoderVersion mismatch", {
      expected: UNIFIED_ENCODER_VERSION,
      actual: encoderVersion,
    });
  }
  const rawBuckets = assertObject(resource.buckets, "buckets");
  const buckets: Record<string, readonly number[]> = {};
  for (const name of REQUIRED_BUCKETS) {
    buckets[name] = assertBucket(rawBuckets[name], `buckets.${name}`);
  }
  return {
    schema: UNIFIED_FEATURE_THRESHOLDS_SCHEMA,
    route,
    encoderVersion,
    buckets,
  };
}

export function validateMissingModeTable(raw: unknown): UnifiedMissingModeTable {
  const resource = assertObject(raw, "missingModeTable");
  if (resource.schema !== UNIFIED_MISSING_MODE_SCHEMA) {
    throw thresholdError("missing mode schema mismatch", {
      expected: UNIFIED_MISSING_MODE_SCHEMA,
      actual: resource.schema,
    });
  }
  if (!Array.isArray(resource.entries)) {
    throw thresholdError("missing mode entries must be an array", { label: "entries" });
  }
  const entries = resource.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `entries[${index}]`);
    const caseRef = assertString(entry.caseRef, `entries[${index}].caseRef`);
    const block = entry.block;
    if (typeof block !== "string" || !(BLOCKS as readonly string[]).includes(block)) {
      throw thresholdError(`entries[${index}].block must be one of G0..G7`, { block });
    }
    const slotIndex = entry.slotIndex;
    if (typeof slotIndex !== "number" || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 63) {
      throw thresholdError(`entries[${index}].slotIndex must be an integer in 0..63`, { slotIndex });
    }
    if (entry.fill !== -1) {
      throw thresholdError(`entries[${index}].fill must be -1`, { fill: entry.fill });
    }
    const reason = assertString(entry.reason, `entries[${index}].reason`);
    return { caseRef, block: block as MissingModeEntry["block"], slotIndex, fill: -1 as const, reason };
  });
  return { schema: UNIFIED_MISSING_MODE_SCHEMA, entries };
}

export async function loadFeatureThresholdsFromFile(path: string): Promise<FeatureThresholds> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return validateFeatureThresholds(raw);
}

export async function loadMissingModeTableFromFile(path: string): Promise<UnifiedMissingModeTable> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return validateMissingModeTable(raw);
}
