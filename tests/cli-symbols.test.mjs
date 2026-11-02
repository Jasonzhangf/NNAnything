import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TESTS_DIR);
const BIN = join(REPO_ROOT, "dist", "cli-call-depth-bin.js");
const FIXTURES = join(TESTS_DIR, "fixtures", "rust-symbols");
const KOTLIN_FIXTURES = join(TESTS_DIR, "fixtures", "kotlin-symbols");

function runCli(argv, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runSymbols(args, cwd = REPO_ROOT) {
  return runCli(["symbols", ...args], cwd);
}

function jsonOf(result) {
  return JSON.parse(result.stdout);
}

test("symbols --help lists symbols usage and calls-only exclusions; calls help is unchanged", () => {
  const symbolsHelp = runSymbols(["--help"]);
  assert.equal(symbolsHelp.status, 0, symbolsHelp.stderr);
  assert.match(symbolsHelp.stdout, /nn-code symbols/);
  assert.match(symbolsHelp.stdout, /--scope/);
  assert.match(symbolsHelp.stdout, /--entry-file/);
  assert.equal(symbolsHelp.stderr, "");

  const globalHelp = runCli(["--help"]);
  assert.equal(globalHelp.status, 0, globalHelp.stderr);
  assert.match(globalHelp.stdout, /symbols/);

  const callsHelp = runCli(["calls", "--help"]);
  assert.equal(callsHelp.status, 0, callsHelp.stderr);
  assert.match(callsHelp.stdout, /nn-code calls/);
  assert.match(callsHelp.stdout, /--entry-symbol/);
});

test("fixture src scope returns a single structured result with honest partial coverage", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.schema, "nnanything.cli-symbols.result.v1");
  assert.equal(payload.language, "rust");
  assert.equal(payload.parser.backend, "rustc_ast_unpretty");
  assert.equal(payload.parser.semanticBinding, false);
  assert.deepEqual(payload.scope, ["src"]);
  assert.equal(payload.coverage.ignorePolicy, "no_ignore");
  assert.equal(payload.coverage.truncated, false);
  assert.equal(payload.boundaries.macroGeneratedDeclarations, "not_expanded");
  assert.equal(payload.logging.state, "disabled");

  const names = new Set(payload.symbols.map(entry => entry.name));
  for (const expected of ["Widget", "GoodStruct", "outer", "inner", "LocalS", "area"]) {
    assert.ok(names.has(expected), `missing symbol ${expected}`);
  }
  assert.equal(payload.coverage.partial, true);
  assert.ok(payload.coverage.scopeFilesFailed.some(entry => entry.file === "src/broken_partial.rs"));
  for (const symbol of payload.symbols) {
    assert.equal(symbol.nameSpan, null);
    assert.equal(symbol.nameSpanSource, "null_reason: ast_dump_ident_has_no_span");
  }
});

test("clean scope reports partial false and exact code-point spans", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "loc",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.coverage.partial, false);
  assert.deepEqual(payload.coverage.skipped, []);
  const unicode = payload.symbols.find(entry => entry.name === "数据加载");
  assert.ok(unicode);
  assert.deepEqual(unicode.declSpan, { startLine: 1, startCol: 1, endLine: 1, endCol: 17 });
  assert.equal(unicode.nameSpan, null);
});

test("public symbols entry extracts nested and conditional block declarations", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src/nested_blocks.rs",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.deepEqual(
    payload.symbols.map(entry => entry.name).sort(),
    ["conditional", "direct", "nested", "outer"],
  );
  for (const name of ["direct", "nested", "conditional"]) {
    const symbol = payload.symbols.find(entry => entry.name === name);
    assert.equal(symbol?.kind, "function");
    assert.deepEqual(symbol?.lexicalScope, ["crate", "fn:outer"]);
  }
  assert.equal(payload.coverage.partial, false);
  assert.equal(payload.coverage.truncated, false);
});

test("public symbols entry keeps direct, bare-block, and if-branch same-name fns distinct", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src/same_name_nested.rs",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.symbols.length, 4);
  assert.deepEqual(
    payload.symbols.map(entry => entry.name).sort(),
    ["dup", "dup", "dup", "outer"],
  );

  const dups = payload.symbols.filter(entry => entry.name === "dup");
  assert.equal(dups.length, 3);
  for (const dup of dups) {
    assert.equal(dup.kind, "function");
    assert.deepEqual(dup.lexicalScope, ["crate", "fn:outer"]);
  }
  assert.equal(new Set(dups.map(entry => entry.symbolId)).size, 3);
  assert.equal(new Set(dups.map(entry => entry.declSpan.startLine)).size, 3);
  assert.equal(payload.coverage.partial, false);
  assert.equal(payload.coverage.truncated, false);
});

