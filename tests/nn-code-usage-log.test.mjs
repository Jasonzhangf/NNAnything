// L1 acceptance for the nn-code usage log: JSONL lifecycle, no-log zero side
// effects, verbose projection, 10 GB capacity accounting, rotation, locking,
// active-run protection, disk failure, oversized event, symlink non-follow,
// and v1 read-only compatibility. Every assertion observes the compiled CLI
// from a non-project cwd or the compiled storage module directly.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");
const logModulePath = join(repoRoot, "dist", "adapters", "cli", "nn-code-usage-log.js");
const SOURCE_BYTES_LIMIT = 1_048_576;

const ENTRY_SOURCE = "export function entry(){ return 1; }\n";
const CALLER_SOURCE = "import { entry } from './entry.js';\nexport function caller(){ return entry(); }\n";

function runBin(args, cwd, env = {}) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function runBinAsync(args, cwd, env = {}) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", chunk => { stdout += chunk; });
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("close", status => resolve({ status, stdout, stderr }));
  });
}

async function makeRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-code-log-test-")));
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

function readJsonl(text) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.filter(line => line.trim().length > 0).map(line => JSON.parse(line));
}

async function listLogs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(entry => entry.name.endsWith(".jsonl")).map(entry => join(dir, entry.name));
}

function baseArgs(root, logDir, overrides = {}) {
  return [
    "calls",
    "--repo", root,
    "--entry-file", overrides.entryFile ?? "src/entry.ts",
    "--entry-symbol", overrides.entrySymbol ?? "entry",
    "--max-depth", String(overrides.maxDepth ?? 0),
    "--scope", overrides.scope ?? "src",
    "--log-dir", logDir,
    ...(overrides.requestId ? ["--request-id", overrides.requestId] : []),
    ...(overrides.noLog ? ["--no-log"] : []),
    ...(overrides.verbose ? ["--verbose"] : []),
  ];
}

test("default success leaves a locatable JSONL with start and finish", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-success-");
  const run = runBin(baseArgs(root, logDir), tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.logging.enabled, true);
  assert.equal(payload.logging.state, "complete");
  assert.equal(payload.logging.runLogPath, payload.runLogPath);
  const events = readJsonl(await readFile(payload.runLogPath, "utf8"));
  assert.equal(events[0].kind, "start");
  assert.equal(events[0].schema, "nnanything.nn-code.usage-log.v2");
  assert.equal(events[0].request.entryFile, "src/entry.ts");
  assert.equal(events[0].semanticContractVersion, "nnanything.recursive-goal.request.v1");
  assert.equal(events[events.length - 1].kind, "finish");
  assert.equal(events[events.length - 1].outcome.status, "achieved");
  assert.equal(events[events.length - 1].resultReceipt.nodes.length, payload.nodes.length);
  events.forEach((event, index) => {
    assert.equal(event.runId, payload.runId);
    assert.equal(event.seq, index);
    assert.equal(typeof event.observedAt, "string");
    assert.equal(typeof event.elapsedMs, "number");
  });
});

test("default semantic failure still leaves a complete JSONL", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-failure-");
  const run = runBin(baseArgs(root, logDir, { entryFile: "src/nope.ts" }), tmpdir());
  assert.equal(run.status, 2, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.logging.state, "complete");
  const events = readJsonl(await readFile(payload.runLogPath, "utf8"));
  assert.equal(events[0].kind, "start");
  assert.equal(events[events.length - 1].kind, "finish");
  assert.equal(events[events.length - 1].outcome.status, "unmet");
  assert.equal(events[events.length - 1].outcome.exitCode, 2);
});

