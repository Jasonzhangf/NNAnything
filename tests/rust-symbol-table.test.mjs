import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRustSymbolTableAdapter,
  runRustSymbolTable,
} from "../dist/adapters/cli/rust-symbol-table-adapter.js";
import {
  filterRustSymbols,
  projectRustSymbolTableResult,
  symbolIdFor,
  validateRustSymbolRequest,
} from "../dist/filters/rust-symbol-table-policy.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rust-symbols");

function runOne(files, extra = {}) {
  return runRustSymbolTable({
    repo: FIXTURES,
    language: "rust",
    scope: ["src"],
    files,
    ...extra,
  });
}

function byName(symbols) {
  return symbols.filter(entry => entry.name !== undefined);
}

test("policy: validates request shape and rejects invalid inputs", () => {
  const missing = validateRustSymbolRequest({});
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.status, "rejected");

  const typo = validateRustSymbolRequest({
    repo: FIXTURES,
    language: "go",
    scope: ["src"],
    files: ["src/kinds.rs"],
  });
  assert.equal(typo.ok, false);
  assert.equal(typo.ok === false && typo.error.reasonCode, "unsupported_language");

  const escape = validateRustSymbolRequest({
    repo: FIXTURES,
    language: "rust",
    scope: ["../outside"],
    files: ["src/kinds.rs"],
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.ok === false && escape.error.reasonCode, "scope_escape");

  const badEdition = validateRustSymbolRequest({
    repo: FIXTURES,
    language: "rust",
    scope: ["src"],
    files: ["src/kinds.rs"],
    edition: "2027",
  });
  assert.equal(badEdition.ok, false);
  assert.equal(badEdition.ok === false && badEdition.error.reasonCode, "invalid_edition");

  const good = validateRustSymbolRequest({
    repo: FIXTURES,
    language: "rust",
    scope: ["src", "src"],
    files: ["src/kinds.rs"],
    edition: "2024",
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.request.edition, "2024");
    assert.equal(good.request.editionSource, "request");
    assert.deepEqual([...good.request.scope], ["src", "src"]);
  }
});

test("policy: exact symbol and file filtering plus projection", () => {
  const request = {
    repo: FIXTURES,
    language: "rust" ,
    scope: ["src"],
    files: ["src/kinds.rs"],
    symbol: "draw",
    file: "src/kinds.rs",
    edition: "2021",
    editionSource: "default",
  };
  const sym = Object.freeze({
    symbolId: symbolIdFor("src/kinds.rs", "draw", { startLine: 20, startCol: 5, endLine: 20, endCol: 22 }),
    name: "draw",
    kind: "method",
    file: "src/kinds.rs",
    declSpan: { startLine: 20, startCol: 5, endLine: 20, endCol: 22 },
    nameSpan: null,
    nameSpanSource: "null_reason: ast_dump_ident_has_no_span",
    lexicalScope: ["crate", "impl:Canvas"],
    projectModulePath: "unknown",
    ownerType: "Canvas",
    implTrait: null,
    visibility: "pub",
    cfgConditional: false,
    cfgAttributes: [],
    parseStatus: "complete",
  });
  const other = Object.freeze({
    ...sym,
    symbolId: symbolIdFor("src/kinds.rs", "other", { startLine: 1, startCol: 1, endLine: 1, endCol: 10 }),
    name: "other",
    declSpan: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
  });
  const filtered = filterRustSymbols([sym, other], "draw", "src/kinds.rs");
  assert.deepEqual(filtered.map(entry => entry.name), ["draw"]);
  const projected = projectRustSymbolTableResult(
    request,
    {
      backend: "rustc_ast_unpretty",
      toolchain: "stable-test",
      edition: "2021",
      editionSource: "default",
      invocation: "RUSTC_BOOTSTRAP=1 rustc -Z unpretty=ast-tree --edition=2021 <file>",
      semanticBinding: false,
    },
    [sym, other],
    [],
    {
      scopeFilesDiscovered: 1,
      scopeFilesParsed: 1,
      scopeFilesFailed: [],
      skipped: [],
      partial: false,
      partialReasons: [],
      truncated: false,
      parserInvocations: 1,
      notes: [],
    },
  );
  assert.equal(projected.schema, "nnanything.cli-symbols.result.v1");
  assert.deepEqual(projected.symbols.map(entry => entry.name), ["draw"]);
});

