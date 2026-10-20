import type { EventEnvelope } from "../core/events.js";
import type { NodeDefinition } from "../core/contracts.js";
import { expectNonEmptyString } from "../core/schema.js";
import { isAbsolute } from "node:path";
import { validateBasicKindProfile } from "../filters/basic-kinds.js";
import {
  BASIC_KIND_TASK_ID,
  readBasicKindSamples,
  readBasicKindTrainingRequest,
  readPrepareBasicKindConfig,
  prepareBasicKindSamples,
  toBasicKindFitRows,
} from "../training/basic-kind-samples.js";
import {
  assessBasicKindComparison,
  compareBasicKindCandidates,
  partitionBasicKindSamples,
  readBasicKindAssessConfig,
  readBasicKindAssessment,
  readBasicKindCandidate,
  readBasicKindComparison,
  readBasicKindPartitionConfig,
  readBasicKindPartitions,
  readBasicKindReportConfig,
  readBasicKindResult,
  writeBasicKindTrainingArtifacts,
} from "../training/basic-kind-training.js";
import {
  fitBasicKinds,
  validateBasicKindTrainingConfig,
  type FitProgress,
} from "../training/basic-kind-numeric.js";

const REQUEST_PORT = { name: "training_request", schemaId: "training/basic-kinds/request/v1", eventType: "training.request.v1", validate: readBasicKindTrainingRequest };
const SAMPLES_PORT = { name: "samples", schemaId: "training/basic-kinds/samples/v1", eventType: "training.samples.v1", validate: readBasicKindSamples };
const PARTITIONS_PORT = { name: "partitions", schemaId: "training/basic-kinds/partitions/v1", eventType: "training.partitions.v1", validate: readBasicKindPartitions };
const CANDIDATE_PORT = { name: "candidate", schemaId: "training/basic-kinds/candidate/v1", eventType: "training.candidate.v1", validate: readBasicKindCandidate };
const COMPARISON_PORT = { name: "comparison", schemaId: "training/basic-kinds/comparison/v1", eventType: "training.comparison.v1", validate: readBasicKindComparison };
const ASSESSMENT_PORT = { name: "assessment", schemaId: "training/basic-kinds/assessment/v1", eventType: "training.assessment.v1", validate: readBasicKindAssessment };
const RESULT_PORT = { name: "training_result", schemaId: "training/basic-kinds/result/v1", eventType: "training.result.v1", validate: readBasicKindResult };

function reasonOf(event: EventEnvelope): string {
  const payload = event.payload;
  if (payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string") {
    return (payload as { reason: string }).reason;
  }
  return "upstream_not_ok";
}

function nonOk(event: EventEnvelope, details: Readonly<Record<string, unknown>> = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as { details?: unknown } : {};
  return {
    reason: reasonOf(event),
    details: {
      upstreamStatus: event.status,
      upstreamNode: event.producer.nodeId,
      ...(payload.details === undefined ? {} : { upstreamDetails: payload.details }),
      ...details,
    },
  };
}

export interface TrainingNodeResources {
  readonly handwiredRoot: string;
  readonly allowedRoot: string;
  readonly onFitProgress?: (progress: FitProgress, context: { readonly runId: string; readonly nodeId: string }) => void;
}

