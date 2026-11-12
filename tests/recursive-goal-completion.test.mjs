import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectRecursiveGoalCompletion,
  runRecursiveGoal,
} from "nnanything/recursive-goal";
import {
  assertResponseReferencesClosed,
  counterGoal,
  createFiniteBudgetHarness,
  createFixtureAdapter,
  evaluator,
  failedAtomicReceipt,
  initialObservation,
  makeRequest,
  responseReport,
  selector,
  skill,
  successfulAtomicReceipt,
} from "./recursive-goal-fixtures.mjs";

function comparators() {
  return {
    sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function dependencies(adapter, {
  enabledSkills = [],
  enabledEvaluators = [evaluator()],
  selectors = [],
  grantedEffects = new Set(),
} = {}) {
  return {
    adapter,
    enabledSkills,
    enabledEvaluators,
    selectors,
    comparators: comparators(),
    grantedEffects,
  };
}

function condition({
  id,
  goal,
  bindings,
  selectorId,
  mode = "atomic",
  lifetime = "stage",
  activation = "required",
}) {
  return {
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId: "counter-evaluator",
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

function evaluated(result, input) {
  return {
    evaluatorId: "counter-evaluator",
    result,
    satisfaction: result === "satisfied" ? 100 : result === "unsatisfied" ? 0 : null,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: result === "satisfied" ? validEvidenceRefs(input) : [],
  };
}

test("root satisfaction completes without execution or condition accounting", async () => {
  const fixture = createFixtureAdapter();
  const response = await runRecursiveGoal(
    makeRequest({
      state: { count: 1 },
      initialObservation: initialObservation(),
    }),
    dependencies(fixture.adapter, {
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);
  const summary = projectRecursiveGoalCompletion(report);

  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(summary.completion, "complete");
  assert.equal(summary.conditionAccounting, "unavailable");
  assert.equal(summary.report, report);
  assert.equal(summary.rootEvaluation, report.rootEvaluation);
  assert.equal(summary.control, report.control);
  assert.equal(summary.errors, report.errors);
  assert.equal(summary.stopReason, report.control.stopReason);
  assertResponseReferencesClosed(response);
});

test("a verified closed root can complete while retaining an execution error", async () => {
  const fixture = createFixtureAdapter({
    executeAtomic() {
      const observed = successfulAtomicReceipt({ count: 1 });
      return failedAtomicReceipt({ newState: observed.newState, evidence: observed.evidence });
    },
  });
  const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    enabledSkills: [skill("observe-goal", "atomic")],
    selectors: [selector("root-selector", ["observe-goal"])],
  }));
  const report = responseReport(response);
  const summary = projectRecursiveGoalCompletion(report);
  assert.equal(report.control.outcome, "error");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(report.atomicResults[0].outcome, "failed");
  assert.equal(summary.completion, "complete");
  assert.equal(summary.errors, report.errors);
  assert.ok(summary.report.primaryErrorId);
  assertResponseReferencesClosed(response);
});

test("root satisfaction cannot override an unresolved required condition", async () => {
  const requiredGoal = counterGoal(2);
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "required-target-two",
          goal: requiredGoal,
          bindings: input.bindings,
          selectorId: "child-selector",
        }),
      ]),
  });
  const response = await runRecursiveGoal(
    makeRequest({ state: { count: 0 } }),
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
  const unresolved = rootFrame.conditionResults.find(
    (item) => item.conditionId === "required-target-two",
  );
  const summary = projectRecursiveGoalCompletion(report);

  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(report.control.outcome, "error");
  assert.ok(report.primaryErrorId);
  assert.equal(unresolved.fact, "unsatisfied");
  assert.equal(summary.completion, "incomplete");
  assert.equal(summary.stopReason, "fatal_error");
  assert.equal(summary.control, report.control);
  assert.equal(summary.errors, report.errors);
  assert.equal(summary.report, report);
  assert.ok(
    summary.remainingItems.some(
      (item) =>
        item.kind === "condition" &&
        item.frameId === rootFrame.frameId &&
        item.conditionId === "required-target-two" &&
        item.evaluation.fact === "unsatisfied",
    ),
  );
  assertResponseReferencesClosed(response);
});

