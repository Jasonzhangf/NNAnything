import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertResponseReferencesClosed,
  createFixtureAdapter,
  evidence,
  evaluator,
  initialObservation,
  makeRequest,
  selector,
  skill,
} from "./recursive-goal-fixtures.mjs";

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
