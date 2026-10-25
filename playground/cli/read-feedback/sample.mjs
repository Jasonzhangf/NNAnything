// Stage 2: real usage sampling.
//
// Every sample runs through the single public entry `runCliReadExpectationGoal`
// with the initial M1 candidate. The t0 input is only the request; the declared
// context is harness input. Hidden file bytes, posterior answers and same-task
// cache are not allowed into t0 or into any recorded model input vector.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_WIRES,
  REASONING_WIRES,
  measureBase,
  measureReasoning,
  mergeCoverage,
  readReadFeedbackUnit,
  runCliReadExpectationGoal,
} from "nnanything/cli-read-feedback";
import { createCliFilesystemSandbox } from "nnanything/cli-read";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
await mkdir(outDir, { recursive: true });

const BASE_PROFILE = join(outDir, "base-profile.json");
const REASONING_PROFILE = join(outDir, "reasoning-profile.json");
const unit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: BASE_PROFILE,
  reasoningProfilePath: REASONING_PROFILE,
});

const DECLARED_CONTEXT = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

const ALPHABET = "qzxjkvbnmwytrplhgfdsac";

/** Deterministic ASCII content; the uppercase marker makes leakage scans unambiguous. */
function contentFor(marker, length) {
  let out = marker;
  for (let index = 0; out.length < length; index += 1) {
    out += ALPHABET[(index * 7 + marker.length + length) % ALPHABET.length];
  }
  return out.slice(0, length);
}

function task(definition) {
  const marker = `QZXREADSAMPLE${definition.serial}`;
  return Object.freeze({
    ...definition,
    marker,
    content: contentFor(marker, definition.size),
  });
}