test("rust and rs language aliases both route to the rust adapter", () => {
  for (const language of ["rust", "rs"]) {
    const result = runSymbols([
      "--repo", FIXTURES,
      "--language", language,
      "--scope", "src/good_file.rs",
      "--compact",
      "--no-log",
    ]);
    assert.equal(result.status, 0, `${language}: ${result.stderr}`);
    const payload = jsonOf(result);
    assert.equal(payload.language, "rust");
    assert.deepEqual(payload.symbols.map(entry => entry.name), ["first_good", "GoodStruct"]);
  }
});

test("four-way symlink boundary: final link, outside parent, inside parent all skipped; real file parsed", () => {
  const base = mkdtempSync(join(tmpdir(), "cli-symbols-link-"));
  const repo = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "inside"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    writeFileSync(join(repo, "src", "real.rs"), "pub fn real_symbol() {}\n");
    writeFileSync(join(repo, "inside", "inner.rs"), "pub fn inside_symbol() {}\n");
    writeFileSync(join(outside, "outer.rs"), "pub fn outside_symbol() {}\n");
    symlinkSync("real.rs", join(repo, "src", "final_link.rs"));
    symlinkSync("../inside", join(repo, "src", "inside_link"));
    symlinkSync(outside, join(repo, "src", "outside_link"));

    const result = runSymbols([
      "--repo", repo,
      "--language", "rust",
      "--scope", "src",
      "--compact",
      "--no-log",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = jsonOf(result);
    const names = payload.symbols.map(entry => entry.name);
    assert.deepEqual(names, ["real_symbol"]);
    assert.equal(payload.symbols[0].file, "src/real.rs");

    const skipped = Object.fromEntries(payload.coverage.skipped.map(entry => [entry.file, entry.reason]));
    assert.equal(skipped["src/final_link.rs"], "SYMLINK_PATH_COMPONENT");
    assert.equal(skipped["src/inside_link"], "SYMLINK_PATH_COMPONENT");
    assert.equal(skipped["src/outside_link"], "SYMLINK_PATH_COMPONENT");
    assert.equal(payload.coverage.partial, true);
    assert.equal(names.includes("inside_symbol"), false);
    assert.equal(names.includes("outside_symbol"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unsupported language returns UNSUPPORTED_LANGUAGE, not entry_not_found", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "typescript",
    "--scope", "src",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 4, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.status, "rejected");
  assert.equal(payload.reasonCode, "UNSUPPORTED_LANGUAGE");
});

test("respect_vcs_ignore is rejected instead of silently downgraded to no_ignore", () => {
  const result = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src",
    "--ignore-policy", "respect_vcs_ignore",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 4, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.status, "rejected");
  assert.ok(
    ["respect_vcs_ignore_requires_ripgrep", "respect_vcs_ignore_not_implemented"].includes(payload.reasonCode),
    payload.reasonCode,
  );
});

test("kotlin scope returns a structured result through the public symbols entry", () => {
  const result = runSymbols([
    "--repo", KOTLIN_FIXTURES,
    "--language", "kotlin",
    "--scope", "kinds",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.schema, "nnanything.cli-symbols.result.v1");
  assert.equal(payload.language, "kotlin");
  assert.equal(payload.parser.backend, "kotlin_psi_factory");
  assert.equal(payload.parser.semanticBinding, false);
  assert.deepEqual(payload.scope, ["kinds"]);
  assert.equal(payload.coverage.ignorePolicy, "no_ignore");
  assert.equal(payload.coverage.truncated, false);
  assert.equal(payload.logging.state, "disabled");

  const names = new Set(payload.symbols.map(entry => entry.name));
  for (const expected of ["Registry", "Api", "Payload", "Mode", "StringList", "bang", "FAST", "SLOW"]) {
    assert.ok(names.has(expected), `missing symbol ${expected}`);
  }
  assert.equal(payload.symbols.find(entry => entry.name === "Api")?.kind, "interface");
  assert.equal(payload.symbols.find(entry => entry.name === "bang")?.receiverType, "String");
});

test("kt alias routes to the kotlin adapter", () => {
  const result = runSymbols([
    "--repo", KOTLIN_FIXTURES,
    "--language", "kt",
    "--scope", "kinds",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.language, "kotlin");
  assert.ok(payload.symbols.length > 0);
});

test("kotlin respect_vcs_ignore is rejected instead of silently downgraded", () => {
  const result = runSymbols([
    "--repo", KOTLIN_FIXTURES,
    "--language", "kotlin",
    "--scope", "kinds",
    "--ignore-policy", "respect_vcs_ignore",
    "--compact",
    "--no-log",
  ]);
  assert.equal(result.status, 4, result.stderr);
  const payload = jsonOf(result);
  assert.equal(payload.status, "rejected");
  assert.ok(
    ["respect_vcs_ignore_requires_ripgrep", "respect_vcs_ignore_not_implemented"].includes(payload.reasonCode),
    payload.reasonCode,
  );
});

test("missing required arguments and escaping scope return status rejected", () => {
  const missingScope = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--compact",
    "--no-log",
  ]);
  assert.equal(missingScope.status, 4);
  assert.equal(jsonOf(missingScope).reasonCode, "missing_scope");

  const missingLanguage = runSymbols([
    "--repo", FIXTURES,
    "--scope", "src",
    "--compact",
    "--no-log",
  ]);
  assert.equal(missingLanguage.status, 4);
  assert.equal(jsonOf(missingLanguage).reasonCode, "missing_language");

  const missingRepo = runSymbols([
    "--language", "rust",
    "--scope", "src",
    "--compact",
    "--no-log",
  ]);
  assert.equal(missingRepo.status, 4);
  assert.equal(jsonOf(missingRepo).reasonCode, "missing_repo");

  const escape = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "../escape",
    "--compact",
    "--no-log",
  ]);
  assert.equal(escape.status, 4);
  assert.equal(jsonOf(escape).reasonCode, "scope_escape");
});

