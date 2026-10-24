import type {
  CliReadReceipt,
  CliAutonomousStepRecord,
  CliAutonomousSummary,
} from "../adapters/cli/autonomous-goal-contract.js";
import type { CliFilesystemSandbox, SessionRef } from "../adapters/cli/filesystem-sandbox.js";
import {
  validateSessionRef,
  type CwdGoal,
  type FilePropertyGoal,
} from "./cli-file-property.js";
import {
  validateExplicitFileState,
  type EvidenceAuthority,
  type ExplicitFileState,
} from "./cli-state.js";
import type { CliCommandPolicyError, CliCommandTransition } from "../nodes/cli-command.js";

export function emptyCliAutonomousState(sessionId: string): ExplicitFileState {
  return Object.freeze({ session: sessionId, cwdObservation: null, directoryListing: null });
}

export function validateAutonomousSession(value: unknown, sandbox: CliFilesystemSandbox): SessionRef {
  const session = validateSessionRef(value, "autonomous goal session");
  sandbox.getSession(session);
  return session;
}

/** Returns the validated state only when every non-null knowledge record is trusted at the current revision. */
export function trustedInitialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  initialState: ExplicitFileState,
  authority: EvidenceAuthority,
): ExplicitFileState | null {
  const state = validateExplicitFileState(initialState);
  if (state.session !== session.sessionId) throw new TypeError("initial state must belong to the bound session");
  const revision = sandbox.getSession(session).revision;
  let trusted = true;
  if (state.cwdObservation !== null) {
    const knowledge = state.cwdObservation;
    trusted = trusted && knowledge.revision === revision && authority.trusted({
      kind: "pwd",
      session: session.sessionId,
      revision: knowledge.revision,
      runId: knowledge.sourceRun,
      observation: knowledge.evidence,
    });
  }
  if (state.directoryListing !== null) {
    const knowledge = state.directoryListing;
    trusted = trusted && knowledge.revision === revision && authority.trusted({
      kind: "directory.list",
      session: session.sessionId,
      revision: knowledge.revision,
      runId: knowledge.sourceRun,
      observation: knowledge.evidence,
    });
  }
  return trusted ? state : null;
}

export function failureCodeOf(transition: CliCommandTransition): string | null {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "failed") return null;
  return receipt.execution.error.code;
}

function stepStatus(transition: CliCommandTransition): CliAutonomousStepRecord["status"] {
  if (transition.status === "achieved") return "satisfied";
  if (transition.status === "rejected") return "rejected";
  if (transition.status === "failed") return "failed";
  if (transition.reason === "binding_unresolved") return "deferred";
  if (transition.reason === "unsupported_property") return "rejected";
  return "progressed";
}

function stepPhase(goal: FilePropertyGoal): string {
  if (goal.property === "file.property.relation.sessionCwd") {
    return (goal as CwdGoal).requirement.kind === "observed" ? "observe_cwd" : "ensure_cwd";
  }
  if (goal.property === "file.property.directory.entries") return "list_directory";
  if (goal.property === "file.property.exists"
    || goal.property === "file.property.type"
    || goal.property === "file.property.size"
    || goal.property === "file.property.mode"
    || goal.property === "file.property.owner"
    || goal.property === "file.property.times"
    || goal.property === "file.property.link.target"
    || goal.property === "file.property.entry.identity") return "inspect_entry";
  if (goal.property.startsWith("file.property.path.")) return "path";
  return "unsupported";
}

function stepReason(transition: CliCommandTransition): string {
  const failureCode = failureCodeOf(transition);
  if (failureCode === "EFFECT_DENIED") return "permission_denied";
  if (failureCode === "SANDBOX_ESCAPE") return "path_outside_workspace";
  if (failureCode === "binding_identity_missing" || failureCode === "STALE_REFERENCE") return "object_changed";
  return transition.reason;
}

export function buildStepRecord(transition: CliCommandTransition, index: number): CliAutonomousStepRecord {
  const requiredHead = typeof transition.evidence.requiredHead === "string" ? transition.evidence.requiredHead : null;
  return Object.freeze({
    stepIndex: index,
    phase: stepPhase(transition.goal),
    goalProperty: transition.goal.property,
    decisionMechanism: "trained_policy_v1" as const,
    expectedHead: requiredHead,
    selectedHead: transition.policy.selectedHead,
    operation: transition.invocation?.[0] ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    status: stepStatus(transition),
    reason: stepReason(transition),
    policyError: transition.policy_error,
  });
}

export function isPolicyError(error: CliCommandPolicyError | null): error is CliCommandPolicyError {
  return error !== null;
}

