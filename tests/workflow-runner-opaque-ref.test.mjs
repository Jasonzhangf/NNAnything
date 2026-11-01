// Runner-layer regression for the flowed `RangeError: Invalid string length`
// crash. Large event payloads must never cross the flowed engine as task
// results. The runner carries only a small opaque ref through flowed and
// resolves the real ArcResult locally, so business events and failure
// semantics stay unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import flowed from "flowed";

import {
  JSON_EVENT_TYPE,
  compileWorkflow,
  createWorkflowInputEvent,
  runWorkflow,
} from "../dist/index.js";

const { FlowManager } = flowed;

function arc(id, schema = "Object") {
  return { id, schema };
}

function port(name, schemaId, eventType, validate = (value) => value) {
  return { name, schemaId, eventType, validate };
}

function graphNode(id, operator, inputs, output) {
  return {
    id,
    operator,
    operator_version: "1",
    inputs,
    output: arc(output),
    input_selector: { include: [], exclude: [] },
    output_selector: { include: [], exclude: [] },
    iterator: "Whole",
  };
}

function workflowGraph({ id = "test-graph", inputs, nodes, edges, outputs }) {
  return { id, version: "1", inputs, nodes, edges, outputs };
}

function edge(from, to, arcId) {
  return { from, to, arc_id: arcId };
}

function nodeDefinition(overrides) {
  return {
    operator: overrides.operator,
    version: "1",
    inputPorts: overrides.inputPorts,
    outputPort: overrides.outputPort,
    execute: overrides.execute,
    config: { required: true, validate: (value) => value },
    ...(overrides.effects === undefined ? {} : { effects: overrides.effects }),
  };
}

function jsonPort(name) {
  return port(name, "test/json/v1", JSON_EVENT_TYPE, (value) => value);
}

function hazardousPayload(marker) {
  const payload = {
    kind: "recursive-goal-report",
    requestId: "req-1",
    acceptedRoot: { root: true },
    report: { states: [{ step: 0, note: marker }, { step: 1, note: marker }] },
  };
  Object.defineProperty(payload, "toJSON", {
    value() {
      throw new RangeError("Invalid string length");
    },
    enumerable: false,
  });
  return payload;
}

test("large payloads stay out of flowed task results and resolve back to the same ArcResult", async () => {
  const marker = `payload-marker-${"x".repeat(128)}`;
  const inputPayload = hazardousPayload(marker);
  let receivedInputPayload;
  const outputPayload = hazardousPayload(marker);

  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [graphNode("sink", "test.sink", ["request"], "done")],
    edges: [],
    outputs: ["done"],
  });
  const definition = nodeDefinition({
    operator: "test.sink",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: ({ inputs, emit }) => {
      receivedInputPayload = inputs[0].payload;
      return emit(outputPayload);
    },
  });
  const compiled = compileWorkflow(
    { graph, bindings: { sink: { config: {} } } },
    { nodeDefinitions: [definition] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-opaque-ref",
    eventId: "run-opaque-ref:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: inputPayload,
  });

  const logEntries = [];
  const originalLog = FlowManager.log;
  // flowed reuses one logFields object per run, so snapshot each entry.
  FlowManager.log = (entry) => logEntries.push({ ...entry, extra: { ...entry.extra } });
  let result;
  try {
    result = await runWorkflow(compiled, input);
  } finally {
    FlowManager.log = originalLog;
  }

  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.payload, outputPayload);
  assert.equal(receivedInputPayload, inputPayload);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload, outputPayload);

  assert.ok(logEntries.length > 0, "flowed must emit log entries");
  assert.ok(logEntries.some((entry) => entry.eventType === "Flow.Started"), "flowed must log the entry parameters");
  assert.ok(logEntries.some((entry) => entry.message.includes("Finished task")), "flowed must log finished tasks");
  for (const entry of logEntries) {
    const serialized = entry.extra.values ?? "";
    assert.ok(serialized.length < 200, `log entry must carry a small ref, got ${serialized.length} chars`);
    assert.ok(!entry.message.includes(marker), "payload marker must not enter flowed messages");
    assert.ok(!serialized.includes(marker), "payload marker must not enter flowed task results");
    if (entry.eventType === "Task.Finished") {
      for (const carried of Object.values(JSON.parse(serialized))) {
        assert.deepEqual(Object.keys(carried).sort(), ["flowRef"], "task result must be an opaque ref");
      }
    }
  }
});

test("failure propagation through opaque refs keeps category, node and skipped-event semantics", async () => {
  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("broken", "test.broken", ["request"], "broken-out"),
      graphNode("after", "test.after", ["broken-out"], "done"),
    ],
    edges: [edge("broken", "after", "broken-out")],
    outputs: ["done"],
  });
  const broken = nodeDefinition({
    operator: "test.broken",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: () => {
      throw new Error("broken upstream");
    },
  });
  const after = nodeDefinition({
    operator: "test.after",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: ({ emit }) => emit({ observed: true }),
  });
  const compiled = compileWorkflow(
    { graph, bindings: { broken: { config: {} }, after: { config: {} } } },
    { nodeDefinitions: [broken, after] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-opaque-ref-failure",
    eventId: "run-opaque-ref-failure:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: { probe: 1 },
  });

  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "failed");
  assert.equal(result.error.category, "node_execution_failed");
  assert.equal(result.error.nodeId, "broken");
  assert.equal(result.error.message, "broken upstream");
  // A failed upstream short-circuits the dependent node without emitting a
  // business event; the failure itself is the run result.
  assert.equal(result.events.length, 0);
});

