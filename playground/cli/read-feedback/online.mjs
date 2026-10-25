// Stage 4: three-arm paired evaluation on a new held-out corpus.
//
// All three arms use the same public entry `runCliReadExpectationGoal`, the same
// controller, the same declared context, and the same per-task I/O cap:
//   baseline - the harness gap follower, no learned unit
//   initial  - the regenerated M1 candidate
//   post     - the isolated post-use candidate from out/post/
//
// The corpus is deterministic and distinct from the 76 offline cases and from
// the stage-2 sampling set. Efficiency is only claimed when the pre-declared
// cost improves while root success and error boundaries hold.
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureBase,
  measureReasoning,
  mergeCoverage,
  readReadFeedbackUnit,
  runCliReadExpectationGoal,
  superviseReasoning,
} from "nnanything/cli-read-feedback";
import { createCliFilesystemSandbox } from "nnanything/cli-read";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
const initialUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "base-profile.json"),
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});
const postUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "post", "base-profile.json"),
  reasoningProfilePath: join(outDir, "post", "reasoning-profile.json"),
});
const baselineUnit = Object.freeze({
  inferBase() {
    throw new Error("baseline policy must not infer a base label");
  },
  inferReasoning() {
    throw new Error("baseline policy must not infer a reasoning label");
  },
});

const DECLARED_CONTEXT = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

const ALPHABET = "bcdfghjklmnpqrstvwxz";

function contentFor(marker, length) {
  let out = marker;
  for (let index = 0; out.length < length; index += 1) {
    out += ALPHABET[(index * 5 + marker.length + length) % ALPHABET.length];
  }
  return out.slice(0, length);
}

function task(definition) {
  const marker = `QZXONLINEHELDOUT${definition.serial}`;
  return Object.freeze({
    ...definition,
    marker,
    content: contentFor(marker, definition.size),
  });
}

// Sizes, contents, offsets and chunk caps differ from both prior corpora.
const HELDOUT_TASKS = Object.freeze([
  task({
    serial: 1,
    id: "holdout-segmented-head",
    family: "segmented-head",
    size: 27,
    request: { shape: "head", mode: "exact", quantity: 10, offset: 0, length: 10 },
    maxReadBytes: 4,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 2,
    id: "holdout-exact-one-read",
    family: "exact-one-read",
    size: 15,
    request: { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 },
    maxReadBytes: 6,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 3,
    id: "holdout-upto-confirmed-end",
    family: "up-to-confirmed-end",
    size: 5,
    request: { shape: "head", mode: "up_to", quantity: 12, offset: 0, length: 12 },
    maxReadBytes: 12,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 4,
    id: "holdout-exact-shortfall",
    family: "exact-shortfall-eof",
    size: 4,
    request: { shape: "head", mode: "exact", quantity: 9, offset: 0, length: 9 },
    maxReadBytes: 9,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: true,
  }),
  task({
    serial: 5,
    id: "holdout-transient-recovery",
    family: "transient-recovery",
    size: 14,
    request: { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 },
    maxReadBytes: 4,
    retryBudget: 1,
    transientTimes: 1,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 6,
    id: "holdout-eacces-terminal",
    family: "eacces-terminal",
    size: 9,
    request: { shape: "head", mode: "exact", quantity: 4, offset: 0, length: 4 },
    maxReadBytes: 4,
    retryBudget: 1,
    transientTimes: 0,
    denied: true,
    expectTerminal: true,
  }),
  task({
    serial: 7,
    id: "holdout-range-segmented",
    family: "range-segmented",
    size: 21,
    request: { shape: "range", mode: "exact", quantity: 6, offset: 7, length: 6 },
    maxReadBytes: 3,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 8,
    id: "holdout-tail-exact",
    family: "tail-exact",
    size: 13,
    request: { shape: "tail", mode: "exact", quantity: 5, offset: 0, length: 5 },
    maxReadBytes: 5,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
    expectTerminal: false,
  }),
  task({
    serial: 9,
    id: "holdout-transient-no-budget",
    family: "transient-terminal",
    size: 12,
    request: { shape: "head", mode: "exact", quantity: 5, offset: 0, length: 5 },
    maxReadBytes: 5,
    retryBudget: 0,
    transientTimes: 1,
    denied: false,
    expectTerminal: true,
  }),
]);

