import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import type { TrainableSemanticUnit } from "../core/trainable-unit.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectRecord } from "../core/schema.js";
import type { FeedbackInput, FeedbackInferenceResult, FeedbackProfile, FeedbackTrainingRequest, FeedbackTrainingReceipt, FeedbackTrainingResources } from "../adapters/browser/feedback-contract.js";
import { predictFeedback, readFeedbackInput, validateFeedbackProfile } from "../filters/browser-feedback.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";
import { runBrowserFeedbackTraining } from "./browser-feedback-training.js";

const port = (name: string) => ({ name, schemaId: `browser.feedback/${name}/v1`, eventType: `browser.feedback.${name}.v1`, validate: (value: unknown) => expectRecord(value, name) });
export function createBrowserFeedbackInferenceNodes(resources: { readonly profile: FeedbackProfile }): readonly NodeDefinition[] {
  const profile = validateFeedbackProfile(resources.profile);
  return [{ operator: "browser.feedback.infer", version: "0.1.0.0000", inputPorts: [port("feedback_request")], outputPort: port("feedback_result"), effects: [],
    execute: context => {
      const input = readFeedbackInput(context.inputs[0]!.payload);
      return context.emit({ prediction: predictFeedback(input, profile), input, satisfaction: null } satisfies FeedbackInferenceResult);
    } }];
}
export async function runBrowserFeedbackInference(input: FeedbackInput, resources: { readonly profile: FeedbackProfile }): Promise<FeedbackInferenceResult> {
  const definition = await loadWorkflow({ configPath: fileURLToPath(new URL("../../workflows/browser-feedback.workflow.json", import.meta.url)), allowedRoot: fileURLToPath(new URL("../../workflows/", import.meta.url)) });
  const compiled = compileWorkflow(definition, { nodeDefinitions: createBrowserFeedbackInferenceNodes(resources), grantedEffects: [] });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({ runId, eventId: `${runId}:input`, port: "feedback_request", type: "browser.feedback.feedback_request.v1", payload: readFeedbackInput(input) }));
  if (result.status === "failed") throw new Error(result.error.message, { cause: result.error });
  return result.outputEvent.payload as FeedbackInferenceResult;
}
export const browserFeedbackUnit: TrainableSemanticUnit<FeedbackInput, FeedbackInferenceResult, { readonly profile: FeedbackProfile }, FeedbackTrainingRequest, FeedbackTrainingReceipt, FeedbackTrainingResources> = {
  infer: runBrowserFeedbackInference, train: runBrowserFeedbackTraining,
};
