import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CompiledWorkflow } from "./core/contracts.js";
import { createWorkflowInputEvent } from "./core/events.js";
import { compileWorkflow } from "./workflow/compiler.js";
import { loadWorkflow } from "./workflow/loader.js";
import { runWorkflow } from "./workflow/runner.js";
import { validateCliCommandProfile, type CliCommandProfile } from "./filters/cli-command-policy.js";
import { createEvidenceAuthority, type EvidenceAuthority } from "./filters/cli-state.js";
import { validatePropertyRequest } from "./filters/cli-file-property.js";
import {
  createCliFilePropertyNodes,
  type CliCommandBinding,
  type CliCommandRequest,
  type CliCommandTransition,
} from "./nodes/cli-command.js";
import {
  createCliCommandTrainingNodes,
  executeCliCommandTrainingSample,
  type CliCommandTrainingReceipt,
  type CliCommandTrainingRequest,
  type CliCommandTrainingResources,
} from "./nodes/cli-command-training.js";

export { executeCliCommandTrainingSample };

export * from "./filters/cli-command-policy.js";
export * from "./filters/cli-file-property.js";
export * from "./filters/cli-state.js";
export * from "./training/cli-command-numeric.js";
export * from "./training/cli-command-samples.js";
export type { CliCommandTrainingReceipt, CliCommandTrainingRequest, CliCommandTrainingResources } from "./nodes/cli-command-training.js";
export type {
  CliCommandAction,
  CliCommandBinding,
  CliCommandCollectionResult,
  CliCommandExecutionResult,
  CliCommandGoalResult,
  CliCommandPolicyError,
  CliCommandRequest,
  CliCommandSample,
  CliCommandStatus,
  CliCommandTransition,
} from "./nodes/cli-command.js";
export * from "./adapters/cli/filesystem-sandbox.js";
export * from "./adapters/cli/directory-listing.js";
export * from "./adapters/cli/sandbox-cleanup.js";
export * from "./filters/cwd-relation.js";
export * from "./training/cwd-relation-numeric.js";
export * from "./filters/two-class-linear.js";

const configPath = (name: string) => fileURLToPath(new URL(`../workflows/${name}.workflow.json`, import.meta.url));
const allowedRoot = fileURLToPath(new URL("../workflows/", import.meta.url));

export type CliCommandPolicy = Readonly<{
  step(request: CliCommandRequest): Promise<CliCommandTransition>;
}>;

export function createCliCommandPolicy(binding: CliCommandBinding): CliCommandPolicy {
  const profile = validateCliCommandProfile(binding.profile) as CliCommandProfile;
  // Validate the explicit session now; later steps read its current snapshot.
  binding.sandbox.getSession(binding.session);
  const authority: EvidenceAuthority = createEvidenceAuthority();
  const definitions = createCliFilePropertyNodes(binding, authority);
  const compiled: Promise<CompiledWorkflow> = loadWorkflow({ configPath: configPath("cli-file-property"), allowedRoot })
    .then(graph => compileWorkflow(graph, { nodeDefinitions: definitions, profiles: { "cli-command-policy": profile } }));
  return Object.freeze({
    async step(request: CliCommandRequest): Promise<CliCommandTransition> {
      validatePropertyRequest(request, binding.session);
      const runId = randomUUID();
      const result = await runWorkflow(await compiled, createWorkflowInputEvent({
        runId,
        eventId: `${runId}:input`,
        port: "file_property_request",
        type: "cli.file_property_request.v1",
        payload: request,
      }));
      if (result.status === "failed") {
        throw Object.assign(new Error(result.error.message), { category: result.error.category, nodeId: result.error.nodeId });
      }
      return result.outputEvent.payload as CliCommandTransition;
    },
  });
}

export async function runCliCommandTraining(
  request: CliCommandTrainingRequest,
  resources: CliCommandTrainingResources,
): Promise<CliCommandTrainingReceipt> {
  const diagnostics = { partialPaths: {} as Partial<Record<string, string>> };
  const definitions = createCliCommandTrainingNodes(resources, binding => createCliCommandPolicy(binding), diagnostics);
  const graph = await loadWorkflow({ configPath: configPath("cli-filesystem-training"), allowedRoot });
  const compiled = compileWorkflow(graph, {
    nodeDefinitions: definitions,
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "command_training_request",
    type: "cli.command_training_request.v1",
    payload: request,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message), { category: result.error.category, nodeId: result.error.nodeId, ...diagnostics });
  }
  return result.outputEvent.payload as CliCommandTrainingReceipt;
}
