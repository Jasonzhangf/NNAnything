import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileWorkflow, createWorkflowInputEvent, loadWorkflow, runWorkflow } from "nnanything";
import { domBasicKindsNode, domNodeDefinitions } from "nnanything/browser";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function execute(config, nodeDefinitions, payload, type, port, runId) {
  const definition = await loadWorkflow({ configPath: `${root}workflows/${config}.workflow.json`, allowedRoot: root });
  if (config === "dom-candidates") {
    for (const binding of Object.values(definition.bindings)) binding.config = { viewportOnly: true, scopeMode: "subtree" };
  }
  const result = await runWorkflow(compileWorkflow(definition, { nodeDefinitions }), createWorkflowInputEvent({ runId, eventId: `${runId}:input`, port, type, payload }));
  if (result.status !== "completed" || result.outputEvent.status !== "ok") throw new Error(JSON.stringify(result));
  return result.outputEvent.payload;
}
let input;
if (process.argv.length > 2) {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") throw new Error("usage: demo.mjs [--input candidate-batch.json]");
  input = JSON.parse(await readFile(process.argv[3], "utf8"));
} else {
  const fixture = JSON.parse(await readFile(new URL("./basic-kinds.fixture.json", import.meta.url), "utf8"));
  const candidates = await execute("dom-candidates", domNodeDefinitions, { observation: fixture.observation, nodeRefs: fixture.nodeRefs }, "dom.candidates.request.v1", "request", "basic-kind-candidates");
  input = { ...candidates, itemObservations: fixture.itemObservations };
}
const output = await execute("dom-basic-kinds", [domBasicKindsNode], input, "dom.candidate-slots.v1", "candidate_slots", "basic-kind-demo");
if (process.argv.length === 2) {
  assert.deepEqual(output.slots.map(slot => slot.basicKind), ["button", "image", "other", "text", "link", "container", "other", null, null, "button", null]);
  assert.equal(output.slots[0].evidence.stateFlags.disabled, true);
  assert.equal(output.slots[7].reasons[0], "candidate_unknown");
  assert.equal(output.slots[8].judgmentStatus, "excluded");
  assert.equal(output.slots.length, input.slots.length);
}
console.log(JSON.stringify({ taskId: output.taskId, profileId: output.profileId, counts: Object.fromEntries(["judged", "unknown", "conflict", "excluded"].map(status => [status, output.slots.filter(slot => slot.judgmentStatus === status).length])), slots: output.slots.map(({ index, nodeRef, candidateStatus, family, basicKind, judgmentStatus, score, confidenceState, reasons, evidence }) => ({ index, nodeRef, candidateStatus, family, basicKind, judgmentStatus, score, confidenceState, reasons, path: evidence.path.map(({ stage, status, selected }) => ({ stage, status, selected })) })) }, null, 2));
