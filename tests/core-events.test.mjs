import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JSON_EVENT_TYPE,
  WORKFLOW_INPUT_NODE_ID,
  commonCountNode,
  createEventEnvelope,
  createWorkflowInputEvent,
  runWorkflow,
} from "../dist/index.js";

function nodeDefinition(overrides) {
  return {
    operator: overrides.operator,
    version: "1",
    inputPorts: overrides.inputPorts,
    outputPort: overrides.outputPort,
    execute: overrides.execute,
  };
}

function port(name, schemaId, eventType, validate = (value) => value) {
  return { name, schemaId, eventType, validate };
}

test("createWorkflowInputEvent marks the workflow input as producer", () => {
  const event = createWorkflowInputEvent({
    runId: "run-1",
    eventId: "run-1:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: { itemKey: "item-1" },
    payload: { values: [] },
  });

  assert.equal(event.producer.nodeId, WORKFLOW_INPUT_NODE_ID);
  assert.equal(event.producer.port, "request");
  assert.equal(event.type, JSON_EVENT_TYPE);
  assert.equal(event.status, "ok");
  assert.deepEqual(event.correlation, { itemKey: "item-1" });
});

test("each ARC yields exactly one event per run with one input event only", async () => {
  // Single input graph node fanning to two consumers of one collector.
  const pass = (operator) =>
    nodeDefinition({
      operator,
      inputPorts: [port("in", "test/json/v1", JSON_EVENT_TYPE)],
      outputPort: port("out", "test/json/v1", JSON_EVENT_TYPE),
      execute: (context) => context.emit(context.inputs[0].payload),
    });
  const collector = nodeDefinition({
    operator: "test.merge",
    inputPorts: [
      port("left", "test/json/v1", JSON_EVENT_TYPE),
      port("right", "test/json/v1", JSON_EVENT_TYPE),
    ],
    outputPort: port("out", "test/json/v1", JSON_EVENT_TYPE),
    acceptNonOkInputs: true,
    execute: (context) =>
      context.emit({
        statuses: context.inputs.map((event) => event.status),
      }),
  });

  const graph = {
    id: "one-per-arc",
    version: "1",
    inputs: [{ id: "request", schema: "Object" }],
    nodes: [
      {
        id: "a",
        operator: "test.a",
        operator_version: "1",
        inputs: ["request"],
        output: { id: "shared", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
      {
        id: "left",
        operator: "test.left",
        operator_version: "1",
        inputs: ["shared"],
        output: { id: "leftOut", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
      {
        id: "right",
        operator: "test.right",
        operator_version: "1",
        inputs: ["shared"],
        output: { id: "rightOut", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
      {
        id: "merge",
        operator: "test.merge",
        operator_version: "1",
        inputs: ["leftOut", "rightOut"],
        output: { id: "merged", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
    ],
    edges: [
      { from: "a", to: "left", arc_id: "shared" },
      { from: "a", to: "right", arc_id: "shared" },
      { from: "left", to: "merge", arc_id: "leftOut" },
      { from: "right", to: "merge", arc_id: "rightOut" },
    ],
    outputs: ["merged"],
  };

  // Import compileWorkflow lazily so a missing export names the right function.
  const { compileWorkflow } = await import("../dist/index.js");
  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: [pass("test.a"), pass("test.left"), pass("test.right"), collector],
  });

  const input = createWorkflowInputEvent({
    runId: "run-arcs",
    eventId: "run-arcs:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: { itemKey: "shared-item", index: 0 },
    payload: { shared: true },
  });
  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  // Four nodes ran, so four events, one per ARC, no duplicates.
  assert.equal(result.events.length, 4);
  assert.equal(new Set(result.events.map((event) => event.eventId)).size, 4);
  assert.ok(result.events.every((event) => event.runId === "run-arcs"));
  assert.deepEqual(result.outputEvent.payload, {
    statuses: ["ok", "ok"],
  });
});

test("emit inherits run metadata and correlation from the first input", async () => {
  const echo = nodeDefinition({
    operator: "test.echo",
    inputPorts: [port("in", "test/json/v1", JSON_EVENT_TYPE)],
    outputPort: port("out", "test/json/v1", JSON_EVENT_TYPE),
    execute: (context) => context.emit(context.inputs[0].payload),
  });
  const graph = {
    id: "emit-graph",
    version: "1",
    inputs: [{ id: "request", schema: "Object" }],
    nodes: [
      {
        id: "echo",
        operator: "test.echo",
        operator_version: "1",
        inputs: ["request"],
        output: { id: "echoed", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
    ],
    edges: [],
    outputs: ["echoed"],
  };

  const { compileWorkflow } = await import("../dist/index.js");
  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: [echo],
  });
  const input = createWorkflowInputEvent({
    runId: "run-emit",
    eventId: "run-emit:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: { itemKey: "item-x", index: 2 },
    payload: { value: 7 },
  });
  const result = await runWorkflow(compiled, input);

  const emitted = result.outputEvent;
  assert.equal(emitted.runId, "run-emit");
  assert.equal(emitted.producer.nodeId, "echo");
  assert.equal(emitted.producer.port, "out");
  assert.equal(emitted.type, JSON_EVENT_TYPE);
  assert.equal(emitted.status, "ok");
  assert.deepEqual(emitted.correlation, { itemKey: "item-x", index: 2 });
  assert.deepEqual(emitted.payload, { value: 7 });
});

test("common count node aggregates and reports an unshaped payload as unknown", async () => {
  const graph = {
    id: "count-graph",
  version: "1",
    inputs: [{ id: "request", schema: "Object" }],
    nodes: [
      {
        id: "count",
        operator: "common.count",
        operator_version: "1",
        inputs: ["request"],
        output: { id: "counted", schema: "Object" },
        input_selector: { include: [], exclude: [] },
        output_selector: { include: [], exclude: [] },
        iterator: "Whole",
      },
    ],
    edges: [],
    outputs: ["counted"],
  };
  const { compileWorkflow } = await import("../dist/index.js");

  const compiledGood = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: [commonCountNode],
  });
  const good = await runWorkflow(
    compiledGood,
    createWorkflowInputEvent({
      runId: "count-ok",
      eventId: "count-ok:input",
      port: "request",
      type: JSON_EVENT_TYPE,
      correlation: {},
      payload: { items: [1, 2, 3, 4] },
    }),
  );
  assert.equal(good.status, "completed");
  assert.equal(good.outputEvent.status, "ok");
  assert.equal(good.outputEvent.payload.count, 4);

  const bad = await runWorkflow(
    compiledGood,
    createWorkflowInputEvent({
      runId: "count-bad",
      eventId: "count-bad:input",
      port: "request",
      type: JSON_EVENT_TYPE,
      correlation: {},
      payload: { items: "not-an-array" },
    }),
  );
  assert.equal(bad.status, "completed");
  assert.equal(bad.outputEvent.status, "unknown");
  assert.equal(bad.outputEvent.payload.reason, "invalid_payload");
});

test("createEventEnvelope copies producer and correlation without sharing", () => {
  const envelope = createEventEnvelope({
    runId: "run-2",
    eventId: "evt-2",
    producer: { nodeId: "n", port: "p" },
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { a: 1 },
  });
  envelope.producer.nodeId = "mutated";
  envelope.correlation.itemKey = "touched";

  const second = createEventEnvelope({
    runId: "run-2",
    eventId: "evt-3",
    producer: { nodeId: "n", port: "p" },
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: {},
  });
  assert.equal(second.producer.nodeId, "n");
  assert.deepEqual(second.correlation, {});
});
