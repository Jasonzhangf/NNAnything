import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runKotlinSymbolTable,
  createKotlinSymbolTableAdapter,
} from "../dist/adapters/cli/kotlin-symbol-table-adapter.js";
import {
  filterKotlinSymbols,
  projectKotlinSymbolTableResult,
  validateKotlinSymbolRequest,
} from "../dist/filters/kotlin-symbol-table-policy.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kotlin-symbols");

function isKotlinSource(name) {
  return name.endsWith(".kt") || name.endsWith(".kts");
}

// Test-side stand-in for the public entry's discovery: the adapter itself does
// not traverse directories and only consumes this explicit regular-file list.
function enumerateKotlinFiles(scope) {
  const files = [];
  const seen = new Set();
  const walk = abs => {
    const stats = lstatSync(abs);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
      return;
    }
    if (stats.isFile() && isKotlinSource(abs)) {
      const rel = relative(FIXTURES, abs).split(sep).join("/");
      if (!seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
    }
  };
  for (const entry of scope) walk(resolve(FIXTURES, entry));
  files.sort();
  return files;
}

function request(scope, extra = {}) {
  return {
    repo: FIXTURES,
    language: "kotlin",
    scope,
    files: enumerateKotlinFiles(scope),
    ...extra,
  };
}

function symbols(outcome) {
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return [];
  return outcome.result.symbols;
}

test("policy: validates request shape and rejects invalid inputs", () => {
  const missing = validateKotlinSymbolRequest({});
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.status, "rejected");

  const typo = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: ["kinds"],
  });
  assert.equal(typo.ok, false);
  assert.equal(typo.ok === false && typo.error.reasonCode, "unsupported_language");

  const escape = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["../outside"],
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.ok === false && escape.error.reasonCode, "scope_escape");

  const badIgnore = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["kinds"],
    files: ["kinds/Kinds.kt"],
    ignorePolicy: "maybe",
  });
  assert.equal(badIgnore.ok, false);
  assert.equal(badIgnore.ok === false && badIgnore.error.reasonCode, "invalid_ignore_policy");

  const badFiles = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["kinds"],
    files: ["../outside.kt"],
  });
  assert.equal(badFiles.ok, false);
  assert.equal(badFiles.ok === false && badFiles.error.reasonCode, "file_escape");

  const badExtension = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["kinds"],
    files: ["kinds/Kinds.txt"],
  });
  assert.equal(badExtension.ok, false);
  assert.equal(badExtension.ok === false && badExtension.error.reasonCode, "invalid_file");

  const good = validateKotlinSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: [".", "kinds"],
    files: ["kinds/Kinds.kt"],
    symbol: "Payload",
    file: "kinds/Kinds.kt",
    ignorePolicy: "no_ignore",
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.request.symbol, "Payload");
    assert.equal(good.request.file, "kinds/Kinds.kt");
    assert.equal(good.request.ignorePolicy, "no_ignore");
    assert.deepEqual(good.request.files, ["kinds/Kinds.kt"]);
  }
});

test("policy: exact symbol/file filtering and result projection", () => {
  const span = Object.freeze({ startLine: 1, startCol: 1, endLine: 1, endCol: 3 });
  const one = Object.freeze({
    symbolId: "kinds/Kinds.kt#One@1-3",
    name: "One",
    kind: "class",
    file: "kinds/Kinds.kt",
    declSpan: span,
    nameSpan: span,
    nameSpanSource: "psi_name_identifier",
    lexicalScope: ["package:fixture.kinds"],
    ownerType: null,
    ownerKind: null,
    receiverType: null,
    modifiers: [],
    visibility: "public",
    declaredIn: "file",
    parseStatus: "complete",
  });
  const two = Object.freeze({
    ...one,
    symbolId: "kinds/Kinds.kt#Two@4-6",
    name: "Two",
  });
  const filtered = filterKotlinSymbols([one, two], "One", "kinds/Kinds.kt");
  assert.deepEqual(filtered.map(entry => entry.name), ["One"]);
  assert.deepEqual(filterKotlinSymbols([one, two], "one", null), []);

  const projected = projectKotlinSymbolTableResult(
    {
      repo: FIXTURES,
      language: "kotlin",
      scope: ["kinds"],
      symbol: "One",
      file: "kinds/Kinds.kt",
      ignorePolicy: "no_ignore",
    },
    {
      backend: "kotlin_psi_factory",
      compilerVersion: "2.2.0",
      invocation: "test",
      semanticBinding: false,
    },
    [one, two],
    {
      scopeFilesDiscovered: 1,
      scopeFilesParsed: 1,
      scopeFilesFailed: [],
      skipped: [],
      psiErrorFiles: [],
      partial: false,
      partialReasons: [],
      truncated: false,
      parserInvocations: 1,
      notes: [],
    },
  );
  assert.equal(projected.schema, "nnanything.cli-symbols.result.v1");
  assert.deepEqual(projected.symbols.map(entry => entry.name), ["One"]);
});

