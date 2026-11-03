// Batch A black-box regression for the `nn-code calls` explicit language
// routing and the first-round text candidate list. Every assertion observes
// the compiled `dist/cli-call-depth-bin.js` process from a non-project cwd.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");

function identifierPositions(source, name) {
  const sourceFile = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const positions = [];
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === name) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      positions.push({ line: pos.line + 1, column: pos.character + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return positions;
}

function textAt(line, column, text) {
  const lines = Array.from({ length: Math.max(line, 1) }, () => "");
  lines[line - 1] = " ".repeat(column - 1) + text;
  return `${lines.join("\n")}\n`;
}

function runBin(args, cwd, extraEnv = {}) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

async function makeRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-language-a-")));
  await mkdir(join(root, "src"), { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function write(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

test("TS without --language keeps the old success path and now includes first-round text candidates", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "entry.ts"),
    "export function entry(){ return helper(); }\nfunction helper(){ return 1; }\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.resolution, "complete");
  assert.equal(payload.requestedLanguage, null);
  assert.equal(payload.actualParser, "typescript");
  assert.deepEqual(payload.supportedLanguages, ["typescript", "javascript", "rust"]);
  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.edges.length, 1);
  assert.equal(payload.unresolvedCallsites.length, 0);
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath), ["src/entry.ts"]);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.text.scanConditions.needle, "entry");
  assert.equal(payload.coverage.semantic.status, "complete");
  assert.equal(payload.coverage.semantic.parser, "typescript");
});

test("explicit typescript/ts and javascript/js aliases route without claiming a JS parser backend", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "entry.ts"),
    "export function entry(){ return 1; }\n");
  await write(join(root, "src", "entry.js"),
    "export function entry(){ return 1; }\n");

  const tsRun = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--language", "ts",
    "--compact",
  ], tmpdir());
  assert.equal(tsRun.status, 0, tsRun.stderr);
  const tsPayload = JSON.parse(tsRun.stdout);
  assert.equal(tsPayload.requestedLanguage, "typescript");
  assert.equal(tsPayload.actualParser, "typescript");
  assert.equal(tsPayload.status, "achieved");

  const jsRun = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.js",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--language", "javascript",
    "--compact",
  ], tmpdir());
  assert.equal(jsRun.status, 0, jsRun.stderr);
  const jsPayload = JSON.parse(jsRun.stdout);
  assert.equal(jsPayload.requestedLanguage, "javascript");
  assert.equal(jsPayload.actualParser, "typescript");
  assert.equal(jsPayload.coverage.semantic.parser, "typescript");
  assert.equal(jsPayload.coverage.languageSupport.actualParser, "typescript");
  assert.equal(jsPayload.coverage.languageSupport.requested, "javascript");
  assert.equal(jsPayload.status, "achieved");
});

test("--language rust parses real Rust content and resolves a same-file call", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "main.rs"),
    "fn entry() -> i32 { helper() }\n\nfn helper() -> i32 { 1 }\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/main.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rust",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.resolution, "complete");
  assert.equal(payload.requestedLanguage, "rust");
  assert.equal(payload.actualParser, "rust");
  assert.deepEqual(payload.supportedLanguages, ["typescript", "javascript", "rust"]);
  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.edges.length, 1);
  assert.equal(payload.unresolvedCallsites.length, 0);
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath), ["src/main.rs"]);
  assert.equal(payload.textCandidates[0].matchedNeedle, "entry");
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.semantic.status, "complete");
  assert.equal(payload.coverage.semantic.parser, "rust");
  assert.equal(payload.coverage.languageSupport.requested, "rust");
  assert.equal(payload.coverage.languageSupport.supported, true);
  assert.equal(payload.coverage.languageSupport.actualParser, "rust");
});

test("misspelled --language value is an argument error exit 1", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "main.rs"), "fn entry() {}\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/main.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rustt",
  ], tmpdir());
  assert.equal(run.status, 1);
  const error = JSON.parse(run.stderr).error;
  assert.equal(error.stage, "args");
  assert.match(error.message, /unknown --language value: rustt/);
  assert.equal(run.stdout, "");
});

