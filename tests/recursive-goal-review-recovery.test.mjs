import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  diagnostic,
  errorsByCode,
  evaluator,
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
  grantedEffects = new Set(),
  signal,
} = {}) {
  return {
    adapter,
    enabledSkills,
    enabledEvaluators: [evaluator()],
    selectors,
    comparators: comparators(),
    grantedEffects,
    ...(signal === undefined ? {} : { signal }),
  };
}

function counterEvaluation(input) {
  const result =
    input.state.count >= input.goal.target ? "satisfied" : "unsatisfied";
  return {
    evaluatorId: "counter-evaluator",
    result,
    satisfaction: result === "satisfied" ? 100 : 0,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs:
      result === "satisfied"
        ? input.evidence
            .filter((item) => item.validity === "valid")
            .map((item) => item.id)
        : [],
  };
}

function condition({
  id,
  goal,
  bindings,
  mode,
  selectorId,
  activation = "required",
  dependsOn = [],
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
    lifetime: "stage",
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

function pendingVerificationControl(report) {
  assert.ok(report.continuation);
  const rootId = report.root.rootFrameId;
  const control = report.continuation.frameControls.find(
    (entry) => entry.frameId === rootId,
  );
  assert.ok(control);
  return control.pendingVerification;
}

function knownEffectReceipt() {
  return successfulAtomicReceipt({
    count: 1,
    stateId: "committed-state",
    evidenceId: "committed-evidence",
    runId: "known-effect-dispatch",
    effect: {
      knowledge: "known",
      confirmedEffects: [{ operation: "counter.increment" }],
      receiptRef: "fixture://known-effect",
    },
  });
}

function verificationGap() {
  return diagnostic({
    diagnosticId: "verification-gap",
    code: "evidence_unavailable",
    stage: "observation",
    sourceCategory: "fixture.verification",
    message: "typed postcondition evidence is not available yet",
    nativeCode: "E_POSTCONDITION",
    refs: ["fixture://verification-gap"],
  });
}

test("known committed effects persist a pending verification without replaying the mutating head", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    evaluate: (input) => counterEvaluation(input),
    select: (_input, calls, memory) => {
      const selected = memory.recoverySelections.shift();
      return { kind: "selected", skillId: selected };
    },
    executeAtomic: (input) => {
      if (input.skill.id === "write-counter") {
        return {
          ...knownEffectReceipt(),
          verificationErrors: [verificationGap()],
        };
      }
      return successfulAtomicReceipt({
        count: 1,
        stateId: "verified-state",
        evidenceId: "verified-evidence",
        runId: "read-only-verification",
      });
    },
  });
  fixture.memory.recoverySelections = [
    "write-counter",
    "write-counter",
    "verify-counter",
  ];
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("write-counter", "atomic", {
        effectClass: "mutating",
        allowedEffects: ["counter.write"],
        requiredEffects: ["counter.write"],
      }),
      skill("verify-counter", "atomic", {
        effectClass: "read_only",
      }),
    ],
    selectors: [
      selector("root-selector", ["write-counter", "verify-counter"]),
    ],
    grantedEffects: new Set(["counter.write"]),
  });
  const request = makeRequest();

  const firstResponse = await api.runRecursiveGoal(request, deps);
  const firstReport = responseReport(firstResponse);
  const pending = pendingVerificationControl(firstReport);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(firstReport.effects.length, 1);
  assert.equal(firstReport.effects[0].knowledge, "known");
  assert.deepEqual(firstReport.effects[0].confirmedEffects, [
    { operation: "counter.increment" },
  ]);
  assert.equal(
    firstReport.errors.some((error) => error.errorId === "verification-gap"),
    true,
  );
  assertResponseReferencesClosed(firstResponse);

  const secondResponse = await api.runRecursiveGoal(
    {
      ...request,
      continuation: firstReport.continuation,
    },
    deps,
  );
  const secondReport = responseReport(secondResponse);

  assert.equal(fixture.calls.executeAtomic, 1, "mutating head must not replay");
  assert.ok(pending);
  assert.equal(pending.dispatchId, firstReport.atomicResults[0].dispatchId);
  assert.deepEqual(pending.verificationErrorIds, ["verification-gap"]);
  assert.equal(secondReport.control.outcome, "error");
  assert.ok(errorsByCode(secondReport, "evidence_unavailable").length > 0);
  assert.equal(
    secondReport.effects.find((effect) => effect.skillId === "write-counter")
      .knowledge,
    "known",
  );
  assertResponseReferencesClosed(secondResponse);

  const thirdResponse = await api.runRecursiveGoal(
    {
      ...request,
      continuation: secondReport.continuation,
    },
    deps,
  );
  const thirdReport = responseReport(thirdResponse);

  assert.equal(thirdReport.control.outcome, "completed");
  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(
    thirdReport.atomicResults.filter(
      (result) => result.skillId === "write-counter",
    ).length,
    1,
  );
  assert.equal(
    thirdReport.atomicResults.filter(
      (result) => result.skillId === "verify-counter",
    ).length,
    1,
  );
  assert.equal(
    thirdReport.errors.some((error) => error.errorId === "verification-gap"),
    true,
  );
  assert.equal(thirdReport.effects[0].knowledge, "known");
  assert.equal(thirdReport.continuation, null);
  assertResponseReferencesClosed(thirdResponse);
});