export function createTrainingNodeDefinitions(input: TrainingNodeResources): readonly NodeDefinition[] {
  const handwiredRoot = expectNonEmptyString(input.handwiredRoot, "handwiredRoot");
  const allowedRoot = expectNonEmptyString(input.allowedRoot, "allowedRoot");
  if (!isAbsolute(handwiredRoot)) throw new TypeError("handwiredRoot must be an absolute path");
  if (!isAbsolute(allowedRoot)) throw new TypeError("allowedRoot must be an absolute path");

  const prepareNode: NodeDefinition = {
    operator: "training.prepare",
    version: "0.1.0",
    inputPorts: [REQUEST_PORT],
    outputPort: SAMPLES_PORT,
    config: { required: true, validate: readPrepareBasicKindConfig },
    effects: [],
    execute: context => context.emit(prepareBasicKindSamples(context.inputs[0]!.payload, context.config)),
  };

  const partitionNode: NodeDefinition = {
    operator: "training.partition",
    version: "0.1.0",
    inputPorts: [SAMPLES_PORT],
    outputPort: PARTITIONS_PORT,
    config: { required: true, validate: readBasicKindPartitionConfig },
    effects: [],
    acceptNonOkInputs: true,
    execute: context => {
      const upstream = context.inputs[0]!;
      if (upstream.status !== "ok") {
        return context.emit(nonOk(upstream), { status: upstream.status });
      }
      const result = partitionBasicKindSamples(upstream.payload, context.config);
      return result.ok
        ? context.emit(result.partitions)
        : context.emit({ reason: result.reason, details: result.details }, { status: "unknown" });
    },
  };

  const fitNode: NodeDefinition = {
    operator: "training.fit",
    version: "0.1.0",
    inputPorts: [PARTITIONS_PORT],
    outputPort: CANDIDATE_PORT,
    config: { required: true, validate: validateBasicKindTrainingConfig },
    profileValidator: validateBasicKindProfile,
    effects: ["filesystem.read"],
    acceptNonOkInputs: true,
    execute: async context => {
      const upstream = context.inputs[0]!;
      if (upstream.status !== "ok") return context.emit(nonOk(upstream, { candidate: null }), { status: upstream.status });
      if (!context.profile) throw new TypeError("training.fit requires an explicit base BasicKindProfile binding");
      const baseProfile = validateBasicKindProfile(context.profile);
      const partitions = readBasicKindPartitions(upstream.payload);
      const samples = readBasicKindSamples({
        schemaVersion: 1,
        taskId: partitions.taskId,
        inputScope: partitions.inputScope,
        rows: partitions.rows,
        includedIndices: partitions.includedIndices,
      });
      const trainSet = new Set(partitions.trainIndices);
      const rows = toBasicKindFitRows(samples).filter((_row, index) => trainSet.has(samples.includedIndices[index]!));
      if (!rows.length) return context.emit({ reason: "no_included_training_samples", details: { trainIndices: partitions.trainIndices.length } }, { status: "unknown" });
      const config = validateBasicKindTrainingConfig(context.config);
      if (config.taskId !== partitions.taskId) throw new TypeError("training.fit config taskId differs from partitions taskId");
      const fitted = await fitBasicKinds({
        handwiredRoot,
        rows,
        baseProfile,
        config,
        candidateId: `${context.runId}-candidate`,
        onProgress: progress => {
          input.onFitProgress?.(progress, { runId: context.runId, nodeId: context.nodeId });
        },
      });
      const labelCounts: Partial<Record<string, number>> = {};
      for (const row of rows) labelCounts[row.expectedLabel] = (labelCounts[row.expectedLabel] ?? 0) + 1;
      return context.emit({
        schemaVersion: 1,
        taskId: BASIC_KIND_TASK_ID,
        candidateId: `${context.runId}-candidate`,
        baseProfileId: baseProfile.id,
        profile: fitted.profile,
        trajectory: fitted.trajectory,
        timing: fitted.timing,
        stoppingReason: fitted.stoppingReason,
        lossBefore: fitted.lossBefore,
        lossAfter: fitted.lossAfter,
        sampleCoverage: { trainRows: rows.length, labelCounts },
      });
    },
  };

  const compareNode: NodeDefinition = {
    operator: "training.compare",
    version: "0.1.0",
    inputPorts: [CANDIDATE_PORT, PARTITIONS_PORT],
    outputPort: COMPARISON_PORT,
    config: { required: true, validate: validateBasicKindTrainingConfig },
    profileValidator: validateBasicKindProfile,
    effects: [],
    acceptNonOkInputs: true,
    execute: context => {
      const upstream = context.inputs.find(event => event.status !== "ok");
      if (upstream) return context.emit(nonOk(upstream, { candidate: null }), { status: upstream.status });
      if (!context.profile) throw new TypeError("training.compare requires the same explicit base BasicKindProfile binding as training.fit");
      const baseProfile = validateBasicKindProfile(context.profile);
      return context.emit(compareBasicKindCandidates({
        candidate: context.inputs[0]!.payload,
        partitions: context.inputs[1]!.payload,
        baseProfile,
        config: context.config,
      }));
    },
  };

  const assessNode: NodeDefinition = {
    operator: "training.assess",
    version: "0.1.0",
    inputPorts: [COMPARISON_PORT],
    outputPort: ASSESSMENT_PORT,
    config: { required: true, validate: readBasicKindAssessConfig },
    effects: [],
    acceptNonOkInputs: true,
    execute: context => {
      const upstream = context.inputs[0]!;
      if (upstream.status !== "ok") {
        return context.emit({
          reason: reasonOf(upstream),
          candidate: null,
          details: {
            taskId: BASIC_KIND_TASK_ID,
            upstreamStatus: upstream.status,
            upstreamNode: upstream.producer.nodeId,
            upstreamReason: reasonOf(upstream),
          },
        }, { status: upstream.status });
      }
      const comparison = readBasicKindComparison(upstream.payload);
      return context.emit(assessBasicKindComparison(comparison, context.config));
    },
  };

  const reportNode: NodeDefinition = {
    operator: "training.report",
    version: "0.1.0",
    inputPorts: [ASSESSMENT_PORT],
    outputPort: RESULT_PORT,
    config: { required: true, validate: readBasicKindReportConfig },
    effects: ["filesystem.write"],
    acceptNonOkInputs: true,
    execute: async context => {
      const upstream = context.inputs[0]!;
      const assessment = upstream.status === "ok" ? readBasicKindAssessment(upstream.payload) : null;
      const receipt = await writeBasicKindTrainingArtifacts({
        allowedRoot,
        config: context.config,
        runId: context.runId,
        taskId: BASIC_KIND_TASK_ID,
        ...(upstream.status === "ok" ? {} : { reason: reasonOf(upstream) }),
        assessment,
      });
      if (upstream.status !== "ok") {
        return context.emit(receipt, { status: upstream.status });
      }
      return context.emit(receipt);
    },
  };

  return [prepareNode, partitionNode, fitNode, compareNode, assessNode, reportNode];
}

export const trainingNodeOperatorNames = [
  "training.prepare",
  "training.partition",
  "training.fit",
  "training.compare",
  "training.assess",
  "training.report",
] as const;

export const trainingSampleSchemas = {
  request: REQUEST_PORT.schemaId,
  samples: SAMPLES_PORT.schemaId,
  partitions: PARTITIONS_PORT.schemaId,
  candidate: CANDIDATE_PORT.schemaId,
  comparison: COMPARISON_PORT.schemaId,
  assessment: ASSESSMENT_PORT.schemaId,
  result: RESULT_PORT.schemaId,
} as const;
