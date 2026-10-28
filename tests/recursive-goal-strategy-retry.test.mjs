import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertResponseReferencesClosed,
  evaluator,
  evidence,
  makeRequest,
  responseReport,
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

function retryPolicy(overrides = {}) {
  return {
    kind: "bounded_strategy_retry.v1",
    selectorId: "root-selector",
    strategySkillIds: ["strategy-a", "strategy-b"],
    sameFailureLimit: 2,
    maxAtomicAttempts: 4,
    ...overrides,
  };
}

function retryRequest(options = {}) {
  const policy = Object.hasOwn(options, "policy")
    ? options.policy
    : retryPolicy();
  const invocation = Object.hasOwn(options, "invocation")
    ? options.invocation
    : { maxAtomicDispatches: 1 };
  const { continuation, ...requestOverrides } = options;
  const overrides = { ...requestOverrides };
  delete overrides.policy;
  delete overrides.invocation;
  return makeRequest({
    ...(policy === undefined ? {} : { retryPolicy: policy }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(continuation === undefined ? {} : { continuation }),
    ...overrides,
  });
}

function atomicResult({
  count,
  stateId,
  evidenceId,
  effectKnowledge = "none",
  outcome = "succeeded",
}) {
  return {
    runId: `run-${stateId}`,
    executorInvoked: true,
    outcome,
    sourceResult: {
      tag: "fixture.strategy-step",
      value: { count },
    },
    newState: {
      id: stateId,
      value: { count },
    },
    evidence: [evidence(evidenceId, stateId, count)],
    executionErrors: [],
    verificationErrors: [],
    effect: {
      knowledge: effectKnowledge,
      confirmedEffects:
        effectKnowledge === "known"
          ? [{ kind: "fixture.side-effect" }]
          : [],
      receiptRef:
        effectKnowledge === "none" ? null : `fixture://${stateId}/effect`,
    },
  };
}

function createRetryFixture({
  evaluate,
  select,
  executeAtomic,
  assessRetry,
} = {}) {
  const calls = {
    evaluate: 0,
    select: 0,
    executeAtomic: 0,
    assessRetry: 0,
  };
  const selectedViews = [];
  const atomicViews = [];

  const adapter = {
    async validateRequest(request) {
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        ...(request.initialObservation === undefined ? {} : { initialObservation: request.initialObservation }),
        continuation: request.continuation ?? null,
        retryPolicy: request.retryPolicy,
      };
    },

    supports(input) {
      return ["strategy-a", "strategy-b"].includes(input.skill.id);
    },

    async evaluate(input) {
      calls.evaluate += 1;
      if (evaluate) {
        return evaluate(input, calls);
      }
      const count = input.state?.count ?? 0;
      const result = count >= 1 ? "satisfied" : "unsatisfied";
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

    async select(input) {
      calls.select += 1;
      selectedViews.push(input.retry);
      if (select) {
        return select(input, calls);
      }
      return input.candidates[0]
        ? { kind: "selected", skillId: input.candidates[0].id }
        : { kind: "defer", reason: "fixture.no_candidate" };
    },

    async derive() {
      throw new TypeError("retry fixture does not derive");
    },

    async executeAtomic(input) {
      calls.executeAtomic += 1;
      atomicViews.push(input.retry);
      if (executeAtomic) {
        return executeAtomic(input, calls);
      }
      const sequence = calls.executeAtomic;
      const attemptKey = input.retry?.remainingAtomicAttempts ?? sequence;
      if (input.skill.id === "strategy-b") {
        return atomicResult({
          count: 1,
          stateId: `state-${attemptKey}`,
          evidenceId: `evidence-${attemptKey}`,
        });
      }
      return atomicResult({
        count: input.state?.count ?? 0,
        stateId: `state-${attemptKey}`,
        evidenceId: `evidence-${attemptKey}`,
      });
    },

    validateAtomicReceipt(raw) {
      return raw;
    },

    measureProgress() {
      return { improved: false, reason: "none", comparable: true };
    },

    async assessRetry(input, fixtureCalls = calls) {
      fixtureCalls.assessRetry += 1;
      if (assessRetry) {
        return assessRetry(input, fixtureCalls);
      }
      return {
        kind: "safe_same_failure",
        failureKey: "same-folded-region",
        evidenceRefs: [...input.evaluation.evidenceRefs],
      };
    },
  };

  const skills = [
    skill("strategy-a", "atomic", {
      retry: "completed_no_effect",
      capability: "counter.increment",
    }),
    skill("strategy-b", "atomic", {
      retry: "completed_no_effect",
      capability: "counter.increment",
    }),
  ];
  const deps = {
    adapter,
    enabledSkills: skills,
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["strategy-a", "strategy-b"])],
    comparators: comparators(),
    grantedEffects: new Set(),
  };

  return { adapter, calls, deps, selectedViews, atomicViews };
}

