import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertResponseReferencesClosed,
  counterGoal,
  createFiniteBudgetHarness,
  createFixtureAdapter,
  errorsByCode,
  evidence,
  evaluator,
  initialObservation,
  makeRequest,
  responseReport,
  sameObligationNoProgressHarness,
  selector,
  skill,
  singleChildDerivation,
  successfulAtomicReceipt,
} from "./recursive-goal-fixtures.mjs";
import {
  createBoundedFiniteResources,
  runBoundedFiniteStep,
} from "../playground/recursive-goal/bounded-finite.mjs";

let publicApi;
let workflowApi;

async function loadPublicApi() {
  publicApi ??= await import("nnanything/recursive-goal");
  return publicApi;
}

async function loadWorkflowApi() {
  workflowApi ??= await import("nnanything");
  return workflowApi;
}

function workflowNode({
  operator,
  input,
  inputSchema,
  inputType,
  output,
  outputSchema,
  outputType,
}) {
  return {
    operator,
    version: "0.2.0.0001",
    inputPorts: [
      {
        name: input,
        schemaId: inputSchema,
        eventType: inputType,
        validate: (value) => value,
      },
    ],
    outputPort: {
      name: output,
      schemaId: outputSchema,
      eventType: outputType,
      validate: (value) => value,
    },
    execute: (context) => context.emit({}),
  };
}

function depsFor(fixture, overrides = {}) {
  return {
    adapter: fixture.adapter,
    enabledSkills: [],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", [])],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
    ...overrides,
  };
}

function legacyContinuationWithoutCompositeCycleBaseline(continuation) {
  const legacy = structuredClone(continuation);
  for (const control of legacy.frameControls) {
    delete control.compositeCycleBaseline;
  }
  return legacy;
}

test("public recursive-goal subpath exposes runRecursiveGoal", async () => {
  const api = await loadPublicApi();
  assert.equal(typeof api.runRecursiveGoal, "function");
});

test("malformed request is rejected before adapter work and never creates a root", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest({
    schema: "nnanything.recursive-goal.request.invalid",
  });

  const response = await api.runRecursiveGoal(request, depsFor(fixture));

  assert.equal(response.kind, "request_rejected");
  assert.equal(response.acceptedRoot, null);
  assert.equal(response.error.code, "invalid_request");
  assert.equal(response.error.stage, "admission");
  assert.equal(fixture.calls.validateRequest, 0);
  assert.equal(fixture.calls.evaluate, 0);
  assert.equal(fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(response);
});

test("invalid threshold and non-integer budgets fail admission without execution", async () => {
  const api = await loadPublicApi();
  for (const request of [
    makeRequest({ satisfactionThreshold: 101 }),
    makeRequest({
      limits: {
        maxTransitions: 1.5,
        maxDepth: 2,
        maxDerivedGoals: 1,
      },
    }),
    makeRequest({
      limits: {
        maxTransitions: 1,
        maxDepth: -1,
        maxDerivedGoals: 1,
      },
    }),
  ]) {
    const fixture = createFixtureAdapter();
    const response = await api.runRecursiveGoal(request, depsFor(fixture));
    assert.equal(response.kind, "request_rejected");
    assert.equal(response.error.code, "invalid_request");
    assert.equal(response.acceptedRoot, null);
    assert.equal(fixture.calls.executeAtomic, 0);
    assertResponseReferencesClosed(response);
  }
});

test("initial observation is bound to its state and cannot accompany continuation", async () => {
  const api = await loadPublicApi();
  const requests = [
    makeRequest({
      state: { count: 1 },
      initialObservation: {
        stateId: "fixture-initial-state",
        evidence: [
          evidence(
            "mismatched-initial-evidence",
            "different-state",
            1,
          ),
        ],
      },
    }),
    makeRequest({
      state: { count: 1 },
      initialObservation: initialObservation(),
      continuation: {},
    }),
  ];

  for (const request of requests) {
    const fixture = createFixtureAdapter();
    const response = await api.runRecursiveGoal(request, depsFor(fixture));

    assert.equal(response.kind, "request_rejected");
    assert.equal(response.error.code, "invalid_request");
    assert.equal(response.acceptedRoot, null);
    assert.equal(fixture.calls.validateRequest, 0);
    assert.equal(fixture.calls.executeAtomic, 0);
    assertResponseReferencesClosed(response);
  }
});