test("mid-run abort leaves start without finish", async t => {
  const root = await makeRepo(t);
  // The child writes start, runs the query, then writes finish within tens of
  // milliseconds, so a coarse poll loses that window and the kill lands after
  // finish. Detect start with a tight poll and kill immediately. If finish
  // slipped in first, retry with a fresh log root and assert the invariant on
  // an attempt where the kill genuinely lands between start and finish.
  let verified = false;
  for (let attempt = 1; attempt <= 6 && !verified; attempt += 1) {
    const logDir = await makeTempDir(t, `usage-abort-${attempt}-`);
    const run = spawn(process.execPath, [
      binPath,
      ...baseArgs(root, logDir),
    ], { cwd: tmpdir(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    run.stdout.on("data", chunk => { stdout += chunk; });
    await new Promise(resolve => run.once("spawn", resolve));
    const closed = new Promise(resolve => run.once("close", resolve));
    let seenStart = false;
    const deadline = Date.now() + 5000;
    while (!seenStart && Date.now() < deadline && run.exitCode === null) {
      const entries = await listLogs(logDir).catch(() => []);
      if (entries.length > 0) {
        const text = await readFile(entries[0], "utf8").catch(() => "");
        seenStart = text.split("\n").some(line => line.includes('"kind":"start"'));
      }
      if (!seenStart) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    run.kill("SIGKILL");
    await closed;
    assert.equal(seenStart, true, "start line must be durable before abort");
    const logs = await listLogs(logDir);
    assert.equal(logs.length, 1, "aborted run keeps exactly one log");
    const events = readJsonl(await readFile(logs[0], "utf8"));
    assert.equal(events[0].kind, "start");
    if (events.some(event => event.kind === "finish")) {
      continue;
    }
    const module = await import(logModulePath);
    const read = await module.readUsageLog(logs[0]);
    assert.equal(read.complete, false);
    assert.equal(read.interrupted, true);
    verified = true;
  }
  assert.equal(verified, true, "abort must land before finish within the retry budget");
});

test("--no-log with an argument error writes no dir and no file", async t => {
  const root = await makeRepo(t);
  const logDir = join(tmpdir(), `usage-nolog-${Date.now()}`);
  await rm(logDir, { recursive: true, force: true });
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--no-log",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /--no-log conflicts/);
  await assert.rejects(() => lstat(logDir), /ENOENT/, "no-log must not create a log dir");

  const diagnosticsPath = join(tmpdir(), `usage-nolog-diag-${Date.now()}.json`);
  const diagnosticsRun = runBin([
    "calls",
    "--repo", root,
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--no-log",
    "--diagnostics-file", diagnosticsPath,
  ], tmpdir());
  assert.equal(diagnosticsRun.status, 1, diagnosticsRun.stderr);
  assert.match(diagnosticsRun.stderr, /--no-log conflicts/);
  await assert.rejects(() => lstat(diagnosticsPath), /ENOENT/, "no-log must not write diagnostics");

  const envDir = join(tmpdir(), `usage-nolog-arg-env-${Date.now()}`);
  await rm(envDir, { recursive: true, force: true });
  const run2 = runBin([
    "calls",
    "--repo", root,
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--no-log",
  ], tmpdir(), { NN_CODE_LOG_DIR: envDir });
  assert.equal(run2.status, 1, run2.stderr);
  assert.match(run2.stderr, /--entry-file is required/);
  const payload = JSON.parse(run2.stderr);
  assert.equal(payload.error.logging.enabled, false);
  assert.equal(payload.error.logging.state, "disabled");
  assert.equal(payload.error.logging.runLogPath, null);
  await assert.rejects(() => lstat(envDir), /ENOENT/, "argument error under --no-log must not touch NN_CODE_LOG_DIR");
});

test("--no-log with env NN_CODE_LOG_DIR still writes nothing", async t => {
  const root = await makeRepo(t);
  const logDir = join(tmpdir(), `usage-nolog-env-${Date.now()}`);
  await rm(logDir, { recursive: true, force: true });
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--no-log",
  ], tmpdir(), { NN_CODE_LOG_DIR: logDir });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.logging.enabled, false);
  assert.equal(payload.logging.state, "disabled");
  assert.equal(payload.logging.runLogPath, null);
  assert.equal(payload.runLogPath, null);
  await assert.rejects(() => lstat(logDir), /ENOENT/, "env log dir must not be created under --no-log");
});

test("--verbose with logging disabled still returns the full JSON graph", async t => {
  const root = await makeRepo(t);
  const logDir = join(tmpdir(), `usage-verbose-${Date.now()}`);
  await rm(logDir, { recursive: true, force: true });
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--no-log",
    "--verbose",
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.logging.state, "disabled");
  assert.equal(payload.status, "achieved");
  assert.equal(typeof payload.coverage, "object");
  assert.equal(payload.coverage.nodesCount, payload.nodes.length);
  assert.equal(Array.isArray(payload.nodes), true);
  await assert.rejects(() => lstat(logDir), /ENOENT/, "verbose must not imply logging");
});

