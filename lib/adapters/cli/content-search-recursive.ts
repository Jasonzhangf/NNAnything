import {
  readAtomicReceipt,
  readRecursiveGoalContinuation,
  type AdapterDiagnostic,
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
  type SelectionInput,
  type SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import { relative } from "node:path";
import {
  createCliCommandPolicy,
  type CliCommandPolicy,
} from "../../cli-goal.js";
import type { DirectoryObjectRef } from "./entry-search-contract.js";
import type {
  CliCommandSample,
  CliCommandTransition,
} from "../../nodes/cli-command.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { PathRef } from "../../filters/cli-file-property.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  SemanticCallReceipt,
  SessionRef,
} from "./filesystem-sandbox.js";
import type { EntryKind, ObservedObjectRef } from "./entry-inspection.js";
import {
  readContentSearchCursor,
  readContentSearchEffectFact,
  readContentSearchEvidencePayload,
  readContentSearchGoal,
  readContentSearchReceiptPayload,
  readContentSearchState,
  type ContentSearchBindings,
  type ContentSearchCandidateFact,
  type ContentSearchCursor,
  type ContentSearchEffectFact,
  type ContentSearchEvidencePayload,
  type ContentSearchFileRef,
  type ContentSearchGoal,
  type ContentSearchInspectGoal,
  type ContentSearchListGoal,
  type ContentSearchOrder,
  type ContentSearchReadFact,
  type ContentSearchReadGoal,
  type ContentSearchReceiptPayload,
  type ContentSearchRequest,
  type ContentSearchScan,
  type ContentSearchState,
} from "./content-search-contract.js";
import {
  contains,
  decideContentSearchRoot,
  initialCandidates,
  inspectedFactFromTransition,
  isStaleReadCode,
  lineColumn,
  listingFactFromTransition,
} from "../../filters/cli-content-search.js";

export const CONTENT_ROOT_COMPOSITE_SKILL = "content-search.composite";
export const CONTENT_LIST_ATOMIC_SKILL = "content-search.list";
export const CONTENT_INSPECT_ATOMIC_SKILL = "content-search.inspect";
export const CONTENT_READ_ATOMIC_SKILL = "content-search.read";
export const CONTENT_ROOT_EVALUATOR = "content-search-root";
export const CONTENT_LIST_EVALUATOR = "content-search-list";
export const CONTENT_INSPECT_EVALUATOR = "content-search-inspect";
export const CONTENT_READ_EVALUATOR = "content-search-read";
export const CONTENT_ROOT_SELECTOR = "content-search-root-selector";
export const CONTENT_LIST_SELECTOR = "content-search-list-selector";
export const CONTENT_INSPECT_SELECTOR = "content-search-inspect-selector";
export const CONTENT_READ_SELECTOR = "content-search-read-selector";

const EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

