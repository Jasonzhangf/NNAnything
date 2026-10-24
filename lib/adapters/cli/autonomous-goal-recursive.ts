import {
  readAtomicReceipt,
  type AdapterDiagnostic,
  type AtomicInput,
  type AtomicReceipt,
  type DerivationInput,
  type EnabledEvaluator,
  type EnabledSkill,
  type EvaluationInput,
  type EvaluationReceipt,
  type FactSnapshot,
  type RecursiveGoalAdapter,
  type RecursiveGoalComparators,
  type RecursiveGoalDependencies,
  type RecursiveGoalRequestEnvelope,
  type SelectorBinding,
  type Selection,
  type SelectionInput,
  type SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import { randomUUID } from "node:crypto";
import { createCliCommandPolicy, type CliCommandPolicy } from "../../cli-goal.js";
import {
  classifyCliAutonomousGoal,
  CONTENT_BYTES_PROPERTY,
  contentReadGoal,
  type CliReadReceipt,
  type CliAutonomousStepRecord,
  type ContentBytesEqualsGoal,
  validateContentBytesEqualsGoal,
} from "./autonomous-goal-contract.js";
import {
  buildStepRecord,
  failureCodeOf,
} from "../../filters/cli-autonomous-goal.js";
import { validateExplicitFileState, type ExplicitFileState } from "../../filters/cli-state.js";
import { validateGoal, type CwdGoal, type FilePropertyGoal, type PathRef } from "../../filters/cli-file-property.js";
import type { CliCommandTransition } from "../../nodes/cli-command.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { EvidenceAuthority } from "../../filters/cli-state.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import type { ObservedObjectRef, OsInteger } from "./entry-inspection.js";

export const ATOMIC_SKILL_ID = "cli.autonomous.atomic" as const;
export const COMPOSITE_SKILL_ID = "cli.autonomous.session-cwd-ensure" as const;
export const ATOMIC_EVALUATOR_ID = "cli.autonomous.atomic-evaluator" as const;
export const ROOT_EVALUATOR_ID = "cli.autonomous.session-cwd-evaluator" as const;
export const ATOMIC_SELECTOR_ID = "cli.autonomous.atomic-selector" as const;
export const ROOT_SELECTOR_ID = "cli.autonomous.session-cwd-selector" as const;
export const CONTENT_COMPOSITE_SKILL_ID = "cli.autonomous.content-bytes" as const;
export const CONTENT_READ_SKILL_ID = "cli.autonomous.content-read" as const;
export const CONTENT_INSPECT_SKILL_ID = "cli.autonomous.content-inspect" as const;
export const CONTENT_ROOT_EVALUATOR_ID = "cli.autonomous.content-bytes-evaluator" as const;
export const CONTENT_READ_EVALUATOR_ID = "cli.autonomous.content-read-evaluator" as const;
export const CONTENT_ROOT_SELECTOR_ID = "cli.autonomous.content-bytes-selector" as const;
export const CONTENT_READ_SELECTOR_ID = "cli.autonomous.content-read-selector" as const;
export const CONTENT_INSPECT_EVALUATOR_ID = "cli.autonomous.content-inspect-evaluator" as const;
export const CONTENT_INSPECT_SELECTOR_ID = "cli.autonomous.content-inspect-selector" as const;

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

export type CliAutonomousCursor = Readonly<{
  phase: "observed" | "verified" | "listed" | "inspected" | "read" | "terminal";
}>;

export type CliAutonomousState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  cli: ExplicitFileState;
}>;

export type ContentReadGoal = Readonly<{
  kind: "cli.content-read";
  property: typeof CONTENT_BYTES_PROPERTY;
  entry?: Readonly<{ name: string; path: string }>;
  range: Readonly<{ offset: number; length: number }>;
  expectedBase64: string;
}>;

export type ContentInspectGoal = Readonly<{
  kind: "cli.content-inspect";
  property: "file.property.type";
}>;

export type CliAutonomousGoal =
  | FilePropertyGoal
  | ContentBytesEqualsGoal
  | ContentReadGoal
  | ContentInspectGoal;

export type CliContentReadEvidence = Readonly<{
  operation: "file.read";
  offset: number;
  length: number;
  bytesRead: number;
  eof: boolean;
  bytes: string;
  rangeBytes: number;
  expectedBase64: string;
  observedObject: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  status: "succeeded" | "failed" | "rejected" | "deferred";
  reason: string;
}>;

export type CliAutonomousEvidencePayload =
  | Readonly<{ kind: "cli.autonomous.transition.v1"; transition: CliCommandTransition }>
  | Readonly<{ kind: "cli.autonomous.content-read.v1"; read: CliContentReadEvidence }>;

export type CliAutonomousEffectFact = Readonly<{
  kind: "cli.autonomous.effect.v1";
  operation: string | null;
  executorInvoked: boolean;
}>;

type ContentReadSandboxReceipt = Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;

export type CliAutonomousReceiptPayload =
  | CliCommandTransition
  | ContentReadSandboxReceipt
  | Readonly<{ kind: "cli.content-read.bind.v1"; reason: string }>;

export type CliAutonomousAdapter = RecursiveGoalAdapter<
  CliAutonomousGoal,
  CliAutonomousState,
  unknown,
  CliAutonomousEvidencePayload,
  CliAutonomousEffectFact,
  CliAutonomousReceiptPayload,
  CliAutonomousCursor
>;

export type CliAutonomousAdapterHandle = Readonly<{
  adapter: CliAutonomousAdapter;
  steps: readonly CliAutonomousStepRecord[];
  lastState: ExplicitFileState | null;
  readReceipts: readonly CliReadReceipt[];
  transitions: readonly CliCommandTransition[];
}>;

export type CliAutonomousAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  authority: EvidenceAuthority;
  initialState: ExplicitFileState;
  readReceipts?: ReadonlyArray<CliReadReceipt>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function sameGoal(left: CliAutonomousGoal, right: CliAutonomousGoal): boolean {
  return canonical(left) === canonical(right);
}

