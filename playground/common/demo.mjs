import assert from "node:assert/strict";
import { commonNodeDefinitions, compileWorkflow, createWorkflowInputEvent, NUMBERS_EVENT_TYPE, runWorkflow } from "nnanything";

const selector = { include: [], exclude: [] };
const node = (id, operator, input, output) => ({
  id, operator, operator_version: "1", inputs: [input], output: { id: output, schema: "Object" },
  input_selector: selector, output_selector: selector, iterator: "Whole",
});
const compiled = compileWorkflow({
  graph: {
    id: "common-numbers", version: "1", inputs: [{ id: "request", schema: "Object" }],
    nodes: [node("scale", "common.scale", "request", "scaled"), node("sum", "common.sum", "scaled", "total")],
    edges: [{ from: "scale", to: "sum", arc_id: "scaled" }], outputs: ["total"],
  },
  bindings: { scale: { config: { factor: 3 } } },
}, { nodeDefinitions: commonNodeDefinitions });
const result = await runWorkflow(compiled, createWorkflowInputEvent({
  runId: "common-demo", eventId: "common-demo:input", port: "request", type: NUMBERS_EVENT_TYPE,
  payload: { values: [1, 2, 3] },
}));
assert.equal(result.status, "completed");
assert.equal(result.outputEvent.status, "ok");
assert.deepEqual(result.outputEvent.payload, { total: 18 });
console.log(JSON.stringify(result, null, 2));
