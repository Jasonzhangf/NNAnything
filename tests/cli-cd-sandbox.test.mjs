import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = () => import("../dist/cli-goal.js");

async function root(t) {
  const value = await mkdtemp(join(tmpdir(), "nnanything-cd-sandbox-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

function recipe() {
  return {
    scenarioId: "cd-sandbox",
    entries: [
      { path: "start", kind: "directory" },
      { path: "start/child", kind: "directory" },
      { path: "start/sibling", kind: "directory" },
      { path: "start/plain.txt", kind: "file", contents: "plain\n" },
      { path: "other", kind: "directory" },
    ],
    sessions: [
      { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] },
      { id: "other", cwd: "other", grantedEffects: ["filesystem.read", "process.exec", "session.write"] },
      { id: "no-exec", cwd: "start", grantedEffects: ["filesystem.read", "session.write"] },
      { id: "no-write", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
    ],
  };
}

test("cwd.set uses the fixed zsh argv, commits S, and leaves other session and parent cwd unchanged", async t => {
  const { createCliFilesystemSandbox, executeSemanticCliCall } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    recipe: recipe(),
    ownerGrantedEffects: ["filesystem.write"],
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const other = sandbox.bindSession("other");
  const directory = await sandbox.bindDirectory(session, "child");
  const before = sandbox.getSession(session);
  const otherBefore = sandbox.getSession(other);
  const parentCwd = process.cwd();

  const receipt = await executeSemanticCliCall(sandbox, {
    operation: "cwd.set",
    parameters: { session, directory },
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.status, "succeeded");
  assert.equal(receipt.execution.executorInvoked, true);
  assert.equal(receipt.execution.observation.kind, "cwd.set");
  assert.equal(receipt.execution.observation.executable, "/bin/zsh");
  assert.deepEqual(receipt.execution.observation.argv, [
    "-f",
    "-c",
    'builtin cd -- "$1" && /bin/pwd -P',
    "nnanything-cd",
    "child",
  ]);
  assert.equal(receipt.execution.observation.requestedPath, "child");
  assert.equal(receipt.session_before.revision, before.revision);
  assert.equal(receipt.session_after.revision, before.revision + 1);
  assert.equal(receipt.session_after.cwd, await realpath(join(sandbox.scenarioRoot, "start", "child")));
  assert.deepEqual(sandbox.getSession(other), otherBefore);
  assert.equal(process.cwd(), parentCwd);

  const observed = await executeSemanticCliCall(sandbox, { operation: "cwd.get", parameters: { session } });
  assert.equal(observed.status, "succeeded");
  assert.equal(observed.execution.status, "succeeded");
  assert.equal(observed.execution.observation.physicalCwd, receipt.session_after.cwd);
});

test("cwd.set rejects extra fields, unsafe resources, final links and missing grants without state changes", async t => {
  const { createCliFilesystemSandbox, executeSemanticCliCall } = await api();
  const ownerRoot = await root(t);
  const outside = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    recipe: recipe(),
    ownerGrantedEffects: ["filesystem.write"],
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const before = sandbox.getSession(session);

  for (const bad of [
    { operation: "cwd.set", parameters: { session } },
    { operation: "cwd.set", parameters: { session, directory: await sandbox.bindDirectory(session, "child") }, argv: [] },
    { operation: "cwd.set", parameters: { session, directory: await sandbox.bindDirectory(session, "child") }, options: { shell: false } },
  ]) {
    await assert.rejects(executeSemanticCliCall(sandbox, bad), TypeError);
  }

  const forged = path => ({ kind: "cli.directory", scenarioId: sandbox.scenarioId, sessionId: "s", path });
  for (const [directory, code] of [
    [{ kind: "cli.directory", scenarioId: "foreign", sessionId: "s", path: "child" }, "EINVAL"],
    [forged("../../outside"), "SANDBOX_ESCAPE"],
    [forged("missing"), "ENOENT"],
    [forged("plain.txt"), "NOT_DIRECTORY"],
  ]) {
    const receipt = await executeSemanticCliCall(sandbox, { operation: "cwd.set", parameters: { session, directory } });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.execution.status, "failed");
    assert.equal(receipt.execution.executorInvoked, false);
    assert.equal(receipt.execution.error.code, code);
    assert.deepEqual(receipt.session_after, before);
  }

  await symlink(join(sandbox.scenarioRoot, "start", "child"), join(sandbox.scenarioRoot, "start", "inside-link"));
  const finalLink = await sandbox.bindDirectory(session, "inside-link");
  const linked = await executeSemanticCliCall(sandbox, { operation: "cwd.set", parameters: { session, directory: finalLink } });
  assert.equal(linked.status, "failed");
  assert.equal(linked.execution.error.code, "FINAL_SYMLINK");
  assert.equal(linked.execution.executorInvoked, false);
  assert.deepEqual(linked.session_after, before);

  await symlink(outside, join(sandbox.scenarioRoot, "start", "outside-link"));
  await assert.rejects(sandbox.bindDirectory(session, "outside-link"), /escape|outside|root/i);

  const child = await sandbox.bindDirectory(session, "child");
  for (const id of ["no-exec", "no-write"]) {
    const deniedSession = sandbox.bindSession(id);
    const denial = await executeSemanticCliCall(sandbox, {
      operation: "cwd.set",
      parameters: { session: deniedSession, directory: { ...child, sessionId: id } },
    });
    assert.equal(denial.status, "failed");
    assert.equal(denial.execution.error.code, "EFFECT_DENIED");
    assert.equal(denial.execution.executorInvoked, false);
    assert.deepEqual(denial.session_after, sandbox.getSession(deniedSession));
  }
});