export const CONTENT_SEARCH_SKILLS = Object.freeze([
  Object.freeze({
    id: CONTENT_ROOT_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "content.search",
    evaluatorId: CONTENT_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: CONTENT_LIST_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.list",
    evaluatorId: CONTENT_LIST_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: CONTENT_INSPECT_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.inspect",
    evaluatorId: CONTENT_INSPECT_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: CONTENT_READ_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "file.read",
    evaluatorId: CONTENT_READ_EVALUATOR,
    requiredEffects: Object.freeze(["filesystem.read"]),
    allowedEffects: Object.freeze(["filesystem.read"]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const CONTENT_SEARCH_EVALUATORS = Object.freeze([
  Object.freeze({
    id: CONTENT_ROOT_EVALUATOR,
    goalType: "file.property.content.bytes.contains",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: CONTENT_LIST_EVALUATOR,
    goalType: "file.property.directory.entries.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: CONTENT_INSPECT_EVALUATOR,
    goalType: "file.property.type.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: CONTENT_READ_EVALUATOR,
    goalType: "file.property.content.bytes.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const CONTENT_SEARCH_SELECTORS = Object.freeze([
  Object.freeze({ id: CONTENT_ROOT_SELECTOR, skillIds: Object.freeze([CONTENT_ROOT_COMPOSITE_SKILL]) }),
  Object.freeze({ id: CONTENT_LIST_SELECTOR, skillIds: Object.freeze([CONTENT_LIST_ATOMIC_SKILL]) }),
  Object.freeze({ id: CONTENT_INSPECT_SELECTOR, skillIds: Object.freeze([CONTENT_INSPECT_ATOMIC_SKILL]) }),
  Object.freeze({ id: CONTENT_READ_SELECTOR, skillIds: Object.freeze([CONTENT_READ_ATOMIC_SKILL]) }),
]);

export const CONTENT_SEARCH_COMPARATORS: RecursiveGoalComparators<
  unknown,
  unknown,
  ContentSearchState,
  ContentSearchEvidencePayload
> = Object.freeze({
  sameGoal: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<ContentSearchState, ContentSearchEvidencePayload>,
    right: FactSnapshot<ContentSearchState, ContentSearchEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

export type ContentSearchAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  scan: ContentSearchScan;
  order: ContentSearchOrder;
  duplicateReadProbe?: readonly string[];
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

export type ContentSearchAdapter = RecursiveGoalAdapter<
  unknown,
  ContentSearchState,
  unknown,
  ContentSearchEvidencePayload,
  ContentSearchEffectFact,
  ContentSearchReceiptPayload,
  unknown
>;

export type ContentSearchAdapterHandle = Readonly<{
  adapter: ContentSearchAdapter;
  calls: Readonly<{
    validateRequest: number;
    supports: number;
    evaluate: number;
    select: number;
    derive: number;
    executeAtomic: number;
    validateAtomicReceipt: number;
    measureProgress: number;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (!path.startsWith("/")) throw new TypeError(`${label} must be absolute`);
  return path;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function readGoal(value: unknown): unknown {
  return readContentSearchGoal(value);
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("content search bindings must be an object");
  exactKeys(value, ["session", "directory", "fileCondition", "cardinality", "needle"], "content search bindings");
  return Object.freeze({ ...value });
}

function readState(value: unknown): ContentSearchState {
  return readContentSearchState(value);
}

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readContentSearchEvidencePayload,
  effectFact: readContentSearchEffectFact,
  sameEffectFact: (left: ContentSearchEffectFact, right: ContentSearchEffectFact) =>
    JSON.stringify(left) === JSON.stringify(right),
  receiptPayload: readContentSearchReceiptPayload,
  cursor: readContentSearchCursor,
  sameGoal: CONTENT_SEARCH_COMPARATORS.sameGoal,
  sameBindings: CONTENT_SEARCH_COMPARATORS.sameBindings,
  sameFacts: CONTENT_SEARCH_COMPARATORS.sameFacts,
  sameCursor: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
});

function stateEvidenceRefs(
  state: ContentSearchState,
  evidence: readonly { id: string; stateRef: string; validity: string }[],
): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

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

async function evaluateRoot(
  input: EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const decision = decideContentSearchRoot(input.state);
  if (decision.result === "satisfied") return evaluation(CONTENT_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  if (decision.result === "unsatisfied") return evaluation(CONTENT_ROOT_EVALUATOR, "unsatisfied", 0, []);
  return evaluation(CONTENT_ROOT_EVALUATOR, "unknown", null, []);
}

async function evaluateList(
  input: EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const listing = input.state.listing;
  if (listing !== null && listing.coverage === "complete" && listing.errors.length === 0 && listing.sourceRun !== null) {
    return evaluation(CONTENT_LIST_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(CONTENT_LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(
  input: EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const goal = input.goal as ContentSearchInspectGoal;
  const knowledge = input.state.cli.entryKnowledge;
  if (
    knowledge !== null &&
    knowledge !== undefined &&
    knowledge.kind === "entry.inspect" &&
    knowledge.query.followSymlinks === false &&
    knowledge.query.ref.kind === "cli.path" &&
    knowledge.query.ref.path === goal.target.ref.path &&
    knowledge.query.ref.scenarioId === goal.target.ref.scenarioId &&
    knowledge.query.ref.sessionId === goal.target.ref.sessionId &&
    knowledge.entryExists === true &&
    knowledge.observedWith !== null &&
    knowledge.type !== null &&
    knowledge.identity.dev !== null &&
    knowledge.identity.ino !== null
  ) {
    return evaluation(CONTENT_INSPECT_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(CONTENT_INSPECT_EVALUATOR, "unknown", null, []);
}

async function evaluateRead(
  input: EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const goal = input.goal as ContentSearchReadGoal;
  const candidate = input.state.candidates.find(item =>
    item.fileRef !== null &&
    item.fileRef.sourceRun === goal.target.ref.sourceRun &&
    item.fileRef.absolutePath === goal.target.ref.absolutePath,
  );
  const read = candidate?.read ?? null;
  const staleRefused = read === null && input.evidence.some(item =>
    item.payload.kind === "cli.content-search.read.v1" &&
    item.payload.receipt.execution.status === "failed" &&
    isStaleReadCode(item.payload.receipt.execution.error.code),
  );
  if (staleRefused) {
    return evaluation(CONTENT_READ_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  if (
    read !== null &&
    read.sourceRun !== null &&
    read.refSourceRun === goal.target.ref.sourceRun &&
    read.revision === goal.target.ref.sessionRevision &&
    read.offset === goal.requirement.range.offset &&
    read.length === goal.requirement.range.length &&
    read.attempt === goal.requirement.attempt &&
    read.bytesRead !== null
  ) {
    return evaluation(CONTENT_READ_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(CONTENT_READ_EVALUATOR, "unknown", null, []);
}

function isRootGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property" &&
    value.property === "file.property.content.bytes" &&
    isRecord(value.requirement) &&
    value.requirement.kind === "contains" &&
    isRecord(value.target) &&
    value.target.kind === "cli.content-search-scope";
}

function isListGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property" &&
    value.property === "file.property.directory.entries" &&
    isRecord(value.requirement) &&
    value.requirement.kind === "observed";
}

function isInspectGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property" &&
    value.property === "file.property.type" &&
    isRecord(value.target) &&
    value.target.kind === "cli.entry-query" &&
    value.target.followSymlinks === false;
}

function isReadGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property" &&
    value.property === "file.property.content.bytes" &&
    isRecord(value.requirement) &&
    value.requirement.kind === "observed" &&
    isRecord(value.target) &&
    value.target.kind === "cli.file";
}

function supports(input: SupportsInput<unknown, unknown>): boolean {
  if (input.skill.id === CONTENT_ROOT_COMPOSITE_SKILL) return isRootGoal(input.goal);
  if (input.skill.id === CONTENT_LIST_ATOMIC_SKILL) return isListGoal(input.goal);
  if (input.skill.id === CONTENT_INSPECT_ATOMIC_SKILL) return isInspectGoal(input.goal);
  if (input.skill.id === CONTENT_READ_ATOMIC_SKILL) return isReadGoal(input.goal);
  return false;
}

async function select(
  input: SelectionInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
) {
  const first = input.candidates[0];
  return first === undefined
    ? { kind: "no_capability" as const, searchedSkillIds: [] }
    : { kind: "selected" as const, skillId: first.id };
}

function condition(
  id: string,
  goal: unknown,
  bindings: unknown,
  selectorId: string,
  evaluatorId: string,
  allowedEffects: readonly string[],
) {
  return Object.freeze({
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId,
    selectorId,
    mode: "atomic" as const,
    dependsOn: Object.freeze([]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...allowedEffects]),
  });
}

function policyDirectoryRef(directory: DirectoryObjectRef, cwd: string): DirectoryRef {
  if ("absolutePath" in directory) {
    const path = relative(cwd, directory.absolutePath) || ".";
    return Object.freeze({
      kind: "cli.directory",
      scenarioId: directory.scenarioId,
      sessionId: directory.sessionId,
      path,
    });
  }
  return directory;
}

function listGoal(bindings: unknown, cwd: string): ContentSearchListGoal {
  const input = bindings as ContentSearchBindings;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: policyDirectoryRef(input.directory, cwd),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function inspectGoal(bindings: unknown, candidatePath: string): ContentSearchInspectGoal {
  const input = bindings as ContentSearchBindings;
  const ref: PathRef = Object.freeze({
    kind: "cli.path",
    scenarioId: input.directory.scenarioId,
    sessionId: input.directory.sessionId,
    path: candidatePath,
  });
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({ kind: "cli.entry-query", ref, followSymlinks: false }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function readGoalAtAttempt(ref: ContentSearchFileRef, size: number, attempt: number): ContentSearchReadGoal {
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({ kind: "cli.file", ref, requiredType: "regular" }),
    requirement: Object.freeze({
      kind: "observed",
      range: Object.freeze({ offset: 0, length: size }),
      attempt,
    }),
  });
}

function inputSession(bindings: unknown): SessionRef {
  return (bindings as ContentSearchBindings).session;
}

type NextAction =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "inspect"; candidate: ContentSearchCandidateFact }>
  | Readonly<{ kind: "read"; candidate: ContentSearchCandidateFact; duplicate: boolean }>
  | Readonly<{ kind: "close" }>;

function nextAction(
  state: ContentSearchState,
  phase: ContentSearchCursor["phase"] | null,
  scan: ContentSearchScan,
  duplicateReadProbe: readonly string[],
): NextAction {
  if (state.listing === null) return Object.freeze({ kind: "list" });
  if (phase === "inspected") {
    const inspected = state.candidates.find(candidate => candidate.inspected !== null && candidate.outcome === "pending");
    if (inspected !== undefined) return Object.freeze({ kind: "read", candidate: inspected, duplicate: false });
  }
  const duplicate = state.candidates.find(candidate =>
    candidate.outcome === "negative" &&
    !candidate.duplicateRead &&
    duplicateReadProbe.includes(candidate.name) &&
    candidate.fileRef !== null,
  );
  if (duplicate !== undefined) return Object.freeze({ kind: "read", candidate: duplicate, duplicate: true });
  const uninspected = state.candidates.find(candidate => candidate.inspected === null && candidate.outcome === "pending");
  if (uninspected !== undefined) return Object.freeze({ kind: "inspect", candidate: uninspected });
  const toRead = state.candidates.find(candidate => candidate.inspected !== null && candidate.outcome === "pending");
  if (toRead !== undefined) return Object.freeze({ kind: "read", candidate: toRead, duplicate: false });
  void scan;
  return Object.freeze({ kind: "close" });
}

async function derive(
  input: DerivationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload, unknown>,
  scan: ContentSearchScan,
  duplicateReadProbe: readonly string[],
) {
  if (!isRootGoal(input.goal) || input.skill.id !== CONTENT_ROOT_COMPOSITE_SKILL) {
    throw new TypeError("content search composite derivation received an incompatible frame");
  }
  const cursor = input.cursor as ContentSearchCursor | null;
  const action = cursor === null
    ? Object.freeze({ kind: "list" as const })
    : nextAction(input.state, cursor.phase, scan, duplicateReadProbe);
  if (action.kind === "list") {
    return Object.freeze({
      conditions: Object.freeze([
        condition("observe-direct-entries", listGoal(input.bindings, input.state.session.cwd), input.bindings,
          CONTENT_LIST_SELECTOR, CONTENT_LIST_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "listed" }),
      expansion: "more",
    });
  }
  if (action.kind === "inspect") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(`verify-${action.candidate.name}`, inspectGoal(input.bindings, action.candidate.path), input.bindings,
          CONTENT_INSPECT_SELECTOR, CONTENT_INSPECT_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "inspected" }),
      expansion: "more",
    });
  }
  if (action.kind === "read") {
    const ref = action.candidate.fileRef;
    const size = action.candidate.inspected?.size;
    if (ref === null || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return Object.freeze({
        conditions: Object.freeze([]),
        nextCursor: Object.freeze({ phase: "closed" }),
        expansion: "closed",
      });
    }
    const attempt = action.duplicate ? (action.candidate.read?.attempt ?? 0) + 1 : 1;
    return Object.freeze({
      conditions: Object.freeze([
        condition(`read-${action.candidate.name}:attempt-${attempt}`,
          readGoalAtAttempt(ref, size, attempt), input.bindings,
          CONTENT_READ_SELECTOR, CONTENT_READ_EVALUATOR, ["filesystem.read"]),
      ]),
      nextCursor: Object.freeze({ phase: "read" }),
      expansion: "more",
    });
  }
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({ phase: "closed" }),
    expansion: "closed",
  });
}

async function validateDirectoryBinding(
  input: Readonly<{ sandbox: CliFilesystemSandbox; rootBindings: unknown }>,
): Promise<void> {
  const bindings = input.rootBindings as ContentSearchBindings;
  const cwd = input.sandbox.getSession(bindings.session).cwd;
  if ("absolutePath" in bindings.directory) {
    await input.sandbox.validateObservedObject(bindings.directory as ObservedObjectRef & Readonly<{ kind: "cli.directory" }>);
  } else {
    await input.sandbox.validateDirectoryRef(bindings.directory);
  }
  await input.sandbox.resolveDirectory(policyDirectoryRef(bindings.directory, cwd));
}

function executeList(
  policy: CliCommandPolicy,
  input: Readonly<{ goal: ContentSearchListGoal; satisfactionThreshold: number; state: ContentSearchState }>,
) {
  return policy.step({ goal: input.goal, satisfactionThreshold: input.satisfactionThreshold, state: input.state.cli });
}

function executeInspect(
  policy: CliCommandPolicy,
  input: Readonly<{ goal: ContentSearchInspectGoal; satisfactionThreshold: number; state: ContentSearchState }>,
) {
  return policy.step({ goal: input.goal, satisfactionThreshold: input.satisfactionThreshold, state: input.state.cli });
}

async function executeRead(
  sandbox: CliFilesystemSandbox,
  input: Readonly<{ goal: ContentSearchReadGoal; state: ContentSearchState }>,
) {
  return sandbox.execute({
    operation: "file.read",
    parameters: {
      ref: input.goal.target.ref,
      offset: input.goal.requirement.range.offset,
      length: input.goal.requirement.range.length,
    },
  });
}

function transitionId(requestId: string, sequence: number): string {
  return `${requestId}:transition-${sequence}`;
}

function stateId(requestId: string, sequence: number): string {
  return `${requestId}:state-${sequence}`;
}

function evidenceId(requestId: string, sequence: number): string {
  return `${requestId}:evidence-${sequence}`;
}

function transitionDiagnostics(transition: CliCommandTransition, id: string): {
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
} {
  const executionErrors: AdapterDiagnostic[] = [];
  const verificationErrors: AdapterDiagnostic[] = [];
  if (transition.status === "rejected" && transition.reason !== "unexpected_head") {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push(Object.freeze({
      diagnosticId: `${id}:binding`,
      code: failure?.code === "EFFECT_DENIED" ? "effect_denied" : "invalid_binding",
      stage: "binding" as const,
      sourceCategory: "cli.directory_binding",
      message: failure?.message ?? transition.reason,
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    }));
  } else if (transition.status === "failed") {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push(Object.freeze({
      diagnosticId: `${id}:execution`,
      code: "execution_failed" as const,
      stage: "execution" as const,
      sourceCategory: "cli.command_execution",
      message: failure?.message ?? transition.reason,
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    }));
  }
  return { executionErrors: Object.freeze(executionErrors), verificationErrors: Object.freeze(verificationErrors) };
}

function outcomeOf(transition: CliCommandTransition): "succeeded" | "failed" | "rejected" | "unknown" {
  if (transition.status === "achieved") return "succeeded";
  if (transition.status === "unknown") return "unknown";
  if (transition.status === "rejected") return "rejected";
  return "failed";
}

function atomicReceiptForTransition(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    transition: CliCommandTransition;
    expectedHead: string;
    session: SessionRef;
    state: ContentSearchState;
    nextState: ContentSearchState;
  }>,
): AtomicReceipt<ContentSearchState, ContentSearchEvidencePayload, ContentSearchEffectFact, ContentSearchReceiptPayload> {
  const transition = input.transition;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextState = Object.freeze({
    id: stateId(input.context.requestId, input.sequence),
    value: Object.freeze({ ...input.nextState, stateId: stateId(input.context.requestId, input.sequence) }),
  });
  const evidence = Object.freeze([
    Object.freeze({
      id: evidenceId(input.context.requestId, input.sequence),
      stateRef: nextState.id,
      payload: Object.freeze({
        kind: "cli.content-search.transition.v1" as const,
        transitionId: id,
        stateId: nextState.id,
        transition,
      }),
      validity: "valid" as const,
    }),
  ]);
  const errors = transitionDiagnostics(transition, id);
  const effect: AtomicReceipt<ContentSearchState, ContentSearchEvidencePayload, ContentSearchEffectFact, ContentSearchReceiptPayload>["effect"] =
    Object.freeze({ knowledge: "none", confirmedEffects: Object.freeze([]), receiptRef: null });
  return Object.freeze({
    runId: transition.execution_result.receipt?.execution.runId ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: outcomeOf(transition),
    sourceResult: Object.freeze({ tag: "cli.command.transition.v1", value: transition }),
    newState: nextState,
    evidence,
    executionErrors: errors.executionErrors,
    verificationErrors: errors.verificationErrors,
    effect,
  });
}

type TrustedRegularFileRef = ObservedObjectRef & Readonly<{ kind: "cli.file"; type: "regular" }>;

function toFileRef(ref: TrustedRegularFileRef): ContentSearchFileRef {
  return Object.freeze({
    kind: "cli.file",
    scenarioId: ref.scenarioId,
    sessionId: ref.sessionId,
    type: "regular",
    identity: Object.freeze({ dev: ref.identity.dev, ino: ref.identity.ino }),
    sourceRun: ref.sourceRun,
    sessionRevision: ref.sessionRevision,
    absolutePath: ref.absolutePath,
  });
}

async function issueObservedRef(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  transition: CliCommandTransition,
): Promise<TrustedRegularFileRef | null> {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  if (snapshot.entryExists !== true || snapshot.kind !== "regular" || snapshot.dev === null || snapshot.ino === null) return null;
  let ref: ObservedObjectRef;
  try {
    ref = await sandbox.bindFile(session, observation.configuredPath);
  } catch {
    return null;
  }
  if (ref.kind !== "cli.file" || ref.type !== "regular" ||
    ref.absolutePath !== observation.configuredPath ||
    String(ref.identity.dev) !== String(snapshot.dev) ||
    String(ref.identity.ino) !== String(snapshot.ino) ||
    ref.sessionRevision !== transition.session_before.revision) {
    return null;
  }
  return ref as TrustedRegularFileRef;
}

function readFactFromReceipt(
  receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>,
  ref: ContentSearchFileRef,
  revision: number,
  attempt: number,
): ContentSearchReadFact | null {
  if (receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "file.read") return null;
  return Object.freeze({
    ref,
    sourceRun: receipt.execution.runId,
    refSourceRun: ref.sourceRun,
    revision,
    offset: observation.offset,
    length: observation.length,
    size: observation.size,
    attempt,
    bytes: observation.bytes,
    bytesRead: observation.bytesRead,
    eof: observation.eof,
    identity: Object.freeze({ dev: observation.identity.dev, ino: observation.identity.ino }),
  });
}

function updateCandidate(
  state: ContentSearchState,
  path: string,
  patch: Partial<ContentSearchCandidateFact>,
): ContentSearchState {
  const candidates = state.candidates.map(candidate => candidate.path === path
    ? Object.freeze({ ...candidate, ...patch })
    : candidate);
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidates: Object.freeze(candidates),
    duplicateReads: state.duplicateReads,
  });
}

function stateWithCli(state: ContentSearchState, cli: ContentSearchState["cli"], session: ContentSearchState["session"]): ContentSearchState {
  return Object.freeze({ ...state, cli, session });
}

function readAtomicReceiptFromSandbox(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;
    session: SessionRef;
    state: ContentSearchState;
    ref: ContentSearchFileRef;
    range: Readonly<{ offset: number; length: number }>;
    read: ContentSearchReadFact | null;
    nextState: ContentSearchState;
  }>,
): AtomicReceipt<ContentSearchState, ContentSearchEvidencePayload, ContentSearchEffectFact, ContentSearchReceiptPayload> {
  const receipt = input.receipt;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextState = Object.freeze({
    id: stateId(input.context.requestId, input.sequence),
    value: Object.freeze({ ...input.nextState, stateId: stateId(input.context.requestId, input.sequence) }),
  });
  const failure = receipt.execution.status === "failed" ? receipt.execution.error : null;
  const stale = failure !== null && isStaleReadCode(failure.code);
  const executionErrors = failure === null || stale
    ? Object.freeze([])
    : Object.freeze([
        Object.freeze({
          diagnosticId: `${id}:execution`,
          code: "execution_failed" as const,
          stage: "execution" as const,
          sourceCategory: "cli.command_execution",
          message: failure.message,
          nativeCode: failure.code,
          refs: Object.freeze([id]),
        }),
      ]);
  const effect: AtomicReceipt<ContentSearchState, ContentSearchEvidencePayload, ContentSearchEffectFact, ContentSearchReceiptPayload>["effect"] =
    Object.freeze({ knowledge: "none", confirmedEffects: Object.freeze([]), receiptRef: null });
  const readReceipt = Object.freeze({ kind: "cli.file.read.receipt.v1" as const, receipt, ref: input.ref });
  return Object.freeze({
    runId: receipt.execution.runId,
    executorInvoked: receipt.execution.executorInvoked,
    outcome: failure === null || stale ? ("succeeded" as const) : ("failed" as const),
    sourceResult: Object.freeze({ tag: "cli.file.read.receipt.v1", value: readReceipt }),
    newState: nextState,
    evidence: Object.freeze([
      Object.freeze({
        id: evidenceId(input.context.requestId, input.sequence),
        stateRef: nextState.id,
        payload: Object.freeze({
          kind: "cli.content-search.read.v1" as const,
          transitionId: id,
          stateId: nextState.id,
          receipt,
          ref: input.ref,
        }),
        validity: "valid" as const,
      }),
    ]),
    executionErrors,
    verificationErrors: Object.freeze([]),
    effect,
  });
}

export function createContentSearchAdapter(input: ContentSearchAdapterInput) {
  const policy = createCliCommandPolicy({
    profile: input.profile,
    sandbox: input.sandbox,
    session: input.session,
    ...(input.onSample === undefined ? {} : { onSample: input.onSample }),
  });
  const calls = {
    validateRequest: 0,
    supports: 0,
    evaluate: 0,
    select: 0,
    derive: 0,
    executeAtomic: 0,
    validateAtomicReceipt: 0,
    measureProgress: 0,
  };
  let sequence = 0;

  const adapter: ContentSearchAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = readContentSearchGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      await validateDirectoryBinding({ sandbox: input.sandbox, rootBindings });
      const state = readState(request.state);
      const root = rootGoal as ContentSearchGoal;
      if (root.kind !== "file.property" || root.property !== "file.property.content.bytes" || root.requirement.kind !== "contains") {
        throw new TypeError("content search root goal must be a content.bytes contains goal");
      }
      if (root.target.cardinality !== "one") {
        throw new TypeError("content search P1 supports only cardinality one");
      }
      if (request.rootEvaluatorId !== CONTENT_ROOT_EVALUATOR || request.rootSelectorId !== CONTENT_ROOT_SELECTOR) {
        throw new TypeError("content search request evaluator or selector is unsupported");
      }
      const continuation = request.continuation === undefined || request.continuation === null
        ? null
        : readRecursiveGoalContinuation(request.continuation, DOMAIN_GUARDS);
      return Object.freeze({
        requestId: request.requestId,
        rootGoal: rootGoal as unknown,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation,
      });
    },

    supports(callback) {
      calls.supports += 1;
      return supports(callback);
    },

    async evaluate(callback) {
      calls.evaluate += 1;
      const input = callback as EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>;
      const goal = input.goal as Readonly<{ property: string; requirement: Readonly<{ kind: string }> }>;
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "contains") {
        return evaluateRoot(input);
      }
      if (goal.property === "file.property.directory.entries") {
        return evaluateList(input);
      }
      if (goal.property === "file.property.type") {
        return evaluateInspect(input);
      }
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "observed") {
        return evaluateRead(input);
      }
      throw new TypeError("content search evaluator received an unsupported goal");
    },

    async select(callback) {
      calls.select += 1;
      return select(callback);
    },

    async derive(callback) {
      calls.derive += 1;
      return derive(callback, input.scan, input.duplicateReadProbe ?? []);
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      sequence += 1;
      const current = sequence;
      const listSelected = callback.skill.id === CONTENT_LIST_ATOMIC_SKILL;
      const inspectSelected = callback.skill.id === CONTENT_INSPECT_ATOMIC_SKILL;
      const readSelected = callback.skill.id === CONTENT_READ_ATOMIC_SKILL;
      if (!listSelected && !inspectSelected && !readSelected) {
        throw new TypeError("content search executeAtomic received an unsupported skill");
      }
      const bindings = callback.bindings as ContentSearchBindings;
      const order = input.order;

      if (listSelected) {
        const transition = await executeList(policy, {
          goal: callback.goal as ContentSearchListGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "ls";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          return atomicReceiptForTransition({
            context: callback.context, sequence: current, transition, expectedHead,
            session: input.session, state: callback.state, nextState: callback.state,
          });
        }
        const listing = listingFactFromTransition(transition);
        const nextState = listing === null
          ? callback.state
          : Object.freeze({
              stateId: stateId(callback.context.requestId, current),
              session: transition.session_after,
              cli: transition.observed_state_after,
              listing,
              candidates: initialCandidates(listing, bindings.fileCondition, order),
              duplicateReads: callback.state.duplicateReads,
            });
        return atomicReceiptForTransition({
          context: callback.context, sequence: current, transition, expectedHead,
          session: input.session, state: callback.state, nextState,
        });
      }

      if (inspectSelected) {
        const transition = await executeInspect(policy, {
          goal: callback.goal as ContentSearchInspectGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "entry.inspect";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          return atomicReceiptForTransition({
            context: callback.context, sequence: current, transition, expectedHead,
            session: input.session, state: callback.state, nextState: callback.state,
          });
        }
        const inspected = inspectedFactFromTransition(transition);
        const observed = await issueObservedRef(input.sandbox, input.session, transition);
        const goal = callback.goal as ContentSearchInspectGoal;
        let nextState = stateWithCli(callback.state, transition.observed_state_after, transition.session_after);
        if (inspected !== null) {
          const fileRef = observed !== null ? toFileRef(observed) : null;
          const outcome = inspected.type !== "regular"
            ? ("type_mismatch" as const)
            : (inspected.size === null ||
                !Number.isSafeInteger(inspected.size) ||
                inspected.size < 0 ||
                inspected.size > input.scan.maxBytesPerFile)
              ? ("unknown" as const)
              : ("pending" as const);
          nextState = updateCandidate(nextState, goal.target.ref.path, {
            inspected: Object.freeze({
              sourceRun: transition.execution_result.receipt?.execution.runId ?? null,
              absolutePath: inspected.absolutePath,
              type: inspected.type === null ? null : inspected.type as EntryKind,
              size: inspected.size,
              identity: Object.freeze({ dev: inspected.identity.dev, ino: inspected.identity.ino }),
              sessionRevision: inspected.sessionRevision,
              errno: inspected.errno,
            }),
            fileRef,
            outcome,
            reason: outcome === "unknown" ? "size_exceeds_limit" : outcome === "type_mismatch" ? "type_mismatch" : null,
          });
        }
        return atomicReceiptForTransition({
          context: callback.context, sequence: current, transition, expectedHead,
          session: input.session, state: callback.state, nextState,
        });
      }

      const goal = callback.goal as ContentSearchReadGoal;
      const sandboxReceipt = await executeRead(input.sandbox, { goal, state: callback.state });
      const needle = Buffer.from(bindings.needle, "utf8");
      const candidate = callback.state.candidates.find(item => item.fileRef?.absolutePath === goal.target.ref.absolutePath);
      const ref = goal.target.ref;
      const read = sandboxReceipt.status === "succeeded"
        ? readFactFromReceipt(sandboxReceipt, ref, sandboxReceipt.session_before.revision, goal.requirement.attempt)
        : null;
      let nextState = stateWithCli(callback.state, callback.state.cli, callback.state.session);
      if (candidate !== undefined) {
        if (read !== null && read.bytesRead !== null) {
          const bytes = Buffer.from(read.bytes, "base64");
          const full = read.offset === 0 && read.length === read.size && read.bytesRead === read.size;
          const match = full ? contains(bytes, needle) : { found: false, start: -1, end: -1 };
          const duplicate = candidate.outcome === "negative" && !candidate.duplicateRead;
          nextState = updateCandidate(nextState, candidate.path, {
            read,
            contains: match.found ? true : (full ? false : null),
            outcome: match.found ? "matched" : (full ? "negative" : "unknown"),
            byteSpan: match.found ? Object.freeze({ start: match.start, end: match.end }) : null,
            line: match.found ? lineColumn(bytes, match.start).line : null,
            column: match.found ? lineColumn(bytes, match.start).column : null,
            reason: match.found ? null : (full ? "no_match" : "short_read"),
            duplicateRead: duplicate,
          });
          if (duplicate) {
            nextState = Object.freeze({ ...nextState, duplicateReads: nextState.duplicateReads + 1 });
          }
        } else {
          const failure = sandboxReceipt.execution.status === "failed" ? sandboxReceipt.execution.error : null;
          nextState = updateCandidate(nextState, candidate.path, {
            read: null,
            contains: null,
            outcome: failure !== null && isStaleReadCode(failure.code) ? "stale" : "read_error",
            reason: failure?.code ?? "read_failed",
            failureCode: failure?.code ?? "EIO",
          });
        }
      }
      return readAtomicReceiptFromSandbox({
        context: callback.context, sequence: current, receipt: sandboxReceipt,
        session: input.session, state: callback.state, ref, range: goal.requirement.range, read, nextState,
      });
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, DOMAIN_GUARDS);
    },

    measureProgress() {
      calls.measureProgress += 1;
      return { improved: false, reason: "none" as const, comparable: true };
    },
  };

  return Object.freeze({ adapter, calls });
}

export function createContentSearchDependencies(
  created: { adapter: ContentSearchAdapter },
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  ContentSearchState,
  unknown,
  ContentSearchEvidencePayload,
  ContentSearchEffectFact,
  ContentSearchReceiptPayload,
  unknown
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: CONTENT_SEARCH_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: CONTENT_SEARCH_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: CONTENT_SEARCH_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: CONTENT_SEARCH_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
