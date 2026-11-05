// Language-agnostic relation facts shared by the TS/JS and Rust unified
// adapters. Language identity is never carried into these facts, so it cannot
// become an answer shortcut in x[64]. Missing and unsupported observations are
// kept explicit; they are never filled with false or zero.

import type { EvidenceRef, MissingReason } from "../training/unified-encoder.js";

export type RelationFactKind =
  | "import"
  | "export"
  | "local"
  | "alias"
  | "call_site"
  | "scope"
  | "shadow";

export interface UnifiedObserved<T> {
  readonly state: "known" | "missing" | "conflicting";
  readonly value?: T;
  readonly reason?: MissingReason;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface UnifiedSymbolFact {
  readonly factKind: RelationFactKind;
  readonly symbolRef: string;
  readonly name: UnifiedObserved<string>;
  readonly kind: UnifiedObserved<string>;
  readonly declaredIn: UnifiedObserved<string>;
  readonly moduleRef: UnifiedObserved<string>;
  readonly lexicalScope: readonly UnifiedObserved<string>[];
  readonly visibility: UnifiedObserved<string>;
}

export interface UnifiedImportFact {
  readonly factKind: "import" | "alias";
  readonly edgeRef: string;
  readonly sourceName: UnifiedObserved<string>;
  readonly sourceModule: UnifiedObserved<string>;
  readonly targetName: UnifiedObserved<string>;
  readonly targetModule: UnifiedObserved<string>;
  readonly moduleSpecifierRaw: UnifiedObserved<string>;
  readonly localAlias: UnifiedObserved<string>;
  readonly hopDepth: UnifiedObserved<number>;
  readonly visibility: UnifiedObserved<string>;
}

export interface UnifiedCallSiteFact {
  readonly factKind: "call_site";
  readonly callSiteRef: string;
  readonly calleeName: UnifiedObserved<string>;
  readonly lexicalScope: UnifiedObserved<string>;
  readonly observationStrength: UnifiedObserved<"complete" | "partial" | "none">;
}

export interface UnifiedMissingFact {
  readonly targetRef: string;
  readonly fieldRef: string;
  readonly reason: MissingReason;
}

export interface UnifiedUnsupportedPattern {
  readonly patternRef: string;
  readonly reason: MissingReason;
}

export interface UnifiedRelationFacts {
  readonly schema: "nnanything.unified.relation-facts.v1";
  readonly episodeRef: string;
  readonly languageAgnostic: true;
  readonly symbols: readonly UnifiedSymbolFact[];
  readonly imports: readonly UnifiedImportFact[];
  readonly callSites: readonly UnifiedCallSiteFact[];
  readonly missing: readonly UnifiedMissingFact[];
  readonly unsupported: readonly UnifiedUnsupportedPattern[];
  readonly conflicts: readonly string[];
}

function semanticProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticProjection);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (
      key === "symbolRef" ||
      key === "edgeRef" ||
      key === "callSiteRef" ||
      key === "evidenceRefs" ||
      key === "targetRef" ||
      key === "patternRef"
    ) {
      continue;
    }
    result[key] = semanticProjection((value as Record<string, unknown>)[key]);
  }
  return result;
}

function stableString(value: unknown): string {
  return JSON.stringify(semanticProjection(value));
}

/**
 * Semantic equality for two relation-fact projections. This intentionally
 * ignores the episodeRef and verifies that two language adapters produce the
 * same abstract relation when the source relation is equivalent. Language
 * specific capability gaps (missing/unsupported) are compared separately and
 * must stay explicit in each adapter result.
 */
export function relationFactsSemanticallyEqual(
  left: UnifiedRelationFacts,
  right: UnifiedRelationFacts,
): boolean {
  if (left.schema !== right.schema) return false;
  if (left.languageAgnostic !== true || right.languageAgnostic !== true) return false;
  if (left.symbols.length !== right.symbols.length) return false;
  if (left.imports.length !== right.imports.length) return false;
  if (left.callSites.length !== right.callSites.length) return false;

  const leftSymbols = [...left.symbols].sort((a, b) => a.symbolRef.localeCompare(b.symbolRef));
  const rightSymbols = [...right.symbols].sort((a, b) => a.symbolRef.localeCompare(b.symbolRef));
  for (let index = 0; index < leftSymbols.length; index += 1) {
    if (stableString(leftSymbols[index]) !== stableString(rightSymbols[index])) return false;
  }

  const leftImports = [...left.imports].sort((a, b) => a.edgeRef.localeCompare(b.edgeRef));
  const rightImports = [...right.imports].sort((a, b) => a.edgeRef.localeCompare(b.edgeRef));
  for (let index = 0; index < leftImports.length; index += 1) {
    if (stableString(leftImports[index]) !== stableString(rightImports[index])) return false;
  }

  const leftCalls = [...left.callSites].sort((a, b) => a.callSiteRef.localeCompare(b.callSiteRef));
  const rightCalls = [...right.callSites].sort((a, b) => a.callSiteRef.localeCompare(b.callSiteRef));
  for (let index = 0; index < leftCalls.length; index += 1) {
    if (stableString(leftCalls[index]) !== stableString(rightCalls[index])) return false;
  }

  return true;
}

export function freeUnifiedRelationFacts(value: object): Readonly<object> {
  return Object.freeze(value);
}
