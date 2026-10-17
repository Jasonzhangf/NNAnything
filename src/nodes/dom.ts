import type { NodeDefinition } from "../core/contracts.js";
import { createFocusSpec } from "../adapters/browser/focus.js";
import { applyCandidateStage, checkCandidates, observeCandidates, scopeIssue, splitCandidates, validateCandidateBatch, validateCandidateRequest } from "../adapters/browser/candidate-chain.js";

export const DOM_CANDIDATE_REQUEST_EVENT_TYPE = "dom.candidates.request.v1";
const types = {
  request: DOM_CANDIDATE_REQUEST_EVENT_TYPE,
  observed: "dom.observed.v1",
  viewport: "dom.viewport-slots.v1",
  focus: "dom.focused-slots.v1",
  deny: "dom.denied-slots.v1",
  allow: "dom.eligible-slots.v1",
  split: "dom.expanded-slots.v1",
  candidates: "dom.candidate-slots.v1",
};

function definition(stage: "observe" | "viewport" | "focus" | "deny" | "allow" | "split" | "candidates", input: keyof typeof types, output: keyof typeof types): NodeDefinition {
  const configured = stage !== "observe" && stage !== "split";
  return {
    operator: `dom.${stage}`, version: "0.1.0",
    inputPorts: [{ name: "input", schemaId: input === "request" ? "dom/request/v1" : "dom/candidate-batch/v1", eventType: types[input], validate: input === "request" ? validateCandidateRequest : validateCandidateBatch }],
    outputPort: { name: "output", schemaId: "dom/candidate-batch/v1", eventType: types[output], validate: validateCandidateBatch },
    ...(configured ? { config: { required: true, validate: createFocusSpec } } : {}),
    acceptNonOkInputs: true,
    execute(context) {
      const event = context.inputs[0]!;
      if (event.status !== "ok") return context.emit(event.payload, { status: event.status });
      if (stage === "observe") return context.emit(observeCandidates(validateCandidateRequest(event.payload)));
      const batch = validateCandidateBatch(event.payload);
      if (stage === "split") return context.emit(splitCandidates(batch));
      const focus = createFocusSpec(context.config);
      const issue = scopeIssue(batch, focus);
      if (issue) return context.emit({ reason: issue }, { status: "unknown" });
      return context.emit(stage === "candidates" ? checkCandidates(batch, focus) : applyCandidateStage(batch, focus, stage));
    },
  };
}

// Operator port contracts only. Workflow node instances and topology remain in the project graph.
export const domNodeDefinitions: readonly NodeDefinition[] = [
  definition("observe", "request", "observed"),
  definition("viewport", "observed", "viewport"),
  definition("focus", "viewport", "focus"),
  definition("deny", "focus", "deny"),
  definition("allow", "deny", "allow"),
  definition("split", "allow", "split"),
  definition("candidates", "split", "candidates"),
];