test("an exhaustive empty query can complete while preserving its empty result and coverage evidence", async () => {
  const stateId = "state-empty-query";
  const evidenceId = "evidence-empty-query";
  const fixture = createFixtureAdapter({
    evaluate: (input) =>
      evaluated(
        input.state.coverage === "complete" && input.state.matches.length === 0
          ? "satisfied"
          : "unsatisfied",
        input,
      ),
  });
  const response = await runRecursiveGoal(
    makeRequest({
      requestId: "completion-empty-query",
      rootGoal: {
        kind: "empty-query",
        capability: "empty.query",
        query: "needle",
      },
      state: {
        matches: [],
        coverage: "complete",
      },
      initialObservation: {
        stateId,
        evidence: [
          {
            id: evidenceId,
            stateRef: stateId,
            payload: {
              matches: [],
              coverage: "complete",
            },
            validity: "valid",
          },
        ],
      },
    }),
    dependencies(fixture.adapter, {
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);
  const summary = projectRecursiveGoalCompletion(report);

  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.deepEqual(report.rootEvaluation.evidenceRefs, [evidenceId]);
  assert.equal(report.atomicResults.length, 0);
  assert.deepEqual(report.evidence[0].payload, {
    matches: [],
    coverage: "complete",
  });
  assert.equal(summary.completion, "complete");
  assert.equal(summary.report, report);
  assertResponseReferencesClosed(response);
});

test("an unfinished empty query with no matches never becomes complete", async () => {
  const stateId = "state-empty-query-partial";
  const evidenceId = "evidence-empty-query-partial";
  const fixture = createFixtureAdapter({
    evaluate: (input) =>
      evaluated(
        input.state.coverage === "complete" && input.state.matches.length === 0
          ? "satisfied"
          : "unsatisfied",
        input,
      ),
  });
  const response = await runRecursiveGoal(
    makeRequest({
      requestId: "completion-empty-query-partial",
      rootGoal: {
        kind: "empty-query",
        capability: "empty.query",
        query: "needle",
      },
      state: {
        matches: [],
        coverage: "partial",
      },
      initialObservation: {
        stateId,
        evidence: [
          {
            id: evidenceId,
            stateRef: stateId,
            payload: {
              matches: [],
              coverage: "partial",
            },
            validity: "valid",
          },
        ],
      },
    }),
    dependencies(fixture.adapter, {
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);
  const summary = projectRecursiveGoalCompletion(report);

  assert.equal(report.rootEvaluation.result, "unsatisfied");
  assert.equal(report.atomicResults.length, 0);
  assert.equal(summary.completion, "incomplete");
  assert.deepEqual(summary.completedItems, []);
  assert.equal(summary.report, report);
  assertResponseReferencesClosed(response);
});

async function runPartialRequiredConditionReport() {
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "ready",
          goal: {
            kind: "partial-ready",
            capability: "partial.ready",
            target: 0,
          },
          bindings: input.bindings,
          selectorId: "ready-selector",
        }),
        condition({
          id: "remaining",
          goal: {
            kind: "partial-remaining",
            capability: "partial.remaining",
            target: 2,
          },
          bindings: input.bindings,
          selectorId: "remaining-selector",
        }),
      ]),
    evaluate: (input) => {
      if (input.goal.kind === "partial-ready") {
        return evaluated(input.state.count === 0 ? "satisfied" : "unsatisfied", input);
      }
      if (input.goal.kind === "partial-remaining") {
        return evaluated("unsatisfied", input);
      }
      return evaluated(
        input.conditions.length === 2 &&
          input.conditions.every((item) => item.fact === "satisfied")
          ? "satisfied"
          : "unsatisfied",
        input,
      );
    },
  });
  const response = await runRecursiveGoal(
    makeRequest({
      requestId: "completion-partial-required-condition",
      rootGoal: {
        kind: "partial-root",
        capability: "partial.root",
        target: 2,
      },
      state: { count: 0 },
      initialObservation: initialObservation({
        stateId: "partial-initial-state",
        evidenceId: "partial-initial-evidence",
        count: 0,
      }),
    }),
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-root", "composite", {
          capability: "partial.root",
        }),
      ],
      selectors: [
        selector("root-selector", ["compose-root"]),
        selector("ready-selector", []),
        selector("remaining-selector", []),
      ],
    }),
  );
  const report = responseReport(response);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.rootEvaluation.result, "unsatisfied");
  assertResponseReferencesClosed(response);
  return report;
}