test("custom log dir and env honor the capacity contract", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-capacity-");
  const envDir = await makeTempDir(t, "usage-env-");
  const run = runBin(baseArgs(root, logDir), tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.ok(payload.runLogPath.startsWith(logDir), "custom --log-dir is selected");

  const envArgs = [
    "calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
  ];
  const envRun = runBin(envArgs, tmpdir(), { NN_CODE_LOG_DIR: envDir });
  assert.equal(envRun.status, 0, envRun.stderr);
  const envPayload = JSON.parse(envRun.stdout);
  assert.ok(envPayload.runLogPath.startsWith(envDir), "NN_CODE_LOG_DIR is selected");
  assert.equal(envPayload.logging.state, "complete");
});

test("small capacity rotates oldest completed runs and preserves active runs", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-rotate-");
  const module = await import(logModulePath);
  const start = { request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null };
  const finish = { outcome: { status: "achieved" }, coverage: null, resultReceipt: null, error: null };
  const first = new module.UsageLogRun({ root: logDir, runId: "rot-a" });
  await first.start(start);
  await first.finish(finish);
  const firstInfo = await lstat(first.runLogPath);
  const second = new module.UsageLogRun({
    root: logDir,
    runId: "rot-b",
    capacityBytes: firstInfo.size + 100,
  });
  await second.start(start);
  await second.finish(finish);
  assert.equal(second.status().state, "complete", second.status().reason);
  await assert.rejects(() => readFile(first.runLogPath, "utf8"), /ENOENT/,
    "oldest completed run must be rotated when capacity is exceeded");
  assert.equal(await readFile(second.runLogPath, "utf8").then(() => true).catch(() => false), true,
    "newest run must survive");
});

test("concurrent writers never corrupt logs and surface busy as partial", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-concurrent-");
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    runBinAsync(baseArgs(root, logDir, { requestId: `conc-${index}` }), tmpdir())));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const payloads = results.map(result => JSON.parse(result.stdout));
  const logs = await listLogs(logDir);
  assert.ok(logs.length >= 1, "at least one concurrent run persisted");
  const byRunId = new Map(payloads.map(payload => [payload.runId, payload]));
  for (const path of logs) {
    const events = readJsonl(await readFile(path, "utf8"));
    assert.equal(events[0].kind, "start");
    const runId = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
    const payload = byRunId.get(runId);
    assert.ok(payload, `stdout payload for ${runId} must exist`);
    const hasFinish = events.some(event => event.kind === "finish");
    if (hasFinish) {
      assert.equal(payload.logging.state, "complete");
    } else {
      assert.equal(payload.logging.state, "partial");
      assert.ok(["LOG_STORE_BUSY", "LOG_CAPACITY_EXCEEDED"].includes(payload.logging.reason));
    }
  }
  for (const payload of payloads) {
    if (payload.logging.runLogPath === null) {
      assert.equal(payload.logging.state, "partial");
      assert.ok(["LOG_STORE_BUSY", "LOG_CAPACITY_EXCEEDED"].includes(payload.logging.reason));
    }
  }
});

test("active run marker prevents rotation while owner pid is alive", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-active-");
  // Create a synthetic active marker with the current pid (still alive).
  const markerPath = join(logDir, ".active-synthetic-run");
  await writeFile(markerPath, JSON.stringify({ pid: process.pid, owner: "test", startedAt: new Date().toISOString() }));
  // Force rotation pressure: a small capacity with the marker's log already present.
  const logPath = join(logDir, "synthetic-run.jsonl");
  await writeFile(logPath, JSON.stringify({ schema: "nnanything.nn-code.usage-log.v2", kind: "start", runId: "synthetic-run", seq: 0, observedAt: new Date().toISOString(), elapsedMs: 0 }) + "\n");
  const module = await import(logModulePath);
  const run = new module.UsageLogRun({ root: logDir, runId: "new-run", capacityBytes: 400 });
  await run.start({ request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null });
  await run.finish({ outcome: { status: "failed" }, coverage: null, resultReceipt: null, error: null });
  assert.equal(run.status().state, "partial", "active run must not be rotated");
  assert.equal(run.status().reason, "LOG_CAPACITY_EXCEEDED");
  assert.equal(await readFile(logPath, "utf8").then(() => true).catch(() => false), true,
    "active synthetic run must be protected from rotation");
  await rm(logDir, { recursive: true, force: true });
});