async function invoke(api, fixture, request) {
  return api.runRecursiveGoal(request, fixture.deps);
}

function resumeData(continuation) {
  return JSON.parse(JSON.stringify(continuation));
}

function assertYielded(report) {
  assert.equal(report.control.outcome, "yielded");
  assert.equal(report.control.stopReason, "step_boundary");
  assert.ok(report.continuation);
  assert.ok(report.continuation.retryControl);
}

test("bounded retry yields after A, locks A, exhausts it, then lets the selector choose B", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const firstRequest = retryRequest();

  const first = await invoke(api, fixture, firstRequest);
  const firstReport = responseReport(first);
  assertYielded(firstReport);
  assert.equal(fixture.calls.executeAtomic, 1);
  const firstFrameRetry = firstReport.continuation.retryControl.frames.find(
    (frame) => frame.frameId === firstReport.frames[0].frameId,
  );
  assert.equal(firstFrameRetry.lockedSkillId, "strategy-a");
  assert.equal(firstFrameRetry.lastAccountedDispatchId, firstReport.atomicResults[0].dispatchId);
  assert.deepEqual(
    firstFrameRetry.strategies.map((strategy) => [
      strategy.skillId,
      strategy.failures[0]?.count ?? 0,
      strategy.exhausted,
    ]),
    [
      ["strategy-a", 1, false],
      ["strategy-b", 0, false],
    ],
  );
  assert.equal(firstReport.continuation.retryControl.atomicAttemptsUsed, 1);

  const second = await invoke(
    api,
    fixture,
    retryRequest({ continuation: resumeData(firstReport.continuation) }),
  );
  const secondReport = responseReport(second);
  assertYielded(secondReport);
  assert.equal(fixture.calls.executeAtomic, 2);
  const secondFrameRetry = secondReport.continuation.retryControl.frames.find(
    (frame) => frame.frameId === secondReport.frames[0].frameId,
  );
  assert.equal(secondFrameRetry.lockedSkillId, null);
  assert.deepEqual(
    secondFrameRetry.strategies.map((strategy) => [
      strategy.skillId,
      strategy.failures[0]?.count ?? 0,
      strategy.exhausted,
    ]),
    [
      ["strategy-a", 2, true],
      ["strategy-b", 0, false],
    ],
  );
  assert.equal(secondReport.continuation.retryControl.atomicAttemptsUsed, 2);

  const third = await invoke(
    api,
    fixture,
    retryRequest({ continuation: resumeData(secondReport.continuation) }),
  );
  const thirdReport = responseReport(third);
  assert.equal(thirdReport.control.outcome, "completed");
  assert.equal(thirdReport.continuation, null);
  assert.equal(fixture.calls.executeAtomic, 3);
  assert.deepEqual(
    fixture.atomicViews.map((view) => view.remainingAtomicAttempts),
    [4, 3, 2],
  );
  assert.deepEqual(
    fixture.selectedViews.map((view) => view?.eligibleSkillIds),
    [
      ["strategy-a", "strategy-b"],
      ["strategy-a"],
      ["strategy-b"],
    ],
  );
  assertResponseReferencesClosed(first);
  assertResponseReferencesClosed(second);
  assertResponseReferencesClosed(third);
});