// Sizes, offsets, modes and contents deliberately differ from the 76 offline
// cases and from the stage-4 held-out corpus.
const SAMPLE_TASKS = Object.freeze([
  task({
    serial: 1,
    id: "sample-segmented-head",
    partition: "train",
    family: "segmented-head",
    provenance: "real",
    description: "exact head split by the harness I/O cap over three real reads",
    size: 25,
    request: { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 },
    maxReadBytes: 3,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 2,
    id: "sample-exact-one-read",
    partition: "train",
    family: "exact-one-read",
    provenance: "real",
    description: "exact head satisfied by one real read",
    size: 30,
    request: { shape: "head", mode: "exact", quantity: 5, offset: 0, length: 5 },
    maxReadBytes: 8,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 3,
    id: "sample-exact-shortfall",
    partition: "train",
    family: "exact-shortfall-eof",
    provenance: "real",
    description: "exact request larger than the file, confirmed at EOF",
    size: 3,
    request: { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 },
    maxReadBytes: 6,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 4,
    id: "sample-transient-recovery",
    partition: "train",
    family: "transient-recovery",
    provenance: "injected",
    description: "one controlled EINTR, retry budget recovers with real reads",
    size: 12,
    request: { shape: "head", mode: "exact", quantity: 6, offset: 0, length: 6 },
    maxReadBytes: 3,
    retryBudget: 1,
    transientTimes: 1,
    denied: false,
  }),
  task({
    serial: 5,
    id: "sample-range-segmented",
    partition: "train",
    family: "range-segmented",
    provenance: "real",
    description: "exact range at a nonzero offset split over three reads",
    size: 17,
    request: { shape: "range", mode: "exact", quantity: 6, offset: 2, length: 6 },
    maxReadBytes: 2,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 6,
    id: "sample-exact-two-reads",
    partition: "train",
    family: "exact-two-reads",
    provenance: "real",
    description: "exact head split over two real reads",
    size: 10,
    request: { shape: "head", mode: "exact", quantity: 10, offset: 0, length: 10 },
    maxReadBytes: 6,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 7,
    id: "sample-eacces-terminal",
    partition: "dev",
    family: "eacces-terminal",
    provenance: "real",
    description: "real EACCES denial, terminal and never repeated",
    size: 8,
    request: { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 },
    maxReadBytes: 3,
    retryBudget: 1,
    transientTimes: 0,
    denied: true,
  }),
  task({
    serial: 8,
    id: "sample-upto-confirmed-end",
    partition: "dev",
    family: "up-to-confirmed-end",
    provenance: "real",
    description: "up_to request larger than the file, met at the confirmed end",
    size: 4,
    request: { shape: "head", mode: "up_to", quantity: 9, offset: 0, length: 9 },
    maxReadBytes: 9,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 9,
    id: "sample-range-verification",
    partition: "verification",
    family: "range-segmented",
    provenance: "real",
    description: "held-out exact range split over three reads",
    size: 19,
    request: { shape: "range", mode: "exact", quantity: 7, offset: 3, length: 7 },
    maxReadBytes: 3,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 10,
    id: "sample-tail-upto",
    partition: "verification",
    family: "tail-up-to",
    provenance: "real",
    description: "held-out tail up_to request met at the confirmed end",
    size: 11,
    request: { shape: "tail", mode: "up_to", quantity: 5, offset: 0, length: 5 },
    maxReadBytes: 10,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 11,
    id: "sample-exact-three-reads",
    partition: "verification",
    family: "exact-three-reads",
    provenance: "real",
    description: "held-out exact head split over three reads",
    size: 9,
    request: { shape: "head", mode: "exact", quantity: 9, offset: 0, length: 9 },
    maxReadBytes: 4,
    retryBudget: 0,
    transientTimes: 0,
    denied: false,
  }),
  task({
    serial: 12,
    id: "sample-transient-no-budget",
    partition: "verification",
    family: "transient-terminal",
    provenance: "injected",
    description: "held-out controlled transient with no retry budget, terminal",
    size: 10,
    request: { shape: "head", mode: "exact", quantity: 4, offset: 0, length: 4 },
    maxReadBytes: 4,
    retryBudget: 0,
    transientTimes: 1,
    denied: false,
  }),
  task({
    serial: 13,
    id: "sample-eacces-terminal-train",
    partition: "train",
    family: "eacces-terminal",
    provenance: "real",
    description: "train-partition real EACCES denial at a smaller size",
    size: 7,
    request: { shape: "head", mode: "exact", quantity: 3, offset: 0, length: 3 },
    maxReadBytes: 3,
    retryBudget: 1,
    transientTimes: 0,
    denied: true,
  }),
  task({
    serial: 14,
    id: "sample-transient-no-budget-train",
    partition: "train",
    family: "transient-terminal",
    provenance: "injected",
    description: "train-partition controlled transient with no retry budget, terminal",
    size: 9,
    request: { shape: "head", mode: "exact", quantity: 5, offset: 0, length: 5 },
    maxReadBytes: 5,
    retryBudget: 0,
    transientTimes: 1,
    denied: false,
  }),
]);

async function worldFor(spec) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-sample-")));
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

function attemptOf(requirement, record, priorCoverage) {
  return Object.freeze({
    request: requirement,
    observation: record.observation === null
      ? null
      : Object.freeze({ ...record.observation, bytes: "" }),
    failure: record.failure,
    priorCoverage: Object.freeze([...priorCoverage]),
  });
}

