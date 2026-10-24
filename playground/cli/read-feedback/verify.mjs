// Real trajectories driven by the single public entry
// `runCliReadExpectationGoal`, which runs the existing recursive-goal
// controller. Every recorded model decision is checked against the independent
// oracle's allowed set; a prediction outside it stops the chain and fails this
// script. A zeroed reasoning profile must also fail this same script.
//
// Two behaviours are pinned here:
//  - the model consumes the real error feedback: a transient error records
//    `retry_current_read` and the controller's typed retry runs a real repeat,
//    while a terminal error records `terminal_error` and never repeats;
//  - the public request is the only source of the requested meaning, so neither
//    execution resources nor a foreign file reference can lower or retarget it.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReadFeedbackUnit, runCliReadExpectationGoal,
} from "nnanything/cli-read-feedback";
import { createCliFilesystemSandbox } from "nnanything/cli-read";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";

const unit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "base-profile.json"),
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});

const context = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

async function world(name, contents, mode = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-verify-")));
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
  if (mode !== null) await chmod(join(root, name, "file.txt"), mode);
  return {
    sandbox, session, fileRef,
    close: async () => { await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); },
  };
}

/** Counts real executions so a rejection can be shown to run nothing. */
function counted(sandbox) {
  let executions = 0;
  return {
    count: () => executions,
    sandbox: {
      ...sandbox,
      async execute(call) {
        executions += 1;
        return sandbox.execute(call);
      },
    },
  };
}

/** A controlled transient error on the first `times` executes. */
function withTransient(sandbox, times) {
  let left = times;
  return {
    ...sandbox,
    async execute(call) {
      if (left > 0 && call?.parameters?.offset !== undefined) {
        left -= 1;
        return {
          status: "failed",
          execution: {
            status: "failed", executorInvoked: true,
            error: { stage: "observe", code: "EINTR", message: "controlled transient interruption" },
          },
        };
      }
      return sandbox.execute(call);
    },
  };
}

function summary(result) {
  const response = result.response;
  if (response.kind !== "run_result") {
    return { kind: response.kind, satisfied: false, stopReason: null, outcome: null, rootResult: null };
  }
  const control = response.report.control;
  const root = response.report.rootEvaluation ?? null;
  return {
    kind: response.kind,
    satisfied: root !== null && root.state === "evaluated" && root.result === "satisfied",
    rootResult: root === null ? null : root.result,
    stopReason: control === null ? null : control.stopReason,
    outcome: control === null ? null : control.outcome,
  };
}

async function run(name, requirement, options) {
  return runCliReadExpectationGoal(
    { requestId: name, requirement, path: "file.txt" },
    { ...options, unit, context },
  );
}

const cases = [];

// 1. Segmented read: a harness I/O cap forces several reads; the model asks for
//    the remaining data, and the root is satisfied only by real coverage.
{
  const w = await world("segmented", "0123456789abcdefghij");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await run("segmented-remaining", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0 });
  await w.close();
  cases.push({ name: "segmented-remaining", result, expect: { satisfied: true, stopReason: "root_evaluation", minDecisions: 2, includes: ["need_remaining_data"] } });
}

// 2. The public request is executed as written: an exact 8-byte request on a
//    10-byte file covers exactly 8 real bytes, never fewer.
{
  const w = await world("exact8", "0123456789");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await run("exact8-request", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 8, retryBudget: 0 });
  await w.close();
  cases.push({ name: "exact8-request", result, expect: { satisfied: true, stopReason: "root_evaluation", reads: 1, bytesReturned: 8, coverage: [[0, 8]] } });
}

// 3. Legal transient recovery: one controlled EINTR. The model must record
//    `retry_current_read` at the error-feedback boundary; only then does the
//    controller's typed retry run a real repeat, and that repeat succeeds.
{
  const w = await world("retry-ok", "012345678");
  const requirement = { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 };
  const result = await run("transient-retry", requirement, { sandbox: withTransient(w.sandbox, 1), session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 1 });
  await w.close();
  cases.push({ name: "transient-retry", result, expect: { satisfied: true, stopReason: "root_evaluation", reads: 3, includes: ["retry_current_read"] } });
}

// 4. Real denial: EACCES is terminal. The model must record `terminal_error` and
//    the run must stop without claiming the root or repeating the denied read.
{
  const w = await world("denied", "abcdefgh", 0o000);
  const requirement = { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 };
  const result = await run("denied-stop", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0 });
  await w.close();
  cases.push({ name: "denied-stop", result, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } });
}