async function worldFor(spec) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-online-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
    recipe: {
      scenarioId: spec.id,
      entries: [{ path: "file.txt", kind: "file", contents: spec.content }],
      sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  const session = sandbox.bindSession("session");
  const fileRef = await sandbox.bindFile(session, "file.txt");
  if (spec.denied) await chmod(join(root, spec.id, "file.txt"), 0o000);
  let transientLeft = spec.transientTimes;
  let executions = 0;
  const counted = {
    ...sandbox,
    async execute(call) {
      executions += 1;
      if (transientLeft > 0 && call?.operation === "file.read") {
        transientLeft -= 1;
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
  return {
    sandbox: counted,
    session,
    fileRef,
    executions: () => executions,
    close: async () => {
      if (spec.denied) await chmod(join(root, spec.id, "file.txt"), 0o600).catch(() => {});
      await sandbox.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function rootFacts(response) {
  if (response.kind !== "run_result") {
    return { kind: response.kind, root: null, control: null };
  }
  const root = response.report.rootEvaluation;
  return {
    kind: response.kind,
    root: root === null
      ? null
      : { state: root.state, result: root.state === "evaluated" ? root.result : null, satisfaction: root.state === "evaluated" ? root.satisfaction : null },
    control: response.report.control,
  };
}

/** Counts learned inference calls so the cache control can prove recomputation. */
function observingUnit(unit) {
  const calls = { base: 0, reasoning: 0, reasoningVectors: [] };
  return {
    calls,
    unit: {
      inferBase(vector) {
        calls.base += 1;
        return unit.inferBase(vector);
      },
      inferReasoning(vector) {
        calls.reasoning += 1;
        calls.reasoningVectors.push(Object.freeze({ ...vector }));
        return unit.inferReasoning(vector);
      },
    },
  };
}

async function runArm(spec, arm, requestId, options = {}) {
  const unit = options.unitOverride ?? (arm === "baseline" ? baselineUnit : arm === "initial" ? initialUnit : postUnit);
  const policy = arm === "baseline" ? "baseline" : "learned";
  const world = await worldFor(spec);
  let outcome = null;
  let thrown = null;
  try {
    outcome = await runCliReadExpectationGoal(
      { requestId, requirement: spec.request, path: "file.txt" },
      {
        sandbox: world.sandbox,
        session: world.session,
        fileRef: world.fileRef,
        unit,
        context: DECLARED_CONTEXT,
        maxReadBytes: spec.maxReadBytes,
        retryBudget: spec.retryBudget,
        policy,
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    await world.close();
  }
  const facts = outcome === null ? { kind: "thrown", root: null, control: null } : rootFacts(outcome.response);
  const attempts = outcome?.finalState?.attempts ?? [];
  const decisions = outcome?.decisions ?? [];
  const decisionByAttempt = new Map(decisions.map(decision => [decision.attemptId, decision]));
  const decisionInputs = [];
  let prior = [];
  let inputsRecomputed = true;
  for (const record of attempts) {
    const attempt = Object.freeze({
      request: spec.request,
      observation: record.observation,
      failure: record.failure,
      priorCoverage: Object.freeze([...prior]),
    });
    const decision = decisionByAttempt.get(record.attemptId);
    if (decision !== undefined) {
      const baseVector = measureBase(attempt);
      const reasoningVector = measureReasoning(decision.basePrediction, attempt, decision.context);
      const allowed = superviseReasoning(attempt, decision.context).allowed;
      if (JSON.stringify(allowed) !== JSON.stringify(decision.allowed)) inputsRecomputed = false;
      decisionInputs.push({
        attemptId: record.attemptId,
        baseVector,
        reasoningVector,
        allowed,
      });
    }
    prior = [...mergeCoverage([...prior, ...record.covered])];
  }
  const rootSuccess = facts.root?.state === "evaluated" && facts.root.result === "satisfied";
  const predictions = decisions.map(decision => decision.prediction);
  const legal = thrown === null
    && inputsRecomputed
    && decisions.every(decision => decision.legal === true && decision.allowed.includes(decision.prediction));
  const recovery = spec.transientTimes > 0 && spec.retryBudget > 0 ? rootSuccess : null;
  const readCount = outcome?.finalState?.reads ?? 0;
  const lastAttempt = attempts.at(-1) ?? null;
  const terminalCode = lastAttempt?.failure?.code ?? null;
  const terminalNotRepeated = attempts.length === 1 && readCount === 1;
  const terminalEvidence = spec.family === "eacces-terminal"
    ? terminalCode === "EACCES"
    : spec.family === "transient-terminal"
      ? terminalCode === "EINTR"
      : spec.family === "exact-shortfall-eof"
        ? lastAttempt?.observation !== null
          && lastAttempt.observation.offset + lastAttempt.observation.bytesRead >= lastAttempt.observation.size
        : false;
  const modelStop = decisions.length === 0
    ? true
    : predictions.includes("terminal_error") && !predictions.includes("retry_current_read");
  const accurateStop = spec.expectTerminal
    ? thrown === null
      && facts.control?.outcome === "error"
      && facts.root?.result !== "satisfied"
      && terminalNotRepeated
      && terminalEvidence
      && modelStop
    : null;
  const bytesRequested = attempts.reduce((total, record) => total + record.range.length, 0);
  const bytesRead = attempts.reduce((total, record) => total + (record.observation?.bytesRead ?? 0), 0);
  return {
    task: spec.id,
    arm,
    policy,
    thrown,
    kind: facts.kind,
    rootSuccess,
    root: facts.root,
    control: facts.control === null ? null : { outcome: facts.control.outcome, stopReason: facts.control.stopReason },
    recovery,
    accurateStop,
    readCount,
    bytesRequested,
    bytesRead,
    bytesReturned: bytesRead,
    terminalCode,
    terminalNotRepeated,
    executions: world.executions(),
    legal,
    decisionInputsRecomputed: inputsRecomputed,
    decisions: decisions.map(decision => ({
      attemptId: decision.attemptId,
      prediction: decision.prediction,
      allowed: decision.allowed,
      legal: decision.legal,
    })),
    predictions,
    ...(options.includeDecisionInputs === true ? { decisionInputs } : {}),
  };
}

const ARMS = ["baseline", "initial", "post"];
const results = [];
for (const spec of HELDOUT_TASKS) {
  for (const arm of ARMS) {
    results.push(await runArm(spec, arm, `online-${spec.id}-${arm}`));
  }
}

// Same-task cache control: two fresh worlds receive the same request id and the
// same task definition. The instrumented unit must run again on the second real
// receipt, and its reasoning vector must equal a fresh recomputation.
const CACHE_TASK = task({
  serial: 90,
  id: "holdout-cache-control",
  family: "cache-control",
  size: 16,
  request: { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 },
  maxReadBytes: 4,
  retryBudget: 1,
  transientTimes: 0,
  denied: false,
  expectTerminal: false,
});
const CACHE_REQUEST_ID = "online-cache-control";
const firstObserved = observingUnit(postUnit);
const secondObserved = observingUnit(postUnit);
const cacheFirst = await runArm(CACHE_TASK, "post", CACHE_REQUEST_ID, {
  unitOverride: firstObserved.unit,
  includeDecisionInputs: true,
});
const cacheSecond = await runArm(CACHE_TASK, "post", CACHE_REQUEST_ID, {
  unitOverride: secondObserved.unit,
  includeDecisionInputs: true,
});
const cacheVectorRecomputed = cacheSecond.decisionInputs.length === secondObserved.calls.reasoning
  && cacheSecond.decisionInputs.every((input, index) => (
    JSON.stringify(input.reasoningVector) === JSON.stringify(secondObserved.calls.reasoningVectors[index])
  ));
const cacheRecomputed = firstObserved.calls.reasoning > 0
  && secondObserved.calls.reasoning > 0
  && cacheSecond.decisionInputs.length > 0
  && cacheVectorRecomputed;
assert.ok(cacheFirst.executions > 0 && cacheSecond.executions > 0, "cache control must execute real reads both times");
assert.equal(cacheFirst.readCount, cacheFirst.executions, "first cache run read count must equal executions");
assert.equal(cacheSecond.readCount, cacheSecond.executions, "second cache run read count must equal executions");
assert.equal(cacheFirst.predictions[0], cacheSecond.predictions[0], "identical tasks must reach the same first decision");
assert.ok(cacheRecomputed, "the second run must infer again from its fresh receipt");

const summaryOf = arm => {
  const rows = results.filter(row => row.arm === arm);
  return {
    arm,
    tasks: rows.length,
    rootSuccess: rows.filter(row => row.rootSuccess).length,
    recovery: rows.filter(row => row.recovery === true).length,
    recoveryTasks: rows.filter(row => row.recovery !== null).length,
    accurateStops: rows.filter(row => row.accurateStop === true).length,
    terminalTasks: rows.filter(row => row.accurateStop !== null).length,
    legal: rows.every(row => row.legal),
    reads: rows.reduce((total, row) => total + row.readCount, 0),
    bytesRequested: rows.reduce((total, row) => total + row.bytesRequested, 0),
    bytesRead: rows.reduce((total, row) => total + row.bytesRead, 0),
    bytesReturned: rows.reduce((total, row) => total + row.bytesReturned, 0),
    thrown: rows.filter(row => row.thrown !== null).length,
  };
};
const summary = {
  baseline: summaryOf("baseline"),
  initial: summaryOf("initial"),
  post: summaryOf("post"),
};

const PRE_DECLARED_COST = "bytesRequested";
const rootBoundary = summary.post.rootSuccess >= summary.initial.rootSuccess;
const recoveryBoundary = summary.post.recovery >= summary.initial.recovery;
const stopBoundary = summary.post.accurateStops >= summary.initial.accurateStops
  && summary.post.accurateStops === summary.post.terminalTasks;
const legalityBoundary = summary.post.legal;
const efficiencyProven = summary.post.bytesRequested < summary.initial.bytesRequested
  && rootBoundary
  && recoveryBoundary
  && stopBoundary
  && legalityBoundary;
const efficiencyReason = efficiencyProven
  ? `${PRE_DECLARED_COST} decreased while root, recovery, stop, and legality held`
  : summary.post.bytesRequested >= summary.initial.bytesRequested
    ? `${PRE_DECLARED_COST} did not improve (post ${summary.post.bytesRequested} vs initial ${summary.initial.bytesRequested})`
    : "a root, recovery, stop, or legality boundary did not hold";

const report = {
  schema: "nnanything.cli-read-feedback.online-report.v1",
  generatedBy: "playground/cli/read-feedback/online.mjs",
  entry: "runCliReadExpectationGoal",
  arms: ARMS,
  heldoutTasks: HELDOUT_TASKS.map(spec => ({
    id: spec.id,
    marker: spec.marker,
    family: spec.family,
    size: spec.size,
    request: spec.request,
    maxReadBytes: spec.maxReadBytes,
    retryBudget: spec.retryBudget,
    transientTimes: spec.transientTimes,
    denied: spec.denied,
    expectTerminal: spec.expectTerminal,
  })),
  ioCap: "per-task maxReadBytes, identical across arms",
  results,
  taskTable: HELDOUT_TASKS.map(spec => ({
    task: spec.id,
    arms: Object.fromEntries(ARMS.map(arm => {
      const row = results.find(candidate => candidate.task === spec.id && candidate.arm === arm);
      return [arm, {
        rootSuccess: row.rootSuccess,
        recovery: row.recovery,
        accurateStop: row.accurateStop,
        readCount: row.readCount,
        bytesRead: row.bytesRead,
        bytesReturned: row.bytesReturned,
        legal: row.legal,
      }];
    })),
  })),
  cacheControl: {
    task: CACHE_TASK.id,
    requestId: CACHE_REQUEST_ID,
    identicalTask: true,
    first: {
      readCount: cacheFirst.readCount,
      executions: cacheFirst.executions,
      predictions: cacheFirst.predictions,
      decisions: cacheFirst.decisions,
      inferenceCalls: firstObserved.calls.reasoning,
    },
    second: {
      readCount: cacheSecond.readCount,
      executions: cacheSecond.executions,
      predictions: cacheSecond.predictions,
      decisions: cacheSecond.decisions,
      inferenceCalls: secondObserved.calls.reasoning,
    },
    readsExecutedAgain: cacheFirst.executions > 0 && cacheSecond.executions > 0,
    decisionRecomputed: cacheRecomputed,
    freshReceiptVectorMatched: cacheVectorRecomputed,
    decisionStable: cacheFirst.predictions,
  },
  efficiency: {
    preDeclaredCost: PRE_DECLARED_COST,
    proven: efficiencyProven,
    claim: efficiencyProven ? "proven" : "not proven",
    reason: efficiencyReason,
  },
  summary,
};
report.textSummary = [
  `arms: baseline, initial, post; tasks: ${HELDOUT_TASKS.length}`,
  `baseline root ${summary.baseline.rootSuccess}/${summary.baseline.tasks}, legal ${summary.baseline.legal}, reads ${summary.baseline.reads}, requested ${summary.baseline.bytesRequested}, returned ${summary.baseline.bytesReturned}`,
  `initial  root ${summary.initial.rootSuccess}/${summary.initial.tasks}, legal ${summary.initial.legal}, reads ${summary.initial.reads}, requested ${summary.initial.bytesRequested}, returned ${summary.initial.bytesReturned}`,
  `post     root ${summary.post.rootSuccess}/${summary.post.tasks}, legal ${summary.post.legal}, reads ${summary.post.reads}, requested ${summary.post.bytesRequested}, returned ${summary.post.bytesReturned}`,
  `cache control: identical task, reads again ${report.cacheControl.readsExecutedAgain}, reasoning calls ${report.cacheControl.first.inferenceCalls}/${report.cacheControl.second.inferenceCalls}, fresh vector matched ${report.cacheControl.freshReceiptVectorMatched}`,
  `efficiency: ${report.efficiency.claim}; ${report.efficiency.reason}`,
];
await writeFile(join(outDir, "online-report.json"), JSON.stringify(report, null, 2));
console.log(report.textSummary.join("\n"));
console.log(JSON.stringify(report, null, 2));
