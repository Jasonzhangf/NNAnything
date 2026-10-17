import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COLLECTION_EVENT_TYPE,
  JSON_EVENT_TYPE,
  NUMBERS_EVENT_TYPE,
  WorkflowContractError,
  commonNodeDefinitions,
  commonScaleNode,
  commonSumNode,
  compileWorkflow,
  createEventEnvelope,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Test helpers: build graphs and node definitions directly, without flattening
// the public contract. Each test exercises the public dist/index.js entry.
// ---------------------------------------------------------------------------

function arc(id, schema = "Object") {
  return { id, schema };
}

function port(name, schemaId, eventType, validate = (value) => value) {
  return { name, schemaId, eventType, validate };
}

function emptySelector() {
  return { include: [], exclude: [] };
}

function graphNode(id, operator, inputs, output, overrides = {}) {
  return {
    id,
    operator,
    operator_version: overrides.version ?? "1",
    inputs,
    output: typeof output === "string" ? arc(output) : output,
    input_selector: overrides.inputSelector ?? emptySelector(),
    output_selector: overrides.outputSelector ?? emptySelector(),
    iterator: overrides.iterator ?? "Whole",
  };
}

function workflowGraph({ id = "test-graph", inputs, nodes, edges, outputs }) {
  return { id, version: "1", inputs, nodes, edges, outputs };
}

function edge(from, to, arcId) {
  return { from, to, arc_id: arcId };
}

function nodeDefinition(overrides) {
  const definition = {
    operator: overrides.operator,
    version: overrides.version ?? "1",
    inputPorts: overrides.inputPorts,
    outputPort: overrides.outputPort,
    execute: overrides.execute,
  };
  if (overrides.config !== undefined) definition.config = overrides.config;
  if (overrides.effects !== undefined) definition.effects = overrides.effects;
  if (overrides.acceptNonOkInputs !== undefined) {
    definition.acceptNonOkInputs = overrides.acceptNonOkInputs;
  }
  if (overrides.profileValidator !== undefined) {
    definition.profileValidator = overrides.profileValidator;
  }
  return definition;
}

function jsonPort(name) {
  return port(name, "test/json/v1", JSON_EVENT_TYPE, (value) => value);
}

function expectContractError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof WorkflowContractError,
      `expected WorkflowContractError, got ${error}`,
    );
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Successful execution through common (non-DOM) nodes.
// ---------------------------------------------------------------------------

test("numbers workflow compiles and runs through common scale and sum nodes", async () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("scale", "common.scale", ["request"], "scaled"),
      graphNode("sum", "common.sum", ["scaled"], "total"),
    ],
    edges: [edge("scale", "sum", "scaled")],
    outputs: ["total"],
  });

  const compiled = compileWorkflow(
    { graph, bindings: { scale: { config: { factor: 3 } } } },
    { nodeDefinitions: commonNodeDefinitions },
  );

  const input = createWorkflowInputEvent({
    runId: "run-numbers",
    eventId: "run-numbers:input",
    port: "request",
    type: NUMBERS_EVENT_TYPE,
    correlation: {},
    payload: { values: [1, 2, 3] },
  });

  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  assert.deepEqual(result.outputEvent.payload, { total: 18 });
  assert.deepEqual(
    result.events.map((event) => event.producer.nodeId),
    ["scale", "sum"],
  );
  // Each ARC produces exactly one event in a single run.
  assert.deepEqual(
    result.events.map((event) => event.producer.port),
    ["out", "out"],
  );
});

