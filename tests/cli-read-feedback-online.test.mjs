// Black-box tests for the CLI read-feedback online loop.
//
// These tests cover the stages 2-4 contract: usage sampling provenance, sourced
// supervision without hidden-content leakage, isolated post-use fitting and a
// new-process reload, three-arm held-out evaluation, cache/shortcut negative
// controls, post-use non-regression on the M1 verify trajectories, and the
// "not applied / gitignored output only" rule. Tests that need a real
// Handwired backend are asset-gated on NN_HANDWIRED_ROOT.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASE_WIRES,
  REASONING_WIRES,
  buildCases,
  prepareSamples,
  fitReadFeedbackProfile,
  loadReadProfile,
  measureBase,
  measureReasoning,
  mergeCoverage,
  readReadFeedbackUnit,
  runCliReadExpectationGoal,
  superviseBase,
  superviseReasoning,
} from "nnanything/cli-read-feedback";
import { createCliFilesystemSandbox } from "nnanything/cli-read";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
const assetGated = { skip: !handwiredRoot && "provide explicit NN_HANDWIRED_ROOT" };
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, "playground", "cli", "read-feedback", "out");

const CONTEXT = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

const req = (shape, mode, quantity, offset = 0, length = quantity) => ({
  shape, mode, quantity, offset, length,
});
const obs = (offset, length, size, bytesRead, bytes = "") => ({
  offset, length, size, bytes, bytesRead, eof: bytesRead < length, dev: 1, ino: 1,
});
const attempt = (request, observation, failure = null, priorCoverage = []) => ({
  request, observation, failure, priorCoverage,
});

async function postUnit() {
  return readReadFeedbackUnit({
    handwiredRoot,
    baseProfilePath: join(outDir, "post", "base-profile.json"),
    reasoningProfilePath: join(outDir, "post", "reasoning-profile.json"),
  });
}

