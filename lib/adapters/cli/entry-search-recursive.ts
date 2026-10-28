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
import {
  readEntrySearchCursor,
  readEntrySearchEffectFact,
  readEntrySearchEvidencePayload,
  readEntrySearchGoal,
  readEntrySearchReceiptPayload,
  readEntrySearchState,
  type EntrySearchCandidateFact,
  type EntrySearchDirectoryFact,
  type EntrySearchEffectFact,
  type EntrySearchEvidencePayload,
  type EntrySearchInspectGoal,
  type EntrySearchListingRecord,
  type EntrySearchListGoal,
  type EntrySearchPredicate,
  type EntrySearchReceiptPayload,
  type EntrySearchRequest,
  type EntrySearchState,
} from "./entry-search-contract.js";
import {
  candidatesFromDirectories,
  decideEntrySearchRoot,
  inspectFactFromTransition,
  issuedRefMatchesInspect,
  listingIntegrityErrors,
  listingFactFromTransition,
  mergeCandidates,
} from "../../filters/cli-entry-search.js";
import type { ExplicitFileState } from "../../filters/cli-state.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { CliCommandSample, CliCommandTransition } from "../../nodes/cli-command.js";
import type { PathRef } from "../../filters/cli-file-property.js";
import type { CliFilesystemSandbox, DirectoryRef, SessionRef } from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";

export const ROOT_COMPOSITE_SKILL = "entry-search.composite";
export const LIST_ATOMIC_SKILL = "entry-search.list";
export const INSPECT_ATOMIC_SKILL = "entry-search.inspect";
export const ROOT_EVALUATOR = "entry-search-root";
export const LIST_EVALUATOR = "entry-search-list";
export const INSPECT_EVALUATOR = "entry-search-inspect";
export const ROOT_SELECTOR = "entry-search-root-selector";
export const LIST_SELECTOR = "entry-search-list-selector";
export const INSPECT_SELECTOR = "entry-search-inspect-selector";

const EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

