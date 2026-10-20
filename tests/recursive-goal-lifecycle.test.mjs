import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  diagnostic,
  errorsByCode,
  evaluator,
  failedAtomicReceipt,
  initialObservation,
  makeRequest,
  responseReport,
  selector,
  skill,
  successfulAtomicReceipt,
  unknownAtomicReceipt,
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

function condition({
  id,
  goal,
  bindings,
  mode,
  selectorId,
  dependsOn = [],
  allowedEffects = [],
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
    activation: "required",
    allowedEffects,
  };
}

function derivation(conditions, cursor = "closed") {
  return {
    conditions,
    nextCursor: cursor,
    expansion: "closed",
  };
}

function completedNoEffectReceipt(sequence) {
  return {
    runId: `no-progress-${sequence}`,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: {
      tag: "fixture.completed-without-state",
      value: { sequence },
    },
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
}

test("derived-goal budget is shared across the tree and no excess atomic work starts", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input, calls) => {
      if (input.skill.id === "compose-root") {
        return derivation([
          condition({
            id: "level-one",
            goal: input.goal,
            bindings: input.bindings,
            mode: "composite",
            selectorId: "level-one-selector",
          }),
        ]);
      }
      if (input.skill.id === "compose-level-one") {
        return derivation([
          condition({
            id: "leaf",
            goal: input.goal,
            bindings: input.bindings,
            mode: "atomic",
            selectorId: "leaf-selector",
          }),
        ]);
      }
      throw new Error(`unexpected derive for ${input.skill.id} after ${calls.derive}`);
    },
  });
  const request = makeRequest({
    limits: {
      maxTransitions: 32,
      maxDepth: 8,
      maxDerivedGoals: 1,
    },
  });
  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-root", "composite"),
        skill("compose-level-one", "composite"),
        skill("increment-leaf", "atomic"),
      ],
      selectors: [
        selector("root-selector", ["compose-root"]),
        selector("level-one-selector", ["compose-level-one"]),
        selector("leaf-selector", ["increment-leaf"]),
      ],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.equal(errorsByCode(report, "budget_exceeded").length > 0, true);
  assert.equal(report.budgetUsed.derivedGoalsUsed, 1);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(Math.max(...report.frames.map((frame) => frame.depth)), 1);
  assertResponseReferencesClosed(response);
});

test("transition budget stops before selector and dispatch when the sole slot is consumed", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest({
    limits: {
      maxTransitions: 1,
      maxDepth: 8,
      maxDerivedGoals: 8,
    },
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.equal(report.budgetUsed.transitionsUsed, 1);
  assert.equal(fixture.calls.evaluate, 1);
  assert.equal(fixture.calls.select, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("depth budget blocks a frame before it can dispatch its atomic child", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) => {
      if (input.skill.id === "compose-root") {
        return derivation([
          condition({
            id: "level-one",
            goal: input.goal,
            bindings: input.bindings,
            mode: "composite",
            selectorId: "level-one-selector",
          }),
        ]);
      }
      return derivation([
        condition({
          id: "too-deep-leaf",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "leaf-selector",
        }),
      ]);
    },
  });
  const request = makeRequest({
    limits: {
      maxTransitions: 32,
      maxDepth: 1,
      maxDerivedGoals: 8,
    },
  });

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-root", "composite"),
        skill("compose-level-one", "composite"),
        skill("increment-leaf", "atomic"),
      ],
      selectors: [
        selector("root-selector", ["compose-root"]),
        selector("level-one-selector", ["compose-level-one"]),
        selector("leaf-selector", ["increment-leaf"]),
      ],
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.equal(errorsByCode(report, "budget_exceeded").length > 0, true);
  assert.equal(Math.max(...report.frames.map((frame) => frame.depth)), 1);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("same Goal composite to atomic descent is legal while a repeated composite obligation cycles", async () => {
  const api = await loadPublicApi();
  const legalFixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "atomic-same-goal",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "atomic-selector",
        }),
      ]),
  });
  const legalRequest = makeRequest();
  const legalResponse = await api.runRecursiveGoal(
    legalRequest,
    dependencies(legalFixture.adapter, {
      enabledSkills: [
        skill("compose-counter", "composite"),
        skill("increment-counter", "atomic"),
      ],
      selectors: [
        selector("root-selector", ["compose-counter"]),
        selector("atomic-selector", ["increment-counter"]),
      ],
    }),
  );
  const legalReport = responseReport(legalResponse);

  assert.equal(legalReport.control.outcome, "completed");
  assert.equal(legalReport.rootEvaluation.state, "evaluated");
  assert.equal(legalReport.rootEvaluation.result, "satisfied");
  assert.equal(legalFixture.calls.executeAtomic, 1);
  assertResponseReferencesClosed(legalResponse);

  const cycleFixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "same-composite-obligation",
          goal: input.goal,
          bindings: input.bindings,
          mode: "composite",
          selectorId: "root-selector",
        }),
      ]),
  });
  const cycleResponse = await api.runRecursiveGoal(
    makeRequest(),
    dependencies(cycleFixture.adapter, {
      enabledSkills: [skill("compose-counter", "composite")],
      selectors: [selector("root-selector", ["compose-counter"])],
    }),
  );
  const cycleReport = responseReport(cycleResponse);

  assert.equal(cycleReport.control.outcome, "error");
  assert.equal(errorsByCode(cycleReport, "derivation_cycle").length > 0, true);
  assert.equal(cycleFixture.calls.executeAtomic, 0);
  assert.ok(cycleFixture.calls.derive <= 2);
  assertResponseReferencesClosed(cycleResponse);
});

