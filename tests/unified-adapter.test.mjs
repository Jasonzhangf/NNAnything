import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapTsJsSymbolTableToUnifiedFacts,
  TsJsUnifiedAdapterInputError,
} from "../dist/adapters/tsjs-unified-adapter.js";
import {
  mapRustSymbolTableToUnifiedFacts,
  RustUnifiedAdapterInputError,
  RUST_IMPORT_RESOLUTION_NOT_IMPLEMENTED,
} from "../dist/adapters/rust-unified-adapter.js";
import { relationFactsSemanticallyEqual } from "../dist/adapters/unified-relation-facts.js";

function span() {
  return { startLine: 1, startCol: 1, endLine: 1, endCol: 10 };
}

function coverage() {
  return {
    scopeFilesDiscovered: 1,
    scopeFilesParsed: 1,
    scopeFilesFailed: [],
    skipped: [],
    parseErrorFiles: [],
    partial: false,
    partialReasons: [],
    truncated: false,
    parserInvocations: 1,
    notes: [],
  };
}

function tsjsTable(overrides = {}) {
  return {
    schema: "nnanything.cli-symbols.result.v1",
    language: "typescript",
    repo: "/repo",
    scope: ["src"],
    parser: {
      backend: "typescript_compiler_ast",
      compilerVersion: "5.0.0",
      invocation: "ts.createSourceFile",
      semanticBinding: false,
    },
    symbols: [
      {
        symbolId: "s1",
        name: "helper",
        kind: "function",
        file: "src/helper",
        declSpan: span(),
        nameSpan: span(),
        nameSpanSource: "identifier",
        lexicalScope: ["top"],
        ownerType: null,
        ownerKind: null,
        modifiers: ["export"],
        visibility: "exported",
        moduleSystem: "esm",
        declaredIn: "file",
        parseStatus: "complete",
      },
    ],
    dynamicMemberBoundaries: [],
    coverage: coverage(),
    boundaries: {
      projectModulePath: "unknown",
      typeCheckerSemanticBinding: "not_resolved",
      dynamicComputedProperties: "not_resolved",
      commonjsDynamicRequire: "not_resolved",
      reExportTargetResolution: "not_resolved",
    },
    ...overrides,
  };
}

function rustTable(overrides = {}) {
  return {
    schema: "nnanything.cli-symbols.result.v1",
    language: "rust",
    repo: "/repo",
    scope: ["src"],
    parser: {
      backend: "rustc_ast_unpretty",
      toolchain: "stable",
      edition: "2021",
      editionSource: "default",
      invocation: "rustc -Zunpretty=ast-tree",
      semanticBinding: false,
    },
    symbols: [
      {
        symbolId: "s1",
        name: "helper",
        kind: "function",
        file: "src/helper",
        declSpan: span(),
        nameSpan: span(),
        nameSpanSource: "ident",
        lexicalScope: ["top"],
        projectModulePath: "unknown",
        ownerType: null,
        implTrait: null,
        visibility: "pub",
        cfgConditional: false,
        cfgAttributes: [],
        parseStatus: "complete",
      },
    ],
    macroBoundaries: [],
    coverage: coverage(),
    boundaries: {
      macroGeneratedDeclarations: "not_expanded",
      cfgConditionalDeclarations: "listed_with_cfgConditional_true",
      projectModulePath: "unknown",
      externalCrates: "not_resolved",
    },
    ...overrides,
  };
}

test("equivalent TS/JS and Rust relations map to one language-agnostic abstraction", () => {
  const tsjs = mapTsJsSymbolTableToUnifiedFacts("episode:1", tsjsTable());
  const rust = mapRustSymbolTableToUnifiedFacts("episode:1", rustTable());

  assert.equal(tsjs.languageAgnostic, true);
  assert.equal(rust.languageAgnostic, true);
  assert.equal(relationFactsSemanticallyEqual(tsjs, rust), true);
  assert.equal(tsjs.symbols[0].kind.value, "function");
  assert.equal(rust.symbols[0].kind.value, "function");
  assert.equal(tsjs.callSites[0].calleeName.value, "helper");
  assert.equal(rust.callSites[0].calleeName.value, "helper");
});

test("language names never appear in semantic fact values", () => {
  const tsjs = mapTsJsSymbolTableToUnifiedFacts("episode:1", tsjsTable());
  const rust = mapRustSymbolTableToUnifiedFacts("episode:1", rustTable());
  const values = [tsjs, rust].map(facts =>
    JSON.stringify({
      symbols: facts.symbols.map(symbol => ({
        name: symbol.name.value,
        kind: symbol.kind.value,
        declaredIn: symbol.declaredIn.value,
      })),
      calls: facts.callSites.map(site => site.calleeName.value),
    }),
  );
  for (const value of values) {
    assert.equal(value.includes("typescript"), false);
    assert.equal(value.includes("rust"), false);
  }
});

test("missing and unsupported observations stay explicit", () => {
  const tsjs = mapTsJsSymbolTableToUnifiedFacts(
    "episode:1",
    tsjsTable({
      coverage: {
        ...coverage(),
        partial: true,
        partialReasons: ["parse_error"],
        truncated: true,
      },
    }),
  );
  assert.ok(tsjs.missing.some(fact => fact.reason === "candidate_truncated"));
  assert.ok(tsjs.conflicts.some(conflict => conflict.includes("partial")));

  const rust = mapRustSymbolTableToUnifiedFacts("episode:1", rustTable());
  assert.ok(
    rust.missing.some(fact => fact.fieldRef === "importResolution"),
  );
  assert.ok(
    rust.unsupported.some(fact => fact.patternRef.includes("import-resolution")),
  );
  assert.equal(RUST_IMPORT_RESOLUTION_NOT_IMPLEMENTED, "RUST_IMPORT_RESOLUTION_NOT_IMPLEMENTED");
});

test("wrong parser backend is rejected", () => {
  assert.throws(
    () =>
      mapTsJsSymbolTableToUnifiedFacts(
        "episode:1",
        tsjsTable({ parser: { ...tsjsTable().parser, backend: "other" } }),
      ),
    TsJsUnifiedAdapterInputError,
  );
  assert.throws(
    () =>
      mapRustSymbolTableToUnifiedFacts(
        "episode:1",
        rustTable({ parser: { ...rustTable().parser, backend: "other" } }),
      ),
    RustUnifiedAdapterInputError,
  );
});