async function world(name, contents, mode = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-online-test-")));
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

function withTransient(sandbox, times) {
  let left = times;
  return {
    ...sandbox,
    async execute(call) {
      if (left > 0 && call?.operation === "file.read") {
        left -= 1;
        return {
          status: "failed",
          execution: {
            status: "failed",
            executorInvoked: true,
            error: { stage: "observe", code: "EINTR", message: "controlled transient interruption" },
          },
        };
      }
      return sandbox.execute(call);
    },
  };
}

function runSummary(result) {
  const response = result.response;
  if (response.kind !== "run_result") {
    return { kind: response.kind, satisfied: false, stopReason: null, outcome: null, rootResult: null };
  }
  const root = response.report.rootEvaluation ?? null;
  const control = response.report.control ?? null;
  return {
    kind: response.kind,
    satisfied: root !== null && root.state === "evaluated" && root.result === "satisfied",
    rootResult: root === null ? null : root.result,
    stopReason: control === null ? null : control.stopReason,
    outcome: control === null ? null : control.outcome,
  };
}

const bytesReturned = result => (result.finalState?.attempts ?? [])
  .reduce((total, record) => total + (record.observation?.bytesRead ?? 0), 0);

test("model inputs and supervision depend only on measured receipt facts, never on hidden content", () => {
  const hiddenA = "QZXHIDDENAAA";
  const hiddenB = "QZXHIDDENBBB";
  const baseA = attempt(req("head", "exact", 8, 0, 8), obs(0, 8, 20, 3, hiddenA));
  const baseB = attempt(req("head", "exact", 8, 0, 8), obs(0, 8, 20, 3, hiddenB));
  assert.deepEqual(measureBase(baseA), measureBase(baseB));
  assert.deepEqual(superviseBase(baseA), superviseBase(baseB));

  const ctxA = { ...CONTEXT, skills: [...CONTEXT.skills] };
  const ctxB = { ...CONTEXT, skills: [...CONTEXT.skills] };
  const prediction = {
    data_obtained: 1,
    end_observed: 0,
    incomplete_observation: 1,
    execution_error: 0,
    target_changed: 0,
    observation_unknown: 0,
  };
  assert.deepEqual(measureReasoning(prediction, baseA, ctxA), measureReasoning(prediction, baseB, ctxB));
  assert.deepEqual(superviseReasoning(baseA, ctxA).allowed, superviseReasoning(baseB, ctxB).allowed);

  const baseGold = superviseBase(baseA);
  assert.equal(baseGold.label.data_obtained, 1);
  assert.equal(baseGold.label.incomplete_observation, 1);
  assert.equal(baseGold.label.end_observed, 0);
  assert.deepEqual([...superviseReasoning(baseA, ctxA).allowed], ["need_remaining_data"]);

  for (const vector of [measureBase(baseA), measureReasoning(prediction, baseA, ctxA)]) {
    assert.equal(JSON.stringify(vector).includes(hiddenA), false);
    assert.equal(JSON.stringify(vector).includes(hiddenB), false);
    for (const value of Object.values(vector)) assert.ok(value === 0 || value === 1);
  }
});

test("usage sample t0 and receipts are request-only, real, and recompute the recorded vectors", async () => {
  const samples = JSON.parse(await readFile(join(outDir, "usage-samples.json"), "utf8"));
  assert.equal(samples.schema, "nnanything.cli-read-feedback.usage-samples.v1");
  assert.ok(Array.isArray(samples.runs) && samples.runs.length > 0);

  for (const run of samples.runs) {
    assert.equal(run.policy, "learned");
    assert.equal(run.source.entry, "runCliReadExpectationGoal");
    assert.equal(run.source.receipt, "finalState.attempts");
    assert.deepEqual(Object.keys(run.t0).sort(), ["path", "requestId", "requirement"]);
    assert.deepEqual(Object.keys(run.t0.requirement).sort(), ["length", "mode", "offset", "quantity", "shape"]);
    assert.equal(JSON.stringify(run.t0).includes(run.task.contentMarker), false, "t0 must not include hidden content");
    for (const record of run.attempts) {
      assert.equal(record.receiptSource, "finalState.attempts");
      assert.ok(record.status === "succeeded" || record.status === "failed");
      if (record.status === "succeeded") {
        assert.ok(record.observation && typeof record.observation.bytes === "string");
      } else {
        assert.ok(record.failure && typeof record.failure.code === "string");
      }
    }
  }

  const run = samples.runs.find(item => item.decisions.length > 0);
  assert.ok(run, "usage-samples.json must contain at least one run with a decision");
  const prior = [];
  const attemptById = new Map();
  for (const record of run.attempts) {
    const built = attempt(
      run.task.request,
      record.observation,
      record.failure,
      mergeCoverage([...prior]),
    );
    attemptById.set(record.attemptId, built);
    prior.push(...record.coverage);
  }
  for (const decision of run.decisions) {
    const built = attemptById.get(decision.attemptId);
    assert.ok(built, `${decision.attemptId}: decision has a receipt`);
    assert.deepEqual(measureBase(built), decision.baseVector, "recorded base vector must recompute from the receipt");
    assert.deepEqual(
      measureReasoning(decision.basePrediction, built, decision.context),
      decision.reasoningVector,
      "recorded reasoning vector must recompute from receipt + recorded context",
    );
    assert.deepEqual(superviseReasoning(built, decision.context).allowed, decision.allowed, "recorded allowed set must be the oracle's");
    assert.deepEqual(
      Object.keys(decision.baseVector).sort(),
      [...BASE_WIRES].sort(),
      "base vector must use the declared base wires",
    );
    assert.deepEqual(
      Object.keys(decision.reasoningVector).sort(),
      [...REASONING_WIRES].sort(),
      "reasoning vector must use the declared reasoning wires",
    );
    for (const vector of [decision.baseVector, decision.reasoningVector]) {
      assert.equal(JSON.stringify(vector).includes(run.task.contentMarker), false, "model input must not include hidden content");
      for (const value of Object.values(vector)) assert.ok(value === 0 || value === 1);
    }
  }
});

test("post-use profiles fit from samples only, reload in a fresh process, and stay unapplied", assetGated, async () => {
  const stdout = execFileSync(
    process.execPath,
    ["playground/cli/read-feedback/post-reload.mjs"],
    { cwd: repoRoot, env: { ...process.env, NN_HANDWIRED_ROOT: handwiredRoot }, encoding: "utf8" },
  );
  const reload = JSON.parse(stdout);
  assert.equal(reload.schema, "nnanything.cli-read-feedback.post-reload-report.v1");
  assert.equal(reload.applied, false);
  assert.ok(reload.verification.attempts > 0);
  assert.ok(reload.verification.decisions > 0);
  assert.equal(reload.process.sameProcessShortcut, false);

  const training = JSON.parse(await readFile(join(outDir, "post", "training-report.json"), "utf8"));
  assert.equal(training.schema, "nnanything.cli-read-feedback.post-training-report.v1");
  assert.equal(training.applied, false);
  const sources = training.sources.map(source => source.split("/").pop()).sort();
  assert.deepEqual(sources, ["pretrain-samples.json", "usage-samples.json"],
    "the continued fit must mix pretraining replay with new usage supervision");
  assert.deepEqual(
    training.isolation.warmStartInputs.map(path => path.split("/").pop()).sort(),
    ["base-profile.json", "reasoning-profile.json"],
    "the continued fit must warm-start from the captured initial profiles",
  );
  assert.equal(training.isolation.wroteWarmStartInputs, false);
  assert.deepEqual(training.isolation.wroteOnlyUnder.map(path => path.split("/").pop()).sort(), ["post", "post-zero"]);
  assert.deepEqual(training.fitOrder, ["base", "reasoning"]);
  assert.equal(training.initialization.weights, "initial_profile");
  assert.equal(training.initialization.reasoningInput, "current_candidate_base_infer_output");
  assert.equal(training.trainingPolicy.executesReads, false, "the fitting entry must not execute reads");
  assert.equal(training.trainingPolicy.replayIllegalActions, false);
  assert.match(training.zeroStartDiagnostic.note, /diagnostic control/);

  // Epoch 0 must reproduce the captured initial candidate before any gradient
  // step, and the continuation must really move weights.
  assert.equal(training.initialization.epochZero.base.allEqual, true);
  assert.equal(training.initialization.epochZero.reasoning.allEqual, true);
  assert.ok(training.update.base.changedWeights > 0, "the continued base fit must change weights");
  assert.ok(training.update.reasoning.changedWeights > 0, "the continued reasoning fit must change weights");
  assert.equal(training.pretrainingReplay.partition, "train", "only the pretraining train partition may be replayed");

  for (const name of ["base-profile.json", "reasoning-profile.json"]) {
    const path = join(outDir, "post", name);
    const profile = JSON.parse(await readFile(path, "utf8"));
    assert.equal(profile.kind, name === "base-profile.json" ? "base" : "reasoning");
    assert.equal(Object.hasOwn(profile, "applied"), false, `${name} must not mark the candidate applied`);
    let ignored = false;
    try { execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot }); ignored = true; } catch {}
    assert.equal(ignored, true, `${path} must live under the ignored out directory`);
  }
});

