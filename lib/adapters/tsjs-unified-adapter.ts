// TS/JS relation-fact adapter for the unified 64-slot decision line.
//
// Consumes an existing `TsJsSymbolTableResult` (TypeScript compiler AST with
// semantic binding off) and projects only local syntax, imports, exports,
// lexical scope, aliases, call sites and observation strength. It must not
// produce teacher chains, final declarations, or `callEdge` truth.

import type {
  TsJsDynamicMemberBoundary,
  TsJsSymbolTableResult,
} from "../filters/tsjs-symbol-table-policy.js";
import {
  freeUnifiedRelationFacts,
  type UnifiedCallSiteFact,
  type UnifiedImportFact,
  type UnifiedObserved,
  type UnifiedRelationFacts,
  type UnifiedSymbolFact,
} from "./unified-relation-facts.js";

export const TSJS_UNIFIED_ADAPTER_SCHEMA = "nnanything.unified.relation-facts.v1";

export class TsJsUnifiedAdapterInputError extends Error {
  readonly code = "TSJS_UNIFIED_ADAPTER_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "TsJsUnifiedAdapterInputError";
  }
}

function known<T>(value: T, evidenceRefs: readonly string[]): UnifiedObserved<T> {
  return Object.freeze({ state: "known", value, evidenceRefs: Object.freeze([...evidenceRefs]) });
}

function missing<T>(
  reason: UnifiedObserved<T>["reason"],
  evidenceRefs: readonly string[],
): UnifiedObserved<T> {
  return Object.freeze({
    state: "missing",
    reason: reason ?? "contract_mismatch",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function symbolEvidenceRef(file: string, symbolId: string): string {
  return `tsjs:symbol:${file}:${symbolId}`;
}

function importEvidenceRef(file: string, edgeRef: string): string {
  return `tsjs:import:${file}:${edgeRef}`;
}

function normalizedVisibility(value: TsJsSymbolTableResult["symbols"][number]["visibility"]): string {
  return value === "exported" || value === "public" ? "public" : "private";
}

function symbolFact(
  file: string,
  symbol: TsJsSymbolTableResult["symbols"][number],
): UnifiedSymbolFact {
  const evidence = [symbolEvidenceRef(file, symbol.symbolId)];
  return {
    factKind: "local",
    symbolRef: `tsjs:symbol:${file}:${symbol.symbolId}`,
    name: known(symbol.name, evidence),
    kind: known(symbol.kind, evidence),
    declaredIn: known(symbol.declaredIn === "file" ? file : symbol.declaredIn, evidence),
    moduleRef: known(file, evidence),
    lexicalScope: symbol.lexicalScope.map(scope => known(scope, evidence)),
    visibility: known(normalizedVisibility(symbol.visibility), evidence),
  };
}

function importFact(
  file: string,
  boundary: TsJsDynamicMemberBoundary,
): UnifiedImportFact | null {
  if (boundary.boundaryKind !== "commonjs_computed_export") return null;
  const evidence = [importEvidenceRef(file, "cjs-computed")];
  return {
    factKind: "alias",
    edgeRef: `tsjs:alias:${file}:${boundary.declSpan.startLine}:${boundary.declSpan.startCol}`,
    sourceName: known(boundary.memberKind, evidence),
    sourceModule: known(file, evidence),
    targetName: missing("dynamic_undecidable", evidence),
    targetModule: missing("dynamic_undecidable", evidence),
    moduleSpecifierRaw: missing("dynamic_undecidable", evidence),
    localAlias: missing("dynamic_undecidable", evidence),
    hopDepth: known(1, evidence),
    visibility: known("reachable", evidence),
  };
}

function callSiteFact(
  file: string,
  symbol: TsJsSymbolTableResult["symbols"][number],
): UnifiedCallSiteFact | null {
  if (symbol.kind !== "function" && symbol.kind !== "method") return null;
  const evidence = [symbolEvidenceRef(file, symbol.symbolId)];
  return {
    factKind: "call_site",
    callSiteRef: `tsjs:call-site:${file}:${symbol.symbolId}`,
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

export function mapTsJsSymbolTableToUnifiedFacts(
  episodeRef: string,
  table: TsJsSymbolTableResult,
): UnifiedRelationFacts {
  if (table.symbols === undefined || table.coverage === undefined || table.parser === undefined) {
    throw new TsJsUnifiedAdapterInputError("tsjs symbol table must be a complete parser result");
  }
  if (table.parser.backend !== "typescript_compiler_ast") {
    throw new TsJsUnifiedAdapterInputError("tsjs symbol table backend is not the TypeScript AST");
  }
  if (table.language !== "typescript" && table.language !== "javascript") {
    throw new TsJsUnifiedAdapterInputError(`unexpected tsjs language ${table.language}`);
  }

  const missingFacts = [];
  for (const failed of table.coverage.scopeFilesFailed) {
    missingFacts.push({
      targetRef: `tsjs:file:${failed.file}`,
      fieldRef: "parse",
      reason: "observation_failed" as const,
    });
  }
  for (const skipped of table.coverage.skipped) {
    missingFacts.push({
      targetRef: `tsjs:file:${skipped.file}`,
      fieldRef: "parse",
      reason: "contract_mismatch" as const,
    });
  }
  if (table.coverage.truncated) {
    missingFacts.push({
      targetRef: `tsjs:coverage:${episodeRef}`,
      fieldRef: "coverage",
      reason: "candidate_truncated" as const,
    });
  }
  for (const errorFile of table.coverage.parseErrorFiles) {
    for (const error of errorFile.errors) {
      missingFacts.push({
        targetRef: `tsjs:parse:${errorFile.file}:${error.line}:${error.column}`,
        fieldRef: "syntax",
        reason: "unsupported_pattern" as const,
      });
    }
  }

  const conflicts = table.coverage.partial
    ? table.coverage.partialReasons.map(reason => `partial:${reason}`)
    : [];

  return freeUnifiedRelationFacts({
    schema: TSJS_UNIFIED_ADAPTER_SCHEMA,
    episodeRef,
    languageAgnostic: true,
    symbols: table.symbols.map(symbol => symbolFact(symbol.file, symbol)),
    imports: table.dynamicMemberBoundaries
      .map(boundary => importFact(boundary.file, boundary))
      .filter((fact): fact is UnifiedImportFact => fact !== null),
    callSites: table.symbols
      .map(symbol => callSiteFact(symbol.file, symbol))
      .filter((fact): fact is UnifiedCallSiteFact => fact !== null),
    missing: missingFacts,
    unsupported: table.dynamicMemberBoundaries
      .filter(boundary => boundary.boundaryKind !== "commonjs_computed_export")
      .map(boundary => ({
        patternRef: `tsjs:boundary:${boundary.file}:${boundary.declSpan.startLine}:${boundary.declSpan.startCol}`,
        reason: "unsupported_pattern" as const,
      })),
    conflicts,
  }) as UnifiedRelationFacts;
}
