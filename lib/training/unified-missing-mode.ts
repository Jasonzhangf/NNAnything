// Shared missing-mode declaration validation for the unified 64-slot path.
//
// Rules (bidirectional between declaration and vector):
//   - missingMode must be an array.
//   - every entry must be an object;
//   - slotIndex must be an integer in 0..63;
//   - fill must be -1;
//   - reason must be a non-empty string;
//   - every declared slot must hold -1 in input;
//   - every -1 in input must be declared.
//
// Consumers map the returned kind to their own error vocabulary:
//   - ROW_SCHEMA_INVALID for declared-but-bad entries (gate),
//   - UnifiedTrainDataError for bad explicit missingMode (student config),
//   - MISSING_FILLED only for declaration/vector disagreement (gate,
//     preserving existing test semantics).
//
// Historical `missingMode === undefined` inference is not touched here:
// that branch is owned by unified-train-config.loadStudentRowsFile.

export type MissingModeCheckKind =
  | "ok"
  | "not_array"
  | "bad_entry"
  | "undeclared_missing"
  | "declared_not_missing";

export const UNIFIED_MISSING_MODE_CODES = {
  NOT_ARRAY: "missingMode must be an array",
  NOT_OBJECT: "missingMode entries must be objects",
  SLOT_OUT_OF_RANGE: "missingMode slotIndex must be an integer in 0..63",
  FILL_NOT_MINUS_ONE: "missingMode fill must be -1",
  REASON_EMPTY: "missingMode reason must be a non-empty string",
  UNDECLARED_MISSING: "input holds -1 at slot without a declared missing mode",
  DECLARED_NOT_MISSING: "declared missing slot does not hold -1 in input",
} as const;

export type MissingModeCheckResult =
  | { readonly ok: true; readonly kind: "ok" }
  | {
    readonly ok: false;
    readonly kind: Exclude<MissingModeCheckKind, "ok">;
    readonly entryIndex?: number;
    readonly slotIndex?: number;
    readonly message: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateMissingModeConsistency(
  input: readonly number[],
  missingMode: unknown,
): MissingModeCheckResult {
  if (!Array.isArray(missingMode)) {
    return { ok: false, kind: "not_array", message: UNIFIED_MISSING_MODE_CODES.NOT_ARRAY };
  }

  const declared = new Set<number>();
  for (let entryIndex = 0; entryIndex < missingMode.length; entryIndex += 1) {
    const entry = missingMode[entryIndex];
    if (!isRecord(entry)) {
      return {
        ok: false,
        kind: "bad_entry",
        entryIndex,
        message: `${UNIFIED_MISSING_MODE_CODES.NOT_OBJECT} [${entryIndex}]`,
      };
    }
    const slotIndex = entry.slotIndex;
    if (
      typeof slotIndex !== "number" ||
      !Number.isInteger(slotIndex) ||
      slotIndex < 0 ||
      slotIndex > 63
    ) {
      return {
        ok: false,
        kind: "bad_entry",
        entryIndex,
        ...(typeof slotIndex === "number" ? { slotIndex } : {}),
        message: `${UNIFIED_MISSING_MODE_CODES.SLOT_OUT_OF_RANGE} [${entryIndex}]`,
      };
    }
    if (entry.fill !== -1) {
      return {
        ok: false,
        kind: "bad_entry",
        entryIndex,
        slotIndex: slotIndex as number,
        message: `${UNIFIED_MISSING_MODE_CODES.FILL_NOT_MINUS_ONE} [${entryIndex}]`,
      };
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      return {
        ok: false,
        kind: "bad_entry",
        entryIndex,
        slotIndex: slotIndex as number,
        message: `${UNIFIED_MISSING_MODE_CODES.REASON_EMPTY} [${entryIndex}]`,
      };
    }
    declared.add(slotIndex);
  }

  if (input.length !== 64) {
    return { ok: true, kind: "ok" }; // input shape is owned elsewhere
  }
  for (let slotIndex = 0; slotIndex < input.length; slotIndex += 1) {
    if (input[slotIndex] === -1 && !declared.has(slotIndex)) {
      return {
        ok: false,
        kind: "undeclared_missing",
        slotIndex,
        message: `${UNIFIED_MISSING_MODE_CODES.UNDECLARED_MISSING} ${slotIndex}`,
      };
    }
    if (declared.has(slotIndex) && input[slotIndex] !== -1) {
      return {
        ok: false,
        kind: "declared_not_missing",
        slotIndex,
        message: `${UNIFIED_MISSING_MODE_CODES.DECLARED_NOT_MISSING} ${slotIndex}`,
      };
    }
  }
  return { ok: true, kind: "ok" };
}
