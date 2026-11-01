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

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");

function runBin(args, cwd) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
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
  assert.deepEqual(payload.supportedLanguages, ["typescript", "javascript"]);
  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.edges.length, 1);
  assert.equal(payload.unresolvedCallsites.length, 0);
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath), ["src/entry.ts"]);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.text.scanConditions.needle, "entry");
  assert.equal(payload.coverage.semantic.status, "complete");
  assert.equal(payload.coverage.semantic.parser, "typescript");
});

test("explicit typescript/ts and javascript/js aliases route to the supported parser", async t => {
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
  assert.equal(jsPayload.actualParser, "javascript");
  assert.equal(jsPayload.status, "achieved");
});

test("--language rust over real Rust content returns unknown exit 3 with candidates and no entry_not_found", async t => {
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
  assert.equal(run.status, 3, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unknown");
  assert.equal(payload.resolution, "UNSUPPORTED_LANGUAGE");
  assert.equal(payload.reasonCode, "UNSUPPORTED_LANGUAGE");
  assert.equal(payload.actualParser, null);
  assert.equal(payload.entryNodeId, null);
  assert.equal(payload.entryResolution, null);
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath), ["src/main.rs"]);
  assert.equal(payload.textCandidates[0].line, 1);
  assert.equal(payload.textCandidates[0].matchedNeedle, "entry");
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.semantic.status, "unsupported");
  assert.equal(payload.coverage.semantic.parser, null);
  assert.equal(payload.coverage.languageSupport.requested, "rust");
  assert.equal(payload.coverage.languageSupport.supported, false);
  assert.equal(payload.coverage.languageSupport.actualParser, null);
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

test("unsupported-language candidates cover multiple occurrences across files", async t => {
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
  assert.equal(run.status, 3, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.resolution, "UNSUPPORTED_LANGUAGE");
  assert.deepEqual(payload.textCandidates.map(candidate => candidate.filePath).sort(), ["src/a.rs", "src/b.rs"]);
  assert.equal(payload.coverage.text.status, "complete");
  assert.equal(payload.coverage.text.matchedFiles, 2);
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
  assert.equal(run.status, 3, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(typeof payload.runLogPath, "string");
  const log = JSON.parse(await readFile(payload.runLogPath, "utf8"));
  assert.equal(log.outcome.requestedLanguage, "rust");
  assert.equal(log.outcome.actualParser, null);
  assert.equal(log.outcome.coverage.text.status, "complete");
  assert.equal(log.outcome.coverage.semantic.status, "unsupported");
  assert.ok(log.resultReceipt.textCandidates.length >= 1);
});