test("live lock reports LOG_STORE_BUSY and dead lock is reclaimed", async t => {
  const logDir = await makeTempDir(t, "usage-lock-");
  const module = await import(logModulePath);
  const lockPath = join(logDir, ".nn-code-usage-log.lock");
  const start = { request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null };
  const finish = { outcome: { status: "achieved" }, coverage: null, error: null };
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    owner: "test",
    acquiredAt: new Date().toISOString(),
  }));
  const blocked = new module.UsageLogRun({ root: logDir, runId: "blocked-run" });
  const blockedStatus = await blocked.start(start);
  assert.equal(blockedStatus.state, "partial");
  assert.equal(blockedStatus.reason, "LOG_STORE_BUSY");
  assert.equal(blockedStatus.runLogPath, null);

  await writeFile(lockPath, JSON.stringify({
    pid: 999999,
    owner: "dead-owner",
    acquiredAt: new Date().toISOString(),
  }));
  const reclaimed = new module.UsageLogRun({ root: logDir, runId: "reclaimed-run" });
  const reclaimedStatus = await reclaimed.start(start);
  assert.equal(reclaimedStatus.state, "partial");
  assert.equal(reclaimedStatus.reason, null);
  assert.ok(reclaimedStatus.runLogPath);
  await reclaimed.finish({ outcome: { status: "achieved" }, coverage: null, resultReceipt: null, error: null });
  assert.equal(reclaimed.status().state, "complete");
  await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
});

test("disk-not-writable reports failed logging without changing query fact", async t => {
  const root = await makeRepo(t);
  const baseDir = await makeTempDir(t, "usage-ro-");
  const logDir = join(baseDir, "sub");
  await mkdir(logDir, { recursive: true });
  await chmod(logDir, 0o500);
  const run = runBin(baseArgs(root, logDir), tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved", "log failure must not change query status");
  assert.equal(payload.logging.state, "failed");
  assert.equal(payload.logging.enabled, true);
  await chmod(logDir, 0o700);
});

test("oversized event marks partial and keeps query result", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-oversize-");
  const module = await import(logModulePath);
  const run = new module.UsageLogRun({ root: logDir, runId: "oversize-run", capacityBytes: 64 });
  const startResult = await run.start({ request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null });
  assert.equal(startResult.state, "partial", startResult.reason);
  assert.equal(startResult.reason, "LOG_CAPACITY_EXCEEDED", "start line alone exceeds capacity 64");
});

test("symlink log files are never followed or deleted during rotation", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-symlink-");
  const outside = await makeTempDir(t, "usage-symlink-out-");
  const targetPath = join(outside, "keep.txt");
  await writeFile(targetPath, "outside target\n");
  const linkPath = join(logDir, "synthetic-run.jsonl");
  await symlink(targetPath, linkPath);
  const module = await import(logModulePath);
  const run = new module.UsageLogRun({ root: logDir, runId: "symlink-new", capacityBytes: 50 });
  await run.start({ request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null });
  assert.equal(run.status().state, "partial");
  assert.equal(run.status().reason, "LOG_CAPACITY_EXCEEDED");
  assert.equal(await readFile(targetPath, "utf8"), "outside target\n",
    "symlink target outside the root must not be deleted");
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true, "symlink must remain");
});

test("capacity rotation skips a symlink even when it is the oldest recyclable entry", async t => {
  const logDir = await makeTempDir(t, "usage-symlink-rotate-");
  const outside = await makeTempDir(t, "usage-symlink-target-");
  let targetDir = outside;
  for (let index = 0; index < 6; index += 1) {
    targetDir = join(targetDir, `part-${"x".repeat(80)}-${index}`);
    await mkdir(targetDir, { recursive: true });
  }
  const targetPath = join(targetDir, "keep.txt");
  await writeFile(targetPath, "outside target\n");
  const linkPath = join(logDir, "oldest-symlink.jsonl");
  await symlink(targetPath, linkPath);
  await new Promise(resolve => setTimeout(resolve, 20));

  const module = await import(logModulePath);
  const start = { request: null, cliVersion: "0", semanticContractVersion: "v", modelRef: null };
  const finish = { outcome: { status: "achieved" }, coverage: null, resultReceipt: null, error: null };
  const real = new module.UsageLogRun({ root: logDir, runId: "real-old" });
  await real.start(start);
  await real.finish(finish);
  const realInfo = await lstat(real.runLogPath);
  const linkInfo = await lstat(linkPath);
  assert.ok(linkInfo.size > 500, `test symlink must be large enough to force rotation (${linkInfo.size})`);

  const next = new module.UsageLogRun({
    root: logDir,
    runId: "new-after-symlink",
    capacityBytes: realInfo.size + 500,
  });
  const started = await next.start(start);
  assert.ok(started.runLogPath, started.reason);
  assert.equal(started.state, "partial");
  await next.finish(finish);
  assert.equal(next.status().state, "complete", next.status().reason);
  assert.equal(await readFile(targetPath, "utf8"), "outside target\n",
    "symlink target must remain");
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true, "symlink must remain");
});