test("packages: same class/file name in different packages stays distinct", async () => {
  const outcome = await runKotlinSymbolTable(request(["packages"]));
  const all = symbols(outcome);
  const same = all.filter(entry => entry.name === "Same");
  assert.equal(same.length, 2);
  assert.deepEqual(new Set(same.map(entry => entry.file)), new Set([
    "packages/alpha/Same.kt",
    "packages/beta/Same.kt",
  ]));
  assert.deepEqual(new Set(same.map(entry => entry.symbolId)).size, 2);
  assert.deepEqual(new Set(same.map(entry => entry.lexicalScope.join("/"))), new Set([
    "package:fixture.packages.alpha",
    "package:fixture.packages.beta",
  ]));
});

test("kinds: class/object/companion/interface/data/enum/entry/typealias/extension", async () => {
  const outcome = await runKotlinSymbolTable(request(["kinds"]));
  const all = symbols(outcome);

  assert.equal(all.find(entry => entry.name === "Registry")?.kind, "object");
  assert.equal(all.find(entry => entry.name === "Api")?.kind, "interface");
  assert.equal(all.find(entry => entry.name === "Payload")?.kind, "data_class");
  assert.equal(all.find(entry => entry.name === "Mode")?.kind, "enum_class");
  assert.equal(all.find(entry => entry.name === "StringList")?.kind, "type_alias");

  const companion = all.find(entry => entry.name === "Companion");
  assert.equal(companion?.kind, "companion_object");
  assert.equal(companion?.ownerType, "Host");
  assert.equal(companion?.nameSpan, null);

  const companionValue = all.find(entry => entry.name === "companionValue");
  assert.equal(companionValue?.kind, "method");
  assert.equal(companionValue?.ownerType, "Companion");
  assert.equal(companionValue?.ownerKind, "companion_object");
  assert.deepEqual([...companionValue.lexicalScope], [
    "package:fixture.kinds",
    "class:Host",
    "companion_object:Companion",
  ]);

  const load = all.find(entry => entry.name === "load");
  assert.equal(load?.kind, "method");
  assert.equal(load?.ownerType, "Api");
  assert.equal(load?.ownerKind, "interface");
  assert.equal(load?.declaredIn, "interface_body");

  const payloadValue = all.find(entry => entry.name === "value" && entry.ownerType === "Payload");
  assert.equal(payloadValue?.kind, "property");
  assert.equal(payloadValue?.declaredIn, "primary_constructor");

  for (const entryName of ["FAST", "SLOW"]) {
    const entry = all.find(item => item.name === entryName);
    assert.equal(entry?.kind, "enum_entry");
    assert.equal(entry?.ownerType, "Mode");
    assert.equal(entry?.ownerKind, "enum_class");
  }

  const bang = all.find(entry => entry.name === "bang");
  assert.equal(bang?.kind, "extension_function");
  assert.equal(bang?.receiverType, "String");

  const size = all.find(entry => entry.name === "sizeOrZero");
  assert.equal(size?.kind, "property");
  assert.equal(size?.receiverType, "String");
});