// 5. A terminal error is not retried even when a retry budget exists.
{
  const w = await world("denied-budget", "abcdefgh", 0o000);
  const requirement = { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 };
  const result = await run("denied-with-budget", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 1 });
  await w.close();
  cases.push({ name: "denied-with-budget", result, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } });
}

// 6. Exhausted retries: the first transient error records a retry, the repeat
//    fails again, and with no budget left the model records `terminal_error`.
//    It must never claim budget forever from a positive declared budget.
{
  const w = await world("retry-exhausted", "012345678");
  const requirement = { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 };
  const result = await run("transient-exhausted", requirement, { sandbox: withTransient(w.sandbox, 2), session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 1 });
  await w.close();
  cases.push({ name: "transient-exhausted", result, expect: { satisfied: false, outcome: "error", reads: 2, predictions: ["retry_current_read", "terminal_error"] } });
}

// 7. No retry budget at all: the same transient error is recorded as terminal.
{
  const w = await world("retry-nobudget", "012345678");
  const requirement = { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 };
  const result = await run("transient-no-budget", requirement, { sandbox: withTransient(w.sandbox, 1), session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0 });
  await w.close();
  cases.push({ name: "transient-no-budget", result, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } });
}

// 8. Budget cuts in after a read and before the root is evaluated.
{
  const w = await world("budget", "0123456789");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await run("budget-truncation", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0, limits: { maxTransitions: 7, maxDepth: 5, maxDerivedGoals: 12 } });
  await w.close();
  cases.push({ name: "budget-truncation", result, expect: { satisfied: false, stopReason: "budget", reads: 1 } });
}

const bytesReturned = result => (result.finalState?.attempts ?? [])
  .reduce((total, attempt) => total + (attempt.observation?.bytesRead ?? 0), 0);

const report = cases.map(entry => {
  const result = entry.result;
  // Every real model decision must fall inside the independent oracle's allowed
  // set, and the adapter must have marked it legal.
  for (const decision of result.decisions) {
    assert.ok(decision.allowed.includes(decision.prediction),
      `${entry.name}: model predicted ${decision.prediction} outside oracle allowed [${decision.allowed.join(", ")}]`);
    assert.equal(decision.legal, true, `${entry.name}: adapter recorded an illegal decision`);
  }
  const s = summary(result);
  const expect = entry.expect;
  const predictions = result.decisions.map(decision => decision.prediction);
  assert.equal(s.satisfied, expect.satisfied, `${entry.name}: unexpected root result ${JSON.stringify(s)}`);
  if (expect.stopReason !== undefined) assert.equal(s.stopReason, expect.stopReason, `${entry.name}: stop ${s.stopReason} != ${expect.stopReason}`);
  if (expect.outcome !== undefined) assert.equal(s.outcome, expect.outcome, `${entry.name}: outcome ${s.outcome} != ${expect.outcome}`);
  if (expect.reads !== undefined) assert.equal(result.finalState?.reads ?? 0, expect.reads, `${entry.name}: reads ${result.finalState?.reads} != ${expect.reads}`);
  if (expect.minDecisions !== undefined) assert.ok(result.decisions.length >= expect.minDecisions, `${entry.name}: expected >=${expect.minDecisions} decisions, got ${result.decisions.length}`);
  if (expect.predictions !== undefined) assert.deepEqual(predictions, expect.predictions, `${entry.name}: decisions`);
  if (expect.includes !== undefined) {
    for (const label of expect.includes) {
      assert.ok(predictions.includes(label), `${entry.name}: no ${label} decision in [${predictions.join(", ")}]`);
    }
  }
  if (expect.bytesReturned !== undefined) assert.equal(bytesReturned(result), expect.bytesReturned, `${entry.name}: real bytes`);
  if (expect.coverage !== undefined) assert.deepEqual((result.finalState?.coverage ?? []).map(pair => [...pair]), expect.coverage, `${entry.name}: coverage`);
  return {
    name: entry.name,
    predictions,
    allowed: result.decisions.map(decision => decision.allowed),
    reads: result.finalState === null ? 0 : result.finalState.reads,
    bytesReturned: bytesReturned(result),
    coverage: (result.finalState?.coverage ?? []).map(pair => [...pair]),
    ...s,
  };
});