test("a satisfied required condition produces partial completion with owner and evidence", async () => {
  const report = await runPartialRequiredConditionReport();
  const rootFrame = report.frames.find((frame) => frame.depth === 0);
  const ready = rootFrame.conditionResults.find((item) => item.conditionId === "ready");
  const remaining = rootFrame.conditionResults.find(
    (item) => item.conditionId === "remaining",
  );
  const snapshot = JSON.stringify(report);
  const summary = projectRecursiveGoalCompletion(report);
  const repeated = projectRecursiveGoalCompletion(report);

  assert.equal(ready.fact, "satisfied");
  assert.equal(remaining.fact, "not_evaluated", "unprocessed condition is not a negative fact");
  assert.equal(summary.completion, "partial");
  assert.equal(summary.conditionAccounting, "available");
  assert.deepEqual(summary.completedItems, [
    {
      frameId: rootFrame.frameId,
      conditionId: "ready",
      lifetime: "stage",
      evaluation: ready,
    },
  ]);
  assert.deepEqual(
    summary.completedItems[0].evaluation.evidenceRefs,
    ["partial-initial-evidence"],
  );
  assert.ok(
    summary.remainingItems.some(
      (item) => item.kind === "root" && item.frameId === rootFrame.frameId,
    ),
  );
  assert.ok(
    summary.remainingItems.some(
      (item) =>
        item.kind === "condition" &&
        item.frameId === rootFrame.frameId &&
        item.conditionId === "remaining",
    ),
  );
  assert.deepEqual(repeated, summary);
  assert.equal(JSON.stringify(report), snapshot);
  assert.equal(summary.report, report);
  assert.equal(report.continuation.dependencies.find(
    (item) => item.condition.id === "ready",
  ).condition.activation, "required");
});