test("stage-2 and stage-4 corpora are distinct from each other and from the offline cases", async () => {
  const samples = JSON.parse(await readFile(join(outDir, "usage-samples.json"), "utf8"));
  const online = JSON.parse(await readFile(join(outDir, "online-report.json"), "utf8"));
  assert.equal(online.schema, "nnanything.cli-read-feedback.online-report.v1");

  const sampleIds = new Set(samples.runs.map(run => run.task.id));
  const onlineIds = new Set(online.heldoutTasks.map(task => task.id));
  for (const id of sampleIds) assert.equal(onlineIds.has(id), false, `stage-2 id ${id} must not appear in stage 4`);

  const keyOf = (request, size) => `${request.shape}|${request.mode}|${request.quantity}|${request.offset}|${size}`;
  const sampleKeys = new Set(samples.runs.map(run => keyOf(run.task.request, run.task.size)));
  const onlineKeys = new Set(online.heldoutTasks.map(task => keyOf(task.request, task.size)));
  for (const key of sampleKeys) assert.equal(onlineKeys.has(key), false, `stage-2 task tuple ${key} must not appear in stage 4`);

  const offline = buildCases();
  const offlineKeys = new Set(offline.map(spec => keyOf(spec.request, spec.files[0]?.contents.length ?? 0)));
  for (const key of sampleKeys) assert.equal(offlineKeys.has(key), false, `stage-2 task tuple ${key} must not appear in the offline cases`);
  for (const key of onlineKeys) assert.equal(offlineKeys.has(key), false, `stage-4 task tuple ${key} must not appear in the offline cases`);

  const offlineText = offline.map(spec => spec.files.map(file => file.contents).join("")).join("");
  for (const run of samples.runs) {
    assert.equal(offlineText.includes(run.task.contentMarker), false, "stage-2 marker must not appear in offline content");
  }
  for (const task of online.heldoutTasks) {
    assert.equal(offlineText.includes(task.marker), false, "stage-4 marker must not appear in offline content");
  }
});

test("posterior-answer unit is caught: hidden content can never answer for the receipt", assetGated, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-online-posterior-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
    recipe: {
      scenarioId: "posterior",
      entries: [{ path: "file.txt", kind: "file", contents: "QZXPOSTERIORSHORT" }],
      sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  const session = sandbox.bindSession("session");
  const fileRef = await sandbox.bindFile(session, "file.txt");

  const posterior = Object.freeze({
    inferBase() {
      return Object.freeze({
        data_obtained: 1, end_observed: 1, incomplete_observation: 0,
        execution_error: 0, target_changed: 0, observation_unknown: 0,
      });
    },
    inferReasoning() {
      return "condition_met";
    },
  });
  let outcome;
  try {
    outcome = await runCliReadExpectationGoal(
      { requestId: "posterior-1", requirement: req("head", "exact", 8, 0, 8), path: "file.txt" },
      { sandbox, session, fileRef, unit: posterior, context: CONTEXT, maxReadBytes: 3, retryBudget: 0 },
    );
  } finally {
    await sandbox.cleanup();
  }
  const rootResult = outcome.response.kind === "run_result" ? outcome.response.report.rootEvaluation : null;
  const satisfied = rootResult !== null && rootResult.state === "evaluated" && rootResult.result === "satisfied";
  const illegal = outcome.decisions.some(decision => !decision.allowed.includes(decision.prediction) || !decision.legal);
  assert.equal(satisfied, false, "a posterior-answer unit must not satisfy the root");
  assert.ok(illegal, "a posterior-answer unit must be caught as an illegal prediction");
  assert.ok(outcome.decisions.length > 0);
});

