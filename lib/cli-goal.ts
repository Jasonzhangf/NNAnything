import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type { CompiledWorkflow } from "./core/contracts.js";
import { createWorkflowInputEvent } from "./core/events.js";
import { createCliSession } from "./cli.js";
import { compileWorkflow } from "./workflow/compiler.js";
import { loadWorkflow } from "./workflow/loader.js";
import { runWorkflow } from "./workflow/runner.js";
import {
  validateCliGoalProfile,
  validateCliGoalSession,
  validateCliGoalStepRequest,
  type CliGoalProfile,
  type CliGoalSession,
  type CliGoalStepRequest,
  type CliGoalTransition,
} from "./filters/cli-goal-policy.js";
import {
  createCliGoalStepNodes,
  createCliGoalTrainingNodes,
  readCliGoalTransition,
  type CliGoalTrainingDiagnostics,
  type CliGoalTrainingReceipt,
  type CliGoalTrainingRequest,
  type CliGoalTrainingResources,
} from "./nodes/cli-goal.js";

export * from "./filters/cli-goal-policy.js";
export * from "./training/cli-goal-numeric.js";
export * from "./training/cli-goal-samples.js";
export {
  createCliGoalStepNodes,
  createCliGoalTrainingNodes,
  evaluateCliGoalSamples,
  readCliGoalTransition,
} from "./nodes/cli-goal.js";
export type {
  CliGoalPolicyEvaluation,
  CliGoalPartitionComparison,
  CliGoalTrainingDiagnostics,
  CliGoalTrainingReceipt,
  CliGoalTrainingRequest,
  CliGoalTrainingResources,
} from "./nodes/cli-goal.js";

const configPath = (name: string) => fileURLToPath(new URL(`../workflows/${name}.workflow.json`, import.meta.url));
const allowedRoot = fileURLToPath(new URL("../workflows/", import.meta.url));

export interface CliGoalPolicy {
  step(request: CliGoalStepRequest): Promise<CliGoalTransition>;
}

export function createCliGoalPolicy(options: {
  readonly profile: CliGoalProfile;
  readonly session: CliGoalSession;
}): CliGoalPolicy {
  if (typeof options !== "object" || options === null || Object.keys(options).some(key => key !== "profile" && key !== "session")) {
    throw new TypeError("createCliGoalPolicy needs profile and session only");
  }
  const profile = validateCliGoalProfile(options.profile);
  const session = validateCliGoalSession(options.session);
  const executor = createCliSession({ cwd: session.cwd, grantedEffects: session.grantedEffects });
  let compiled: Promise<CompiledWorkflow> | undefined;
  const getCompiled = () => compiled ??= loadWorkflow({ configPath: configPath("cli-goal-step"), allowedRoot })
    .then(definition => compileWorkflow(definition, {
      nodeDefinitions: createCliGoalStepNodes({ id: session.id, cwd: session.cwd, observe: executor.observe }),
      profiles: { "cli-goal-policy": profile },
    }));
  return Object.freeze({
    async step(request: CliGoalStepRequest): Promise<CliGoalTransition> {
      const validated = validateCliGoalStepRequest(request, session);
      const runId = randomUUID();
      const result = await runWorkflow(await getCompiled(), createWorkflowInputEvent({
        runId,
        eventId: `${runId}:input`,
        port: "goal_step_request",
        type: "cli.goal.step-request.v1",
        payload: validated,
      }));
      if (result.status === "failed") {
        const error = new Error(result.error.message);
        Object.assign(error, { category: result.error.category, nodeId: result.error.nodeId });
        throw error;
      }
      return readCliGoalTransition(result.outputEvent.payload);
    },
  });
}

export async function runCliGoalTraining(
  request: CliGoalTrainingRequest,
  resources: CliGoalTrainingResources,
): Promise<CliGoalTrainingReceipt> {
  if (!resources || typeof resources.handwiredRoot !== "string" || !resources.handwiredRoot.length
    || !isAbsolute(resources.outputRoot) || !Array.isArray(resources.grantedEffects)) {
    throw new TypeError("Explicit backend, absolute outputRoot and grantedEffects are required");
  }
  const diagnostics: CliGoalTrainingDiagnostics = { partialPaths: {} };
  const definitions = createCliGoalTrainingNodes(
    resources,
    (profile, session) => createCliGoalPolicy({ profile, session }),
    diagnostics,
  );
  const definition = await loadWorkflow({ configPath: configPath("cli-goal-training"), allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: definitions,
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "goal_training_request",
    type: "cli.goal.training-request.v1",
    payload: request,
  }));
  if (result.status === "failed") {
    const error = new Error(result.error.message);
    Object.assign(error, {
      category: result.error.category,
      nodeId: result.error.nodeId,
      partialReceipt: diagnostics.partialPaths,
      timing: diagnostics.fitTiming,
      evaluationMs: diagnostics.evaluationMs,
    });
    throw error;
  }
  return result.outputEvent.payload as CliGoalTrainingReceipt;
}
