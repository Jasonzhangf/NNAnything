import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecursiveGoal } from "nnanything/recursive-goal";
import { counterGoal, createFixtureAdapter, evaluator, makeRequest, responseReport, selector, singleChildDerivation, skill, successfulAtomicReceipt } from "./recursive-goal-fixtures.mjs";

function harness() {
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
      if (input.goal.role === "A" && input.state.count === 0) {
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
  return { request, deps, executions };
}

test("trace preserves the observed blocked and resumed branch history", async () => {
  const { request, deps, executions } = harness();
  const records = [];
  deps.trace = { segmentId: "branches", emit(event) { records.push(event); } };

  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);
  assert.deepEqual(executions, ["B", "A"]);

  const definitions = records.filter(event => event.payload.kind === "frame_defined");
  const rootDefinition = definitions.find(event => event.payload.details.parentFrameRef === null);
  assert.ok(rootDefinition);
  const childDefinitions = definitions.filter(event => event.payload.frameRef !== rootDefinition.payload.frameRef);
  for (const definition of childDefinitions) {
    assert.equal(definition.payload.details.parentFrameRef, rootDefinition.payload.frameRef);
  }

  const aDefinition = childDefinitions.find(event => event.payload.details.goal.role === "A");
  assert.ok(aDefinition);
  const branchStates = records
    .filter(event =>
      event.payload.kind === "branch_changed" &&
      event.payload.frameRef === aDefinition.payload.frameRef)
    .map(event => event.payload.details.state);
  const blockedAt = branchStates.indexOf("blocked");
  const resumedAt = branchStates.indexOf("resumed");
  assert.ok(blockedAt >= 0);
  assert.ok(resumedAt > blockedAt);

  const resumed = records.find(event =>
    event.payload.kind === "branch_changed" &&
    event.payload.frameRef === aDefinition.payload.frameRef &&
    event.payload.details.state === "resumed");
  assert.equal(resumed.payload.details.reason, "facts_changed");

  const ended = records.find(event => event.payload.kind === "segment_ended");
  assert.ok(ended);
  assert.deepEqual(ended.payload.details.control, report.control);
});
