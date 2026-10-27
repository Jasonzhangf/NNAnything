import assert from "node:assert/strict";

export const REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1";
export const CONTINUATION_SCHEMA = "nnanything.recursive-goal.continuation.v1";

export function counterGoal(target = 1, overrides = {}) {
  return {
    kind: "counter",
    capability: "counter.increment",
    target,
    ...overrides,
  };
}

export function makeRequest(overrides = {}) {
  return {
    schema: REQUEST_SCHEMA,
    requestId: "recursive-fixture-request",
    rootGoal: counterGoal(),
    satisfactionThreshold: 100,
    rootBindings: { scope: "fixture" },
    state: { count: 0 },
    rootEvaluatorId: "counter-evaluator",
    rootSelectorId: "root-selector",
    limits: {
      maxTransitions: 32,
      maxDepth: 8,
      maxDerivedGoals: 16,
    },
    ...overrides,
  };
}

export function skill(id, mode, overrides = {}) {
  return {
    id,
    version: "1.0.0",
    mode,
    capability: "counter.increment",
    evaluatorId: "counter-evaluator",
    requiredEffects: [],
    allowedEffects: [],
    retry: "never",
    effectClass: "none",
    ...overrides,
  };
}

export function evaluator(overrides = {}) {
  return {
    id: "counter-evaluator",
    goalType: "counter",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
    ...overrides,
  };
}

export function selector(id, skillIds) {
  return { id, skillIds };
}

export function evidence(id, stateRef, count, validity = "valid") {
  return {
    id,
    stateRef,
    payload: { count },
    validity,
  };
}

export function initialObservation({
  stateId = "fixture-initial-state",
  evidenceId = "fixture-initial-evidence",
  count = 1,
} = {}) {
  return {
    stateId,
    evidence: [evidence(evidenceId, stateId, count)],
  };
}

export function diagnostic(overrides = {}) {
  return {
    diagnosticId: "fixture-diagnostic",
    code: "execution_failed",
    stage: "execution",
    sourceCategory: "fixture.execution",
    message: "fixture execution failed",
    nativeCode: "E_FIXTURE",
    refs: ["fixture://receipt"],
    ...overrides,
  };
}

export function successfulAtomicReceipt({
  count,
  stateId = "state-after",
  evidenceId = "evidence-after",
  runId = "fixture-run",
  effect = {
    knowledge: "none",
    confirmedEffects: [],
    receiptRef: null,
  },
} = {}) {
  const nextCount = count ?? 1;
  return {
    runId,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: {
      tag: "fixture.counter-receipt",
      value: { count: nextCount },
    },
    newState: {
      id: stateId,
      value: {
        count: nextCount,
      },
    },
    evidence: [evidence(evidenceId, stateId, nextCount)],
    executionErrors: [],
    verificationErrors: [],
    effect,
  };
}

export function failedAtomicReceipt(overrides = {}) {
  return {
    runId: "fixture-failed-run",
    executorInvoked: true,
    outcome: "failed",
    sourceResult: {
      tag: "fixture.failure-receipt",
      value: {
        token: "opaque-failure-receipt",
        attempted: true,
      },
    },
    newState: null,
    evidence: [],
    executionErrors: [
      diagnostic({
        diagnosticId: "fixture-execution-error",
        message: "authoritative typed execution failure",
        nativeCode: "E_TYPED_FAILURE",
      }),
    ],
    verificationErrors: [],
    effect: {
      knowledge: "none",
      confirmedEffects: [],
      receiptRef: null,
    },
    ...overrides,
  };
}

export function unknownAtomicReceipt(overrides = {}) {
  return {
    runId: "fixture-unknown-run",
    executorInvoked: "unknown",
    outcome: "unknown",
    sourceResult: null,
    newState: null,
    evidence: [],
    executionErrors: [],
    verificationErrors: [],
    effect: {
      knowledge: "unknown",
      confirmedEffects: [],
      receiptRef: "fixture://unknown-dispatch",
    },
    ...overrides,
  };
}

function currentCount(state) {
  return typeof state?.count === "number" ? state.count : 0;
}

function defaultEvaluation(input, calls, options) {
  const count = currentCount(input.state);
  const target = typeof input.goal?.target === "number" ? input.goal.target : 0;
  const result = count >= target ? "satisfied" : "unsatisfied";
  const observedRefs = input.evidence
    .filter((item) => item.validity === "valid")
    .map((item) => item.id);
  if (result === "satisfied" && observedRefs.length === 0) {
    throw new TypeError("fixture satisfied evaluation requires observable evidence");
  }
  calls.evaluate += 1;
  return {
    evaluatorId: options.evaluatorId ?? "counter-evaluator",
    result,
    satisfaction: result === "satisfied" ? 100 : 0,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: observedRefs,
  };
}

