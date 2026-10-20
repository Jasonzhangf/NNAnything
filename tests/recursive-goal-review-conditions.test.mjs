import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  counterGoal,
  createFixtureAdapter,
  evaluator,
  initialObservation,
  makeRequest,
  responseReport,
  selector,
  skill,
  successfulAtomicReceipt,
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

function dependencies(adapter, {
  enabledSkills,
  selectors,
  enabledEvaluators = [evaluator()],
}) {
  return {
    adapter,
    enabledSkills,
    enabledEvaluators,
    selectors,
    comparators: comparators(),
    grantedEffects: new Set(),
  };
}

function condition({
  id,
  goal,
  bindings,
  mode,
  selectorId,
  evaluatorId = "counter-evaluator",
  lifetime = "stage",
  activation = "required",
}) {
  return {
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId,
    selectorId,
    mode,
    dependsOn: [],
    lifetime,
    activation,
    allowedEffects: [],
  };
}

function derivation(conditions) {
  return {
    conditions,
    nextCursor: "closed",
    expansion: "closed",
  };
}

function validEvidenceRefs(input) {
  return input.evidence
    .filter((item) => item.validity === "valid")
    .map((item) => item.id);
}

test("a locally satisfied parent cannot complete while a required child is unsatisfied", async () => {
  const api = await loadPublicApi();
  const rootGoal = counterGoal(1);
  const requiredGoal = counterGoal(2);
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "required-target-two",
          goal: requiredGoal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "child-selector",
        }),
      ]),
  });
  const request = makeRequest({
    rootGoal,
    state: { count: 0 },
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-root", "composite"),
        skill("increment-counter", "atomic"),
      ],
      selectors: [
        selector("root-selector", ["compose-root"]),
        selector("child-selector", ["increment-counter"]),
      ],
    }),
  );
  const report = responseReport(response);
  const rootFrame = report.frames.find((frame) => frame.depth === 0);
  const required = rootFrame?.conditionResults.find(
    (item) => item.conditionId === "required-target-two",
  );

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.equal(required?.fact, "unsatisfied");
  assert.deepEqual(rootFrame?.unresolvedRequirements, ["required-target-two"]);
  assert.ok(
    report.errors.some((error) => error.source.category === "unresolved_requirements"),
  );
  assertResponseReferencesClosed(response);
});