test("a successful atomic execution without a satisfied condition remains incomplete", async () => {
  const fixture = createFixtureAdapter({
    evaluate: (input) => evaluated("unsatisfied", input),
  });
  const response = await runRecursiveGoal(
    makeRequest({
      requestId: "completion-success-without-goal",
      state: { count: 0 },
      limits: {
        maxTransitions: 6,
        maxDepth: 8,
        maxDerivedGoals: 4,
      },
    }),
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  const report = responseReport(response);
  const summary = projectRecursiveGoalCompletion(report);

  assert.ok(report.atomicResults.length > 0);
  assert.ok(
    report.atomicResults.every((result) => result.outcome === "succeeded"),
  );
  assert.notEqual(report.rootEvaluation.result, "satisfied");
  assert.equal(summary.completion, "incomplete");
  assert.deepEqual(summary.completedItems, []);
  assert.deepEqual(
    summary.report.atomicResults.map((result) => result.outcome),
    report.atomicResults.map(() => "succeeded"),
  );
  assertResponseReferencesClosed(response);
});

test("budget stops project partial only when a required condition was recorded", async () => {
  const partial = createFiniteBudgetHarness({
    rootTarget: 20,
    derivationCount: 20,
    limits: {
      maxTransitions: 6,
      maxDepth: 8,
      maxDerivedGoals: 16,
    },
  });
  const partialReport = responseReport(
    await runRecursiveGoal(partial.request, partial.deps),
  );
  const partialSummary = projectRecursiveGoalCompletion(partialReport);

  assert.equal(partialReport.control.outcome, "exceeded");
  assert.equal(partialReport.control.stopReason, "budget");
  assert.ok(partialReport.atomicResults.length > 0);
  assert.deepEqual(partialReport.control.budget, {
    dimension: "maxTransitions",
    limit: 6,
    used: 6,
    attempted: 7,
  });
  assert.equal(partialSummary.completion, "incomplete", "atomic return before evaluation is not a proved accomplishment");
  assert.deepEqual(partialSummary.completedItems, []);
  assert.equal(partialSummary.control, partialReport.control);
  assert.deepEqual(partialSummary.control.budget, partialReport.control.budget);

  const evaluated = createFiniteBudgetHarness({
    rootTarget: 20,
    derivationCount: 20,
    limits: { maxDerivedGoals: 1 },
  });
  const evaluatedReport = responseReport(await runRecursiveGoal(evaluated.request, evaluated.deps));
  const evaluatedSummary = projectRecursiveGoalCompletion(evaluatedReport);
  assert.equal(evaluatedReport.control.stopReason, "budget");
  assert.equal(evaluatedReport.control.budget.dimension, "maxDerivedGoals");
  assert.equal(evaluatedSummary.completion, "partial");
  assert.ok(evaluatedSummary.completedItems.length > 0);
  assert.ok(evaluatedSummary.completedItems.every(item => item.evaluation.fact === "satisfied"));
  assert.equal(evaluatedSummary.control, evaluatedReport.control);

  const empty = createFiniteBudgetHarness({
    rootTarget: 2,
    derivationCount: 2,
    limits: {
      maxTransitions: 1,
      maxDepth: 8,
      maxDerivedGoals: 4,
    },
  });
  const emptyReport = responseReport(await runRecursiveGoal(empty.request, empty.deps));
  const emptySummary = projectRecursiveGoalCompletion(emptyReport);

  assert.equal(emptyReport.control.outcome, "exceeded");
  assert.equal(emptyReport.control.stopReason, "budget");
  assert.equal(emptyReport.atomicResults.length, 0);
  assert.deepEqual(emptyReport.control.budget, {
    dimension: "maxTransitions",
    limit: 1,
    used: 1,
    attempted: 2,
  });
  assert.equal(emptySummary.completion, "incomplete");
  assert.deepEqual(emptySummary.completedItems, []);
  assert.equal(emptySummary.control, emptyReport.control);
  assert.deepEqual(emptySummary.control.budget, emptyReport.control.budget);
});

test("projection-only metadata guards are not engine evidence", async () => {
  // Projection-only: these copies exercise metadata branches that the current
  // finite fixture does not produce directly. They are not engine receipts.
  const report = await runPartialRequiredConditionReport();
  const persistent = structuredClone(report);
  const persistentDependency = persistent.continuation.dependencies.find(
    (item) => item.condition.id === "ready",
  );
  const persistentOwner = persistent.frames.find(
    (frame) => frame.frameId === persistentDependency.ownerFrameId,
  );
  const persistentEvaluation = persistentOwner.conditionResults.find(
    (item) => item.conditionId === "ready",
  );
  persistentDependency.condition.lifetime = "persistent";
  persistentDependency.fact = "unknown";
  persistentEvaluation.fact = "unknown";
  persistentEvaluation.satisfaction = null;

  const persistentSummary = projectRecursiveGoalCompletion(persistent);
  assert.equal(persistentSummary.completion, "incomplete");
  assert.deepEqual(persistentSummary.completedItems, []);

  const inactive = structuredClone(report);
  const inactiveDependency = inactive.continuation.dependencies.find(
    (item) => item.condition.id === "ready",
  );
  inactiveDependency.condition.activation = "not_applicable";
  const inactiveSummary = projectRecursiveGoalCompletion(inactive);
  assert.equal(inactiveSummary.completion, "incomplete");
  assert.deepEqual(inactiveSummary.completedItems, []);
});
