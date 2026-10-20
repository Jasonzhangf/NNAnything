import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  completionAdapter,
  createFixtureAdapter,
  diagnostic,
  evaluator,
  failedAtomicReceipt,
  initialObservation,
  makeRequest,
  responseReport,
  selector,
  singleChildDerivation,
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

function dependencies(adapter, {
  enabledSkills = [],
  selectors = [],
  enabledEvaluators = [evaluator()],
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

test("already satisfied root completes with zero derived goals and zero atomic calls", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest({
    state: { count: 1 },
    initialObservation: initialObservation(),
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "completed");
  assert.equal(report.control.stopReason, "root_evaluation");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(report.frames.length, 1);
  assert.equal(report.frames[0].depth, 0);
  assert.equal(report.budgetUsed.derivedGoalsUsed, 0);
  assert.equal(report.atomicResults.length, 0);
  assert.equal(fixture.calls.derive, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("unsatisfied root derives one child, executes once, and returns through the parent", async () => {
  const api = await loadPublicApi();
  const { request, deps, fixture } = completionAdapter();

  const response = await api.runRecursiveGoal(request, deps);
  const report = responseReport(response);
  const rootFrame = report.frames.find((frame) => frame.depth === 0);
  const childFrame = report.frames.find((frame) => frame.depth === 1);

  assert.equal(report.control.outcome, "completed");
  assert.equal(report.control.stopReason, "root_evaluation");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.deepEqual(report.root.rootGoal, request.rootGoal);
  assert.equal(report.root.rootThreshold, request.satisfactionThreshold);
  assert.deepEqual(report.root.rootBindings, request.rootBindings);
  assert.ok(rootFrame, "root frame must be returned");
  assert.ok(childFrame, "derived child frame must be returned");
  assert.equal(childFrame.parentFrameId, rootFrame.frameId);
  assert.equal(childFrame.fulfillsConditionId, "child-condition");
  assert.equal(childFrame.mode, "atomic");
  assert.equal(childFrame.execution, "completed");
  assert.equal(report.atomicResults.length, 1);
  assert.equal(report.effects.length, 1);
  assert.equal(report.effects[0].knowledge, "none");
  assert.equal(fixture.calls.executeAtomic, 1);
  assertResponseReferencesClosed(response);
});

test("no compatible enabled skill returns capability_missing without selector or executor calls", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    supports: () => false,
  });
  const request = makeRequest();

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("unsupported-counter", "atomic")],
      selectors: [selector("root-selector", ["unsupported-counter"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.equal(report.errors.some((error) => error.code === "capability_missing"), true);
  assert.equal(fixture.calls.select, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.atomicResults.length, 0);
  assertResponseReferencesClosed(response);
});

test("covered selector returning an outside skill returns policy_error without execution", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    select: () => ({ kind: "selected", skillId: "not-in-vocabulary" }),
  });
  const request = makeRequest();

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "error");
  assert.equal(report.errors.some((error) => error.code === "policy_error"), true);
  assert.equal(fixture.calls.select, 1);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.atomicResults.length, 0);
  assertResponseReferencesClosed(response);
});

