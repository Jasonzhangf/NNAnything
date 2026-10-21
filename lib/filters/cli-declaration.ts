import { posix } from "node:path";
import { isUtf8 } from "node:buffer";

// S15: declaration-derived reference edges only. Deterministic (D).
// - Only an explicitly named declaration field is a reference source.
// - Same-named strings elsewhere are not references.
// - Nothing is executed; only the declared JSON field is parsed.
// - Partial coverage never claims "no references".
// - Symbols/definition resolution and role inference are out of scope.

export type DeclaredReference = Readonly<{ target: string; field: string; ordinal: number }>;

export type DeclarationResult = Readonly<{
  status: "ok" | "unknown" | "rejected";
  coverage: "complete" | "partial";
  references: readonly DeclaredReference[];
  notes: readonly string[];
}>;

export type DeclarationInput = Readonly<{
  manifestPath: string;
  bytes: Uint8Array;
  complete: boolean;
  referencesField: string;
  scopePrefix: string;
}>;

function fail(status: "unknown" | "rejected", coverage: "complete" | "partial", notes: readonly string[]): DeclarationResult {
  return Object.freeze({ status, coverage, references: Object.freeze([]) as readonly DeclaredReference[], notes: Object.freeze([...notes]) });
}

export function readDeclaredReferences(input: DeclarationInput): DeclarationResult {
  const notes: string[] = [];
  const bytes = input.bytes;
  if (!input.complete) {
    notes.push("coverage_partial");
    return fail("unknown", "partial", notes);
  }
  if (!isUtf8(bytes)) {
    notes.push("bytes_not_utf8");
    return fail("unknown", "complete", notes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    notes.push("declaration_not_json");
    return fail("unknown", "complete", notes);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    notes.push("declaration_not_object");
    return fail("unknown", "complete", notes);
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, input.referencesField)) {
    notes.push("declared_field_absent");
    return fail("unknown", "complete", notes);
  }
  const declared = record[input.referencesField];
  if (!Array.isArray(declared)) {
    notes.push("declared_field_not_array");
    return fail("unknown", "complete", notes);
  }
  const references: DeclaredReference[] = [];
  const rejected: string[] = [];
  declared.forEach((entry, ordinal) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      rejected.push(`entry_${ordinal}_not_string`);
      return;
    }
    const resolved = posix.resolve(input.scopePrefix, entry);
    const inside = resolved === input.scopePrefix || resolved.startsWith(input.scopePrefix.endsWith("/") ? input.scopePrefix : `${input.scopePrefix}/`);
    if (!inside) {
      rejected.push(`entry_${ordinal}_out_of_scope`);
      return;
    }
    references.push(Object.freeze({ target: resolved, field: input.referencesField, ordinal }));
  });
  if (rejected.length > 0) {
    return Object.freeze({ status: "rejected" as const, coverage: "complete" as const, references: Object.freeze([]) as readonly DeclaredReference[], notes: Object.freeze([...notes, ...rejected]) });
  }
  if (references.length === 0) notes.push("declared_field_empty");
  return Object.freeze({ status: "ok" as const, coverage: "complete" as const, references: Object.freeze(references), notes: Object.freeze(notes) });
}