test("a node requiring ok inputs receives a skipped event when upstream is not ok", async () => {
  let consumerRuns = 0;
  const gate = nodeDefinition({
    operator: "test.gate",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: (context) =>
      context.emit({ reason: "no_match" }, { status: "skipped" }),
  });
  const consumer = nodeDefinition({
    operator: "test.consumer",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: (context) => {
      consumerRuns += 1;
      return context.emit({ reached: true });
    },
  });
  const tail = nodeDefinition({
    operator: "test.tail",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    acceptNonOkInputs: true,
    execute: (context) =>
      context.emit({
        seen: context.inputs.map((event) => event.status),
        reason: context.inputs[0].payload.reason,
      }),
  });

  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("gate", "test.gate", ["request"], "gated"),
      graphNode("consumer", "test.consumer", ["gated"], "consumed"),
      graphNode("tail", "test.tail", ["consumed"], "tail"),
    ],
    edges: [
      edge("gate", "consumer", "gated"),
      edge("consumer", "tail", "consumed"),
    ],
    outputs: ["tail"],
  });

  const compiled = compileWorkflow(
    { graph, bindings: {} },
    { nodeDefinitions: [gate, consumer, tail] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-skip",
    eventId: "run-skip:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { anything: true },
  });
  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  assert.equal(consumerRuns, 0, "consumer with ok-only inputs must not execute");
  const consumerEvent = result.events.find(
    (event) => event.producer.nodeId === "consumer",
  );
  assert.equal(consumerEvent.status, "skipped");
  assert.equal(consumerEvent.payload.reason, "upstream_not_ok");
  assert.deepEqual(result.outputEvent.payload, {
    seen: ["skipped"],
    reason: "upstream_not_ok",
  });
});

test("fan-in waits for every input and the collector runs exactly once", async () => {
  let collectorRuns = 0;
  let observedOrder;
  const source = (operator, waitMs, value) =>
    nodeDefinition({
      operator,
      inputPorts: [jsonPort("in")],
      outputPort: jsonPort("out"),
      execute: async (context) => {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return context.emit({ value });
      },
    });
  const collector = nodeDefinition({
    operator: "test.collector",
    inputPorts: [jsonPort("a"), jsonPort("b")],
    outputPort: port("out", "test/collection/v1", COLLECTION_EVENT_TYPE, (v) => v),
    execute: (context) => {
      collectorRuns += 1;
      observedOrder = context.inputs.map((event) => event.payload.value);
      return context.emit({ values: observedOrder });
    },
  });

  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("slow", "test.slow", ["request"], "slowOut"),
      graphNode("fast", "test.fast", ["request"], "fastOut"),
      graphNode("collector", "test.collector", ["slowOut", "fastOut"], "merged"),
    ],
    edges: [
      edge("slow", "collector", "slowOut"),
      edge("fast", "collector", "fastOut"),
    ],
    outputs: ["merged"],
  });

  const compiled = compileWorkflow(
    { graph, bindings: {} },
    {
      nodeDefinitions: [
        source("test.slow", 30, "slow"),
        source("test.fast", 5, "fast"),
        collector,
      ],
    },
  );
  const input = createWorkflowInputEvent({
    runId: "run-fanin",
    eventId: "run-fanin:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { start: true },
  });
  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  assert.equal(collectorRuns, 1);
  // Input order follows the declared port order, not completion order.
  assert.deepEqual(observedOrder, ["slow", "fast"]);
  assert.deepEqual(result.outputEvent.payload, { values: ["slow", "fast"] });
});

// ---------------------------------------------------------------------------
// Compile-time rejections with concrete failure modes.
// ---------------------------------------------------------------------------

test("compile rejects a workflow with more than one entry", () => {
  const node = nodeDefinition({
    operator: "test.pass",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: (context) => context.emit(context.inputs[0].payload),
  });
  const graph = workflowGraph({
    inputs: [arc("request"), arc("other")],
    nodes: [graphNode("pass", "test.pass", ["request"], "passed")],
    edges: [],
    outputs: ["passed"],
  });
  expectContractError(
    () => compileWorkflow({ graph, bindings: {} }, { nodeDefinitions: [node] }),
    "COMPILE_INVALID_GRAPH",
  );
});

test("compile rejects a cyclic graph", () => {
  const pass = (operator) =>
    nodeDefinition({
      operator,
      inputPorts: [jsonPort("in"), jsonPort("extra")],
      outputPort: jsonPort("out"),
      execute: (context) => context.emit(context.inputs[0].payload),
    });
  const single = (operator) =>
    nodeDefinition({
      operator,
      inputPorts: [jsonPort("in")],
      outputPort: jsonPort("out"),
      execute: (context) => context.emit(context.inputs[0].payload),
    });
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("a", "test.a", ["request", "c"], "a"),
      graphNode("b", "test.b", ["a"], "b"),
      graphNode("c", "test.c", ["b"], "c"),
    ],
    edges: [edge("a", "b", "a"), edge("b", "c", "b"), edge("c", "a", "c")],
    outputs: ["c"],
  });
  expectContractError(
    () =>
      compileWorkflow(
        { graph, bindings: {} },
        { nodeDefinitions: [pass("test.a"), single("test.b"), single("test.c")] },
      ),
    "COMPILE_INVALID_GRAPH",
  );
});