test("calls-only flags are rejected by symbols with unknown_argument", () => {
  for (const extra of [
    ["--entry-file", "src/good_file.rs"],
    ["--entry-symbol", "first_good"],
    ["--max-depth", "1"],
  ]) {
    const result = runSymbols([
      "--repo", FIXTURES,
      "--language", "rust",
      "--scope", "src",
      "--compact",
      "--no-log",
      ...extra,
    ]);
    assert.equal(result.status, 4);
    assert.equal(jsonOf(result).reasonCode, "unknown_argument");
  }
});

test("symbol and file filter as an exact intersection", () => {
  const hit = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src",
    "--symbol", "Widget",
    "--file", "src/kinds.rs",
    "--compact",
    "--no-log",
  ]);
  assert.equal(hit.status, 0, hit.stderr);
  const hitPayload = jsonOf(hit);
  assert.deepEqual(hitPayload.symbols.map(entry => entry.name), ["Widget"]);
  assert.deepEqual(hitPayload.symbols.map(entry => entry.file), ["src/kinds.rs"]);

  const miss = runSymbols([
    "--repo", FIXTURES,
    "--language", "rust",
    "--scope", "src",
    "--symbol", "Widget",
    "--file", "src/good_file.rs",
    "--compact",
    "--no-log",
  ]);
  assert.equal(miss.status, 0, miss.stderr);
  assert.deepEqual(jsonOf(miss).symbols, []);
});

test("--log-dir writes one usage-log JSONL; --no-log disables persistence", () => {
  const logDir = mkdtempSync(join(tmpdir(), "cli-symbols-log-"));
  try {
    const logged = runSymbols([
      "--repo", FIXTURES,
      "--language", "rust",
      "--scope", "src/good_file.rs",
      "--compact",
      "--log-dir", logDir,
    ]);
    assert.equal(logged.status, 0, logged.stderr);
    const payload = jsonOf(logged);
    assert.equal(payload.logging.enabled, true);
    assert.ok(payload.runLogPath.endsWith(".jsonl"));
    const logs = readdirSync(logDir).filter(name => name.endsWith(".jsonl"));
    assert.equal(logs.length, 1);

    const disabled = runSymbols([
      "--repo", FIXTURES,
      "--language", "rust",
      "--scope", "src/good_file.rs",
      "--compact",
      "--no-log",
    ]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(jsonOf(disabled).logging.state, "disabled");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
