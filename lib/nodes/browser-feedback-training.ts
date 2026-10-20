import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectRecord } from "../core/schema.js";
import type { FeedbackFitResult, FeedbackTrainingReceipt, FeedbackTrainingRequest, FeedbackTrainingResources } from "../adapters/browser/feedback-contract.js";
import { createZeroFeedbackProfile, validateFeedbackProfile } from "../filters/browser-feedback.js";
import { readFeedbackEpisodes, partitionFeedbackEpisodes, evaluateFeedbackCases } from "../training/browser-feedback-samples.js";
import { fitFeedbackProfile } from "../training/browser-feedback-numeric.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

type Partitions = ReturnType<typeof partitionFeedbackEpisodes>;
interface Stage {
  request: FeedbackTrainingRequest;
  partitions?: Partitions;
  fit?: FeedbackFitResult;
  comparison?: FeedbackTrainingReceipt["comparison"];
  accepted?: boolean;
}
const port = (name: string) => ({ name, schemaId: `browser.feedback.training/${name}/v1`, eventType: `browser.feedback.training.${name}.v1`, validate: (value: unknown) => expectRecord(value, name) });
export function createBrowserFeedbackTrainingNodes(resources: FeedbackTrainingResources): readonly NodeDefinition[] {
  if (typeof resources.handwiredRoot !== "string" || !resources.handwiredRoot || typeof resources.outputDirectory !== "string" || !resources.outputDirectory) throw new TypeError("Explicit feedback training resources required");
  const node = (name: string, inputs: string[], output: string, execute: NodeDefinition["execute"], effects: readonly string[] = []): NodeDefinition => ({
    operator: `browser.feedback.training.${name}`, version: "0.1.0.0000", inputPorts: inputs.map(port), outputPort: port(output), effects, execute,
  });
  return [
    node("prepare", ["training_request"], "samples", context => {
      const request = context.inputs[0]!.payload as FeedbackTrainingRequest;
      validateFeedbackProfile(request.initial);
      if (!Number.isInteger(request.epochs) || request.epochs < 0 || !Number.isFinite(request.learningRate) || request.learningRate <= 0) throw new TypeError("Invalid explicit feedback training budget");
      return context.emit({ request: { ...request, episodes: readFeedbackEpisodes(request.episodes) } } satisfies Stage);
    }),
    node("partition", ["samples"], "partitions", context => {
      const stage = context.inputs[0]!.payload as Stage;
      const partitions = partitionFeedbackEpisodes(stage.request.episodes);
      if (partitions.verification.length || !partitions.train.length || !partitions.development.length) throw new TypeError("Feedback training requires train/development and rejects verification");
      return context.emit({ ...stage, partitions } satisfies Stage);
    }),
    node("fit", ["partitions"], "candidate", async context => {
      const stage = context.inputs[0]!.payload as Stage;
      const fit = await fitFeedbackProfile({ ...stage.request, episodes: stage.partitions!.train, handwiredRoot: resources.handwiredRoot });
      return context.emit({ request: stage.request, fit } satisfies Stage);
    }),
    node("compare", ["partitions", "candidate"], "comparison", context => {
      const stage = context.inputs[1]!.payload as Stage;
      const partitions = (context.inputs[0]!.payload as Stage).partitions!;
      const zero = createZeroFeedbackProfile();
      const comparison = { train: { zero: evaluateFeedbackCases(zero, partitions.train), trained: evaluateFeedbackCases(stage.fit!.profile, partitions.train) },
        development: { zero: evaluateFeedbackCases(zero, partitions.development), trained: evaluateFeedbackCases(stage.fit!.profile, partitions.development) } };
      return context.emit({ ...stage, comparison } satisfies Stage);
    }),
    node("assess", ["comparison"], "assessment", context => {
      const stage = context.inputs[0]!.payload as Stage;
      const result = stage.comparison!;
      const accepted = result.train.trained.failed === 0 && result.development.trained.failed === 0
        && result.train.trained.passed > result.train.zero.passed;
      return context.emit({ ...stage, accepted } satisfies Stage);
    }),
    node("report", ["assessment"], "training_result", async context => {
      const stage = context.inputs[0]!.payload as Stage;
      const candidatePath = join(resources.outputDirectory, "candidate.json");
      const reportPath = join(resources.outputDirectory, "report.json");
      const receipt: FeedbackTrainingReceipt = { runId: randomUUID(), accepted: stage.accepted!, profile: stage.fit!.profile, fit: stage.fit!, comparison: stage.comparison!, candidatePath, reportPath,
        error: stage.accepted ? null : "Feedback candidate failed train/development acceptance" };
      await mkdir(resources.outputDirectory, { recursive: true });
      await writeFile(candidatePath, JSON.stringify(receipt.profile, null, 2) + "\n");
      await writeFile(reportPath, JSON.stringify(receipt, null, 2) + "\n");
      return context.emit(receipt);
    }, ["filesystem.write"]),
  ];
}
export async function runBrowserFeedbackTraining(request: FeedbackTrainingRequest, resources: FeedbackTrainingResources): Promise<FeedbackTrainingReceipt> {
  const definition = await loadWorkflow({ configPath: fileURLToPath(new URL("../../workflows/browser-feedback-training.workflow.json", import.meta.url)), allowedRoot: fileURLToPath(new URL("../../workflows/", import.meta.url)) });
  const compiled = compileWorkflow(definition, { nodeDefinitions: createBrowserFeedbackTrainingNodes(resources), grantedEffects: ["filesystem.write"] });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({ runId, eventId: `${runId}:input`, port: "training_request", type: "browser.feedback.training.training_request.v1", payload: request }));
  if (result.status === "failed") throw new Error(result.error.message, { cause: result.error });
  return result.outputEvent.payload as FeedbackTrainingReceipt;
}