function assertPureT0(t0, context, spec, vectors) {
  assert.deepEqual(Object.keys(t0).sort(), ["path", "requestId", "requirement"], "t0 must contain only the request");
  assert.deepEqual(
    Object.keys(t0.requirement).sort(),
    ["length", "mode", "offset", "quantity", "shape"],
    "t0 requirement must carry only the typed read request",
  );
  for (const forbidden of ["bytes", "content", "answer", "posterior", "cache", "body"]) {
    assert.equal(Object.hasOwn(t0, forbidden), false, `t0 must not carry ${forbidden}`);
    assert.equal(Object.hasOwn(t0.requirement, forbidden), false, `t0 requirement must not carry ${forbidden}`);
    assert.equal(Object.hasOwn(context, forbidden), false, `declared context must not carry ${forbidden}`);
  }
  const t0Json = JSON.stringify(t0);
  const contextJson = JSON.stringify(context);
  for (const hidden of [spec.content, spec.marker]) {
    assert.equal(t0Json.includes(hidden), false, `t0 must not include hidden content for ${spec.id}`);
    assert.equal(contextJson.includes(hidden), false, `declared context must not include hidden content for ${spec.id}`);
  }
  for (const vector of vectors) {
    const keys = Object.keys(vector).sort();
    const expected = keys.length === BASE_WIRES.length
      ? [...BASE_WIRES].sort()
      : [...REASONING_WIRES].sort();
    assert.deepEqual(keys, expected, `model input vector for ${spec.id} must use the declared wires`);
    for (const [wire, value] of Object.entries(vector)) {
      assert.ok(value === 0 || value === 1, `model input ${wire} must be a measured 0/1, received ${value}`);
    }
    for (const hidden of [spec.content, spec.marker]) {
      assert.equal(JSON.stringify(vector).includes(hidden), false, `model input must not include hidden content for ${spec.id}`);
    }
  }
}