test("--language typescript with a .rs entry returns mismatch, candidates, and no parser invocation", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "main.rs"), "fn entry() {}\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/main.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "typescript",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 3, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unknown");
  assert.equal(payload.resolution, "LANGUAGE_MISMATCH");
  assert.equal(payload.actualParser, null);
  assert.equal(payload.coverage.languageSupport.actualParser, null);
  assert.equal(payload.coverage.semantic.status, "mismatch");
  assert.equal(payload.coverage.semantic.parser, null);
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath), ["src/main.rs"]);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.nodes.length, 0);
});

test("zero text matches complete scan returns full text coverage with no candidates", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "entry.ts"), "export function other(){ return 1; }\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "absent",
    "--max-depth", "0",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 2, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unmet");
  assert.equal(payload.resolution, "entry_not_found");
  assert.equal(payload.textCandidates.length, 0);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.text.complete, true);
  assert.equal(payload.coverage.text.failures.length, 0);
  assert.equal(payload.coverage.text.scannedFiles, 1);
});

test("unreadable file during scan is a distinct coverage failure, not a zero-match", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "ok.ts"), "export function entry(){ return 1; }\n");
  await write(join(root, "src", "locked.ts"), "export function entry(){ return 2; }\n");
  await chmod(join(root, "src", "locked.ts"), 0o000);
  t.after(async () => {
    await chmod(join(root, "src", "locked.ts"), 0o644).catch(() => {});
  });
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/ok.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.notEqual(run.status, 2, "partial/failed scan must not become entry_not_found");
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.coverage.text.status, "failed");
  assert.equal(payload.coverage.text.complete, false);
  assert.ok(payload.coverage.text.unreadFiles.some(path => path.endsWith("src/locked.ts")), JSON.stringify(payload.coverage.text.unreadFiles));
  assert.ok(payload.coverage.text.failures.some(failure => failure.endsWith("EACCES")), JSON.stringify(payload.coverage.text.failures));
});

test("rust text candidates cover multiple occurrences across files", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "a.rs"), "fn entry() {}\n");
  await write(join(root, "src", "b.rs"), "fn entry() {}\n");
  await write(join(root, "src", "c.rs"), "fn other() {}\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/a.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rust",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.requestedLanguage, "rust");
  assert.equal(payload.actualParser, "rust");
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath).sort(), ["src/a.rs", "src/b.rs"]);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.text.matchedFiles, 2);
});

test("explicit javascript does not report a JavaScript parser backend", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "entry.js"),
    "export function entry(){ return 1; }\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.js",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--language", "javascript",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.requestedLanguage, "javascript");
  assert.equal(payload.actualParser, "typescript");
  assert.equal(payload.coverage.semantic.parser, "typescript");
  assert.equal(payload.coverage.languageSupport.requested, "javascript");
  assert.equal(payload.coverage.languageSupport.actualParser, "typescript");
});

test("same line/column text hit in a different file is not confirmed_call", async t => {
  const root = await makeRepo(t);
  const source = "export function entry(){ return helper(); }\nfunction helper(){ return entry(); }\n";
  await write(join(root, "src", "entry.ts"), source);
  const positions = identifierPositions(source, "entry");
  assert.equal(positions.length, 2, "fixture has one declaration and one call");
  const call = positions[1];
  await write(join(root, "src", "other.ts"), textAt(call.line, call.column, "entry"));
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "2",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  const sameFile = payload.textCandidates.find(candidate =>
    candidate.filePath === "src/entry.ts"
    && candidate.line === call.line
    && candidate.column === call.column);
  assert.ok(sameFile, "same-file call candidate is present");
  assert.equal(sameFile.disposition, "confirmed_call");
  const otherFile = payload.textCandidates.find(candidate => candidate.filePath === "src/other.ts");
  assert.ok(otherFile, "other-file candidate is present");
  assert.equal(otherFile.line, call.line);
  assert.equal(otherFile.column, call.column);
  assert.notEqual(otherFile.disposition, "confirmed_call");
  assert.equal(otherFile.disposition, "unclassified");
});

