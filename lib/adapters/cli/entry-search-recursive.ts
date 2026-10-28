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
  type EntrySearchEffectFact,
  type EntrySearchEvidencePayload,
  type EntrySearchInspectGoal,
  type EntrySearchListGoal,
  type EntrySearchReceiptPayload,
  type EntrySearchRequest,
  type EntrySearchState,
} from "./entry-search-contract.js";
import { decideRoot, listingIntegrityErrors } from "../../filters/cli-entry-search.js";
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
  issuedRef: ObservedObjectRef | null;
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

function readGoal(value: unknown): unknown {
  return readEntrySearchGoal(value);
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("entry search bindings must be an object");
  exactKeys(value, ["session", "directory", "predicate"], "entry search bindings");
  return Object.freeze({ ...value });
}

function readState(value: unknown): EntrySearchState {
  if (!isRecord(value)) throw new TypeError("entry search state must be an object");
  exactKeys(value, ["stateId", "session", "cli"], "entry search state");
  return Object.freeze({
    stateId: nonEmpty(value.stateId, "entry search state stateId"),
    session: readSessionSnapshot(value.session),
    cli: value.cli as ExplicitFileState,
  });
}

function readSessionSnapshot(value: unknown): EntrySearchState["session"] {
  if (!isRecord(value)) throw new TypeError("entry search session snapshot must be an object");
  exactKeys(value, ["id", "cwd", "revision", "grantedEffects"], "entry search session snapshot");
  const grantedEffects = value.grantedEffects;
  if (!Array.isArray(grantedEffects) || grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError("entry search session snapshot grantedEffects must be a string array");
  }
  return Object.freeze({
    id: nonEmpty(value.id, "entry search session snapshot id"),
    cwd: absolutePath(value.cwd, "entry search session snapshot cwd"),
    revision: nonnegativeInteger(value.revision, "entry search session snapshot revision"),
    grantedEffects: Object.freeze([...grantedEffects]),
  });
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

function listingKnowledge(state: EntrySearchState, name: string): {
  coverage: "complete" | "partial" | null;
  candidate: { name: string; path: string; listedType: string } | null;
} {
  const listing = state.cli.directoryListing;
  if (listing === null) return { coverage: null, candidate: null };
  const integrity = listingIntegrityErrors(listing.entries, listing.physicalDirectory);
  const matches = listing.entries.filter(entry => entry.name === name);
  const single = matches.length === 1 ? matches[0] : undefined;
  return {
    coverage: integrity.length === 0 ? listing.coverage : "partial",
    candidate:
      integrity.length === 0 && single !== undefined
        ? { name: single.name, path: single.path, listedType: single.type }
        : null,
  };
}

async function evaluateRoot(
  input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>,
  issuedRef: ObservedObjectRef | null,
): Promise<EvaluationReceipt> {
  const bindings = input.bindings as Readonly<{ predicate: Readonly<{ name: string; type: "regular" | "directory" }> }>;
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const decision = decideRoot(
    input.state.cli,
    bindings.predicate.name,
    bindings.predicate.type,
    transitionsOf(input.evidence),
    issuedRef,
  );
  if (decision.result === "satisfied") {
    return evaluation(ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (decision.result === "unsatisfied") {
    return evaluation(ROOT_EVALUATOR, "unsatisfied", 0, []);
  }
  return evaluation(ROOT_EVALUATOR, "unknown", null, []);
}

function transitionsOf(evidence: readonly { payload: EntrySearchEvidencePayload }[]): readonly CliCommandTransition[] {
  const transitions = evidence
    .filter(item => item.payload.kind === "cli.entry-search.transition.v1")
    .map(item => item.payload.transition);
  return Object.freeze([...transitions]);
}

async function evaluateList(input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>): Promise<EvaluationReceipt> {
  const listing = input.state.cli.directoryListing;
  if (
    listing !== null &&
    listing.coverage === "complete" &&
    listing.errors.length === 0 &&
    listing.entries.every(entry => entry.type !== "unknown")
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(LIST_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(input: EvaluationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload>): Promise<EvaluationReceipt> {
  const goal = input.goal as EntrySearchInspectGoal;
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
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(INSPECT_EVALUATOR, "satisfied", 100, evidenceRefs);
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

function listGoal(bindings: unknown, cwd: string): EntrySearchListGoal {
  const input = bindings as Readonly<{ directory: DirectoryObjectRef }>;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: policyDirectoryRef(input.directory, cwd),
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

async function derive(input: DerivationInput<unknown, EntrySearchState, unknown, EntrySearchEvidencePayload, unknown>) {
  if (!isRootGoal(input.goal) || input.skill.id !== ROOT_COMPOSITE_SKILL) {
    throw new TypeError("entry search composite derivation received an incompatible frame");
  }
  const cursor = input.cursor as Readonly<{ phase: "listed" | "verified" | "closed" }> | null;
  const phase = cursor === null ? "initial" : cursor.phase;
  const bindings = input.bindings as Readonly<{ predicate: Readonly<{ name: string }> }>;
  const listing = listingKnowledge(input.state, bindings.predicate.name);
  if (phase === "initial") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "observe-direct-entries",
          listGoal(input.bindings, input.state.session.cwd),
          input.bindings,
          LIST_SELECTOR,
          LIST_EVALUATOR,
          EFFECTS,
        ),
      ]),
      nextCursor: Object.freeze({ phase: "listed" }),
      expansion: "more",
    });
  }
  if (
    phase === "listed" &&
    listing.coverage === "complete" &&
    listing.candidate !== null
  ) {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "verify-matched-entry",
          inspectGoal(input.bindings, listing.candidate.path, inputSession(input.bindings)),
          input.bindings,
          INSPECT_SELECTOR,
          INSPECT_EVALUATOR,
          EFFECTS,
        ),
      ]),
      nextCursor: Object.freeze({ phase: "closed" }),
      expansion: "closed",
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
    predicate: Readonly<{ name: string; type: "regular" | "directory" }>;
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

function transitionDiagnostics(transition: CliCommandTransition, id: string): {
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
} {
  const executionErrors: AdapterDiagnostic[] = [];
  const verificationErrors: AdapterDiagnostic[] = [];
  if (missingEntryObservation(transition)) {
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
    return { executionErrors, verificationErrors };
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
  } else if (transition.status === "failed") {
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
  return { executionErrors, verificationErrors };
}

function missingEntryObservation(transition: CliCommandTransition): boolean {
  if (transition.goal.property !== "file.property.type") return false;
  const knowledge = transition.observed_state_after.entryKnowledge;
  return knowledge?.kind === "entry.inspect" && knowledge.entryExists === false;
}

function outcomeOf(transition: CliCommandTransition): "succeeded" | "failed" | "rejected" | "unknown" {
  if (missingEntryObservation(transition)) return "succeeded";
  if (transition.status === "achieved") return "succeeded";
  if (transition.status === "unknown") return "unknown";
  if (transition.status === "rejected") return "rejected";
  return "failed";
}

function atomicReceipt(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    transition: CliCommandTransition;
    expectedHead: string;
    session: SessionRef;
  }>,
): AtomicReceipt<EntrySearchState, EntrySearchEvidencePayload, EntrySearchEffectFact, EntrySearchReceiptPayload> {
  const transition = input.transition;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextState = Object.freeze({
    id: stateId(input.context.requestId, input.sequence),
    value: Object.freeze({
      stateId: stateId(input.context.requestId, input.sequence),
      session: transition.session_after,
      cli: transition.observed_state_after,
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
  const errors = transitionDiagnostics(transition, id);
  const effect: AtomicReceipt<EntrySearchState, EntrySearchEvidencePayload, EntrySearchEffectFact, EntrySearchReceiptPayload>["effect"] = Object.freeze({
    knowledge: "none",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
  return Object.freeze({
    runId: transition.execution_result.receipt?.execution.runId ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: outcomeOf(transition),
    sourceResult: Object.freeze({
      tag: "cli.command.transition.v1",
      value: transition,
    }),
    newState: nextState,
    evidence,
    executionErrors: Object.freeze(errors.executionErrors),
    verificationErrors: Object.freeze(errors.verificationErrors),
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
  let issuedRef: ObservedObjectRef | null = null;

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
        return evaluateRoot(input, issuedRef);
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
      if (inspectSelected) {
        issuedRef = await issueObservedRef(input.sandbox, input.session, transition);
      }
      return atomicReceipt({
        context: callback.context,
        sequence: current,
        transition,
        expectedHead,
        session: input.session,
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
    get issuedRef(): ObservedObjectRef | null {
      return issuedRef;
    },
    calls,
  });
}

// Business-fact fingerprint for the composite entry-search cycle. It tracks
// whether the direct listing and the exact-entry inspection facts advanced and
// ignores identity-only churn (source runs, revisions, dev/ino identity,
// observation timestamps). The composite `expansion: "more"` no-progress check
// compares this so list -> inspect progress is not treated as a stalled
// obligation.
function entrySearchProgressFingerprint(state: EntrySearchState): string {
  const listing = state.cli.directoryListing;
  const listingFact = listing === null
    ? null
    : [
        listing.coverage,
        listing.errors.length,
        listing.entries.map(entry => [entry.name, entry.path, entry.type]),
      ];
  const entry = state.cli.entryKnowledge ?? null;
  const entryFact = entry === null
    ? null
    : [
        entry.observedWith,
        entry.entryExists,
        entry.type,
        entry.absolutePath,
      ];
  return JSON.stringify({ listing: listingFact, entry: entryFact });
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