test("cached answers are not reused: a changed receipt recomputes the decision", assetGated, async t => {
  const unit = await postUnit();
  const makeWorld = async (scenarioId, transient) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nn-online-cache-")));
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    const sandbox = await createCliFilesystemSandbox({
      root,
      ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
      recipe: {
        scenarioId,
        entries: [{ path: "file.txt", kind: "file", contents: "QZXCACHECONTENT" }],
        sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
      },
    });
    const session = sandbox.bindSession("session");
    const fileRef = await sandbox.bindFile(session, "file.txt");
    let executions = 0;
    return {
      session,
      fileRef,
      executions: () => executions,
      sandbox: {
        ...sandbox,
        async execute(call) {
          executions += 1;
          if (transient > 0 && call?.operation === "file.read") {
            transient -= 1;
            return {
              status: "failed",
              execution: {
                status: "failed",
                executorInvoked: true,
                error: { stage: "observe", code: "EINTR", message: "controlled transient" },
              },
            };
          }
          return sandbox.execute(call);
        },
      },
    };
  };

  const first = await makeWorld("cache-first", 0);
  const firstOutcome = await runCliReadExpectationGoal(
    { requestId: "cache-1", requirement: req("head", "exact", 8, 0, 8), path: "file.txt" },
    { sandbox: first.sandbox, session: first.session, fileRef: first.fileRef, unit, context: CONTEXT, maxReadBytes: 4, retryBudget: 1 },
  );
  assert.ok(first.executions() > 0, "first run must execute real reads");
  assert.equal(firstOutcome.finalState.reads, first.executions());

  const second = await makeWorld("cache-second", 1);
  const secondOutcome = await runCliReadExpectationGoal(
    { requestId: "cache-2", requirement: req("head", "exact", 8, 0, 8), path: "file.txt" },
    { sandbox: second.sandbox, session: second.session, fileRef: second.fileRef, unit, context: CONTEXT, maxReadBytes: 4, retryBudget: 1 },
  );
  assert.ok(second.executions() > 0, "second run must re-execute real reads");
  assert.equal(secondOutcome.finalState.reads, second.executions());
  assert.notEqual(firstOutcome.decisions[0]?.prediction, secondOutcome.decisions[0]?.prediction, "a changed receipt must change the first decision");
  assert.equal(secondOutcome.decisions[0]?.prediction, "retry_current_read");
  assert.ok(secondOutcome.decisions.every(decision => decision.allowed.includes(decision.prediction)));
});

test("held-out three-arm evaluation reports legality and per-task root/recovery/stop", async () => {
  const report = JSON.parse(await readFile(join(outDir, "online-report.json"), "utf8"));
  assert.equal(report.schema, "nnanything.cli-read-feedback.online-report.v1");
  const arms = ["baseline", "initial", "post"];
  for (const arm of arms) {
    const summary = report.summary[arm];
    assert.ok(summary, `${arm} summary must exist`);
    assert.ok(summary.legal, `${arm} legality must hold on the held-out tasks`);
  }

  for (const spec of report.heldoutTasks) {
    const rows = report.results.filter(row => row.task === spec.id);
    assert.equal(rows.length, arms.length, `${spec.id} must have one row per arm`);
    for (const row of rows) {
      assert.equal(row.legal, true, `${spec.id}/${row.arm} legality`);
      assert.equal(typeof row.rootSuccess, "boolean");
      assert.equal(typeof row.readCount, "number");
      assert.equal(typeof row.bytesRequested, "number");
      assert.equal(typeof row.bytesRead, "number");
      assert.equal(typeof row.bytesReturned, "number");
      assert.equal(row.decisionInputsRecomputed, true, `${spec.id}/${row.arm} inputs must recompute from the receipt`);
    }
  }

  const eacces = report.results.find(row => row.task === "holdout-eacces-terminal" && row.arm === "post");
  assert.ok(eacces, "EACCES post arm row must exist");
  assert.equal(eacces.accurateStop, true);
  assert.equal(eacces.terminalCode, "EACCES");
  assert.equal(eacces.terminalNotRepeated, true);
  assert.equal(eacces.readCount, 1);
  assert.deepEqual(eacces.predictions, ["terminal_error"]);

  assert.equal(report.cacheControl.identicalTask, true);
  assert.equal(report.cacheControl.readsExecutedAgain, true);
  assert.equal(report.cacheControl.decisionRecomputed, true);
  assert.equal(report.cacheControl.freshReceiptVectorMatched, true);
  if (report.efficiency.proven === false) assert.equal(report.efficiency.claim, "not proven");
});

