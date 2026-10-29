import type { NodeDefinition } from "../core/contracts.js";
import { expectRecord } from "../core/schema.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  EntryInspectObservation,
  PathPartsCallObservation,
  PathRealpathObservation,
  PathRelativeObservation,
  PathResolveObservation,
  SessionRef,
  SessionSnapshot,
  SemanticCallReceipt,
} from "../adapters/cli/filesystem-sandbox.js";
import type { DirectoryListObservation } from "../adapters/cli/directory-listing.js";
import type { PwdObservation } from "../adapters/cli/observation.js";
import {
  computePropertyFacts,
  expectedDirectoryOf,
  isResolvedTargetGoal,
  requiredHead,
  validatePropertyRequest,
  type CwdGoal,
  type EntryInspectQuery,
  type FilePropertyGoal,
  type InspectGoal,
  type InspectRef,
  type PathAbsoluteGoal,
  type PathPhysicalGoal,
  type PathPartsGoal,
  type PathRef,
  type PathRelativeGoal,
  type PropertyFacts,
  type PropertyRequest,
  type ResolvedTargetGoal,
  type ValidatedPropertyRequest,
} from "../filters/cli-file-property.js";
import {
  predictCliCommand,
  validateCliCommandProfile,
  type CliCommandHead,
  type CliCommandPrediction,
  type CliCommandProfile,
} from "../filters/cli-command-policy.js";
import {
  createEvidenceAuthority,
  type CwdKnowledge,
  type DirectoryKnowledge,
  type EntryKnowledge,
  type EvidenceAuthority,
  type ExplicitFileState,
  type PathKnowledge,
} from "../filters/cli-state.js";

export type CliCommandRequest = PropertyRequest;
export type CliCommandStatus = "achieved" | "unmet" | "unknown" | "rejected" | "failed";
export type CliCommandExecutionStatus = "succeeded" | "failed" | "unsupported" | "deferred" | "noop" | "rejected";
export type CliCommandInvocation =
  | readonly ["pwd"]
  | readonly ["cd" | "ls", DirectoryRef]
  | readonly ["path.resolve", PathRef, string]
  | readonly ["path.relative", PathRef, PathRef]
  | readonly ["path.parts", PathRef]
  | readonly ["path.realpath", InspectRef]
  | readonly ["entry.inspect", InspectRef, boolean];

export type CliCommandPolicyError = Readonly<{ expectedHead: CliCommandHead; selectedHead: CliCommandHead }>;
export type CliCommandDefer = Readonly<{ code: "binding_unresolved"; detail: string }>;
export type CliCommandCollectionResult =
  | Readonly<{ status: "not_configured" }>
  | Readonly<{ status: "saved" }>
  | Readonly<{ status: "failed"; error: string }>;

export type CliCommandExecutionResult = Readonly<{
  status: CliCommandExecutionStatus;
  executorInvoked: boolean;
  receipt: SemanticCallReceipt | null;
  reason: string;
  error: string | null;
}>;

export type CliCommandPostcondition = Readonly<{ receipt: SemanticCallReceipt; matchedTarget: boolean }>;

export type CliCommandAction = Readonly<{
  kind: CliCommandHead;
  session: SessionRef | null;
  directory: DirectoryRef | null;
  path: PathRef | null;
  from: PathRef | null;
  to: PathRef | null;
  input: string | null;
  ref: InspectRef | null;
  followSymlinks: boolean | null;
}>;

export type CliCommandGoalResult = Readonly<{
  status: CliCommandStatus;
  satisfaction: 0 | 100 | null;
  reason: string;
  changed: boolean;
}>;

export type CliCommandTransition = Readonly<{
  goal: FilePropertyGoal;
  satisfactionThreshold: number;
  state_before: ExplicitFileState;
  action: CliCommandAction;
  invocation: CliCommandInvocation | null;
  policy: CliCommandPrediction;
  policy_error: CliCommandPolicyError | null;
  execution_result: CliCommandExecutionResult;
  session_before: SessionSnapshot;
  session_after: SessionSnapshot;
  observed_state_after: ExplicitFileState;
  postcondition: CliCommandPostcondition | null;
  satisfaction: 0 | 100 | null;
  status: CliCommandStatus;
  reason: string;
  changed: boolean;
  evidence: Readonly<Record<string, unknown>>;
  collection_result: CliCommandCollectionResult;
  defer: CliCommandDefer | null;
}>;