test("unresolved callsite is unknown with callsite evidence, not other_binding", async t => {
  const root = await makeRepo(t);
  const source = "export function entry(){ return helper(); }\nfunction helper(){ return obj.entry(); }\n";
  await write(join(root, "src", "entry.ts"), source);
  const positions = identifierPositions(source, "entry");
  assert.equal(positions.length, 2, "fixture has one declaration and one unresolved property name");
  const unresolved = positions[1];
  await write(join(root, "src", "other.ts"), textAt(unresolved.line, unresolved.column, "entry"));
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "2",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.unresolvedCallsites.length, 1);
  const unresolvedFact = payload.unresolvedCallsites[0];
  assert.equal(unresolvedFact.calleeExpr, "obj.entry");
  const sameFile = payload.textCandidates.find(candidate =>
    candidate.filePath === "src/entry.ts"
    && candidate.line === unresolved.line
    && candidate.column === unresolved.column);
  assert.ok(sameFile, "unresolved candidate is present");
  assert.equal(sameFile.disposition, "unknown");
  assert.ok(sameFile.evidenceRefs.includes(`callsite:${unresolvedFact.callerId}`));
  const otherFile = payload.textCandidates.find(candidate => candidate.filePath === "src/other.ts");
  assert.ok(otherFile, "other-file candidate is present");
  assert.equal(otherFile.disposition, "unclassified");
});

test("definition attribution uses the declaration name token, not the whole function body", async t => {
  const root = await makeRepo(t);
  const source = "export function entry(){\n // entry in comment\n return helper(\"entry\");\n}\nfunction helper(value: string){ return value; }\n";
  await write(join(root, "src", "entry.ts"), source);
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  const byPosition = (line, column) => payload.textCandidates.find(candidate =>
    candidate.filePath === "src/entry.ts"
    && candidate.line === line
    && candidate.column === column);

  const declaration = byPosition(1, 17);
  assert.ok(declaration, JSON.stringify(payload.textCandidates));
  assert.equal(declaration.disposition, "definition");

  const comment = byPosition(2, 5);
  assert.ok(comment, "comment candidate is present");
  assert.notEqual(comment.disposition, "definition", "comment text must not be the definition");

  const string = byPosition(3, 17);
  assert.ok(string, "string candidate is present");
  assert.notEqual(string.disposition, "definition", "string text must not be the definition");
});

test("same-name unresolved call inside the entry body stays unknown, not definition", async t => {
  const root = await makeRepo(t);
  const source = "export function entry(){\n return obj.entry();\n}\n";
  await write(join(root, "src", "entry.ts"), source);
  const positions = identifierPositions(source, "entry");
  assert.equal(positions.length, 2, "fixture has one declaration and one unresolved property name");
  const declaration = positions[0];
  const unresolved = positions[1];
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "2",
    "--scope", "src",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.unresolvedCallsites.length, 1);
  const unresolvedFact = payload.unresolvedCallsites[0];
  assert.equal(unresolvedFact.calleeExpr, "obj.entry");

  const declarationCandidate = payload.textCandidates.find(candidate =>
    candidate.filePath === "src/entry.ts"
    && candidate.line === declaration.line
    && candidate.column === declaration.column);
  assert.ok(declarationCandidate, "declaration candidate is present");
  assert.equal(declarationCandidate.disposition, "definition");

  const unresolvedCandidate = payload.textCandidates.find(candidate =>
    candidate.filePath === "src/entry.ts"
    && candidate.line === unresolved.line
    && candidate.column === unresolved.column);
  assert.ok(unresolvedCandidate, "unresolved callsite candidate is present");
  assert.equal(unresolvedCandidate.disposition, "unknown");
  assert.ok(unresolvedCandidate.evidenceRefs.includes(`callsite:${unresolvedFact.callerId}`));
});