test("post-use candidate keeps the M1 root/recovery/stop trajectories", assetGated, async () => {
  const unit = await postUnit();
  const cases = [
    { name: "segmented-remaining", requirement: req("head", "exact", 8), world: ["segmented", "0123456789abcdefghij", null], transient: 0, options: { maxReadBytes: 3, retryBudget: 0 }, expect: { satisfied: true, stopReason: "root_evaluation", minDecisions: 2, includes: ["need_remaining_data"] } },
    { name: "exact8-request", requirement: req("head", "exact", 8), world: ["exact8", "0123456789", null], transient: 0, options: { maxReadBytes: 8, retryBudget: 0 }, expect: { satisfied: true, stopReason: "root_evaluation", reads: 1, bytesReturned: 8, coverage: [[0, 8]] } },
    { name: "transient-retry", requirement: req("head", "exact", 6), world: ["retry-ok", "012345678", null], transient: 1, options: { maxReadBytes: 3, retryBudget: 1 }, expect: { satisfied: true, stopReason: "root_evaluation", reads: 3, includes: ["retry_current_read"] } },
    { name: "denied-stop", requirement: req("head", "exact", 3), world: ["denied", "abcdefgh", 0o000], transient: 0, options: { maxReadBytes: 3, retryBudget: 0 }, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } },
    { name: "denied-with-budget", requirement: req("head", "exact", 3), world: ["denied-budget", "abcdefgh", 0o000], transient: 0, options: { maxReadBytes: 3, retryBudget: 1 }, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } },
    { name: "transient-exhausted", requirement: req("head", "exact", 6), world: ["retry-exhausted", "012345678", null], transient: 2, options: { maxReadBytes: 3, retryBudget: 1 }, expect: { satisfied: false, outcome: "error", reads: 2, predictions: ["retry_current_read", "terminal_error"] } },
    { name: "transient-no-budget", requirement: req("head", "exact", 6), world: ["retry-nobudget", "012345678", null], transient: 1, options: { maxReadBytes: 3, retryBudget: 0 }, expect: { satisfied: false, outcome: "error", reads: 1, predictions: ["terminal_error"] } },
    { name: "budget-truncation", requirement: req("head", "exact", 8), world: ["budget", "0123456789", null], transient: 0, options: { maxReadBytes: 3, retryBudget: 0, limits: { maxTransitions: 7, maxDepth: 5, maxDerivedGoals: 12 } }, expect: { satisfied: false, stopReason: "budget", reads: 1 } },
  ];

  for (const entry of cases) {
    const [name, contents, mode] = entry.world;
    const w = await world(name, contents, mode);
    let result;
    try {
      const sandbox = entry.transient > 0 ? withTransient(w.sandbox, entry.transient) : w.sandbox;
      result = await runCliReadExpectationGoal(
        { requestId: `online-m1-${entry.name}`, requirement: entry.requirement, path: "file.txt" },
        { sandbox, session: w.session, fileRef: w.fileRef, unit, context: CONTEXT, ...entry.options },
      );
    } finally {
      await w.close();
    }
    for (const decision of result.decisions) {
      assert.ok(decision.allowed.includes(decision.prediction), `${entry.name}: illegal ${decision.prediction}`);
      assert.equal(decision.legal, true, `${entry.name}: adapter marked a legal decision illegal`);
    }
    const summary = runSummary(result);
    const predictions = result.decisions.map(decision => decision.prediction);
    const expect = entry.expect;
    assert.equal(summary.satisfied, expect.satisfied, `${entry.name}: root result`);
    if (expect.stopReason !== undefined) assert.equal(summary.stopReason, expect.stopReason, `${entry.name}: stop reason`);
    if (expect.outcome !== undefined) assert.equal(summary.outcome, expect.outcome, `${entry.name}: outcome`);
    if (expect.reads !== undefined) assert.equal(result.finalState?.reads ?? 0, expect.reads, `${entry.name}: reads`);
    if (expect.minDecisions !== undefined) assert.ok(result.decisions.length >= expect.minDecisions, `${entry.name}: decisions`);
    if (expect.predictions !== undefined) assert.deepEqual(predictions, expect.predictions, `${entry.name}: decisions`);
    if (expect.includes !== undefined) for (const label of expect.includes) assert.ok(predictions.includes(label), `${entry.name}: missing ${label}`);
    if (expect.bytesReturned !== undefined) assert.equal(bytesReturned(result), expect.bytesReturned, `${entry.name}: bytes returned`);
    if (expect.coverage !== undefined) assert.deepEqual((result.finalState?.coverage ?? []).map(pair => [...pair]), expect.coverage, `${entry.name}: coverage`);
  }
});

