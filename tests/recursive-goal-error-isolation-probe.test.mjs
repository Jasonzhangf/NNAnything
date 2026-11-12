import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  diagnostic,
  evaluator,
  failedAtomicReceipt,
  makeRequest,
  responseReport,
  selector,
  skill,
  successfulAtomicReceipt,
} from "./recursive-goal-fixtures.mjs";
import { runRecursiveGoal } from "nnanything/recursive-goal";

const ROOT_CAPABILITY = "probe.root";
const BRANCH_CAPABILITIES = { a: "probe.a", b: "probe.b", c: "probe.c" };

function validEvidenceRefs(input) {
  return input.evidence
    .filter((item) => item.validity === "valid")
    .map((item) => item.id);
}

function probeEvaluation(input, calls, memory) {
  const completed = Array.isArray(input.state?.completed)
    ? [...input.state.completed]
    : [];
  const conditions = Array.isArray(input.conditions)
    ? input.conditions.map((item) => ({ id: item.conditionId, fact: item.fact }))
    : [];
  memory.evaluatorObservations ??= [];
  memory.evaluatorObservations.push({
    target: input.goal.kind === "probe-root" ? "root" : input.goal.branch,
    completed,
    conditions,
  });

  const rootComplete =
    input.goal.kind === "probe-root" &&
    input.conditions.length > 0 &&
    input.conditions.every((item) => item.fact === "satisfied");
  const branch = input.goal.branch;
  const branchComplete = branch !== undefined && completed.includes(branch);
  const complete = rootComplete || branchComplete;

  return {
    evaluatorId: "probe-evaluator",
    result: complete ? "satisfied" : "unsatisfied",
    satisfaction: complete ? 100 : 0,
    necessaryConditionsMet: complete,
    evidenceRefs: complete ? validEvidenceRefs(input) : [],
  };
}

function condition(id, branch, input, overrides = {}) {
  return {
    id,
    goal: {
      kind: "probe-branch",
      capability: BRANCH_CAPABILITIES[branch],
      branch,
    },
    bindings: input.bindings,
    satisfactionThreshold: 100,
    evaluatorId: "probe-evaluator",
    selectorId: `${branch}-selector`,
    mode: "atomic",
    // Empty dependencies are the contract under test: A failure must not
    // prevent B from starting.
    dependsOn: [],
    lifetime: "stage",
    activation: "required",
    allowedEffects: [],
    ...overrides,
  };
}

function branchReceipt(branch, previousCompleted, additionalCompleted = []) {
  const branchStateId = `state-after-${branch}`;
  const completed = [
    ...new Set([...previousCompleted, ...additionalCompleted, branch]),
  ];
  const receipt = successfulAtomicReceipt({
    count: completed.length,
    stateId: branchStateId,
    evidenceId: `evidence-after-${branch}`,
    runId: `run-${branch}`,
  });
  receipt.sourceResult = {
    tag: `probe.${branch}-receipt`,
    value: { branch, executed: true },
  };
  receipt.newState = {
    id: branchStateId,
    value: { completed },
  };
  return receipt;
}

