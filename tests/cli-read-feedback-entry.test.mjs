// Black-box tests for the single public entry `runCliReadExpectationGoal`.
// Two contracts are pinned here, both at the entry boundary:
//  - the request argument is the only source of the requested meaning, so
//    execution resources and foreign file references cannot lower or retarget it;
//  - the requested quantity is really read: an exact-8 request covers 8 real
//    bytes, and a 3-byte resource-level request cannot stand in for it.
// The `baseline` policy avoids the learned units, so this file needs no profile.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCliReadExpectationGoal } from "nnanything/cli-read-feedback";

const context = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

// The baseline policy never asks a unit, so a stub is enough here. It must not
// be reachable: if it is, this file stops testing the entry boundary.
const stubUnit = Object.freeze({
  inferBase() {
    throw new Error("baseline policy must not infer a base label");
  },
  inferReasoning() {
    throw new Error("baseline policy must not infer a reasoning label");
  },
});

async function world(t, name, contents) {
  const { createCliFilesystemSandbox } = await import("nnanything/cli-read");
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-entry-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
    recipe: {
      scenarioId: name,
      entries: [{ path: "file.txt", kind: "file", contents }],
      sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  const session = sandbox.bindSession("session");
  const fileRef = await sandbox.bindFile(session, "file.txt");
  let executions = 0;
  return {
    session,
    fileRef,
    executes: () => executions,
    sandbox: {
      ...sandbox,
      async execute(call) {
        executions += 1;
        return sandbox.execute(call);
      },
    },
  };
}

const exact = (quantity, offset = 0) => ({ shape: "head", mode: "exact", quantity, offset, length: quantity });
const bytesReturned = result => (result.finalState?.attempts ?? [])
  .reduce((total, attempt) => total + (attempt.observation?.bytesRead ?? 0), 0);

test("a resource-level request cannot replace the request argument", async t => {
  const w = await world(t, "entry-conflict", "0123456789");
  await assert.rejects(
    runCliReadExpectationGoal(
      { requestId: "conflict-1", requirement: exact(8), path: "file.txt" },
      { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit: stubUnit, context, request: exact(3), maxReadBytes: 8 },
    ),
    /must not carry request/,
  );
  await assert.rejects(
    runCliReadExpectationGoal(
      { requestId: "conflict-2", requirement: exact(8), path: "file.txt" },
      { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit: stubUnit, context, path: "file.txt", maxReadBytes: 8 },
    ),
    /must not carry path/,
  );
  assert.equal(w.executes(), 0, "a conflicting request must be rejected before any read");
});

test("a file reference from another target is refused for this request", async t => {
  const requested = await world(t, "entry-requested", "abcdefgh");
  const foreign = await world(t, "entry-foreign", "ZZZZZZZZ");
  await assert.rejects(
    runCliReadExpectationGoal(
      { requestId: "binding-1", requirement: exact(4), path: "file.txt" },
      { sandbox: requested.sandbox, session: requested.session, fileRef: foreign.fileRef, unit: stubUnit, context, maxReadBytes: 4 },
    ),
    /does not correspond to the requested path and session/,
  );
  assert.equal(requested.executes(), 0, "a foreign reference must be rejected before any read");
});

test("with no profiles the entry still reads the requested quantity, not less", async t => {
  const w = await world(t, "entry-exact8", "0123456789");
  const result = await runCliReadExpectationGoal(
    { requestId: "exact8-1", requirement: exact(8), path: "file.txt" },
    { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit: stubUnit, context, maxReadBytes: 3, policy: "baseline" },
  );
  const root = result.response.kind === "run_result" ? result.response.report.rootEvaluation ?? null : null;
  assert.equal(root === null ? null : root.result, "satisfied");
  assert.equal(bytesReturned(result), 8, "the root must be satisfied by 8 real bytes, never by 3");
  assert.deepEqual((result.finalState?.coverage ?? []).map(pair => [...pair]), [[0, 8]]);
  assert.ok((result.finalState?.reads ?? 0) > 1, "the harness cap must force more than one read");
});