test("the post-use candidate stays a local gitignored file and is never applied", async () => {
  const training = JSON.parse(await readFile(join(outDir, "post", "training-report.json"), "utf8"));
  assert.equal(training.applied, false);
  for (const name of ["base-profile.json", "reasoning-profile.json", "training-report.json"]) {
    const path = join(outDir, "post", name);
    let ignored = false;
    try { execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot }); ignored = true; } catch {}
    assert.equal(ignored, true, `${path} must be gitignored`);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (name === "training-report.json") {
      assert.equal(parsed.applied, false);
    } else {
      assert.equal(Object.hasOwn(parsed, "applied"), false, `${name} must not carry an applied marker`);
    }
  }
});

// P1-1 counterexample: a wrong sampled prediction used to abort the whole
// fitting entry. It must instead become sourced supervision. The tampered copy
// keeps the real receipt, the recorded input vectors and the oracle allowed set
// untouched; only the recorded prediction and its legality flag are wrong.
test("a wrong sampled prediction is accepted as sourced supervision, never replayed as a read", assetGated, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nn-online-p11-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  for (const name of ["base-profile.json", "reasoning-profile.json", "pretrain-samples.json", "training-report.json"]) {
    await writeFile(join(dir, name), await readFile(join(outDir, name)));
  }
  const samples = JSON.parse(await readFile(join(outDir, "usage-samples.json"), "utf8"));
  const run = samples.runs.find(item => item.decisions.length > 0 && item.task.partition === "train");
  const decision = run.decisions[0];
  const wrong = ["condition_met", "need_current_target", "need_observation"].find(label => !decision.allowed.includes(label));
  assert.ok(wrong, "the tampered prediction must be outside the oracle allowed set");
  decision.prediction = wrong;
  decision.legal = false;
  await writeFile(join(dir, "usage-samples.json"), JSON.stringify(samples, null, 2));

  const stdout = execFileSync(process.execPath, ["playground/cli/read-feedback/post-train.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NN_HANDWIRED_ROOT: handwiredRoot, NN_OUT_DIR: dir },
  });
  assert.equal(typeof JSON.parse(stdout).out, "string");

  const report = JSON.parse(await readFile(join(dir, "post", "training-report.json"), "utf8"));
  assert.equal(report.sampledErrors.length, 1, "the wrong sampled prediction must be reported");
  const sampled = report.sampledErrors[0];
  assert.equal(sampled.attemptId, decision.attemptId);
  assert.equal(sampled.prediction, wrong);
  assert.deepEqual(sampled.allowed, decision.allowed);
  assert.equal(sampled.source.requestId, run.source.requestId);
  assert.deepEqual(report.rejectedSamples, [], "a wrong prediction is not a reason to reject the sample");
  assert.equal(report.trainingPolicy.executesReads, false, "the fitting entry must not execute the sampled read");
  assert.equal(report.trainingPolicy.replayIllegalActions, false);

  // It still entered the oracle-supervised training set, and the wrong label
  // never became a target.
  assert.ok(report.counts.decisionsByPartition.train > 0);
  for (const label of decision.allowed) {
    assert.ok(report.perLabelSources.reasoning[label].real.includes(run.task.id),
      `${run.task.id} must remain a sourced ${label} example`);
  }
  assert.equal(report.perLabelSources.reasoning[wrong].real.includes(run.task.id), false,
    "the model's own wrong prediction must never become the target label");
});

