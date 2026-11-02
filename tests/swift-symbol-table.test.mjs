import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSwiftSymbolTableAdapter,
  runSwiftSymbolTable,
} from "../dist/adapters/cli/swift-symbol-table-adapter.js";
import {
  filterSwiftSymbols,
  projectSwiftSymbolTableResult,
  symbolIdFor,
  validateSwiftSymbolRequest,
} from "../dist/filters/swift-symbol-table-policy.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "swift-symbols");
const REAL_REPO = "/Volumes/extension/code/rea";
const SWIFTC = process.env.NN_CODE_SWIFTC_BIN ?? "/usr/bin/swiftc";

function hasSwiftc() {
  return existsSync(SWIFTC);
}

function fixtureRequest(files, extra = {}) {
  return {
    repo: FIXTURES,
    language: "swift",
    scope: ["."],
    files,
    ...extra,
  };
}

function requireSwiftc(t) {
  if (hasSwiftc()) return true;
  t.skip(`swiftc unavailable at ${SWIFTC}`);
  return false;
}

function symbol(outcome, name) {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return null;
  return outcome.result.symbols.find(entry => entry.name === name) ?? null;
}

test("policy: validates request and exact short/full-name filtering", () => {
  const missing = validateSwiftSymbolRequest({});
  assert.equal(missing.ok, false);

  const wrongLanguage = validateSwiftSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["."],
    files: ["all-kinds.swift"],
  });
  assert.equal(wrongLanguage.ok, false);
  assert.equal(wrongLanguage.ok === false && wrongLanguage.error.reasonCode, "unsupported_language");

  const escaped = validateSwiftSymbolRequest({
    repo: FIXTURES,
    language: "swift",
    scope: ["../outside"],
    files: ["all-kinds.swift"],
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.ok === false && escaped.error.reasonCode, "scope_escape");

  const good = validateSwiftSymbolRequest(fixtureRequest(["all-kinds.swift"], { symbol: "overload" }));
  assert.equal(good.ok, true);

  const span = Object.freeze({ startLine: 1, startCol: 1, endLine: 1, endCol: 10 });
  const one = Object.freeze({
    symbolId: symbolIdFor("all-kinds.swift", "overload(_:)", span),
    name: "overload",
    fullName: "overload(_:)",
    kind: "function",
    file: "all-kinds.swift",
    declSpan: span,
    nameSpan: span,
    nameSpanSource: "header_scanner",
    lexicalScope: ["file"],
    ownerType: null,
    ownerKind: null,
    modifiers: [],
    visibility: "public",
    declaredIn: "file",
    parseStatus: "complete",
  });
  const two = Object.freeze({
    ...one,
    symbolId: symbolIdFor("all-kinds.swift", "overload(value:)", { ...span, startLine: 2 }),
    fullName: "overload(value:)",
    declSpan: { ...span, startLine: 2 },
  });
  assert.equal(filterSwiftSymbols([one, two], "overload", null).length, 2);
  assert.deepEqual(filterSwiftSymbols([one, two], "overload(value:)", null).map(item => item.fullName), [
    "overload(value:)",
  ]);

  const projected = projectSwiftSymbolTableResult(
    {
      repo: FIXTURES,
      language: "swift",
      scope: ["."],
      files: ["all-kinds.swift"],
      symbol: "overload",
      file: "all-kinds.swift",
    },
    {
      backend: "swiftc_dump_parse",
      compilerVersion: "test",
      invocation: "swiftc -dump-parse <file>",
      semanticBinding: false,
    },
    [one, two],
    {
      scopeFilesDiscovered: 1,
      scopeFilesParsed: 1,
      scopeFilesFailed: [],
      skipped: [],
      syntaxErrorFiles: [],
      partial: false,
      partialReasons: [],
      truncated: false,
      parserInvocations: 1,
      notes: [],
    },
  );
  assert.equal(projected.symbols.length, 2);
  assert.equal(projected.schema, "nnanything.cli-symbols.result.v1");
});