test("scopes: member method vs local function with the same short name", async () => {
  const outcome = await runKotlinSymbolTable(request(["scopes"]));
  const all = symbols(outcome);

  const ownerMethods = all.filter(entry => entry.name === "same" && entry.kind === "method");
  assert.equal(ownerMethods.length, 2);
  assert.deepEqual(new Set(ownerMethods.map(entry => entry.ownerType)), new Set(["OwnerA", "OwnerB"]));

  const local = all.find(entry => entry.name === "same" && entry.kind === "function");
  assert.ok(local);
  assert.equal(local.ownerType, null);
  assert.equal(local.declaredIn, "local_scope");
  assert.deepEqual([...local.lexicalScope], [
    "package:fixture.scopes",
    "class:LocalHost",
    "function:outer",
  ]);

  const topLevel = all.find(entry => entry.name === "topLevel");
  assert.equal(topLevel?.kind, "function");
  assert.equal(topLevel?.ownerType, null);
  assert.equal(topLevel?.declaredIn, "file");
});

test("scopes: init/lambda/constructor locals keep local_scope and lexical evidence", async () => {
  const outcome = await runKotlinSymbolTable(request(["local-scopes"]));
  const all = symbols(outcome);

  const expectedLocals = [
    {
      name: "initLocal",
      lexicalScope: ["package:fixture.local_scopes", "class:C", "init"],
    },
    {
      name: "lambdaLocal",
      lexicalScope: ["package:fixture.local_scopes", "class:C", "lambda"],
    },
    {
      name: "constructorLocal",
      lexicalScope: ["package:fixture.local_scopes", "class:C", "constructor"],
    },
    {
      name: "inner",
      lexicalScope: ["package:fixture.local_scopes", "class:C", "function:outer"],
    },
  ];

  for (const expected of expectedLocals) {
    const entry = all.find(item => item.name === expected.name);
    assert.ok(entry, `${expected.name} must be present`);
    assert.equal(entry?.kind, "function");
    assert.equal(entry?.ownerType, null);
    assert.equal(entry?.ownerKind, null);
    assert.equal(entry?.declaredIn, "local_scope");
    assert.deepEqual([...entry.lexicalScope], expected.lexicalScope);
  }

  const outer = all.find(item => item.name === "outer");
  assert.equal(outer?.kind, "method");
  assert.equal(outer?.ownerType, "C");

  const localClass = all.find(item => item.name === "Inner");
  assert.equal(localClass?.kind, "class");
  assert.equal(localClass?.ownerType, null);
  assert.equal(localClass?.declaredIn, "local_scope");
  assert.deepEqual([...localClass.lexicalScope], [
    "package:fixture.local_scopes",
    "class:C",
    "function:owner",
  ]);

  const localMember = all.find(item => item.name === "localMember");
  assert.equal(localMember?.kind, "method");
  assert.equal(localMember?.ownerType, "Inner");
  assert.equal(localMember?.ownerKind, "class");
  assert.equal(localMember?.declaredIn, "class_body");
  assert.deepEqual([...localMember.lexicalScope], [
    "package:fixture.local_scopes",
    "class:C",
    "function:owner",
    "class:Inner",
  ]);
});

test("properties: constructor val/var and extension properties are covered", async () => {
  const outcome = await runKotlinSymbolTable(request(["properties"]));
  const all = symbols(outcome);

  const privateValue = all.find(entry => entry.name === "privateValue");
  assert.equal(privateValue?.kind, "property");
  assert.equal(privateValue?.declaredIn, "primary_constructor");
  assert.equal(privateValue?.ownerType, "ConstructorProperties");
  assert.equal(privateValue?.visibility, "private");

  const mutableValue = all.find(entry => entry.name === "mutableValue");
  assert.equal(mutableValue?.kind, "property");
  assert.equal(mutableValue?.declaredIn, "primary_constructor");
  assert.equal(mutableValue?.visibility, "public");

  const hidden = all.find(entry => entry.name === "hidden");
  assert.equal(hidden?.declaredIn, "class_body");
  assert.equal(hidden?.visibility, "private");

  const extension = all.find(entry => entry.name === "extensionLength");
  assert.equal(extension?.kind, "property");
  assert.equal(extension?.receiverType, "String");
  assert.equal(extension?.declaredIn, "file");
});

