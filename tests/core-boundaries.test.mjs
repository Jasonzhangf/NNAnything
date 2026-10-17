import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileWorkflow, createWorkflowInputEvent, loadWorkflow, runWorkflow } from "nnanything";

const selector = { include: [], exclude: [] };
const port = { name: "out", schemaId: "boundary/value/v1", eventType: "boundary.value.v1", validate(value) {
  assert.equal(typeof value.value, "number"); return value;
} };
const node = (id, inputs, output = id) => ({ id, operator: id, operator_version: "1", inputs,
  output: { id: output, schema: "Object" }, iterator: "Whole", input_selector: selector, output_selector: selector });
const graph = (nodes = [node("a", ["request"])], edges = [], outputs = ["a"]) => ({ id: "boundaries", version: "1", inputs: [{ id: "request", schema: "Object" }], nodes, edges, outputs });
const operator = (id, execute, extra = {}) => ({ operator: id, version: "1", inputPorts: [port], outputPort: port, execute, ...extra });
const input = (runId = "boundary-run") => createWorkflowInputEvent({ runId, eventId: "input", port: "request", type: port.eventType, correlation: { itemKey: "item" }, payload: { value: 1 } });

test("output event rejects forged producer, type, itemKey, status, id and payload", async () => {
  const corruptions = [
    event => ({ ...event, producer: { ...event.producer, nodeId: "other" } }),
    event => ({ ...event, producer: { ...event.producer, port: "other" } }),
    event => ({ ...event, type: "other" }),
    event => ({ ...event, correlation: { itemKey: "other" } }),
    event => ({ ...event, status: "success" }),
    event => ({ ...event, eventId: "input" }),
    event => ({ ...event, payload: { value: "invalid" } }),
    event => ({ ...event, status: "unknown", payload: {} }),
  ];
  for (const corrupt of corruptions) {
    const compiled = compileWorkflow({ graph: graph(), bindings: {} }, {
      nodeDefinitions: [operator("a", ctx => corrupt(ctx.emit({ value: 2 })))],
    });
    const result = await runWorkflow(compiled, input());
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "invalid_node_event");
    assert.equal(result.error.nodeId, "a");
    assert.deepEqual(result.events, []);
  }
});

test("invalid entry producer and payload reject before effects", async () => {
  let executions = 0;
  const compiled = compileWorkflow({ graph: graph(), bindings: {} }, {
    nodeDefinitions: [operator("a", ctx => { executions++; return ctx.emit({ value: 2 }); }, { effects: ["boundary.write"] })],
    grantedEffects: ["boundary.write"],
  });
  for (const event of [{ ...input(), producer: { nodeId: "other", port: "request" } }, { ...input(), payload: { value: "bad" } }]) {
    const result = await runWorkflow(compiled, event);
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "invalid_input_event");
  }
  assert.equal(executions, 0);
});

test("effect exceptions preserve cause, do not retry, and block downstream execution", async () => {
  let attempts = 0;
  let downstream = 0;
  const compiled = compileWorkflow({ graph: graph([node("a", ["request"]), node("b", ["a"])], [{ from: "a", to: "b", arc_id: "a" }], ["b"]), bindings: {} }, {
    nodeDefinitions: [
      operator("a", async () => { attempts++; throw new Error("write outcome unknown"); }, { effects: ["boundary.write"] }),
      operator("b", ctx => { downstream++; return ctx.emit({ value: 2 }); }),
    ], grantedEffects: ["boundary.write"],
  });
  const result = await runWorkflow(compiled, input());
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, { category: "node_execution_failed", nodeId: "a", message: "write outcome unknown" });
  assert.equal(attempts, 1);
  assert.equal(downstream, 0);
  assert.deepEqual(result.events, []);
});

test("edges and dead branches are checked independently of operator bindings", () => {
  const definitions = [operator("a", ctx => ctx.emit({ value: 2 })), operator("b", ctx => ctx.emit({ value: 3 }))];
  for (const broken of [
    graph([node("a", ["request"]), node("b", ["a"])], [], ["b"]),
    graph([node("a", ["request"]), node("b", ["request"])], [], ["a"]),
    graph([node("a", ["missing"])]),
  ]) assert.throws(() => compileWorkflow({ graph: broken, bindings: {} }, { nodeDefinitions: definitions }), error => error.code === "COMPILE_INVALID_GRAPH");
});

test("profile resources must exist, validate and reach the node explicitly", async () => {
  const definition = { graph: graph(), bindings: { a: { config: {}, profileId: "chosen" } } };
  const options = { nodeDefinitions: [operator("a", ctx => ctx.emit({ value: ctx.profile.value }), {
    config: { validate: value => value }, profileValidator: port.validate,
  })] };
  assert.throws(() => compileWorkflow(definition, options), error => error.code === "COMPILE_BINDING");
  assert.throws(() => compileWorkflow(definition, { ...options, profiles: { chosen: { value: "bad" } } }), error => error.code === "COMPILE_BINDING");
  const compiled = compileWorkflow(definition, { ...options, profiles: { chosen: { value: 7 } } });
  const result = await runWorkflow(compiled, input());
  assert.equal(result.status, "completed");
  assert.deepEqual(result.outputEvent.payload, { value: 7 });
});

test("local graph symlinks cannot escape allowedRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-root-"));
  const outside = await mkdtemp(join(tmpdir(), "nnanything-external-"));
  try {
    await writeFile(join(outside, "outside.graph.json"), JSON.stringify(graph()));
    await symlink(join(outside, "outside.graph.json"), join(root, "linked.graph.json"));
    await writeFile(join(root, "workflow.json"), JSON.stringify({ configVersion: 1, graphRef: "linked.graph.json", configs: {}, bindings: {} }));
    await assert.rejects(loadWorkflow({ configPath: join(root, "workflow.json"), allowedRoot: root }), error => error.code === "LOAD_PATH_OUTSIDE_ROOT");
  } finally { await rm(root, { recursive: true }); await rm(outside, { recursive: true }); }
});