test("run log records requested language, actual parser and both coverage dimensions", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "main.rs"), "fn entry() {}\n");
  const logDir = await realpath(await mkdtemp(join(tmpdir(), "nn-language-a-log-")));
  t.after(async () => {
    await rm(logDir, { recursive: true, force: true });
  });
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/main.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rust",
    "--log-dir", logDir,
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(typeof payload.runLogPath, "string");
  const logText = await readFile(payload.runLogPath, "utf8");
  const events = logText.split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
  const finish = events[events.length - 1];
  assert.equal(finish.kind, "finish");
  assert.equal(finish.coverage.requestedLanguage, "rust");
  assert.equal(finish.coverage.actualParser, "rust");
  assert.equal(finish.coverage.coverage.text.status, "complete");
  assert.equal(finish.coverage.coverage.semantic.status, "complete");
  assert.ok(finish.resultReceipt.textCandidates.length >= 1);
});

const RUST_FIXTURES = Object.freeze({
  RS_NEG_1: { symbol: "select_slot", reasons: ["RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH"], clues: ["read_slot", "read_slot"], coverage: ["locatable_candidate_unverified", "locatable_candidate_unverified"], missing: [["receiver_type_or_trait_impl_unverified"], ["receiver_type_or_trait_impl_unverified"]], modules: [null, null], candidates: [null, null], binding: [true, true] },
  RS_NEG_2: { symbol: "run_untyped_and_colliding", reasons: ["RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH"], clues: ["check", "check"], coverage: ["truly_dynamic_unlocatable", "locatable_candidate_unverified"], missing: [["receiver_type_or_trait_impl_unverified"], ["receiver_type_or_trait_impl_unverified"]], modules: [null, null], candidates: [null, "src/lib.rs"], binding: [null, true] },
  RS_NEG_3: { symbol: "handle_event", reasons: ["RUST_MACRO_INVOCATION_UNEXPANDED", "RUST_MACRO_INVOCATION_UNEXPANDED"], clues: ["matches", "dispatch_call"], coverage: ["boundary_not_expanded", "boundary_not_expanded"], missing: [["macro_expansion_not_evaluated"], ["macro_expansion_not_evaluated"]], modules: [null, null], candidates: [null, null], binding: [null, null] },
  RS_NEG_4: { symbol: "run_compute", reasons: ["RUST_CFG_CONDITIONAL_TARGET"], clues: ["compute"], coverage: ["locatable_candidate_unverified"], missing: [["cfg_condition_unverified"]], modules: [null], candidates: ["src/lib.rs"], binding: [null] },
  RS_NEG_5: { symbol: "run_with_hook", reasons: ["LEXICAL_PARAM_OR_CLOSURE_CALL", "LEXICAL_PARAM_OR_CLOSURE_CALL"], clues: [null, null], coverage: ["truly_dynamic_unlocatable", "truly_dynamic_unlocatable"], missing: [["runtime_callback_or_higher_order_value"], ["runtime_callback_or_higher_order_value"]], modules: [null, null], candidates: [null, null], binding: [true, true] },
  RS_NEG_6: { symbol: "run_glob_and_ext", reasons: ["EXTERNAL_CRATE_OR_STD_CALL", "RUST_GLOB_USE_AMBIGUOUS_TARGET"], clues: ["from_str", "parse_item"], coverage: ["boundary_not_expanded", "locatable_candidate_unverified"], missing: [["external_crate_or_out_of_scope_target"], ["glob_use_resolution_unverified"]], modules: ["serde_json", "crate::mod_a, crate::mod_b"], candidates: [null, null], binding: [null, null] },
});