test("serialized continuation resumes in a fresh fixture from retryControl alone", async () => {
  const api = await loadPublicApi();
  const firstFixture = createRetryFixture();
  const first = await invoke(api, firstFixture, retryRequest());
  const firstReport = responseReport(first);
  assertYielded(firstReport);

  const secondFixture = createRetryFixture();
  const second = await invoke(
    api,
    secondFixture,
    retryRequest({
      continuation: resumeData(firstReport.continuation),
    }),
  );
  const secondReport = responseReport(second);

  assertYielded(secondReport);
  assert.equal(secondFixture.calls.evaluate, 1);
  assert.equal(secondFixture.calls.select, 1);
  assert.equal(secondFixture.calls.executeAtomic, 1);
  assert.equal(secondFixture.calls.assessRetry, 1);
  assert.deepEqual(
    secondFixture.atomicViews.map((view) => view.remainingAtomicAttempts),
    [3],
  );
  const frameRetry = secondReport.continuation.retryControl.frames.find(
    (frame) => frame.frameId === secondReport.frames[0].frameId,
  );
  assert.equal(
    secondReport.continuation.retryControl.atomicAttemptsUsed,
    2,
  );
  assert.deepEqual(
    frameRetry.strategies.map((strategy) => [
      strategy.skillId,
      strategy.failures[0]?.count ?? 0,
      strategy.exhausted,
    ]),
    [
      ["strategy-a", 2, true],
      ["strategy-b", 0, false],
    ],
  );
});

test("four safe no-effect failures exhaust both strategies without the legacy two-attempt stop", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture({
    executeAtomic: (input) => {
      const attemptKey = input.retry.remainingAtomicAttempts;
      return atomicResult({
        count: input.state?.count ?? 0,
        stateId: `stalled-state-${attemptKey}`,
        evidenceId: `stalled-evidence-${attemptKey}`,
      });
    },
  });
  const response = await invoke(
    api,
    fixture,
    retryRequest({
      invocation: undefined,
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "stalled");
  assert.equal(report.control.stopReason, "no_progress");
  assert.equal(fixture.calls.executeAtomic, 4);
  assert.equal(
    report.errors.some(
      (error) =>
        error.code === "no_progress" &&
        error.source.category === "strategies_exhausted",
    ),
    true,
  );
  assert.equal(report.atomicResults.length, 4);
  assert.equal(report.effects.every((effect) => effect.knowledge === "none"), true);
  assertResponseReferencesClosed(response);
});

test("n=1 exhausts A after its first safe failure and still requires the selector to choose B", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const first = await invoke(
    api,
    fixture,
    retryRequest({
      policy: retryPolicy({ sameFailureLimit: 1, maxAtomicAttempts: 2 }),
    }),
  );
  const firstReport = responseReport(first);
  assertYielded(firstReport);
  assert.equal(fixture.calls.executeAtomic, 1);

  const second = await invoke(
    api,
    fixture,
    retryRequest({
      policy: retryPolicy({ sameFailureLimit: 1, maxAtomicAttempts: 2 }),
      continuation: resumeData(firstReport.continuation),
    }),
  );
  const secondReport = responseReport(second);
  assert.equal(secondReport.control.outcome, "completed");
  assert.equal(fixture.calls.executeAtomic, 2);
  assert.deepEqual(
    fixture.selectedViews.map((view) => view?.eligibleSkillIds),
    [["strategy-a", "strategy-b"], ["strategy-b"]],
  );
});

test("selector defer stops with policy_deferred and never dispatches a fallback", async () => {
  const api = await loadPublicApi();
  let defer = false;
  const fixture = createRetryFixture({
    select: (input) =>
      defer
        ? { kind: "defer", reason: "fixture.score_not_positive" }
        : { kind: "selected", skillId: input.candidates[0].id },
  });
  const policy = retryPolicy({ sameFailureLimit: 1, maxAtomicAttempts: 2 });
  const first = await invoke(api, fixture, retryRequest({ policy }));
  const firstReport = responseReport(first);
  assertYielded(firstReport);
  defer = true;

  const second = await invoke(
    api,
    fixture,
    retryRequest({ policy, continuation: resumeData(firstReport.continuation) }),
  );
  const secondReport = responseReport(second);
  assert.equal(secondReport.control.outcome, "stalled");
  assert.equal(secondReport.control.stopReason, "no_progress");
  assert.equal(secondReport.errors.some((error) => error.code === "policy_deferred"), true);
  assert.equal(secondReport.errors.some((error) => error.code === "capability_missing"), false);
  assert.equal(fixture.calls.executeAtomic, 1);
});