function defaultSelection(input) {
  const preferred = input.goal?.preferredSkillId;
  if (
    typeof preferred === "string" &&
    input.candidates.some((candidate) => candidate.id === preferred)
  ) {
    return { kind: "selected", skillId: preferred };
  }
  const first = input.candidates[0];
  return first
    ? { kind: "selected", skillId: first.id }
    : { kind: "no_capability", searchedSkillIds: [] };
}

function defaultAtomicReceipt(input, calls) {
  const nextCount = currentCount(input.state) + 1;
  const sequence = calls.executeAtomic;
  return successfulAtomicReceipt({
    count: nextCount,
    stateId: `fixture-state-${sequence}`,
    evidenceId: `fixture-evidence-${sequence}`,
    runId: `fixture-run-${sequence}`,
  });
}

export function createFixtureAdapter(options = {}) {
  const calls = {
    validateRequest: 0,
    supports: 0,
    evaluate: 0,
    select: 0,
    derive: 0,
    executeAtomic: 0,
    validateAtomicReceipt: 0,
    measureProgress: 0,
    cleanup: 0,
    collect: 0,
  };
  const memory = {
    unknownDispatchObserved: false,
  };

  const adapter = {
    async validateRequest(request) {
      calls.validateRequest += 1;
      if (options.validateRequest) {
        return options.validateRequest(request, calls, memory);
      }
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation: request.continuation ?? null,
        ...(request.initialObservation === undefined
          ? {}
          : { initialObservation: request.initialObservation }),
      };
    },

    supports(input) {
      calls.supports += 1;
      if (options.supports) {
        return options.supports(input, calls, memory);
      }
      return input.goal?.capability === input.skill.capability;
    },

    async evaluate(input) {
      if (options.evaluate) {
        return options.evaluate(input, calls, memory);
      }
      return defaultEvaluation(input, calls, options);
    },

    async select(input) {
      calls.select += 1;
      if (options.select) {
        return options.select(input, calls, memory);
      }
      return defaultSelection(input);
    },

    async derive(input) {
      calls.derive += 1;
      if (options.derive) {
        return options.derive(input, calls, memory);
      }
      throw new TypeError("fixture derive callback is not configured");
    },

    async executeAtomic(input) {
      calls.executeAtomic += 1;
      if (options.executeAtomic) {
        return options.executeAtomic(input, calls, memory);
      }
      return defaultAtomicReceipt(input, calls);
    },

    validateAtomicReceipt(raw) {
      calls.validateAtomicReceipt += 1;
      if (options.validateAtomicReceipt) {
        return options.validateAtomicReceipt(raw, calls, memory);
      }
      return raw;
    },

    measureProgress(input) {
      calls.measureProgress += 1;
      if (options.measureProgress) {
        return options.measureProgress(input, calls, memory);
      }
      const before = currentCount(input.before);
      const after = currentCount(input.after);
      return after > before
        ? { improved: true, reason: "facts_improved", comparable: true }
        : { improved: false, reason: "none", comparable: true };
    },
  };

  if (options.cleanup) {
    adapter.cleanup = async (input) => {
      calls.cleanup += 1;
      return options.cleanup(input, calls, memory);
    };
  }
  if (options.collect) {
    adapter.collect = async (input) => {
      calls.collect += 1;
      return options.collect(input, calls, memory);
    };
  }

  return { adapter, calls, memory };
}

export function singleChildDerivation({
  id = "child-condition",
  goal,
  bindings,
  mode = "atomic",
  selectorId = "child-selector",
  evaluatorId = "counter-evaluator",
  dependsOn = [],
  lifetime = "stage",
  activation = "required",
  allowedEffects = [],
  cursor = "closed",
  expansion = "closed",
} = {}) {
  return {
    conditions: [
      {
        id,
        goal,
        bindings,
        satisfactionThreshold: 100,
        evaluatorId,
        selectorId,
        mode,
        dependsOn,
        lifetime,
        activation,
        allowedEffects,
      },
    ],
    nextCursor: cursor,
    expansion,
  };
}

export function finiteDerivationAdapter(options = {}) {
  return incrementalChainHarness(options);
}

export function createFiniteBudgetHarness(options = {}) {
  if (options.nested !== undefined) {
    return nestedDepthHarness({
      depth: options.nested.depth ?? 6,
      limits: options.nested.limits,
    });
  }
  return finiteDerivationAdapter(options);
}