test("two completed safe retries with no factual progress stop as stalled", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "retry-child",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "retry-selector",
        }),
      ]),
    executeAtomic: (_input, calls) => completedNoEffectReceipt(calls.executeAtomic),
    measureProgress: () => ({
      improved: false,
      reason: "none",
      comparable: true,
    }),
  });
  const request = makeRequest();

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [
        skill("compose-counter", "composite"),
        skill("increment-counter", "atomic", {
          retry: "completed_no_effect",
        }),
      ],
      selectors: [
        selector("root-selector", ["compose-counter"]),
        selector("retry-selector", ["increment-counter"]),
      ],
    }),
  );
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(report.control.outcome, "stalled");
  assert.equal(report.control.stopReason, "no_progress");
  assert.equal(errorsByCode(report, "no_progress").length > 0, true);
  assertResponseReferencesClosed(response);
});

test("an unsafe failed action is not retried into the no-progress counter", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    executeAtomic: () => failedAtomicReceipt(),
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

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.control.outcome, "error");
  assert.equal(errorsByCode(report, "execution_failed").length > 0, true);
  assert.equal(errorsByCode(report, "no_progress").length, 0);
  assertResponseReferencesClosed(response);
});

test("pre-cancelled requests dispatch no Goal action and keep cancelled control", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const controller = new AbortController();
  controller.abort();

  const response = await api.runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
      signal: controller.signal,
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "cancelled");
  assert.equal(report.control.stopReason, "cancel");
  assert.equal(errorsByCode(report, "cancelled").length > 0, true);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("in-flight cancellation waits for the bounded receipt and does not rewrite it as success", async () => {
  const api = await loadPublicApi();
  const controller = new AbortController();
  let releaseAtomic;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fixture = createFixtureAdapter({
    executeAtomic: () =>
      new Promise((resolve) => {
        releaseAtomic = () => resolve(successfulAtomicReceipt({ count: 1 }));
        markStarted();
      }),
  });
  const run = api.runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
      signal: controller.signal,
    }),
  );

  await started;
  controller.abort();
  releaseAtomic();
  const response = await run;
  const report = responseReport(response);

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(report.control.outcome, "cancelled");
  assert.equal(report.control.stopReason, "cancel");
  assert.equal(report.atomicResults.length, 1);
  assert.equal(report.effects.length, 1);
  assert.equal(report.atomicResults[0].outcome, "succeeded");
  assertResponseReferencesClosed(response);
});

test("an abort after completed control cannot rewrite the completed result", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const controller = new AbortController();
  const response = await api.runRecursiveGoal(
    makeRequest({
      state: { count: 1 },
      initialObservation: initialObservation(),
    }),
    dependencies(fixture.adapter, {
      enabledSkills: [],
      selectors: [selector("root-selector", [])],
      signal: controller.signal,
    }),
  );
  const beforeLateCancel = structuredClone(response);

  controller.abort();

  assert.deepEqual(response, beforeLateCancel);
  assert.equal(responseReport(response).control.outcome, "completed");
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("continuation preserves consumed transitions and resumes to completion", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "continuation-leaf",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "leaf-selector",
        }),
      ]),
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("leaf-selector", ["increment-counter"]),
    ],
  });
  const firstRequest = makeRequest({
    limits: {
      maxTransitions: 2,
      maxDepth: 8,
      maxDerivedGoals: 8,
    },
  });
  const firstResponse = await api.runRecursiveGoal(firstRequest, deps);
  const firstReport = responseReport(firstResponse);

  assert.equal(firstReport.control.outcome, "exceeded");
  assert.equal(firstReport.budgetUsed.transitionsUsed, 2);
  assert.ok(firstReport.continuation);

  const secondRequest = {
    ...firstRequest,
    continuation: firstReport.continuation,
    limits: {
      maxTransitions: 16,
      maxDepth: 8,
      maxDerivedGoals: 8,
    },
  };
  const secondResponse = await api.runRecursiveGoal(secondRequest, deps);
  const secondReport = responseReport(secondResponse);

  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(secondReport.rootEvaluation.state, "evaluated");
  assert.equal(secondReport.rootEvaluation.result, "satisfied");
  assert.equal(
    secondReport.budgetUsed.transitionsUsed >= firstReport.budgetUsed.transitionsUsed,
    true,
  );
  assert.equal(fixture.calls.executeAtomic, 1);
  assertResponseReferencesClosed(secondResponse);
});

