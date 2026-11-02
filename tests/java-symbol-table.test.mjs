import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runJavaSymbolTable,
  createJavaSymbolTableAdapter,
} from "../dist/adapters/cli/java-symbol-table-adapter.js";
import {
  filterJavaSymbols,
  projectJavaSymbolTableResult,
  validateJavaSymbolRequest,
} from "../dist/filters/java-symbol-table-policy.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "java-symbols");
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILDER = join(REPO_ROOT, "scripts", "build-java-symbol-jvm.mjs");
const JVM_DIR = join(REPO_ROOT, "dist", "adapters", "cli", "java-symbol-jvm");

// `npm run build` does not compile the Java driver (that wiring is owned by
// Jenny), so make this file self-sufficient: build the driver once before the
// driver-dependent tests run.
before(() => {
  if (existsSync(join(JVM_DIR, "ExtractJavaSymbols.class"))) return;
  const build = spawnSync(process.execPath, [BUILDER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
});

function isJavaSource(name) {
  return name.endsWith(".java");
}

// Test-side stand-in for the public entry's discovery: the adapter itself does
// not traverse directories and only consumes this explicit regular-file list.
function enumerateJavaFiles(scope) {
  const files = [];
  const seen = new Set();
  const walk = abs => {
    const stats = lstatSync(abs);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
      return;
    }
    if (stats.isFile() && isJavaSource(abs)) {
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
    language: "java",
    scope,
    files: enumerateJavaFiles(scope),
    ...extra,
  };
}

function symbols(outcome) {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  if (outcome.status !== "ok") return [];
  return outcome.result.symbols;
}

test("policy: validates request shape and rejects invalid inputs", () => {
  const missing = validateJavaSymbolRequest({});
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.status, "rejected");

  const typo = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "kotlin",
    scope: ["kinds"],
  });
  assert.equal(typo.ok, false);
  assert.equal(typo.ok === false && typo.error.reasonCode, "unsupported_language");

  const escape = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: ["../outside"],
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.ok === false && escape.error.reasonCode, "scope_escape");

  const badIgnore = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: ["kinds"],
    files: ["kinds/Kinds.java"],
    ignorePolicy: "maybe",
  });
  assert.equal(badIgnore.ok, false);
  assert.equal(badIgnore.ok === false && badIgnore.error.reasonCode, "invalid_ignore_policy");

  const badFiles = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: ["kinds"],
    files: ["../outside.java"],
  });
  assert.equal(badFiles.ok, false);
  assert.equal(badFiles.ok === false && badFiles.error.reasonCode, "file_escape");

  const badExtension = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: ["kinds"],
    files: ["kinds/Kinds.txt"],
  });
  assert.equal(badExtension.ok, false);
  assert.equal(badExtension.ok === false && badExtension.error.reasonCode, "invalid_file");

  const good = validateJavaSymbolRequest({
    repo: FIXTURES,
    language: "java",
    scope: [".", "kinds"],
    files: ["kinds/Kinds.java"],
    symbol: "Api",
    file: "kinds/Kinds.java",
    ignorePolicy: "no_ignore",
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.request.symbol, "Api");
    assert.equal(good.request.file, "kinds/Kinds.java");
    assert.equal(good.request.ignorePolicy, "no_ignore");
    assert.deepEqual(good.request.files, ["kinds/Kinds.java"]);
  }
});