// P1-2: the old gold has to be compared per case, and a reasoning collapse from
// 19/19 to 8/19 has to fail the candidate even though the entry exits 0.
test("the per-case regression gate fails a reasoning collapse and keeps the real post numbers", assetGated, async t => {
  const stdout = execFileSync(process.execPath, ["playground/cli/read-feedback/post-regress.mjs"], {
    cwd: repoRoot, encoding: "utf8",
    env: { ...process.env, NN_HANDWIRED_ROOT: handwiredRoot },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.schema, "nnanything.cli-read-feedback.post-regression-report.v1");
  assert.equal(report.applied, false);
  assert.equal(report.corpus.cases, 19);

  // The delivered continued candidate must not regress on the old gold. That is
  // a narrow non-regression verdict and must never be reported as an overall pass.
  assert.equal(report.nonRegression.passed, true, report.nonRegression.reasons.join("; "));
  assert.equal(report.post.base.totals.regressed, 0);
  assert.equal(report.post.reasoning.totals.regressed, 0);
  assert.deepEqual([report.post.base.totals.initialCorrect, report.post.base.totals.scored], [94, 94]);
  assert.deepEqual([report.post.reasoning.totals.initialCorrect, report.post.reasoning.totals.scored], [19, 19]);
  assert.equal(report.nonRegression.passed && report.overallQualification.qualified, false,
    "a non-regression pass must not imply an overall qualification");
  assert.equal(report.overallQualification.status, "INCOMPLETE");
  assert.ok(report.overallQualification.reasons.length > 0, "the incomplete qualification must state its reasons");
  assert.ok(report.overallQualification.reasons.some(reason => /independent-source/i.test(reason)));
  assert.ok(report.overallQualification.reasons.some(reason => /efficiency/i.test(reason)));

  // The zero-start diagnostic keeps the real failure evidence unchanged.
  const zero = report.zeroStartDiagnostic;
  assert.equal(zero.qualified, false);
  assert.deepEqual([zero.base.totals.candidateCorrect, zero.base.totals.scored], [87, 94]);
  assert.deepEqual([zero.reasoning.totals.candidateCorrect, zero.reasoning.totals.scored], [8, 19]);
  assert.ok(zero.base.totals.regressed > 0);
  assert.ok(zero.reasoning.totals.regressed > 0);
  assert.match(zero.label, /diagnostic control/);

  // Degraded candidate: identical base weights, reasoning weights zeroed. The
  // gate must catch the reasoning collapse instead of hiding it behind a floor.
  const degraded = await mkdtemp(join(tmpdir(), "nn-online-p12-"));
  t.after(async () => { await rm(degraded, { recursive: true, force: true }); });
  await writeFile(join(degraded, "base-profile.json"), await readFile(join(outDir, "base-profile.json")));
  const reasoning = JSON.parse(await readFile(join(outDir, "post", "reasoning-profile.json"), "utf8"));
  reasoning.weights = reasoning.weights.map(row => row.map(() => 0));
  await writeFile(join(degraded, "reasoning-profile.json"), JSON.stringify(reasoning, null, 2));

  const deliveredReportBefore = await readFile(join(outDir, "post-regression-report.json"), "utf8");
  const degradedOut = execFileSync(process.execPath, ["playground/cli/read-feedback/post-regress.mjs"], {
    cwd: repoRoot, encoding: "utf8",
    env: { ...process.env, NN_HANDWIRED_ROOT: handwiredRoot, NN_POST_DIR: degraded },
  });
  const degradedReport = JSON.parse(degradedOut);

  // A diagnostic candidate must never overwrite the delivered candidate's report.
  const deliveredReportAfter = await readFile(join(outDir, "post-regression-report.json"), "utf8");
  assert.equal(deliveredReportAfter, deliveredReportBefore,
    "scoring a foreign candidate must not rewrite the delivered regression report");
  assert.equal(degradedReport.reportPath, join(degraded, "post-regression-report.json"),
    "a foreign candidate keeps its own report beside itself");
  assert.equal(degradedReport.nonRegression.passed, false, "a reasoning collapse must fail the non-regression gate");
  assert.ok(degradedReport.post.reasoning.totals.regressed > 0, "the collapse must show up as regressed cases");
  assert.ok(degradedReport.nonRegression.reasons.some(reason => reason.includes("reasoning regressed")));
  assert.equal(degradedReport.post.base.totals.regressed, 0, "an unchanged base unit must not be blamed");
});

// Warm start is an explicit, validated entry on the fit owners. Omitting it keeps
// the original zero-start behaviour; supplying it makes epoch 0 reproduce the
// captured candidate exactly, before any gradient step.
test("the fit owner warm-starts only from an explicit matching profile", assetGated, async () => {
  const att = attempt(req("head", "exact", 8, 0, 8), obs(0, 8, 20, 3));
  const supervision = superviseBase(att);
  const episode = {
    partition: "train",
    input: measureBase(att),
    label: supervision.label,
    mask: supervision.mask,
  };
  const initial = await loadReadProfile(join(outDir, "base-profile.json"), "base");
  const base = { handwiredRoot, epochs: 0, learningRate: 0.1, episodes: [episode], stopCheckpoints: [1] };

  const seeded = await fitReadFeedbackProfile({ ...base, initialProfile: initial });
  assert.deepEqual(seeded.profile.weights, initial.weights, "epoch 0 must return the supplied profile unchanged");
  assert.notEqual(seeded.epochZero, null, "a seeded fit must report its epoch-0 forward");

  const scratch = await fitReadFeedbackProfile(base);
  assert.equal(scratch.epochZero, null, "the default path must not claim an epoch-0 reproduction");
  assert.ok(scratch.profile.weights.every(row => row.every(weight => weight === 0)), "omitting the profile keeps the zero start");

  const reasoning = await loadReadProfile(join(outDir, "reasoning-profile.json"), "reasoning");
  await assert.rejects(
    fitReadFeedbackProfile({ ...base, initialProfile: reasoning }),
    /initial profile (schema|kind) must be/,
    "a mismatched profile must be rejected instead of silently used",
  );
});

// Isolation red test. The pretraining entry must fit the train partition only.
//
// Red proof: this test builds a fit whose dev/verification labels are flipped. If
// the entry passed every measured case to the fit, the flipped dev/verification
// supervision would enter the gradient and the resulting base weights would
// differ from the train-only fit. The assertion below therefore fails exactly
// when the entry is not isolated, and the report's fitted episode ids must all
// belong to the train partition.
test("pretraining fits the train partition only and records the fitted episode ids", assetGated, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-online-isolation-"));
  try {
    const stdout = execFileSync(process.execPath, ["playground/cli/read-feedback/train.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NN_HANDWIRED_ROOT: handwiredRoot, NN_OUT_DIR: dir },
    });
    assert.doesNotThrow(() => JSON.parse(stdout), "the pretraining entry must report its gate as JSON");

    const report = JSON.parse(await readFile(join(dir, "training-report.json"), "utf8"));
    assert.equal(report.schema, "nnanything.cli-read-feedback.pretraining-report.v1");
    assert.equal(report.entry.includes("train partition only"), true);

    // Every fitted id must be a train case, and no dev/verification case may appear.
    const cases = buildCases();
    const partitionOf = new Map(cases.map(spec => [spec.id, spec.partition]));
    const trainIds = cases.filter(spec => spec.partition === "train").map(spec => spec.id).sort();
    assert.equal(trainIds.length, 38);

    for (const unit of ["base", "reasoning"]) {
      const fitted = report.fitted[unit];
      assert.equal(fitted.partition, "train", `${unit}: only the train partition may be fitted`);
      assert.deepEqual([...fitted.episodeIds].sort(), trainIds, `${unit}: the fitted ids must be exactly the train cases`);
      assert.deepEqual(fitted.partitionCounts, { train: 38, dev: 0, verification: 0 },
        `${unit}: dev and verification must not enter the fit`);
      for (const id of fitted.episodeIds) {
        assert.equal(partitionOf.get(id), "train", `${unit}: fitted id ${id} must be a train case`);
      }
    }
    assert.ok(report.evaluationOnly.dev > 0 && report.evaluationOnly.verification > 0,
      "the skipped partitions must still be reported as measured, evaluation-only cases");

    // The pre-declared budget and gate must be recorded, not inferred afterwards.
    assert.deepEqual(report.budget.stopCheckpoints, [50, 100, 150, 200]);
    assert.equal(report.budget.epochs, 200);
    assert.equal(report.budget.learningRate, 0.1);
    assert.equal(typeof report.gate.passed, "boolean");

    // Red proof. The epoch-1 loss is the exact sum over the fitted rows, so it is
    // a fingerprint of the row set that entered the gradient. Flipping every
    // dev/verification label must change that loss; the delivered run must carry
    // the train-only loss and must not match the contaminated one.
    const prepared = await prepareSamples(cases);
    const trainEpisodes = prepared.base.filter(episode => episode.partition === "train");
    const flipped = prepared.base.map(episode => episode.partition === "train"
      ? episode
      : { ...episode, label: Object.fromEntries(Object.entries(episode.label).map(([label, value]) => [label, value === 1 ? 0 : 1])) });
    const options = { handwiredRoot, epochs: 1, learningRate: 0.1, stopCheckpoints: [1] };
    const isolatedFit = await fitReadFeedbackProfile({ ...options, episodes: trainEpisodes });
    const contaminatedFit = await fitReadFeedbackProfile({ ...options, episodes: flipped });
    const isolatedLoss = isolatedFit.trajectory[0].loss;
    const contaminatedLoss = contaminatedFit.trajectory[0].loss;
    assert.notEqual(contaminatedLoss, isolatedLoss,
      "the counterexample must actually change the fit, otherwise this test proves nothing");

    assert.equal(report.base.trajectory[0].loss, isolatedLoss,
      "the reported base fit must be the train-only fit");
    assert.notEqual(report.base.trajectory[0].loss, contaminatedLoss,
      "the reported base fit must not have consumed dev/verification supervision");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
