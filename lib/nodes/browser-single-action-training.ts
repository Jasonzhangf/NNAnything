import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectFiniteNumber, expectRecord } from "../core/schema.js";
import type {
  BrowserSingleActionProfile,
  SingleActionTeacherEpisode,
} from "../adapters/browser/single-action-contract.js";
import {
  createZeroBrowserSingleActionProfile,
  validateBrowserSingleActionProfile,
} from "../filters/browser-single-action-policy.js";
import {
  type BrowserSingleActionFitTiming,
  type BrowserSingleActionFitTrajectory,
  fitBrowserSingleActionProfile,
} from "../training/browser-single-action-numeric.js";
import {
  partitionBrowserSingleActionSamples,
  readBrowserSingleActionPartitions,
  readBrowserSingleActionTeacherEpisodes,
} from "../training/browser-single-action-samples.js";
import {
  assessBrowserSingleActionTraining,
  evaluateBrowserSingleActionComparison,
  readBrowserSingleActionTrainingReceipt,
  writeBrowserSingleActionTrainingArtifacts,
  type BrowserSingleActionComparison,
  type BrowserSingleActionTrainingAssessment,
  type BrowserSingleActionTrainingReceipt,
} from "../training/browser-single-action-training.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

export interface BrowserSingleActionTrainingOptions {
  readonly episodes: readonly SingleActionTeacherEpisode[];
  readonly handwiredRoot: string;
  readonly outputDirectory: string;
  readonly relationEpochs?: number;
  readonly capabilityEpochs?: number;
  readonly learningRate?: number;
}

interface TrainingRequest {
  readonly episodes: readonly SingleActionTeacherEpisode[];
  readonly relationEpochs: number;
  readonly capabilityEpochs: number;
  readonly learningRate: number;
}

interface FittedCandidate {
  readonly profile: BrowserSingleActionProfile;
  readonly timing: BrowserSingleActionFitTiming;
  readonly trajectory: BrowserSingleActionFitTrajectory;
}

interface ComparedCandidate {
  readonly candidate: FittedCandidate;
  readonly comparison: BrowserSingleActionComparison;
}

interface AssessedCandidate extends ComparedCandidate {
  readonly assessment: BrowserSingleActionTrainingAssessment;
}