test("compile rejects an unknown operator version binding", () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("a", "missing.op", ["request"], "a", { version: "9" })],
    edges: [],
    outputs: ["a"],
  });
  expectContractError(
    () => compileWorkflow({ graph, bindings: {} }, { nodeDefinitions: [] }),
    "COMPILE_UNKNOWN_OPERATOR",
  );
});

test("compile rejects incompatible port schema and event type contracts", () => {
  const producer = nodeDefinition({
    operator: "test.producer",
    inputPorts: [jsonPort("in")],
    outputPort: port("out", "test/x/v1", "test.x.v1", (v) => v),
    execute: (context) => context.emit(context.inputs[0].payload, { type: "test.x.v1" }),
  });
  const consumer = nodeDefinition({
    operator: "test.consumer",
    inputPorts: [port("in", "test/y/v1", "test.y.v1", (v) => v)],
    outputPort: jsonPort("out"),
    execute: (context) => context.emit(context.inputs[0].payload),
  });
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("producer", "test.producer", ["request"], "produced"),
      graphNode("consumer", "test.consumer", ["produced"], "consumed"),
    ],
    edges: [edge("producer", "consumer", "produced")],
    outputs: ["consumed"],
  });
  expectContractError(
    () =>
      compileWorkflow(
        { graph, bindings: {} },
        { nodeDefinitions: [producer, consumer] },
      ),
    "COMPILE_PORT_MISMATCH",
  );
});

test("compile rejects a missing required config binding", () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("scale", "common.scale", ["request"], "scaled")],
    edges: [],
    outputs: ["scaled"],
  });
  expectContractError(
    () =>
      compileWorkflow(
        { graph, bindings: {} },
        { nodeDefinitions: [commonScaleNode] },
      ),
    "COMPILE_BINDING",
  );
});

test("compile rejects duplicate ARC producers", () => {
  const node = (operator) =>
    nodeDefinition({
      operator,
      inputPorts: [jsonPort("in")],
      outputPort: jsonPort("out"),
      execute: (context) => context.emit(context.inputs[0].payload),
    });
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("a", "test.a", ["request"], "dup"),
      graphNode("b", "test.b", ["request"], "dup"),
    ],
    edges: [],
    outputs: ["dup"],
  });
  expectContractError(
    () =>
      compileWorkflow(
        { graph, bindings: {} },
        { nodeDefinitions: [node("test.a"), node("test.b")] },
      ),
    "COMPILE_DUPLICATE_ARC",
  );
});

test("compile rejects unsupported iterator and selectors instead of dropping data", () => {
  const node = nodeDefinition({
    operator: "test.pass",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: (context) => context.emit(context.inputs[0].payload),
  });
  const iteratorGraph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("a", "test.pass", ["request"], "a", { iterator: "Items" })],
    edges: [],
    outputs: ["a"],
  });
  expectContractError(
    () =>
      compileWorkflow({ graph: iteratorGraph, bindings: {} }, { nodeDefinitions: [node] }),
    "COMPILE_UNSUPPORTED_ITERATOR",
  );

  const selectorGraph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("a", "test.pass", ["request"], "a", {
        inputSelector: { include: ["x"], exclude: [] },
      }),
    ],
    edges: [],
    outputs: ["a"],
  });
  expectContractError(
    () =>
      compileWorkflow({ graph: selectorGraph, bindings: {} }, { nodeDefinitions: [node] }),
    "COMPILE_UNSUPPORTED_SELECTOR",
  );
});

// ---------------------------------------------------------------------------
// Authorization: an unauthorized effect must keep the node at zero executions.
// ---------------------------------------------------------------------------

