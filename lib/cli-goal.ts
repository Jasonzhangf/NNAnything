import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CompiledWorkflow } from "./core/contracts.js";
import { createWorkflowInputEvent } from "./core/events.js";
import { compileWorkflow } from "./workflow/compiler.js";
import { loadWorkflow } from "./workflow/loader.js";
import { runWorkflow } from "./workflow/runner.js";
import {
  validateCliCommandProfile,
  type CliCommandProfile,
} from "./filters/cli-command-policy.js";
import {
  createEvidenceAuthority,
  validateExplicitFileState,
  type EvidenceAuthority,
} from "./filters/cli-state.js";
import {
  expectedDirectoryOf,
  validateGoal,
  validatePropertyRequest,
} from "./filters/cli-file-property.js";
import {
  classifyCliAutonomousGoal,
  validateContentBytesEqualsGoal,
  validateContentBytesResources,
  type CliAutonomousRequest,
  type CliAutonomousRunResult,
} from "./adapters/cli/autonomous-goal-contract.js";
import {
  ATOMIC_EVALUATOR_ID,
  ATOMIC_SELECTOR_ID,
  ATOMIC_SKILL_ID,
  COMPOSITE_SKILL_ID,
  CONTENT_COMPOSITE_SKILL_ID,
  CONTENT_INSPECT_SKILL_ID,
  CONTENT_READ_SKILL_ID,
  RECURSIVE_REQUEST_SCHEMA,
  ROOT_EVALUATOR_ID,
  ROOT_SELECTOR_ID,
  CONTENT_ROOT_EVALUATOR_ID,
  CONTENT_ROOT_SELECTOR_ID,
  createCliAutonomousAdapter,
  createCliAutonomousDependencies,
} from "./adapters/cli/autonomous-goal-recursive.js";
import {
  emptyCliAutonomousState,
  projectAutonomousSummary,
  trustedInitialState,
  validateAutonomousSession,
} from "./filters/cli-autonomous-goal.js";
import {
  readSemanticCliCall,
  type CliFilesystemSandbox,
  type CliSandboxEffect,
  type DirectoryRef,
  type SemanticCallReceipt,
  type SemanticCliCall,
  type SessionRef,
} from "./adapters/cli/filesystem-sandbox.js";
import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
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
export * from "./adapters/cli/autonomous-goal-contract.js";

const configPath = (name: string) => fileURLToPath(new URL(`../workflows/${name}.workflow.json`, import.meta.url));
const allowedRoot = fileURLToPath(new URL("../workflows/", import.meta.url));

export type CliCommandPolicy = Readonly<{
  step(request: CliCommandRequest): Promise<CliCommandTransition>;
}>;

export function createCliCommandPolicy(
  binding: CliCommandBinding,
  authority?: EvidenceAuthority,
): CliCommandPolicy {
  const profile = validateCliCommandProfile(binding.profile) as CliCommandProfile;
  // Validate the explicit session now; later steps read its current snapshot.
  binding.sandbox.getSession(binding.session);
  const resolvedAuthority: EvidenceAuthority = authority ?? createEvidenceAuthority();
  const definitions = createCliFilePropertyNodes(binding, resolvedAuthority);
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

const OBSERVE_EFFECTS: readonly CliSandboxEffect[] = Object.freeze(["filesystem.read", "process.exec"]);
const READ_ONLY_EFFECTS: readonly CliSandboxEffect[] = Object.freeze(["filesystem.read"]);
const CWD_SET_EFFECTS: readonly CliSandboxEffect[] = Object.freeze([
  "filesystem.read",
  "process.exec",
  "session.write",
]);
const NO_EFFECTS: readonly CliSandboxEffect[] = Object.freeze([]);
const ALL_CLI_EFFECTS: ReadonlySet<string> = new Set([
  "filesystem.read",
  "process.exec",
  "session.write",
]);

function requiredEffectsForOperation(
  operation: SemanticCliCall["operation"],
): readonly CliSandboxEffect[] {
  switch (operation) {
    case "cwd.set":
      return CWD_SET_EFFECTS;
    case "path.resolve":
    case "path.relative":
    case "path.parts":
      return NO_EFFECTS;
    case "file.read":
      return READ_ONLY_EFFECTS;
    case "cwd.get":
    case "directory.list":
    case "entry.inspect":
      return OBSERVE_EFFECTS;
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`Unsupported semantic CLI operation: ${String(exhaustive)}`);
    }
  }
}

function validateGrantedEffects(value: unknown): readonly CliSandboxEffect[] {
  if (value === undefined) {
    throw new TypeError("autonomous goal requires resources.grantedEffects");
  }
  if (!Array.isArray(value) || value.some(effect => !ALL_CLI_EFFECTS.has(effect))) {
    throw new TypeError("grantedEffects must contain only filesystem.read, process.exec and session.write");
  }
  return Object.freeze([...new Set(value)] as CliSandboxEffect[]);
}

