import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = () => import("../dist/cli-goal.js");

test("sandbox rejects lexical session cwd escape before creating a scenario", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  await assert.rejects(createCliFilesystemSandbox({ root: ownerRoot, ownerGrantedEffects: ["filesystem.write"],
    recipe: { scenarioId: "session-escape", entries: [], sessions: [
      { id: "outside", cwd: "../outside", grantedEffects: ["filesystem.read", "process.exec"] },
    ] },
  }), TypeError);
});

test("cwd symlink replaced outside scenario is refused before native pwd", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t), outside = await root(t);
  const sandbox = await createCliFilesystemSandbox({ root: ownerRoot, ownerGrantedEffects: ["filesystem.write"],
    recipe: { scenarioId: "cwd-link-escape", entries: [{ path: "inside", kind: "directory" }], sessions: [
      { id: "a", cwd: "inside", grantedEffects: ["filesystem.read", "process.exec"] },
    ] },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("a"), before = sandbox.getSession(session);
  await rm(before.cwd, { recursive: true });
  await symlink(outside, before.cwd);
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.error.code, "SANDBOX_ESCAPE");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.deepEqual(sandbox.getSession(session), before);
});

async function root(t) {
  const value = await mkdtemp(join(tmpdir(), "nnanything-cwd-sandbox-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("sandbox issues typed refs, returns snapshots and cleans only its scenario", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "typed-refs",
      entries: [
        { path: "alpha with space", kind: "directory" },
        { path: "alpha with space/child", kind: "directory" },
        { path: "beta", kind: "directory" },
        { path: "beta/keep.txt", kind: "file", contents: "keep" },
      ],
      sessions: [
        { id: "a", cwd: "alpha with space", grantedEffects: ["filesystem.read", "process.exec"] },
        { id: "b", cwd: "beta", grantedEffects: ["filesystem.read", "process.exec"] },
      ],
    },
  });
  const a = sandbox.bindSession("a");
  const b = sandbox.bindSession("b");
  assert.notDeepEqual(a, b);
  assert.throws(() => sandbox.bindSession("missing"), /session/i);
  const snapshot = sandbox.getSession(a);
  assert.equal(snapshot.id, "a");
  assert.equal(snapshot.cwd, join(sandbox.scenarioRoot, "alpha with space"));
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.grantedEffects.includes("filesystem.read"), true);
  assert.throws(() => snapshot.grantedEffects.push("process.exec"), TypeError);
  assert.deepEqual(sandbox.getSession(a).grantedEffects, ["filesystem.read", "process.exec"]);

  const directory = await sandbox.bindDirectory(a, "child");
  assert.equal(directory.kind, "cli.directory");
  assert.equal(directory.sessionId, "a");
  assert.equal(directory.path, "child");
  const resolved = await sandbox.resolveDirectory(directory);
  assert.equal(resolved.configuredPath, join(sandbox.scenarioRoot, "alpha with space", "child"));
  assert.equal(resolved.physicalPath, await realpath(join(sandbox.scenarioRoot, "alpha with space", "child")));
  const sibling = await sandbox.bindDirectory(a, "../beta");
  assert.equal((await sandbox.resolveDirectory(sibling)).physicalPath, await realpath(join(sandbox.scenarioRoot, "beta")));
  await assert.rejects(sandbox.bindDirectory(a, "../../outside"), /outside|escape|root/i);
  await assert.rejects(sandbox.bindDirectory(a, "/tmp"), TypeError);
  assert.equal(await readFile(join(sandbox.scenarioRoot, "beta", "keep.txt"), "utf8"), "keep");

  const result = await sandbox.cleanup();
  assert.equal(result.removed, true);
  assert.throws(() => sandbox.getSession(a), /clean|closed|scenario/i);
});