test("kinds.rs: unified kinds, ownerType, implTrait, modules", async () => {
  const out = await runOne(["src/kinds.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const names = out.result.symbols.map(entry => entry.name).sort();
  assert.deepEqual(names, [
    "Canvas",
    "Mode",
    "Renderer",
    "Widget",
    "area",
    "draw",
    "geometry",
    "render",
    "render",
  ]);

  const widget = out.result.symbols.find(entry => entry.name === "Widget");
  assert.equal(widget?.kind, "struct");
  const mode = out.result.symbols.find(entry => entry.name === "Mode");
  assert.equal(mode?.kind, "enum");
  const renderer = out.result.symbols.find(entry => entry.name === "Renderer");
  assert.equal(renderer?.kind, "trait");
  const geometry = out.result.symbols.find(entry => entry.name === "geometry");
  assert.equal(geometry?.kind, "module");

  const inherentDraw = out.result.symbols.filter(
    entry => entry.name === "draw" && entry.ownerType === "Canvas",
  );
  assert.equal(inherentDraw.length, 1);
  assert.equal(inherentDraw[0].kind, "method");
  assert.equal(inherentDraw[0].implTrait, null);
  assert.deepEqual([...inherentDraw[0].lexicalScope], ["crate", "impl:Canvas"]);

  const traitRender = out.result.symbols.filter(
    entry => entry.name === "render" && entry.implTrait === "Renderer",
  );
  assert.equal(traitRender.length, 2);
  const traitMember = traitRender.find(entry => entry.ownerType === null);
  const implMember = traitRender.find(entry => entry.ownerType === "Canvas");
  assert.ok(traitMember);
  assert.ok(implMember);
  assert.equal(traitMember.kind, "method");
  assert.equal(traitMember.implTrait, "Renderer");
  assert.equal(implMember.kind, "method");
  assert.equal(implMember.implTrait, "Renderer");
  assert.equal(implMember.ownerType, "Canvas");
  assert.deepEqual([...implMember.lexicalScope], ["crate", "impl:Renderer for Canvas"]);

  assert.equal(out.result.symbols.some(entry => entry.kind === "impl_method" || entry.kind === "trait_member"), false);
});

test("nested_modules.rs: same short name in different lexical scopes stays distinct", async () => {
  const out = await runOne(["src/nested_modules.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const handles = out.result.symbols.filter(entry => entry.name === "handle");
  assert.equal(handles.length, 3);
  const scopes = handles.map(entry => entry.lexicalScope.join("/")).sort();
  assert.deepEqual(scopes, ["crate", "crate/mod:outer", "crate/mod:outer/mod:inner"]);
  const ids = new Set(handles.map(entry => entry.symbolId));
  assert.equal(ids.size, 3);
});

test("block_local.rs: block-local declarations extracted with fn scope, same-name locals kept separate", async () => {
  const out = await runOne(["src/block_local.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const outer = out.result.symbols.find(entry => entry.name === "outer");
  assert.equal(outer?.kind, "function");
  assert.deepEqual([...outer.lexicalScope], ["crate"]);

  const inner = out.result.symbols.find(entry => entry.name === "inner");
  assert.equal(inner?.kind, "function");
  assert.deepEqual([...inner.lexicalScope], ["crate", "fn:outer"]);

  const localS = out.result.symbols.find(entry => entry.name === "LocalS");
  assert.equal(localS?.kind, "struct");
  assert.deepEqual([...localS.lexicalScope], ["crate", "fn:holder"]);

  const localM = out.result.symbols.find(entry => entry.name === "m");
  assert.equal(localM?.kind, "method");
  assert.equal(localM?.ownerType, "LocalS");
  assert.equal(localM?.implTrait, null);
  assert.deepEqual([...localM.lexicalScope], ["crate", "fn:holder", "impl:LocalS"]);

  const dups = out.result.symbols.filter(entry => entry.name === "dup");
  assert.equal(dups.length, 2);
  const dupScopes = dups.map(entry => entry.lexicalScope.join("/")).sort();
  assert.deepEqual(dupScopes, ["crate/fn:first", "crate/fn:second"]);
  const dupIds = new Set(dups.map(entry => entry.symbolId));
  assert.equal(dupIds.size, 2);
  assert.notEqual(dups[0].declSpan.startLine, dups[1].declSpan.startLine);

  assert.equal(out.result.coverage.partial, false);
});

test("nested_blocks.rs: declarations in bare and conditional blocks keep the enclosing fn scope", async () => {
  const out = await runOne(["src/nested_blocks.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  assert.deepEqual(
    out.result.symbols.map(entry => entry.name).sort(),
    ["conditional", "direct", "nested", "outer"],
  );
  for (const name of ["direct", "nested", "conditional"]) {
    const symbol = out.result.symbols.find(entry => entry.name === name);
    assert.equal(symbol?.kind, "function");
    assert.equal(symbol?.ownerType, null);
    assert.equal(symbol?.implTrait, null);
    assert.deepEqual([...symbol.lexicalScope], ["crate", "fn:outer"]);
  }
  const outer = out.result.symbols.find(entry => entry.name === "outer");
  assert.deepEqual([...outer.lexicalScope], ["crate"]);
  assert.equal(out.result.coverage.partial, false);
  assert.equal(out.result.coverage.truncated, false);
});

test("same_name_nested.rs: direct, bare-block, and if-branch same-name fns stay distinct", async () => {
  const out = await runOne(["src/same_name_nested.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  assert.equal(out.result.symbols.length, 4);
  assert.deepEqual(
    out.result.symbols.map(entry => entry.name).sort(),
    ["dup", "dup", "dup", "outer"],
  );

  const outer = out.result.symbols.find(entry => entry.name === "outer");
  assert.equal(outer?.kind, "function");
  assert.deepEqual([...outer.lexicalScope], ["crate"]);

  const dups = out.result.symbols.filter(entry => entry.name === "dup");
  assert.equal(dups.length, 3);
  for (const dup of dups) {
    assert.equal(dup.kind, "function");
    assert.deepEqual([...dup.lexicalScope], ["crate", "fn:outer"]);
  }
  assert.equal(new Set(dups.map(entry => entry.symbolId)).size, 3);
  assert.equal(new Set(dups.map(entry => entry.declSpan.startLine)).size, 3);
  assert.equal(out.result.coverage.partial, false);
  assert.equal(out.result.coverage.truncated, false);
});

test("nested_branches.rs: every block-bearing branch and arbitrary nesting is traversed", async () => {
  const out = await runOne(["src/nested_branches.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const expected = [
    "BranchLocal",
    "branch_method",
    "branches",
    "deep_branch",
    "for_branch",
    "if_branch",
    "if_else",
    "loop_branch",
    "match_branch",
    "repeated",
    "repeated",
    "while_branch",
  ].sort();
  assert.deepEqual(out.result.symbols.map(entry => entry.name).sort(), expected);

  for (const name of [
    "if_branch",
    "if_else",
    "loop_branch",
    "while_branch",
    "for_branch",
    "match_branch",
    "deep_branch",
  ]) {
    const symbol = out.result.symbols.find(entry => entry.name === name);
    assert.equal(symbol?.kind, "function");
    assert.deepEqual([...symbol.lexicalScope], ["crate", "fn:branches"]);
  }

  const repeated = out.result.symbols.filter(entry => entry.name === "repeated");
  assert.equal(repeated.length, 2);
  assert.equal(new Set(repeated.map(entry => entry.symbolId)).size, 2);
  assert.notEqual(repeated[0].declSpan.startLine, repeated[1].declSpan.startLine);
  assert.equal(out.result.symbols.find(entry => entry.name === "BranchLocal")?.kind, "struct");

  const method = out.result.symbols.find(entry => entry.name === "branch_method");
  assert.equal(method?.kind, "method");
  assert.equal(method?.ownerType, "BranchLocal");
  assert.equal(method?.implTrait, null);
  assert.deepEqual(
    [...method.lexicalScope],
    ["crate", "fn:branches", "impl:BranchLocal"],
  );
  assert.equal(out.result.coverage.partial, false);
});

test("symlink boundary: every symlink path component is skipped without following", async () => {
  const base = mkdtempSync(join(tmpdir(), "rust-symbol-link-"));
  const repo = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(join(repo, "real"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    writeFileSync(join(repo, "real", "normal.rs"), "pub fn normal_symbol() {}\n");
    writeFileSync(join(outside, "external.rs"), "pub fn outside_repo() {}\n");
    symlinkSync("real", join(repo, "link_in"));
    symlinkSync("../outside", join(repo, "link_out"));
    symlinkSync("real/normal.rs", join(repo, "file_link.rs"));

    const out = await runRustSymbolTable({
      repo,
      language: "rust",
      scope: ["real"],
      files: [
        "real/normal.rs",
        "link_in/normal.rs",
        "link_out/external.rs",
        "file_link.rs",
      ],
    });
    assert.equal(out.status, "ok");
    if (out.status !== "ok") return;

    const skipped = Object.fromEntries(out.result.coverage.skipped.map(entry => [entry.file, entry.reason]));
    assert.deepEqual(skipped, {
      "link_in/normal.rs": "SYMLINK_PATH_COMPONENT",
      "link_out/external.rs": "SYMLINK_PATH_COMPONENT",
      "file_link.rs": "SYMLINK_PATH_COMPONENT",
    });

    assert.equal(out.result.symbols.some(entry => entry.name === "outside_repo"), false);
    assert.equal(out.result.symbols.some(entry => entry.file === "file_link.rs"), false);

    const normalFiles = out.result.symbols
      .filter(entry => entry.name === "normal_symbol")
      .map(entry => entry.file)
      .sort();
    assert.deepEqual(normalFiles, ["real/normal.rs"]);

    assert.equal(out.result.coverage.partial, true);
    assert.deepEqual([...out.result.coverage.partialReasons], [
      "link_in/normal.rs: SYMLINK_PATH_COMPONENT",
      "link_out/external.rs: SYMLINK_PATH_COMPONENT",
      "file_link.rs: SYMLINK_PATH_COMPONENT",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cfg.rs: cfgConditional true and cfgAttributes preserved, non-cfg unaffected", async () => {
  const out = await runOne(["src/cfg.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const seed = out.result.symbols.find(entry => entry.name === "seed");
  assert.equal(seed?.cfgConditional, true);
  assert.deepEqual([...seed.cfgAttributes], ["#[cfg(test)]"]);

  const optional = out.result.symbols.find(entry => entry.name === "OptionalThing");
  assert.equal(optional?.cfgConditional, true);
  assert.deepEqual(
    [...optional.cfgAttributes],
    ['#[cfg(feature = "extra")]', "#[cfg_attr(debug_assertions, allow(dead_code))]"],
  );

  const always = out.result.symbols.find(entry => entry.name === "always_here");
  assert.equal(always?.cfgConditional, false);
  assert.deepEqual([...always.cfgAttributes], []);
});

test("macros.rs: macro definition and unexpanded call go to macroBoundaries, never symbols", async () => {
  const out = await runOne(["src/macros.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  const symbolNames = out.result.symbols.map(entry => entry.name);
  assert.deepEqual(symbolNames, ["real_function"]);
  assert.equal(out.result.symbols.some(entry => entry.name === "GeneratedWidget"), false);

  const def = out.result.macroBoundaries.find(entry => entry.boundaryKind === "macro_rules_definition");
  assert.equal(def?.macroName, "declare_widget");
  const call = out.result.macroBoundaries.find(entry => entry.boundaryKind === "unexpanded_item_macro_call");
  assert.equal(call?.macroName, "declare_widget");
  assert.equal(call?.rawInvocationPreview, "declare_widget!(GeneratedWidget);");
});

test("partial: one broken file is recorded while another file still succeeds", async () => {
  const out = await runOne(["src/good_file.rs", "src/broken_partial.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;

  assert.equal(out.result.coverage.partial, true);
  assert.equal(out.result.coverage.scopeFilesParsed, 1);
  assert.equal(out.result.coverage.scopeFilesFailed.length, 1);
  assert.equal(out.result.coverage.scopeFilesFailed[0].file, "src/broken_partial.rs");
  assert.match(out.result.coverage.scopeFilesFailed[0].reason, /syntax_error/);
  assert.equal(out.result.symbols.some(entry => entry.name === "first_good"), true);
  assert.equal(out.result.symbols.some(entry => entry.name === "GoodStruct"), true);
});

test("loc: exact code-point spans, CRLF lines, raw identifier, comment non-symbol", async () => {
  const unicodeOut = await runOne(["loc/unicode.rs"], { scope: ["loc"] });
  assert.equal(unicodeOut.status, "ok");
  if (unicodeOut.status !== "ok") return;

  const unicodeFn = unicodeOut.result.symbols.find(entry => entry.name === "数据加载");
  assert.ok(unicodeFn);
  assert.deepEqual(unicodeFn.declSpan, { startLine: 1, startCol: 1, endLine: 1, endCol: 17 });
  const raw = unicodeOut.result.symbols.find(entry => entry.name === "r#match");
  assert.ok(raw);
  assert.equal(raw.name, "r#match");
  const targetDecls = unicodeOut.result.symbols.filter(entry => entry.name === "target");
  assert.equal(targetDecls.length, 1);
  assert.deepEqual(targetDecls[0].declSpan, { startLine: 8, startCol: 1, endLine: 8, endCol: 19 });

  const crlfOut = await runOne(["loc/crlf.rs"], { scope: ["loc"] });
  assert.equal(crlfOut.status, "ok");
  if (crlfOut.status !== "ok") return;

  const 数 = crlfOut.result.symbols.find(entry => entry.name === "数");
  assert.ok(数);
  assert.deepEqual(数.declSpan, { startLine: 1, startCol: 1, endLine: 1, endCol: 20 });
  const 据 = crlfOut.result.symbols.find(entry => entry.name === "据");
  assert.ok(据);
  assert.deepEqual(据.declSpan, { startLine: 2, startCol: 1, endLine: 2, endCol: 14 });
  const crlfTargets = crlfOut.result.symbols.filter(entry => entry.name === "target");
  assert.equal(crlfTargets.length, 1);
  assert.deepEqual(crlfTargets[0].declSpan, { startLine: 4, startCol: 1, endLine: 4, endCol: 19 });
});

test("nameSpan is null with a concrete source reason everywhere", async () => {
  const out = await runOne(["src/kinds.rs"]);
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  for (const symbol of out.result.symbols) {
    assert.equal(symbol.nameSpan, null);
    assert.equal(symbol.nameSpanSource, "null_reason: ast_dump_ident_has_no_span");
  }
});

test("symbol+file filters as exact intersection", async () => {
  const out = await runOne(["src/kinds.rs", "src/good_file.rs"], {
    symbol: "Widget",
    file: "src/kinds.rs",
  });
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  assert.deepEqual(out.result.symbols.map(entry => entry.name), ["Widget"]);
  assert.deepEqual(out.result.symbols.map(entry => entry.file), ["src/kinds.rs"]);

  const mismatch = await runOne(["src/kinds.rs"], { symbol: "Widget", file: "src/good_file.rs" });
  assert.equal(mismatch.status, "ok");
  if (mismatch.status === "ok") {
    assert.deepEqual(mismatch.result.symbols, []);
  }
});

test("adapter factory shares the same deterministic entry", async () => {
  const adapter = createRustSymbolTableAdapter({ toolchainLabel: "stable-test" });
  const out = await adapter.symbols({
    repo: FIXTURES,
    language: "rust",
    scope: ["src"],
    files: ["src/good_file.rs"],
  });
  assert.equal(out.status, "ok");
  if (out.status === "ok") {
    assert.equal(out.result.parser.toolchain, "stable-test");
    assert.deepEqual(byName(out.result.symbols).map(entry => entry.name), [
      "first_good",
      "GoodStruct",
    ]);
  }
});