function intersect(
  requested: readonly CliSandboxEffect[],
  session: readonly CliSandboxEffect[],
): readonly CliSandboxEffect[] {
  const requestedSet = new Set(requested);
  return Object.freeze(session.filter(effect => requestedSet.has(effect)));
}

function sessionRefOf(ref: Readonly<{ scenarioId: string; sessionId: string }>): SessionRef {
  return Object.freeze({
    kind: "cli.session",
    scenarioId: ref.scenarioId,
    sessionId: ref.sessionId,
  });
}

function sessionOfSemanticCall(call: SemanticCliCall): SessionRef {
  if (call.operation === "cwd.get" || call.operation === "cwd.set" || call.operation === "directory.list") {
    return call.parameters.session;
  }
  if (call.operation === "path.resolve") return sessionRefOf(call.parameters.base);
  if (call.operation === "path.relative") return sessionRefOf(call.parameters.from);
  if (call.operation === "path.parts") return sessionRefOf(call.parameters.path);
  return sessionRefOf(call.parameters.ref);
}

function narrowSandbox(
  sandbox: CliFilesystemSandbox,
  allowed: readonly CliSandboxEffect[],
): CliFilesystemSandbox {
  const granted = new Set(allowed);
  return Object.freeze({
    ...sandbox,
    async execute(value: unknown): Promise<SemanticCallReceipt> {
      const call = readSemanticCliCall(value);
      const missing = requiredEffectsForOperation(call.operation)
        .filter(effect => !granted.has(effect));
      if (missing.length === 0) return sandbox.execute(call);
      const before = sandbox.getSession(sessionOfSemanticCall(call));
      return Object.freeze({
        call,
        status: "failed",
        session_before: before,
        session_after: before,
        execution: Object.freeze({
          status: "failed",
          runId: randomUUID(),
          executorInvoked: false,
          error: Object.freeze({
            operation: call.operation,
            stage: "authorize",
            code: "EFFECT_DENIED",
            message: `Missing CLI effect grant: ${missing.join(", ")}`,
          }),
        }),
      });
    },
  });
}

const DEFAULT_AUTONOMOUS_LIMITS = Object.freeze({
  maxTransitions: 20,
  maxDepth: 4,
  maxDerivedGoals: 8,
});

function readEnabledSkills(
  value: readonly string[] | undefined,
  content: boolean,
): readonly string[] {
  const allowed = content
    ? [ATOMIC_SKILL_ID, COMPOSITE_SKILL_ID, CONTENT_COMPOSITE_SKILL_ID, CONTENT_INSPECT_SKILL_ID, CONTENT_READ_SKILL_ID]
    : [ATOMIC_SKILL_ID, COMPOSITE_SKILL_ID];
  if (value === undefined) {
    return Object.freeze(content
      ? [ATOMIC_SKILL_ID, CONTENT_COMPOSITE_SKILL_ID, CONTENT_INSPECT_SKILL_ID, CONTENT_READ_SKILL_ID]
      : [ATOMIC_SKILL_ID, COMPOSITE_SKILL_ID]);
  }
  if (!Array.isArray(value) || value.some(skill => !allowed.includes(skill))) {
    throw new TypeError(`enabledSkills must contain only ${allowed.join(", ")}`);
  }
  return Object.freeze([...new Set(value)]);
}

function isSandboxEscape(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "SANDBOX_ESCAPE";
}

type TargetScope = "inside" | "outside" | "unresolvable";

function isUnresolvableTarget(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isStaleScopeRef(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error.code === "EINVAL" || error.code === "binding_identity_missing";
  }
  // validateDirectoryRef rejects an unknown session with a plain TypeError and no code.
  // That is still an unusable reference, so it is projected as a stale scope instead of escaping.
  return error instanceof TypeError;
}

// Summarize the real native failure for evidence without faking a success.
function staleScopeDetail(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  return `content scope rejected by validateDirectoryRef: ${code} ${message}`;
}

// Probe only the path containment/existence of a scope, ignoring trust/revision
// so an unissued/stale reference keeps its original outside/unresolvable reason.
async function classifyScopePath(
  sandbox: CliAutonomousRequest["resources"]["sandbox"],
  scope: unknown,
): Promise<TargetScope> {
  try {
    await sandbox.resolveDirectory(scope as DirectoryRef);
    return "inside";
  } catch (error) {
    if (isSandboxEscape(error)) return "outside";
    if (isUnresolvableTarget(error)) return "unresolvable";
    return "inside";
  }
}