test("partial: one syntax-error file is recorded while another file still succeeds", async () => {
  const outcome = await runKotlinSymbolTable(request(["partial"]));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 2);
  assert.equal(outcome.result.coverage.scopeFilesFailed.length, 0);
  assert.equal(outcome.result.coverage.psiErrorFiles.length, 1);
  assert.equal(outcome.result.coverage.psiErrorFiles[0].file, "partial/Broken.kt");
  assert.equal(outcome.result.coverage.psiErrorFiles[0].errors.length, 2);

  assert.equal(outcome.result.symbols.some(entry => entry.name === "Good"), true);
  assert.equal(outcome.result.symbols.some(entry => entry.name === "ValidClass"), true);
  const broken = outcome.result.symbols.find(entry => entry.name === "ValidClass");
  assert.equal(broken?.parseStatus, "partial_syntax_error");
});

test("receiver: complex call expression remains declaration-only", async () => {
  const outcome = await runKotlinSymbolTable(request(["receiver"]));
  const all = symbols(outcome);
  const names = all.map(entry => entry.name).sort();
  assert.deepEqual(names, ["Factory", "complexReceiver", "factory", "run"]);
  assert.equal(all.some(entry => entry.name === "factory().run"), false);
  for (const entry of all) {
    assert.equal("callEdges" in entry, false);
    assert.equal("bindings" in entry, false);
  }
});

test("unicode/crlf: code-point columns are correct for non-BMP identifiers", async () => {
  const outcome = await runKotlinSymbolTable(request(["unicode"]));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  const symbol = outcome.result.symbols.find(entry => entry.name === "𐐀Symbol");
  assert.ok(symbol);
  assert.equal(symbol.nameSpan?.startCol, 7);
  assert.equal(symbol.nameSpan?.endCol, 14);

  const value = outcome.result.symbols.find(entry => entry.name === "𐐀value");
  assert.ok(value);
  assert.equal(value.nameSpan?.startCol, 9);
  assert.equal(value.nameSpan?.endCol, 15);
});

test("adapter: deduplicates duplicate file entries and rejects unsupported ignore", async () => {
  const files = ["packages/alpha/Same.kt", "packages/alpha/Same.kt", "packages/beta/Same.kt"];
  const outcome = await runKotlinSymbolTable(request(["packages"], { files }));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.equal(outcome.result.coverage.scopeFilesDiscovered, 2);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 2);
  assert.equal(outcome.result.coverage.parserInvocations, 1);

  const unsupported = await runKotlinSymbolTable(request(["kinds"], { ignorePolicy: "respect_vcs_ignore" }));
  assert.equal(unsupported.status, "rejected");
  assert.equal(unsupported.status === "rejected" && unsupported.reasonCode, "capability_missing");
});

test("adapter factory returns a callable symbols entry", () => {
  const adapter = createKotlinSymbolTableAdapter();
  assert.equal(typeof adapter.symbols, "function");
});

test("adapter: rejects final and parent symlinks without reading outside symbols", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "nnanything-kotlin-symlink-")));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await writeFile(join(repo, "Normal.kt"), "package fixture.symlink_adapter\n\nfun normalInside() {}\n");
  await writeFile(join(outside, "External.kt"), "package fixture.symlink_adapter\n\nfun outsideRepo() {}\n");
  await symlink(outside, join(repo, "linked"), "dir");
  await symlink(join(outside, "External.kt"), join(repo, "final-link.kt"), "file");

  const outcome = await runKotlinSymbolTable({
    repo,
    language: "kotlin",
    scope: [".", "linked"],
    files: ["Normal.kt", "linked/External.kt", "final-link.kt"],
    ignorePolicy: "no_ignore",
  });

  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  assert.deepEqual(outcome.result.symbols.map(entry => entry.name), ["normalInside"]);
  assert.equal(outcome.result.symbols.some(entry => entry.name === "outsideRepo"), false);
  assert.equal(outcome.result.symbols.some(entry => entry.file === "linked/External.kt"), false);
  assert.equal(outcome.result.symbols.some(entry => entry.file === "final-link.kt"), false);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 1);
  assert.equal(outcome.result.coverage.partial, true);
  assert.deepEqual(
    outcome.result.coverage.skipped.map(entry => entry.file).sort(),
    ["final-link.kt", "linked/External.kt"],
  );
  for (const entry of outcome.result.coverage.skipped) {
    assert.equal(entry.reason, "symlink_not_followed");
  }
});
