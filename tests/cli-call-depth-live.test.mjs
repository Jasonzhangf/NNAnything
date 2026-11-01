// Gate A1 black-box regression for the `nn-code calls` CLI entry, the user-level
// run log, and the target-repository write protection. Every assertion observes
// the compiled `dist/cli-call-depth-bin.js` process from a non-project cwd.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const cliVersion = pkg.version;

const ENTRY_SOURCE = "export function entry(){ return 1; }\n";

function runBin(args, cwd) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

async function makeRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-code-calls-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"), ENTRY_SOURCE);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function makeTempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function readJsonlText(text) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.filter(line => line.trim().length > 0).map(line => JSON.parse(line));
}

test("nn-code calls --help emits same-source help and writes no run log", async t => {
  const logDir = await makeTempDir(t, "nn-code-help-log-");
  const run = runBin(["calls", "--help", "--log-dir", logDir], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Usage:\n  nn-code calls --repo/);
  assert.match(run.stdout, /--repo <path>/);
  assert.match(run.stdout, /--entry-file <repoRelativePath>/);
  assert.match(run.stdout, /--entry-symbol <symbol>/);
  assert.match(run.stdout, /--max-depth <0\|1\|2\|3>/);
  assert.match(run.stdout, /--scope <prefix>/);
  assert.match(run.stdout, /Exit Codes/);
  assert.match(run.stdout, /~\/\.local\/state\/nn-code\/runs/);
  assert.match(run.stdout, /~\/\.agents\/skills\/nn-code\/SKILL\.md/);
  assert.match(run.stdout, /Examples:/);
  assert.ok(run.stdout.includes(`nn-code v${cliVersion}`), `help must include nn-code v${cliVersion}`);
  const entries = await readdir(logDir);
  assert.equal(entries.length, 0, "help must not write a run log");
});

test("nn-code calls writes an external run log and echoes runLogPath", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-log-");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.cliVersion, cliVersion);
  assert.equal(typeof payload.runId, "string");
  const logPath = join(logDir, `${payload.runId}.jsonl`);
  assert.equal(payload.runLogPath, logPath);
  assert.equal(payload.logging.enabled, true);
  assert.equal(payload.logging.state, "complete");
  assert.equal(payload.logging.runLogPath, logPath);
  assert.equal(payload.logging.reason, null);
  assert.equal(payload.status, "achieved");
  assert.equal("finalState" in payload, false, "stdout never dumps finalState");
  assert.equal("response" in payload, false, "stdout never dumps response");

  const logText = await readFile(logPath, "utf8");
  assert.equal(logText.includes("sourceText"), false, "run log must not save sourceText");
  assert.equal(logText.includes("initialBytesBase64"), false, "run log must not save initialBytesBase64");
  const events = readJsonlText(logText);
  assert.equal(events[0].schema, "nnanything.nn-code.usage-log.v2");
  assert.equal(events[0].kind, "start");
  assert.equal(events[0].cliVersion, cliVersion);
  assert.equal(events[0].runId, payload.runId);
  assert.equal(events[0].request.entryFile, "src/entry.ts");
  assert.equal(events[events.length - 1].kind, "finish");
  assert.equal(events[events.length - 1].outcome.status, "achieved");
  assert.equal(events[events.length - 1].outcome.exitCode, 0);
  assert.equal(events.filter(event => event.kind === "node_expanded").length, payload.nodes.length);
  events.forEach((event, index) => assert.equal(event.seq, index));
});

test("successful query with a live usage log lock reports partial and stderr", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-busy-log-");
  await writeFile(join(logDir, ".nn-code-usage-log.lock"), JSON.stringify({
    pid: process.pid,
    owner: "test",
    acquiredAt: new Date().toISOString(),
  }));
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.logging.state, "partial");
  assert.equal(payload.logging.reason, "LOG_STORE_BUSY");
  assert.equal(payload.logWriteError.stage, "log_write");
  assert.match(run.stderr, /"stage":"log_write"/);
  assert.match(run.stderr, /LOG_STORE_BUSY/);
});