test("real recursive workflow assets load and compile as a 3N2E candidate", async () => {
  const { loadWorkflow, compileWorkflow } = await loadWorkflowApi();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const configPath = fileURLToPath(
    new URL("../workflows/recursive-goal.workflow.json", import.meta.url),
  );
  const graph = JSON.parse(
    await readFile(
      new URL("../workflows/recursive-goal.graph.json", import.meta.url),
      "utf8",
    ),
  );
  const workflow = JSON.parse(
    await readFile(
      new URL("../workflows/recursive-goal.workflow.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(graph.id, "recursive-goal");
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.inputs.length, 1);
  assert.equal(graph.outputs.length, 1);
  assert.equal(graph.version, "0.2.0.0001");
  assert.deepEqual(
    graph.nodes.map((node) => node.operator),
    [
      "goal.recursive.bind",
      "goal.recursive.run",
      "goal.recursive.report",
    ],
  );
  assert.equal(
    graph.nodes.every((node) => node.operator_version === "0.2.0.0001"),
    true,
  );
  assert.equal(workflow.configVersion, 1);
  assert.equal(workflow.graphRef, "./recursive-goal.graph.json");
  assert.deepEqual(workflow.configs, {});
  assert.deepEqual(workflow.bindings, {});

  const loaded = await loadWorkflow({ configPath, allowedRoot: root });
  assert.deepEqual(loaded.graph, graph);
  const compiled = compileWorkflow(loaded, {
    nodeDefinitions: [
      workflowNode({
        operator: "goal.recursive.bind",
        input: "recursive_goal_request",
        inputSchema: "nnanything.recursive-goal.request.v1",
        inputType: "recursive-goal.request",
        output: "recursive_goal_context",
        outputSchema: "nnanything.recursive-goal.context.v1",
        outputType: "recursive-goal.context",
      }),
      workflowNode({
        operator: "goal.recursive.run",
        input: "recursive_goal_context",
        inputSchema: "nnanything.recursive-goal.context.v1",
        inputType: "recursive-goal.context",
        output: "recursive_goal_outcome",
        outputSchema: "nnanything.recursive-goal.outcome.v1",
        outputType: "recursive-goal.outcome",
      }),
      workflowNode({
        operator: "goal.recursive.report",
        input: "recursive_goal_outcome",
        inputSchema: "nnanything.recursive-goal.outcome.v1",
        inputType: "recursive-goal.outcome",
        output: "recursive_goal_result",
        outputSchema: "nnanything.recursive-goal.result.v1",
        outputType: "recursive-goal.result",
      }),
    ],
    grantedEffects: [],
  });
  assert.equal(compiled.nodeBindings.size, 3);
  assert.equal(compiled.entryArc.id, "recursive_goal_request");
  assert.equal(compiled.outputArc.id, "recursive_goal_result");
});

test("request rejection keeps a stable diagnostic and no false effect ledger", async () => {
  const api = await loadPublicApi();
  const fixture = createFixtureAdapter();
  const request = makeRequest({
    rootGoal: { kind: "counter", capability: "counter.increment", target: 1 },
    limits: {
      maxTransitions: -1,
      maxDepth: 0,
      maxDerivedGoals: 0,
    },
  });

  const response = await api.runRecursiveGoal(request, depsFor(fixture));

  assert.equal(response.kind, "request_rejected");
  assert.equal(response.error.code, "invalid_request");
  assert.equal(response.error.effectKnowledge, "none");
  assert.deepEqual(response.error.atomicResultRefs, []);
  assert.equal(
    response.error.cause === null ||
      response.error.cause.kind === "captured_error",
    true,
  );
  assertResponseReferencesClosed(response);
});

test("R1 omitted limits complete past the old default caps", async () => {
  const api = await loadPublicApi();
  const fixtureHarness = createFiniteBudgetHarness({
    rootTarget: 120,
    derivationCount: 120,
  });
  const response = await api.runRecursiveGoal(
    fixtureHarness.request,
    fixtureHarness.deps,
  );
  const report = responseReport(response);
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.ok(report.budgetUsed.transitionsUsed > 100);
  const nested = createFiniteBudgetHarness({
    nested: { depth: 6 },
  });
  const nestedResponse = await api.runRecursiveGoal(
    nested.request,
    nested.deps,
  );
  const nestedReport = responseReport(nestedResponse);
  assert.equal(nestedReport.control.outcome, "completed");
  assert.ok(
    nestedReport.frames.some((frame) => frame.depth >= 6),
    "omitting maxDepth allows the old default depth limit to be exceeded",
  );
  assertResponseReferencesClosed(response);
  assertResponseReferencesClosed(nestedResponse);
});

test("R3 explicit zero budgets are exact and never treated as unlimited", async () => {
  const api = await loadPublicApi();
  const zeroTransitions = createFiniteBudgetHarness({
    limits: { maxTransitions: 0, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const transitionResponse = await api.runRecursiveGoal(
    zeroTransitions.request,
    zeroTransitions.deps,
  );
  const transitionReport = responseReport(transitionResponse);
  assert.equal(transitionReport.control.outcome, "exceeded");
  assert.equal(transitionReport.control.stopReason, "budget");
  assert.equal(transitionReport.budgetUsed.transitionsUsed, 0);
  assert.equal(zeroTransitions.fixture.calls.executeAtomic, 0);

  const zeroDerived = createFiniteBudgetHarness({
    limits: { maxTransitions: 32, maxDepth: 8, maxDerivedGoals: 0 },
    rootTarget: 1,
    derivationCount: 3,
  });
  const derivedResponse = await api.runRecursiveGoal(
    zeroDerived.request,
    zeroDerived.deps,
  );
  const derivedReport = responseReport(derivedResponse);
  assert.equal(derivedReport.control.outcome, "exceeded");
  assert.equal(derivedReport.control.stopReason, "budget");
  assert.equal(derivedReport.control.budget.dimension, "maxDerivedGoals");
  assert.equal(derivedReport.control.budget.limit, 0);
  assert.equal(derivedReport.control.budget.used, 0);
  assert.equal(derivedReport.control.budget.attempted, 1);
  assert.equal(
    errorsByCode(derivedReport, "budget_exceeded").length > 0,
    true,
  );
  assert.equal(derivedReport.budgetUsed.derivedGoalsUsed, 0);
  assert.equal(zeroDerived.fixture.calls.executeAtomic, 0);

  const zeroDepth = createFiniteBudgetHarness({
    limits: { maxTransitions: 32, maxDepth: 0, maxDerivedGoals: 16 },
    derivationCount: 3,
  });
  const depthResponse = await api.runRecursiveGoal(
    zeroDepth.request,
    zeroDepth.deps,
  );
  const depthReport = responseReport(depthResponse);
  assert.equal(depthReport.control.outcome, "exceeded");
  assert.equal(depthReport.control.stopReason, "budget");
  assert.deepEqual(depthReport.control.budget, {
    dimension: "maxDepth",
    limit: 0,
    used: 0,
    attempted: 1,
  });
  assert.equal(
    errorsByCode(depthReport, "budget_exceeded").length > 0,
    true,
  );
  assert.equal(Math.max(...depthReport.frames.map((frame) => frame.depth)), 0);
  assert.equal(zeroDepth.fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(depthResponse);
});

test("R3 depth exhaustion reports the accepted depth and attempted child depth", async () => {
  const api = await loadPublicApi();
  const nested = createFiniteBudgetHarness({
    nested: {
      depth: 2,
      limits: { maxTransitions: 32, maxDepth: 1, maxDerivedGoals: 16 },
    },
  });
  const response = await api.runRecursiveGoal(nested.request, nested.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.deepEqual(report.control.budget, {
    dimension: "maxDepth",
    limit: 1,
    used: 1,
    attempted: 2,
  });
  assert.equal(
    errorsByCode(report, "budget_exceeded").length > 0,
    true,
  );
  assert.equal(Math.max(...report.frames.map((frame) => frame.depth)), 1);
  assertResponseReferencesClosed(response);
});

test("R3 simultaneous maxDerivedGoals and maxDepth exhaustion reports both dimensions", async () => {
  const api = await loadPublicApi();
  const nested = createFiniteBudgetHarness({
    nested: {
      depth: 2,
      limits: { maxTransitions: 32, maxDepth: 1, maxDerivedGoals: 1 },
    },
  });
  const response = await api.runRecursiveGoal(nested.request, nested.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.deepEqual(report.control.budget, {
    dimension: ["maxDerivedGoals", "maxDepth"],
    limit: [1, 1],
    used: [1, 1],
    attempted: [1, 2],
  });
  assert.equal(errorsByCode(report, "budget_exceeded").length > 0, true);
  assertResponseReferencesClosed(response);
});

test("R4 partial omission does not restore the hidden defaults", async () => {
  const api = await loadPublicApi();
  const partial = createFiniteBudgetHarness({
    rootTarget: 120,
    derivationCount: 120,
    limits: { maxDepth: 8 },
  });
  const response = await api.runRecursiveGoal(partial.request, partial.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.ok(report.budgetUsed.transitionsUsed > 100);

  const adapter = createFixtureAdapter({
    validateRequest: (request) => {
      const limits = request.limits ?? {};
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: {
          ...limits,
          maxTransitions:
            limits.maxTransitions === undefined ? 1 : limits.maxTransitions + 1,
        },
        continuation: request.continuation ?? null,
      };
    },
  });
  const tampered = await api.runRecursiveGoal(
    makeRequest({
      limits: { maxTransitions: 1, maxDepth: 8, maxDerivedGoals: 16 },
    }),
    depsFor(adapter, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  assert.equal(tampered.kind, "request_rejected");
  assert.equal(tampered.error.code, "invalid_binding");
  assertResponseReferencesClosed(tampered);

  const adapterDropped = createFixtureAdapter({
    validateRequest: (request) => {
      const limits = { ...request.limits };
      delete limits.maxTransitions;
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits,
        continuation: request.continuation ?? null,
      };
    },
  });
  const dropped = await api.runRecursiveGoal(
    makeRequest({
      limits: { maxTransitions: 1, maxDepth: 8, maxDerivedGoals: 16 },
    }),
    depsFor(adapterDropped, {
      enabledSkills: [skill("increment-counter", "atomic")],
      selectors: [selector("root-selector", ["increment-counter"])],
    }),
  );
  assert.equal(dropped.kind, "request_rejected");
  assert.equal(dropped.error.code, "invalid_binding");
  assertResponseReferencesClosed(dropped);
});

test("R4 adapter-returned malformed limits shapes are rejected before execution", async () => {
  const api = await loadPublicApi();
  const request = makeRequest({ limits: undefined });
  const malformedValues = [null, 3, [], { extraKey: 1 }];
  for (const malformed of malformedValues) {
    const adapter = createFixtureAdapter({
      validateRequest: (value) => ({
        requestId: value.requestId,
        rootGoal: value.rootGoal,
        satisfactionThreshold: value.satisfactionThreshold,
        rootBindings: value.rootBindings,
        state: value.state,
        rootEvaluatorId: value.rootEvaluatorId,
        rootSelectorId: value.rootSelectorId,
        limits: malformed,
        continuation: value.continuation ?? null,
      }),
    });
    const response = await api.runRecursiveGoal(
      request,
      depsFor(adapter, {
        enabledSkills: [skill("increment-counter", "atomic")],
        selectors: [selector("root-selector", ["increment-counter"])],
      }),
    );
    assert.equal(response.kind, "request_rejected", JSON.stringify(malformed));
    assert.equal(response.error.code, "invalid_binding", JSON.stringify(malformed));
    assert.equal(adapter.calls.executeAtomic, 0, JSON.stringify(malformed));
    assertResponseReferencesClosed(response);
  }
});

test("R10 omitted limits never inject a hidden 13-dispatch atomic ceiling", async () => {
  const api = await loadPublicApi();
  const harness = createFiniteBudgetHarness({
    rootTarget: 20,
    derivationCount: 20,
  });
  const response = await api.runRecursiveGoal(harness.request, harness.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(harness.fixture.calls.executeAtomic, 20);
  assert.equal(
    report.atomicResults.length,
    20,
    "no hidden atomic attempt ceiling may truncate omitted budgets",
  );
  assertResponseReferencesClosed(response);
});

test("R2 finite transition budget reports the exhausted dimension without dispatching past it", async () => {
  const api = await loadPublicApi();
  const harness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 6, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const response = await api.runRecursiveGoal(harness.request, harness.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "exceeded");
  assert.equal(report.control.stopReason, "budget");
  assert.deepEqual(report.control.budget, {
    dimension: "maxTransitions",
    limit: 6,
    used: 6,
    attempted: 7,
  });
  assert.equal(report.budgetUsed.transitionsUsed, 6);
  assert.equal(harness.fixture.calls.executeAtomic, 1);
  assert.equal(report.atomicResults.length, 1);
  assert.equal(errorsByCode(report, "budget_exceeded").length > 0, true);
  assertResponseReferencesClosed(response);
});

test("R5 continuation keeps cumulative usage while the new request owns budget declarations", async () => {
  const api = await loadPublicApi();
  const firstHarness = createFiniteBudgetHarness({
    rootTarget: 30,
    derivationCount: 30,
    limits: { maxTransitions: 9, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const first = await api.runRecursiveGoal(
    firstHarness.request,
    firstHarness.deps,
  );
  const firstReport = responseReport(first);
  assert.equal(firstReport.control.outcome, "exceeded");
  assert.equal(firstReport.budgetUsed.transitionsUsed, 9);
  assert.equal(firstHarness.fixture.calls.executeAtomic, 1);

  // Resumed runs must derive fresh condition ids; the first run already
  // registered its satisfied child in the restored frame.
  const resumeDerive = (input) =>
    singleChildDerivation({
      id: `resume-step-${input.conditions.length + 1}`,
      goal: counterGoal((input.state?.count ?? 0) + 1),
      bindings: input.bindings,
      mode: "atomic",
      selectorId: "finite-leaf-selector",
      cursor: "open",
      expansion: "more",
    });
  const resumeAtomic = (input, calls) =>
    successfulAtomicReceipt({
      count: (input.state?.count ?? 0) + 1,
      stateId: `resume-state-${calls.executeAtomic}`,
      evidenceId: `resume-evidence-${calls.executeAtomic}`,
      runId: `resume-run-${calls.executeAtomic}`,
    });
  const sameHarness = createFiniteBudgetHarness({
    rootTarget: 30,
    derivationCount: 30,
    derive: resumeDerive,
    executeAtomic: resumeAtomic,
  });
  const same = await api.runRecursiveGoal(
    {
      ...sameHarness.request,
      continuation: firstReport.continuation,
      limits: { maxTransitions: 9, maxDepth: 8, maxDerivedGoals: 16 },
    },
    sameHarness.deps,
  );
  const sameReport = responseReport(same);
  assert.equal(sameReport.control.outcome, "exceeded");
  assert.equal(sameReport.budgetUsed.transitionsUsed, 9);
  assert.equal(sameHarness.fixture.calls.executeAtomic, 0);

  const expandedHarness = createFiniteBudgetHarness({
    rootTarget: 30,
    derivationCount: 30,
    derive: resumeDerive,
    executeAtomic: resumeAtomic,
  });
  const expanded = await api.runRecursiveGoal(
    {
      ...expandedHarness.request,
      continuation: firstReport.continuation,
      limits: { maxTransitions: 300, maxDepth: 8, maxDerivedGoals: 64 },
    },
    expandedHarness.deps,
  );
  const expandedReport = responseReport(expanded);
  assert.equal(expandedReport.control.outcome, "completed");
  assert.equal(expandedReport.rootEvaluation.result, "satisfied");
  assert.ok(expandedReport.budgetUsed.transitionsUsed > 9);
  // The first run already dispatched the first atomic; the resume may only
  // dispatch the remaining 29 and must not replay the restored one.
  assert.equal(expandedHarness.fixture.calls.executeAtomic, 29);
  assert.equal(expandedReport.atomicResults.length, 30);
  assertResponseReferencesClosed(same);
  assertResponseReferencesClosed(expanded);
});

test("R7 changed ids cannot hide two completed composite cycles of the same non-progressing obligation", async () => {
  const api = await loadPublicApi();
  const harness = sameObligationNoProgressHarness({});
  const response = await api.runRecursiveGoal(harness.request, harness.deps);
  const report = responseReport(response);
  assert.equal(report.control.outcome, "stalled");
  assert.equal(report.control.stopReason, "no_progress");
  assert.equal(errorsByCode(report, "no_progress").length > 0, true);
  assert.equal(errorsByCode(report, "budget_exceeded").length, 0);
  // Baseline cycle plus the first proven non-progress cycle; the stop on the
  // second non-progress cycle must not issue another derive.
  assert.equal(harness.fixture.calls.derive, 2);
  assertResponseReferencesClosed(response);
});

test("R7b a composite no-progress baseline survives continuation", async () => {
  const api = await loadPublicApi();
  const never = () => ({ improved: false, reason: "none", comparable: true });
  const firstHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 16, maxDepth: 8, maxDerivedGoals: 16 },
    measureProgress: never,
  });
  const first = await api.runRecursiveGoal(
    firstHarness.request,
    firstHarness.deps,
  );
  const firstReport = responseReport(first);
  const rootFrameId = firstReport.continuation.acceptedRoot.rootFrameId;
  const firstRootControl = firstReport.continuation.frameControls.find(
    control => control.frameId === rootFrameId,
  );
  assert.ok(firstRootControl, "the root frame control must exist");
  assert.ok(
    firstRootControl.compositeCycleBaseline,
    "the completed cycle baseline must be serialized",
  );
  assert.equal(
    firstReport.frames.find(frame => frame.frameId === rootFrameId).noProgressCount,
    1,
  );

  const resumeHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 16 },
    measureProgress: never,
    derive: (input) =>
      singleChildDerivation({
        id: `resume-step-${input.conditions.length + 1}`,
        goal: counterGoal((input.state?.count ?? 0) + 1),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "open",
        expansion: "more",
      }),
    executeAtomic: (input, calls) =>
      successfulAtomicReceipt({
        count: (input.state?.count ?? 0) + 1,
        stateId: `resume-state-${calls.executeAtomic}`,
        evidenceId: `resume-evidence-${calls.executeAtomic}`,
        runId: `resume-run-${calls.executeAtomic}`,
      }),
  });
  const resumed = await api.runRecursiveGoal(
    {
      ...resumeHarness.request,
      continuation: firstReport.continuation,
      limits: { maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 16 },
    },
    resumeHarness.deps,
  );
  const resumedReport = responseReport(resumed);
  assert.equal(resumedReport.control.outcome, "stalled");
  assert.equal(resumedReport.control.stopReason, "no_progress");
  // The restored cycle is compared and stopped before a fresh transition
  // starts, so the first run's budget error may stay in the continued
  // error ledger. The new resume must not issue a new derive that would
  // consume another transition for the second non-progress cycle.
  assert.equal(resumeHarness.fixture.calls.derive, 0);
  assert.equal(resumeHarness.fixture.calls.executeAtomic, 0);
  assert.equal(
    resumedReport.frames.find(frame => frame.frameId === rootFrameId).noProgressCount,
    2,
  );
  assertResponseReferencesClosed(resumed);
});

test("R7c real progress across an interruption clears the restored no-progress count", async () => {
  const api = await loadPublicApi();
  const never = () => ({ improved: false, reason: "none", comparable: true });
  const firstHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 16, maxDepth: 8, maxDerivedGoals: 16 },
    measureProgress: never,
  });
  const first = await api.runRecursiveGoal(
    firstHarness.request,
    firstHarness.deps,
  );
  const firstReport = responseReport(first);
  const rootFrameId = firstReport.continuation.acceptedRoot.rootFrameId;
  let progressCalls = 0;
  const resumeHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 21, maxDepth: 8, maxDerivedGoals: 16 },
    measureProgress: () => {
      progressCalls += 1;
      return { improved: true, reason: "facts_improved", comparable: true };
    },
    derive: (input) =>
      singleChildDerivation({
        id: `resume-step-${input.conditions.length + 1}`,
        goal: counterGoal((input.state?.count ?? 0) + 1),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "open",
        expansion: "more",
      }),
    executeAtomic: (input, calls) =>
      successfulAtomicReceipt({
        count: (input.state?.count ?? 0) + 1,
        stateId: `resume-state-${calls.executeAtomic}`,
        evidenceId: `resume-evidence-${calls.executeAtomic}`,
        runId: `resume-run-${calls.executeAtomic}`,
      }),
  });
  const resumed = await api.runRecursiveGoal(
    {
      ...resumeHarness.request,
      continuation: firstReport.continuation,
      limits: { maxTransitions: 21, maxDepth: 8, maxDerivedGoals: 16 },
    },
    resumeHarness.deps,
  );
  const resumedReport = responseReport(resumed);
  assert.ok(progressCalls > 0, "the restored baseline must be compared");
  assert.equal(
    resumedReport.frames.find(frame => frame.frameId === rootFrameId).noProgressCount,
    0,
    "real progress after the interruption must clear the prior count",
  );
  assertResponseReferencesClosed(resumed);
});

test("R8 incomparable progress stays uncounted; a constant comparable obligation is detected", async () => {
  const api = await loadPublicApi();
  const unknownHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 12, maxDepth: 8, maxDerivedGoals: 16 },
    measureProgress: () => ({
      improved: false,
      reason: "none",
      comparable: false,
    }),
  });
  const unknownResponse = await api.runRecursiveGoal(
    unknownHarness.request,
    unknownHarness.deps,
  );
  const unknownReport = responseReport(unknownResponse);
  assert.equal(unknownReport.control.stopReason, "budget");
  assert.equal(unknownReport.budgetUsed.transitionsUsed, 12);
  assert.equal(
    unknownReport.errors.some(error => error.code === "no_progress"),
    false,
  );

  const sameHarness = sameObligationNoProgressHarness({});
  const sameResponse = await api.runRecursiveGoal(
    sameHarness.request,
    sameHarness.deps,
  );
  const sameReport = responseReport(sameResponse);
  assert.equal(sameReport.control.stopReason, "no_progress");
  assertResponseReferencesClosed(unknownResponse);
  assertResponseReferencesClosed(sameResponse);
});

