import { posix } from "node:path";
import { isUtf8 } from "node:buffer";

// S15: declaration-derived reference edges only. Deterministic (D).
// - Only an explicitly named declaration field is a reference source.
// - Same-named strings elsewhere are not references.
// - Nothing is executed; only the declared JSON field is parsed.
// - Partial coverage never claims "no references".
// - Manifest source must be inside the declared scope; a manifest outside the
//   scope is rejected (source/scope association is not inferred from names).
// - Relative reference entries resolve against the manifest's own directory,
//   not against an arbitrary prefix.
// - Every reference keeps its source endpoint (manifestPath).
// - Symbols/definition resolution and role inference are out of scope.

export type DeclaredReference = Readonly<{ target: string; field: string; ordinal: number; source: string }>;

export type DeclarationResult = Readonly<{
  status: "ok" | "unknown" | "rejected";
  coverage: "complete" | "partial";
  references: readonly DeclaredReference[];
  notes: readonly string[];
}>;

export type DeclarationInput = Readonly<{
  manifestPath: string; // the declaration source endpoint (absolute)
  bytes: Uint8Array;
  complete: boolean;
  referencesField: string;
  scopePrefix: string; // absolute scope the references must stay inside
}>;

function fail(status: "unknown" | "rejected", coverage: "complete" | "partial", notes: readonly string[]): DeclarationResult {
  return Object.freeze({ status, coverage, references: Object.freeze([]) as readonly DeclaredReference[], notes: Object.freeze([...notes]) });
}

function insideScope(path: string, scopePrefix: string): boolean {
  const normalized = posix.normalize(path);
  const scope = posix.normalize(scopePrefix);
  return normalized === scope || normalized.startsWith(scope.endsWith("/") ? scope : `${scope}/`);
}

export function readDeclaredReferences(input: DeclarationInput): DeclarationResult {
  const notes: string[] = [];
  const bytes = input.bytes;
  if (!posix.isAbsolute(input.manifestPath)) {
    notes.push("manifest_not_absolute");
    return fail("rejected", "complete", notes);
  }
  if (!posix.isAbsolute(input.scopePrefix)) {
    notes.push("scope_not_absolute");
    return fail("rejected", "complete", notes);
  }
  const manifestNormalized = posix.normalize(input.manifestPath);
  const scopeNormalized = posix.normalize(input.scopePrefix);
  if (!insideScope(manifestNormalized, scopeNormalized)) {
    notes.push("manifest_out_of_scope");
    return fail("rejected", "complete", notes);
  }
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
  const base = posix.dirname(manifestNormalized);
  const references: DeclaredReference[] = [];
  const rejected: string[] = [];
  declared.forEach((entry, ordinal) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      rejected.push(`entry_${ordinal}_not_string`);
      return;
    }
    const resolved = posix.resolve(base, entry);
    if (!insideScope(resolved, scopeNormalized)) {
      rejected.push(`entry_${ordinal}_out_of_scope`);
      return;
    }
    references.push(Object.freeze({ target: resolved, field: input.referencesField, ordinal, source: manifestNormalized }));
  });
  if (rejected.length > 0) {
    return Object.freeze({ status: "rejected" as const, coverage: "complete" as const, references: Object.freeze([]) as readonly DeclaredReference[], notes: Object.freeze([...notes, ...rejected]) });
  }
  if (references.length === 0) notes.push("declared_field_empty");
  return Object.freeze({ status: "ok" as const, coverage: "complete" as const, references: Object.freeze(references), notes: Object.freeze(notes) });
}