test("real swift: declarations, ownership, overloads, modifiers, and non-BMP columns", async t => {
  if (!requireSwiftc(t)) return;
  const outcome = await runSwiftSymbolTable(fixtureRequest(["all-kinds.swift"]), { swiftcBin: SWIFTC });
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return;
  const symbols = outcome.result.symbols;
  const names = new Set(symbols.map(entry => entry.name));

  for (const expected of [
    "_InternalBox",
    "_cache",
    "a",
    "b",
    "x",
    "y",
    "_helper",
    "default",
    "計算",
    "==",
    "MyFinalClass",
    "sharedCount",
    "makeInstance",
    "afterInlineEmoji",
    "Counter",
    "Greetable",
    "Result",
    "success",
    "failure",
    "plain",
    "Other",
    "Callback",
    "overload",
    "topLevel",
    "_topHidden",
    "AppMain",
    "main",
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }

  assert.equal(symbol(outcome, "_InternalBox")?.kind, "struct");
  assert.equal(symbol(outcome, "MyFinalClass")?.kind, "class");
  assert.equal(symbol(outcome, "Counter")?.kind, "actor");
  assert.equal(symbol(outcome, "Greetable")?.kind, "protocol");
  assert.equal(symbol(outcome, "Callback")?.kind, "typealias");

  const makeInstance = symbol(outcome, "makeInstance");
  assert.equal(makeInstance?.kind, "method");
  assert.ok(makeInstance?.modifiers.includes("static"));
  assert.ok(makeInstance?.modifiers.includes("class"));
  assert.equal(makeInstance?.nameSpanSource, "header_scanner");
  assert.ok((makeInstance?.nameSpan?.startCol ?? 0) > (makeInstance?.declSpan.startCol ?? 0));

  const cls = symbol(outcome, "MyFinalClass");
  assert.equal(cls?.nameSpan?.startCol, 20);

  const emojiMethod = symbol(outcome, "afterInlineEmoji");
  assert.deepEqual(emojiMethod?.nameSpan, {
    startLine: 14,
    startCol: 23,
    endLine: 14,
    endCol: 39,
  });

  for (const [name, kind, source] of [
    ["init", "initializer", "keyword"],
    ["deinit", "deinitializer", "keyword"],
    ["subscript", "subscript", "keyword"],
  ]) {
    const entry = symbol(outcome, name);
    assert.equal(entry?.kind, kind);
    assert.equal(entry?.nameSpanSource, source);
    assert.ok(entry?.nameSpan);
  }

  const success = symbols.filter(entry => entry.name === "success");
  assert.equal(success.length, 1);
  assert.equal(success[0]?.kind, "enum_case");
  assert.equal(success[0]?.ownerType, "Result");

  const plain = symbols.filter(entry => entry.name === "plain").sort((left, right) => left.ownerType.localeCompare(right.ownerType));
  assert.deepEqual(plain.map(entry => entry.ownerType), ["Other", "Result"]);

  const protocolGreet = symbols.find(entry => entry.name === "greet" && entry.ownerKind === "protocol");
  assert.equal(protocolGreet?.kind, "method");
  assert.equal(protocolGreet?.ownerType, "Greetable");
  assert.equal(protocolGreet?.declaredIn, "protocol_body");
  const extensionGreet = symbols.find(entry => entry.name === "greet" && entry.ownerKind === "extension");
  assert.equal(extensionGreet?.kind, "method");
  assert.equal(extensionGreet?.ownerType, "Greetable");
  assert.equal(extensionGreet?.declaredIn, "extension_body");

  const app = symbol(outcome, "AppMain");
  assert.ok(app?.modifiers.includes("main"));
  const appMain = symbols.find(entry => entry.name === "main" && entry.ownerType === "AppMain");
  assert.ok(appMain?.modifiers.includes("static"));

  const byShort = await runSwiftSymbolTable(fixtureRequest(["all-kinds.swift"], { symbol: "overload" }), { swiftcBin: SWIFTC });
  assert.equal(byShort.status, "ok");
  if (byShort.status === "ok") {
    assert.equal(byShort.result.symbols.filter(entry => entry.name === "overload").length, 2);
  }
  const byFull = await runSwiftSymbolTable(
    fixtureRequest(["all-kinds.swift"], { symbol: "overload(value:)" }),
    { swiftcBin: SWIFTC },
  );
  assert.equal(byFull.status, "ok");
  if (byFull.status === "ok") {
    assert.deepEqual(byFull.result.symbols.map(entry => entry.fullName), ["overload(value:)"]);
  }
  assert.equal(outcome.result.coverage.partial, false);
  assert.equal(outcome.result.coverage.truncated, false);
});

test("real swift: syntax failure preserves recovered declarations and marks partial", async t => {
  if (!requireSwiftc(t)) return;
  const outcome = await runSwiftSymbolTable(fixtureRequest(["broken.swift"]), { swiftcBin: SWIFTC });
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return;
  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 1);
  assert.equal(outcome.result.coverage.syntaxErrorFiles.length, 1);

  const valid = symbol(outcome, "ValidBefore");
  assert.equal(valid?.parseStatus, "partial_syntax_error");
  const id = symbol(outcome, "id");
  assert.equal(id?.parseStatus, "partial_syntax_error");
  const broken = symbol(outcome, "broken");
  assert.equal(broken?.parseStatus, "partial_syntax_error");
});