test("selector choice outside the filtered eligible set is policy_error with no fallback", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture({
    select: (input, calls) =>
      calls.select === 1
        ? { kind: "selected", skillId: input.candidates[0].id }
        : { kind: "selected", skillId: "strategy-a" },
  });
  const policy = retryPolicy({ sameFailureLimit: 1, maxAtomicAttempts: 2 });
  const first = await invoke(api, fixture, retryRequest({ policy }));
  const firstReport = responseReport(first);
  assertYielded(firstReport);

  const second = await invoke(
    api,
    fixture,
    retryRequest({ policy, continuation: resumeData(firstReport.continuation) }),
  );
  const secondReport = responseReport(second);

  assert.equal(secondReport.control.outcome, "error");
  assert.equal(secondReport.control.stopReason, "fatal_error");
  assert.equal(
    secondReport.errors.some(
      (error) =>
        error.code === "policy_error" &&
        error.source.category === "selection_head",
    ),
    true,
  );
  assert.equal(fixture.calls.executeAtomic, 1);
});

test("successful-looking atomic outcome with unknown effects stops before assessRetry", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture({
    executeAtomic: (input, calls) =>
      atomicResult({
        count: input.state?.count ?? 0,
        stateId: `unknown-state-${calls.executeAtomic}`,
        evidenceId: `unknown-evidence-${calls.executeAtomic}`,
        effectKnowledge: "unknown",
      }),
  });
  const response = await invoke(api, fixture, retryRequest());
  const report = responseReport(response);

  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(fixture.calls.assessRetry, 0);
  assert.equal(
    report.errors.some(
      (error) =>
        error.code === "effect_outcome_unknown" &&
        error.source.category === "retry_effect_not_none",
    ),
    true,
  );
});

test("assessRetry stop and callback errors stop without counting the retry", async () => {
  const api = await loadPublicApi();
  const stopFixture = createRetryFixture({
    assessRetry: () => ({
      kind: "stop",
      reason: "effects_not_none",
    }),
  });
  const stopped = await invoke(api, stopFixture, retryRequest());
  const stoppedReport = responseReport(stopped);
  assert.equal(stoppedReport.control.outcome, "error");
  assert.equal(stopFixture.calls.executeAtomic, 1);
  assert.equal(stopFixture.calls.assessRetry, 1);
  assert.equal(
    stoppedReport.errors.some(
      (error) =>
        error.code === "effect_denied" &&
        error.source.category === "retry_assessment:effects_not_none",
    ),
    true,
  );
  assert.equal(
    stoppedReport.continuation.retryControl.frames[0].lastAccountedDispatchId,
    null,
  );
  assert.equal(
    stoppedReport.continuation.retryControl.frames[0].strategies[0].failures.length,
    0,
  );

  const errorFixture = createRetryFixture({
    assessRetry: () => {
      throw new Error("fixture retry assessment failed");
    },
  });
  const failed = await invoke(api, errorFixture, retryRequest());
  const failedReport = responseReport(failed);
  assert.equal(failedReport.control.outcome, "error");
  assert.equal(errorFixture.calls.executeAtomic, 1);
  assert.equal(errorFixture.calls.assessRetry, 1);
  assert.equal(
    failedReport.errors.some(
      (error) =>
        error.code === "adapter_contract_invalid" &&
        error.source.category === "assess_retry",
    ),
    true,
  );
  assert.equal(
    failedReport.continuation.retryControl.frames[0].lastAccountedDispatchId,
    null,
  );
});

