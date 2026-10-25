import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const recoveryApi = () => import(fileURLToPath(new URL("../playground/cli/content-search/p3-recovery.mjs", import.meta.url)));
const policyApi = () => import("nnanything/cli-goal");

function eioCell(overrides = {}) {
  const cell = {
    arm: "forced",
    feedbackKind: "E",
    slot0: { name: "a", outcome: "read_error", failureCode: "EIO", contains: null, hasRead: false, scan: null },
    negativeNames: [],
    denominators: { directoriesComplete: 1, directoriesUncovered: 0 },
    decisionTrace: [
      { ordinal: 1, selectedName: "a", candidateNames: ["a"], executions: [{ index: 2, head: "read", candidateName: "a", outcome: "succeeded" }] },
      { ordinal: 2, selectedName: "b", candidateNames: ["b"], executions: [{ index: 4, head: "read", candidateName: "b", outcome: "succeeded" }] },
    ],
    atomicSteps: [
      { index: 0, head: "ls", candidateName: null, outcome: "succeeded" },
      { index: 1, head: "entry.inspect", candidateName: "a", outcome: "succeeded" },
      { index: 2, head: "read", candidateName: "a", outcome: "succeeded" },
      { index: 3, head: "entry.inspect", candidateName: "b", outcome: "succeeded" },
      { index: 4, head: "read", candidateName: "b", outcome: "succeeded" },
    ],
    status: "achieved",
    root: { state: "evaluated", result: "satisfied", satisfaction: 100 },
    control: { outcome: "completed" },
    hitName: "b",
    transitionsUsed: 4,
    derivedGoalsUsed: 2,
    limits: { maxTransitions: 256, maxDerivedGoals: 64 },
  };
  return Object.assign(cell, overrides);
}

test("F2 recovery rejects an absent slot 0 feedback", async () => {
  const { recoveryOutcome } = await recoveryApi();
  const outcome = recoveryOutcome(eioCell({ slot0: null }));
  assert.equal(outcome.covered, false);
  assert.equal(outcome.recovered, false);
});

test("F2 recovery rejects a wrong feedback type", async () => {
  const { recoveryOutcome } = await recoveryApi();
  const outcome = recoveryOutcome(eioCell({
    slot0: { name: "a", outcome: "negative", failureCode: null, contains: false, hasRead: true, scan: { complete: true, shortRead: false, found: false } },
  }));
  assert.equal(outcome.covered, false);
  assert.equal(outcome.recovered, false);
});

test("F2 recovery rejects a selection with no execution", async () => {
  const { recoveryOutcome } = await recoveryApi();
  const outcome = recoveryOutcome(eioCell({
    decisionTrace: [
      { ordinal: 1, selectedName: "a", candidateNames: ["a"], executions: [] },
      { ordinal: 2, selectedName: "b", candidateNames: ["b"], executions: [] },
    ],
  }));
  assert.equal(outcome.covered, false);
  assert.equal(outcome.recovered, false);
});

test("F2 recovery rejects a hit observed before the feedback", async () => {
  const { recoveryOutcome } = await recoveryApi();
  const outcome = recoveryOutcome(eioCell({
    decisionTrace: [
      { ordinal: 1, selectedName: "a", candidateNames: ["a"], executions: [{ index: 1, head: "read", candidateName: "a", outcome: "succeeded" }] },
      { ordinal: 2, selectedName: "b", candidateNames: ["b"], executions: [{ index: 3, head: "read", candidateName: "b", outcome: "succeeded" }] },
    ],
    atomicSteps: [
      { index: 0, head: "read", candidateName: "b", outcome: "succeeded" },
      { index: 1, head: "read", candidateName: "a", outcome: "succeeded" },
    ],
  }));
  assert.equal(outcome.recovered, false);
});

test("F4 comparison reports a root-only mismatch", async () => {
  const { t1t2Mismatches } = await recoveryApi();
  const left = {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    root: { state: "evaluated", result: "satisfied", satisfaction: 100 },
    control: { outcome: "completed" },
    invocationCount: 3,
    observationCount: 3,
    bytesReadTotal: 64,
    duplicateReads: 0,
    decisionTrace: [{ ordinal: 1, forced: false, candidateNames: ["a"], selectedName: "a", selectedFeatures: Array(31).fill(0) }],
  };
  const right = {
    ...left,
    root: { state: "evaluated", result: "unsatisfied", satisfaction: 0 },
  };
  const mismatches = t1t2Mismatches(left, right, "root-only");
  assert.ok(mismatches.some(message => message.includes("root.result")));
});

test("candidate-preference task runs through the shared training workflow", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const policy = await policyApi();
  const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "nn-p3-rework-train-"));
  const outputRoot = join(root, "results");
  await mkdir(outputRoot);
  try {
    const initial = policy.zeroCliCommandProfile();
    const receipt = await policy.runCliCommandTraining({
      task: "candidate-preference",
      preferenceRows: [{
        id: "one",
        sourceGroup: "synthetic",
        partition: "train",
        preferredName: "needle",
        otherName: "other",
        preferredFeatures: Array.from({ length: 31 }, (_, index) => index === 29 ? 1 : 0),
        otherFeatures: Array(31).fill(0),
        evidenceRefs: ["one:dispatch:1"],
      }],
      initial,
      initialSource: null,
      epochs: 1,
      learningRate: 0.1,
    }, {
      handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
    });
    assert.equal(receipt.task, "candidate-preference");
    assert.equal(receipt.fullyVerified, false);
    assert.equal(receipt.dataset.validPairCount, 1);
    assert.equal(receipt.execution.correct, 1);
    assert.equal(receipt.trainable.frozenParameterCount, 309);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