function isolationHarness({
  failA,
  bAdditionalCompleted = [],
  withDependentC = false,
  onlyA = false,
  failedAPost = false,
  nested = false,
}) {
  const fixture = createFixtureAdapter({
    evaluate: probeEvaluation,
    derive: (input) => {
      if (input.skill.id !== "compose-probe") {
        throw new TypeError(`unexpected derive target ${input.skill.id}`);
      }
      const inner = nested && input.goal.level === "inner";
      const first = nested && !inner
        ? condition("inner", "a", input, {
            goal: { kind: "probe-root", capability: ROOT_CAPABILITY, level: "inner" },
            selectorId: "root-selector", mode: "composite",
          })
        : condition("a", "a", input);
      const conditions = [first,
        ...(onlyA || inner ? [] : [condition("b", "b", input)]),
      ];
      if (withDependentC) {
        conditions.push(
          condition("c", "c", input, { dependsOn: ["a"] }),
        );
      }
      return {
        conditions,
        nextCursor: "closed",
        expansion: "closed",
      };
    },
    executeAtomic: (input) => {
      if (input.skill.id === "probe-a" && failA) {
        const post = failedAPost ? branchReceipt("a", input.state.completed) : null;
        return failedAtomicReceipt({
          runId: "run-a",
          ...(post === null ? {} : { newState: post.newState, evidence: post.evidence }),
          executionErrors: [
            diagnostic({
              diagnosticId: "probe-a-execution-error",
              code: "execution_failed",
              stage: "execution",
              sourceCategory: "probe.a",
              message: "A failed without effects",
              nativeCode: "E_PROBE_A_FAILURE",
              refs: ["fixture://probe-a"],
            }),
          ],
        });
      }
      if (input.skill.id === "probe-a") return branchReceipt("a", input.state.completed);
      if (input.skill.id === "probe-b") {
        return branchReceipt("b", input.state.completed, bAdditionalCompleted);
      }
      if (input.skill.id === "probe-c") return branchReceipt("c", input.state.completed);
      throw new TypeError(`unexpected execution target ${input.skill.id}`);
    },
  });
  const request = makeRequest({
    requestId: "recursive-error-isolation-probe",
    rootGoal: { kind: "probe-root", capability: ROOT_CAPABILITY },
    rootBindings: { scope: "probe" },
    state: { completed: [] },
    rootEvaluatorId: "probe-evaluator",
    rootSelectorId: "root-selector",
    limits: { maxTransitions: 32, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose-probe", "composite", {
        capability: ROOT_CAPABILITY,
        evaluatorId: "probe-evaluator",
      }),
      skill("probe-a", "atomic", {
        capability: BRANCH_CAPABILITIES.a,
        evaluatorId: "probe-evaluator",
      }),
      skill("probe-b", "atomic", {
        capability: BRANCH_CAPABILITIES.b,
        evaluatorId: "probe-evaluator",
      }),
      skill("probe-c", "atomic", {
        capability: BRANCH_CAPABILITIES.c,
        evaluatorId: "probe-evaluator",
      }),
    ],
    enabledEvaluators: [
      evaluator({
        id: "probe-evaluator",
        goalType: "probe-root",
        thresholdContract: "0..100",
      }),
    ],
    selectors: [
      selector("root-selector", ["compose-probe"]),
      selector("a-selector", ["probe-a"]),
      selector("b-selector", ["probe-b"]),
      selector("c-selector", ["probe-c"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

function lastObservation(fixture, target) {
  return fixture.memory.evaluatorObservations
    .filter((observation) => observation.target === target)
    .at(-1);
}

function rootAtomicFailureHarness() {
  const fixture = createFixtureAdapter({
    evaluate: probeEvaluation,
    executeAtomic: (input) => {
      if (input.skill.id === "probe-root-first") {
        return failedAtomicReceipt({
          runId: "run-root-atomic",
          executionErrors: [
            diagnostic({
              diagnosticId: "probe-root-atomic-execution-error",
              code: "execution_failed",
              stage: "execution",
              sourceCategory: "probe.root",
              message: "root atomic failed without effects",
              nativeCode: "E_PROBE_ROOT_ATOMIC_FAILURE",
              refs: ["fixture://probe-root-atomic"],
            }),
          ],
        });
      }
      if (input.skill.id === "probe-root-fallback") {
        return successfulAtomicReceipt({
          count: 1,
          stateId: "state-after-root-fallback",
          evidenceId: "evidence-after-root-fallback",
          runId: "run-root-fallback",
        });
      }
      throw new TypeError(`unexpected execution target ${input.skill.id}`);
    },
  });
  const request = makeRequest({
    requestId: "recursive-root-atomic-failure-probe",
    rootGoal: { kind: "probe-root", capability: ROOT_CAPABILITY },
    rootBindings: { scope: "probe" },
    state: { completed: [] },
    rootEvaluatorId: "probe-evaluator",
    rootSelectorId: "root-selector",
    limits: { maxTransitions: 32, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("probe-root-first", "atomic", {
        capability: ROOT_CAPABILITY,
        evaluatorId: "probe-evaluator",
      }),
      skill("probe-root-fallback", "atomic", {
        capability: ROOT_CAPABILITY,
        evaluatorId: "probe-evaluator",
      }),
    ],
    enabledEvaluators: [
      evaluator({
        id: "probe-evaluator",
        goalType: "probe-root",
        thresholdContract: "0..100",
      }),
    ],
    selectors: [
      selector("root-selector", ["probe-root-first", "probe-root-fallback"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

test("independent A and B both run and the root completes when neither fails", async () => {
  const { request, deps, fixture } = isolationHarness({ failA: false });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.deepEqual(
    report.atomicResults.map((result) => result.skillId).sort(),
    ["probe-a", "probe-b"],
  );
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(response);
});

test("A execution failure with no effects does not stop independent B or complete the root", async () => {
  const { request, deps, fixture } = isolationHarness({ failA: true });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  const originalError = report.errors.find(
    (error) => error.source.nativeCode === "E_PROBE_A_FAILURE",
  );
  assert.ok(originalError, "A's original execution error must be returned");
  assert.equal(originalError.code, "execution_failed");
  assert.equal(originalError.stage, "execution");
  assert.equal(originalError.effectKnowledge, "none");
  assert.equal(originalError.diagnosticMessage, "A failed without effects");
  assert.equal(originalError.source.category, "probe.a");

  const aResult = report.atomicResults.find(
    (result) => result.skillId === "probe-a",
  );
  assert.ok(aResult, "A's failed result must be preserved");
  assert.equal(aResult.outcome, "failed");
  assert.equal(aResult.sourceResult?.tag, "fixture.failure-receipt");
  assert.equal(aResult.sourceResult?.value?.token, "opaque-failure-receipt");
  assert.equal(aResult.effect.knowledge, "none");

  const bResult = report.atomicResults.find(
    (result) => result.skillId === "probe-b",
  );
  assert.ok(bResult, "independent B must execute after A fails");
  assert.equal(bResult.outcome, "succeeded");
  assert.equal(bResult.sourceResult?.tag, "probe.b-receipt");
  assert.equal(bResult.sourceResult?.value?.branch, "b");
  assert.equal(bResult.sourceResult?.value?.executed, true);
  assert.equal(
    fixture.calls.executeAtomic,
    2,
    "A failure with effect knowledge none must not stop independent B",
  );

  const aFrame = report.frames.find(
    (frame) => frame.fulfillsConditionId === "a",
  );
  const bFrame = report.frames.find(
    (frame) => frame.fulfillsConditionId === "b",
  );
  assert.ok(aFrame, "A's failed frame must be retained");
  assert.equal(aFrame.execution, "failed");
  assert.ok(bFrame, "B's completed frame must be retained");
  assert.equal(bFrame.execution, "completed");
  assert.equal(bFrame.fact, "satisfied");

  assert.notEqual(report.control.outcome, "completed");
  if (report.rootEvaluation.state === "evaluated") {
    assert.notEqual(report.rootEvaluation.result, "satisfied");
  }
  assertResponseReferencesClosed(response);
});

test("B observation satisfies A and B without replaying failed A and preserves A's error", async () => {
  const { request, deps, fixture } = isolationHarness({
    failA: true,
    bAdditionalCompleted: ["a"],
  });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.deepEqual(
    report.atomicResults.map((result) => result.skillId).sort(),
    ["probe-a", "probe-b"],
  );
  assert.deepEqual(lastObservation(fixture, "a"), {
    target: "a",
    completed: ["a", "b"],
    conditions: [],
  });
  assert.deepEqual(lastObservation(fixture, "root"), {
    target: "root",
    completed: ["a", "b"],
    conditions: [
      { id: "a", fact: "satisfied" },
      { id: "b", fact: "satisfied" },
    ],
  });

  const aResult = report.atomicResults.find(
    (result) => result.skillId === "probe-a",
  );
  const aError = report.errors.find(
    (error) => error.source.nativeCode === "E_PROBE_A_FAILURE",
  );
  const aFrame = report.frames.find(
    (frame) => frame.fulfillsConditionId === "a",
  );
  const rootFrame = report.frames.find((frame) => frame.depth === 0);

  assert.ok(aResult, "A's failed receipt must remain in the report");
  assert.equal(aResult.outcome, "failed");
  assert.equal(aResult.effect.knowledge, "none");
  assert.ok(aError, "A's original typed error must remain in the report");
  assert.equal(report.primaryErrorId, aError.errorId);
  assert.ok(aFrame, "A's failed frame must remain in the report");
  assert.equal(aFrame.execution, "failed");
  assert.equal(aFrame.fact, "satisfied");
  assert.equal(
    rootFrame.conditionResults.find((item) => item.conditionId === "a")?.fact,
    "satisfied",
  );
  assert.equal(
    rootFrame.conditionResults.find((item) => item.conditionId === "b")?.fact,
    "satisfied",
  );
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.control.stopReason, "root_evaluation");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(response);
});

test("same-state continuation after unresolved A does not replay A or B or rederive", async () => {
  const { request, deps, fixture } = isolationHarness({ failA: true });
  const firstResponse = await runRecursiveGoal(request, deps);
  const firstReport = responseReport(firstResponse);

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(fixture.calls.derive, 1);
  assert.equal(firstReport.control.outcome, "stalled");
  assert.equal(firstReport.control.stopReason, "no_progress");
  assert.deepEqual(lastObservation(fixture, "a"), {
    target: "a",
    completed: ["b"],
    conditions: [],
  });
  assert.ok(firstReport.continuation, "an unresolved A must return continuation state");

  const observationCount = fixture.memory.evaluatorObservations.length;
  const secondResponse = await runRecursiveGoal(
    { ...request, continuation: firstReport.continuation },
    deps,
  );
  const secondReport = responseReport(secondResponse);
  const originalAError = secondReport.errors.find(
    (error) => error.source.nativeCode === "E_PROBE_A_FAILURE",
  );

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(fixture.calls.derive, 1);
  assert.equal(
    fixture.memory.evaluatorObservations.length,
    observationCount,
    "same-state continuation must not consume the same facts again",
  );
  assert.equal(secondReport.atomicResults.length, 2);
  assert.equal(secondReport.control.stopReason, "no_progress");
  assert.ok(originalAError, "continuation must retain A's original typed error");
  assert.equal(secondReport.primaryErrorId, originalAError.errorId);
  assertResponseReferencesClosed(secondResponse);
});

test("dependent C stays unexecuted while independent B runs after A fails", async () => {
  const { request, deps, fixture } = isolationHarness({
    failA: true,
    withDependentC: true,
  });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.deepEqual(
    report.atomicResults.map((result) => result.skillId).sort(),
    ["probe-a", "probe-b"],
  );
  assert.deepEqual(lastObservation(fixture, "a"), {
    target: "a",
    completed: ["b"],
    conditions: [],
  });
  assert.deepEqual(lastObservation(fixture, "root"), {
    target: "root",
    completed: ["b"],
    conditions: [
      { id: "a", fact: "unsatisfied" },
      { id: "b", fact: "satisfied" },
      { id: "c", fact: "unknown" },
    ],
  });
  assert.equal(lastObservation(fixture, "c"), undefined);

  const cFrame = report.frames.find(
    (frame) => frame.fulfillsConditionId === "c",
  );
  assert.ok(cFrame, "C's dependent frame must remain visible");
  assert.equal(cFrame.execution, "not_started");
  assert.equal(cFrame.unexecutedReason, "dependency_not_met");
  assert.equal(report.control.outcome, "stalled");
  assert.equal(report.control.stopReason, "no_progress");
  assertResponseReferencesClosed(response);
});

test("a failed child consumes its own trusted post without needing another sibling", async () => {
  const { request, deps, fixture } = isolationHarness({ failA: true, onlyA: true, failedAPost: true });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "completed");
  assert.equal(fixture.calls.executeAtomic, 1);
  const child = report.frames.find(frame => frame.fulfillsConditionId === "a");
  assert.equal(child.fact, "satisfied");
  assert.equal(child.execution, "failed");
  assert.equal(report.atomicResults[0].outcome, "failed");
  assert.equal(report.primaryErrorId, child.errorId);
  assert.ok(report.errors.some(error => error.source.nativeCode === "E_PROBE_A_FAILURE"));
  assertResponseReferencesClosed(response);
});

test("an exhausted nested failure subtree lets its ancestor run independent B", async () => {
  const { request, deps, fixture } = isolationHarness({ failA: true, nested: true });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.deepEqual(report.atomicResults.map(item => item.skillId), ["probe-a", "probe-b"]);
  assert.equal(report.control.stopReason, "no_progress");
  assert.notEqual(report.rootEvaluation.result, "satisfied");
  const before = fixture.calls.executeAtomic;
  const resumed = await runRecursiveGoal({ ...request, continuation: report.continuation }, deps);
  assert.equal(fixture.calls.executeAtomic, before);
  assert.equal(responseReport(resumed).control.stopReason, "no_progress");
  assertResponseReferencesClosed(response);
  assertResponseReferencesClosed(resumed);
});

test("ancestor B supplies new facts that close a parked subtree without replaying its failed leaf", async () => {
  const { request, deps, fixture } = isolationHarness({
    failA: true, nested: true, bAdditionalCompleted: ["a"],
  });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "completed");
  assert.deepEqual(report.atomicResults.map(item => item.skillId), ["probe-a", "probe-b"]);
  assert.equal(fixture.calls.executeAtomic, 2);
  const leaf = report.frames.find(frame => frame.fulfillsConditionId === "a");
  assert.equal(leaf.execution, "failed");
  assert.equal(leaf.fact, "satisfied");
  assert.equal(report.primaryErrorId, leaf.errorId);
  assertResponseReferencesClosed(response);
});

test("root atomic failed with no effects keeps the original stop boundary", async () => {
  const { request, deps, fixture } = rootAtomicFailureHarness();
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  const originalError = report.errors.find(
    (error) => error.source.nativeCode === "E_PROBE_ROOT_ATOMIC_FAILURE",
  );
  const rootFrame = report.frames.find((frame) => frame.depth === 0);

  assert.equal(fixture.calls.derive, 0);
  assert.equal(fixture.calls.select, 1);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.atomicResults.length, 1);
  assert.equal(report.atomicResults[0].skillId, "probe-root-first");
  assert.ok(originalError, "the root atomic error must be preserved");
  assert.ok(rootFrame, "the failed root frame must remain in the report");
  assert.equal(rootFrame.execution, "failed");
  assert.equal(rootFrame.selectedSkillId, "probe-root-first");
  assert.equal(rootFrame.errorId, originalError.errorId);
  assert.equal(report.primaryErrorId, originalError.errorId);
  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assertResponseReferencesClosed(response);
});
