import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  evaluator,
  initialObservation,
  makeRequest,
  selector,
  skill,
} from "./recursive-goal-fixtures.mjs";

let publicApi;

async function loadPublicApi() {
  publicApi ??= await import("nnanything/recursive-goal");
  return publicApi;
}

function comparators() {
  return {
    sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function dependencies(adapter, { enabledSkills, selectors, signal } = {}) {
  return {
    adapter,
    enabledSkills,
    enabledEvaluators: [evaluator()],
    selectors,
    comparators: comparators(),
    grantedEffects: new Set(),
    ...(signal === undefined ? {} : { signal }),
  };
}

function responseReport(response) {
  assert.equal(
    response.kind,
    "run_result",
    `expected run_result, received ${response.kind}: ${JSON.stringify(
      response.error ?? response.fault ?? null,
    )}`,
  );
  return response.report;
}

function rootFrame(report) {
  return report.frames.find((frame) => frame.depth === 0);
}

const enabledSkills = [skill("increment-counter", "atomic")];
const selectors = [selector("root-selector", ["increment-counter"])];

test("pre-selection baseline resumes after the transition budget is increased", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const firstRequest = makeRequest({
    limits: {
      maxTransitions: 1,
      maxDepth: 8,
      maxDerivedGoals: 8,
    },
  });

  const firstResponse = await api.runRecursiveGoal(
    firstRequest,
    dependencies(fixture.adapter, { enabledSkills, selectors }),
  );
  const firstReport = responseReport(firstResponse);

  assert.equal(firstReport.control.outcome, "exceeded");
  assert.equal(firstReport.control.stopReason, "budget");
  assert.equal(firstReport.budgetUsed.transitionsUsed, 1);
  assert.equal(fixture.calls.evaluate, 1);
  assert.equal(fixture.calls.select, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.ok(firstReport.continuation);
  assert.equal(firstReport.continuation.budgetUsed.transitionsUsed, 1);
  assert.equal(firstReport.continuation.stack.at(-1).phase, "select");
  assert.equal(firstReport.continuation.frames[0].selectedSkillId, null);
  assert.notEqual(
    firstReport.continuation.frameControls[0].progressBaseline,
    null,
  );
  assertResponseReferencesClosed(firstResponse);

  const secondResponse = await api.runRecursiveGoal(
    {
      ...firstRequest,
      continuation: firstReport.continuation,
      limits: {
        maxTransitions: 16,
        maxDepth: 8,
        maxDerivedGoals: 8,
      },
    },
    dependencies(fixture.adapter, { enabledSkills, selectors }),
  );
  const secondReport = responseReport(secondResponse);

  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(secondReport.rootEvaluation.state, "evaluated");
  assert.equal(secondReport.rootEvaluation.result, "satisfied");
  assert.equal(
    secondReport.budgetUsed.transitionsUsed >
      firstReport.budgetUsed.transitionsUsed,
    true,
  );
  assert.equal(
    secondReport.budgetUsed.transitionsUsed >=
      firstReport.budgetUsed.transitionsUsed + 1,
    true,
  );
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(secondReport.continuation, null);
  assertResponseReferencesClosed(secondResponse);
});

test("cancellation after the first evaluation resumes without losing root evidence or budget", async () => {
  const api = await loadPublicApi();
  const controller = new AbortController();
  const fixture = createFixtureAdapter({
    evaluate: (input, calls) => {
      calls.evaluate += 1;
      const count = typeof input.state?.count === "number" ? input.state.count : 0;
      const target = typeof input.goal?.target === "number" ? input.goal.target : 0;
      const result = count >= target ? "satisfied" : "unsatisfied";
      if (calls.evaluate === 1) controller.abort();
      return {
        evaluatorId: "counter-evaluator",
        result,
        satisfaction: result === "satisfied" ? 100 : 0,
        necessaryConditionsMet: result === "satisfied",
        evidenceRefs: input.evidence
          .filter((item) => item.validity === "valid")
          .map((item) => item.id),
      };
    },
  });
  const firstRequest = makeRequest({
    state: { count: 0 },
    initialObservation: initialObservation({ count: 0 }),
  });

  const firstResponse = await api.runRecursiveGoal(
    firstRequest,
    dependencies(fixture.adapter, {
      enabledSkills,
      selectors,
      signal: controller.signal,
    }),
  );
  const firstReport = responseReport(firstResponse);

  assert.equal(firstReport.control.outcome, "cancelled");
  assert.equal(firstReport.control.stopReason, "cancel");
  assert.equal(firstReport.budgetUsed.transitionsUsed, 1);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(firstReport.rootEvaluation.state, "evaluated");
  assert.equal(firstReport.rootEvaluation.result, "unsatisfied");
  assert.equal(
    firstReport.evidence.some((item) => item.id === "fixture-initial-evidence"),
    true,
  );
  assert.ok(firstReport.continuation);
  assert.equal(firstReport.continuation.stack.at(-1).phase, "select");
  assert.equal(firstReport.continuation.frames[0].selectedSkillId, null);
  assert.notEqual(
    firstReport.continuation.frameControls[0].progressBaseline,
    null,
  );
  assertResponseReferencesClosed(firstResponse);

  const secondResponse = await api.runRecursiveGoal(
    makeRequest({
      state: { count: 0 },
      continuation: firstReport.continuation,
    }),
    dependencies(fixture.adapter, { enabledSkills, selectors }),
  );
  const secondReport = responseReport(secondResponse);
  const resumedRoot = rootFrame(secondReport);

  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(secondReport.rootEvaluation.state, "evaluated");
  assert.equal(secondReport.rootEvaluation.result, "satisfied");
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(
    secondReport.budgetUsed.transitionsUsed >
      firstReport.budgetUsed.transitionsUsed,
    true,
  );
  assert.ok(resumedRoot);
  assert.equal(
    resumedRoot.evidenceRefs.includes("fixture-initial-evidence"),
    true,
  );
  assert.equal(
    secondReport.evidence.some((item) => item.id === "fixture-initial-evidence"),
    true,
  );
  assert.equal(
    secondReport.states.some((item) => item.id === "fixture-initial-state"),
    true,
  );
  assert.equal(secondReport.continuation, null);
  assertResponseReferencesClosed(secondResponse);
});