// Composite root that repeatedly derives exactly one atomic child. Each child
// carries a per-step goal (current count + 1) so a single increment satisfies
// it, and the root keeps expanding with `expansion: "more"` until the root
// target is met. This exercises real, monotonically increasing progress across
// many transitions and derived goals without any caller-declared cap.
export function incrementalChainHarness(options = {}) {
  const rounds = options.derivationCount ?? options.rounds ?? options.rootTarget ?? 1;
  const fixture = createFixtureAdapter({
    derive: (input, calls) => {
      if (calls.derive > rounds) {
        throw new TypeError("fixture incremental derivation exhausted");
      }
      const current = currentCount(input.state);
      return singleChildDerivation({
        id: `increment-step-${calls.derive}`,
        goal: counterGoal(current + 1),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "open",
        expansion: "more",
      });
    },
    executeAtomic: (input, calls) => {
      const count = currentCount(input.state) + 1;
      return successfulAtomicReceipt({
        count,
        stateId: `finite-state-${calls.executeAtomic}`,
        evidenceId: `finite-evidence-${calls.executeAtomic}`,
        runId: `finite-run-${calls.executeAtomic}`,
      });
    },
    ...options,
  });
  const request = makeRequest({
    rootGoal: counterGoal(options.rootTarget ?? 1),
    state: { count: options.rootCount ?? 0 },
    ...(options.limits === undefined ? { limits: undefined } : { limits: options.limits }),
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    enabledEvaluators: [evaluator()],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("finite-leaf-selector", ["increment-counter"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

// Nested composite chain that descends `depth` composite levels before deriving
// a single atomic leaf. Used to prove that omitting maxDepth allows the goal
// stack to exceed the retired default depth caps.
export function nestedDepthHarness({ depth = 6, limits } = {}) {
  const fixture = createFixtureAdapter({
    derive: (input, calls) => {
      const level = typeof input.goal?.level === "number" ? input.goal.level : 0;
      if (level < depth) {
        return singleChildDerivation({
          id: `nested-composite-${level}`,
          goal: counterGoal(1, { level: level + 1 }),
          bindings: input.bindings,
          mode: "composite",
          selectorId: "finite-child-selector",
          cursor: "closed",
          expansion: "closed",
        });
      }
      const current = currentCount(input.state);
      return singleChildDerivation({
        id: `nested-leaf-${level}`,
        goal: counterGoal(current + 1, { level }),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "closed",
        expansion: "closed",
      });
    },
    executeAtomic: (input, calls) => {
      const count = currentCount(input.state) + 1;
      return successfulAtomicReceipt({
        count,
        stateId: `nested-state-${calls.executeAtomic}`,
        evidenceId: `nested-evidence-${calls.executeAtomic}`,
        runId: `nested-run-${calls.executeAtomic}`,
      });
    },
  });
  const request = makeRequest({
    rootGoal: counterGoal(1, { level: 0 }),
    state: { count: 0 },
    ...(limits === undefined ? { limits: undefined } : { limits }),
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("compose-child", "composite"),
      skill("increment-counter", "atomic"),
    ],
    enabledEvaluators: [evaluator()],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("finite-child-selector", ["compose-child"]),
      selector("finite-leaf-selector", ["increment-counter"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

// Composite root that keeps re-deriving the same obligation with a *new*
// condition id but no real state change. Each derived child is already
// satisfied, so the root never makes business progress while it keeps
// expanding. Used to prove that changing ids/counters is not treated as
// progress and that the composite no-progress detector fires.
export function sameObligationNoProgressHarness({ limits, rootTarget = 100 } = {}) {
  const fixture = createFixtureAdapter({
    derive: (input, calls) => {
      const current = currentCount(input.state);
      return singleChildDerivation({
        id: `stale-obligation-${calls.derive}`,
        goal: counterGoal(current, { obligation: "same" }),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "open",
        expansion: "more",
      });
    },
    executeAtomic: (input, calls) => {
      const count = currentCount(input.state);
      return successfulAtomicReceipt({
        count,
        stateId: `stale-state-${calls.executeAtomic}`,
        evidenceId: `stale-evidence-${calls.executeAtomic}`,
        runId: `stale-run-${calls.executeAtomic}`,
      });
    },
  });
  const request = makeRequest({
    rootGoal: counterGoal(rootTarget),
    state: { count: 0 },
    initialObservation: initialObservation({ count: 0 }),
    ...(limits === undefined ? { limits: undefined } : { limits }),
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    enabledEvaluators: [evaluator()],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("finite-leaf-selector", ["increment-counter"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

export function completionAdapter({
  rootTarget = 1,
  rootCount = 0,
  deriveFactory,
  ...adapterOptions
} = {}) {
  const rootGoal = counterGoal(rootTarget);
  const fixture = createFixtureAdapter({
    derive:
      deriveFactory ??
      ((input, calls, memory) =>
        singleChildDerivation({
          goal: input.goal,
          bindings: input.bindings,
        })),
    ...adapterOptions,
  });
  const request = makeRequest({
    rootGoal,
    state: { count: rootCount },
    ...(rootCount >= rootTarget
      ? { initialObservation: initialObservation({ count: rootCount }) }
      : {}),
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    enabledEvaluators: [evaluator()],
    selectors: [
      selector("root-selector", ["compose-counter"]),
      selector("child-selector", ["increment-counter"]),
    ],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
  return { request, deps, fixture };
}

export function responseReport(response) {
  assert.equal(response.kind, "run_result");
  return response.report;
}

export function errorsByCode(report, code) {
  return report.errors.filter((error) => error.code === code);
}

export function hasExecutionDiagnostic(report, diagnosticId) {
  return report.atomicResults.some(
    (result) =>
      result.executionErrorIds.includes(diagnosticId) ||
      result.verificationErrorIds.includes(diagnosticId),
  );
}

export function assertResponseReferencesClosed(response) {
  const report =
    response.kind === "run_result"
      ? response.report
      : response.kind === "module_fault"
        ? response.report
        : null;

  if (response.kind === "request_rejected") {
    assert.equal(response.acceptedRoot, null);
    assert.equal(response.error.errorId.length > 0, true);
    return;
  }
  if (response.kind === "module_fault") {
    assert.ok(response.fault);
    assert.equal(response.fault.errorId.length > 0, true);
  }
  if (report === null) return;

  const frameIds = new Set(report.frames.map((frame) => frame.frameId));
  const errorIds = new Set(report.errors.map((error) => error.errorId));
  const atomicIds = new Set(report.atomicResults.map((result) => result.dispatchId));
  const effectIds = new Set(report.effects.map((effect) => effect.dispatchId));
  const stateIds = new Set(report.states.map((state) => state.id));
  const evidenceIds = new Set(report.evidence.map((item) => item.id));

  assert.equal(frameIds.size, report.frames.length);
  assert.equal(errorIds.size, report.errors.length);
  assert.equal(atomicIds.size, report.atomicResults.length);
  assert.equal(effectIds.size, report.effects.length);
  assert.equal(stateIds.size, report.states.length);
  assert.equal(evidenceIds.size, report.evidence.length);

  if (report.primaryErrorId !== null) {
    assert.ok(errorIds.has(report.primaryErrorId));
  }
  for (const issue of report.relatedIssues) {
    assert.ok(errorIds.has(issue.errorId));
  }
  for (const frame of report.frames) {
    if (frame.errorId !== null) assert.ok(errorIds.has(frame.errorId));
    for (const evidenceRef of frame.evidenceRefs) {
      assert.ok(evidenceIds.has(evidenceRef));
    }
    for (const dispatchRef of frame.dispatchRefs) {
      assert.ok(effectIds.has(dispatchRef));
    }
    for (const atomicRef of frame.atomicResultRefs) {
      assert.ok(atomicIds.has(atomicRef));
    }
    for (const condition of frame.conditionResults) {
      if (condition.childFrameId !== null) {
        assert.ok(frameIds.has(condition.childFrameId));
      }
    }
  }
  for (const result of report.atomicResults) {
    assert.ok(frameIds.has(result.frameId));
    assert.ok(effectIds.has(result.dispatchId));
    if (result.observedStateRef !== null) {
      assert.ok(stateIds.has(result.observedStateRef));
    }
    for (const errorId of [
      ...result.executionErrorIds,
      ...result.verificationErrorIds,
    ]) {
      assert.ok(errorIds.has(errorId));
    }
  }
  for (const effect of report.effects) {
    assert.ok(frameIds.has(effect.frameId));
  }
  for (const item of report.evidence) {
    assert.ok(stateIds.has(item.stateRef));
  }
  if (report.rootEvaluation.state === "evaluated") {
    for (const evidenceRef of report.rootEvaluation.evidenceRefs) {
      assert.ok(evidenceIds.has(evidenceRef));
    }
  }

  const byErrorId = new Map(report.errors.map((error) => [error.errorId, error]));
  for (const error of report.errors) {
    if (error.origin.frameId !== null) {
      assert.ok(frameIds.has(error.origin.frameId));
    }
    for (const atomicRef of error.atomicResultRefs) {
      assert.ok(atomicIds.has(atomicRef));
    }
    if (error.cause?.kind === "error_ref") {
      assert.ok(errorIds.has(error.cause.errorId));
    }
    for (const propagation of error.propagation) {
      assert.ok(frameIds.has(propagation.frameId));
      if (propagation.parentFrameId !== null) {
        assert.ok(frameIds.has(propagation.parentFrameId));
      }
      if (propagation.satisfies !== null) {
        assert.ok(frameIds.has(propagation.satisfies.frameId));
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (errorId) => {
    assert.equal(visiting.has(errorId), false, "error cause cycle");
    if (visited.has(errorId)) return;
    visiting.add(errorId);
    const cause = byErrorId.get(errorId)?.cause;
    if (cause?.kind === "error_ref") visit(cause.errorId);
    visiting.delete(errorId);
    visited.add(errorId);
  };
  for (const errorId of errorIds) visit(errorId);
}
