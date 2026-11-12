import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecursiveGoal } from "nnanything/recursive-goal";
import { assertResponseReferencesClosed, counterGoal, createFixtureAdapter, evaluator, makeRequest, responseReport, selector, singleChildDerivation, skill, successfulAtomicReceipt } from "./recursive-goal-fixtures.mjs";

function harness({ remainDeferred = false } = {}) {
  const selections = [];
  const executions = [];
  const fixture = createFixtureAdapter({
    derive(input) {
      const parts = ["A", "B"].map(id => singleChildDerivation({
        id, goal: counterGoal(id === "A" ? 2 : 1, { role: id }),
        bindings: input.bindings, selectorId: `${id}-selector`,
      }).conditions[0]);
      return { conditions: parts, nextCursor: "closed", expansion: "closed" };
    },
    select(input) {
      selections.push(input.goal.role);
      if (input.goal.role === "A" && (input.state.count === 0 || remainDeferred)) {
        return { kind: "defer", reason: "declaration evidence is not yet available" };
      }
      return { kind: "selected", skillId: input.candidates[0].id };
    },
    executeAtomic(input) {
      executions.push(input.goal.role);
      return successfulAtomicReceipt({
        count: input.state.count + 1,
        stateId: `state-${input.goal.role}`, evidenceId: `evidence-${input.goal.role}`,
        runId: `run-${input.goal.role}`,
      });
    },
  });
  const request = makeRequest({
    rootGoal: counterGoal(2, { role: "root" }),
    limits: { maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 4 },
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [skill("compose", "composite"), skill("read-A", "atomic"), skill("read-B", "atomic")],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["compose"]), selector("A-selector", ["read-A"]), selector("B-selector", ["read-B"])],
    grantedEffects: new Set(),
    comparators: {
      sameGoal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameBindings: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameFacts: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    },
  };
  return { request, deps, selections, executions };
}

test("A defers before B runs; B supplies evidence and A is reconsidered in the same request", async () => {
  const { request, deps, executions, selections } = harness();
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.deepEqual(executions, ["B", "A"], JSON.stringify({ selections, control: report.control, errors: report.errors }));
  assert.deepEqual(selections, ["root", "A", "B", "A"]);
  assert.equal(report.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(response);
});

test("still deferred A stops without looping and preserves B and its original deferral", async () => {
  const { request, deps, executions, selections } = harness({ remainDeferred: true });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.deepEqual(executions, ["B"]);
  assert.deepEqual(selections, ["root", "A", "B", "A"]);
  assert.equal(report.control.stopReason, "no_progress");
  assert.ok(report.errors.some(e => e.code === "policy_deferred"));
  assert.ok(report.continuation.remainingRequirements.some(c => c.conditionId === "A"));
  assert.equal(report.atomicResults.length, 1);
  assertResponseReferencesClosed(response);
  const resumed = await runRecursiveGoal({ ...request, continuation: report.continuation }, deps);
  assertResponseReferencesClosed(resumed);
  assert.equal(responseReport(resumed).control.stopReason, "no_progress");
  assert.deepEqual(executions, ["B"], "same-state continuation must not replay B");
});