test("fan-out/fan-in keeps the original opaque object reference and isolates a failed branch", async () => {
  const marker = `fan-marker-${"y".repeat(128)}`;
  const inputPayload = hazardousPayload(marker);
  inputPayload.bulk = "z".repeat(1024 * 1024);

  let leftReceived;
  let rightReceived;
  let collectorRuns = 0;
  let collectorOrder;

  const left = nodeDefinition({
    operator: "test.fan.left",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: async ({ inputs, emit }) => {
      leftReceived = inputs[0].payload;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return emit(inputs[0].payload);
    },
  });
  const right = nodeDefinition({
    operator: "test.fan.right",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: ({ inputs, emit }) => {
      rightReceived = inputs[0].payload;
      return emit(inputs[0].payload);
    },
  });
  const collector = nodeDefinition({
    operator: "test.fan.collector",
    inputPorts: [jsonPort("left"), jsonPort("right")],
    outputPort: jsonPort("out"),
    execute: ({ inputs, emit }) => {
      collectorRuns += 1;
      collectorOrder = inputs.map((event) => event.payload);
      return emit({ values: collectorOrder });
    },
  });

  const graph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("left", "test.fan.left", ["request"], "leftOut"),
      graphNode("right", "test.fan.right", ["request"], "rightOut"),
      graphNode("collector", "test.fan.collector", ["leftOut", "rightOut"], "merged"),
    ],
    edges: [
      edge("left", "collector", "leftOut"),
      edge("right", "collector", "rightOut"),
    ],
    outputs: ["merged"],
  });
  const compiled = compileWorkflow(
    { graph, bindings: { left: { config: {} }, right: { config: {} }, collector: { config: {} } } },
    { nodeDefinitions: [left, right, collector] },
  );
  const input = createWorkflowInputEvent({
    runId: "run-fan-opaque",
    eventId: "run-fan-opaque:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: inputPayload,
  });

  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  // Both consumers resolve the same original object from the local ref map.
  assert.equal(leftReceived, inputPayload);
  assert.equal(rightReceived, inputPayload);
  // The collector runs once and sees the branches in declared port order.
  assert.equal(collectorRuns, 1);
  assert.equal(collectorOrder[0], inputPayload);
  assert.equal(collectorOrder[1], inputPayload);
  // The collected output keeps the original object references, not copies.
  assert.equal(result.outputEvent.payload.values[0], inputPayload);
  assert.equal(result.outputEvent.payload.values[1], inputPayload);

  let independentRuns = 0;
  let failedCollectorRuns = 0;
  const broken = nodeDefinition({
    operator: "test.fan.broken",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    execute: () => {
      throw new Error("broken fan branch");
    },
  });
  const independent = nodeDefinition({
    operator: "test.fan.independent",
    inputPorts: [jsonPort("in")],
    outputPort: jsonPort("out"),
    effects: ["test.side.effect"],
    execute: async ({ emit }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      independentRuns += 1;
      return emit({ ok: true });
    },
  });
  const failedCollector = nodeDefinition({
    operator: "test.fan.failed-collector",
    inputPorts: [jsonPort("broken"), jsonPort("independent")],
    outputPort: jsonPort("out"),
    effects: ["test.side.effect"],
    execute: ({ emit }) => {
      failedCollectorRuns += 1;
      return emit({ mustNotRun: true });
    },
  });

  const failureGraph = workflowGraph({
    inputs: [arc("request")],
    nodes: [
      graphNode("broken", "test.fan.broken", ["request"], "brokenOut"),
      graphNode("independent", "test.fan.independent", ["request"], "indepOut"),
      graphNode("failedCollector", "test.fan.failed-collector", ["brokenOut", "indepOut"], "merged"),
    ],
    edges: [
      edge("broken", "failedCollector", "brokenOut"),
      edge("independent", "failedCollector", "indepOut"),
    ],
    outputs: ["merged"],
  });
  const failedCompiled = compileWorkflow(
    {
      graph: failureGraph,
      bindings: {
        broken: { config: {} },
        independent: { config: {} },
        failedCollector: { config: {} },
      },
    },
    {
      nodeDefinitions: [broken, independent, failedCollector],
      grantedEffects: ["test.side.effect"],
    },
  );
  const failureInput = createWorkflowInputEvent({
    runId: "run-fan-opaque-failure",
    eventId: "run-fan-opaque-failure:input",
    port: "request",
    type: JSON_EVENT_TYPE,
    correlation: {},
    payload: inputPayload,
  });

  const failedResult = await runWorkflow(failedCompiled, failureInput);

  // The independent branch still executes under the existing effects contract.
  assert.equal(independentRuns, 1);
  // The collector depends on the failed result, so it never executes or runs effects.
  assert.equal(failedCollectorRuns, 0);
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.error.category, "node_execution_failed");
  assert.equal(failedResult.error.nodeId, "broken");
  assert.equal(failedResult.error.message, "broken fan branch");
  // The independent branch's real event is preserved; the collector emits nothing.
  assert.equal(failedResult.events.length, 1);
  assert.equal(failedResult.events[0].producer.nodeId, "independent");
  assert.deepEqual(failedResult.events[0].payload, { ok: true });
});