test("unknown mutating dispatch is never replayed and continuation uses explicit read-only evidence", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    derive: (input) =>
      derivation([
        condition({
          id: "uncertain-effect-child",
          goal: input.goal,
          bindings: input.bindings,
          mode: "atomic",
          selectorId: "effect-selector",
          allowedEffects: ["fixture.write"],
        }),
      ]),
    select: (input, _calls, memory) => {
      if (input.selectorId === "effect-selector") {
        return {
          kind: "selected",
          skillId: memory.unknownDispatchObserved
            ? "verify-read-only"
            : "write-mutating",
        };
      }
      return { kind: "selected", skillId: "compose-counter" };
    },
    executeAtomic: (input, calls, memory) => {
      if (input.skill.id === "write-mutating") {
        memory.unknownDispatchObserved = true;
        return unknownAtomicReceipt();
      }
      if (input.skill.id === "verify-read-only") {
        return successfulAtomicReceipt({
          count: 1,
          stateId: `verified-state-${calls.executeAtomic}`,
          evidenceId: `verified-evidence-${calls.executeAtomic}`,
        });
      }
      throw new Error(`unexpected atomic skill ${input.skill.id}`);
    },
  });
  const deps = dependencies(fixture.adapter, {
    enabledSkills: [
      skill("compose-counter", "composite", {
        allowedEffects: ["fixture.write"],
      }),
      skill("write-mutating", "atomic", {
        effectClass: "mutating",
        allowedEffects: ["fixture.write"],
        requiredEffects: ["fixture.write"],
      }),
      skill("verify-read-only", "atomic", {
        effectClass: "read_only",
      }),
    ],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("effect-selector", ["write-mutating", "verify-read-only"]),
    ],
    grantedEffects: new Set(["fixture.write"]),
  });
  const firstRequest = makeRequest();
  const firstResponse = await api.runRecursiveGoal(firstRequest, deps);
  const firstReport = responseReport(firstResponse);
  const firstEffects = firstReport.effects.filter(
    (effect) => effect.skillId === "write-mutating",
  );

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(firstEffects.length, 1);
  assert.equal(firstEffects[0].knowledge, "unknown");
  assert.equal(firstReport.control.outcome, "error");
  assert.equal(
    firstReport.errors.some(
      (error) =>
        error.code === "effect_outcome_unknown" ||
        error.code === "evidence_unavailable",
    ),
    true,
  );
  assert.ok(firstReport.continuation);
  assertResponseReferencesClosed(firstResponse);

  const secondResponse = await api.runRecursiveGoal(
    {
      ...firstRequest,
      continuation: firstReport.continuation,
    },
    deps,
  );
  const secondReport = responseReport(secondResponse);
  const writeCount = fixture.calls.executeAtomic;

  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(
    secondReport.atomicResults.filter((result) => result.skillId === "write-mutating")
      .length,
    1,
  );
  assert.equal(
    secondReport.atomicResults.filter((result) => result.skillId === "verify-read-only")
      .length,
    1,
  );
  assert.equal(writeCount, 2, "one write and one read-only verification call");
  assertResponseReferencesClosed(secondResponse);
});

test("unknown and mixed effects without read-only recovery stay unreplayed", async () => {
  const api = await loadPublicApi();
  const cases = [
    {
      name: "unknown",
      receipt: () => unknownAtomicReceipt(),
    },
    {
      name: "mixed",
      receipt: () =>
        unknownAtomicReceipt({
          effect: {
            knowledge: "mixed",
            confirmedEffects: [{ fixtureEffect: "partially-observed" }],
            receiptRef: "fixture://mixed-dispatch",
          },
        }),
    },
  ];

  for (const effectCase of cases) {
    const fixture = createFixtureAdapter({
      executeAtomic: (_input, _calls, memory) => {
        memory.writeAttempts = (memory.writeAttempts ?? 0) + 1;
        return effectCase.receipt();
      },
    });
    const deps = dependencies(fixture.adapter, {
      enabledSkills: [
        skill("write-mutating", "atomic", {
          effectClass: "mutating",
          allowedEffects: ["fixture.write"],
          requiredEffects: ["fixture.write"],
        }),
      ],
      selectors: [selector("root-selector", ["write-mutating"])],
      grantedEffects: new Set(["fixture.write"]),
    });
    const firstRequest = makeRequest();
    const firstResponse = await api.runRecursiveGoal(firstRequest, deps);
    const firstReport = responseReport(firstResponse);

    assert.equal(fixture.memory.writeAttempts, 1, effectCase.name);
    assert.ok(firstReport.continuation, effectCase.name);

    const secondResponse = await api.runRecursiveGoal(
      {
        ...firstRequest,
        continuation: firstReport.continuation,
      },
      deps,
    );
    const secondReport = responseReport(secondResponse);

    assert.equal(
      fixture.memory.writeAttempts,
      1,
      `${effectCase.name} action must not be replayed`,
    );
    assert.equal(
      secondReport.control.outcome === "error" ||
        secondReport.control.outcome === "stalled",
      true,
      effectCase.name,
    );
    assert.equal(
      secondReport.errors.some(
        (error) =>
          error.code === "effect_outcome_unknown" ||
          error.code === "evidence_unavailable",
      ),
      true,
      effectCase.name,
    );
    assertResponseReferencesClosed(secondResponse);
  }
});