test("unauthorized effects are rejected at compile and never execute", async () => {
  let runs = 0;
  const writer = nodeDefinition({
    operator: "test.writer",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    effects: ["test.side.effect"],
    execute: (context) => {
      runs += 1;
      return context.emit(context.inputs[0].payload);
    },
  });
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("writer", "test.writer", ["request"], "written")],
    edges: [],
    outputs: ["written"],
  });

  expectContractError(
    () =>
      compileWorkflow({ graph, bindings: {} }, { nodeDefinitions: [writer] }),
    "COMPILE_EFFECT_UNAUTHORIZED",
  );
  assert.equal(runs, 0, "unauthorized effect node must not run");

  // A binding cannot self-grant an effect.
  expectContractError(
    () =>
      compileWorkflow(
        {
          graph,
          bindings: { writer: { config: {}, effects: ["test.side.effect"] } },
        },
        { nodeDefinitions: [writer] },
      ),
    "COMPILE_BINDING",
  );
  assert.equal(runs, 0, "config cannot grant effects");

  const granted = compileWorkflow(
    { graph, bindings: {} },
    { nodeDefinitions: [writer], grantedEffects: ["test.side.effect"] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-effect",
    eventId: "run-effect:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { ok: true },
  });
  const result = await runWorkflow(granted, input);
  assert.equal(result.status, "completed");
  assert.equal(runs, 1);
});

// ---------------------------------------------------------------------------
// Run-time event contract enforcement.
// ---------------------------------------------------------------------------

test("run rejects an entry event with the wrong producer or type", async () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("sum", "common.sum", ["request"], "total")],
    edges: [],
    outputs: ["total"],
  });
  const compiled = compileWorkflow(
    { graph, bindings: {} },
    { nodeDefinitions: [commonSumNode] },
  );
  const wrongType = createWorkflowInputEvent({
    runId: "run-input",
    eventId: "run-input:input",
    port: "request",
    type: "wrong.event.type",
    correlation: {},
    payload: { values: [1] },
  });
  const result = await runWorkflow(compiled, wrongType);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "invalid_input_event");
});

test("run rejects a node event that leaks into another run id", async () => {
  const leaky = nodeDefinition({
    operator: "test.leaky",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: (context) =>
      createEventEnvelope({
        runId: "some-other-run",
        eventId: "leak",
        producer: { nodeId: context.nodeId, port: "out" },
        type: JSON_EVENT_TYPE,
        payload: { ok: true },
      }),
  });
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("leaky", "test.leaky", ["request"], "leaked")],
    edges: [],
    outputs: ["leaked"],
  });
  const compiled = compileWorkflow(
    { graph, bindings: {} },
    { nodeDefinitions: [leaky] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-leak",
    eventId: "run-leak:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { ok: true },
  });
  const result = await runWorkflow(compiled, input);
  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "invalid_node_event");
  assert.equal(result.error.nodeId, "leaky");
  assert.deepEqual(result.events, []);
});

test("run produces a fresh, isolated trace for each entry event", async () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("scale", "common.scale", ["request"], "scaled"),
      graphNode("sum", "common.sum", ["scaled"], "total"),
    ],
    edges: [edge("scale", "sum", "scaled")],
    outputs: ["total"],
  });
  const compiled = compileWorkflow(
    { graph, bindings: { scale: { config: { factor: 2 } } } },
    { nodeDefinitions: commonNodeDefinitions },
  );
  const first = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId: "run-a",
      eventId: "run-a:input",
      port: "request",
      type: NUMBERS_EVENT_TYPE,
      correlation: {},
      payload: { values: [1, 2] },
    }),
  );
  const second = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId: "run-b",
      eventId: "run-b:input",
      port: "request",
      type: NUMBERS_EVENT_TYPE,
      correlation: {},
      payload: { values: [10] },
    }),
  );

  assert.equal(first.outputEvent.payload.total, 6);
  assert.equal(second.outputEvent.payload.total, 20);
  assert.ok(first.events.every((event) => event.runId === "run-a"));
  assert.ok(second.events.every((event) => event.runId === "run-b"));
});

// ---------------------------------------------------------------------------
// Config loading: one topology source, resolved local references only.
// ---------------------------------------------------------------------------

function writeLoadedFixture(root, configText, graph = null) {
  const graphPath = join(root, "graph.graph.json");
  if (graph !== null) writeFileSync(graphPath, JSON.stringify(graph));
  const configPath = join(root, "workflow.json");
  writeFileSync(configPath, configText);
  return { graphPath, configPath };
}