function responseFacts(response) {
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

const runs = [];
for (const spec of SAMPLE_TASKS) {
  const requestId = `sample-run-${spec.serial}`;
  const t0 = Object.freeze({
    requestId,
    requirement: Object.freeze({ ...spec.request }),
    path: "file.txt",
  });
  const declaredContext = Object.freeze({ ...DECLARED_CONTEXT, skills: Object.freeze([...DECLARED_CONTEXT.skills]) });
  const world = await worldFor(spec);
  let outcome;
  try {
    outcome = await runCliReadExpectationGoal(t0, {
      sandbox: world.sandbox,
      session: world.session,
      fileRef: world.fileRef,
      unit,
      context: declaredContext,
      maxReadBytes: spec.maxReadBytes,
      retryBudget: spec.retryBudget,
      policy: "learned",
    });
  } finally {
    await world.close();
  }
  const facts = responseFacts(outcome.response);
  assert.equal(facts.kind, "run_result", `${spec.id}: the initial candidate must run through the entry without a module fault`);

  // Per-attempt state ids come from the controller's real evidence records, not
  // from an arithmetic reconstruction of the attempt id.
  const stateIdByAttempt = new Map();
  for (const item of outcome.response.report.evidence ?? []) {
    if (item.payload?.kind === "cli.read-expectation.receipt.v1") {
      stateIdByAttempt.set(item.payload.attemptId, item.payload.stateId);
    }
  }

  const attempts = outcome.finalState?.attempts ?? [];
  const decisions = outcome.decisions;
  const decisionByAttempt = new Map(decisions.map(decision => [decision.attemptId, decision]));
  const priorCoverage = [];
  const attemptRecords = [];
  const inputVectors = [];
  for (const record of attempts) {
    const attempt = attemptOf(t0.requirement, record, priorCoverage);
    const decision = decisionByAttempt.get(record.attemptId) ?? null;
    const baseVector = measureBase(attempt);
    const reasoningVector = decision === null
      ? null
      : measureReasoning(decision.basePrediction, attempt, decision.context);
    attemptRecords.push({
      attemptId: record.attemptId,
      stateId: stateIdByAttempt.get(record.attemptId),
      range: { offset: record.range.offset, length: record.range.length },
      status: record.status,
      // Keep the exact real receipt, including bytes. t0 and the recorded model
      // vectors remain content-free; training reconstructs inputs from measured
      // facts and deliberately replaces bytes before measurement.
      observation: record.observation,
      failure: record.failure,
      coverage: record.covered.map(pair => [pair[0], pair[1]]),
      receiptSource: "finalState.attempts",
    });
    assert.equal(
      typeof attemptRecords.at(-1).stateId,
      "string",
      `${spec.id}: every attempt must have a recorded state id from the controller evidence`,
    );
    inputVectors.push(baseVector);
    if (decision !== null) {
      assert.deepEqual(
        Object.keys(decision.context).sort(),
        ["bindingReissuable", "retryBudgetLeft", "retryEligible", "retryExhausted", "skills", "target"],
        `${spec.id}: the decision must record a full effective context`,
      );
      inputVectors.push(reasoningVector);
    }
    priorCoverage.push(...record.covered);
  }
  assertPureT0(t0, declaredContext, spec, inputVectors);

  const byteAccounting = {
    reads: outcome.finalState?.reads ?? attempts.length,
    bytesRequested: attempts.reduce((total, record) => total + record.range.length, 0),
    bytesReturned: attempts.reduce((total, record) => total + (record.observation?.bytesRead ?? 0), 0),
  };
  const decisionRecords = decisions.map(decision => ({
    attemptId: decision.attemptId,
    range: { offset: decision.range.offset, length: decision.range.length },
    basePrediction: decision.basePrediction,
    prediction: decision.prediction,
    allowed: decision.allowed,
    legal: decision.legal,
    context: decision.context,
    baseVector: measureBase(attemptOf(
      t0.requirement,
      attempts.find(record => record.attemptId === decision.attemptId),
      mergeCoverage(attempts
        .slice(0, attempts.findIndex(record => record.attemptId === decision.attemptId))
        .flatMap(record => record.covered)),
    )),
    reasoningVector: (() => {
      const index = attempts.findIndex(record => record.attemptId === decision.attemptId);
      const prior = mergeCoverage(attempts.slice(0, index).flatMap(record => record.covered));
      return measureReasoning(
        decision.basePrediction,
        attemptOf(t0.requirement, attempts[index], prior),
        decision.context,
      );
    })(),
  }));

  runs.push({
    task: {
      id: spec.id,
      partition: spec.partition,
      family: spec.family,
      provenance: spec.provenance,
      description: spec.description,
      size: spec.size,
      contentMarker: spec.marker,
      request: { ...spec.request },
      maxReadBytes: spec.maxReadBytes,
      retryBudget: spec.retryBudget,
      transientTimes: spec.transientTimes,
      denied: spec.denied,
    },
    policy: "learned",
    t0,
    declaredContext,
    maxReadBytes: spec.maxReadBytes,
    retryBudget: spec.retryBudget,
    source: {
      entry: "runCliReadExpectationGoal",
      module: "nnanything/cli-read-feedback",
      receipt: "finalState.attempts",
      requestId,
      finalStateId: outcome.finalState?.stateId ?? null,
      attemptIds: attempts.map(record => record.attemptId),
      executions: world.executions(),
    },
    attempts: attemptRecords,
    decisions: decisionRecords,
    root: facts.root,
    control: facts.control,
    readCount: byteAccounting.reads,
    byteAccounting,
  });
}

const countsByPartition = { train: 0, dev: 0, verification: 0 };
for (const run of runs) countsByPartition[run.task.partition] += 1;
const output = {
  schema: "nnanything.cli-read-feedback.usage-samples.v1",
  generatedBy: "playground/cli/read-feedback/sample.mjs",
  entry: "runCliReadExpectationGoal",
  policy: "learned",
  initialCandidate: { baseProfile: BASE_PROFILE, reasoningProfile: REASONING_PROFILE },
  declaredContext: DECLARED_CONTEXT,
  counts: {
    tasks: runs.length,
    runs: runs.length,
    attempts: runs.reduce((total, run) => total + run.attempts.length, 0),
    decisions: runs.reduce((total, run) => total + run.decisions.length, 0),
    byPartition: countsByPartition,
  },
  runs,
};
await writeFile(join(outDir, "usage-samples.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  out: join(outDir, "usage-samples.json"),
  counts: output.counts,
  tasks: runs.map(run => ({
    id: run.task.id,
    partition: run.task.partition,
    reads: run.readCount,
    decisions: run.decisions.map(decision => decision.prediction),
    root: run.root?.result ?? null,
    control: run.control === null ? null : { outcome: run.control.outcome, stopReason: run.control.stopReason },
  })),
}, null, 2));