test("an initially satisfied root with no declared obligations keeps the zero-action path", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest({
    state: { count: 1 },
    initialObservation: initialObservation(),
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [],
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "completed");
  assert.equal(report.control.stopReason, "root_evaluation");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(fixture.calls.evaluate, 1);
  assert.equal(fixture.calls.derive, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

function nestedPersistentFixture({ invalidateAfterOuter, middleObservations }) {
  const rootGoal = {
    kind: "chain-root",
    capability: "chain.root",
    target: 1,
  };
  const middleGoal = {
    kind: "chain-middle",
    capability: "chain.middle",
    target: 1,
  };
  const innerGoal = {
    kind: "guarded-inner",
    capability: "counter.increment",
    target: 1,
  };
  const mutateGoal = {
    kind: "chain-mutate",
    capability: "chain.mutate",
    target: 2,
  };

  const fixture = createFixtureAdapter({
    derive: (input) => {
      if (input.skill.id === "compose-root") {
        const conditions = [
          condition({
            id: "outer",
            goal: middleGoal,
            bindings: input.bindings,
            mode: "composite",
            selectorId: "middle-selector",
            evaluatorId: "middle-evaluator",
            lifetime: "persistent",
          }),
        ];
        conditions.push(
          invalidateAfterOuter
            ? condition({
                id: "mutate",
                goal: mutateGoal,
                bindings: input.bindings,
                mode: "atomic",
                selectorId: "mutate-selector",
                evaluatorId: "mutate-evaluator",
              })
            : condition({
                id: "inner",
                goal: innerGoal,
                bindings: input.bindings,
                mode: "atomic",
                selectorId: "inner-selector",
                activation: "not_applicable",
              }),
        );
        return derivation(conditions);
      }
      if (input.skill.id === "compose-middle") {
        return derivation([
          condition({
            id: "inner",
            goal: innerGoal,
            bindings: input.bindings,
            mode: "atomic",
            selectorId: "inner-selector",
            lifetime: "persistent",
          }),
        ]);
      }
      throw new TypeError(`unexpected derive skill ${input.skill.id}`);
    },
    evaluate: (input, calls) => {
      calls.evaluate += 1;
      const count =
        typeof input.state?.count === "number" ? input.state.count : 0;
      let result;
      if (input.goal.kind === "chain-middle") {
        middleObservations.push(
          input.conditions.map((item) => item.conditionId),
        );
        const inner = input.conditions.find(
          (item) => item.conditionId === "inner",
        );
        result = inner?.fact === "satisfied" ? "satisfied" : "unsatisfied";
      } else if (input.goal.kind === "guarded-inner") {
        result =
          input.state?.guard !== "broken" && count >= input.goal.target
            ? "satisfied"
            : "unsatisfied";
      } else if (input.goal.kind === "chain-mutate") {
        result = count >= input.goal.target ? "satisfied" : "unsatisfied";
      } else {
        result = count >= input.goal.target ? "satisfied" : "unsatisfied";
      }
      return {
        evaluatorId: input.goal.kind === "chain-middle"
          ? "middle-evaluator"
          : input.goal.kind === "chain-mutate"
            ? "mutate-evaluator"
            : "counter-evaluator",
        result,
        satisfaction: result === "satisfied" ? 100 : 0,
        necessaryConditionsMet: result === "satisfied",
        evidenceRefs: validEvidenceRefs(input),
      };
    },
    executeAtomic: (input, calls, memory) => {
      if (input.skill.id === "mutate-guard") {
        return {
          ...successfulAtomicReceipt({
            count: 2,
            stateId: "state-after-mutate",
            evidenceId: "evidence-after-mutate",
            runId: "fixture-mutate",
          }),
          newState: {
            id: "state-after-mutate",
            value: { count: 2, guard: "broken" },
          },
        };
      }
      memory.innerExecuted = true;
      return {
        ...successfulAtomicReceipt({
          count: 1,
          stateId: "state-after-inner",
          evidenceId: "evidence-after-inner",
          runId: "fixture-inner",
        }),
        newState: {
          id: "state-after-inner",
          value: { count: 1, guard: "ok" },
        },
      };
    },
  });

  const request = makeRequest({
    requestId: invalidateAfterOuter ? "persistent-deep-invalid" : "persistent-own-conditions",
    rootGoal,
    state: { count: 0, guard: "ok" },
    limits: {
      maxTransitions: 32,
      maxDepth: 8,
      maxDerivedGoals: 8,
    },
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-root", "composite", { capability: "chain.root" }),
      skill("compose-middle", "composite", {
        capability: "chain.middle",
        evaluatorId: "middle-evaluator",
      }),
      skill("increment-counter", "atomic", { capability: "counter.increment" }),
      skill("mutate-guard", "atomic", {
        capability: "chain.mutate",
        evaluatorId: "mutate-evaluator",
      }),
    ],
    selectors: [
      selector("root-selector", ["compose-root"]),
      selector("middle-selector", ["compose-middle"]),
      selector("inner-selector", ["increment-counter"]),
      selector("mutate-selector", ["mutate-guard"]),
    ],
    enabledEvaluators: [
      evaluator(),
      evaluator({ id: "middle-evaluator" }),
      evaluator({ id: "mutate-evaluator" }),
    ],
  });
  return { request, deps, fixture };
}

test("persistent composite revalidation uses the child condition facts, not the parent facts", async () => {
  const api = await loadPublicApi();
  const middleObservations = [];
  const { request, deps, fixture } = nestedPersistentFixture({
    invalidateAfterOuter: false,
    middleObservations,
  });

  const response = await api.runRecursiveGoal(request, deps);
  const report = responseReport(response);
  const middleFrame = report.frames.find(
    (frame) => frame.goal.kind === "chain-middle",
  );
  const inner = middleFrame?.conditionResults.find(
    (item) => item.conditionId === "inner",
  );

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(inner?.fact, "satisfied");
  assert.ok(
    middleObservations.every((ids) => !ids.includes("outer")),
    "middle evaluator must never receive the parent condition set",
  );
  assert.ok(
    middleObservations.some((ids) => ids.length === 1 && ids[0] === "inner"),
    "middle evaluator must receive its own condition facts",
  );
  assertResponseReferencesClosed(response);
});

test("a later State change invalidates a deeper persistent condition before the root completes", async () => {
  const api = await loadPublicApi();
  const middleObservations = [];
  const { request, deps, fixture } = nestedPersistentFixture({
    invalidateAfterOuter: true,
    middleObservations,
  });

  const response = await api.runRecursiveGoal(request, deps);
  const report = responseReport(response);
  const rootFrame = report.frames.find((frame) => frame.depth === 0);
  const middleFrame = report.frames.find(
    (frame) => frame.goal.kind === "chain-middle",
  );
  const outer = rootFrame?.conditionResults.find(
    (item) => item.conditionId === "outer",
  );
  const inner = middleFrame?.conditionResults.find(
    (item) => item.conditionId === "inner",
  );

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(report.control.outcome, "error");
  assert.notEqual(report.control.outcome, "completed");
  assert.equal(inner?.fact, "unsatisfied");
  assert.equal(outer?.fact, "unsatisfied");
  assert.ok(
    report.errors.some((error) => error.source.category === "persistent_condition"),
  );
  assert.ok(
    middleObservations.every((ids) => !ids.includes("outer")),
    "deep revalidation must keep each frame's own condition set",
  );
  assertResponseReferencesClosed(response);
});