async function targetScope(
  sandbox: CliAutonomousRequest["resources"]["sandbox"],
  goal: ReturnType<typeof validateGoal>["goal"],
): Promise<TargetScope> {
  const directory = expectedDirectoryOf(goal);
  if (directory === null) return "inside";
  try {
    await sandbox.resolveDirectory(directory);
    return "inside";
  } catch (error) {
    if (isSandboxEscape(error)) return "outside";
    if (isUnresolvableTarget(error)) return "unresolvable";
    throw error;
  }
}

export async function runCliAutonomousGoal(request: CliAutonomousRequest): Promise<CliAutonomousRunResult> {
  if (typeof request !== "object" || request === null
    || typeof request.resources !== "object" || request.resources === null) {
    throw new TypeError("autonomous goal request must contain resources");
  }
  const family = classifyCliAutonomousGoal(request.goal);
  if (family === "content_bytes_equals") {
    return runContentBytesGoal(request);
  }
  const goal = validateGoal(request.goal).goal;
  const sourceSandbox = request.resources.sandbox;
  const session = validateAutonomousSession(request.resources.session, sourceSandbox);
  const sessionSnapshot = sourceSandbox.getSession(session);
  const requested = validateGrantedEffects(request.resources.grantedEffects);
  const allowed = intersect(requested, sessionSnapshot.grantedEffects);
  const sandbox = narrowSandbox(sourceSandbox, allowed);
  const enabledSkills = readEnabledSkills(request.resources.enabledSkills, false);
  const authority = request.resources.authority ?? createEvidenceAuthority();
  let state = emptyCliAutonomousState(session.sessionId);
  let initialTrusted = false;
  let initialStateStatus: "absent" | "trusted" | "untrusted" = "absent";
  if (request.resources.initialState !== undefined) {
    const validated = validateExplicitFileState(request.resources.initialState);
    if (validated.session !== session.sessionId) {
      throw new TypeError("initial state must belong to the bound session");
    }
    state = validated;
    if (request.resources.authority !== undefined) {
      const trusted = trustedInitialState(
        sandbox,
        session,
        validated,
        request.resources.authority,
      );
      initialTrusted = trusted !== null && trusted.cwdObservation !== null;
    }
    // Without an authority there is no evidence that the caller's observation is fresh,
    // so the state is kept but never treated as trusted evidence.
    initialStateStatus = initialTrusted ? "trusted" : "untrusted";
  }
  validatePropertyRequest({ goal, satisfactionThreshold: 100, state }, session);

  const requestView = Object.freeze({ goal, grantedEffects: allowed, enabledSkills });
  const scope = await targetScope(sandbox, goal);
  if (scope !== "inside") {
    const projected = projectAutonomousSummary({
      family,
      steps: Object.freeze([]),
      response: null,
      state,
      authority,
      initialStateStatus,
    });
    return Object.freeze({
      request: requestView,
      response: null,
      domain: Object.freeze({
        ...projected,
        status: "rejected" as const,
        reason: scope === "outside" ? "path_outside_workspace" as const : "target_unresolvable" as const,
      }),
    });
  }

  const profile = request.resources.profile;
  if (profile === undefined) {
    throw new TypeError("autonomous goal requires an explicit command profile; no candidate default is allowed");
  }
  const created = createCliAutonomousAdapter({
    sandbox,
    session,
    profile,
    authority,
    initialState: state,
  });
  const requestId = randomUUID();
  const rootFrameId = `${requestId}:root`;
  const compositeRoot = family === "session_cwd_equals";
  const response = await runRecursiveGoal({
    schema: RECURSIVE_REQUEST_SCHEMA,
    requestId,
    rootGoal: goal,
    satisfactionThreshold: 100,
    rootBindings: Object.freeze({ session, initialTrusted }),
    state: Object.freeze({
      stateId: `${rootFrameId}:state:initial`,
      session: sandbox.getSession(session),
      cli: state,
    }),
    rootEvaluatorId: compositeRoot ? ROOT_EVALUATOR_ID : ATOMIC_EVALUATOR_ID,
    rootSelectorId: compositeRoot ? ROOT_SELECTOR_ID : ATOMIC_SELECTOR_ID,
    limits: Object.freeze({
      ...DEFAULT_AUTONOMOUS_LIMITS,
      ...(request.resources.budget ?? {}),
    }),
  }, createCliAutonomousDependencies(created, allowed, enabledSkills));
  const finalState = created.lastState ?? state;
  return Object.freeze({
    request: requestView,
    response,
    domain: projectAutonomousSummary({
      family,
      steps: created.steps,
      response,
      state: finalState,
      authority,
      initialStateStatus,
    }),
  });
}

