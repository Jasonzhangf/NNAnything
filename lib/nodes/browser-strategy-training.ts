import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectFiniteNumber, expectRecord } from "../core/schema.js";
import type {
  StrategyEpisodePartitions,
  StrategyEvaluationModels,
} from "../training/browser-strategy-samples.js";
import type {
  BrowserStrategyProfile,
  StrategyFitResult,
  StrategyTrainingReceipt,
  StrategyTrainingRequest,
  StrategyTrainingResources,
} from "../adapters/browser/strategy-contract.js";
import {
  createZeroBrowserStrategyProfile,
  validateBrowserStrategyProfile,
} from "../filters/browser-strategy.js";
import { validateBrowserSingleActionProfile } from "../filters/browser-single-action-policy.js";
import { validateFeedbackProfile } from "../filters/browser-feedback.js";
import {
  evaluateStrategyCases,
  partitionStrategyEpisodes,
  readStrategyEpisodes,
} from "../training/browser-strategy-samples.js";
import { fitBrowserStrategyProfile } from "../training/browser-strategy-numeric.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

interface PartitionedStage {
  readonly request: StrategyTrainingRequest;
  readonly partitions: StrategyEpisodePartitions;
}

interface CandidateStage {
  readonly request: StrategyTrainingRequest;
  readonly fit: StrategyFitResult;
}

interface ComparedStage {
  readonly fit: StrategyFitResult;
  readonly comparison: StrategyTrainingReceipt["comparison"];
}

interface AssessedStage extends ComparedStage {
  readonly accepted: boolean;
}

const REQUEST_KEYS = ["initial", "episodes", "epochs", "learningRate"] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function trainingBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("browser strategy training epochs must be a nonnegative integer");
  }
  return value;
}

function learningRate(value: unknown): number {
  const rate = expectFiniteNumber(value, "browser strategy training learningRate");
  if (rate <= 0) throw new TypeError("browser strategy training learningRate must be positive");
  return rate;
}

function readTrainingRequest(value: unknown): StrategyTrainingRequest {
  const input = expectRecord(value, "browser strategy training request");
  exactKeys(input, REQUEST_KEYS, "browser strategy training request");
  return Object.freeze({
    initial: validateBrowserStrategyProfile(input.initial),
    episodes: readStrategyEpisodes(input.episodes),
    epochs: trainingBudget(input.epochs),
    learningRate: learningRate(input.learningRate),
  });
}

const port = (name: string) => ({
  name,
  schemaId: `browser.strategy.training/${name}/v1`,
  eventType: `browser.strategy.training.${name}.v1`,
  validate: (value: unknown) => expectRecord(value, name),
});