function isCwdEqualsGoal(goal: CliAutonomousGoal): boolean {
  return goal.property === "file.property.relation.sessionCwd"
    && (goal as CwdGoal).requirement.kind === "equals";
}

function isContentBytesGoal(goal: CliAutonomousGoal): goal is ContentBytesEqualsGoal {
  return goal.property === CONTENT_BYTES_PROPERTY
    && "target" in goal
    && isRecord(goal.requirement)
    && goal.requirement.kind === "equals";
}

function isContentReadGoal(goal: CliAutonomousGoal): goal is ContentReadGoal {
  return goal.kind === "cli.content-read" && goal.property === CONTENT_BYTES_PROPERTY;
}

function isContentInspectGoal(goal: CliAutonomousGoal): goal is ContentInspectGoal {
  return goal.kind === "cli.content-inspect" && goal.property === "file.property.type";
}

function readGoal(value: unknown): CliAutonomousGoal {
  if (isRecord(value) && value.kind === "cli.content-read") return value as ContentReadGoal;
  if (isRecord(value) && value.kind === "cli.content-inspect") return value as ContentInspectGoal;
  if (isRecord(value) && value.property === CONTENT_BYTES_PROPERTY
    && isRecord(value.requirement) && value.requirement.kind === "equals") {
    return validateContentBytesEqualsGoal(value);
  }
  return validateGoal(value).goal;
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("autonomous bindings must be an object");
  return Object.freeze({ ...value });
}

function readSessionSnapshot(value: unknown): SessionSnapshot {
  if (!isRecord(value)) throw new TypeError("autonomous session snapshot must be an object");
  const keys = ["id", "cwd", "revision", "grantedEffects"];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`autonomous session snapshot must contain ${keys.join(", ")}`);
  }
  const grantedEffects = value.grantedEffects;
  if (!Array.isArray(grantedEffects) || grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError("autonomous session snapshot grantedEffects must be a string array");
  }
  return Object.freeze({
    id: nonEmpty(value.id, "session snapshot id"),
    cwd: nonEmpty(value.cwd, "session snapshot cwd"),
    revision: Number(value.revision),
    grantedEffects: Object.freeze([...grantedEffects]),
  });
}

function readState(value: unknown): CliAutonomousState {
  if (!isRecord(value)) throw new TypeError("autonomous state must be an object");
  if (!Object.hasOwn(value, "stateId") || !Object.hasOwn(value, "session") || !Object.hasOwn(value, "cli")) {
    throw new TypeError("autonomous state must contain stateId, session, and cli");
  }
  return Object.freeze({
    stateId: nonEmpty(value.stateId, "state stateId"),
    session: readSessionSnapshot(value.session),
    cli: validateExplicitFileState(value.cli),
  });
}

function readEvidencePayload(value: unknown): CliAutonomousEvidencePayload {
  if (!isRecord(value)) throw new TypeError("autonomous evidence payload must be an object");
  if (value.kind === "cli.autonomous.content-read.v1") {
    if (!isRecord(value.read)) throw new TypeError("content-read evidence must contain read");
    return Object.freeze({ kind: "cli.autonomous.content-read.v1", read: value.read as CliContentReadEvidence });
  }
  if (value.kind === "cli.autonomous.transition.v1") {
    return Object.freeze({ kind: "cli.autonomous.transition.v1", transition: value.transition as CliCommandTransition });
  }
  throw new TypeError("autonomous evidence payload kind is unsupported");
}

const COMPARATORS: RecursiveGoalComparators<CliAutonomousGoal, unknown, CliAutonomousState, CliAutonomousEvidencePayload> = Object.freeze({
  sameGoal: (left: CliAutonomousGoal, right: CliAutonomousGoal) => canonical(left) === canonical(right),
  sameBindings: (left: unknown, right: unknown) => canonical(left) === canonical(right),
  sameFacts: (
    left: FactSnapshot<CliAutonomousState, CliAutonomousEvidencePayload>,
    right: FactSnapshot<CliAutonomousState, CliAutonomousEvidencePayload>,
  ) => canonical(left) === canonical(right),
});

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readEvidencePayload,
  effectFact: (value: unknown) => value as CliAutonomousEffectFact,
  receiptPayload: (value: unknown) => value as CliAutonomousReceiptPayload,
});