export const ENTRY_SEARCH_SKILLS = Object.freeze([
  Object.freeze({
    id: ROOT_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "entry.search",
    evaluatorId: ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: LIST_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.list",
    evaluatorId: LIST_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: INSPECT_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.inspect",
    evaluatorId: INSPECT_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const ENTRY_SEARCH_EVALUATORS = Object.freeze([
  Object.freeze({
    id: ROOT_EVALUATOR,
    goalType: "file.property.directory.entries.matches",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: LIST_EVALUATOR,
    goalType: "file.property.directory.entries.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: INSPECT_EVALUATOR,
    goalType: "file.property.type.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const ENTRY_SEARCH_SELECTORS = Object.freeze([
  Object.freeze({ id: ROOT_SELECTOR, skillIds: Object.freeze([ROOT_COMPOSITE_SKILL]) }),
  Object.freeze({ id: LIST_SELECTOR, skillIds: Object.freeze([LIST_ATOMIC_SKILL]) }),
  Object.freeze({ id: INSPECT_SELECTOR, skillIds: Object.freeze([INSPECT_ATOMIC_SKILL]) }),
]);

export const ENTRY_SEARCH_COMPARATORS: RecursiveGoalComparators<
  unknown,
  unknown,
  EntrySearchState,
  EntrySearchEvidencePayload
> = Object.freeze({
  sameGoal: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<EntrySearchState, EntrySearchEvidencePayload>,
    right: FactSnapshot<EntrySearchState, EntrySearchEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

export type EntrySearchAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

export type EntrySearchAdapter = RecursiveGoalAdapter<
  unknown,
  EntrySearchState,
  unknown,
  EntrySearchEvidencePayload,
  EntrySearchEffectFact,
  EntrySearchReceiptPayload,
  unknown
>;

export type EntrySearchAdapterHandle = Readonly<{
  adapter: EntrySearchAdapter;
  issuedRefs: readonly ObservedObjectRef[];
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

export type EntrySearchCursor = Readonly<{ phase: "initial" | "listed" | "descend" | "closed" }>;

type NextAction =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "descend"; directory: Readonly<{ path: string; depth: number }> }>
  | Readonly<{ kind: "inspect"; candidate: EntrySearchCandidateFact }>
  | Readonly<{ kind: "close" }>;

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

function readGoal(value: unknown): unknown {
  return readEntrySearchGoal(value);
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("entry search bindings must be an object");
  exactKeys(value, ["session", "directory", "predicate"], "entry search bindings");
  return Object.freeze({ ...value });
}

function readState(value: unknown): EntrySearchState {
  return readEntrySearchState(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readEntrySearchEvidencePayload,
  effectFact: readEntrySearchEffectFact,
  sameEffectFact: (left: EntrySearchEffectFact, right: EntrySearchEffectFact) =>
    JSON.stringify(left) === JSON.stringify(right),
  receiptPayload: readEntrySearchReceiptPayload,
  cursor: readEntrySearchCursor,
  sameGoal: ENTRY_SEARCH_COMPARATORS.sameGoal,
  sameBindings: ENTRY_SEARCH_COMPARATORS.sameBindings,
  sameFacts: ENTRY_SEARCH_COMPARATORS.sameFacts,
  sameCursor: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
});

function stateEvidenceRefs(state: EntrySearchState, evidence: readonly { id: string; stateRef: string; validity: string }[]): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function evaluation(evaluatorId: string, result: "satisfied" | "unsatisfied" | "unknown", satisfaction: number | null, evidenceRefs: readonly string[]): EvaluationReceipt {
  return Object.freeze({
    evaluatorId,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function directoriesOf(state: EntrySearchState): readonly EntrySearchDirectoryFact[] {
  return state.directories ?? Object.freeze([]);
}

function candidatesOf(state: EntrySearchState): readonly EntrySearchCandidateFact[] {
  return state.candidates ?? Object.freeze([]);
}

function directoryFor(state: EntrySearchState, path: string): EntrySearchDirectoryFact | null {
  return directoriesOf(state).find(directory => directory.path === path) ?? null;
}

function listingIntegrityClean(directory: EntrySearchDirectoryFact): boolean {
  return directory.listing !== null && directory.listing.coverage === "complete"
    && directory.listing.errors.length === 0;
}

async function evaluateRoot(
  input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const decision = decideEntrySearchRoot(input.state);
  if (decision.result === "satisfied") {
    return evaluation(ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (decision.result === "unsatisfied") {
    return evaluation(ROOT_EVALUATOR, "unsatisfied", 0, []);
  }
  return evaluation(ROOT_EVALUATOR, "unknown", null, []);
}

async function evaluateList(
  input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const goal = input.goal as EntrySearchListGoal;
  const target = goal.target;
  const cwd = input.state.session.cwd;
  const absoluteTarget = target.path === "." || target.path === "" || target.path.startsWith("/")
    ? (target.path === "." ? cwd : target.path)
    : `${cwd}/${target.path}`;
  const directory = directoryFor(input.state, absoluteTarget);
  const listing = directory?.listing ?? null;
  if (listing !== null && listing.sourceRun !== null && listingIntegrityClean(directory ?? {
    path: absoluteTarget,
    depth: 0,
    listing,
    observedAtSourceRun: listing.sourceRun,
    listed: true,
    descendable: false,
    uncoveredReason: null,
  } as EntrySearchDirectoryFact)) {
    return evaluation(LIST_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(
  input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const goal = input.goal as EntrySearchInspectGoal;
  const knowledge = input.state.cli.entryKnowledge;
  const candidate = input.state.candidates?.find(item =>
    item.path === goal.target.ref.path && item.inspected !== null);
  if (
    candidate !== undefined &&
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
    return evaluation(INSPECT_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  if (candidate !== undefined && candidate.inspected !== null && candidate.inspected.entryExists === false) {
    return evaluation(INSPECT_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(INSPECT_EVALUATOR, "unknown", null, []);
}

function supports(input: SupportsInput<unknown, unknown>): boolean {
  if (input.skill.id === ROOT_COMPOSITE_SKILL) {
    return isRootGoal(input.goal);
  }
  if (input.skill.id === LIST_ATOMIC_SKILL) {
    return isListGoal(input.goal);
  }
  if (input.skill.id === INSPECT_ATOMIC_SKILL) {
    return isInspectGoal(input.goal);
  }
  return false;
}

function isRootGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property" &&
    value.property === "file.property.directory.entries" &&
    isRecord(value.requirement) &&
    value.requirement.kind === "matches";
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

async function select(input: SelectionInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>) {
  const first = input.candidates[0];
  const selection = first === undefined
    ? { kind: "no_capability" as const, searchedSkillIds: [] }
    : { kind: "selected" as const, skillId: first.id };
  return selection;
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

function listGoal(bindings: unknown, cwd: string, targetDirectory: DirectoryObjectRef): EntrySearchListGoal {
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: policyDirectoryRef(targetDirectory, cwd),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function inspectGoal(bindings: unknown, candidatePath: string, session: SessionRef): EntrySearchInspectGoal {
  const input = bindings as Readonly<{ directory: { scenarioId: string; sessionId: string } }>;
  const ref: PathRef = Object.freeze({
    kind: "cli.path",
    scenarioId: input.directory.scenarioId,
    sessionId: input.directory.sessionId,
    path: candidatePath,
  });
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({
      kind: "cli.entry-query",
      ref,
      followSymlinks: false,
    }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function nextAction(
  state: EntrySearchState,
  phase: EntrySearchCursor["phase"] | null,
): NextAction {
  if (directoriesOf(state).length === 0) {
    return Object.freeze({ kind: "list" });
  }
  const pending = state.pendingDirectories ?? Object.freeze([]);
  const firstPending = pending[0];

  const matches = candidatesOf(state).filter(candidate => candidate.outcome === "matched");
  if (state.cardinality === "one" && matches.length > 0) {
    return Object.freeze({ kind: "close" });
  }

  if (state.cardinality === "all" && firstPending !== undefined) {
    return Object.freeze({ kind: "descend", directory: firstPending });
  }

  const toInspect = candidatesOf(state).find(candidate => candidate.outcome === "pending");
  if (toInspect !== undefined) {
    return Object.freeze({ kind: "inspect", candidate: toInspect });
  }

  if (firstPending !== undefined) {
    return Object.freeze({ kind: "descend", directory: firstPending });
  }
  void phase;
  return Object.freeze({ kind: "close" });
}

async function derive(input: DerivationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload, unknown>) {
  if (!isRootGoal(input.goal) || input.skill.id !== ROOT_COMPOSITE_SKILL) {
    throw new TypeError("entry search composite derivation received an incompatible frame");
  }
  const cursor = input.cursor as EntrySearchCursor | null;
  const action = cursor === null
    ? Object.freeze({ kind: "list" as const })
    : nextAction(input.state, cursor.phase);
  const bindings = input.bindings as Readonly<{ directory: DirectoryObjectRef }>;
  const cwd = input.state.session.cwd;
  const ordinal = input.conditions.length;
  if (action.kind === "list") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(`observe-direct-entries:${ordinal}`, listGoal(input.bindings, cwd, bindings.directory), input.bindings,
          LIST_SELECTOR, LIST_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "listed" }),
      expansion: "more",
    });
  }
  if (action.kind === "descend") {
    const target: DirectoryRef = Object.freeze({
      kind: "cli.directory",
      scenarioId: bindings.directory.scenarioId,
      sessionId: bindings.directory.sessionId,
      path: relative(cwd, action.directory.path) || ".",
    });
    return Object.freeze({
      conditions: Object.freeze([
        condition(`descend-${action.directory.path}:${ordinal}`, listGoal(input.bindings, cwd, target), input.bindings,
          LIST_SELECTOR, LIST_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "descend" }),
      expansion: "more",
    });
  }
  if (action.kind === "inspect") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          `verify-${action.candidate.path}:${ordinal}`,
          inspectGoal(input.bindings, action.candidate.path, inputSession(input.bindings)),
          input.bindings,
          INSPECT_SELECTOR, INSPECT_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "listed" as const }),
      expansion: "more",
    });
  }
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({ phase: "closed" }),
    expansion: "closed",
  });
}

function inputSession(bindings: unknown): SessionRef {
  const input = bindings as Readonly<{ session: SessionRef }>;
  return input.session;
}

async function validateDirectoryBinding(
  input: Readonly<{
    sandbox: CliFilesystemSandbox;
    rootBindings: unknown;
  }>,
): Promise<void> {
  const bindings = input.rootBindings as Readonly<{
    session: SessionRef;
    directory: DirectoryObjectRef;
  }>;
  const cwd = input.sandbox.getSession(bindings.session).cwd;
  if ("absolutePath" in bindings.directory) {
    await input.sandbox.validateObservedObject(bindings.directory);
  }
  await input.sandbox.resolveDirectory(policyDirectoryRef(bindings.directory, cwd));
}

function executeList(
  policy: CliCommandPolicy,
  input: Readonly<{
    goal: EntrySearchListGoal;
    satisfactionThreshold: number;
    state: EntrySearchState;
  }>,
) {
  return policy.step({
    goal: input.goal,
    satisfactionThreshold: input.satisfactionThreshold,
    state: input.state.cli,
  });
}

function executeInspect(
  policy: CliCommandPolicy,
  input: Readonly<{
    goal: EntrySearchInspectGoal;
    satisfactionThreshold: number;
    state: EntrySearchState;
  }>,
) {
  return policy.step({
    goal: input.goal,
    satisfactionThreshold: input.satisfactionThreshold,
    state: input.state.cli,
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

function transitionDiagnostics(
  transition: CliCommandTransition,
  id: string,
  state: EntrySearchState,
): {
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
  outcome: "succeeded" | "failed" | "rejected" | "unknown";
} {
  const executionErrors: AdapterDiagnostic[] = [];
  const verificationErrors: AdapterDiagnostic[] = [];
  let outcome: "succeeded" | "failed" | "rejected" | "unknown";
  const isFlatSingle =
    (state.recursion ?? "flat") === "flat" && (state.cardinality ?? "one") === "one";
  if (missingEntryObservation(transition)) {
    if (isFlatSingle) {
      const knowledge = transition.observed_state_after.entryKnowledge;
      verificationErrors.push({
        diagnosticId: `${id}:postcommit-observation`,
        code: "evidence_unavailable",
        stage: "observation",
        sourceCategory: "cli.entry_inspection",
        message: `matched entry disappeared before inspection: ${knowledge?.errno ?? "ENOENT"}`,
        nativeCode: knowledge?.errno ?? "ENOENT",
        refs: Object.freeze([id]),
      });
    }
    outcome = "succeeded";
    return { executionErrors, verificationErrors, outcome };
  }
  if (transition.status === "rejected" && transition.reason !== "unexpected_head") {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push({
      diagnosticId: `${id}:binding`,
      code: failure?.code === "EFFECT_DENIED" ? "effect_denied" : "invalid_binding",
      stage: "binding",
      sourceCategory: "cli.directory_binding",
      message: failure?.message ?? (transition.reason.length === 0 ? "entry command rejected" : transition.reason),
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
    outcome = "rejected";
  } else if (transition.status === "failed" || transition.policy_error !== null) {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push({
      diagnosticId: `${id}:execution`,
      code: "execution_failed",
      stage: "execution",
      sourceCategory: "cli.command_execution",
      message: failure?.message ?? (transition.reason.length === 0 ? "entry command failed" : transition.reason),
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
    outcome = "failed";
  } else if (transition.status === "unknown") {
    outcome = "unknown";
  } else {
    outcome = "succeeded";
  }
  if (transition.reason === "postcommit_observation_failed") {
    const receipt = transition.postcondition?.receipt ?? null;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    verificationErrors.push({
      diagnosticId: `${id}:postcommit-observation`,
      code: "evidence_unavailable",
      stage: "observation",
      sourceCategory: "cli.postcommit_observation",
      message: failure?.message ?? "postcommit observation failed",
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
  }
  return { executionErrors, verificationErrors, outcome };
}

function missingEntryObservation(transition: CliCommandTransition): boolean {
  if (transition.goal.property !== "file.property.type") return false;
  const knowledge = transition.observed_state_after.entryKnowledge;
  return knowledge?.kind === "entry.inspect" && knowledge.entryExists === false;
}

function candidateFromTransition(
  transition: CliCommandTransition,
  candidate: EntrySearchCandidateFact,
  predicate: EntrySearchPredicate,
  issuedRef: ObservedObjectRef | null,
): EntrySearchCandidateFact {
  const inspect = inspectFactFromTransition(transition);
  if (inspect === null) {
    return Object.freeze({ ...candidate, outcome: "stale_or_unverified", reason: "unverified_identity", inspected: null, issuedRef: null });
  }
  if (inspect.entryExists !== true) {
    return Object.freeze({ ...candidate, outcome: "stale_or_unverified", reason: inspect.errno === "ENOENT" ? "disappeared" : "unverified_identity", inspected: inspect, issuedRef: null });
  }
  if (inspect.type === null || inspect.identity.dev === null || inspect.identity.ino === null) {
    return Object.freeze({ ...candidate, outcome: "stale_or_unverified", reason: "unverified_identity", inspected: inspect, issuedRef: null });
  }
  const sessionBefore = transition.session_before;
  if (
    issuedRef === null ||
    !issuedRefMatchesInspect(issuedRef, inspect) ||
    issuedRef.sessionRevision !== sessionBefore.revision
  ) {
    return Object.freeze({ ...candidate, outcome: "stale_or_unverified", reason: "stale_revision", inspected: inspect, issuedRef: null });
  }
  if (inspect.type !== predicate.type) {
    return Object.freeze({ ...candidate, outcome: "type_mismatch", reason: "type_mismatch", inspected: inspect, issuedRef });
  }
  return Object.freeze({ ...candidate, outcome: "matched", reason: null, inspected: inspect, issuedRef });
}

function entriesAfterListing(
  _state: EntrySearchState,
  listing: EntrySearchListingRecord,
  depth: number,
  recursion: "flat" | "nested",
  maxDirectoryDepth: number | null,
): Readonly<{
  current: EntrySearchDirectoryFact;
  addedDirectories: readonly EntrySearchDirectoryFact[];
  addedPending: readonly Readonly<{ path: string; depth: number }>[];
}> {
  const current: EntrySearchDirectoryFact = Object.freeze({
    path: listing.physicalDirectory,
    depth,
    listing,
    observedAtSourceRun: listing.sourceRun,
    listed: true,
    descendable: recursion === "nested",
    uncoveredReason: listing.coverage === "complete" && listing.errors.length === 0
      && listingIntegrityErrors(listing.entries, listing.physicalDirectory).length === 0
      ? null
      : "listing_partial",
  });
  const addedDirectories: EntrySearchDirectoryFact[] = [];
  const addedPending: Readonly<{ path: string; depth: number }>[] = [];
  if (
    recursion === "nested" &&
    listing.coverage === "complete" &&
    listing.errors.length === 0 &&
    listingIntegrityErrors(listing.entries, listing.physicalDirectory).length === 0
  ) {
    const childDepth = depth + 1;
    for (const child of listing.entries) {
      if (child.type !== "directory") continue;
      if (maxDirectoryDepth !== null && childDepth > maxDirectoryDepth) {
        addedDirectories.push(Object.freeze({
          path: child.path,
          depth: childDepth,
          listing: null,
          observedAtSourceRun: null,
          listed: false,
          descendable: false,
          uncoveredReason: "depth_limit",
        }));
      } else {
        addedDirectories.push(Object.freeze({
          path: child.path,
          depth: childDepth,
          listing: null,
          observedAtSourceRun: null,
          listed: false,
          descendable: false,
          uncoveredReason: null,
        }));
        addedPending.push(Object.freeze({ path: child.path, depth: childDepth }));
      }
    }
  }
  return Object.freeze({
    current,
    addedDirectories: Object.freeze(addedDirectories),
    addedPending: Object.freeze(addedPending),
  });
}

function atomicReceipt(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    transition: CliCommandTransition;
    expectedHead: string;
    session: SessionRef;
    state: EntrySearchState;
    nextState: EntrySearchState;
  }>,
): AtomicReceipt<EntrySearchState, EntrySearchEvidencePayload, EntrySearchEffectFact, EntrySearchReceiptPayload> {
  const transition = input.transition;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextState = Object.freeze({
    id: stateId(input.context.requestId, input.sequence),
    value: Object.freeze({
      ...input.nextState,
      stateId: stateId(input.context.requestId, input.sequence),
    }),
  });
  const evidence = Object.freeze([
    Object.freeze({
      id: evidenceId(input.context.requestId, input.sequence),
      stateRef: nextState.id,
      payload: Object.freeze({
        kind: "cli.entry-search.transition.v1" as const,
        transitionId: id,
        stateId: nextState.id,
        transition,
      }),
      validity: "valid" as const,
    }),
  ]);
  const diagnostics = transitionDiagnostics(transition, id, input.state);
  const effect: AtomicReceipt<EntrySearchState, EntrySearchEvidencePayload, EntrySearchEffectFact, EntrySearchReceiptPayload>["effect"] = Object.freeze({
    knowledge: "none",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
  return Object.freeze({
    runId: transition.execution_result.receipt?.execution.runId ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: diagnostics.outcome,
    sourceResult: Object.freeze({
      tag: "cli.command.transition.v1",
      value: transition,
    }),
    newState: nextState,
    evidence,
    executionErrors: Object.freeze(diagnostics.executionErrors),
    verificationErrors: Object.freeze(diagnostics.verificationErrors),
    effect,
  });
}

async function issueObservedRef(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  transition: CliCommandTransition,
): Promise<ObservedObjectRef | null> {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  if (snapshot.entryExists !== true || snapshot.kind === null || snapshot.dev === null || snapshot.ino === null) {
    return null;
  }
  const bind = snapshot.kind === "regular"
    ? sandbox.bindFile
    : snapshot.kind === "directory"
      ? sandbox.bindDirectoryObject
      : sandbox.bindEntry;
  let ref: ObservedObjectRef;
  try {
    ref = await bind.call(sandbox, session, observation.configuredPath);
  } catch {
    return null;
  }
  const expectedKind = snapshot.kind === "regular"
    ? "cli.file"
    : snapshot.kind === "directory"
      ? "cli.directory"
      : "cli.entry";
  if (
    ref.kind !== expectedKind ||
    ref.type !== snapshot.kind ||
    ref.absolutePath !== observation.configuredPath ||
    String(ref.identity.dev) !== String(snapshot.dev) ||
    String(ref.identity.ino) !== String(snapshot.ino) ||
    ref.sessionRevision !== transition.session_before.revision
  ) {
    return null;
  }
  return ref;
}

function restoredSequence(continuation: unknown): number {
  const value = continuation as { requestId?: unknown; transitionsUsed?: unknown };
  // The continuation envelope is opaque; infer from its stored state ids when present.
  const raw = continuation as { states?: readonly { id?: unknown }[] };
  let max = 0;
  for (const state of raw.states ?? []) {
    if (typeof state.id === "string") {
      const match = /:state-(\d+)$/.exec(state.id);
      if (match !== null) max = Math.max(max, Number(match[1]));
    }
  }
  if (max === 0 && typeof value.transitionsUsed === "number") max = value.transitionsUsed;
  return max;
}

export function createEntrySearchAdapter(input: EntrySearchAdapterInput) {
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
  const issuedRefs: ObservedObjectRef[] = [];

  const adapter: EntrySearchAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = readEntrySearchGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      await validateDirectoryBinding({
        sandbox: input.sandbox,
        rootBindings,
      });
      const state = readState(request.state);
      const root = rootGoal as EntrySearchRequest["goal"];
      if (
        root.kind !== "file.property" ||
        root.property !== "file.property.directory.entries" ||
        root.requirement.kind !== "matches"
      ) {
        throw new TypeError("entry search root goal must be a directory.entries matches goal");
      }
      const session = input.session;
      if (
        root.target.scenarioId !== session.scenarioId ||
        root.target.sessionId !== session.sessionId ||
        state.session.id !== session.sessionId
      ) {
        throw new TypeError("entry search request must identify the bound session");
      }
      if (
        request.rootEvaluatorId !== ROOT_EVALUATOR ||
        request.rootSelectorId !== ROOT_SELECTOR
      ) {
        throw new TypeError("entry search request evaluator or selector is unsupported");
      }
      const continuation =
        request.continuation === undefined || request.continuation === null
          ? null
          : readRecursiveGoalContinuation(request.continuation, DOMAIN_GUARDS);
      if (continuation !== null) {
        sequence = Math.max(sequence, restoredSequence(continuation));
      }
      return Object.freeze({
        requestId: request.requestId,
        rootGoal: rootGoal as unknown,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        continuation,
      });
    },

    supports(callback) {
      calls.supports += 1;
      return supports(callback);
    },

    async evaluate(callback) {
      calls.evaluate += 1;
      const input = callback as EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>;
      const goal = input.goal as Readonly<{ property: string; requirement: Readonly<{ kind: string }> }>;
      if (goal.property === "file.property.directory.entries" && goal.requirement.kind === "matches") {
        return evaluateRoot(input);
      }
      if (goal.property === "file.property.directory.entries" && goal.requirement.kind === "observed") {
        return evaluateList(input);
      }
      if (goal.property === "file.property.type") {
        return evaluateInspect(input);
      }
      throw new TypeError("entry search evaluator received an unsupported goal");
    },

    async select(callback) {
      calls.select += 1;
      return select(callback);
    },

    async derive(callback) {
      calls.derive += 1;
      return derive(callback);
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      sequence += 1;
      const current = sequence;
      const listSelected = callback.skill.id === LIST_ATOMIC_SKILL;
      const inspectSelected = callback.skill.id === INSPECT_ATOMIC_SKILL;
      if (!listSelected && !inspectSelected) {
        throw new TypeError("entry search executeAtomic received an unsupported skill");
      }
      const bindings = callback.bindings as Readonly<{ predicate: EntrySearchPredicate }>;
      const transition = listSelected
        ? await executeList(policy, {
            goal: callback.goal as EntrySearchListGoal,
            satisfactionThreshold: callback.satisfactionThreshold,
            state: callback.state,
          })
        : await executeInspect(policy, {
            goal: callback.goal as EntrySearchInspectGoal,
            satisfactionThreshold: callback.satisfactionThreshold,
            state: callback.state,
          });
      const expectedHead = listSelected ? "ls" : "entry.inspect";
      if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
        const receipt = atomicReceipt({
          context: callback.context,
          sequence: current,
          transition,
          expectedHead,
          session: input.session,
          state: callback.state,
          nextState: callback.state,
        });
        const selectedHead = transition.policy.selectedHead;
        const policyError: AdapterDiagnostic = Object.freeze({
          diagnosticId: `${transitionId(callback.context.requestId, current)}:policy`,
          code: "policy_error",
          stage: "selection",
          sourceCategory: "cli.command_policy",
          message: `command policy selected ${selectedHead}, expected ${expectedHead}`,
          nativeCode: null,
          refs: Object.freeze([transitionId(callback.context.requestId, current)]),
        });
        return Object.freeze({
          ...receipt,
          outcome: "rejected",
          executionErrors: Object.freeze([...receipt.executionErrors, policyError]),
        });
      }

      let nextState = callback.state;
      let inspectRef: ObservedObjectRef | null = null;
      if (listSelected) {
        const observation = listingFactFromTransition(transition);
        const listing: EntrySearchListingRecord | null = observation === null
          ? null
          : Object.freeze({
              physicalDirectory: observation.physicalDirectory,
              entries: observation.entries,
              coverage: observation.coverage,
              errors: observation.errors,
              sourceRun: transition.execution_result.receipt?.execution.runId ?? "",
              revision: transition.session_before.revision,
              observation,
            });
        if (listing !== null) {
          const existing = callback.state.directories?.find(directory => directory.path === listing.physicalDirectory);
          const depth = existing?.depth ?? 0;
          const recursion = callback.state.recursion ?? bindings.predicate.recursion ?? "flat";
          const maxDirectoryDepth = callback.state.maxDirectoryDepth === undefined
            ? (recursion === "flat" ? 0 : null)
            : callback.state.maxDirectoryDepth;
          const after = entriesAfterListing(callback.state, listing, depth, recursion, maxDirectoryDepth);
          const directories = existing === undefined
            ? [after.current, ...after.addedDirectories]
            : [
                ...callback.state.directories!.map(directory => directory.path === after.current.path ? after.current : directory),
                ...after.addedDirectories.filter(added => !callback.state.directories!.some(directory => directory.path === added.path)),
              ];
          const pendingDirectories = [
            ...(callback.state.pendingDirectories ?? Object.freeze([])).filter(pending => pending.path !== after.current.path),
            ...after.addedPending,
          ];
          const candidates = mergeCandidates(
            callback.state.candidates ?? Object.freeze([]),
            candidatesFromDirectories(
              Object.freeze(directories),
              bindings.predicate as EntrySearchPredicate,
            ),
          );
          nextState = Object.freeze({
            ...callback.state,
            session: transition.session_after,
            cli: transition.observed_state_after,
            directories: Object.freeze(directories),
            pendingDirectories: Object.freeze(pendingDirectories),
            candidates,
          });
        }
      } else {
        inspectRef = await issueObservedRef(input.sandbox, input.session, transition);
        if (inspectRef !== null) issuedRefs.push(inspectRef);
        const pending = callback.state.candidates?.find(candidate => candidate.path === (callback.goal as EntrySearchInspectGoal).target.ref.path);
        if (pending !== undefined) {
          const updated = candidateFromTransition(transition, pending, bindings.predicate, inspectRef);
          const candidates = Object.freeze((callback.state.candidates ?? []).map(candidate =>
            candidate.path === pending.path ? updated : candidate));
          nextState = Object.freeze({
            ...callback.state,
            session: transition.session_after,
            cli: transition.observed_state_after,
            candidates,
          });
        }
      }
      return atomicReceipt({
        context: callback.context,
        sequence: current,
        transition,
        expectedHead,
        session: input.session,
        state: callback.state,
        nextState,
      });
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, DOMAIN_GUARDS);
    },

    measureProgress(input) {
      calls.measureProgress += 1;
      const before = input.before as EntrySearchState;
      const after = input.after as EntrySearchState;
      const improved = entrySearchProgressFingerprint(before) !== entrySearchProgressFingerprint(after);
      return { improved, reason: improved ? "facts_improved" as const : "none" as const, comparable: true };
    },
  };

  return Object.freeze({
    adapter,
    get issuedRefs(): readonly ObservedObjectRef[] {
      return Object.freeze([...issuedRefs]);
    },
    calls,
  });
}

// Business-fact fingerprint for the composite entry-search cycle. It tracks
// cumulative per-directory listing facts, the pending-directory set and
// candidate verification progress, and ignores identity-only churn (source
// runs, revisions, dev/ino identity, observation timestamps). The composite
// `expansion: "more"` no-progress check compares this so listing a distinct
// empty directory still counts as progress toward the search frontier.
function byFirstElement(left: readonly unknown[], right: readonly unknown[]): number {
  const leftKey = String(left[0]);
  const rightKey = String(right[0]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function entrySearchProgressFingerprint(state: EntrySearchState): string {
  const directories = (state.directories ?? [])
    .map(directory => [
      directory.path,
      directory.depth,
      directory.listed,
      directory.descendable,
      directory.uncoveredReason,
      directory.listing === null
        ? null
        : [
            directory.listing.coverage,
            directory.listing.errors.map(error => [error.name, error.code, error.message]),
            directory.listing.entries.map(entry => [entry.name, entry.path, entry.type]),
          ],
    ])
    .sort(byFirstElement);
  const pending = (state.pendingDirectories ?? [])
    .map(pendingDirectory => [pendingDirectory.path, pendingDirectory.depth])
    .sort(byFirstElement);
  const candidates = (state.candidates ?? [])
    .map(candidate => [
      candidate.path,
      candidate.outcome,
      candidate.reason,
      candidate.inspected === null
        ? null
        : [
            candidate.inspected.observedWith,
            candidate.inspected.entryExists,
            candidate.inspected.resolvedTargetExists,
            candidate.inspected.type,
            candidate.inspected.errno,
          ],
    ])
    .sort(byFirstElement);
  return JSON.stringify({ directories, pending, candidates });
}

export function createEntrySearchDependencies(
  created: { adapter: EntrySearchAdapter },
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  EntrySearchState,
  unknown,
  EntrySearchEvidencePayload,
  EntrySearchEffectFact,
  EntrySearchReceiptPayload,
  unknown
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: ENTRY_SEARCH_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: ENTRY_SEARCH_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: ENTRY_SEARCH_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: ENTRY_SEARCH_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