test("missing required effect returns effect_denied before the executor is invoked", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest();
  const mutatingSkill = skill("write-counter", "atomic", {
    requiredEffects: ["fixture.write"],
    allowedEffects: ["fixture.write"],
    effectClass: "mutating",
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [mutatingSkill],
      selectors: [selector("root-selector", ["write-counter"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "error");
  assert.equal(report.errors.some((error) => error.code === "effect_denied"), true);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.atomicResults.length, 0);
  assertResponseReferencesClosed(response);
});

test("typed atomic failure returns its source, effect boundary, root cause, and skips dependents", async () => {
  const api = await loadPublicApi();
  const rootGoal = makeRequest().rootGoal;
  const bindings = { scope: "fixture" };
  const fixture = createFixtureAdapter({
    derive: (input) =>
      input.skill.id === "compose-counter"
        ? {
            conditions: [
              {
                id: "fail-child",
                goal: input.goal,
                bindings: input.bindings,
                satisfactionThreshold: 100,
                evaluatorId: "counter-evaluator",
                selectorId: "fail-selector",
                mode: "atomic",
                dependsOn: [],
                lifetime: "stage",
                activation: "required",
                allowedEffects: [],
              },
              {
                id: "after-fail-child",
                goal: input.goal,
                bindings: input.bindings,
                satisfactionThreshold: 100,
                evaluatorId: "counter-evaluator",
                selectorId: "after-selector",
                mode: "atomic",
                dependsOn: ["fail-child"],
                lifetime: "stage",
                activation: "required",
                allowedEffects: [],
              },
            ],
            nextCursor: "closed",
            expansion: "closed",
          }
        : singleChildDerivation({
            goal: input.goal,
            bindings: input.bindings,
          }),
    executeAtomic: (input) => {
      if (input.skill.id === "fail-child") return failedAtomicReceipt();
      return {
        runId: "must-not-run",
        executorInvoked: false,
        outcome: "rejected",
        sourceResult: null,
        newState: null,
        evidence: [],
        executionErrors: [],
        verificationErrors: [],
        effect: {
          knowledge: "none",
          confirmedEffects: [],
          receiptRef: null,
        },
      };
    },
  });
  const request = makeRequest({
    rootGoal,
    rootBindings: bindings,
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("fail-child", "atomic"),
      skill("after-fail-child", "atomic"),
    ],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("fail-selector", ["fail-child"]),
      selector("after-selector", ["after-fail-child"]),
    ],
  });

  const response = await api.runRecursiveGoal(request, deps);
  const report = responseReport(response);
  const original = report.errors.find(
    (error) =>
      error.code === "execution_failed" &&
      error.source.nativeCode === "E_TYPED_FAILURE",
  );
  const failedResult = report.atomicResults.find(
    (result) => result.skillId === "fail-child",
  );
  const failedChild = report.frames.find(
    (frame) => frame.fulfillsConditionId === "fail-child",
  );
  const dependentChild = report.frames.find(
    (frame) => frame.fulfillsConditionId === "after-fail-child",
  );

  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.ok(original, "typed execution diagnostic must be returned");
  assert.equal(original.stage, "execution");
  assert.equal(original.source.category, "fixture.execution");
  assert.equal(original.diagnosticMessage, "authoritative typed execution failure");
  assert.ok(failedResult, "failed atomic result must be returned");
  assert.equal(failedResult.outcome, "failed");
  assert.equal(failedResult.sourceResult?.tag, "fixture.failure-receipt");
  assert.equal(failedResult.sourceResult?.value?.token, "opaque-failure-receipt");
  assert.equal(failedResult.effect.knowledge, "none");
  assert.ok(failedChild, "failed child frame must be retained");
  assert.equal(failedChild.execution, "failed");
  assert.ok(failedChild.errorId);
  assert.equal(report.primaryErrorId, failedChild.errorId);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.ok(dependentChild, "generated dependent frame must be retained");
  assert.equal(dependentChild.execution, "not_started");
  assert.equal(dependentChild.unexecutedReason, "dependency_not_met");
  assertResponseReferencesClosed(response);
});

test("captured atomic exception still returns a total report with an unknown dispatch ledger", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    executeAtomic: () => {
      throw new Error("fixture callback escaped");
    },
  });
  const request = makeRequest();
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [skill("increment-counter", "atomic")],
    selectors: [selector("root-selector", ["increment-counter"])],
  });

  const response = await api.runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(response.requestId, request.requestId);
  assert.deepEqual(response.acceptedRoot.rootGoal, request.rootGoal);
  assert.equal(report.control.outcome, "error");
  assert.ok(report.primaryErrorId);
  assert.equal(report.errors.some((error) => error.code === "capability_missing"), false);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.effects.length, 1);
  assert.equal(
    report.effects[0].knowledge === "unknown" ||
      report.effects[0].knowledge === "mixed",
    true,
  );
  assertResponseReferencesClosed(response);
});

test("adapter diagnostic identity survives mapping and error references remain closed", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    executeAtomic: () =>
      failedAtomicReceipt({
        executionErrors: [
          diagnostic({
            diagnosticId: "stable-adapter-diagnostic",
            code: "execution_failed",
            stage: "execution",
            message: "stable adapter failure",
            sourceCategory: "fixture.typed",
            nativeCode: "E_STABLE",
            refs: ["fixture://stable"],
          }),
        ],
      }),
  });
  const request = makeRequest();

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  const report = responseReport(response);
  const original = report.errors.find(
    (error) => error.source.nativeCode === "E_STABLE",
  );

  assert.ok(original);
  assert.equal(original.code, "execution_failed");
  assert.equal(original.stage, "execution");
  assert.deepEqual(original.source.refs, ["fixture://stable"]);
  assert.equal(original.diagnosticMessage, "stable adapter failure");
  assertResponseReferencesClosed(response);
});