function evaluation(
  evaluatorId: string,
  result: "satisfied" | "unsatisfied" | "unknown",
  satisfaction: number | null,
  evidenceRefs: readonly string[],
): EvaluationReceipt {
  return Object.freeze({
    evaluatorId,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function outcomeOf(transition: CliCommandTransition): AtomicReceipt<unknown, unknown, unknown, unknown>["outcome"] {
  if (transition.status === "achieved") return "succeeded";
  if (transition.status === "failed") return "failed";
  return "rejected";
}

function transitionDiagnostics(transition: CliCommandTransition, id: string): {
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
} {
  const executionErrors: AdapterDiagnostic[] = [];
  if (transition.policy_error !== null) {
    executionErrors.push({
      diagnosticId: `${id}:policy`,
      code: "policy_error",
      stage: "selection",
      sourceCategory: "cli.command_policy",
      message: `command policy selected ${transition.policy_error.selectedHead}, expected ${transition.policy_error.expectedHead}`,
      nativeCode: null,
      refs: Object.freeze([id]),
    });
  } else if (transition.status === "unknown" && transition.reason === "unsupported_property") {
    executionErrors.push({
      diagnosticId: `${id}:unsupported`,
      code: "capability_missing",
      stage: "selection",
      sourceCategory: "cli.command_policy",
      message: "file.property is not registered",
      nativeCode: null,
      refs: Object.freeze([id]),
    });
  } else if (transition.status === "unknown" && transition.reason === "binding_unresolved") {
    executionErrors.push({
      diagnosticId: `${id}:binding`,
      code: "policy_deferred",
      stage: "binding",
      sourceCategory: "cli.directory_binding",
      message: transition.reason,
      nativeCode: null,
      refs: Object.freeze([id]),
    });
  } else if (transition.status === "rejected" && transition.reason !== "unexpected_head") {
    const code = failureCodeOf(transition);
    executionErrors.push({
      diagnosticId: `${id}:execution`,
      code: code === "EFFECT_DENIED" ? "effect_denied" : "invalid_binding",
      stage: code === "EFFECT_DENIED" ? "execution" : "binding",
      sourceCategory: "cli.command_execution",
      message: transition.execution_result.reason,
      nativeCode: code,
      refs: Object.freeze([id]),
    });
  } else if (transition.status === "failed") {
    const code = failureCodeOf(transition);
    executionErrors.push({
      diagnosticId: `${id}:execution`,
      code: "execution_failed",
      stage: "execution",
      sourceCategory: "cli.command_execution",
      message: transition.execution_result.reason,
      nativeCode: code,
      refs: Object.freeze([id]),
    });
  }
  return { executionErrors: Object.freeze(executionErrors), verificationErrors: Object.freeze([]) };
}

function atomicReceipt(input: {
  requestId: string;
  sequence: number;
  transition: CliCommandTransition;
}): AtomicReceipt<CliAutonomousState, CliAutonomousEvidencePayload, CliAutonomousEffectFact, CliAutonomousReceiptPayload> {
  const transition = input.transition;
  const id = `${input.requestId}:transition-${input.sequence}`;
  const stateId = `${input.requestId}:state-${input.sequence}`;
  const nextState = Object.freeze({
    id: stateId,
    value: Object.freeze({
      stateId,
      session: transition.session_after,
      cli: transition.observed_state_after,
    }),
  });
  const evidence = Object.freeze([
    Object.freeze({
      id: `${input.requestId}:evidence-${input.sequence}`,
      stateRef: stateId,
      payload: Object.freeze({ kind: "cli.autonomous.transition.v1", transition }),
      validity: "valid" as const,
    }),
  ]);
  const errors = transitionDiagnostics(transition, id);
  return Object.freeze({
    runId: transition.execution_result.receipt?.execution.runId ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: outcomeOf(transition),
    sourceResult: Object.freeze({ tag: "cli.command.transition.v1", value: transition }),
    newState: nextState,
    evidence,
    executionErrors: errors.executionErrors,
    verificationErrors: errors.verificationErrors,
    effect: Object.freeze({
      knowledge: "none" as const,
      confirmedEffects: Object.freeze([]),
      receiptRef: null,
    }),
  });
}

function cwdFresh(state: CliAutonomousState): boolean {
  return state.cli.cwdObservation !== null && state.cli.cwdObservation.revision === state.session.revision;
}

function hasPwdTransition(evidence: readonly { payload: CliAutonomousEvidencePayload }[]): boolean {
  return evidence.some(item =>
    item.payload.kind === "cli.autonomous.transition.v1"
    && item.payload.transition.goal.property === "file.property.relation.sessionCwd"
    && (item.payload.transition.goal as CwdGoal).requirement.kind === "observed"
    && item.payload.transition.status === "achieved");
}

function pwdGoal(session: SessionRef): FilePropertyGoal {
  return Object.freeze({
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: Object.freeze({ kind: "cli.file-query", relation: "sessionCwd", session }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function condition(
  id: string,
  goal: CliAutonomousGoal,
  bindings: unknown,
  evaluatorId: string,
  selectorId: string,
  allowedEffects: readonly string[],
  dependsOn: readonly string[] = [],
) {
  return Object.freeze({
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId,
    selectorId,
    mode: "atomic" as const,
    dependsOn: Object.freeze([...dependsOn]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...allowedEffects]),
  });
}

export function createCliAutonomousAdapter(input: CliAutonomousAdapterInput): CliAutonomousAdapterHandle {
  const policy: CliCommandPolicy = createCliCommandPolicy({
    profile: input.profile,
    sandbox: input.sandbox,
    session: input.session,
  }, input.authority);
  let sequence = 0;
  const transitions: CliCommandTransition[] = [];
  const steps: CliAutonomousStepRecord[] = [];
  const readReceipts: CliReadReceipt[] = [];
  let requestId = "";
  let rootFrameId = "";
  let rootEvaluatorId: string = ATOMIC_EVALUATOR_ID;
  const recordStep = (step: CliAutonomousStepRecord) => {
    steps.push(step);
  };

  const adapter: CliAutonomousAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      const rootGoal = readGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      readState(request.state);
      requestId = request.requestId;
      rootFrameId = `${request.requestId}:root`;
      rootEvaluatorId = request.rootEvaluatorId;
      if (
        request.rootEvaluatorId !== ATOMIC_EVALUATOR_ID
        && request.rootEvaluatorId !== ROOT_EVALUATOR_ID
        && request.rootEvaluatorId !== CONTENT_ROOT_EVALUATOR_ID
        && request.rootEvaluatorId !== CONTENT_READ_EVALUATOR_ID
      ) {
        throw new TypeError("unsupported root evaluator");
      }
      if (
        request.rootSelectorId !== ATOMIC_SELECTOR_ID
        && request.rootSelectorId !== ROOT_SELECTOR_ID
        && request.rootSelectorId !== CONTENT_ROOT_SELECTOR_ID
        && request.rootSelectorId !== CONTENT_READ_SELECTOR_ID
      ) {
        throw new TypeError("unsupported root selector");
      }
      return Object.freeze({
        requestId: request.requestId,
        rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state: readState(request.state),
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation: null,
      });
    },

    supports(callback: SupportsInput<CliAutonomousGoal, unknown>) {
      if (callback.skill.id === COMPOSITE_SKILL_ID) return isCwdEqualsGoal(callback.goal);
      if (callback.skill.id === CONTENT_COMPOSITE_SKILL_ID) return isContentBytesGoal(callback.goal);
      if (callback.skill.id === ATOMIC_SKILL_ID) {
        if (isContentReadGoal(callback.goal) || isContentBytesGoal(callback.goal)) return false;
        try {
          classifyCliAutonomousGoal(callback.goal);
          return true;
        } catch {
          return false;
        }
      }
      if (callback.skill.id === CONTENT_INSPECT_SKILL_ID) return isContentInspectGoal(callback.goal);
      if (callback.skill.id === CONTENT_READ_SKILL_ID) return isContentReadGoal(callback.goal);
      return false;
    },

    async evaluate(callback: EvaluationInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload>) {
      const evaluatorId = callback.context.frameId === rootFrameId ? rootEvaluatorId : ATOMIC_EVALUATOR_ID;
      if (isContentReadGoal(callback.goal)) {
        const evidenceRefs = callback.evidence
          .filter(item =>
            item.validity === "valid"
            && item.payload.kind === "cli.autonomous.content-read.v1")
          .map(item => item.id);
        const satisfied = evidenceRefs.length !== 0;
        return evaluation(
          CONTENT_READ_EVALUATOR_ID,
          satisfied ? "satisfied" : "unknown",
          satisfied ? 100 : null,
          evidenceRefs,
        );
      }
      if (isContentInspectGoal(callback.goal)) {
        const evidenceRefs = callback.evidence
          .filter(item =>
            item.validity === "valid"
            && item.payload.kind === "cli.autonomous.transition.v1"
            && item.payload.transition.status === "achieved"
            && item.payload.transition.goal.property === "file.property.type")
          .map(item => item.id);
        const satisfied = evidenceRefs.length !== 0;
        return evaluation(
          CONTENT_INSPECT_EVALUATOR_ID,
          satisfied ? "satisfied" : "unknown",
          satisfied ? 100 : null,
          evidenceRefs,
        );
      }
      if (isContentBytesGoal(callback.goal)) {
        const readEvidence = callback.evidence
          .filter(item =>
            item.validity === "valid"
            && item.payload.kind === "cli.autonomous.content-read.v1"
            && item.payload.read.status === "succeeded")
          .map(item => {
            if (item.payload.kind !== "cli.autonomous.content-read.v1") {
              throw new TypeError("content read evidence narrowing failed");
            }
            return item.payload.read;
          });
        const trusted = readEvidence.some(evidence =>
          evidence.bytesRead === evidence.length
          && Buffer.from(evidence.bytes, "base64").length === evidence.rangeBytes
          && evidence.bytes === evidence.expectedBase64);
        const refs = callback.evidence
          .filter(item =>
            item.validity === "valid"
            && item.payload.kind === "cli.autonomous.content-read.v1"
            && item.payload.read.status === "succeeded")
          .map(item => item.id);
        const succeeded = trusted;
        return evaluation(
          evaluatorId,
          succeeded ? "satisfied" : (readEvidence.length === 0 ? "unknown" : "unsatisfied"),
          succeeded ? 100 : null,
          succeeded ? refs : [],
        );
      }
      const evidenceRefs = callback.evidence
        .filter(item =>
          item.validity === "valid"
          && item.payload.kind === "cli.autonomous.transition.v1"
          && item.payload.transition.status === "achieved"
          && sameGoal(item.payload.transition.goal, callback.goal))
        .map(item => item.id);
      const satisfied = evidenceRefs.length !== 0;
      return evaluation(
        evaluatorId,
        satisfied ? "satisfied" : "unknown",
        satisfied ? 100 : null,
        evidenceRefs,
      );
    },

    async select(callback: SelectionInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload>): Promise<Selection> {
      const first = callback.candidates[0];
      return first === undefined
        ? { kind: "no_capability", searchedSkillIds: Object.freeze([]) }
        : { kind: "selected", skillId: first.id };
    },

    async derive(callback: DerivationInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload, CliAutonomousCursor>) {
      if (callback.skill.id === COMPOSITE_SKILL_ID) {
        if (!isCwdEqualsGoal(callback.goal)) {
          throw new TypeError("session-cwd composite derivation received an incompatible frame");
        }
        return deriveCwd(callback);
      }
      if (callback.skill.id === CONTENT_COMPOSITE_SKILL_ID) {
        if (!isContentBytesGoal(callback.goal)) {
          throw new TypeError("content-bytes composite derivation received an incompatible frame");
        }
        return deriveContent(callback);
      }
      if (callback.skill.id === CONTENT_READ_SKILL_ID) {
        throw new TypeError("autonomous composite derivation received an incompatible frame");
      }
      throw new TypeError("autonomous derivation received an unsupported skill");
    },
    async executeAtomic(callback: AtomicInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload>) {
      sequence += 1;
      if (callback.skill.id === CONTENT_READ_SKILL_ID) {
        if (!isContentReadGoal(callback.goal)) {
          throw new TypeError("content-read executeAtomic received an incompatible frame");
        }
        const receipt = await executeContentRead(callback, input, sequence, recordStep);
        if (receipt.sourceResult !== null
          && typeof receipt.sourceResult === "object"
          && "tag" in receipt.sourceResult
          && receipt.sourceResult.tag === "cli.content-read.receipt.v1") {
          const raw = receipt.sourceResult.value as Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;
          const observation = raw.execution.status === "succeeded" ? raw.execution.observation : null;
          if (observation !== null && observation.kind === "file.read") {
            readReceipts.push(Object.freeze({
              operation: "file.read",
              offset: observation.offset,
              length: observation.length,
              bytesRead: observation.bytesRead,
              eof: observation.eof,
              observedObject: Object.freeze({
                dev: observation.identity.dev,
                ino: observation.identity.ino,
              }),
            }));
          }
        }
        return receipt;
      }
      if (callback.skill.id === CONTENT_INSPECT_SKILL_ID) {
        const bindings = callback.bindings as Readonly<{ scope: DirectoryRef; fileName: string | null }>;
        const listing = callback.state.cli.directoryListing;
        const candidates = listing === null || listing.coverage !== "complete"
          ? []
          : contentCandidates(listing.entries, bindings.fileName);
        const resolved = candidates.length === 1 ? candidates[0]! : null;
        if (resolved === null) {
          const step: CliAutonomousStepRecord = Object.freeze({
            stepIndex: sequence - 1,
            phase: "inspect_entry",
            goalProperty: "file.property.type",
            decisionMechanism: "trained_policy_v1",
            expectedHead: null,
            selectedHead: null,
            operation: null,
            executorInvoked: false,
            status: candidates.length > 1 ? "deferred" : "rejected",
            reason: candidates.length > 1 ? "candidate_ambiguous" : "candidate_missing",
            policyError: null,
          });
          recordStep(step);
          return Object.freeze({
            runId: null,
            executorInvoked: false,
            outcome: "rejected",
            sourceResult: null,
            newState: Object.freeze({
              id: `${requestId}:state-${sequence}`,
              value: Object.freeze({ stateId: `${requestId}:state-${sequence}`, session: callback.state.session, cli: callback.state.cli }),
            }),
            evidence: Object.freeze([]),
            executionErrors: Object.freeze([]),
            verificationErrors: Object.freeze([]),
            effect: Object.freeze({ knowledge: "none", confirmedEffects: Object.freeze([]), receiptRef: null }),
          });
        }
        const transition = await policy.step({
          goal: inspectGoalFor(resolved.path, input.session),
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state.cli,
        });
        transitions.push(transition);
        recordStep(buildStepRecord(transition, sequence - 1));
        return atomicReceipt({ requestId, sequence, transition });
      }
      if (!("target" in callback.goal)) {
        throw new TypeError("command policy received a non-policy goal");
      }
      const transition = await policy.step({
        goal: callback.goal as FilePropertyGoal,
        satisfactionThreshold: callback.satisfactionThreshold,
        state: callback.state.cli,
      });
      transitions.push(transition);
      recordStep(buildStepRecord(transition, sequence - 1));
      return atomicReceipt({ requestId, sequence, transition });
    },

    validateAtomicReceipt(raw: unknown) {
      return readAtomicReceipt(raw, DOMAIN_GUARDS as never);
    },

    measureProgress() {
      return { improved: false, reason: "none" as const, comparable: true };
    },
  };

  return Object.freeze({
    adapter,
    get steps() {
      return Object.freeze([...steps]);
    },
    get lastState() {
      return transitions.length === 0
        ? input.initialState
        : transitions[transitions.length - 1]!.observed_state_after;
    },
    get readReceipts() {
      return Object.freeze([...readReceipts]);
    },
    get transitions() {
      return Object.freeze([...transitions]);
    },
  });
}

export function createCliAutonomousDependencies(
  created: { adapter: CliAutonomousAdapter },
  grantedEffects: readonly string[],
  enabledSkillIds: readonly string[],
): RecursiveGoalDependencies<
  CliAutonomousGoal,
  CliAutonomousState,
  unknown,
  CliAutonomousEvidencePayload,
  CliAutonomousEffectFact,
  CliAutonomousReceiptPayload,
  CliAutonomousCursor
> {
  const atomicSkill: EnabledSkill = Object.freeze({
    id: ATOMIC_SKILL_ID,
    version: "1.0.0",
    mode: "atomic",
    capability: "cli.command",
    evaluatorId: ATOMIC_EVALUATOR_ID,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...grantedEffects]),
    retry: "never",
    effectClass: "mutating",
  });
  const compositeSkill: EnabledSkill = Object.freeze({
    id: COMPOSITE_SKILL_ID,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.session_cwd.ensure",
    evaluatorId: ROOT_EVALUATOR_ID,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...grantedEffects]),
    retry: "never",
    effectClass: "none",
  });
  const contentCompositeSkill: EnabledSkill = Object.freeze({
    id: CONTENT_COMPOSITE_SKILL_ID,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.content_bytes.equals",
    evaluatorId: CONTENT_ROOT_EVALUATOR_ID,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...grantedEffects]),
    retry: "never",
    effectClass: "none",
  });
  const contentInspectSkill: EnabledSkill = Object.freeze({
    id: CONTENT_INSPECT_SKILL_ID,
    version: "1.0.0",
    mode: "atomic",
    capability: "cli.content_inspect.entry",
    evaluatorId: CONTENT_INSPECT_EVALUATOR_ID,
    requiredEffects: Object.freeze(["filesystem.read", "process.exec"]),
    allowedEffects: Object.freeze(["filesystem.read", "process.exec"]),
    retry: "never",
    effectClass: "read_only",
  });
  const contentReadSkill: EnabledSkill = Object.freeze({
    id: CONTENT_READ_SKILL_ID,
    version: "1.0.0",
    mode: "atomic",
    capability: "cli.content_read.range",
    evaluatorId: CONTENT_READ_EVALUATOR_ID,
    requiredEffects: Object.freeze(["filesystem.read"]),
    allowedEffects: Object.freeze(["filesystem.read"]),
    retry: "never",
    effectClass: "read_only",
  });
  const enabled = new Set(enabledSkillIds);
  const enabledSkills = Object.freeze(
    [atomicSkill, compositeSkill, contentCompositeSkill, contentInspectSkill, contentReadSkill].filter(skill => enabled.has(skill.id)),
  );
  const enabledEvaluators: readonly EnabledEvaluator[] = Object.freeze([
    Object.freeze({
      id: ATOMIC_EVALUATOR_ID,
      goalType: "cli.autonomous.atomic",
      thresholdContract: "0..100",
      allowsPartialSatisfaction: false,
    }),
    Object.freeze({
      id: CONTENT_INSPECT_EVALUATOR_ID,
      goalType: "cli.content_inspect.observed",
      thresholdContract: "0..100",
      allowsPartialSatisfaction: false,
    }),
    Object.freeze({
      id: ROOT_EVALUATOR_ID,
      goalType: "file.property.relation.sessionCwd.equals",
      thresholdContract: "0..100",
      allowsPartialSatisfaction: false,
    }),
    Object.freeze({
      id: CONTENT_ROOT_EVALUATOR_ID,
      goalType: "file.property.content.bytes.equals",
      thresholdContract: "0..100",
      allowsPartialSatisfaction: false,
    }),
    Object.freeze({
      id: CONTENT_READ_EVALUATOR_ID,
      goalType: "cli.content_read.observed",
      thresholdContract: "0..100",
      allowsPartialSatisfaction: false,
    }),
  ]);
  const selectors: readonly SelectorBinding[] = Object.freeze([
    ...(enabled.has(ATOMIC_SKILL_ID)
      ? [Object.freeze({ id: ATOMIC_SELECTOR_ID, skillIds: Object.freeze([ATOMIC_SKILL_ID]) })]
      : []),
    ...(enabled.has(COMPOSITE_SKILL_ID)
      ? [Object.freeze({ id: ROOT_SELECTOR_ID, skillIds: Object.freeze([COMPOSITE_SKILL_ID]) })]
      : []),
    ...(enabled.has(CONTENT_COMPOSITE_SKILL_ID)
      ? [Object.freeze({ id: CONTENT_ROOT_SELECTOR_ID, skillIds: Object.freeze([CONTENT_COMPOSITE_SKILL_ID]) })]
      : []),
    ...(enabled.has(CONTENT_INSPECT_SKILL_ID)
      ? [Object.freeze({ id: CONTENT_INSPECT_SELECTOR_ID, skillIds: Object.freeze([CONTENT_INSPECT_SKILL_ID]) })]
      : []),
    ...(enabled.has(CONTENT_READ_SKILL_ID)
      ? [Object.freeze({ id: CONTENT_READ_SELECTOR_ID, skillIds: Object.freeze([CONTENT_READ_SKILL_ID]) })]
      : []),
  ]);
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills,
    enabledEvaluators,
    selectors,
    comparators: COMPARATORS,
    grantedEffects: new Set(grantedEffects),
  });
}

