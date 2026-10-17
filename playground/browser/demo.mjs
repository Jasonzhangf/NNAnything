import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileWorkflow, createWorkflowInputEvent, loadWorkflow, runWorkflow } from "nnanything";
import { DOM_CANDIDATE_REQUEST_EVENT_TYPE, domNodeDefinitions } from "nnanything/browser";

const definition = await loadWorkflow({
  configPath: fileURLToPath(new URL("./dom-candidates.workflow.json", import.meta.url)),
  allowedRoot: fileURLToPath(new URL("../../", import.meta.url)),
});
const observation = JSON.parse(await readFile(new URL("./observation.fixture.json", import.meta.url), "utf8"));
const workflow = compileWorkflow(definition, { nodeDefinitions: domNodeDefinitions });
for (const [name, nodeRefs] of [["page", undefined], ["explicit", ["allowed-span", "partial", "allowed-span", "unknown-clipping", "denied-button", "missing-ref"]]]) {
  const runId = `browser-demo-${name}`;
  const result = await runWorkflow(workflow, createWorkflowInputEvent({ runId, eventId: `${runId}:input`, port: "request", type: DOM_CANDIDATE_REQUEST_EVENT_TYPE, correlation: {}, payload: { observation, ...(nodeRefs === undefined ? {} : { nodeRefs }) } }));
  if (result.status !== "completed" || result.outputEvent.status !== "ok") throw new Error(JSON.stringify(result));
  const { slots, candidateRefs } = result.outputEvent.payload;
  console.log(JSON.stringify({ mode: name, status: result.status, candidateRefs, counts: Object.fromEntries(["ok", "filtered_out", "skipped", "unknown"].map(status => [status, slots.filter(slot => slot.status === status).length])), slots: slots.map(({ index, nodeRef, status, reasons }) => ({ index, nodeRef, status, reasons })) }, null, 2));
}