test("malformed validated receipt maps to adapter_contract_invalid after crossing dispatch", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    executeAtomic: () => ({ malformed: true }),
    validateAtomicReceipt: () => ({}),
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

  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(errorsByCode(report, "adapter_contract_invalid").length > 0, true);
  assert.equal(errorsByCode(report, "capability_missing").length, 0);
  assert.equal(report.effects.length, 1);
  assert.equal(
    report.effects[0].knowledge === "unknown" ||
      report.effects[0].knowledge === "mixed",
    true,
  );
  assertResponseReferencesClosed(response);
});

test("cleanup failure is a related issue and never replaces the original primary error", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    supports: (input) => input.skill.id === "fail-primary",
    executeAtomic: () => failedAtomicReceipt(),
    cleanup: () => {
      throw new Error("cleanup failed after primary");
    },
  });
  const request = makeRequest();

  const response = await api.runRecursiveGoal(
    request,
    dependencies(fixture.adapter, {
      enabledSkills: [skill("fail-primary", "atomic")],
      selectors: [selector("root-selector", ["fail-primary"])],
    }),
  );
  const report = responseReport(response);
  const primary = report.errors.find(
    (error) => error.errorId === report.primaryErrorId,
  );
  const cleanupIssue = report.relatedIssues.find(
    (issue) => issue.relation === "cleanup",
  );
  const cleanupError =
    cleanupIssue === undefined
      ? null
      : report.errors.find((error) => error.errorId === cleanupIssue.errorId);

  assert.equal(fixture.calls.cleanup, 1);
  assert.equal(primary?.code, "execution_failed");
  assert.equal(primary?.stage, "execution");
  assert.ok(cleanupIssue, "cleanup failure must be visible");
  assert.equal(cleanupError?.stage, "cleanup");
  assert.notEqual(cleanupIssue.errorId, report.primaryErrorId);
  assertResponseReferencesClosed(response);
});

test("cleanup failure without a primary error remains visible and is not invented as execution failure", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    cleanup: () => {
      throw new Error("optional cleanup failed");
    },
  });

  const response = await api.runRecursiveGoal(
    makeRequest({
      state: { count: 1 },
      initialObservation: initialObservation(),
    }),
    dependencies(fixture.adapter, {
      enabledSkills: [],
      selectors: [selector("root-selector", [])],
    }),
  );
  const report = responseReport(response);
  const cleanupIssue = report.relatedIssues.find(
    (issue) => issue.relation === "cleanup",
  );
  const cleanupError =
    cleanupIssue === undefined
      ? null
      : report.errors.find((error) => error.errorId === cleanupIssue.errorId);

  assert.equal(fixture.calls.cleanup, 1);
  assert.equal(report.primaryErrorId, null);
  assert.equal(report.control.outcome, "completed");
  assert.ok(cleanupIssue, "optional cleanup failure must be visible");
  assert.equal(cleanupError?.code, "adapter_contract_invalid");
  assert.equal(cleanupError?.stage, "cleanup");
  assert.equal(cleanupIssue.affectsCompletion, false);
  assertResponseReferencesClosed(response);
});

test("returned errors, frames, atomic results, effects, and causes form a closed reference graph", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter({
    executeAtomic: () =>
      failedAtomicReceipt({
        executionErrors: [
          diagnostic({
            diagnosticId: "closure-original-error",
            code: "execution_failed",
            stage: "execution",
            sourceCategory: "fixture.closure",
            message: "closure failure",
            nativeCode: "E_CLOSURE",
            refs: ["fixture://closure"],
          }),
        ],
      }),
  });

  const response = await api.runRecursiveGoal(
    makeRequest(),
    dependencies(fixture.adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  const report = responseReport(response);

  assert.ok(report.primaryErrorId);
  assert.equal(report.atomicResults[0].executionErrorIds.length > 0, true);
  assertResponseReferencesClosed(response);
});