export type CliCommandSample = Readonly<{
  goal: FilePropertyGoal;
  satisfactionThreshold: number;
  state_before: ExplicitFileState;
  action: CliCommandAction;
  invocation: CliCommandInvocation | null;
  policy: CliCommandPrediction;
  policy_error: CliCommandPolicyError | null;
  execution_result: CliCommandExecutionResult;
  observed_state_after: ExplicitFileState;
  satisfaction: 0 | 100 | null;
  status: CliCommandStatus;
  reason: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type CliCommandBinding = Readonly<{
  profile: CliCommandProfile;
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

type BoundContext = Readonly<{
  request: ValidatedPropertyRequest;
  session: SessionRef;
  session_before: SessionSnapshot;
  expectedPhysical: string | null;
  bindingError: string | null;
  registered: boolean;
  unboundDirectory: boolean;
}>;

type SelectedContext = BoundContext & Readonly<{
  facts: PropertyFacts;
  requiredHead: CliCommandHead;
  policy: CliCommandPrediction;
  policy_error: CliCommandPolicyError | null;
}>;

type ExecutedContext = SelectedContext & Readonly<{
  invocation: CliCommandInvocation | null;
  call: SemanticCallReceipt["call"] | null;
  receipt: SemanticCallReceipt | null;
  execution_result: CliCommandExecutionResult;
  session_after: SessionSnapshot;
}>;

type ObservedContext = ExecutedContext & Readonly<{
  observed_state_after: ExplicitFileState;
  postcondition: CliCommandPostcondition | null;
  changed: boolean;
}>;

type EvaluatedContext = ObservedContext & Readonly<{
  satisfaction: 0 | 100 | null;
  status: CliCommandStatus;
  reason: string;
  evidence: Readonly<Record<string, unknown>>;
  defer: CliCommandDefer | null;
}>;

const port = (name: string, eventType: string) => ({ name, schemaId: eventType, eventType, validate: (value: unknown) => expectRecord(value, eventType) });

const bindPort = port("file_property_request", "cli.file_property_request.v1");
const contextPort = port("file_property_context", "cli.file_property_context.v1");
const proposalPort = port("file_property_action_proposal", "cli.file_property_action_proposal.v1");
const executionPort = port("file_property_execution", "cli.file_property_execution.v1");
const transitionPort = port("file_property_transition", "cli.file_property_transition.v1");
const evaluationPort = port("file_property_evaluation", "cli.file_property_evaluation.v1");
const resultPort = port("file_property_result", "cli.file_property_result.v1");

function unchanged(before: SessionSnapshot, after: SessionSnapshot): boolean {
  return before.cwd === after.cwd && before.revision === after.revision;
}

function changed(before: SessionSnapshot, after: SessionSnapshot): boolean {
  return !unchanged(before, after);
}

function actionOf(selectedHead: CliCommandHead, session: SessionRef, goal: FilePropertyGoal): CliCommandAction {
  const directory = selectedHead === "cd" || selectedHead === "ls" ? expectedDirectoryOf(goal) : null;
  const pathGoal = goal.property === "file.property.path.parent" || goal.property === "file.property.path.name"
    ? selectedHead === "path.parts" ? goal as PathPartsGoal : null
    : null;
  const absoluteGoal = goal.property === "file.property.path.absolute" && selectedHead === "path.resolve"
    ? goal as PathAbsoluteGoal
    : null;
  const relativeGoal = goal.property === "file.property.path.relative" && selectedHead === "path.relative"
    ? goal as PathRelativeGoal
    : null;
  const physicalGoal = goal.property === "file.property.path.physical" && selectedHead === "path.realpath"
    ? goal as PathPhysicalGoal
    : null;
  const inspect = goal.requirement.kind === "observed" && (goal.property === "file.property.exists"
    || goal.property === "file.property.type"
    || goal.property === "file.property.size"
    || goal.property === "file.property.mode"
    || goal.property === "file.property.owner"
    || goal.property === "file.property.times"
    || goal.property === "file.property.link.target"
    || goal.property === "file.property.entry.identity")
    ? selectedHead === "entry.inspect" ? goal as InspectGoal : null
    : null;
  const resolvedTarget = isResolvedTargetGoal(goal)
    && selectedHead === "entry.inspect"
    ? goal as ResolvedTargetGoal
    : null;
  const inspectTarget = inspect?.target ?? resolvedTarget?.target ?? null;
  return Object.freeze({
    kind: selectedHead,
    session: ["pwd", "cd", "path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect"].includes(selectedHead) ? session : null,
    directory,
    path: pathGoal?.target ?? absoluteGoal?.target.base ?? relativeGoal?.target.from
      ?? (physicalGoal?.target.kind === "cli.path" ? physicalGoal.target : null),
    from: relativeGoal?.target.from ?? null,
    to: relativeGoal?.target.to ?? null,
    input: absoluteGoal?.target.input ?? null,
    ref: inspectTarget?.ref ?? null,
    followSymlinks: inspectTarget?.followSymlinks ?? null,
  });
}

function cwdKnowledge(observation: PwdObservation, revision: number, sourceRun: string): CwdKnowledge {
  return Object.freeze({ physicalCwd: observation.physicalCwd, evidence: observation, revision, sourceRun });
}

function directoryKnowledge(observation: DirectoryListObservation, revision: number, sourceRun: string): DirectoryKnowledge {
  if (observation.coverage !== "complete" || observation.errors.length !== 0 || observation.entries.some(entry => entry.type === "unknown")) {
    throw new TypeError("Only complete typed directory listings can become knowledge");
  }
  return Object.freeze({
    physicalDirectory: observation.physicalDirectory,
    entries: observation.entries,
    coverage: "complete",
    errors: Object.freeze([]),
    evidence: observation,
    revision,
    sourceRun,
  });
}

function pathKnowledge(
  observation: PathResolveObservation | PathRelativeObservation | PathPartsCallObservation | PathRealpathObservation,
  revision: number,
  sourceRun: string,
): PathKnowledge {
  if (observation.kind === "path.resolve") {
    return Object.freeze({
      kind: "path.resolve",
      base: observation.base,
      input: observation.input,
      absolutePath: observation.absolute,
      parent: observation.parent,
      sourceRun,
      sessionRevision: revision,
    });
  }
  if (observation.kind === "path.relative") {
    return Object.freeze({
      kind: "path.relative",
      from: observation.from,
      to: observation.to,
      relativePath: observation.relative,
      sourceRun,
      sessionRevision: revision,
    });
  }
  if (observation.kind === "path.realpath") {
    return Object.freeze({
      kind: "path.realpath",
      ref: observation.ref as InspectRef,
      physicalPath: observation.snapshot.physicalPath,
      entryExists: observation.snapshot.entryExists,
      resolvedTargetExists: observation.snapshot.resolvedTargetExists,
      resolvedIdentity: observation.snapshot.resolvedIdentity,
      errno: observation.snapshot.errno,
      sourceRun,
      sessionRevision: revision,
    });
  }
  return Object.freeze({
    kind: "path.parts",
    path: observation.path,
    parent: observation.parent,
    name: observation.name,
    isRoot: observation.isRoot,
    sourceRun,
    sessionRevision: revision,
  });
}

function entryKnowledge(
  query: EntryInspectQuery,
  observation: EntryInspectObservation,
  revision: number,
  sourceRun: string,
): EntryKnowledge {
  const snapshot = observation.snapshot;
  const owner = snapshot.uid === null || snapshot.gid === null
    ? null
    : Object.freeze({ uid: snapshot.uid, gid: snapshot.gid });
  const times = [snapshot.atimeMs, snapshot.mtimeMs, snapshot.ctimeMs, snapshot.birthtimeMs].every(value => value === null)
    ? null
    : Object.freeze({
        atimeMs: snapshot.atimeMs,
        mtimeMs: snapshot.mtimeMs,
        ctimeMs: snapshot.ctimeMs,
        birthtimeMs: snapshot.birthtimeMs,
      });
  return Object.freeze({
    kind: "entry.inspect",
    query,
    absolutePath: observation.configuredPath,
    observedWith: snapshot.observedWith,
    entryExists: snapshot.entryExists,
    resolvedTargetExists: snapshot.resolvedTargetExists,
    type: snapshot.kind,
    size: snapshot.size,
    mode: snapshot.mode,
    owner,
    times,
    linkTarget: snapshot.linkTarget,
    identity: Object.freeze({
      dev: snapshot.dev,
      ino: snapshot.ino,
      nlink: snapshot.nlink,
      rdev: snapshot.rdev,
    }),
    errno: snapshot.errno,
    sourceRun,
    sessionRevision: revision,
  });
}

function executionResult(
  status: CliCommandExecutionStatus,
  reason: string,
  receipt: SemanticCallReceipt | null = null,
  executorInvoked = false,
  error: string | null = null,
): CliCommandExecutionResult {
  return Object.freeze({ status, executorInvoked, receipt, reason, error });
}

function failureCode(receipt: SemanticCallReceipt | null): string | null {
  return receipt?.execution.status === "failed" ? receipt.execution.error.code : null;
}

function receiptExecutionStatus(receipt: SemanticCallReceipt): CliCommandExecutionStatus {
  if (receipt.execution.status === "succeeded") return "succeeded";
  const error = receipt.execution.error;
  if (error.code === "EFFECT_DENIED" || error.code === "SANDBOX_ESCAPE" || error.code === "STALE_REFERENCE" || error.code === "EINVAL") {
    return "rejected";
  }
  return "failed";
}

type InspectProjection =
  | Readonly<{ state: "known"; value: unknown }>
  | Readonly<{ state: "inapplicable" }>
  | Readonly<{ state: "missing"; errno: string | null }>;

function inspectProjection(goal: InspectGoal, observation: EntryInspectObservation): InspectProjection {
  const snapshot = observation.snapshot;
  if (goal.property === "file.property.exists") {
    const value = goal.target.followSymlinks ? snapshot.resolvedTargetExists : snapshot.entryExists;
    return typeof value === "boolean" ? { state: "known", value } : { state: "missing", errno: snapshot.errno };
  }
  if (goal.property === "file.property.type") {
    return snapshot.kind === null ? { state: "missing", errno: snapshot.errno } : { state: "known", value: snapshot.kind };
  }
  if (goal.property === "file.property.size") {
    return snapshot.size === null ? { state: "missing", errno: snapshot.errno } : { state: "known", value: snapshot.size };
  }
  if (goal.property === "file.property.mode") {
    return snapshot.mode === null ? { state: "missing", errno: snapshot.errno } : { state: "known", value: snapshot.mode };
  }
  if (goal.property === "file.property.owner") {
    return snapshot.uid === null || snapshot.gid === null
      ? { state: "missing", errno: snapshot.errno }
      : { state: "known", value: Object.freeze({ uid: snapshot.uid, gid: snapshot.gid }) };
  }
  if (goal.property === "file.property.times") {
    return [snapshot.atimeMs, snapshot.mtimeMs, snapshot.ctimeMs, snapshot.birthtimeMs].every(value => value === null)
      ? { state: "missing", errno: snapshot.errno }
      : {
          state: "known",
          value: Object.freeze({
            atimeMs: snapshot.atimeMs,
            mtimeMs: snapshot.mtimeMs,
            ctimeMs: snapshot.ctimeMs,
            birthtimeMs: snapshot.birthtimeMs,
          }),
        };
  }
  if (goal.property === "file.property.link.target") {
    if (goal.target.followSymlinks || snapshot.kind !== "symlink") return { state: "inapplicable" };
    if (snapshot.linkTarget === null) return { state: "missing", errno: snapshot.errno };
    return { state: "known", value: snapshot.linkTarget };
  }
  if (snapshot.observedWith === null) return { state: "missing", errno: snapshot.errno };
  return {
    state: "known",
    value: Object.freeze({
      dev: snapshot.dev,
      ino: snapshot.ino,
      nlink: snapshot.nlink,
      rdev: snapshot.rdev,
    }),
  };
}

function resolvedTargetProjection(observation: EntryInspectObservation): InspectProjection {
  const snapshot = observation.snapshot;
  if (observation.entryKind !== "symlink") {
    if (snapshot.entryExists === false) return { state: "missing", errno: snapshot.errno };
    return { state: "inapplicable" };
  }
  if (snapshot.resolvedTargetExists !== true || snapshot.kind === null) {
    return { state: "missing", errno: snapshot.errno };
  }
  return {
    state: "known",
    value: Object.freeze({
      resolvedTargetExists: true,
      targetType: snapshot.kind,
      targetIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    }),
  };
}

function evaluateOutcome(input: ObservedContext): Pick<EvaluatedContext, "satisfaction" | "status" | "reason" | "evidence" | "defer"> {
  const common = {
    facts: input.facts,
    requiredHead: input.requiredHead,
    selectedHead: input.policy.selectedHead,
    expectedPhysical: input.expectedPhysical,
    bindingError: input.bindingError,
    executionStatus: input.execution_result.status,
    errorCode: failureCode(input.receipt),
  } as const;
  if (input.bindingError !== null) {
    return {
      satisfaction: 0,
      status: "rejected",
      reason: input.bindingError === "resolved_target_requires_follow_symlinks"
        ? input.bindingError
        : "directory_binding_failed",
      evidence: Object.freeze({ ...common }),
      defer: null,
    };
  }
  if (!input.registered) {
    return { satisfaction: null, status: "unknown", reason: "unsupported_property", evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.policy_error !== null) {
    return { satisfaction: 0, status: "rejected", reason: "unexpected_head", evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.unboundDirectory) {
    return {
      satisfaction: null,
      status: "unknown",
      reason: "binding_unresolved",
      evidence: Object.freeze({ ...common }),
      defer: Object.freeze({ code: "binding_unresolved", detail: "DirectoryQuery requires a later explicit binding" }),
    };
  }
  if (input.policy.selectedHead === "NOOP") {
    return {
      satisfaction: 100,
      status: "achieved",
      reason: "fresh_equality_noop",
      evidence: Object.freeze({ ...common, fresh: input.facts.hasFreshEvidence, condition: input.facts.requiredConditionHolds }),
      defer: null,
    };
  }
  const observation = input.receipt?.execution.status === "succeeded" ? input.receipt.execution.observation : null;
  const physicalGoal = input.request.goal.property === "file.property.path.physical"
    ? input.request.goal as PathPhysicalGoal
    : null;
  const resolvedTargetGoal = isResolvedTargetGoal(input.request.goal)
    ? input.request.goal as ResolvedTargetGoal
    : null;
  const inspectGoal = resolvedTargetGoal === null
    && input.request.goal.requirement.kind === "observed"
    && (input.request.goal.property === "file.property.exists"
    || input.request.goal.property === "file.property.type"
    || input.request.goal.property === "file.property.size"
    || input.request.goal.property === "file.property.mode"
    || input.request.goal.property === "file.property.owner"
    || input.request.goal.property === "file.property.times"
    || input.request.goal.property === "file.property.link.target"
    || input.request.goal.property === "file.property.entry.identity")
    ? input.request.goal as InspectGoal
    : null;
  const observedRef = inspectGoal?.target.ref ?? physicalGoal?.target ?? null;
  const legacyInspect = observedRef !== null
    && observedRef.kind === "cli.directory"
    && !Object.hasOwn(observedRef, "absolutePath");
  if (legacyInspect && failureCode(input.receipt) === "binding_identity_missing") {
    return { satisfaction: null, status: "unknown", reason: "binding_identity_missing", evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.execution_result.status === "rejected") {
    return { satisfaction: 0, status: "rejected", reason: input.execution_result.reason, evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.execution_result.status === "failed") {
    if (physicalGoal !== null) {
      return { satisfaction: 0, status: "failed", reason: "physical_path_unavailable", evidence: Object.freeze({ ...common }), defer: null };
    }
    return { satisfaction: 0, status: "failed", reason: input.execution_result.reason, evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.request.goal.property === "file.property.relation.sessionCwd") {
    const requirement = (input.request.goal as CwdGoal).requirement;
    if (requirement.kind === "observed") {
      return observation?.kind === "pwd" && unchanged(input.session_before, input.session_after)
        ? { satisfaction: 100, status: "achieved", reason: "fresh_pwd_observation", evidence: Object.freeze({ ...common, observationKind: observation.kind }), defer: null }
        : { satisfaction: null, status: "unknown", reason: "pwd_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (input.execution_result.status !== "succeeded" || observation?.kind !== "cwd.set") {
      return { satisfaction: null, status: "unknown", reason: "cd_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (input.postcondition === null) {
      return { satisfaction: null, status: "unknown", reason: "postcommit_observation_failed", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (input.postcondition.receipt.execution.status !== "succeeded") {
      return { satisfaction: null, status: "unknown", reason: "postcommit_observation_failed", evidence: Object.freeze({ ...common, changed: input.changed }), defer: null };
    }
    return input.postcondition.matchedTarget
      ? { satisfaction: 100, status: "achieved", reason: "postcommit_target_matched", evidence: Object.freeze({ ...common, changed: input.changed }), defer: null }
      : { satisfaction: 0, status: "unmet", reason: "postcommit_target_mismatch", evidence: Object.freeze({ ...common, changed: input.changed }), defer: null };
  }
  if (input.request.goal.property === "file.property.directory.entries") {
    if (observation?.kind !== "directory.list") {
      return { satisfaction: null, status: "unknown", reason: "directory_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (observation.coverage === "complete" && observation.errors.length === 0 && observation.entries.every(entry => entry.type !== "unknown")) {
      return { satisfaction: 100, status: "achieved", reason: "complete_listing", evidence: Object.freeze({ ...common, entries: observation.entries.length }), defer: null };
    }
    return { satisfaction: null, status: "unknown", reason: "partial_coverage", evidence: Object.freeze({ ...common }), defer: null };
  }
  if (input.request.goal.property === "file.property.path.absolute") {
    if (observation?.kind !== "path.resolve") {
      return { satisfaction: null, status: "unknown", reason: "path_resolve_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    return {
      satisfaction: 100,
      status: "achieved",
      reason: "lexical_path_resolved",
      evidence: Object.freeze({ ...common, absolutePath: observation.absolute, parent: observation.parent }),
      defer: null,
    };
  }
  if (input.request.goal.property === "file.property.path.relative") {
    if (observation?.kind !== "path.relative") {
      return { satisfaction: null, status: "unknown", reason: "path_relative_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    return {
      satisfaction: 100,
      status: "achieved",
      reason: "lexical_path_related",
      evidence: Object.freeze({ ...common, relativePath: observation.relative }),
      defer: null,
    };
  }
  if (physicalGoal !== null) {
    if (observation?.kind !== "path.realpath") {
      return { satisfaction: null, status: "unknown", reason: "path_realpath_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (observation.snapshot.physicalPath === null || observation.snapshot.entryExists !== true
      || observation.snapshot.resolvedTargetExists !== true) {
      return { satisfaction: 0, status: "failed", reason: "physical_path_unavailable", evidence: Object.freeze({ ...common }), defer: null };
    }
    return {
      satisfaction: 100,
      status: "achieved",
      reason: "physical_path_observed",
      evidence: Object.freeze({ ...common, value: observation.snapshot.physicalPath }),
      defer: null,
    };
  }
  if (input.request.goal.property === "file.property.path.parent" || input.request.goal.property === "file.property.path.name") {
    if (observation?.kind !== "path.parts") {
      return { satisfaction: null, status: "unknown", reason: "path_parts_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    return {
      satisfaction: 100,
      status: "achieved",
      reason: "path_parts_observed",
      evidence: Object.freeze({ ...common, parent: observation.parent, name: observation.name, isRoot: observation.isRoot }),
      defer: null,
    };
  }
  if (resolvedTargetGoal !== null) {
    if (observation?.kind !== "entry.inspect") {
      return { satisfaction: null, status: "unknown", reason: "entry_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    const projected = resolvedTargetProjection(observation);
    if (projected.state === "known") {
      return {
        satisfaction: 100,
        status: "achieved",
        reason: "resolved_target_observed",
        evidence: Object.freeze({ ...common, value: projected.value }),
        defer: null,
      };
    }
    if (projected.state === "inapplicable") {
      return {
        satisfaction: null,
        status: "unknown",
        reason: "attribute_not_applicable",
        evidence: Object.freeze({ ...common }),
        defer: null,
      };
    }
    if (projected.errno === "ENOENT") {
      return {
        satisfaction: 0,
        status: "unmet",
        reason: "resolved_target_missing",
        evidence: Object.freeze({ ...common, errno: projected.errno }),
        defer: null,
      };
    }
    return {
      satisfaction: 0,
      status: "failed",
      reason: "attribute_unavailable",
      evidence: Object.freeze({ ...common, errno: projected.errno }),
      defer: null,
    };
  }
  if (inspectGoal !== null) {
    if (observation?.kind !== "entry.inspect") {
      return { satisfaction: null, status: "unknown", reason: "entry_observation_invalid", evidence: Object.freeze({ ...common }), defer: null };
    }
    if (!unchanged(input.session_before, input.session_after)) {
      return { satisfaction: 0, status: "unmet", reason: "unexpected_state_change", evidence: Object.freeze({ ...common }), defer: null };
    }
    const projected = inspectProjection(inspectGoal, observation);
    if (projected.state === "known") {
      return {
        satisfaction: 100,
        status: "achieved",
        reason: "entry_property_observed",
        evidence: Object.freeze({ ...common, property: inspectGoal.property, value: projected.value }),
        defer: null,
      };
    }
    if (projected.state === "inapplicable") {
      return {
        satisfaction: null,
        status: "unknown",
        reason: "attribute_not_applicable",
        evidence: Object.freeze({ ...common, property: inspectGoal.property }),
        defer: null,
      };
    }
    return {
      satisfaction: 0,
      status: "failed",
      reason: "attribute_unavailable",
      evidence: Object.freeze({ ...common, property: inspectGoal.property, errno: projected.errno }),
      defer: null,
    };
  }
  return { satisfaction: null, status: "unknown", reason: "unsupported_property", evidence: Object.freeze({ ...common }), defer: null };
}

export function createCliFilePropertyNodes(binding: CliCommandBinding, authority: EvidenceAuthority = createEvidenceAuthority()): readonly NodeDefinition[] {
  const profile = validateCliCommandProfile(binding.profile);
  const { sandbox, session } = binding;
  return [
    {
      operator: "cli.file-property.bind",
      version: "0.3.0.0000",
      inputPorts: [bindPort],
      outputPort: contextPort,
      effects: [],
      async execute(context) {
        const request = validatePropertyRequest(context.inputs[0]!.payload, session);
        const before = sandbox.getSession(session);
        const expected = expectedDirectoryOf(request.goal);
        let expectedPhysical: string | null = null, bindingError: string | null = null;
        if (expected !== null) {
          try { expectedPhysical = (await sandbox.resolveDirectory(expected)).physicalPath; }
          catch (error) { bindingError = error instanceof Error ? error.message : String(error); }
        }
        return context.emit({
          request,
          session,
          session_before: before,
          expectedPhysical,
          bindingError: request.bindingError ?? bindingError,
          registered: request.registered,
          unboundDirectory: request.unboundDirectory,
        });
      },
    },
    {
      operator: "cli.file-property.select",
      version: "0.3.0.0000",
      inputPorts: [contextPort],
      outputPort: proposalPort,
      effects: [],
      execute(context) {
        const raw = context.inputs[0]!.payload as unknown as BoundContext;
        const facts = computePropertyFacts({
          goal: raw.request.goal,
          state: raw.request.state,
          session,
          revision: raw.session_before.revision,
          authority,
          expectedPhysical: raw.expectedPhysical,
        });
        const required = requiredHead({ registered: raw.registered, unboundDirectory: raw.unboundDirectory, goal: raw.request.goal, facts });
        const policy = predictCliCommand(raw.request.goal, facts, profile, raw.registered);
        const policy_error = policy.selectedHead === required ? null : Object.freeze({ expectedHead: required, selectedHead: policy.selectedHead });
        return context.emit({ ...raw, facts, requiredHead: required, policy, policy_error });
      },
    },
    {
      operator: "cli.file-property.execute",
      version: "0.3.0.0000",
      inputPorts: [proposalPort],
      outputPort: executionPort,
      effects: [],
      async execute(context) {
        const selected = context.inputs[0]!.payload as unknown as SelectedContext;
        const before = selected.session_before;
        let invocation: CliCommandInvocation | null = null, call: SemanticCallReceipt["call"] | null = null, receipt: SemanticCallReceipt | null = null;
        let result: CliCommandExecutionResult;
        if (selected.bindingError !== null) {
          result = executionResult("rejected",
            selected.bindingError === "resolved_target_requires_follow_symlinks"
              ? selected.bindingError
              : "directory_binding_failed",
            null, false, selected.bindingError);
        } else if (selected.policy_error !== null) {
          result = executionResult("rejected", "unexpected_head");
        } else if (selected.policy.selectedHead === "unsupported") {
          result = executionResult("unsupported", "unsupported_property");
        } else if (selected.policy.selectedHead === "DEFER") {
          result = executionResult("deferred", "binding_unresolved");
        } else if (selected.policy.selectedHead === "NOOP") {
          result = executionResult("noop", "fresh_equality_noop");
        } else {
          const head = selected.policy.selectedHead;
          const goal = selected.request.goal;
          try {
            if (head === "pwd") {
              invocation = Object.freeze(["pwd"] as const);
              call = Object.freeze({ operation: "cwd.get", parameters: Object.freeze({ session }) });
            } else if (head === "cd" || head === "ls") {
              const directory = expectedDirectoryOf(selected.request.goal);
              if (directory === null) throw new TypeError("Executable property head needs a bound directory reference");
              invocation = Object.freeze([head, directory] as const);
              call = Object.freeze({
                operation: head === "cd" ? "cwd.set" : "directory.list",
                parameters: Object.freeze({ session, directory }),
              });
            } else if (head === "path.resolve") {
              const target = (goal as PathAbsoluteGoal).target;
              invocation = Object.freeze(["path.resolve", target.base, target.input] as const);
              call = Object.freeze({
                operation: "path.resolve",
                parameters: Object.freeze({ base: target.base, input: target.input }),
              });
            } else if (head === "path.relative") {
              const target = (goal as PathRelativeGoal).target;
              invocation = Object.freeze(["path.relative", target.from, target.to] as const);
              call = Object.freeze({
                operation: "path.relative",
                parameters: Object.freeze({ from: target.from, to: target.to }),
              });
            } else if (head === "path.parts") {
              const target = (goal as PathPartsGoal).target;
              invocation = Object.freeze(["path.parts", target] as const);
              call = Object.freeze({
                operation: "path.parts",
                parameters: Object.freeze({ path: target }),
              });
            } else if (head === "path.realpath") {
              const target = (goal as PathPhysicalGoal).target;
              invocation = Object.freeze(["path.realpath", target] as const);
              call = Object.freeze({
                operation: "path.realpath",
                parameters: Object.freeze({ ref: target }),
              });
            } else if (head === "entry.inspect") {
              const target = (goal as InspectGoal).target;
              invocation = Object.freeze(["entry.inspect", target.ref, target.followSymlinks] as const);
              call = Object.freeze({
                operation: "entry.inspect",
                parameters: Object.freeze({ ref: target.ref, followSymlinks: target.followSymlinks }),
              });
            } else {
              throw new TypeError(`Unsupported executable head: ${head}`);
            }
            receipt = await sandbox.execute(call);
            const status = receiptExecutionStatus(receipt);
            result = executionResult(status,
              status === "succeeded" ? "executed" : status === "rejected" ? "execution_rejected" : "execution_failed",
              receipt, receipt.execution.executorInvoked,
              receipt.status === "failed" && receipt.execution.status === "failed" ? receipt.execution.error.message : null);
          } catch (error) {
            result = executionResult("failed", "execution_threw", null, false, error instanceof Error ? error.message : String(error));
          }
        }
        return context.emit({ ...selected, invocation, call, receipt, execution_result: result, session_after: sandbox.getSession(session) });
      },
    },
    {
      operator: "cli.file-property.observe",
      version: "0.3.0.0000",
      inputPorts: [executionPort],
      outputPort: transitionPort,
      effects: [],
      async execute(context) {
        const executed = context.inputs[0]!.payload as unknown as ExecutedContext;
        let observed = executed.request.state, postcondition: CliCommandPostcondition | null = null;
        if (executed.receipt?.execution.status === "succeeded") {
          const observation = executed.receipt.execution.observation;
          if (observation.kind === "pwd" && unchanged(executed.session_before, executed.session_after)) {
            observed = Object.freeze({ ...observed, cwdObservation: cwdKnowledge(observation, executed.session_before.revision, executed.receipt.execution.runId) });
            authority.record({
              kind: "pwd",
              session: session.sessionId,
              revision: executed.session_before.revision,
              runId: executed.receipt.execution.runId,
              observation,
            });
          } else if (observation.kind === "directory.list" && unchanged(executed.session_before, executed.session_after)
            && observation.coverage === "complete" && observation.errors.length === 0 && observation.entries.every(entry => entry.type !== "unknown")) {
            observed = Object.freeze({ ...observed, directoryListing: directoryKnowledge(observation, executed.session_before.revision, executed.receipt.execution.runId) });
            authority.record({
              kind: "directory.list",
              session: session.sessionId,
              revision: executed.session_before.revision,
              runId: executed.receipt.execution.runId,
              observation,
            });
          } else if ((observation.kind === "path.resolve" || observation.kind === "path.relative" || observation.kind === "path.parts" || observation.kind === "path.realpath")
            && unchanged(executed.session_before, executed.session_after)) {
            observed = Object.freeze({
              ...observed,
              pathKnowledge: pathKnowledge(observation, executed.session_before.revision, executed.receipt.execution.runId),
            });
          } else if (observation.kind === "entry.inspect" && unchanged(executed.session_before, executed.session_after)) {
            observed = Object.freeze({
              ...observed,
              entryKnowledge: entryKnowledge(
                (executed.request.goal as InspectGoal).target,
                observation,
                executed.session_before.revision,
                executed.receipt.execution.runId,
              ),
            });
          } else if (observation.kind === "cwd.set") {
            const post = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
            const matchedTarget = post.execution.status === "succeeded"
              && post.execution.observation.kind === "pwd"
              && post.execution.observation.physicalCwd === observation.targetPhysicalPath
              && sandbox.getSession(session).cwd === observation.targetPhysicalPath;
            postcondition = Object.freeze({ receipt: post, matchedTarget });
            if (post.execution.status === "succeeded" && post.execution.observation.kind === "pwd") {
              observed = Object.freeze({
                ...observed,
                cwdObservation: cwdKnowledge(post.execution.observation, sandbox.getSession(session).revision, post.execution.runId),
              });
              authority.record({
                kind: "pwd",
                session: session.sessionId,
                revision: sandbox.getSession(session).revision,
                runId: post.execution.runId,
                observation: post.execution.observation,
              });
            }
          }
        }
        return context.emit({
          ...executed,
          observed_state_after: observed,
          postcondition,
          changed: changed(executed.session_before, sandbox.getSession(session)),
        });
      },
    },
    {
      operator: "cli.file-property.evaluate",
      version: "0.3.0.0000",
      inputPorts: [transitionPort],
      outputPort: evaluationPort,
      effects: [],
      execute(context) {
        const observed = context.inputs[0]!.payload as unknown as ObservedContext;
        const outcome = evaluateOutcome(observed);
        return context.emit({ ...observed, ...outcome });
      },
    },
    {
      operator: "cli.file-property.report",
      version: "0.3.0.0000",
      inputPorts: [evaluationPort],
      outputPort: resultPort,
      effects: [],
      async execute(context) {
        const evaluated = context.inputs[0]!.payload as unknown as EvaluatedContext;
        const sample: CliCommandSample = Object.freeze({
          goal: evaluated.request.goal,
          satisfactionThreshold: evaluated.request.satisfactionThreshold,
          state_before: evaluated.request.state,
          action: actionOf(evaluated.policy.selectedHead, session, evaluated.request.goal),
          invocation: evaluated.invocation,
          policy: evaluated.policy,
          policy_error: evaluated.policy_error,
          execution_result: evaluated.execution_result,
          observed_state_after: evaluated.observed_state_after,
          satisfaction: evaluated.satisfaction,
          status: evaluated.status,
          reason: evaluated.reason,
          evidence: evaluated.evidence,
        });
        let collection: CliCommandCollectionResult = Object.freeze({ status: "not_configured" });
        if (binding.onSample !== undefined) {
          try { await binding.onSample(sample); collection = Object.freeze({ status: "saved" }); }
          catch (error) { collection = Object.freeze({ status: "failed", error: error instanceof Error ? error.message : String(error) }); }
        }
        const result: CliCommandTransition = Object.freeze({
          goal: evaluated.request.goal,
          satisfactionThreshold: evaluated.request.satisfactionThreshold,
          state_before: evaluated.request.state,
          action: sample.action,
          invocation: evaluated.invocation,
          policy: evaluated.policy,
          policy_error: evaluated.policy_error,
          execution_result: evaluated.execution_result,
          session_before: evaluated.session_before,
          session_after: evaluated.session_after,
          observed_state_after: evaluated.observed_state_after,
          postcondition: evaluated.postcondition,
          satisfaction: evaluated.satisfaction,
          status: evaluated.status,
          reason: evaluated.reason,
          changed: evaluated.changed,
          evidence: evaluated.evidence,
          collection_result: collection,
          defer: evaluated.defer,
        });
        return context.emit(result);
      },
    },
  ];
}