// The content root is executed by the shared recursive controller. These helpers
// express the content composite skill below; the old hand-rolled chain is removed
// so no path can bypass the generic budget/limits controller.

function nativeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code.length !== 0 && code !== "undefined") return code;
  }
  return "UNKNOWN";
}

const OBJECT_CHANGED_BIND_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ESTALE",
  "EINVAL",
  "READ_TARGET_CHANGED",
  "STALE_REFERENCE",
]);

const OBJECT_CHANGED_READ_CODES: ReadonlySet<string> = new Set([
  "STALE_REFERENCE",
  "READ_TARGET_CHANGED",
]);

type ContentReadDisposition = Readonly<{
  outcome: "failed" | "rejected";
  reason: string;
  nativeCode: string | null;
}>;

function contentReadDisposition(code: string | null): ContentReadDisposition {
  if (code === "EFFECT_DENIED") {
    return Object.freeze({ outcome: "rejected", reason: "permission_denied", nativeCode: code });
  }
  if (code !== null && (OBJECT_CHANGED_BIND_CODES.has(code) || OBJECT_CHANGED_READ_CODES.has(code))) {
    return Object.freeze({ outcome: "failed", reason: "object_changed", nativeCode: code });
  }
  return Object.freeze({ outcome: "failed", reason: "binding_failed", nativeCode: code });
}