test("policy: exact symbol/file filtering and result projection", () => {
  const span = Object.freeze({ startLine: 1, startCol: 1, endLine: 1, endCol: 3 });
  const one = Object.freeze({
    symbolId: "kinds/Kinds.java#One@1:1-1:3",
    name: "One",
    kind: "class",
    file: "kinds/Kinds.java",
    declSpan: span,
    nameSpan: span,
    nameSpanSource: "header_scanner",
    packageName: "fixture.kinds",
    lexicalScope: ["pkg:fixture.kinds"],
    ownerType: null,
    ownerKind: null,
    modifiers: [],
    visibility: "public",
    declaredIn: "file",
    parseStatus: "complete",
  });
  const two = Object.freeze({
    ...one,
    symbolId: "kinds/Kinds.java#Two@4:1-4:3",
    name: "Two",
  });
  const filtered = filterJavaSymbols([one, two], "One", "kinds/Kinds.java");
  assert.deepEqual(filtered.map(entry => entry.name), ["One"]);
  assert.deepEqual(filterJavaSymbols([one, two], "one", null), []);

  const projected = projectJavaSymbolTableResult(
    {
      repo: FIXTURES,
      language: "java",
      scope: ["kinds"],
      symbol: "One",
      file: "kinds/Kinds.java",
      ignorePolicy: "no_ignore",
    },
    {
      backend: "javac_compiler_tree",
      jdkVersion: "17.0.0",
      invocation: "test",
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
  assert.equal(projected.schema, "nnanything.cli-symbols.result.v1");
  assert.deepEqual(projected.symbols.map(entry => entry.name), ["One"]);
  assert.equal(projected.boundaries.classpathTypeResolution, "not_resolved");
});

test("kinds: class/interface/enum/record/annotation and members", async () => {
  const outcome = await runJavaSymbolTable(request(["kinds"]));
  const all = symbols(outcome);

  assert.equal(all.find(entry => entry.name === "Kinds")?.kind, "class");
  assert.equal(all.find(entry => entry.name === "Api")?.kind, "interface");
  assert.equal(all.find(entry => entry.name === "Mode")?.kind, "enum");
  assert.equal(all.find(entry => entry.name === "Point")?.kind, "record");
  assert.equal(all.find(entry => entry.name === "Ann")?.kind, "annotation_interface");
  assert.equal(all.find(entry => entry.name === "Nested")?.ownerType, "Kinds");
  assert.equal(all.find(entry => entry.name === "Inner")?.ownerType, "Kinds");
  assert.equal(all.find(entry => entry.name === "d")?.ownerKind, "interface");

  const magic = all.find(entry => entry.name === "MAGIC");
  assert.equal(magic?.kind, "field");
  assert.equal(magic?.visibility, "private");
  assert.deepEqual([...magic.modifiers], ["private", "static", "final"]);
  assert.equal(all.find(entry => entry.name === "visible")?.visibility, "public");
  assert.equal(all.find(entry => entry.name === "guarded")?.visibility, "protected");
  assert.equal(all.find(entry => entry.name === "hidden")?.visibility, "private");
  assert.equal(all.find(entry => entry.name === "packagePrivate")?.visibility, "package_private");

  const anonymous = all.find(entry => entry.name === "anon$Runnable");
  assert.ok(anonymous);
  assert.equal(anonymous.kind, "class");
  assert.equal(anonymous.declaredIn, "anonymous_class_body");
  assert.equal(anonymous.nameSpanSource, "anonymous_type");
  const anonymousRun = all.find(entry => entry.name === "run" && entry.ownerType === "anon$Runnable");
  assert.ok(anonymousRun);
  assert.equal(anonymousRun.declaredIn, "anonymous_class_body");
  assert.deepEqual([...anonymousRun.lexicalScope], [
    "pkg:fixture.kinds",
    "class:Kinds",
    "method:make",
    "class:anon$Runnable",
  ]);
});

test("kinds: no synthetic implicit constructors are emitted", async () => {
  const outcome = await runJavaSymbolTable(request(["kinds"]));
  const all = symbols(outcome);
  const constructors = all.filter(entry => entry.kind === "constructor");
  assert.deepEqual(
    constructors.map(entry => `${entry.ownerType}:${entry.name}`).sort(),
    ["Kinds:Kinds"],
  );
  const records = all.filter(entry => entry.kind === "record");
  assert.deepEqual(records.map(entry => entry.name), ["Point"]);
  for (const component of ["x", "y"]) {
    const symbol = all.find(entry => entry.name === component && entry.ownerType === "Point");
    assert.equal(symbol?.kind, "record_component");
    assert.equal(symbol?.declaredIn, "record_header");
    assert.equal(symbol?.visibility, "private");
    assert.equal(symbol?.modifiers.includes("final"), true);
  }
});

test("names: same-name annotations/type parameters do not steal nameSpan", async () => {
  const outcome = await runJavaSymbolTable(request(["names"]));
  const all = symbols(outcome);

  const method = all.find(entry => entry.name === "Foo" && entry.kind === "method");
  assert.ok(method);
  const constructor = all.find(entry => entry.name === "Foo" && entry.kind === "constructor"
    && entry.declSpan.startLine === 6);
  assert.ok(constructor);
  const plain = all.find(entry => entry.name === "plain");
  assert.ok(plain);

  for (const symbol of [method, constructor, plain]) {
    assert.equal(symbol.nameSpan !== null, true, `${symbol.declSpan.startLine}:${symbol.declSpan.startCol} nameSpan missing`);
    const span = symbol.nameSpan;
    const decl = symbol.declSpan;
    assert.ok(span.startCol >= decl.startCol, "nameSpan must stay inside declSpan");
    assert.ok(span.endCol <= decl.endCol, "nameSpan must stay inside declSpan");
    assert.equal(typeof symbol.nameSpanSource, "string");
  }
  const constructorSpan = constructor.nameSpan;
  const methodSpan = method.nameSpan;
  assert.equal(constructorSpan.startLine, 6);
  assert.equal(methodSpan.startLine, 5);
});

test("records: compact constructor, components, and body fields stay distinct", async () => {
  const outcome = await runJavaSymbolTable(request(["records"]));
  const all = symbols(outcome);

  assert.deepEqual(
    all.filter(entry => entry.kind === "record_component").map(entry => entry.name),
    ["x", "y"],
  );
  const compact = all.find(entry => entry.kind === "constructor"
    && entry.ownerType === "Rec" && entry.declSpan.startLine === 4);
  assert.ok(compact);
  assert.equal(compact.name, "Rec");
  assert.equal(compact.nameSpan !== null, true);
  assert.equal(compact.declaredIn, "record_body");
  assert.equal(all.find(entry => entry.name === "z")?.kind, "field");
  assert.equal(all.find(entry => entry.name === "z")?.declaredIn, "record_body");
  const total = all.find(entry => entry.name === "total");
  assert.equal(total?.kind, "method");
  assert.equal(total?.ownerType, "Rec");
  assert.equal(all.some(entry => entry.name === "x" && entry.kind === "method"), false);
  assert.equal(all.some(entry => entry.name === "y" && entry.kind === "method"), false);
});

test("enums: annotated constants vs same-name fields are distinguished", async () => {
  const outcome = await runJavaSymbolTable(request(["enums"]));
  const all = symbols(outcome);

  const constants = all.filter(entry => entry.kind === "enum_constant");
  assert.deepEqual(constants.map(entry => entry.name), ["FIRST", "SECOND"]);
  for (const symbol of constants) {
    assert.equal(symbol.visibility, "public");
    assert.equal(symbol.declaredIn, "enum_body");
    assert.equal(symbol.ownerType, "E");
    assert.equal(symbol.ownerKind, "enum");
  }
  const field = all.find(entry => entry.name === "FIRST" && entry.kind === "field");
  assert.ok(field);
  assert.equal(field.declaredIn, "enum_body");
  const rank = all.find(entry => entry.name === "rank");
  assert.equal(rank?.kind, "method");
});

test("unicode: legal escape keeps record complete with unknown nameSpan only", async () => {
  const outcome = await runJavaSymbolTable(request(["unicode"]));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  const escaped = outcome.result.symbols.find(entry => entry.name === "escapedName");
  assert.ok(escaped);
  assert.equal(escaped.parseStatus, "complete");
  assert.equal(escaped.nameSpan, null);
  assert.equal(escaped.nameSpanSource, "unknown");
  const afterEmoji = outcome.result.symbols.find(entry => entry.name === "afterEmoji");
  assert.ok(afterEmoji);
  assert.equal(afterEmoji.nameSpan !== null, true);
  assert.equal(outcome.result.coverage.partial, true);
  assert.ok(outcome.result.coverage.partialReasons.includes("unconfirmed_name_span"));
  assert.equal(outcome.result.coverage.syntaxErrorFiles.length, 0);
});

test("partial: syntax-error file still yields recoverable declarations", async () => {
  const outcome = await runJavaSymbolTable(request(["partial"]));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 2);
  assert.equal(outcome.result.coverage.scopeFilesFailed.length, 0);
  assert.equal(outcome.result.coverage.syntaxErrorFiles.length, 1);
  assert.equal(outcome.result.coverage.syntaxErrorFiles[0].file, "partial/Broken.java");
  const good = outcome.result.symbols.find(entry => entry.name === "Good");
  assert.equal(good?.parseStatus, "complete");
  const broken = outcome.result.symbols.find(entry => entry.name === "Broken");
  assert.ok(broken);
  assert.equal(broken.parseStatus, "partial_syntax_error");
});

test("nested/scopes: same short names in different owners and overloads stay distinct", async () => {
  const outcome = await runJavaSymbolTable(request(["nested"]));
  const all = symbols(outcome);

  const methods = all.filter(entry => entry.name === "shared" && entry.kind === "method");
  assert.equal(methods.length, 5);
  const owners = new Set(methods.map(entry => entry.ownerType));
  assert.deepEqual(owners, new Set(["Alpha", "Inner", "Beta"]));
  const inner = all.find(entry => entry.name === "Inner");
  assert.equal(inner?.kind, "class");
  assert.equal(inner?.ownerType, "Alpha");
  assert.deepEqual([...inner.lexicalScope], ["pkg:fixture.nested", "class:Alpha"]);
});

test("unicode/crlf: code-point columns are correct", async () => {
  const outcome = await runJavaSymbolTable(request(["unicode"]));
  const afterEmoji = outcome.result.symbols.find(entry => entry.name === "afterEmoji");
  assert.equal(afterEmoji.nameSpan.startLine, 5);
  assert.equal(afterEmoji.nameSpan.startCol, 18);
  assert.equal(afterEmoji.nameSpan.endCol, 28);
});

test("real: DumpProvider members and anonymous classes", async () => {
  const outcome = await runJavaSymbolTable(request(["real"]));
  const all = symbols(outcome);

  const dump = all.find(entry => entry.name === "DumpProvider");
  assert.equal(dump?.kind, "class");
  const copy = all.find(entry => entry.name === "copy");
  assert.equal(copy?.kind, "method");
  const onCreate = all.find(entry => entry.name === "onCreate");
  assert.equal(onCreate?.kind, "method");
  const observer = all.find(entry => entry.name === "anon$FileObserver");
  assert.equal(observer?.nameSpanSource, "anonymous_type");
  const onEvent = all.find(entry => entry.name === "onEvent" && entry.ownerType === "anon$FileObserver");
  assert.equal(onEvent?.kind, "method");
  const runnable = all.find(entry => entry.name === "anon$Runnable");
  assert.equal(runnable?.kind, "class");
  const run = all.find(entry => entry.name === "run" && entry.ownerType === "anon$Runnable");
  assert.equal(run?.kind, "method");
  assert.equal(all.some(entry => entry.kind === "constructor"), false);
});

test("adapter: deduplicates duplicate file entries and rejects unsupported ignore", async () => {
  const files = ["kinds/Kinds.java", "kinds/Kinds.java"];
  const outcome = await runJavaSymbolTable(request(["kinds"], { files }));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.equal(outcome.result.coverage.scopeFilesParsed, 1);
  assert.equal(outcome.result.coverage.parserInvocations, 1);

  const unsupported = await runJavaSymbolTable(request(["kinds"], { ignorePolicy: "respect_vcs_ignore" }));
  assert.equal(unsupported.status, "rejected");
  assert.equal(unsupported.status === "rejected" && unsupported.reasonCode, "capability_missing");
});

test("adapter: missing java or missing driver class rejects before JVM start", async () => {
  const missingPath = await runJavaSymbolTable(request(["kinds"]), { javaBin: "/nonexistent/java" });
  assert.equal(missingPath.status, "rejected");
  assert.equal(missingPath.status === "rejected" && missingPath.reasonCode, "JAVA_COMPILER_UNAVAILABLE");

  const missingDriver = async () => {
    const temp = await mkdtemp(join(tmpdir(), "nnanything-java-driver-"));
    const outcome = await runJavaSymbolTable(request(["kinds"]), { driverClassDir: temp });
    await rm(temp, { recursive: true, force: true });
    return outcome;
  };
  const driverOutcome = await missingDriver();
  assert.equal(driverOutcome.status, "rejected");
  assert.equal(driverOutcome.status === "rejected" && driverOutcome.reasonCode, "JAVA_DRIVER_NOT_BUILT");
});

test("adapter: rejects final and parent symlinks without reading outside symbols", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "nnanything-java-symlink-")));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const repo = join(parent, "repo");
  const outside = join(parent, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await writeFile(join(repo, "Normal.java"), "package fixture.symlink_adapter;\n\nclass Normal { void nativeMethod() {} }\n");
  await writeFile(join(outside, "External.java"), "package fixture.symlink_adapter;\n\nclass External { void outsideRepo() {} }\n");
  await symlink(outside, join(repo, "linked"), "dir");
  await symlink(join(outside, "External.java"), join(repo, "final-link.java"), "file");

  const outcome = await runJavaSymbolTable({
    repo,
    language: "java",
    scope: [".", "linked"],
    files: ["Normal.java", "linked/External.java", "final-link.java"],
    ignorePolicy: "no_ignore",
  });

  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.deepEqual(outcome.result.symbols.map(entry => entry.name), ["Normal", "nativeMethod"]);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 1);
  assert.equal(outcome.result.coverage.partial, true);
  assert.deepEqual(
    outcome.result.coverage.skipped.map(entry => entry.file).sort(),
    ["final-link.java", "linked/External.java"],
  );
  for (const entry of outcome.result.coverage.skipped) {
    assert.equal(entry.reason, "symlink_not_followed");
  }
});

