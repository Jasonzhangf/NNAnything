// Gate 1 black-box regression for the read-only live repository sandbox and the
// installed `nn-call-depth` CLI wrapper. Every assertion observes a public
// entry: either the `nnanything/cli-call-depth` module or the compiled
// `dist/cli-call-depth-bin.js` process. Lossless cleanup is proved only on a
// controlled temp directory; the real repository is never snapshotted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const binPath = join(repoRoot, "dist", "cli-call-depth-bin.js");
const api = () => import("nnanything/cli-call-depth");

const ENTRY_SOURCE = "export function entry(){ return 1; }\n";
const SENTINEL = "ignored-sentinel-content\n";

async function makeRepo(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cd1-live-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"), ENTRY_SOURCE);
  await writeFile(join(root, ".ignored-sentinel"), SENTINEL);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function snapshot(root) {
  return {
    entry: await readFile(join(root, "src", "entry.ts"), "utf8"),
    sentinel: await readFile(join(root, ".ignored-sentinel"), "utf8"),
    entryStat: await lstat(join(root, "src", "entry.ts")),
    sentinelStat: await lstat(join(root, ".ignored-sentinel")),
  };
}

function assertUnchanged(before, after) {
  assert.equal(after.entry, before.entry);
  assert.equal(after.sentinel, before.sentinel);
  assert.equal(after.entryStat.ino, before.entryStat.ino);
  assert.equal(after.sentinelStat.ino, before.sentinelStat.ino);
}

function runBin(args, cwd) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function liveGoal(entryFile, entrySymbol, maxDepth, scopePaths) {
  return {
    kind: "cli.programming.callee_call_graph",
    entryFile,
    entrySymbol,
    maxDepth,
    direction: "callee",
    scopePaths,
    satisfactionThreshold: 1.0,
  };
}

test("read-only sandbox mounts a live repo and cleanup is non-destructive", async t => {
  const root = await makeRepo(t);
  const before = await snapshot(root);
  const module = await api();
  const sandbox = await module.createReadOnlyCliFilesystemSandbox({ root });
  const session = sandbox.bindSession(module.DEFAULT_READ_ONLY_SESSION_ID);
  const result = await module.runCliCalleeCallGraphGoal(
    { requestId: "live-mount", rootGoal: liveGoal("src/entry.ts", "entry", 0, ["src"]) },
    { sandbox, session },
  );
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.equal(result.nodes.length, 1);
  const cleanup = await sandbox.cleanup();
  assert.deepEqual(cleanup, { removed: false, scenarioRoot: sandbox.scenarioRoot });
  assertUnchanged(before, await snapshot(root));
  await assert.rejects(
    () => sandbox.bindFile(session, "src/entry.ts"),
    /Filesystem sandbox is closed/,
  );
});

test("read-only sandbox denies cwd.set and directory.list at the permission boundary", async t => {
  const root = await makeRepo(t);
  const module = await api();
  const sandbox = await module.createReadOnlyCliFilesystemSandbox({ root });
  const session = sandbox.bindSession(module.DEFAULT_READ_ONLY_SESSION_ID);
  const directory = await sandbox.bindDirectory(session, ".");
  const setReceipt = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory } });
  assert.equal(setReceipt.execution.status, "failed");
  assert.equal(setReceipt.execution.error?.code, "EFFECT_DENIED");
  const listReceipt = await sandbox.execute({ operation: "directory.list", parameters: { session, directory } });
  assert.equal(listReceipt.execution.status, "failed");
  assert.equal(listReceipt.execution.error?.code, "EFFECT_DENIED");
  await sandbox.cleanup();
});

test("compiled CLI runs from a non-project cwd for maxDepth 0 and 1", async t => {
  const root = await makeRepo(t);
  const before = await snapshot(root);
  for (const depth of [0, 1]) {
    const run = runBin([
      "--repo", root,
      "--entry-file", "src/entry.ts",
      "--entry-symbol", "entry",
      "--max-depth", String(depth),
      "--scope", "src",
    ], tmpdir());
    assert.equal(run.status, 0, `max-depth ${depth} exits 0; stderr: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "achieved");
    assert.equal(payload.requestedMaxDepth, depth);
    assert.equal("finalState" in payload, false, "stdout never dumps finalState");
    assert.equal("response" in payload, false, "stdout never dumps response");
    if (depth === 0) {
      assert.equal(payload.achievedDepth, 0);
      assert.equal(payload.nodes.length, 1);
      assert.equal(payload.nodes[0].bodyExtracted, false);
      assert.equal(payload.edges.length, 0);
      assert.equal(payload.truncated, false);
    }
  }
  assertUnchanged(before, await snapshot(root));
});

test("CLI reports the contract exit codes without touching the repo", async t => {
  const root = await makeRepo(t);
  const before = await snapshot(root);

  let run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
  ], tmpdir());
  assert.equal(run.status, 1, "missing --scope exits 1");

  run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "",
  ], tmpdir());
  assert.equal(run.status, 1, "empty --scope exits 1");

  run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "9",
    "--scope", "src",
  ], tmpdir());
  assert.equal(run.status, 1, "invalid --max-depth exits 1");
  assert.match(run.stderr, /rootGoal\.maxDepth must be 0, 1, 2, or 3/);

  run = runBin([
    "--repo", join(root, "missing-repo"),
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
  ], tmpdir());
  assert.equal(run.status, 1, "missing --repo exits 1");
  assert.match(run.stderr, /ENOENT/);

  run = runBin([
    "--repo", root,
    "--entry-file", "src/nope.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
  ], tmpdir());
  assert.equal(run.status, 2, "missing --entry-file exits 2");
  assert.equal(JSON.parse(run.stdout).status, "unmet");

  run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "other",
  ], tmpdir());
  assert.equal(run.status, 4, "out-of-scope --entry-file exits 4");
  assert.equal(JSON.parse(run.stdout).status, "rejected");

  assertUnchanged(before, await snapshot(root));
});

test("diagnostics file refuses the target root and symlink escape", async t => {
  const root = await makeRepo(t);
  const before = await snapshot(root);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "nn-cd1-diag-")));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  let run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--diagnostics-file", join(root, "diag.json"),
  ], tmpdir());
  assert.equal(run.status, 1, "diagnostics inside the target root is refused");

  const notePath = join(root, "note.md");
  await writeFile(notePath, "keep\n");
  const escapePath = join(outside, "diag.json");
  await symlink(notePath, escapePath);
  run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--diagnostics-file", escapePath,
  ], tmpdir());
  assert.equal(run.status, 1, "diagnostics symlink escape is refused");
  assert.equal(await readFile(notePath, "utf8"), "keep\n", "symlink target is untouched");

  const cleanPath = join(outside, "clean.json");
  run = runBin([
    "--repo", root,
    "--entry-file", "src/entry.ts",
    "--entry-symbol", "entry",
    "--max-depth", "0",
    "--scope", "src",
    "--diagnostics-file", cleanPath,
  ], tmpdir());
  assert.equal(run.status, 0);
  const diagnostics = JSON.parse(await readFile(cleanPath, "utf8"));
  assert.equal(typeof diagnostics.finalState, "object");
  assert.equal(typeof diagnostics.response, "object");

  assertUnchanged(before, await snapshot(root));
});