export function projectAutonomousSummary(input: {
  family: CliAutonomousSummary["family"];
  steps: readonly CliAutonomousStepRecord[];
  response: unknown;
  state: ExplicitFileState;
  authority: EvidenceAuthority;
  outcome?: Readonly<{ status: CliAutonomousSummary["status"]; reason: string }>;
  readReceipt?: CliReadReceipt | null;
  reasonDetail?: string | null;
  initialStateStatus?: CliAutonomousSummary["initialStateStatus"];
  contentFileName?: string | null;
}): CliAutonomousSummary {
  const {
    family, steps, response, state, authority, outcome, readReceipt, reasonDetail,
    initialStateStatus = "absent", contentFileName,
  } = input;
  const executorInvocationCount = steps.reduce((total, step) => total + (step.executorInvoked ? 1 : 0), 0);
  const policyStepCount = steps.reduce(
    (total, step) => total + (step.decisionMechanism === "trained_policy_v1" ? 1 : 0),
    0,
  );
  const policyError = steps.map(step => step.policyError).find(isPolicyError) ?? null;

  let status: CliAutonomousSummary["status"] = "failed";
  let reason = "failed";
  if (outcome !== undefined) {
    status = outcome.status;
    reason = outcome.reason;
  } else {
    const unsupported = steps.find(step => step.reason === "unsupported_property");
    const permission = steps.find(step => step.reason === "permission_denied");
    const rejected = steps.find(step => step.status === "rejected");
    const deferred = steps.find(step => step.status === "deferred");
    const failed = steps.find(step => step.status === "failed");
    const objectChanged = failed !== undefined
      && (failed.reason === "object_changed"
        || failed.reason === "STALE_REFERENCE"
        || failed.reason === "READ_TARGET_CHANGED");
    if (policyError !== null) {
      status = "rejected";
      reason = "unexpected_head";
    } else if (unsupported !== undefined) {
      status = "rejected";
      reason = "unsupported_property";
    } else if (permission !== undefined) {
      status = "rejected";
      reason = "permission_denied";
    } else if (rejected !== undefined) {
      status = "rejected";
      reason = rejected.reason;
    } else if (deferred !== undefined) {
      status = "deferred";
      reason = deferred.reason;
    } else if (isRunResult(response) && response.report.rootEvaluation.state === "evaluated"
      && response.report.rootEvaluation.result === "satisfied") {
      status = "satisfied";
      reason = "satisfied";
    } else if (objectChanged) {
      status = "failed";
      reason = "object_changed";
    } else if (family === "content_bytes_equals"
      && readReceipt !== null
      && isRunResult(response)
      && response.report.rootEvaluation.state === "evaluated"
      && response.report.rootEvaluation.result === "unsatisfied") {
      status = "failed";
      reason = "content_mismatch";
    } else if (failed !== undefined) {
      status = "failed";
      reason = failed.reason;
    } else if (isRunResult(response) && response.report.control.stopReason === "budget") {
      status = "failed";
      reason = "budget_exhausted";
    } else if (family === "content_bytes_equals" && state.directoryListing !== null) {
      const listing = state.directoryListing;
      const candidates = listing.coverage !== "complete"
        ? []
        : contentFileName === undefined || contentFileName === null
          ? listing.entries.filter(entry => entry.type === "file")
          : listing.entries.filter(entry => entry.name === contentFileName);
      if (candidates.length > 1) {
        status = "deferred";
        reason = "candidate_ambiguous";
      } else if (candidates.length === 0) {
        status = "rejected";
        reason = "candidate_missing";
      } else if (state.entryKnowledge !== undefined
        && state.entryKnowledge !== null
        && state.entryKnowledge.entryExists === true
        && state.entryKnowledge.type !== null
        && state.entryKnowledge.type !== "regular") {
        status = "rejected";
        reason = "candidate_not_regular";
      }
    } else if (isResponseKind(response, "request_rejected")) {
      status = "rejected";
      reason = "request_rejected";
    }
  }

  const cwdObservation = state.cwdObservation === null
    ? null
    : Object.freeze({
        logicalCwd: state.cwdObservation.evidence.configuredCwd,
        physicalCwd: state.cwdObservation.physicalCwd,
      });
  const directoryListing = state.directoryListing === null
    ? null
    : Object.freeze({
        path: state.directoryListing.physicalDirectory,
        entries: Object.freeze(state.directoryListing.entries.map(entry => Object.freeze({
          name: entry.name,
          path: entry.path,
          type: entry.type,
        }))),
        directoryRef: null,
      });
  const noopSatisfied = status === "satisfied"
    && executorInvocationCount === 0
    && steps.length === 1
    && steps[0]?.selectedHead === "NOOP";

  return Object.freeze({
    family,
    status,
    reason,
    reasonDetail: reasonDetail ?? null,
    initialStateStatus,
    noopSatisfied,
    steps,
    executorInvocationCount,
    policyStepCount,
    cwdObservation,
    directoryListing,
    state,
    authority,
    policyError,
    readReceipt: readReceipt ?? null,
  });
}

function isRunResult(value: unknown): value is {
  report: {
    rootEvaluation: { state: string; result?: string };
    control: { stopReason: string };
  };
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "run_result" && typeof record.report === "object" && record.report !== null;
}

function isResponseKind(value: unknown, kind: string): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === kind;
}