test("adapter factory returns a callable symbols entry", () => {
  const adapter = createJavaSymbolTableAdapter();
  assert.equal(typeof adapter.symbols, "function");
});

test("enums: broken source does not promote a NOPOS field to enum_constant", async () => {
  const outcome = await runJavaSymbolTable(request(["broken-enum"]));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  const all = outcome.result.symbols;
  const constants = all.filter(entry => entry.kind === "enum_constant").map(entry => entry.name);
  assert.deepEqual(constants, ["RED", "GREEN"]);
  // The malformed trailing field must stay a field even though its type or
  // initializer position is unusable; broken syntax is not proof of an enum
  // constant.
  const broken = all.find(entry => entry.name === "broken");
  assert.equal(broken?.kind, "field");
  assert.equal(all.some(entry => entry.name === "broken" && entry.kind === "enum_constant"), false);
  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.coverage.syntaxErrorFiles.length, 1);
});

test("adapter: mid-batch JVM failure keeps completed files and reports the rest", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "nnanything-java-interrupt-")));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const repo = join(parent, "repo");
  const fakeJava = join(parent, "fake-java");
  await mkdir(repo);
  await writeFile(join(repo, "A.java"), "class A { void a() {} }\n");
  await writeFile(join(repo, "B.java"), "class B { void b() {} }\n");
  await writeFile(join(repo, "C.java"), "class C { void c() {} }\n");

  const fileLine = JSON.stringify({
    type: "file",
    file: "A.java",
    parseStatus: "complete",
    syntaxErrorCount: 0,
    syntaxErrors: [],
    failed: false,
    unconfirmedNameSpans: 0,
    symbols: [{
      symbolId: "A.java#A@1:1-1:20",
      name: "A",
      kind: "class",
      file: "A.java",
      declSpan: { startLine: 1, startCol: 1, endLine: 1, endCol: 2 },
      nameSpan: { startLine: 1, startCol: 7, endLine: 1, endCol: 8 },
      nameSpanSource: "header_scanner",
      packageName: null,
      lexicalScope: [],
      ownerType: null,
      ownerKind: null,
      modifiers: [],
      visibility: "package_private",
      declaredIn: "file",
      parseStatus: "complete",
    }],
  });
  await writeFile(fakeJava, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'openjdk version "17.0.1"'
  exit 0
fi
argfile=""
for a in "$@"; do
  case "$a" in
    *.txt) argfile="$a"; break ;;
  esac
