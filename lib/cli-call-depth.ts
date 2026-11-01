// Slice CD-1 public entry: `runCliCalleeCallGraphGoal`.
//
// The request is the only source of the intended meaning. It binds the target
// session through the caller-supplied sandbox, builds the deterministic state,
// and drives the existing 3N2E recursive-goal controller. All reads flow
// through the adapter; the AST policy is pure and performs no OS access.
import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import type { RecursiveGoalLimits } from "./workflow/recursive-goal/contracts.js";
import type { CliFilesystemSandbox, SessionRef, SessionSnapshot } from "./adapters/cli/filesystem-sandbox.js";
import {
  buildInitialState,
  createCallDepthAdapter,
  createCallDepthDependencies,
} from "./adapters/cli/call-depth-recursive.js";
import {
  CALL_DEPTH_ROOT_EVALUATOR,
  CALL_DEPTH_ROOT_SELECTOR,
  CALL_DEPTH_REQUEST_SCHEMA,
  readCalleeCallGraphGoal,
  type CallDepthRunResult,
  type CallDepthState,
  type CliCalleeCallGraphGoal,
} from "./adapters/cli/call-depth-contract.js";

export type CallDepthResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  limits?: RecursiveGoalLimits;
  signal?: AbortSignal;
  continuation?: unknown;
}>;

function latestState(value: unknown): CallDepthState | null {
  const report = value as {
    report?: { states?: readonly { value?: unknown }[] } | null;
  } | null;
  if (report?.report?.states === undefined) return null;
  const states = report.report.states;
  if (states.length === 0) return null;
  const last = states[states.length - 1]?.value;
  if (last === null || typeof last !== "object") return null;
  return last as CallDepthState;
}

function rootResultOf(value: unknown): Readonly<{
  result: "satisfied" | "unsatisfied" | "unknown" | "not_evaluated";
  satisfaction: number | null;
}> {
  const report = value as {
    report?: {
      rootEvaluation?: {
        state?: unknown;
        result?: unknown;
        satisfaction?: unknown;
      } | null;
      control?: { outcome?: unknown; stopReason?: unknown } | null;
    } | null;
  } | null;
  const evaluation = report?.report?.rootEvaluation;
  if (evaluation === null || evaluation === undefined || evaluation.state !== "evaluated") {
    return Object.freeze({ result: "not_evaluated", satisfaction: null });
  }
  const result = evaluation.result;
  if (result !== "satisfied" && result !== "unsatisfied" && result !== "unknown") {
    return Object.freeze({ result: "not_evaluated", satisfaction: null });
  }
  const satisfaction = typeof evaluation.satisfaction === "number" ? evaluation.satisfaction : null;
  return Object.freeze({ result, satisfaction });
}

function stopOf(value: unknown): Readonly<{ outcome: string | null; stopReason: string | null }> {
  const report = value as {
    report?: { control?: { outcome?: unknown; stopReason?: unknown } | null } | null;
  } | null;
  const control = report?.report?.control;
  return Object.freeze({
    outcome: typeof control?.outcome === "string" ? control.outcome : null,
    stopReason: typeof control?.stopReason === "string" ? control.stopReason : null,
  });
}