export function createBrowserStrategyTrainingNodes(resources: StrategyTrainingResources): readonly NodeDefinition[] {
  if (typeof resources.handwiredRoot !== "string" || !resources.handwiredRoot
    || typeof resources.outputDirectory !== "string" || !resources.outputDirectory) {
    throw new TypeError("Explicit browser strategy handwiredRoot and outputDirectory are required");
  }
  validateBrowserSingleActionProfile(resources.atomicProfile);
  validateFeedbackProfile(resources.feedbackProfile);
  const models: StrategyEvaluationModels = Object.freeze({
    atomicProfile: resources.atomicProfile,
    feedbackProfile: resources.feedbackProfile,
  });
  const node = (
    name: string,
    inputs: readonly string[],
    output: string,
    effects: readonly string[],
    execute: NodeDefinition["execute"],
  ): NodeDefinition => ({
    operator: `browser.strategy.training.${name}`,
    version: "0.1.0.0000",
    inputPorts: inputs.map(port),
    outputPort: port(output),
    effects,
    execute,
  });

  return [
    node("prepare", ["training_request"], "samples", [], context =>
      context.emit(readTrainingRequest(context.inputs[0]!.payload))),

    node("partition", ["samples"], "partitions", [], context => {
      const request = readTrainingRequest(context.inputs[0]!.payload);
      const partitions = partitionStrategyEpisodes(request.episodes);
      if (partitions.verification.length > 0) {
        throw new TypeError("browser strategy training rejects verification episodes");
      }
      if (partitions.train.length === 0 || partitions.development.length === 0) {
        throw new TypeError("browser strategy training requires train and development episodes");
      }
      return context.emit(Object.freeze({ request, partitions } satisfies PartitionedStage));
    }),

    node("fit", ["partitions"], "candidate", [], async context => {
      const stage = context.inputs[0]!.payload as PartitionedStage;
      const fit = await fitBrowserStrategyProfile({
        profile: stage.request.initial,
        episodes: stage.partitions.train,
        atomicProfile: resources.atomicProfile,
        feedbackProfile: resources.feedbackProfile,
        handwiredRoot: resources.handwiredRoot,
        epochs: stage.request.epochs,
        learningRate: stage.request.learningRate,
      });
      return context.emit(Object.freeze({ request: stage.request, fit } satisfies CandidateStage));
    }),

    node("compare", ["partitions", "candidate"], "comparison", [], context => {
      const partitions = (context.inputs[0]!.payload as PartitionedStage).partitions;
      const candidate = context.inputs[1]!.payload as CandidateStage;
      validateBrowserStrategyProfile(candidate.fit.profile);
      const zero: BrowserStrategyProfile = createZeroBrowserStrategyProfile();
      const comparison: StrategyTrainingReceipt["comparison"] = {
        train: {
          zero: evaluateStrategyCases(zero, partitions.train, models),
          trained: evaluateStrategyCases(candidate.fit.profile, partitions.train, models),
        },
        development: {
          zero: evaluateStrategyCases(zero, partitions.development, models),
          trained: evaluateStrategyCases(candidate.fit.profile, partitions.development, models),
        },
      };
      return context.emit(Object.freeze({ fit: candidate.fit, comparison } satisfies ComparedStage));
    }),

    node("assess", ["comparison"], "assessment", [], context => {
      const stage = context.inputs[0]!.payload as ComparedStage;
      const accepted = stage.comparison.train.trained.failed === 0
        && stage.comparison.development.trained.failed === 0
        && stage.comparison.train.trained.passed > stage.comparison.train.zero.passed
        && stage.comparison.development.trained.passed > stage.comparison.development.zero.passed;
      return context.emit(Object.freeze({ ...stage, accepted } satisfies AssessedStage));
    }),

    node("report", ["assessment"], "training_result", ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as AssessedStage;
      const candidatePath = join(resources.outputDirectory, "candidate.json");
      const reportPath = join(resources.outputDirectory, "report.json");
      const receipt: StrategyTrainingReceipt = {
        accepted: stage.accepted,
        profile: stage.fit.profile,
        fit: stage.fit,
        comparison: stage.comparison,
        candidatePath,
        reportPath,
        error: stage.accepted ? null : "Strategy candidate did not improve and pass train/development",
      };
      await mkdir(resources.outputDirectory, { recursive: true });
      await writeFile(candidatePath, `${JSON.stringify(receipt.profile, null, 2)}\n`);
      await writeFile(reportPath, `${JSON.stringify(receipt, null, 2)}\n`);
      return context.emit(receipt);
    },),
  ];
}

const configPath = fileURLToPath(new URL("../../workflows/browser-strategy-training.workflow.json", import.meta.url));
const allowedRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

export async function runBrowserStrategyTraining(
  request: StrategyTrainingRequest,
  resources: StrategyTrainingResources,
): Promise<StrategyTrainingReceipt> {
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserStrategyTrainingNodes(resources),
    grantedEffects: ["filesystem.write"],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "training_request",
    type: "browser.strategy.training.training_request.v1",
    payload: request,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message, { cause: result.error }), {
      category: result.error.category,
      nodeId: result.error.nodeId,
    });
  }
  const receipt = result.outputEvent.payload as StrategyTrainingReceipt;
  validateBrowserStrategyProfile(receipt.profile);
  return receipt;
}