test("v1 run log stays readable for rotation", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-v1-");
  const v1Path = join(logDir, "old-run.json");
  await writeFile(v1Path, JSON.stringify({ schema: "nnanything.nn-code.run-log.v1", runId: "old-run", outcome: { status: "achieved" } }));
  const module = await import(logModulePath);
  const read = await module.readUsageLog(v1Path);
  assert.equal(read.kind, "v1");
  assert.equal(read.complete, true);
  assert.equal(read.interrupted, false);
  assert.equal(await readFile(v1Path, "utf8").then(() => true).catch(() => false), true,
    "v1 log must not be rewritten");
});

test("readUsageLog reports trailing incomplete line without sampling it", async t => {
  const logDir = await makeTempDir(t, "usage-tail-");
  const path = join(logDir, "tail-run.jsonl");
  await writeFile(path, '{"schema":"nnanything.nn-code.usage-log.v2","kind":"start","runId":"r","seq":0}\n{"schema":"nnanything.nn-code.usage-log.v2","kind":"finish","runId":"r","seq":1}\n{"schema":"nnanything.nn-code.usage-log.v2","kind":"finish"');
  const module = await import(logModulePath);
  const read = await module.readUsageLog(path);
  assert.equal(read.complete, true);
  assert.equal(read.trailingIncompleteLine, true);
  assert.equal(read.events[read.events.length - 1].kind, "finish");
});

test("installed-version query from non-project cwd against real repo works", async t => {
  const realRepo = await realpath(repoRoot);
  const run = runBin([
    "calls",
    "--repo", realRepo,
    "--entry-file", "lib/cli-call-depth.ts",
    "--entry-symbol", "runCliCalleeCallGraphGoal",
    "--max-depth", "0",
    "--scope", "lib",
    "--no-log",
  ], "/tmp");
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.logging.state, "disabled");
  assert.equal(payload.runLogPath, null);
});

test("default failure with bad arg writes complete log only when no-log absent", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "usage-argfail-");
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 1, run.stderr);
  const logs = await listLogs(logDir);
  assert.equal(logs.length, 1, "argument failure with logging on still writes a run log");
  const events = readJsonl(await readFile(logs[0], "utf8"));
  assert.equal(events[0].kind, "start");
  assert.equal(events[events.length - 1].kind, "finish");
});

test("successful relation events include source, node, and resolved edge facts", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-relations-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"),
    "export function helper(){ return 1; }\nexport function entry(){ return helper(); }\n");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const logDir = await makeTempDir(t, "usage-relations-log-");
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  const events = readJsonl(await readFile(payload.runLogPath, "utf8"));
  const source = events.find(event => event.kind === "source_observed");
  assert.ok(source);
  assert.equal(source.file, "src/entry.ts");
  assert.equal(source.readRange.startByte, 0);
  assert.equal(source.readRange.complete, true);
  assert.equal(source.beforeStat.size > 0, true);
  assert.equal(source.readRange.endByte, source.beforeStat.size);
  assert.ok(source.beforeStat.dev !== undefined, "source_observed must retain file dev identity");
  assert.ok(source.beforeStat.ino !== undefined, "source_observed must retain file ino identity");
  assert.equal(source.afterStat, null);
  assert.equal(source.afterStatStatus, "not_observed");
  assert.equal("hash" in source, false);
  assert.ok(events.find(event => event.kind === "node_expanded"));
  const edge = events.find(event => event.kind === "relation_resolved");
  assert.ok(edge, "resolved helper() edge must be recorded");
  assert.equal(edge.callerId, payload.entryNodeId);
  assert.equal(typeof edge.calleeId, "string");
  assert.equal(edge.callsiteSpan.startLine, 2);
});