test("P1-2: public Rust CLI preserves all structured unresolved evidence fields", async () => {
  for (const [id, expected] of Object.entries(RUST_FIXTURES)) {
    const repo = join(repoRoot, "tests", "fixtures", "rust-calls", id);
    const run = runBin(["calls",
      "--repo", repo,
      "--entry-file", "src/lib.rs",
      "--entry-symbol", expected.symbol,
      "--max-depth", "2",
      "--scope", "src",
      "--language", "rust",
      "--compact",
    ], tmpdir());
    assert.equal(run.status, 0, `${id} stderr: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.requestedLanguage, "rust", id);
    assert.equal(payload.actualParser, "rust", id);
    assert.equal(payload.unresolvedCallsites.length, expected.reasons.length, `${id} unresolved count`);
    for (const [index, item] of payload.unresolvedCallsites.entries()) {
      assert.equal(item.reasonCode, expected.reasons[index], `${id}[${index}] reasonCode`);
      assert.equal(item.targetSymbolClue, expected.clues[index], `${id}[${index}] targetSymbolClue`);
      assert.equal(item.coverageStatus, expected.coverage[index], `${id}[${index}] coverageStatus`);
      assert.deepEqual(item.missingEvidence, expected.missing[index], `${id}[${index}] missingEvidence`);
      assert.equal(item.moduleSpecifierClue, expected.modules[index], `${id}[${index}] moduleSpecifierClue`);
      assert.equal(item.candidateModulePath, expected.candidates[index], `${id}[${index}] candidateModulePath`);
      if (expected.binding[index] === null) assert.equal(item.bindingDeclarationSpan, null, `${id}[${index}] bindingDeclarationSpan`);
      else assert.ok(item.bindingDeclarationSpan !== null && typeof item.bindingDeclarationSpan.startLine === "number", `${id}[${index}] bindingDeclarationSpan`);
      assert.equal(typeof item.callerId, "string", `${id}[${index}] callerId`);
      assert.equal(typeof item.calleeExpr, "string", `${id}[${index}] calleeExpr`);
      assert.equal(typeof item.callsiteSpan.startLine, "number", `${id}[${index}] callsiteSpan`);
      assert.equal(typeof item.kind, "string", `${id}[${index}] kind`);
    }
  }
});

test("P1-1: public Rust scope keeps an outside resolvable module unresolved", async () => {
  const repo = join(repoRoot, "tests", "fixtures", "rust-calls", "RS_SCOPE_1");
  const run = runBin(["calls",
    "--repo", repo,
    "--entry-file", "src/inner/mod.rs",
    "--entry-symbol", "entry",
    "--max-depth", "2",
    "--scope", "src/inner",
    "--language", "rust",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.actualParser, "rust");
  assert.equal(payload.edges.length, 0, "outside module must not produce an edge");
  assert.equal(payload.unresolvedCallsites.length, 1);
  const item = payload.unresolvedCallsites[0];
  assert.equal(item.reasonCode, "TARGET_OUTSIDE_DECLARED_SCOPE");
  assert.equal(item.calleeExpr, "crate::outer::helper");
  assert.equal(item.coverageStatus, "boundary_not_expanded");
  assert.equal(item.candidateModulePath, "src/outer.rs");
  assert.deepEqual(item.missingEvidence, ["target_outside_declared_scope"]);
});

test("P1-3: --language rs aliases to rust and reports rust parser metadata", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "main.rs"),
    "fn entry() -> i32 { helper() }\n\nfn helper() -> i32 { 1 }\n");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/main.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rs",
    "--compact",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.requestedLanguage, "rust");
  assert.equal(payload.actualParser, "rust");
  assert.equal(payload.coverage.semantic.parser, "rust");
  assert.equal(payload.coverage.languageSupport.requested, "rust");
  assert.equal(payload.coverage.languageSupport.actualParser, "rust");
  assert.equal(payload.edges.length, 1);
  assert.equal(payload.nodes.length, 2);
});

test("P1-3: public Rust CLI stays read-only and never executes repository build code", async t => {
  const root = await makeRepo(t);
  await write(join(root, "src", "lib.rs"),
    "pub fn entry() { helper(); }\nfn helper() {}\n");
  await write(join(root, "Cargo.toml"),
    "[package]\nname = \"readonly-probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  await write(join(root, "build.rs"),
    "use std::fs;\nfn main() { fs::write(\"build-ran.txt\", \"executed\").unwrap(); }\n");
  const shim = join(root, "cargo-shim.sh");
  const marker = join(root, "cargo-ran.txt");
  await write(shim, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`);
  await chmod(shim, 0o755);
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/lib.rs",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--language", "rust",
    "--compact",
  ], tmpdir(), { CARGO: shim, RUSTC: shim });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.actualParser, "rust");
  assert.equal(payload.edges.length, 1);
  await assert.rejects(() => readFile(join(root, "build-ran.txt")), /ENOENT/);
  await assert.rejects(() => readFile(marker), /ENOENT/);
});