export interface BrowserSingleActionTrainingDiagnostics {
  readonly partialPaths: {
    candidatePath?: string;
    reportPath?: string;
    casesPath?: string;
  };
  timing?: BrowserSingleActionFitTiming;
  trajectory?: BrowserSingleActionFitTrajectory;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function budget(value: unknown, label: string): number {
  const number = expectFiniteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return number;
}

function learningRate(value: unknown): number {
  const number = expectFiniteNumber(value, "learningRate");
  if (number <= 0) throw new TypeError("learningRate must be positive");
  return number;
}

function readTrainingRequest(value: unknown): TrainingRequest {
  const input = expectRecord(value, "browser single action training request");
  exactKeys(input, ["episodes", "relationEpochs", "capabilityEpochs", "learningRate"], "browser single action training request");
  return Object.freeze({
    episodes: readBrowserSingleActionTeacherEpisodes(input.episodes),
    relationEpochs: budget(input.relationEpochs, "relationEpochs"),
    capabilityEpochs: budget(input.capabilityEpochs, "capabilityEpochs"),
    learningRate: learningRate(input.learningRate),
  });
}

function readCandidate(value: unknown): FittedCandidate {
  const input = expectRecord(value, "browser single action candidate");
  const profile = validateBrowserSingleActionProfile(input.profile);
  if (typeof input.timing !== "object" || input.timing === null) throw new TypeError("candidate.timing is required");
  if (!Array.isArray(input.trajectory)) throw new TypeError("candidate.trajectory must be an array");
  return Object.freeze({
    profile,
    timing: input.timing as unknown as BrowserSingleActionFitTiming,
    trajectory: input.trajectory as unknown as BrowserSingleActionFitTrajectory,
  });
}

function readCompared(value: unknown): ComparedCandidate {
  const input = expectRecord(value, "browser single action comparison stage");
  return Object.freeze({
    candidate: readCandidate(input.candidate),
    comparison: input.comparison as BrowserSingleActionComparison,
  });
}

function readAssessmentStage(value: unknown): AssessedCandidate {
  const input = expectRecord(value, "browser single action assessment stage");
  return Object.freeze({
    candidate: readCandidate(input.candidate),
    comparison: input.comparison as BrowserSingleActionComparison,
    assessment: input.assessment as BrowserSingleActionTrainingAssessment,
  });
}

const port = (name: string, eventType: string, validate: (value: unknown) => unknown) => ({
  name,
  schemaId: eventType,
  eventType,
  validate,
});

const REQUEST_PORT = port("training_request", "browser.single-action.training.request.v1", readTrainingRequest);
const SAMPLES_PORT = port("samples", "browser.single-action.training.samples.v1",
  value => readBrowserSingleActionTeacherEpisodes(value));
const PARTITIONS_PORT = port("partitions", "browser.single-action.training.partitions.v1",
  readBrowserSingleActionPartitions);
const CANDIDATE_PORT = port("candidate", "browser.single-action.training.candidate.v1", readCandidate);
const COMPARISON_PORT = port("comparison", "browser.single-action.training.comparison.v1", readCompared);
const ASSESSMENT_PORT = port("assessment", "browser.single-action.training.assessment.v1", readAssessmentStage);
const RESULT_PORT = port("training_result", "browser.single-action.training.result.v1",
  readBrowserSingleActionTrainingReceipt);

export function createBrowserSingleActionTrainingNodes(
  resources: Readonly<{
    handwiredRoot: string;
    outputDirectory: string;
    relationEpochs: number;
    capabilityEpochs: number;
    learningRate: number;
  }>,
  diagnostics: BrowserSingleActionTrainingDiagnostics,
): readonly NodeDefinition[] {
  if (!isAbsolute(resources.handwiredRoot) || !isAbsolute(resources.outputDirectory)) {
    throw new TypeError("Explicit absolute Handwired and output roots are required");
  }
  const node = (
    name: string,
    inputPorts: readonly NodeDefinition["inputPorts"][number][],
    outputPort: NodeDefinition["outputPort"],
    effects: readonly string[],
    execute: NodeDefinition["execute"],
  ): NodeDefinition => Object.freeze({
    operator: `browser.singleAction.training.${name}`,
    version: "0.1.0.0000",
    inputPorts,
    outputPort,
    effects,
    execute,
  });
  return Object.freeze([
    node("prepare", [REQUEST_PORT], SAMPLES_PORT, [], context =>
      context.emit(readTrainingRequest(context.inputs[0]!.payload).episodes)),

    node("partition", [SAMPLES_PORT], PARTITIONS_PORT, [], context =>
      context.emit(partitionBrowserSingleActionSamples(context.inputs[0]!.payload))),

    node("fit", [PARTITIONS_PORT], CANDIDATE_PORT, ["filesystem.read"], async context => {
      const partitions = readBrowserSingleActionPartitions(context.inputs[0]!.payload);
      let fitted;
      try {
        fitted = await fitBrowserSingleActionProfile({
          initial: createZeroBrowserSingleActionProfile(),
          episodes: partitions.train,
          handwiredRoot: resources.handwiredRoot,
          relationEpochs: resources.relationEpochs,
          capabilityEpochs: resources.capabilityEpochs,
          learningRate: resources.learningRate,
        });
      } catch (error) {
        const partial = error as {
          timing?: BrowserSingleActionFitTiming;
          trajectory?: BrowserSingleActionFitTrajectory;
        };
        if (partial.timing !== undefined) diagnostics.timing = partial.timing;
        if (partial.trajectory !== undefined) diagnostics.trajectory = partial.trajectory;
        throw error;
      }
      diagnostics.timing = fitted.timing;
      diagnostics.trajectory = fitted.trajectory;
      return context.emit(Object.freeze({
        profile: fitted.profile,
        timing: fitted.timing,
        trajectory: fitted.trajectory,
      } satisfies FittedCandidate));
    }),

    node("compare", [PARTITIONS_PORT, CANDIDATE_PORT], COMPARISON_PORT, [], context => {
      const partitions = readBrowserSingleActionPartitions(context.inputs[0]!.payload);
      const candidate = readCandidate(context.inputs[1]!.payload);
      return context.emit(Object.freeze({
        candidate,
        comparison: evaluateBrowserSingleActionComparison(partitions, candidate.profile),
      } satisfies ComparedCandidate));
    }),

    node("assess", [COMPARISON_PORT], ASSESSMENT_PORT, [], context => {
      const compared = readCompared(context.inputs[0]!.payload);
      return context.emit(Object.freeze({
        ...compared,
        assessment: assessBrowserSingleActionTraining(compared.comparison),
      } satisfies AssessedCandidate));
    }),

    node("report", [ASSESSMENT_PORT], RESULT_PORT, ["filesystem.write"], async context => {
      const stage = readAssessmentStage(context.inputs[0]!.payload);
      const written = await writeBrowserSingleActionTrainingArtifacts({
        outputDirectory: resources.outputDirectory,
        runId: context.runId,
        profile: stage.candidate.profile,
        timing: stage.candidate.timing,
        trajectory: stage.candidate.trajectory,
        comparison: stage.comparison,
        assessment: stage.assessment,
        onPartial: paths => Object.assign(diagnostics.partialPaths, paths),
      });
      return context.emit(written.receipt);
    }),
  ]);
}

const configPath = fileURLToPath(new URL("../../workflows/browser-single-action-training.workflow.json", import.meta.url));
const allowedRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

export async function runBrowserSingleActionTraining(
  options: BrowserSingleActionTrainingOptions,
): Promise<BrowserSingleActionTrainingReceipt> {
  if (typeof options !== "object" || options === null) throw new TypeError("Explicit browser single action training options are required");
  if (!isAbsolute(options.handwiredRoot) || !isAbsolute(options.outputDirectory)) {
    throw new TypeError("Explicit absolute handwiredRoot and outputDirectory are required");
  }
  const request: TrainingRequest = Object.freeze({
    episodes: readBrowserSingleActionTeacherEpisodes(options.episodes),
    relationEpochs: budget(options.relationEpochs ?? 200, "relationEpochs"),
    capabilityEpochs: budget(options.capabilityEpochs ?? 200, "capabilityEpochs"),
    learningRate: learningRate(options.learningRate ?? 0.1),
  });
  const diagnostics: BrowserSingleActionTrainingDiagnostics = { partialPaths: {} };
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserSingleActionTrainingNodes({
      handwiredRoot: options.handwiredRoot,
      outputDirectory: options.outputDirectory,
      relationEpochs: request.relationEpochs,
      capabilityEpochs: request.capabilityEpochs,
      learningRate: request.learningRate,
    }, diagnostics),
    grantedEffects: ["filesystem.read", "filesystem.write"],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "training_request",
    type: "browser.single-action.training.request.v1",
    payload: request,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message), {
      category: result.error.category,
      nodeId: result.error.nodeId,
      partialPaths: diagnostics.partialPaths,
      timing: diagnostics.timing,
      trajectory: diagnostics.trajectory,
    });
  }
  return readBrowserSingleActionTrainingReceipt(result.outputEvent.payload);
}

export const browserSingleActionTrainingOperatorNames = [
  "browser.singleAction.training.prepare",
  "browser.singleAction.training.partition",
  "browser.singleAction.training.fit",
  "browser.singleAction.training.compare",
  "browser.singleAction.training.assess",
  "browser.singleAction.training.report",
] as const;
