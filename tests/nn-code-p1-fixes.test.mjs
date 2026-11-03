// P1 regression observed through the compiled CLI: scope path normalization,
// new-expression and tagged-template call recording, and concurrent usage-log
// serialization. Each case drives dist/cli-call-depth-bin.js as a real process.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");
const ENTRY_SOURCE = "export function entry(){ return 1; }\n";

function runBin(args, cwd) {
  const proc = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function runBinAsync(args, cwd) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [binPath, ...args], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", chunk => { stdout += chunk; });
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("close", status => resolve({ status, stdout, stderr }));
  });
}

async function makeRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-code-p1-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"), ENTRY_SOURCE);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function makeTempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test("scope dot, dot-slash prefix, and trailing slash resolve an in-repo entry", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-scope-");
  for (const scope of [".", "./src", "src/"]) {
    const run = runBin(["calls",
      "--repo", root,
      "--entry-file", "src/entry.ts",
      "--entry-symbol", "entry",
      "--max-depth", "0",
      "--scope", scope,
      "--log-dir", logDir,
    ], tmpdir());
    assert.equal(run.status, 0, `scope ${scope}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "achieved", `scope ${scope} must resolve`);
    assert.equal(typeof payload.entryNodeId, "string", `scope ${scope} entry node`);
  }
});

test("entry-file leading dot-slash normalizes like its scope", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-entrydot-");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "./src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(typeof payload.entryNodeId, "string");
});

test("entry-file parent segments and absolute paths stay rejected", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-entryreject-");
  for (const entryFile of ["src/../src/entry.ts", "../entry.ts"]) {
    const run = runBin(["calls",
      "--repo", root,
      "--entry-file", entryFile,
      "--entry-symbol", "entry",
      "--max-depth", "0",
      "--scope", "src",
      "--log-dir", logDir,
    ], tmpdir());
    assert.equal(run.status, 4, `${entryFile}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "rejected", `${entryFile} must stay rejected`);
  }
});

test("new expression and tagged template are recorded instead of silently dropped", async t => {
  const root = await makeRepo(t);
  await writeFile(join(root, "src", "forms.ts"), [
    "class Helper { constructor() {} }",
    "function tag(s: TemplateStringsArray): string { return s[0]!; }",
    "export function direct(): void {",
    "  new Helper();",
    "  tag`hi`;",
    "}",
    "",
  ].join("\n"));
  const logDir = await makeTempDir(t, "nn-code-forms-");
  const run = runBin(["calls",
    "--repo", root,
    "--entry-file", "src/forms.ts",
    "--entry-symbol", "direct",
    "--max-depth", "2",
    "--scope", "src",
    "--verbose",
    "--log-dir", logDir,
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  const calleeIds = payload.edges.map(edge => edge.calleeId);
  assert.ok(calleeIds.some(id => id.includes("#tag@")), `tagged template edge: ${JSON.stringify(calleeIds)}`);
  const unresolved = payload.unresolvedCallsites.map(call => call.calleeExpr);
  assert.ok(unresolved.includes("Helper"), `new expression classified: ${JSON.stringify(payload.unresolvedCallsites)}`);
  assert.ok(payload.edges.length + payload.unresolvedCallsites.length >= 2,
    "neither new expression nor tagged template may be silently dropped");
});

test("concurrent writers each persist a complete usage log", async t => {
  const root = await makeRepo(t);
  const logDir = await makeTempDir(t, "nn-code-concurrent-");
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => runBinAsync(["calls",
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--request-id", `conc-${index}`,
    "--log-dir", logDir,
  ], tmpdir())));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const payloads = results.map(result => JSON.parse(result.stdout));
  const logs = (await readdir(logDir, { withFileTypes: true })).filter(entry => entry.name.endsWith(".jsonl"));
  assert.equal(logs.length, payloads.length, "every concurrent run must persist its own log");
  for (const payload of payloads) {
    assert.notEqual(payload.logging.runLogPath, null, `run ${payload.runId} must persist`);
    assert.equal(payload.logging.state, "complete", `run ${payload.runId} logging state`);
    const events = (await readFile(payload.logging.runLogPath, "utf8")).split("\n")
      .filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    assert.equal(events[0].kind, "start");
    assert.equal(events[events.length - 1].kind, "finish");
  }
});