done
printf '%s\\n' '${fileLine}'
exit 3
`, "utf8");
  await chmod(fakeJava, 0o755);

  const outcome = await runJavaSymbolTable({
    repo,
    language: "java",
    scope: ["."],
    files: ["A.java", "B.java", "C.java"],
    ignorePolicy: "no_ignore",
  }, { javaBin: fakeJava });

  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.deepEqual(outcome.result.symbols.map(entry => entry.name), ["A"]);
  assert.equal(outcome.result.coverage.partial, true);
  assert.equal(outcome.result.coverage.scopeFilesParsed, 1);
  assert.deepEqual(
    outcome.result.coverage.scopeFilesFailed.map(entry => entry.file).sort(),
    ["B.java", "C.java"],
  );
  assert.ok(outcome.result.coverage.partialReasons.some(reason => reason.includes("jvm_batch_interrupted")));
});

test("build: clean compile uses public APIs and emits the driver classes", () => {
  assert.equal(existsSync(BUILDER), true, BUILDER);
  const build = spawnSync(process.execPath, [BUILDER, "--clean"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.equal(existsSync(join(JVM_DIR, "ExtractJavaSymbols.class")), true);
  const classNames = readdirSync(JVM_DIR);
  assert.ok(classNames.includes("ExtractJavaSymbols$Collector.class"));
});

test("build: invalid NN_CODE_JAVAC_BIN fails with an explicit diagnostic", () => {
  const run = spawnSync(process.execPath, [BUILDER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NN_CODE_JAVAC_BIN: "/definitely/not/a/javac" },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr ?? ""}${run.stdout ?? ""}`, /NN_CODE_JAVAC_BIN/);
});