test("pending known-effect recovery reports evidence_unavailable when no read-only skill exists", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    evaluate: (input) => counterEvaluation(input),
    executeAtomic: () => ({
      ...knownEffectReceipt(),
      verificationErrors: [verificationGap()],
    }),
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("write-counter", "atomic", {
        effectClass: "mutating",
        allowedEffects: ["counter.write"],
        requiredEffects: ["counter.write"],
      }),
    ],
    selectors: [selector("root-selector", ["write-counter"])],
    grantedEffects: new Set(["counter.write"]),
  });
  const request = makeRequest();
  const firstResponse = await api.runRecursiveGoal(request, deps);
  const firstReport = responseReport(firstResponse);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.ok(pendingVerificationControl(firstReport));

  const secondResponse = await api.runRecursiveGoal(
    {
      ...request,
      continuation: firstReport.continuation,
    },
    deps,
  );
  const secondReport = responseReport(secondResponse);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(secondReport.control.outcome, "error");
  assert.ok(errorsByCode(secondReport, "evidence_unavailable").length > 0);
  assert.equal(secondReport.effects[0].knowledge, "known");
  assertResponseReferencesClosed(secondResponse);
});

test("a cancelled derivation preserves not_applicable branches as unexecuted and resumes", async () => {
  const api = await loadPublicApi();
  const controller = new AbortController();
  const fixture = createFixtureAdapter({
    evaluate: (input) => counterEvaluation(input),
    derive: (input) => {
      controller.abort();
      return derivation([
        condition({
          id: "unselected-branch",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "unselected-selector",
          activation: "not_applicable",
        }),
        condition({
          id: "required-branch",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "required-selector",
        }),
      ]);
    },
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("unselected-selector", ["increment-counter"]),
      selector("required-selector", ["increment-counter"]),
    ],
    signal: controller.signal,
  });
  const request = makeRequest();

  const firstResponse = await api.runRecursiveGoal(request, deps);
  const firstReport = responseReport(firstResponse);
  const firstBranch = firstReport.continuation.dependencies.find(
    (dependency) => dependency.condition.id === "unselected-branch",
  );

  assert.equal(firstReport.control.outcome, "cancelled");
  assert.equal(firstBranch.fact, "not_applicable");
  assert.equal(firstBranch.execution, "not_started");
  assert.equal(firstBranch.childFrameId, null);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(firstResponse);

  const secondResponse = await api.runRecursiveGoal(
    {
      ...request,
      continuation: firstReport.continuation,
    },
    dependencies(fixture.adapter, {
      enabledSkills: deps.enabledSkills,
      selectors: deps.selectors,
    }),
  );
  const secondReport = responseReport(secondResponse);
  const resumedBranch = secondReport.continuation
    ? secondReport.continuation.dependencies.find(
        (dependency) => dependency.condition.id === "unselected-branch",
      )
    : null;

  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(
    secondReport.atomicResults.some(
      (result) => result.frameId.includes("unselected-branch"),
    ),
    false,
  );
  assert.equal(
    secondReport.budgetUsed.transitionsUsed >
      firstReport.budgetUsed.transitionsUsed,
    true,
  );
  if (resumedBranch !== null) {
    assert.equal(resumedBranch.execution, "not_started");
  }
  assertResponseReferencesClosed(secondResponse);
});