test("--log-dir inside --repo is refused before mkdir with exit code unchanged", async t => {
  const root = await makeRepo(t);
  const inside = join(root, "new-logs");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", inside,
  ], tmpdir());
  assert.equal(run.status, 0, `expected query success, stderr: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.runLogPath, null);
  assert.equal(payload.logging.enabled, true);
  assert.equal(payload.logging.state, "failed");
  assert.equal(payload.logging.reason, "SANDBOX_ESCAPE");
  assert.equal(payload.logWriteError.stage, "log_write");
  assert.match(run.stderr, /"stage":"log_write"/);
  await assert.rejects(() => lstat(inside), /ENOENT/, "in-repo log dir must not be created");

  const outside = await makeTempDir(t, "nn-code-outside-");
  const link = join(outside, "repo-src-link");
  await symlink(join(root, "src"), link);
  const run2 = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", join(link, "logs"),
  ], tmpdir());
  assert.equal(run2.status, 0, run2.stderr);
  const payload2 = JSON.parse(run2.stdout);
  assert.equal(payload2.runLogPath, null);
  assert.equal(payload2.logging.state, "failed");
  assert.equal(payload2.logging.reason, "SANDBOX_ESCAPE");
  assert.equal(payload2.logWriteError.stage, "log_write");
  await assert.rejects(() => lstat(join(root, "src", "logs")), /ENOENT/, "symlinked in-repo log dir must not be created");
  assert.equal(await readFile(join(root, "src", "entry.ts"), "utf8"), ENTRY_SOURCE);
});

test("args failure, duplicate --repo and unresolved protection root never write into the repo", async t => {
  const root = await makeRepo(t);
  const inside = join(root, "bad-logs");

  let run = runBin(["calls",
    "--repo", root,
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", inside,
  ], tmpdir());
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /--entry-file is required/);
  assert.match(run.stderr, /"stage":"log_write"/);
  await assert.rejects(() => lstat(inside), /ENOENT/, "args failure must not create the in-repo log dir");

  run = runBin(["calls",
    "--repo", root,
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", join(tmpdir(), "nn-code-dup-log"),
  ], tmpdir());
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /duplicate --repo argument is not allowed/);

  const loop = join(root, "repo-loop");
  await symlink("repo-loop", loop);
  run = runBin(["calls",
    "--repo", loop,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", join(root, "init-bad-logs"),
  ], tmpdir());
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /"stage":"log_write"/);
  await assert.rejects(() => lstat(join(root, "init-bad-logs")), /ENOENT/, "init failure must not create the in-repo log dir");
});

test("semantic non-zero exits 2 and 4 still write complete run logs", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-nonzero-log-");

  let run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/nope.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 2, run.stderr);
  let payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unmet");
  assert.equal(payload.runLogPath, join(logDir, `${payload.runId}.jsonl`));
  assert.equal(payload.logging.state, "complete");
  let events = readJsonlText(await readFile(payload.runLogPath, "utf8"));
  assert.equal(events[0].schema, "nnanything.nn-code.usage-log.v2");
  assert.equal(events[events.length - 1].kind, "finish");
  assert.equal(events[events.length - 1].outcome.exitCode, 2);
  assert.equal(events[events.length - 1].outcome.status, "unmet");

  run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "other",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 4, run.stderr);
  payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "rejected");
  assert.equal(payload.runLogPath, join(logDir, `${payload.runId}.jsonl`));
  assert.equal(payload.logging.state, "complete");
  events = readJsonlText(await readFile(payload.runLogPath, "utf8"));
  assert.equal(events[0].schema, "nnanything.nn-code.usage-log.v2");
  assert.equal(events[events.length - 1].kind, "finish");
  assert.equal(events[events.length - 1].outcome.exitCode, 4);
  assert.equal(events[events.length - 1].outcome.status, "rejected");
});