function deriveCwd(callback: DerivationInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload, CliAutonomousCursor>) {
  const bindings = callback.bindings as Readonly<{
    session: SessionRef;
    initialTrusted: boolean;
  }>;
  const allowedEffects = callback.skill.allowedEffects;
  const observed = cwdFresh(callback.state)
    && (bindings.initialTrusted === true || hasPwdTransition(callback.evidence));
  if (!observed) {
    return Object.freeze({
      conditions: Object.freeze([
        condition("observe-cwd", pwdGoal(bindings.session), callback.bindings, ATOMIC_EVALUATOR_ID, ATOMIC_SELECTOR_ID, allowedEffects),
      ]),
      nextCursor: Object.freeze({ phase: "observed" }),
      expansion: "more" as const,
    });
  }
  return Object.freeze({
    conditions: Object.freeze([
      condition("ensure-cwd", callback.goal, callback.bindings, ATOMIC_EVALUATOR_ID, ATOMIC_SELECTOR_ID, allowedEffects),
    ]),
    nextCursor: Object.freeze({ phase: "verified" }),
    expansion: "closed" as const,
  });
}

function listGoalFor(scope: DirectoryRef): FilePropertyGoal {
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: scope,
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function inspectGoalFor(absolutePath: string, session: SessionRef): FilePropertyGoal {
  const inspectRef: PathRef = Object.freeze({
    kind: "cli.path",
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: absolutePath,
  });
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({ kind: "cli.entry-query", ref: inspectRef, followSymlinks: false }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function contentCandidates(
  entries: readonly Readonly<{ name: string; path: string; type: string }>[],
  fileName: string | null,
): readonly Readonly<{ name: string; path: string; type: string }>[] {
  return fileName === null
    ? entries.filter(entry => entry.type === "file")
    : entries.filter(entry => entry.name === fileName);
}

function deriveContent(
  callback: DerivationInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload, CliAutonomousCursor>,
) {
  const bindings = callback.bindings as Readonly<{ scope: DirectoryRef; fileName: string | null }>;
  const root = callback.goal as ContentBytesEqualsGoal;
  const allowedEffects = callback.skill.allowedEffects;
  if (callback.cursor !== null) {
    return Object.freeze({
      conditions: Object.freeze([]),
      nextCursor: Object.freeze({ phase: "terminal" }),
      expansion: "closed" as const,
    });
  }
  const readGoal: ContentReadGoal = Object.freeze({
    kind: "cli.content-read",
    property: CONTENT_BYTES_PROPERTY,
    range: root.requirement.range,
    expectedBase64: root.requirement.expectedBase64,
  });
  return Object.freeze({
    conditions: Object.freeze([
      condition(
        "observe-scope-entries",
        listGoalFor(bindings.scope),
        callback.bindings,
        ATOMIC_EVALUATOR_ID,
        ATOMIC_SELECTOR_ID,
        allowedEffects,
      ),
      condition(
        "verify-candidate-entry",
        Object.freeze({ kind: "cli.content-inspect", property: "file.property.type" }),
        callback.bindings,
        CONTENT_INSPECT_EVALUATOR_ID,
        CONTENT_INSPECT_SELECTOR_ID,
        allowedEffects,
        ["observe-scope-entries"],
      ),
      condition(
        "read-trusted-range",
        readGoal,
        callback.bindings,
        CONTENT_READ_EVALUATOR_ID,
        CONTENT_READ_SELECTOR_ID,
        allowedEffects,
        ["verify-candidate-entry"],
      ),
    ]),
    nextCursor: Object.freeze({ phase: "terminal" }),
    expansion: "closed" as const,
  });
}

function contentReadStepRecord(
  sequence: number,
  receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>,
  goal: ContentReadGoal,
): { step: CliAutonomousStepRecord; evidence: ReturnType<typeof readEvidencePayload> } {
  const execution = receipt.execution;
  const failure = execution.status === "failed" ? execution.error : null;
  const observation = execution.status === "succeeded" ? execution.observation : null;
  const succeeded = observation?.kind === "file.read";
  const disposition = succeeded
    ? Object.freeze({ outcome: "failed" as const, reason: "content_read", nativeCode: null })
    : contentReadDisposition(failure?.code ?? null);
  const step: CliAutonomousStepRecord = Object.freeze({
    stepIndex: sequence,
    phase: "read-range",
    goalProperty: "file.property.content.bytes",
    decisionMechanism: "deterministic_exec",
    expectedHead: null,
    selectedHead: null,
    operation: "file.read",
    executorInvoked: execution.executorInvoked,
    status: succeeded ? "satisfied" : (disposition.outcome === "rejected" ? "rejected" : "failed"),
    reason: succeeded ? "content_read" : (failure?.code ?? disposition.reason),
    policyError: null,
  });
  const evidence = readEvidencePayload({
    kind: "cli.autonomous.content-read.v1",
    read: Object.freeze({
      operation: "file.read",
      offset: observation?.kind === "file.read" ? observation.offset : 0,
      length: observation?.kind === "file.read" ? observation.length : 0,
      bytesRead: observation?.kind === "file.read" ? observation.bytesRead : 0,
      eof: observation?.kind === "file.read" ? observation.eof : false,
      bytes: observation?.kind === "file.read" ? observation.bytes : "",
      rangeBytes: observation?.kind === "file.read" ? observation.length : 0,
      expectedBase64: goal.expectedBase64,
      observedObject: observation?.kind === "file.read"
        ? observation.identity
        : { dev: null, ino: null },
      status: succeeded ? "succeeded" : (disposition.outcome === "rejected" ? "rejected" : "failed"),
      reason: succeeded ? "content_read" : disposition.reason,
    }),
  });
  return { step, evidence };
}

function contentReadFailureReceipt(
  callback: AtomicInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload>,
  sequence: number,
  step: CliAutonomousStepRecord,
  disposition: ContentReadDisposition,
  recordStep: (step: CliAutonomousStepRecord) => void,
): AtomicReceipt<CliAutonomousState, CliAutonomousEvidencePayload, CliAutonomousEffectFact, CliAutonomousReceiptPayload> {
  const requestId = callback.context.requestId;
  const stateId = `${requestId}:state-${sequence}`;
  const id = `${requestId}:transition-${sequence}`;
  recordStep(step);
  const evidence = readEvidencePayload({
    kind: "cli.autonomous.content-read.v1",
    read: Object.freeze({
      operation: "file.read",
      offset: 0,
      length: 0,
      bytesRead: 0,
      eof: false,
      bytes: "",
      rangeBytes: 0,
      expectedBase64: "",
      observedObject: Object.freeze({ dev: null, ino: null }),
      status: disposition.outcome === "rejected" ? "rejected" : "failed",
      reason: disposition.reason,
    }),
  });
  const diagnostic: AdapterDiagnostic = Object.freeze({
    diagnosticId: `${id}:execution`,
    code: disposition.outcome === "rejected" ? "effect_denied" : "execution_failed",
    stage: step.executorInvoked ? "execution" : "binding",
    sourceCategory: "cli.command_execution",
    message: disposition.reason,
    nativeCode: disposition.nativeCode,
    refs: Object.freeze([id]),
  });
  return Object.freeze({
    runId: null,
    executorInvoked: false,
    outcome: disposition.outcome,
    sourceResult: Object.freeze({
      tag: "cli.content-read.bind.v1",
      value: Object.freeze({ kind: "cli.content-read.bind.v1" as const, reason: disposition.reason }),
    }),
    newState: Object.freeze({
      id: stateId,
      value: Object.freeze({
        stateId,
        session: callback.state.session,
        cli: callback.state.cli,
      }),
    }),
    evidence: Object.freeze([Object.freeze({
      id: `${requestId}:evidence-${sequence}`,
      stateRef: stateId,
      payload: evidence,
      validity: "valid" as const,
    })]),
    executionErrors: Object.freeze([diagnostic]),
    verificationErrors: Object.freeze([]),
    effect: Object.freeze({ knowledge: "none", confirmedEffects: Object.freeze([]), receiptRef: null }),
  });
}

async function executeContentRead(
  callback: AtomicInput<CliAutonomousGoal, CliAutonomousState, unknown, CliAutonomousEvidencePayload>,
  input: CliAutonomousAdapterInput,
  sequence: number,
  recordStep: (step: CliAutonomousStepRecord) => void,
): Promise<AtomicReceipt<CliAutonomousState, CliAutonomousEvidencePayload, CliAutonomousEffectFact, CliAutonomousReceiptPayload>> {
  const goal = callback.goal as ContentReadGoal;
  const requestId = callback.context.requestId;
  const stateId = `${requestId}:state-${sequence}`;
  const bindings = callback.bindings as Readonly<{ scope: DirectoryRef; fileName: string | null }>;
  const listing = callback.state.cli.directoryListing;
  const candidates = listing === null || listing.coverage !== "complete"
    ? []
    : contentCandidates(listing.entries, bindings.fileName);
  const candidate = candidates.length === 1 ? candidates[0]! : null;
  let ref: ObservedObjectRef;
  if (candidate === null) {
    const reason = candidates.length > 1 ? "candidate_ambiguous" : "candidate_missing";
    return contentReadFailureReceipt(
      callback,
      sequence,
      Object.freeze({
        stepIndex: sequence,
        phase: "bind-range",
        goalProperty: "file.property.content.bytes",
        decisionMechanism: "deterministic_exec",
        expectedHead: null,
        selectedHead: null,
        operation: null,
        executorInvoked: false,
        status: "rejected",
        reason,
        policyError: null,
      }),
      Object.freeze({ outcome: "rejected", reason, nativeCode: null }),
      recordStep,
    );
  }
  const knowledge = callback.state.cli.entryKnowledge ?? null;
  if (
    knowledge !== null
    && knowledge.entryExists === true
    && knowledge.type !== null
    && knowledge.type !== "regular"
    && knowledge.absolutePath === candidate.path
  ) {
    return contentReadFailureReceipt(
      callback,
      sequence,
      Object.freeze({
        stepIndex: sequence,
        phase: "bind-range",
        goalProperty: "file.property.content.bytes",
        decisionMechanism: "deterministic_exec",
        expectedHead: null,
        selectedHead: null,
        operation: null,
        executorInvoked: false,
        status: "rejected",
        reason: "candidate_not_regular",
        policyError: null,
      }),
      Object.freeze({ outcome: "rejected", reason: "candidate_not_regular", nativeCode: null }),
      recordStep,
    );
  }
  if (
    knowledge === null
    || knowledge.entryExists !== true
    || knowledge.type !== "regular"
    || knowledge.absolutePath !== candidate.path
  ) {
    const reason = "object_changed";
    const step: CliAutonomousStepRecord = Object.freeze({
      stepIndex: sequence,
      phase: "bind-range",
      goalProperty: "file.property.content.bytes",
      decisionMechanism: "deterministic_exec",
      expectedHead: null,
      selectedHead: null,
      operation: null,
      executorInvoked: false,
      status: "failed",
      reason,
      policyError: null,
    });
    return contentReadFailureReceipt(
      callback,
      sequence,
      step,
      Object.freeze({ outcome: "failed", reason, nativeCode: null }),
      recordStep,
    );
  }
  try {
    ref = await input.sandbox.bindFile(input.session, candidate.path);
  } catch (error) {
    const code = nativeErrorCode(error);
    const disposition = contentReadDisposition(code);
    const step: CliAutonomousStepRecord = Object.freeze({
      stepIndex: sequence,
      phase: "bind-range",
      goalProperty: "file.property.content.bytes",
      decisionMechanism: "deterministic_exec",
      expectedHead: null,
      selectedHead: null,
      operation: null,
      executorInvoked: false,
      status: disposition.outcome === "rejected" ? "rejected" : "failed",
      reason: disposition.reason,
      policyError: null,
    });
    return contentReadFailureReceipt(callback, sequence, step, disposition, recordStep);
  }
  const currentRevision = input.sandbox.getSession(input.session).revision;
  const identityMatches = knowledge !== null
    && knowledge.entryExists === true
    && knowledge.identity.dev !== null
    && knowledge.identity.ino !== null
    && String(ref.identity.dev) === String(knowledge.identity.dev)
    && String(ref.identity.ino) === String(knowledge.identity.ino);
  if (
    !identityMatches
    || ref.sessionRevision !== currentRevision
    || knowledge === null
    || knowledge.sessionRevision !== currentRevision
  ) {
    const step: CliAutonomousStepRecord = Object.freeze({
      stepIndex: sequence,
      phase: "bind-range",
      goalProperty: "file.property.content.bytes",
      decisionMechanism: "deterministic_exec",
      expectedHead: null,
      selectedHead: null,
      operation: null,
      executorInvoked: false,
      status: "failed",
      reason: "object_changed",
      policyError: null,
    });
    return contentReadFailureReceipt(
      callback,
      sequence,
      step,
      Object.freeze({ outcome: "failed", reason: "object_changed", nativeCode: "STALE_REFERENCE" }),
      recordStep,
    );
  }
  const raw = await input.sandbox.execute({
    operation: "file.read",
    parameters: {
      ref,
      offset: goal.range.offset,
      length: goal.range.length,
    },
  });
  const { step, evidence } = contentReadStepRecord(sequence, raw, goal);
  recordStep(step);
  const execution = raw.execution;
  const failure = execution.status === "failed" ? execution.error : null;
  const succeeded = execution.status === "succeeded" && execution.observation.kind === "file.read";
  const disposition = succeeded
    ? Object.freeze({ outcome: "succeeded" as const, reason: "content_read", nativeCode: null })
    : contentReadDisposition(failure?.code ?? null);
  const diagnostic: AdapterDiagnostic | null = disposition.outcome === "failed"
    ? Object.freeze({
        diagnosticId: `${requestId}:transition-${sequence}:execution`,
        code: "execution_failed",
        stage: "execution",
        sourceCategory: "cli.command_execution",
        message: disposition.reason,
        nativeCode: disposition.nativeCode,
        refs: Object.freeze([`${requestId}:transition-${sequence}`]),
      })
    : null;
  return Object.freeze({
    runId: execution.runId,
    executorInvoked: execution.executorInvoked,
    outcome: disposition.outcome,
    sourceResult: Object.freeze({ tag: "cli.content-read.receipt.v1", value: raw }),
    newState: Object.freeze({ id: stateId, value: Object.freeze({ stateId, session: raw.session_after, cli: callback.state.cli }) }),
    evidence: Object.freeze([Object.freeze({
      id: `${requestId}:evidence-${sequence}`,
      stateRef: stateId,
      payload: evidence,
      validity: "valid" as const,
    })]),
    executionErrors: Object.freeze(diagnostic === null ? [] : [diagnostic]),
    verificationErrors: Object.freeze([]),
    effect: Object.freeze({ knowledge: "none", confirmedEffects: Object.freeze([]), receiptRef: null }),
  });
}

export { RECURSIVE_REQUEST_SCHEMA };