const loadedGraph = workflowGraph({
  inputs: [arc("request")],
  nodes: [graphNode("scale", "common.scale", ["request"], "scaled")],
  edges: [],
  outputs: ["scaled"],
});

test("loadWorkflow resolves a local config and graph into one definition", async () => {
  const root = mkdtempSync(join(tmpdir(), "nnanything-load-"));
  const { configPath } = writeLoadedFixture(
    root,
    JSON.stringify({
      configVersion: 1,
      graphRef: "graph.graph.json",
      configs: { factor: { factor: 5 } },
      bindings: { scale: { configRef: "factor" } },
    }),
    loadedGraph,
  );
  const definition = await loadWorkflow({ configPath, allowedRoot: root });
  assert.equal(definition.graph.id, "test-graph");
  assert.deepEqual(definition.bindings.scale, { config: { factor: 5 } });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: [commonScaleNode],
  });
  const result = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId: "run-load",
      eventId: "run-load:input",
      port: "request",
      type: NUMBERS_EVENT_TYPE,
      correlation: {},
      payload: { values: [2] },
    }),
  );
  assert.equal(result.outputEvent.payload.values[0], 10);
});

test("loadWorkflow rejects unknown versions, remote or script graphs, and bad references", async () => {
  const root = mkdtempSync(join(tmpdir(), "nnanything-load-bad-"));

  async function attempt(config, graph = loadedGraph) {
    const { configPath } = writeLoadedFixture(root, JSON.stringify(config), graph);
    return loadWorkflow({ configPath, allowedRoot: root });
  }

  await assert.rejects(
    attempt({ configVersion: 2, graphRef: "graph.graph.json", configs: {}, bindings: {} }),
    (error) => error.code === "LOAD_UNKNOWN_VERSION",
  );
  await assert.rejects(
    attempt({
      configVersion: 1,
      graphRef: "https://example.com/graph.json",
      configs: {},
      bindings: {},
    }),
    (error) => error.code === "LOAD_REMOTE_OR_SCRIPT_GRAPH",
  );
  await assert.rejects(
    attempt({
      configVersion: 1,
      graphRef: "graph.js",
      configs: {},
      bindings: {},
    }),
    (error) => error.code === "LOAD_REMOTE_OR_SCRIPT_GRAPH",
  );
  await assert.rejects(
    attempt({
      configVersion: 1,
      graphRef: "../outside.graph.json",
      configs: {},
      bindings: {},
    }),
    (error) => error.code === "LOAD_PATH_OUTSIDE_ROOT",
  );
  await assert.rejects(
    attempt({
      configVersion: 1,
      graphRef: "graph.graph.json",
      configs: {},
      bindings: { scale: { configRef: "missing" } },
    }),
    (error) => error.code === "LOAD_BAD_REFERENCE",
  );
  await assert.rejects(
    attempt({
      configVersion: 1,
      graphRef: "graph.graph.json",
      configs: {},
      bindings: { unknownNode: { config: {} } },
    }),
    (error) => error.code === "LOAD_BAD_REFERENCE",
  );
});

test("loadWorkflow refuses config self-granting and paths outside the allowed root", async () => {
  const root = mkdtempSync(join(tmpdir(), "nnanything-load-grant-"));
  const { configPath } = writeLoadedFixture(
    root,
    JSON.stringify({
      configVersion: 1,
      graphRef: "graph.graph.json",
      configs: {},
      bindings: { scale: { config: { factor: 2 }, effects: ["test.side.effect"] } },
    }),
    loadedGraph,
  );
  await assert.rejects(
    loadWorkflow({ configPath, allowedRoot: root }),
    (error) => error.code === "LOAD_INVALID_CONFIG",
  );

  const outsideRoot = mkdtempSync(join(tmpdir(), "nnanything-outside-"));
  const { configPath: outsideConfig } = writeLoadedFixture(
    outsideRoot,
    JSON.stringify({
      configVersion: 1,
      graphRef: "graph.graph.json",
      configs: {},
      bindings: {},
    }),
    loadedGraph,
  );
  await assert.rejects(
    loadWorkflow({ configPath: outsideConfig, allowedRoot: root }),
    (error) => error.code === "LOAD_PATH_OUTSIDE_ROOT",
  );
});