test("R9 cancellation wins over zero budget and stops an omitted-budget run after the in-flight receipt", async () => {
  const api = await loadPublicApi();

  const preController = new AbortController();
  preController.abort();
  const preHarness = createFiniteBudgetHarness({
    limits: { maxTransitions: 0, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const preResponse = await api.runRecursiveGoal(preHarness.request, {
    ...preHarness.deps,
    signal: preController.signal,
  });
  const preReport = responseReport(preResponse);
  assert.equal(preReport.control.outcome, "cancelled");
  assert.equal(preReport.control.stopReason, "cancel");
  assert.equal(preHarness.fixture.calls.executeAtomic, 0);

  const controller = new AbortController();
  const harness = createFiniteBudgetHarness({
    rootTarget: 10,
    derivationCount: 10,
    executeAtomic: (input, calls) => {
      controller.abort();
      const count = (input.state?.count ?? 0) + 1;
      return successfulAtomicReceipt({
        count,
        stateId: `abort-state-${calls.executeAtomic}`,
        evidenceId: `abort-evidence-${calls.executeAtomic}`,
        runId: `abort-run-${calls.executeAtomic}`,
      });
    },
  });
  const response = await api.runRecursiveGoal(harness.request, {
    ...harness.deps,
    signal: controller.signal,
  });
  const report = responseReport(response);
  assert.equal(report.control.outcome, "cancelled");
  assert.equal(report.control.stopReason, "cancel");
  assert.equal(harness.fixture.calls.executeAtomic, 1);
  assert.equal(report.atomicResults.length, 1);
  assertResponseReferencesClosed(preResponse);
  assertResponseReferencesClosed(response);
});

test("R7 a repeated condition id stays a duplicate_condition contract error", async () => {
  const api = await loadPublicApi();
  const harness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    derive: (input) =>
      singleChildDerivation({
        id: "fixed-obligation-id",
        goal: counterGoal((input.state?.count ?? 0) + 1),
        bindings: input.bindings,
        mode: "atomic",
        selectorId: "finite-leaf-selector",
        cursor: "open",
        expansion: "more",
      }),
  });
  const response = await api.runRecursiveGoal(harness.request, harness.deps);
  const report = responseReport(response);
  const duplicate = errorsByCode(report, "adapter_contract_invalid").find(
    error => error.source.category === "duplicate_condition",
  );
  assert.notEqual(duplicate, undefined);
  assert.equal(report.control.outcome, "error");
  assertResponseReferencesClosed(response);
});

test("legacy v1 continuation missing compositeCycleBaseline resumes without budget reset or replay", async () => {
  const api = await loadPublicApi();
  const firstHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 9, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const first = await api.runRecursiveGoal(firstHarness.request, firstHarness.deps);
  const firstReport = responseReport(first);
  assert.equal(firstReport.control.outcome, "exceeded");
  const legacy = legacyContinuationWithoutCompositeCycleBaseline(
    firstReport.continuation,
  );
  assert.equal(legacy.schema, "nnanything.recursive-goal.continuation.v1");
  assert.equal(
    legacy.frameControls.every(
      control => !Object.hasOwn(control, "compositeCycleBaseline"),
    ),
    true,
  );

  const resumeHarness = createFiniteBudgetHarness({
    rootTarget: 50,
    derivationCount: 50,
    limits: { maxTransitions: 0, maxDepth: 8, maxDerivedGoals: 16 },
  });
  const resumed = await api.runRecursiveGoal(
    {
      ...resumeHarness.request,
      continuation: legacy,
      limits: { maxTransitions: 0, maxDepth: 8, maxDerivedGoals: 16 },
    },
    resumeHarness.deps,
  );
  assert.equal(
    resumed.kind,
    "run_result",
    `legacy v1 continuation must resume; got ${resumed.kind}: ${resumed.error?.diagnosticMessage ?? ""}`,
  );
  const resumedReport = responseReport(resumed);
  const rootFrameId = resumedReport.continuation.acceptedRoot.rootFrameId;
  const rootControl = resumedReport.continuation.frameControls.find(
    control => control.frameId === rootFrameId,
  );
  assert.equal(rootControl.compositeCycleBaseline, null);
  assert.equal(
    resumedReport.budgetUsed.transitionsUsed,
    firstReport.budgetUsed.transitionsUsed,
    "cumulative transition budget must not reset",
  );
  assert.deepEqual(
    resumedReport.atomicResults.map(result => result.dispatchId),
    firstReport.atomicResults.map(result => result.dispatchId),
    "completed atomic actions must not replay",
  );
  assert.equal(resumeHarness.fixture.calls.executeAtomic, 0);
  assertResponseReferencesClosed(resumed);
});

test("legacy v2 planning continuation missing compositeCycleBaseline resumes without budget reset or replay", async () => {
  const api = await loadPublicApi();
  const resources = createBoundedFiniteResources({
    scenario: "branch-switch",
    actualBranch: "reject",
    expectedBranch: "reject",
  });
  const firstStep = await runBoundedFiniteStep(resources);
  const firstReport = responseReport(firstStep.response);
  assert.equal(firstReport.control.outcome, "yielded");
  const legacy = legacyContinuationWithoutCompositeCycleBaseline(
    firstReport.continuation,
  );
  assert.equal(legacy.schema, "nnanything.recursive-goal.continuation.v2");
  assert.equal(
    legacy.frameControls.every(
      control => !Object.hasOwn(control, "compositeCycleBaseline"),
    ),
    true,
  );

  const resumeResources = createBoundedFiniteResources({
    scenario: "branch-switch",
    actualBranch: "reject",
    expectedBranch: "reject",
  });
  const resumed = await api.runRecursiveGoal(
    {
      ...resumeResources.request,
      continuation: legacy,
      limits: { maxTransitions: 0, maxDepth: 6, maxDerivedGoals: 24 },
    },
    resumeResources.dependencies,
  );
  assert.equal(
    resumed.kind,
    "run_result",
    `legacy v2 continuation must resume; got ${resumed.kind}: ${resumed.error?.diagnosticMessage ?? ""}`,
  );
  const resumedReport = responseReport(resumed);
  const rootFrameId = resumedReport.continuation.acceptedRoot.rootFrameId;
  const rootControl = resumedReport.continuation.frameControls.find(
    control => control.frameId === rootFrameId,
  );
  assert.equal(rootControl.compositeCycleBaseline, null);
  assert.equal(
    resumedReport.budgetUsed.transitionsUsed,
    firstReport.budgetUsed.transitionsUsed,
    "cumulative transition budget must not reset",
  );
  assert.deepEqual(
    resumedReport.atomicResults.map(result => result.dispatchId),
    firstReport.atomicResults.map(result => result.dispatchId),
    "completed atomic actions must not replay",
  );
  assert.equal(resumeResources.memory.atomicExecutions.length, 0);
  assertResponseReferencesClosed(resumed);
});