test("real swift: repository process declarations remain independently recoverable", async t => {
  if (!requireSwiftc(t) || !existsSync(REAL_REPO)) {
    if (!existsSync(REAL_REPO)) t.skip(`real Swift repository unavailable at ${REAL_REPO}`);
    return;
  }
  const outcome = await runSwiftSymbolTable({
    repo: REAL_REPO,
    language: "swift",
    scope: ["bridge/process"],
    files: [
      "bridge/process/ProcessRunTokenReader.swift",
      "bridge/process/ProcessRunTokenReaderMain.swift",
    ],
  }, { swiftcBin: SWIFTC });
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return;
  const symbols = outcome.result.symbols;
  assert.ok(symbols.some(entry => entry.name === "RunTokenObservation"));
  assert.ok(symbols.some(entry => entry.name === "ProcessMetadata" && entry.visibility === "private"));
  assert.ok(symbols.some(entry => entry.name === "metadata" && entry.visibility === "fileprivate"));
  assert.ok(symbols.some(entry => entry.name === "ProcessTableSysctlCall" && entry.kind === "typealias"));
  assert.ok(symbols.some(entry => entry.name === "ProcessRunTokenReaderMain"));
  assert.ok(symbols.some(entry => entry.name === "main" && entry.kind === "method"));
  const snapshots = symbols.filter(entry => entry.name === "readProcessSnapshot");
  assert.equal(snapshots.length, 2);
  const reader = symbols.filter(entry => entry.name === "RunTokenReadError");
  assert.equal(reader.length, 1);
});

test("synthetic swiftc: invalid positions are unknown, never clamped", async t => {
  const root = mkdtempSync(join(tmpdir(), "swift-symbol-invalid-span-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "Broken.swift");
  const compiler = join(root, "fake-swiftc.mjs");
  writeFileSync(source, "public struct Broken {}\n");
  writeFileSync(compiler, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("Apple Swift version test\\n");
  process.exit(0);
}
const file = args[args.length - 1];
process.stdout.write("(source_file \\"" + file + "\\"\\n");
process.stdout.write("  (struct_decl decl_context=0x1 range=[" + file + ":1:15 - line:2:999] \\"Broken\\"\\n");
process.stdout.write("    (brace_stmt range=[" + file + ":1:23 - line:1:24])))\\n");
`);
  chmodSync(compiler, 0o755);

  const outcome = await runSwiftSymbolTable(fixtureRequest([], {
    repo: root,
    files: ["Broken.swift"],
  }), { swiftcBin: compiler });
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return;
  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.symbols.length, 1);
  assert.deepEqual(outcome.result.symbols[0].declSpan, {
    startLine: 0,
    startCol: 0,
    endLine: 0,
    endCol: 0,
  });
  assert.equal(outcome.result.symbols[0].nameSpan, null);
  assert.equal(outcome.result.symbols[0].nameSpanSource, "unknown");
  assert.equal(outcome.result.symbols[0].parseStatus, "partial_syntax_error");
});

test("adapter factory and unavailable compiler rejection", async () => {
  const adapter = createSwiftSymbolTableAdapter({ swiftcBin: "/definitely/missing/swiftc" });
  const outcome = await adapter.symbols(fixtureRequest(["all-kinds.swift"]));
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.status === "rejected" && outcome.reasonCode, "SWIFTC_UNAVAILABLE");
});

