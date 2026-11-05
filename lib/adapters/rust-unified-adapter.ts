// Rust relation-fact adapter for the unified 64-slot decision line.
//
// The current Rust symbol-table slice is syntax-only (`semanticBinding:false`)
// and does not resolve import edges or callsites. This adapter maps the facts
// that are actually observed and records the unimplemented import resolution
// explicitly instead of inventing a `callEdge` or filling false/zero.

import type {
  RustSymbolTableResult,
} from "../filters/rust-symbol-table-policy.js";
import {
  freeUnifiedRelationFacts,
  type UnifiedCallSiteFact,
  type UnifiedImportFact,
  type UnifiedObserved,
  type UnifiedRelationFacts,
  type UnifiedSymbolFact,
} from "./unified-relation-facts.js";

export const RUST_UNIFIED_ADAPTER_SCHEMA = "nnanything.unified.relation-facts.v1";
export const RUST_IMPORT_RESOLUTION_NOT_IMPLEMENTED =
  "RUST_IMPORT_RESOLUTION_NOT_IMPLEMENTED" as const;

export class RustUnifiedAdapterInputError extends Error {
  readonly code = "RUST_UNIFIED_ADAPTER_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "RustUnifiedAdapterInputError";
  }
}

function known<T>(value: T, evidenceRefs: readonly string[]): UnifiedObserved<T> {
  return Object.freeze({ state: "known", value, evidenceRefs: Object.freeze([...evidenceRefs]) });
}

function symbolEvidenceRef(file: string, symbolId: string): string {
  return `rust:symbol:${file}:${symbolId}`;
}

function normalizedVisibility(value: RustSymbolTableResult["symbols"][number]["visibility"]): string {
  return value === "private" ? "private" : "public";
}

function symbolFact(
  file: string,
  symbol: RustSymbolTableResult["symbols"][number],
): UnifiedSymbolFact {
  const evidence = [symbolEvidenceRef(file, symbol.symbolId)];
  return {
    factKind: "local",
    symbolRef: `rust:symbol:${file}:${symbol.symbolId}`,
    name: known(symbol.name, evidence),
    kind: known(symbol.kind, evidence),
    declaredIn: known(symbol.ownerType ?? symbol.file, evidence),
    moduleRef: known(file, evidence),
    lexicalScope: symbol.lexicalScope.map(scope => known(scope, evidence)),
    visibility: known(normalizedVisibility(symbol.visibility), evidence),
  };
}

function callSiteFact(
  file: string,
  symbol: RustSymbolTableResult["symbols"][number],
): UnifiedCallSiteFact | null {
  if (symbol.kind !== "function" && symbol.kind !== "method") return null;
  const evidence = [symbolEvidenceRef(file, symbol.symbolId)];
  return {
    factKind: "call_site",
    callSiteRef: `rust:call-site:${file}:${symbol.symbolId}`,
    calleeName: known(symbol.name, evidence),
    lexicalScope: known(
      symbol.lexicalScope[symbol.lexicalScope.length - 1] ?? "",
      evidence,
    ),
    observationStrength: known(
      symbol.parseStatus === "complete" ? "complete" : "partial",
      evidence,
    ),
  };
}

export function mapRustSymbolTableToUnifiedFacts(
  episodeRef: string,
  table: RustSymbolTableResult,
): UnifiedRelationFacts {
  if (table.symbols === undefined || table.coverage === undefined || table.parser === undefined) {
    throw new RustUnifiedAdapterInputError("rust symbol table must be a complete parser result");
  }
  if (table.parser.backend !== "rustc_ast_unpretty") {
    throw new RustUnifiedAdapterInputError("rust symbol table backend is not rustc AST");
  }
  if (table.language !== "rust") {
    throw new RustUnifiedAdapterInputError(`unexpected rust language ${table.language}`);
  }

  const missing = [];
  for (const failed of table.coverage.scopeFilesFailed) {
    missing.push({
      targetRef: `rust:file:${failed.file}`,
      fieldRef: "parse",
      reason: "observation_failed" as const,
    });
  }
  for (const skipped of table.coverage.skipped) {
    missing.push({
      targetRef: `rust:file:${skipped.file}`,
      fieldRef: "parse",
      reason: "contract_mismatch" as const,
    });
  }
  if (table.coverage.truncated) {
    missing.push({
      targetRef: `rust:coverage:${episodeRef}`,
      fieldRef: "coverage",
      reason: "candidate_truncated" as const,
    });
  }
  missing.push({
    targetRef: `rust:imports:${episodeRef}`,
    fieldRef: "importResolution",
    reason: "unsupported_pattern" as const,
  });

  const unsupported = table.macroBoundaries.map(boundary => ({
    patternRef: `rust:macro-boundary:${boundary.file}:${boundary.declSpan.startLine}:${boundary.declSpan.startCol}`,
    reason: "unsupported_pattern" as const,
  }));
  unsupported.push({
    patternRef: `rust:import-resolution:${episodeRef}`,
    reason: "unsupported_pattern" as const,
  });

  const conflicts = table.coverage.partial
    ? table.coverage.partialReasons.map(reason => `partial:${reason}`)
    : [];

  const imports: readonly UnifiedImportFact[] = [];

  return freeUnifiedRelationFacts({
    schema: RUST_UNIFIED_ADAPTER_SCHEMA,
    episodeRef,
    languageAgnostic: true,
    symbols: table.symbols.map(symbol => symbolFact(symbol.file, symbol)),
    imports,
    callSites: table.symbols
      .map(symbol => callSiteFact(symbol.file, symbol))
      .filter((fact): fact is UnifiedCallSiteFact => fact !== null),
    missing,
    unsupported,
    conflicts,
  }) as UnifiedRelationFacts;
}
