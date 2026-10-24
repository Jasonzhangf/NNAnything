// Four real trajectories driven by the single public entry
// `runCliReadExpectationGoal`, which runs the existing recursive-goal
// controller. Every recorded model decision is checked against the independent
// oracle's allowed set; a prediction outside it stops the chain and fails this
// script. A zeroed reasoning profile must also fail this same script.
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

function withTransientOnce(sandbox) {
  let armed = true;
  return {
    ...sandbox,
    async execute(call) {
      if (armed && call?.parameters?.offset !== undefined && call?.parameters?.offset === 0) {
        armed = false;
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
  const result = await runCliReadExpectationGoal(
    { requestId: name, requirement, path: "file.txt" },
    { ...options, unit, context, request: requirement, path: "file.txt" },
  );
  return result;
}

const cases = [];

// 1. Segmented read: a harness I/O cap forces several reads; the model asks for
//    the remaining data, and the root is satisfied only by real coverage.
{
  const w = await world("segmented", "0123456789abcdefghij");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await run("segmented-remaining", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0 });
  await w.close();
  cases.push({ name: "segmented-remaining", result, expect: { satisfied: true, stopReason: "root_evaluation", minDecisions: 2, lastPrediction: "need_remaining_data" } });
}

// 2. Legal transient recovery: one controlled transient error, a controller-owned
//    bounded retry, then a real success followed by one model decision.
{
  const w = await world("retry-ok", "012345678");
  const requirement = { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 };
  const result = await run("transient-retry", requirement, { sandbox: withTransientOnce(w.sandbox), session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 1 });
  await w.close();
  cases.push({ name: "transient-retry", result, expect: { satisfied: true, stopReason: "root_evaluation", minDecisions: 1 } });
}

// 3. Real denial: EACCES is terminal. The run must stop without claiming the root,
//    and it must not repeat the denied read.
{
  const w = await world("denied", "abcdefgh", 0o000);
  const requirement = { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 };
  const result = await run("denied-stop", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0 });
  await w.close();
  cases.push({ name: "denied-stop", result, expect: { satisfied: false, outcome: "error", reads: 1 } });
}

// 4. Budget cuts in after a read and before the root is evaluated.
{
  const w = await world("budget", "0123456789");
  const requirement = { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 };
  const result = await run("budget-truncation", requirement, { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, maxReadBytes: 3, retryBudget: 0, limits: { maxTransitions: 7, maxDepth: 5, maxDerivedGoals: 12 } });
  await w.close();
  cases.push({ name: "budget-truncation", result, expect: { satisfied: false, stopReason: "budget", reads: 1 } });
}

const report = cases.map(entry => {
  const result = entry.result;
  // P1-1: every real model decision must fall inside the independent oracle's
  // allowed set.
  for (const decision of result.decisions) {
    assert.ok(decision.allowed.includes(decision.prediction),
      `${entry.name}: model predicted ${decision.prediction} outside oracle allowed [${decision.allowed.join(", ")}]`);
    assert.equal(decision.legal, true, `${entry.name}: adapter recorded an illegal decision`);
  }
  const s = summary(result);
  const expect = entry.expect;
  assert.equal(s.satisfied, expect.satisfied, `${entry.name}: unexpected root result ${JSON.stringify(s)}`);
  if (expect.stopReason !== undefined) assert.equal(s.stopReason, expect.stopReason, `${entry.name}: stop ${s.stopReason} != ${expect.stopReason}`);
  if (expect.outcome !== undefined) assert.equal(s.outcome, expect.outcome, `${entry.name}: outcome ${s.outcome} != ${expect.outcome}`);
  if (expect.reads !== undefined) assert.equal(result.finalState?.reads ?? 0, expect.reads, `${entry.name}: reads ${result.finalState?.reads} != ${expect.reads}`);
  if (expect.minDecisions !== undefined) assert.ok(result.decisions.length >= expect.minDecisions, `${entry.name}: expected >=${expect.minDecisions} decisions, got ${result.decisions.length}`);
  if (expect.lastPrediction !== undefined) assert.equal(result.decisions.at(-1)?.prediction, expect.lastPrediction, `${entry.name}: last prediction`);
  return {
    name: entry.name,
    expectations: result.decisions.map(d => d.prediction),
    allowed: result.decisions.map(d => d.allowed),
    reads: result.finalState === null ? 0 : result.finalState.reads,
    coverage: result.finalState === null ? [] : result.finalState.coverage,
    ...s,
  };
});

// Sensitivity control: the same script, run with a zeroed reasoning profile, must
// be caught (an out-of-allowed decision) and must not succeed.
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
    { sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit: broken, context, request: requirement, path: "file.txt", maxReadBytes: 3, retryBudget: 0 },
  );
  await w.close();
  await rm(brokenDir, { recursive: true, force: true });
  const illegal = result.decisions.filter(d => !d.allowed.includes(d.prediction));
  const caught = illegal.length > 0 || summary(result).satisfied === false;
  assert.ok(caught, "a zeroed reasoning profile must be caught by this verification");
  report.push({ name: "control-zeroed-profile", caught, illegalPredictions: illegal.map(d => d.prediction) });
}

console.log(JSON.stringify({ trajectories: report }, null, 2));