// Red test: the request meaning is not allowed to travel a second time through
// execution resources. The same trusted 10-byte file, an exact-8 request, and a
// resource-level exact-3 request must be rejected before any read runs.
{
  const w = await world("conflict", "0123456789");
  const counter = counted(w.sandbox);
  const request = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const lowered = { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 };
  let rejected = null;
  try {
    await runCliReadExpectationGoal(
      { requestId: "conflict-1", requirement: request, path: "file.txt" },
      { sandbox: counter.sandbox, session: w.session, fileRef: w.fileRef, unit, context, request: lowered, path: "file.txt", maxReadBytes: 8 },
    );
  } catch (error) {
    rejected = error;
  }
  await w.close();
  assert.ok(rejected instanceof TypeError, "a resource-level requirement must not replace the request");
  assert.equal(counter.count(), 0, "the conflicting request must be rejected before any read");
  report.push({ name: "conflict-request-8-vs-3", rejected: rejected.message, executions: counter.count() });
}

// Red test: the same file name in a different target must not be read with this
// request's reference. Both worlds hold file.txt; only one is the requested one.
{
  const requested = await world("binding-requested", "abcdefgh");
  const foreign = await world("binding-foreign", "zzzzzzzz");
  const counter = counted(requested.sandbox);
  const request = { shape: "head", mode: "exact", quantity: 4, offset: 0, length: 4 };
  let rejected = null;
  let borrowed = null;
  try {
    await runCliReadExpectationGoal(
      { requestId: "binding-1", requirement: request, path: "file.txt" },
      { sandbox: counter.sandbox, session: requested.session, fileRef: foreign.fileRef, unit, context, maxReadBytes: 4 },
    );
  } catch (error) {
    rejected = error;
  }
  const executionsBeforeAccept = counter.count();
  try {
    const result = await runCliReadExpectationGoal(
      { requestId: "binding-2", requirement: request, path: "file.txt" },
      { sandbox: counter.sandbox, session: requested.session, fileRef: requested.fileRef, unit, context, maxReadBytes: 4 },
    );
    borrowed = bytesReturned(result);
  } finally {
    await requested.close();
    await foreign.close();
  }
  assert.ok(rejected instanceof TypeError, "a foreign file reference must not be accepted for this request");
  assert.equal(executionsBeforeAccept, 0, "the foreign reference must be rejected before any read");
  assert.equal(borrowed, 4, "the requested target itself must read its own 4 bytes");
  report.push({ name: "binding-foreign-ref", rejected: rejected.message, executionsBeforeReject: executionsBeforeAccept, requestedTargetBytes: borrowed });
}

// Red test: a zeroed reasoning profile must be caught by this same script: it
// predicts an out-of-allowed label and the chain stops without the root.
{
  const brokenDir = await mkdtemp(join(tmpdir(), "nn-read-broken-"));
  const base = JSON.parse(await readFile(join(outDir, "base-profile.json"), "utf8"));
  const reasoning = JSON.parse(await readFile(join(outDir, "reasoning-profile.json"), "utf8"));
  reasoning.weights = reasoning.weights.map(row => row.map(() => 0));
  await writeFile(join(brokenDir, "base-profile.json"), JSON.stringify(base));
  await writeFile(join(brokenDir, "reasoning-profile.json"), JSON.stringify(reasoning));
  const broken = await readReadFeedbackUnit({
    handwiredRoot,
    baseProfilePath: join(brokenDir, "base-profile.json"),
    reasoningProfilePath: join(brokenDir, "reasoning-profile.json"),
  });
  const w = await world("broken", "0123456789");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await runCliReadExpectationGoal(
    { requestId: "control-1", requirement, path: "file.txt" },
    { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit: broken, context, maxReadBytes: 3, retryBudget: 0 },
  );
  await w.close();
  await rm(brokenDir, { recursive: true, force: true });
  const illegal = result.decisions.filter(decision => !decision.allowed.includes(decision.prediction));
  const caught = illegal.length > 0 || summary(result).satisfied === false;
  assert.ok(caught, "a zeroed reasoning profile must be caught by this verification");
  report.push({ name: "control-zeroed-profile", caught, illegalPredictions: illegal.map(decision => decision.prediction) });
}

console.log(JSON.stringify({ trajectories: report }, null, 2));
