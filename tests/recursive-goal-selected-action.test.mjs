import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecursiveGoal } from "nnanything/recursive-goal";
import { createFixtureAdapter, evaluator, makeRequest, responseReport, selector, skill, successfulAtomicReceipt } from "./recursive-goal-fixtures.mjs";

function deps(adapter, mode = "atomic") {
  return {
    adapter,
    enabledSkills: [skill("read-target", mode)],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["read-target"])],
    grantedEffects: new Set(),
    comparators: {
      sameGoal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameBindings: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameFacts: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    },
  };
}

test("selected object and parameters reach the same atomic execution without reselection", async () => {
  const decision = { target: "B", parameters: { path: "b.ts" } };
  const executed = [];
  let selectedFrame;
  const fixture = createFixtureAdapter({
    select(input) {
      selectedFrame = input.context.frameId;
      return { kind: "selected", skillId: "read-target", decision };
    },
    executeAtomic(input) {
      assert.equal(input.context.frameId, selectedFrame);
      assert.deepEqual(input.decision, decision);
      assert.ok(Object.isFrozen(input.decision.parameters));
      executed.push(input.decision.target);
      return successfulAtomicReceipt();
    },
  });
  const report = responseReport(await runRecursiveGoal(makeRequest(), deps(fixture.adapter)));
  assert.deepEqual(executed, ["B"]);
  assert.equal(fixture.calls.select, 1);
  assert.equal(report.rootEvaluation.result, "satisfied");
});

test("legacy atomic selection without decision retains its original callback shape", async () => {
  const fixture = createFixtureAdapter({
    executeAtomic(input) {
      assert.equal(Object.hasOwn(input, "decision"), false);
      return successfulAtomicReceipt();
    },
  });
  const report = responseReport(await runRecursiveGoal(makeRequest(), deps(fixture.adapter)));
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(fixture.calls.executeAtomic, 1);
});

test("unsupported composite decision is rejected before derive rather than silently lost", async () => {
  const fixture = createFixtureAdapter({
    select: () => ({ kind: "selected", skillId: "read-target", decision: { target: "B" } }),
  });
  const report = responseReport(await runRecursiveGoal(makeRequest(), deps(fixture.adapter, "composite")));
  assert.equal(fixture.calls.derive, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.control.outcome, "error");
});