test("continuation rejects policy omissions, mutations, duplicate accounting, and illegal lock state", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const first = await invoke(api, fixture, retryRequest());
  const firstReport = responseReport(first);
  assertYielded(firstReport);

  const mutations = [
    {
      name: "missing policy",
      stage: "binding",
      category: "continuation_contract",
      request: retryRequest({
        policy: undefined,
        continuation: resumeData(firstReport.continuation),
      }),
    },
    {
      name: "changed failure limit",
      stage: "binding",
      category: "continuation_contract",
      request: retryRequest({
        policy: retryPolicy({ sameFailureLimit: 3 }),
        continuation: resumeData(firstReport.continuation),
      }),
    },
    {
      name: "changed strategy set",
      stage: "admission",
      category: "dependency_contract",
      request: retryRequest({
        policy: retryPolicy({ strategySkillIds: ["strategy-a"] }),
        continuation: resumeData(firstReport.continuation),
      }),
    },
    {
      name: "raised attempt budget",
      stage: "binding",
      category: "continuation_contract",
      request: retryRequest({
        policy: retryPolicy({ maxAtomicAttempts: 5 }),
        continuation: resumeData(firstReport.continuation),
      }),
    },
  ];

  const continuation = structuredClone(firstReport.continuation);
  const frameRetry = continuation.retryControl.frames[0];
  continuation.retryControl.atomicAttemptsUsed = 0;
  mutations.push({
    name: "rewound attempt count",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation }),
  });

  const duplicate = structuredClone(firstReport.continuation);
  duplicate.retryControl.frames[0].strategies[0].failures.push({
    failureKey: "same-folded-region",
    count: 1,
  });
  mutations.push({
    name: "duplicate failure key",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation: duplicate }),
  });

  const badLedger = structuredClone(firstReport.continuation);
  badLedger.retryControl.frames[0].lastAccountedDispatchId = "missing-dispatch";
  mutations.push({
    name: "unknown accounted dispatch",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation: badLedger }),
  });

  const badLock = structuredClone(firstReport.continuation);
  badLock.retryControl.frames[0].lockedSkillId = null;
  mutations.push({
    name: "missing safe-failure lock",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation: badLock }),
  });

  const badExhaustion = structuredClone(firstReport.continuation);
  badExhaustion.retryControl.frames[0].strategies[0].failures[0].count = 2;
  mutations.push({
    name: "false unexhausted state",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation: badExhaustion }),
  });

  const forgedYield = resumeData(firstReport.continuation);
  forgedYield.control.stopReason = "budget";
  mutations.push({
    name: "yield relabeled as budget",
    stage: "binding",
    category: "continuation",
    request: retryRequest({ continuation: forgedYield }),
  });

  assert.equal(frameRetry.lockedSkillId, "strategy-a");
  for (const mutation of mutations) {
    const response = await invoke(api, fixture, mutation.request);
    assert.equal(response.kind, "request_rejected", mutation.name);
    assert.equal(response.error.stage, mutation.stage, mutation.name);
    assert.equal(response.error.source.category, mutation.category, mutation.name);
  }
  assert.equal(fixture.calls.executeAtomic, 1);
});

test("continuation rejects count changes that do not match accounted dispatches", async () => {
  const api = await loadPublicApi();
  const policy = retryPolicy({
    sameFailureLimit: 3,
    maxAtomicAttempts: 4,
  });
  const fixture = createRetryFixture();
  const first = await invoke(api, fixture, retryRequest({ policy }));
  const firstReport = responseReport(first);
  assertYielded(firstReport);

  const duplicateCount = resumeData(firstReport.continuation);
  duplicateCount.retryControl.frames[0].strategies[0].failures.push({
    failureKey: "second-unique-key",
    count: 1,
  });

  const raisedCount = resumeData(firstReport.continuation);
  raisedCount.retryControl.frames[0].strategies[0].failures[0].count = 2;

  for (const [name, continuation] of [
    ["duplicate count", duplicateCount],
    ["raised count", raisedCount],
  ]) {
    const response = await invoke(
      api,
      fixture,
      retryRequest({ policy, continuation }),
    );
    assert.equal(response.kind, "request_rejected", name);
    assert.equal(response.error.stage, "binding", name);
    assert.equal(response.error.source.category, "continuation", name);
  }
  assert.equal(fixture.calls.executeAtomic, 1);
});

