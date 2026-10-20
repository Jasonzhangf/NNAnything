import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  evaluator,
  makeRequest,
  responseReport,
  selector,
  skill,
} from "./recursive-goal-fixtures.mjs";

async function loadPublicApi() {
  return import("nnanything/recursive-goal");
}

function comparators() {
  return {
    sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function dependencies(adapter, {
  enabledSkills,
  selectors,
  grantedEffects,
}) {
  return {
    adapter,
    enabledSkills,
    enabledEvaluators: [evaluator()],
    selectors,
    comparators: comparators(),
    grantedEffects,
  };
}

function condition(input, allowedEffects) {
  return {
    id: "write-child",
    goal: input.goal,
    bindings: input.bindings,
    satisfactionThreshold: 100,
    evaluatorId: "counter-evaluator",
    selectorId: "write-selector",
    mode: "atomic",
    dependsOn: [],
    lifetime: "stage",
    activation: "required",
    allowedEffects,
  };
}

test("derived condition with an explicit empty effect set denies a granted write", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) => ({
      conditions: [condition(input, [])],
      nextCursor: "closed",
      expansion: "closed",
    }),
  });
  const response = await api.runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-counter", "composite", {
          allowedEffects: ["fixture.write"],
        }),
        skill("write-counter", "atomic", {
          allowedEffects: ["fixture.write"],
          requiredEffects: ["fixture.write"],
          effectClass: "mutating",
        }),
      ],
      selectors: [
        selector("root-selector", ["compose-counter"]),
        selector("write-selector", ["write-counter"]),
      ],
      grantedEffects: new Set(["fixture.write"]),
    }),
  );
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.atomicResults.length, 0);
  assert.equal(report.control.outcome, "error");
  assert.equal(report.errors.some(error => error.code === "effect_denied"), true);
  assertResponseReferencesClosed(response);
});

test("empty composite skill allowed effects denies a descendant write", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) => ({
      conditions: [condition(input, ["fixture.write"])],
      nextCursor: "closed",
      expansion: "closed",
    }),
  });
  const response = await api.runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-counter", "composite"),
        skill("write-counter", "atomic", {
          allowedEffects: ["fixture.write"],
          requiredEffects: ["fixture.write"],
          effectClass: "mutating",
        }),
      ],
      selectors: [
        selector("root-selector", ["compose-counter"]),
        selector("write-selector", ["write-counter"]),
      ],
      grantedEffects: new Set(["fixture.write"]),
    }),
  );
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.atomicResults.length, 0);
  assert.equal(report.control.outcome, "error");
  assert.equal(report.errors.some(error => error.code === "effect_denied"), true);
  assertResponseReferencesClosed(response);
});
