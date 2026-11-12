import assert from "node:assert/strict";
import { test } from "node:test";

import { runRecursiveGoal } from "nnanything/recursive-goal";
import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  createFiniteBudgetHarness,
  diagnostic,
  evidence,
  evaluator,
  failedAtomicReceipt,
  makeRequest,
  responseReport,
  sameObligationNoProgressHarness,
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
  enabledSkills,
  selectors,
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

function condition({
  id,
  goal,
  bindings,
  mode = "atomic",
  selectorId,
  dependsOn = [],
  activation = "required",
  lifetime = "stage",
}) {
  return {
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId: "counter-evaluator",
    selectorId,
    mode,
    dependsOn,
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

function satisfied(input) {
  return {
    evaluatorId: "counter-evaluator",
    result: "satisfied",
    satisfaction: 100,
    necessaryConditionsMet: true,
    evidenceRefs: validEvidenceRefs(input),
  };
}

function unsatisfied() {
  return {
    evaluatorId: "counter-evaluator",
    result: "unsatisfied",
    satisfaction: 0,
    necessaryConditionsMet: false,
    evidenceRefs: [],
  };
}

function conditionFact(report, conditionId) {
  for (const frame of report.frames) {
    const found = frame.conditionResults.find(
      (item) => item.conditionId === conditionId,
    );
    if (found !== undefined) return found;
  }
  return null;
}

test("selected action decision preserves object B for the same atomic skill", async () => {
  const decision = {
    objectId: "B",
    parameters: { path: "fixtures/b.txt" },
  };
  let selectedFrameId = null;
  let selectorCalls = 0;
  const fixture = createFixtureAdapter({
    select(input) {
      selectorCalls += 1;
      selectedFrameId = input.context.frameId;
      assert.deepEqual(input.bindings.objects, ["A", "B"]);
      return {
        kind: "selected",
        skillId: "write-target",
        decision,
      };
    },
    executeAtomic(input) {
      assert.equal(input.context.frameId, selectedFrameId);
      assert.deepEqual(input.decision, decision);
      const receipt = successfulAtomicReceipt({
        count: 1,
        stateId: "state-after-b",
        evidenceId: "evidence-after-b",
        runId: "write-b",
      });
      receipt.sourceResult = {
        tag: "fixture.selected-object",
        value: { objectId: input.decision.objectId },
      };
      return receipt;
    },
  });
  const request = makeRequest({
    rootBindings: { objects: ["A", "B"] },
    limits: { maxTransitions: 16, maxDepth: 4, maxDerivedGoals: 4 },
  });
  const response = await runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("write-target", "atomic")],
      selectors: [selector("root-selector", ["write-target"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(selectorCalls, 1);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.atomicResults[0].sourceResult.value.objectId, "B");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(response);
});

test("a decision payload on a composite skill is rejected and never silently replayed", async () => {
  const fixture = createFixtureAdapter({
    select: () => ({
      kind: "selected",
      skillId: "compose-target",
      decision: { objectId: "B" },
    }),
  });
  const response = await runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-target", "composite"),
      ],
      selectors: [selector("root-selector", ["compose-target"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(fixture.calls.derive, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(report.control.outcome, "error");
  assert.ok(
    report.errors.some(
      (error) =>
        error.source.category === "selection_receipt" &&
        error.diagnosticMessage.includes("supported only for atomic skills"),
    ),
  );
  assertResponseReferencesClosed(response);
});

function createSubsetHarness({ failBlocked = false } = {}) {
  const fixture = createFixtureAdapter({
    derive: (input) => {
      assert.equal(input.skill.id, "compose-subset");
      return derivation([
        condition({
          id: "ready",
          goal: {
            kind: "subset-step",
            capability: "subset.step",
            slot: "ready",
          },
          bindings: input.bindings,
          selectorId: "ready-selector",
        }),
        condition({
          id: "needs-work",
          goal: {
            kind: "subset-step",
            capability: "subset.step",
            slot: "needs-work",
          },
          bindings: input.bindings,
          selectorId: "work-selector",
        }),
      ]);
    },
    evaluate: (input) => {
      if (input.goal.kind === "subset-root") {
        const allSatisfied =
          input.conditions.length === 2 &&
          input.conditions.every((item) => item.fact === "satisfied");
        return allSatisfied ? satisfied(input) : unsatisfied();
      }
      if (input.goal.slot === "ready") {
        return input.state.ready === true ? satisfied(input) : unsatisfied();
      }
      if (input.goal.slot === "needs-work") {
        return input.state.blocked === true ? satisfied(input) : unsatisfied();
      }
      throw new TypeError(`unexpected goal ${JSON.stringify(input.goal)}`);
    },
    executeAtomic: (input) => {
      assert.equal(input.skill.id, "finish-blocked");
      if (failBlocked) {
        return failedAtomicReceipt({
          executionErrors: [
            diagnostic({
              diagnosticId: "blocked-sibling-failure",
              code: "execution_failed",
              stage: "execution",
              sourceCategory: "fixture.blocked-sibling",
              message: "blocked sibling failed without invalidating ready evidence",
              nativeCode: "E_BLOCKED_SIBLING",
            }),
          ],
        });
      }
      const receipt = successfulAtomicReceipt({
        count: 1,
        stateId: "state-after-blocked",
        evidenceId: "evidence-after-blocked",
        runId: "finish-blocked",
      });
      receipt.newState = {
        id: "state-after-blocked",
        value: { ready: true, blocked: true },
      };
      return receipt;
    },
  });
  const request = makeRequest({
    rootGoal: { kind: "subset-root", capability: "subset.root" },
    state: { ready: true, blocked: false },
    initialObservation: {
      stateId: "state-initial",
      evidence: [evidence("evidence-ready", "state-initial", 1)],
    },
    limits: { maxTransitions: 32, maxDepth: 6, maxDerivedGoals: 8 },
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-subset", "composite", { capability: "subset.root" }),
      skill("read-ready", "atomic", { capability: "subset.step" }),
      skill("finish-blocked", "atomic", { capability: "subset.step" }),
    ],
    selectors: [
      selector("root-selector", ["compose-subset"]),
      selector("ready-selector", ["read-ready"]),
      selector("work-selector", ["finish-blocked"]),
    ],
  });
  return { request, deps, fixture };
}

test("evaluable ready subset is used without dispatching it, then pending work completes", async () => {
  const { request, deps, fixture } = createSubsetHarness();
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.atomicResults[0].skillId, "finish-blocked");
  assert.equal(conditionFact(report, "ready").fact, "satisfied");
  assert.equal(conditionFact(report, "needs-work").fact, "satisfied");
  assert.equal(report.control.outcome, "completed");
  assertResponseReferencesClosed(response);
});

test("a ready subset remains visible when a pending sibling fails, without false completion", async () => {
  const { request, deps, fixture } = createSubsetHarness({ failBlocked: true });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(conditionFact(report, "ready").fact, "satisfied");
  assert.notEqual(conditionFact(report, "needs-work").fact, "satisfied");
  assert.equal(report.control.outcome, "error");
  assert.notEqual(report.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(response);
});

function createPrerequisiteHarness({ supplyPrerequisite }) {
  const executions = [];
  const fixture = createFixtureAdapter({
    derive: (input) => {
      assert.equal(input.skill.id, "compose-prerequisite");
      return derivation([
        condition({
          id: "A",
          goal: {
            kind: "prerequisite-step",
            capability: "prerequisite.step",
            step: "A",
          },
          bindings: input.bindings,
          selectorId: "a-selector",
          dependsOn: ["B"],
        }),
        condition({
          id: "B",
          goal: {
            kind: "prerequisite-step",
            capability: "prerequisite.step",
            step: "B",
          },
          bindings: input.bindings,
          selectorId: "b-selector",
        }),
      ]);
    },
    evaluate: (input) => {
      if (input.goal.kind === "prerequisite-root") {
        const allSatisfied =
          input.conditions.length === 2 &&
          input.conditions.every((item) => item.fact === "satisfied");
        return allSatisfied ? satisfied(input) : unsatisfied();
      }
      if (input.goal.step === "B") {
        return input.state.b === true ? satisfied(input) : unsatisfied();
      }
      if (input.goal.step === "A") {
        return input.state.prerequisite === true && input.state.a === true
          ? satisfied(input)
          : unsatisfied();
      }
      throw new TypeError(`unexpected goal ${JSON.stringify(input.goal)}`);
    },
    executeAtomic: (input) => {
      executions.push(input.skill.id);
      if (input.skill.id === "provide-prerequisite") {
        const receipt = successfulAtomicReceipt({
          count: 1,
          stateId: "state-after-b",
          evidenceId: "evidence-after-b",
          runId: "provide-prerequisite",
        });
        receipt.newState = {
          id: "state-after-b",
          value: {
            a: false,
            b: true,
            prerequisite: supplyPrerequisite,
          },
        };
        receipt.sourceResult = {
          tag: "fixture.prerequisite",
          value: { step: "B", supplied: supplyPrerequisite },
        };
        return receipt;
      }
      if (input.skill.id === "consume-prerequisite") {
        if (input.state.prerequisite !== true) {
          return failedAtomicReceipt({
            executionErrors: [
              diagnostic({
                diagnosticId: "prerequisite-not-supplied",
                code: "precondition_unsatisfied",
                stage: "execution",
                sourceCategory: "fixture.prerequisite",
                message: "A is blocked because B did not supply its prerequisite",
                nativeCode: "E_PREREQUISITE_MISSING",
              }),
            ],
          });
        }
        const receipt = successfulAtomicReceipt({
          count: 1,
          stateId: "state-after-a",
          evidenceId: "evidence-after-a",
          runId: "consume-prerequisite",
        });
        receipt.newState = {
          id: "state-after-a",
          value: { a: true, b: true, prerequisite: true },
        };
        receipt.sourceResult = {
          tag: "fixture.prerequisite",
          value: { step: "A", supplied: true },
        };
        return receipt;
      }
      throw new TypeError(`unexpected atomic skill ${input.skill.id}`);
    },
  });
  const request = makeRequest({
    rootGoal: {
      kind: "prerequisite-root",
      capability: "prerequisite.root",
    },
    state: { a: false, b: false, prerequisite: false },
    initialObservation: {
      stateId: "state-initial",
      evidence: [evidence("evidence-initial", "state-initial", 1)],
    },
    limits: { maxTransitions: 48, maxDepth: 6, maxDerivedGoals: 8 },
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-prerequisite", "composite", {
        capability: "prerequisite.root",
      }),
      skill("provide-prerequisite", "atomic", {
        capability: "prerequisite.step",
      }),
      skill("consume-prerequisite", "atomic", {
        capability: "prerequisite.step",
      }),
    ],
    selectors: [
      selector("root-selector", ["compose-prerequisite"]),
      selector("a-selector", ["consume-prerequisite"]),
      selector("b-selector", ["provide-prerequisite"]),
    ],
  });
  return { request, deps, fixture, executions };
}

test("dependent A resumes in the same invocation after independent B supplies its prerequisite", async () => {
  const { request, deps, fixture, executions } = createPrerequisiteHarness({
    supplyPrerequisite: true,
  });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.deepEqual(executions, ["provide-prerequisite", "consume-prerequisite"]);
  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(conditionFact(report, "A").fact, "satisfied");
  assert.equal(conditionFact(report, "B").fact, "satisfied");
  assert.equal(report.control.outcome, "completed");
  assertResponseReferencesClosed(response);
});

test("B completing without A's prerequisite does not fabricate A completion", async () => {
  const { request, deps } = createPrerequisiteHarness({
    supplyPrerequisite: false,
  });
  const response = await runRecursiveGoal(request, deps);
  const report = responseReport(response);

  assert.notEqual(conditionFact(report, "A").fact, "satisfied");
  assert.notEqual(report.control.outcome, "completed");
  assert.ok(
    report.errors.some(
      (error) =>
        error.code === "precondition_unsatisfied" &&
        error.source.nativeCode === "E_PREREQUISITE_MISSING",
    ),
  );
  assertResponseReferencesClosed(response);
});

test("relevant reassessment without factual progress terminates as no_progress", async () => {
  const progress = createFiniteBudgetHarness({
    rootTarget: 2,
    derivationCount: 2,
  });
  const progressReport = responseReport(
    await runRecursiveGoal(progress.request, progress.deps),
  );
  assert.equal(progressReport.control.outcome, "completed");
  assert.equal(progress.fixture.calls.executeAtomic, 2);

  const stale = sameObligationNoProgressHarness({});
  const staleResponse = await runRecursiveGoal(stale.request, stale.deps);
  const staleReport = responseReport(staleResponse);

  assert.equal(staleReport.control.outcome, "stalled");
  assert.equal(staleReport.control.stopReason, "no_progress");
  assert.equal(
    staleReport.errors.some((error) => error.code === "no_progress"),
    true,
  );
  assert.equal(
    staleReport.errors.some((error) => error.code === "budget_exceeded"),
    false,
  );
  assert.equal(stale.fixture.calls.derive, 2);
  assertResponseReferencesClosed(staleResponse);
});

test("partial budget preserves completed results and negative completion remains evaluated", async (t) => {
  const partial = createFiniteBudgetHarness({
    rootTarget: 20,
    derivationCount: 20,
    limits: {
      maxTransitions: 6,
      maxDepth: 8,
      maxDerivedGoals: 16,
    },
  });
  const partialResponse = await runRecursiveGoal(
    partial.request,
    partial.deps,
  );
  const partialReport = responseReport(partialResponse);

  assert.equal(partialReport.control.outcome, "exceeded");
  assert.equal(partialReport.control.stopReason, "budget");
  assert.ok(partialReport.atomicResults.length > 0);
  assert.ok(partialReport.continuation.remainingRequirements.length > 0);
  assert.notEqual(partialReport.rootEvaluation.result, "satisfied");
  assertResponseReferencesClosed(partialResponse);

  if (!Object.hasOwn(partialReport, "completion")) {
    t.diagnostic(
      "Top-level completion projection is not exposed; preserved generic results and budget control are used instead.",
    );
  }

  const negativeFixture = createFixtureAdapter({
    evaluate: (input) =>
      input.state.found === false && input.state.coverage === "complete"
        ? satisfied(input)
        : unsatisfied(),
  });
  const negativeRequest = makeRequest({
    rootGoal: {
      kind: "negative-completion",
      capability: "negative.completion",
    },
    state: { found: false, coverage: "complete" },
    initialObservation: {
      stateId: "state-negative-complete",
      evidence: [
        evidence("evidence-complete-negative", "state-negative-complete", 0),
      ],
    },
  });
  const negativeResponse = await runRecursiveGoal(
    negativeRequest,
    dependencies(negativeFixture.adapter, {
      enabledSkills: [],
      selectors: [selector("root-selector", [])],
    }),
  );
  const negativeReport = responseReport(negativeResponse);

  assert.equal(negativeReport.control.outcome, "completed");
  assert.equal(negativeReport.control.stopReason, "root_evaluation");
  assert.equal(negativeReport.rootEvaluation.result, "satisfied");
  assert.equal(negativeReport.atomicResults.length, 0);
  assertResponseReferencesClosed(negativeResponse);
});