function deriveRunResult(
  requestedMaxDepth: CliCalleeCallGraphGoal["maxDepth"],
  response: unknown,
  finalState: CallDepthState | null,
): CallDepthRunResult {
  const root = rootResultOf(response);
  const stop = stopOf(response);
  const budgetStopped = stop.outcome === "exceeded"
    && (stop.stopReason === "budget" || stop.stopReason === "too_many_attempts");
  const interrupted = !budgetStopped && (stop.outcome === "exceeded"
    || stop.outcome === "cancelled"
    || stop.outcome === "stalled"
    || stop.stopReason === "budget"
    || stop.stopReason === "cancel"
    || stop.stopReason === "no_progress");

  let status: CallDepthRunResult["status"];
  let resolution: CallDepthRunResult["resolution"];
  if (budgetStopped) {
    status = "unknown";
    resolution = "budget_exhausted";
  } else if (interrupted) {
    status = "unknown";
    resolution = "interrupted";
  } else if (finalState?.termination !== null && finalState?.termination !== undefined) {
    status = finalState.termination.status;
    resolution = finalState.termination.resolution;
  } else if (root.result === "satisfied") {
    status = "achieved";
    resolution = "complete";
  } else if (root.result === "unsatisfied") {
    status = "unmet";
    resolution = finalState?.entryResolution === "ok" || finalState?.entryResolution === undefined
      ? "entry_not_found"
      : finalState.entryResolution;
  } else if (finalState?.sourceConsistencyFailed === true || finalState?.truncated === true) {
    status = "unknown";
    resolution = "insufficient_evidence";
  } else {
    status = "unknown";
    resolution = "insufficient_evidence";
  }

  const maxDepthOfNodes = finalState === null
    ? 0
    : finalState.nodes.reduce((max, node) => Math.max(max, node.minDepth), 0);
  return Object.freeze({
    status,
    resolution,
    entryNodeId: finalState?.entryNodeId ?? null,
    requestedMaxDepth,
    achievedDepth: maxDepthOfNodes,
    nodes: finalState?.nodes ?? Object.freeze([]),
    edges: finalState?.edges ?? Object.freeze([]),
    unresolvedCallsites: finalState?.unresolvedCallsites ?? Object.freeze([]),
    counters: finalState?.counters ?? Object.freeze({
      filesReadCount: 0,
      initialAstFileReadCalls: 0,
      closureVerifyFileReadCalls: 0,
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
      totalRelaxations: 0,
      closureVerifiedFilesCount: 0,
      sandboxApiCalls: 0,
    }),
    finalState,
    response,
  });
}

export async function runCliCalleeCallGraphGoal(
  rawRequest: unknown,
  resources: CallDepthResources,
): Promise<CallDepthRunResult> {
  // Validate the request before touching any sandbox state.
  const raw = rawRequest as Readonly<Record<string, unknown>> | null;
  const goalValue = raw?.rootGoal ?? raw?.goal ?? raw;
  const goal = readCalleeCallGraphGoal(goalValue);
  const requestId = typeof raw?.requestId === "string" && raw.requestId.length > 0
    ? raw.requestId
    : "cli-call-depth";
  const scopePaths = goal.scopePaths;
  const sessionSnapshot: SessionSnapshot = resources.sandbox.getSession(resources.session);
  const state = buildInitialState(goal, sessionSnapshot, requestId);
  const created = createCallDepthAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
  });
  created.setState(state);
  const response = await runRecursiveGoal(
    {
      schema: CALL_DEPTH_REQUEST_SCHEMA,
      requestId,
      rootGoal: goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: Object.freeze({
          kind: "cli.session" as const,
          scenarioId: resources.session.scenarioId,
          sessionId: resources.session.sessionId,
        }),
        scopePaths,
      }),
      state,
      rootEvaluatorId: CALL_DEPTH_ROOT_EVALUATOR,
      rootSelectorId: CALL_DEPTH_ROOT_SELECTOR,
      ...(resources.limits === undefined ? {} : { limits: resources.limits }),
      ...(resources.continuation === undefined ? {} : { continuation: resources.continuation }),
    },
    createCallDepthDependencies(created, resources.signal),
  );
  const finalState = created.getState() ?? latestState(response);
  return deriveRunResult(goal.maxDepth, response, finalState);
}

export {
  createCliFilesystemSandbox,
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SCENARIO_ID,
  DEFAULT_READ_ONLY_SESSION_ID,
} from "./adapters/cli/filesystem-sandbox.js";
export { readCalleeCallGraphGoal } from "./adapters/cli/call-depth-contract.js";
export type {
  CallDepthRunResult,
  CallDepthState,
  CliCalleeCallGraphGoal,
} from "./adapters/cli/call-depth-contract.js";