test("an atomic callback exception consumes the total attempt budget without a free retry", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture({
    executeAtomic: () => {
      throw new Error("fixture callback failed after authorization");
    },
  });
  const policy = retryPolicy({ maxAtomicAttempts: 1 });
  const first = await invoke(api, fixture, retryRequest({ policy }));
  const firstReport = responseReport(first);

  assert.equal(firstReport.control.outcome, "error");
  assert.equal(firstReport.continuation.retryControl.atomicAttemptsUsed, 1);
  assert.equal(fixture.calls.executeAtomic, 1);

  const second = await invoke(
    api,
    fixture,
    retryRequest({ policy, continuation: resumeData(firstReport.continuation) }),
  );
  const secondReport = responseReport(second);
  assert.equal(secondReport.control.outcome, "exceeded");
  assert.equal(secondReport.control.stopReason, "budget");
  assert.equal(secondReport.errors.some((error) => error.code === "budget_exceeded"), true);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(fixture.calls.select, 1);
});

test("a final safe attempt at the total budget stops before selecting another strategy", async () => {
  const api = await loadPublicApi();
  const policy = retryPolicy({
    sameFailureLimit: 3,
    maxAtomicAttempts: 1,
  });
  const fixture = createRetryFixture();
  const response = await invoke(
    api,
    fixture,
    retryRequest({ policy, invocation: undefined }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.deepEqual(report.control.budget, {
    dimension: "maxAtomicAttempts",
    limit: 1,
    used: 1,
    attempted: 2,
  });
  assert.equal(fixture.calls.select, 1);
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.equal(fixture.calls.assessRetry, 1);
  assert.equal(fixture.atomicViews[0].remainingAtomicAttempts, 1);
  assert.equal(
    report.errors.some((error) => error.code === "budget_exceeded"),
    true,
  );
});

test("omitted maxAtomicAttempts leaves the total ceiling unknown but keeps same-failure recovery", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const policy = retryPolicy({ sameFailureLimit: 1 });
  delete policy.maxAtomicAttempts;

  const response = await invoke(
    api,
    fixture,
    retryRequest({ policy, invocation: undefined }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "completed");
  assert.equal(report.control.budget, undefined);
  assert.deepEqual(
    fixture.atomicViews.map((view) => view.remainingAtomicAttempts),
    [null, null],
  );
  assert.equal(fixture.calls.executeAtomic, 2);
  assertResponseReferencesClosed(response);
});

test("an already satisfied root ignores retry and returns the legacy-shaped continuation", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const response = await invoke(
    api,
    fixture,
    retryRequest({
      state: { count: 1 },
      initialObservation: {
        stateId: "satisfied-initial-state",
        evidence: [evidence("satisfied-initial-evidence", "satisfied-initial-state", 1)],
      },
    }),
  );
  const report = responseReport(response);

  assert.equal(report.control.outcome, "completed");
  assert.equal(report.continuation, null);
  assert.equal(fixture.calls.executeAtomic, 0);
  assert.equal(fixture.calls.assessRetry, 0);
});

test("requests without a retry policy keep retry views absent", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const response = await invoke(
    api,
    fixture,
    makeRequest({
      limits: {
        maxTransitions: 1,
        maxDepth: 8,
        maxDerivedGoals: 8,
      },
    }),
  );
  const report = responseReport(response);

  assert.equal(fixture.calls.evaluate, 1);
  assert.equal(fixture.calls.select, 0);
  assert.equal(report.continuation.retryControl, undefined);
  assert.equal("retryControl" in report.continuation, false);
});

test("legacy selector and atomic callbacks receive no retry view without policy", async () => {
  const api = await loadPublicApi();
  const fixture = createRetryFixture();
  const response = await invoke(api, fixture, makeRequest());
  const report = responseReport(response);

  assert.equal(report.control.outcome, "stalled");
  assert.equal(fixture.calls.select, 2);
  assert.equal(fixture.calls.executeAtomic, 2);
  assert.equal(fixture.calls.assessRetry, 0);
  assert.deepEqual(fixture.selectedViews, [undefined, undefined]);
  assert.deepEqual(fixture.atomicViews, [undefined, undefined]);
  assert.equal(report.continuation.retryControl, undefined);
  assert.equal("retryControl" in report.continuation, false);
  assertResponseReferencesClosed(response);
});