async function runContentBytesGoal(request: CliAutonomousRequest): Promise<CliAutonomousRunResult> {
  const goal = validateContentBytesEqualsGoal(request.goal);
  const { scope, fileName } = validateContentBytesResources(request.resources);
  const sourceSandbox = request.resources.sandbox;
  const session = validateAutonomousSession(request.resources.session, sourceSandbox);
  const sessionSnapshot = sourceSandbox.getSession(session);
  const requested = validateGrantedEffects(request.resources.grantedEffects);
  const allowed = intersect(requested, sessionSnapshot.grantedEffects);
  const sandbox = narrowSandbox(sourceSandbox, allowed);
  const authority = request.resources.authority ?? createEvidenceAuthority();
  const state = emptyCliAutonomousState(session.sessionId);
  const enabledSkills = readEnabledSkills(request.resources.enabledSkills, true);
  const requestView = Object.freeze({
    goal,
    grantedEffects: allowed,
    enabledSkills,
  });

  // Blocking A: the content scope must be a trusted, current directory reference
  // before resolution. Validation runs first, but an unissued/stale reference is
  // still classified by path when it is outside or missing so the existing
  // path_outside_workspace / target_unresolvable semantics are preserved.
  let resolution: TargetScope;
  let staleError: unknown = undefined;
  try {
    await sandbox.validateDirectoryRef(scope);
    await sandbox.resolveDirectory(scope);
    resolution = "inside";
  } catch (error) {
    if (isSandboxEscape(error)) resolution = "outside";
    else if (isUnresolvableTarget(error)) resolution = "unresolvable";
    else if (isStaleScopeRef(error)) {
      const classification = await classifyScopePath(sandbox, scope);
      resolution = classification === "outside" || classification === "unresolvable"
        ? classification
        : "inside";
      staleError = classification !== "outside" && classification !== "unresolvable" ? error : undefined;
    } else throw error;
  }
  if (staleError !== undefined) {
    const projected = projectAutonomousSummary({
      family: "content_bytes_equals",
      steps: Object.freeze([]),
      response: null,
      state,
      authority,
    });
    return Object.freeze({
      request: requestView,
      response: null,
      domain: Object.freeze({
        ...projected,
        status: "rejected" as const,
        reason: "stale_scope" as const,
        reasonDetail: staleScopeDetail(staleError),
      }),
    });
  }
  if (resolution !== "inside") {
    const projected = projectAutonomousSummary({
      family: "content_bytes_equals",
      steps: Object.freeze([]),
      response: null,
      state,
      authority,
    });
    return Object.freeze({
      request: requestView,
      response: null,
      domain: Object.freeze({
        ...projected,
        status: "rejected" as const,
        reason: resolution === "outside" ? "path_outside_workspace" as const : "target_unresolvable" as const,
      }),
    });
  }

  const required = ["filesystem.read", "process.exec"] as const;
  if (required.some(effect => !allowed.includes(effect))) {
    const projected = projectAutonomousSummary({
      family: "content_bytes_equals",
      steps: Object.freeze([]),
      response: null,
      state,
      authority,
    });
    return Object.freeze({
      request: requestView,
      response: null,
      domain: Object.freeze({ ...projected, status: "rejected" as const, reason: "permission_denied" as const }),
    });
  }

  const profile = request.resources.profile;
  if (profile === undefined) {
    throw new TypeError("autonomous goal requires an explicit command profile; no candidate default is allowed");
  }

  const created = createCliAutonomousAdapter({
    sandbox,
    session,
    profile,
    authority,
    initialState: state,
  });
  const requestId = randomUUID();
  const rootFrameId = `${requestId}:root`;
  const response = await runRecursiveGoal({
    schema: RECURSIVE_REQUEST_SCHEMA,
    requestId,
    rootGoal: goal,
    satisfactionThreshold: 100,
    rootBindings: Object.freeze({ scope, fileName }),
    state: Object.freeze({
      stateId: `${rootFrameId}:state:initial`,
      session: sandbox.getSession(session),
      cli: state,
    }),
    rootEvaluatorId: CONTENT_ROOT_EVALUATOR_ID,
    rootSelectorId: CONTENT_ROOT_SELECTOR_ID,
    limits: Object.freeze({
      ...DEFAULT_AUTONOMOUS_LIMITS,
      ...(request.resources.budget ?? {}),
    }),
  }, createCliAutonomousDependencies(created, allowed, enabledSkills));
  const finalState = created.lastState ?? state;
  const readReceipt = created.readReceipts[0] ?? null;

  return Object.freeze({
    request: requestView,
    response,
    domain: projectAutonomousSummary({
      family: "content_bytes_equals",
      steps: created.steps,
      response,
      state: finalState,
      authority,
      readReceipt,
      contentFileName: fileName,
    }),
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