test("real CLI truncated source logs a partial source_observed without parsing", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-truncated-source-")));
  await mkdir(join(root, "src"), { recursive: true });
  const sourceSize = SOURCE_BYTES_LIMIT + 512;
  await writeFile(join(root, "src", "entry.ts"), Buffer.alloc(sourceSize, 0x78));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const logDir = await makeTempDir(t, "usage-truncated-source-log-");
  const run = runBin(baseArgs(root, logDir), tmpdir());
  assert.equal(run.status, 3, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unknown");
  assert.equal(payload.truncated, true);
  const events = readJsonl(await readFile(payload.runLogPath, "utf8"));
  const sources = events.filter(event => event.kind === "source_observed");
  assert.equal(sources.length, 1, "truncated source must be projected exactly once");
  const source = sources[0];
  assert.equal(source.file, "src/entry.ts");
  assert.equal(source.readRange.startByte, 0);
  assert.equal(source.readRange.endByte, SOURCE_BYTES_LIMIT);
  assert.equal(source.readRange.complete, false);
  assert.equal(source.beforeStat.size, sourceSize);
  assert.equal(typeof source.beforeStat.dev, "number");
  assert.equal(typeof source.beforeStat.ino, "number");
  assert.equal(source.afterStat, null);
  assert.equal(source.afterStatStatus, "not_observed");
  assert.equal(source.unchangedAtClosure, false);
  assert.equal(source.truncated, true);
  const finish = events[events.length - 1];
  assert.equal(finish.kind, "finish");
  assert.equal(finish.outcome.truncated, true);
  assert.equal(events.filter(event => event.kind === "node_expanded").length, 0);
});

test("source_observed marks an incomplete read from actual bytes instead of claiming file size", async t => {
  const module = await import(logModulePath);
  const result = {
    finalState: {
      truncated: true,
      files: [],
      partialSources: [{
        relPath: "src/truncated.ts",
        dev: 11,
        ino: 22,
        size: 20,
        bytesRead: 5,
        complete: false,
        truncated: true,
      }],
    },
    nodes: [],
    edges: [],
    unresolvedCallsites: [],
  };
  const events = module.projectCallDepthUsageEvents({
    result,
    repoRoot: "/repo",
    reserveExcerptBytes: () => 0,
  });
  const source = events.find(event => event.kind === "source_observed");
  assert.ok(source);
  assert.equal(source.body.readRange.startByte, 0);
  assert.equal(source.body.readRange.endByte, 5);
  assert.equal(source.body.readRange.complete, false);
  assert.equal(source.body.beforeStat.size, 20);
  assert.equal(source.body.beforeStat.dev, 11);
  assert.equal(source.body.beforeStat.ino, 22);
  assert.equal(source.body.afterStat, null);
  assert.equal(source.body.afterStatStatus, "not_observed");
  assert.equal(source.body.truncated, true);
});

test("relation_unknown records the UnknownFact shape with reviewState unreviewed", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-unknown-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"),
    "export function entry(fn: () => number){ return fn(); }\n");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const logDir = await makeTempDir(t, "usage-unknown-log-");
  const run = runBin([
    "calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "1",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.ok(payload.unresolvedCallsites.length >= 1);
  const events = readJsonl(await readFile(payload.runLogPath, "utf8"));
  const unknown = events.find(event => event.kind === "relation_unknown");
  assert.ok(unknown, "dynamic parameter call must be recorded as relation_unknown");
  assert.equal(unknown.reviewState, "unreviewed");
  assert.equal(typeof unknown.unknownId, "string");
  assert.equal(typeof unknown.callerNodeId, "string");
  assert.equal(unknown.calleeExpression, "fn");
  assert.equal(unknown.reasonCode, "LEXICAL_PARAM_OR_VARIABLE_CALL");
  assert.ok(unknown.coverageImpact === "target_unknown" || unknown.coverageImpact === "scope_limited");
  assert.equal(unknown.sourceExcerpt.complete, true);
  assert.equal(unknown.sourceExcerpt.file, "src/entry.ts");
  assert.ok(unknown.sourceExcerpt.text.includes("fn"));
  const bytes = Buffer.byteLength(unknown.sourceExcerpt.text, "utf8");
  assert.ok(bytes <= 16 * 1024);
});

test("source excerpt budget caps at 16 KiB per unknown and 1 MiB per run", async t => {
  const logDir = await makeTempDir(t, "usage-budget-");
  const module = await import(logModulePath);
  const run = new module.UsageLogRun({ root: logDir, runId: "budget-run" });
  for (let index = 0; index < 64; index += 1) {
    assert.equal(run.reserveExcerptBytes(16 * 1024), 16 * 1024);
  }
  assert.equal(run.reserveExcerptBytes(1), 0, "per-run source excerpt budget is 1 MiB");
  assert.equal(run.reserveExcerptBytes(32 * 1024), 0, "exhausted budget returns zero");
});