test("sandbox rejects an escaping symlink target and missing owner write grant", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  const outside = join(ownerRoot, "outside");
  await symlink(outside, join(ownerRoot, "escape-link")).catch(() => {});
  await assert.rejects(createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: [],
    recipe: { scenarioId: "no-write", entries: [], sessions: [] },
  }), /filesystem.write|grant/i);

  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "physical-bound",
      entries: [{ path: "inside", kind: "directory" }],
      sessions: [{ id: "inside", cwd: "inside", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
  });
  t.after(() => sandbox.cleanup());
  await symlink(outside, join(sandbox.scenarioRoot, "escape-link")).catch(() => {});
  const ref = sandbox.bindSession("inside");
  await assert.rejects(sandbox.bindDirectory(ref, "../../outside"), /outside|escape|root/i);
});

test("cwd.get is the only semantic call, uses real pwd and rejects extra argv or foreign refs", async t => {
  const { createCliFilesystemSandbox, executeSemanticCliCall } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "cwd-get",
      entries: [
        { path: "one", kind: "directory" },
        { path: "two", kind: "directory" },
      ],
      sessions: [
        { id: "one", cwd: "one", grantedEffects: ["filesystem.read", "process.exec"] },
        { id: "none", cwd: "two", grantedEffects: [] },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const one = sandbox.bindSession("one");
  const none = sandbox.bindSession("none");
  const parentCwd = process.cwd();
  const before = sandbox.getSession(one);
  const call = { operation: "cwd.get", parameters: { session: one } };
  const receipt = await executeSemanticCliCall(sandbox, call);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.status, "succeeded");
  assert.equal(receipt.execution.executorInvoked, true);
  assert.equal(receipt.execution.observation.executable, "/bin/pwd");
  assert.deepEqual(receipt.execution.observation.argv, ["-P"]);
  assert.equal(receipt.execution.observation.physicalCwd, await realpath(join(sandbox.scenarioRoot, "one")));
  assert.deepEqual(receipt.session_before, before);
  assert.deepEqual(receipt.session_after, before);
  assert.equal(process.cwd(), parentCwd);

  const denied = await executeSemanticCliCall(sandbox, { operation: "cwd.get", parameters: { session: none } });
  assert.equal(denied.status, "failed");
  assert.equal(denied.execution.error.code, "EFFECT_DENIED");
  assert.equal(denied.execution.executorInvoked, true);

  for (const bad of [
    null,
    { operation: "cd", parameters: { session: one } },
    { operation: "cwd.get", parameters: {} },
    { operation: "cwd.get", parameters: { session: one, directory: one } },
    { operation: "cwd.get", parameters: { session: { ...one, scenarioId: "foreign" } } },
    { operation: "cwd.get", parameters: { session: one }, argv: ["/bin/pwd"] },
  ]) {
    await assert.rejects(executeSemanticCliCall(sandbox, bad), TypeError);
  }
});

test("missing cwd and missing grants are distinct native/authorization failures", async t => {
  const { createCliFilesystemSandbox, executeSemanticCliCall } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "failures",
      entries: [{ path: "present", kind: "directory" }],
      sessions: [
        { id: "present", cwd: "present", grantedEffects: ["filesystem.read", "process.exec"] },
        { id: "missing", cwd: "missing", grantedEffects: ["filesystem.read", "process.exec"] },
        { id: "denied", cwd: "present", grantedEffects: [] },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const missing = await executeSemanticCliCall(sandbox, {
    operation: "cwd.get",
    parameters: { session: sandbox.bindSession("missing") },
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.execution.error.stage, "observe");
  assert.match(missing.execution.error.code, /ENOENT|ENOTDIR/);
  const denied = await executeSemanticCliCall(sandbox, {
    operation: "cwd.get",
    parameters: { session: sandbox.bindSession("denied") },
  });
  assert.equal(denied.status, "failed");
  assert.equal(denied.execution.error.stage, "authorize");
  assert.equal(denied.execution.error.code, "EFFECT_DENIED");
});
