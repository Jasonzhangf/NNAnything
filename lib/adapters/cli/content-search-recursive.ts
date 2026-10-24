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
  type ContentSearchDirectoryFact,
  type ContentSearchEffectFact,
  type ContentSearchEvidencePayload,
  type ContentSearchFileRef,
  type ContentSearchGoal,
  type ContentSearchHistoricalHitFact,
  type ContentSearchIdentityKey,
  type ContentSearchInspectGoal,
  type ContentSearchListGoal,
  type ContentSearchMismatchFact,
  type ContentSearchOrder,
  type ContentSearchReadFact,
  type ContentSearchReadGoal,
  type ContentSearchReceiptPayload,
  type ContentSearchRequest,
  type ContentSearchScan,
  type ContentSearchScanFact,
  type ContentSearchState,
} from "./content-search-contract.js";
import {
  applyReadToScan,
  candidatesFromListings,
  contains,
  decideContentSearchRoot,
  identityKeyOfRef,
  initialCandidates,
  inspectedFactFromTransition,
  isStaleReadCode,
  lineColumn,
  lineColumnOfFirstMatch,
  readFactEndObserved,
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
  for (const key of ["session", "directory", "fileCondition", "cardinality", "needle"]) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`content search bindings.${key} is required`);
  }
  if (Object.keys(value).some(key => !["session", "directory", "fileCondition", "cardinality", "needle", "recursion"].includes(key))) {
    throw new TypeError("content search bindings contains unsupported fields");
  }
  return Object.freeze({
    ...value,
    recursion: Object.hasOwn(value, "recursion") ? value.recursion : "flat",
  });
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
  const goal = input.goal as ContentSearchListGoal;
  const target = goal.target;
  const cwd = input.state.session.cwd;
  const absoluteTarget = target.path === "." || target.path === "" || target.path.startsWith("/")
    ? (target.path === "." ? cwd : target.path)
    : `${cwd}/${target.path}`;
  const directory = input.state.directories.find(candidate =>
    candidate.path === absoluteTarget,
  );
  const listing = directory?.listing ?? null;
  if (listing !== null && listing.sourceRun !== null) {
    return evaluation(CONTENT_LIST_EVALUATOR, "satisfied", 100, stateEvidenceRefs(input.state, input.evidence));
  }
  return evaluation(CONTENT_LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(
  input: EvaluationInput<unknown, ContentSearchState, unknown, ContentSearchEvidencePayload>,
): Promise<EvaluationReceipt> {
  const goal = input.goal as ContentSearchInspectGoal;
  const knowledge = input.state.cli.entryKnowledge;
  const candidate = input.state.candidates.find(item =>
    item.path === goal.target.ref.path &&
    item.inspected !== null &&
    item.outcome !== "stale",
  );
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
    item.payload.ref.sourceRun === goal.target.ref.sourceRun &&
    item.payload.ref.absolutePath === goal.target.ref.absolutePath &&
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

function chunkReadGoalAtAttempt(
  ref: ContentSearchFileRef,
  offset: number,
  length: number,
  attempt: number,
): ContentSearchReadGoal {
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({ kind: "cli.file", ref, requiredType: "regular" }),
    requirement: Object.freeze({
      kind: "observed",
      range: Object.freeze({ offset, length }),
      attempt,
    }),
  });
}

function inputSession(bindings: unknown): SessionRef {
  return (bindings as ContentSearchBindings).session;
}

type NextAction =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "descend"; directory: Readonly<{ path: string; depth: number }> }>
  | Readonly<{ kind: "inspect"; candidate: ContentSearchCandidateFact }>
  | Readonly<{ kind: "read"; candidate: ContentSearchCandidateFact; duplicate: boolean }>
  | Readonly<{ kind: "reconcile"; candidate: ContentSearchCandidateFact }>
  | Readonly<{ kind: "close" }>;

function pendingDirectoriesOf(
  state: ContentSearchState,
): readonly Readonly<{ path: string; depth: number }>[] {
  return state.pendingDirectories;
}

function isNegativeComplete(candidate: ContentSearchCandidateFact): boolean {
  return candidate.outcome === "negative";
}

function needsInspect(candidate: ContentSearchCandidateFact): boolean {
  return candidate.inspected === null &&
    (candidate.outcome === "pending" || candidate.outcome === "stale");
}

function needsRead(candidate: ContentSearchCandidateFact): boolean {
  if (candidate.inspected === null || candidate.fileRef === null) return false;
  if (candidate.scan === null) return candidate.outcome === "pending";
  if (candidate.scan.complete || candidate.scan.shortRead) return false;
  if (candidate.outcome === "pending" || candidate.outcome === "unknown") return true;
  if (candidate.outcome === "matched") {
    return true;
  }
  return false;
}

function nextAction(
  state: ContentSearchState,
  phase: ContentSearchCursor["phase"] | null,
  scan: ContentSearchScan,
  duplicateReadProbe: readonly string[],
): NextAction {
  if (state.directories.length === 0 && state.listing === null) {
    return Object.freeze({ kind: "list" });
  }

  // Recursive descent is only entered when no unresolved regular candidate can
  // make forward progress, and it always keeps one directory.list in flight.
  const pending = pendingDirectoriesOf(state);
  const firstPending = pending[0];
  void phase;

  // A stale candidate must be re-inspected before any further read.
  const stale = state.candidates.find(candidate =>
    candidate.outcome === "stale" &&
    candidate.staleRetries < scan.maxStaleRetries,
  );
  if (stale !== undefined) {
    return Object.freeze({ kind: "inspect", candidate: stale });
  }

  // Continue an unfinished chunk scan before selecting another candidate.
  const inProgress = state.candidates.find(candidate => needsRead(candidate) && candidate.outcome === "matched");
  if (inProgress !== undefined) {
    return Object.freeze({ kind: "read", candidate: inProgress, duplicate: false });
  }
  const inProgressPending = state.candidates.find(candidate => needsRead(candidate) && candidate.outcome === "pending");
  if (inProgressPending !== undefined) {
    return Object.freeze({ kind: "read", candidate: inProgressPending, duplicate: false });
  }

  // one can stop after a hit; all continues every unresolved candidate.
  const currentMatches = state.candidates.filter(candidate => candidate.outcome === "matched");
  if (state.cardinality === "one" && currentMatches.length > 0) {
    return Object.freeze({ kind: "close" });
  }

  const duplicate = state.candidates.find(candidate =>
    isNegativeComplete(candidate) &&
    !candidate.duplicateRead &&
    duplicateReadProbe.includes(candidate.name) &&
    candidate.fileRef !== null,
  );
  if (duplicate !== undefined) {
    return Object.freeze({ kind: "read", candidate: duplicate, duplicate: true });
  }

  const toInspect = state.candidates.find(candidate => needsInspect(candidate));
  if (toInspect !== undefined) {
    return Object.freeze({ kind: "inspect", candidate: toInspect });
  }

  const toRead = state.candidates.find(candidate => needsRead(candidate));
  if (toRead !== undefined) {
    return Object.freeze({ kind: "read", candidate: toRead, duplicate: false });
  }

  if (phase === "listed" && firstPending !== undefined) {
    return Object.freeze({ kind: "descend", directory: firstPending });
  }

  // No more regular candidate work. If a child directory remains, list it.
  if (firstPending !== undefined) {
    return Object.freeze({ kind: "descend", directory: firstPending });
  }

  const unresolved = state.candidates.find(candidate =>
    candidate.outcome === "unknown" || candidate.outcome === "read_error" || candidate.outcome === "stale",
  );
  if (unresolved !== undefined) {
    return Object.freeze({ kind: "reconcile", candidate: unresolved });
  }

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
  const ordinal = input.conditions.length;
  if (action.kind === "list") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(`observe-direct-entries:${ordinal}`, listGoal(input.bindings, input.state.session.cwd), input.bindings,
          CONTENT_LIST_SELECTOR, CONTENT_LIST_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "listed" }),
      expansion: "more",
    });
  }
  if (action.kind === "descend") {
    const cwd = input.state.session.cwd;
    const relativePath = relative(cwd, action.directory.path) || ".";
    const target = Object.freeze({
      kind: "cli.directory",
      scenarioId: (input.bindings as ContentSearchBindings).directory.scenarioId,
      sessionId: (input.bindings as ContentSearchBindings).directory.sessionId,
      path: relativePath,
    });
    return Object.freeze({
      conditions: Object.freeze([
        condition(`descend-${action.directory.path}:${ordinal}`, listGoal(
          Object.freeze({ ...(input.bindings as ContentSearchBindings), directory: target }),
          input.state.session.cwd,
        ), input.bindings,
        CONTENT_LIST_SELECTOR, CONTENT_LIST_EVALUATOR, EFFECTS),
      ]),
      nextCursor: Object.freeze({ phase: "descend" }),
      expansion: "more",
    });
  }
  if (action.kind === "inspect") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          `verify-${action.candidate.name}:${ordinal}`,
          inspectGoal(input.bindings, action.candidate.path),
          input.bindings,
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
    const offset = action.duplicate ? 0 : (action.candidate.scan?.nextOffset ?? 0);
    const length = action.duplicate
      ? size
      : Math.max(0, Math.min(scan.chunkSize, size - offset));
    return Object.freeze({
      conditions: Object.freeze([
        condition(`read-${action.candidate.name}:attempt-${attempt}:offset-${offset}:${ordinal}`,
          chunkReadGoalAtAttempt(ref, offset, length, attempt), input.bindings,
          CONTENT_READ_SELECTOR, CONTENT_READ_EVALUATOR, ["filesystem.read"]),
      ]),
      nextCursor: Object.freeze({ phase: "read" }),
      expansion: "more",
    });
  }
  if (action.kind === "reconcile") {
    return Object.freeze({
      conditions: Object.freeze([]),
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

function restoredSequence(
  continuation: Readonly<{ states: readonly Readonly<{ id: string }>[] }> | null,
): number {
  if (continuation === null) return 0;
  let maximum = 0;
  for (const state of continuation.states) {
    const match = /:state-(\d+)$/.exec(state.id);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > maximum) maximum = value;
  }
  return maximum;
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
  if (transition.execution_result.receipt?.execution.status === "succeeded") return "succeeded";
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

function candidateIdentityStable(candidate: ContentSearchCandidateFact, read: ContentSearchReadFact): boolean {
  if (candidate.fileRef === null) return false;
  const ref = candidate.fileRef;
  return String(ref.identity.dev) === String(read.identity.dev) &&
    String(ref.identity.ino) === String(read.identity.ino) &&
    ref.sessionRevision === read.revision &&
    ref.sourceRun === read.refSourceRun &&
    ref.scenarioId === read.ref.scenarioId &&
    ref.sessionId === read.ref.sessionId;
}

function candidateSizeStable(candidate: ContentSearchCandidateFact, read: ContentSearchReadFact): boolean {
  return candidate.inspected !== null && candidate.inspected.size === read.size;
}

function historicalHitFrom(
  candidate: ContentSearchCandidateFact,
  needle: string,
  invalidation: ContentSearchHistoricalHitFact["invalidation"],
): readonly ContentSearchHistoricalHitFact[] {
  if (candidate.scan === null || candidate.fileRef === null || candidate.scan.found === false ||
      candidate.scan.firstMatch === null) {
    return Object.freeze([]);
  }
  return Object.freeze([
    Object.freeze({
      kind: "historical_stale_hit" as const,
      historical: true as const,
      identityKey: identityKeyOfRef(candidate.fileRef),
      fileRef: candidate.fileRef,
      sourceRun: candidate.fileRef.sourceRun,
      path: candidate.path,
      needle,
      byteSpan: Object.freeze({ start: candidate.scan.firstMatch.start, end: candidate.scan.firstMatch.end }),
      line: candidate.line ?? 1,
      column: candidate.column ?? 1,
      size: Number(candidate.inspected?.size ?? candidate.scan.sizeAtStart),
      bytesRead: candidate.scan.bytesRead,
      invalidation,
    }),
  ]);
}

function lineColumnFromScan(
  previous: ContentSearchScanFact | null,
  currentBytes: Buffer,
  readOffset: number,
  firstMatch: Readonly<{ start: number; end: number }>,
): Readonly<{ line: number; column: number }> {
  return lineColumnOfFirstMatch(previous, currentBytes, readOffset, firstMatch.start);
}

function updateCandidate(
  state: ContentSearchState,
  path: string,
  patch: Partial<ContentSearchCandidateFact>,
): ContentSearchState {
  const candidates = state.candidates.map(candidate => candidate.path === path
    ? Object.freeze({ ...candidate, ...patch })
    : candidate);
  return Object.freeze({ ...state, candidates: Object.freeze(candidates) });
}

function updateDirectories(
  state: ContentSearchState,
  patch: readonly ContentSearchDirectoryFact[],
  pendingDirectories: readonly Readonly<{ path: string; depth: number }>[],
): ContentSearchState {
  return Object.freeze({
    ...state,
    directories: Object.freeze(patch),
    pendingDirectories: Object.freeze(pendingDirectories),
    listing: patch[0]?.listing ?? state.listing,
  });
}

function typeMismatchFacts(
  candidates: readonly ContentSearchCandidateFact[],
): readonly ContentSearchMismatchFact[] {
  return Object.freeze(candidates
    .filter(candidate => candidate.outcome === "type_mismatch")
    .map(candidate => Object.freeze({ name: candidate.name, path: candidate.path })));
}

function stateWithCli(state: ContentSearchState, cli: ContentSearchState["cli"], session: ContentSearchState["session"]): ContentSearchState {
  return Object.freeze({ ...state, cli, session });
}

function progressFingerprint(state: ContentSearchState): string {
  const directories = state.directories.map(directory => [
    directory.path,
    directory.listed,
    directory.observedAtSourceRun,
    directory.listing?.coverage ?? null,
    directory.listing?.sourceRun ?? null,
    directory.uncoveredReason,
    directory.listing?.entries.length ?? 0,
  ]);
  const candidates = state.candidates.map(candidate => [
    candidate.path,
    candidate.outcome,
    candidate.contains,
    candidate.scan?.bytesRead ?? 0,
    candidate.scan?.chunks ?? 0,
    candidate.scan?.complete ?? false,
    candidate.inspected?.sourceRun ?? null,
    candidate.fileRef?.sourceRun ?? null,
    candidate.history.length,
    candidate.failureCode ?? null,
  ]);
  return JSON.stringify({ directories, candidates, duplicateReads: state.duplicateReads });
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
      if (request.rootEvaluatorId !== CONTENT_ROOT_EVALUATOR || request.rootSelectorId !== CONTENT_ROOT_SELECTOR) {
        throw new TypeError("content search request evaluator or selector is unsupported");
      }
      const continuation = request.continuation === undefined || request.continuation === null
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
        let nextState = callback.state;
        if (listing !== null) {
          const existing = callback.state.directories.find(directory => directory.path === listing.physicalDirectory);
          const depth = existing?.depth ?? 0;
          const currentDirectory: ContentSearchDirectoryFact = Object.freeze({
            path: listing.physicalDirectory ?? "",
            depth,
            listing,
            observedAtSourceRun: listing.sourceRun,
            listed: true,
            descendable: callback.state.recursion === "nested" &&
              depth < callback.state.maxDirectoryDepth &&
              listing.coverage === "complete",
            uncoveredReason: listing.coverage === "complete" ? null : "listing_partial",
          });
          const directories = existing === undefined
            ? [currentDirectory]
            : callback.state.directories.map(directory => directory.path === currentDirectory.path ? currentDirectory : directory);
          const childDepth = depth + 1;
          const childEntries = listing.entries.filter(entry => entry.type === "directory");
          const addedFacts: ContentSearchDirectoryFact[] = [];
          const addedPending: Readonly<{ path: string; depth: number }>[] = [];
          for (const child of childEntries) {
            if (callback.state.recursion !== "nested") continue;
            const already = directories.some(directory => directory.path === child.path);
            if (already) continue;
            if (childDepth <= callback.state.maxDirectoryDepth) {
              addedFacts.push(Object.freeze({
                path: child.path,
                depth: childDepth,
                listing: null,
                observedAtSourceRun: null,
                listed: false,
                descendable: false,
                uncoveredReason: null,
              }));
              addedPending.push(Object.freeze({ path: child.path, depth: childDepth }));
            } else {
              addedFacts.push(Object.freeze({
                path: child.path,
                depth: childDepth,
                listing: null,
                observedAtSourceRun: null,
                listed: false,
                descendable: false,
                uncoveredReason: "depth_limit",
              }));
            }
          }
          const mergedDirectories = Object.freeze([...directories, ...addedFacts]);
          const pendingDirectories = Object.freeze([
            ...callback.state.pendingDirectories.filter(pending => pending.path !== currentDirectory.path),
            ...addedPending,
          ]);
          const mergedCandidates = candidatesFromListings(mergedDirectories, bindings.fileCondition, order)
            .map(fresh => callback.state.candidates.find(existing => existing.path === fresh.path) ?? fresh);
          nextState = Object.freeze({
            ...callback.state,
            stateId: stateId(callback.context.requestId, current),
            session: transition.session_after,
            cli: transition.observed_state_after,
            listing: mergedDirectories[0]?.listing ?? callback.state.listing,
            directories: mergedDirectories,
            pendingDirectories,
            candidates: Object.freeze(mergedCandidates),
            provenNegatives: callback.state.provenNegatives,
            typeMismatches: typeMismatchFacts(mergedCandidates),
          });
        }
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
          const existing = callback.state.candidates.find(candidate => candidate.path === goal.target.ref.path);
          const wasStale = existing?.outcome === "stale";
          const staleRetries = (existing?.staleRetries ?? 0) + (wasStale ? 1 : 0);
          const retainedHistory = existing?.history ?? Object.freeze([]);
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
            scan: null,
            contains: null,
            outcome,
            byteSpan: null,
            line: null,
            column: null,
            reason: outcome === "unknown"
              ? "size_exceeds_limit"
              : outcome === "type_mismatch"
                ? "type_mismatch"
                : null,
            failureCode: null,
            duplicateRead: false,
            history: retainedHistory,
            staleRetries,
          });
          nextState = Object.freeze({
            ...nextState,
            typeMismatches: typeMismatchFacts(nextState.candidates),
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
      const failure = sandboxReceipt.execution.status === "failed" ? sandboxReceipt.execution.error : null;
      const read = sandboxReceipt.status === "succeeded"
        ? readFactFromReceipt(sandboxReceipt, ref, sandboxReceipt.session_before.revision, goal.requirement.attempt)
        : null;
      let nextState = stateWithCli(callback.state, callback.state.cli, callback.state.session);
      if (candidate !== undefined) {
        if (read !== null && read.bytesRead !== null) {
          const bytes = Buffer.from(read.bytes, "base64");
          const duplicate = candidate.outcome === "negative" && !candidate.duplicateRead;
          const previousScan = candidate.scan ?? null;
          const endObserved = readFactEndObserved(read);
          const shortRead = read.eof && !endObserved;
          const identityStable = candidateIdentityStable(candidate, read);
          const sizeStable = candidateSizeStable(candidate, read);

          if (previousScan !== null && (!identityStable || !sizeStable)) {
            // An identity or size change observed mid-scan invalidates the
            // accumulated scan and any first hit it produced.
            const temporaryScan = applyReadToScan(previousScan, candidate, read, needle);
            const temporaryCandidate = Object.freeze({ ...candidate, scan: temporaryScan });
            const invalidationKind = !identityStable ? "identity_changed" : "size_changed";
            const historical = historicalHitFrom(temporaryCandidate, bindings.needle, Object.freeze({
              kind: invalidationKind as ContentSearchHistoricalHitFact["invalidation"]["kind"],
              observedAtSourceRun: read.sourceRun,
              code: null,
            }));
            nextState = updateCandidate(nextState, candidate.path, {
              read,
              inspected: null,
              fileRef: candidate.fileRef,
              scan: null,
              contains: null,
              outcome: "stale",
              byteSpan: null,
              line: null,
              column: null,
              reason: invalidationKind,
              failureCode: null,
              duplicateRead: duplicate,
              history: Object.freeze([...candidate.history, ...historical]),
            });
          } else if (candidate.inspected !== null && candidate.fileRef !== null && !identityStable) {
            // First read after a stale inspect: no scan baseline yet.
            const temporaryScan = applyReadToScan(null, candidate, read, needle);
            const temporaryCandidate = Object.freeze({ ...candidate, scan: temporaryScan });
            const historical = historicalHitFrom(temporaryCandidate, bindings.needle, Object.freeze({
              kind: "identity_changed" as const,
              observedAtSourceRun: read.sourceRun,
              code: null,
            }));
            nextState = updateCandidate(nextState, candidate.path, {
              read,
              inspected: null,
              fileRef: candidate.fileRef,
              scan: null,
              contains: null,
              outcome: "stale",
              byteSpan: null,
              line: null,
              column: null,
              reason: "identity_changed",
              failureCode: null,
              history: Object.freeze([...candidate.history, ...historical]),
            });
          } else if (candidate.inspected !== null && candidate.fileRef !== null && !sizeStable) {
            const temporaryScan = applyReadToScan(null, candidate, read, needle);
            const temporaryCandidate = Object.freeze({ ...candidate, scan: temporaryScan });
            const historical = historicalHitFrom(temporaryCandidate, bindings.needle, Object.freeze({
              kind: "size_changed" as const,
              observedAtSourceRun: read.sourceRun,
              code: null,
            }));
            nextState = updateCandidate(nextState, candidate.path, {
              read,
              inspected: null,
              fileRef: candidate.fileRef,
              scan: null,
              contains: null,
              outcome: "stale",
              byteSpan: null,
              line: null,
              column: null,
              reason: "size_changed",
              failureCode: null,
              history: Object.freeze([...candidate.history, ...historical]),
            });
          } else {
            const scan = applyReadToScan(previousScan, candidate, read, needle);
            const matched = scan.found && !scan.shortRead;
            const negative = scan.complete && !matched && !scan.shortRead;
            const shortRead = scan.shortRead;
            const outcome: ContentSearchCandidateFact["outcome"] =
              shortRead
                ? "unknown"
                : matched
                  ? "matched"
                  : negative
                    ? "negative"
                    : scan.complete
                      ? "negative"
                      : "unknown";
            const firstMatch = scan.firstMatch;
            const lineColumnValue = firstMatch === null
              ? null
              : lineColumnFromScan(previousScan, bytes, read.offset, firstMatch);
            nextState = updateCandidate(nextState, candidate.path, {
              read,
              contains: shortRead ? null : matched ? true : negative ? false : null,
              outcome,
              scan,
              byteSpan: shortRead || firstMatch === null ? null : Object.freeze({ start: firstMatch.start, end: firstMatch.end }),
              line: shortRead || lineColumnValue === null ? null : lineColumnValue.line,
              column: shortRead || lineColumnValue === null ? null : lineColumnValue.column,
              reason: shortRead ? "short_read" : matched ? null : negative ? "no_match" : "read_partial",
              duplicateRead: duplicate,
            });
          }
          if (duplicate) {
            nextState = Object.freeze({ ...nextState, duplicateReads: nextState.duplicateReads + 1 });
          }
        } else {
          const staleFailure = failure !== null && isStaleReadCode(failure.code);
          const historical = staleFailure
            ? historicalHitFrom(candidate, bindings.needle, Object.freeze({
                kind: "read_stale" as const,
                observedAtSourceRun: candidate.scan?.lastReadSourceRun ?? sandboxReceipt.execution.runId,
                code: failure?.code ?? null,
              }))
            : Object.freeze([]);
          nextState = updateCandidate(nextState, candidate.path, {
            read: null,
            inspected: staleFailure ? null : candidate.inspected,
            fileRef: staleFailure ? null : candidate.fileRef,
            scan: staleFailure ? null : candidate.scan,
            contains: null,
            outcome: staleFailure ? "stale" : "read_error",
            byteSpan: staleFailure ? null : candidate.byteSpan,
            line: staleFailure ? null : candidate.line,
            column: staleFailure ? null : candidate.column,
            reason: failure?.code ?? "read_failed",
            failureCode: failure?.code ?? "EIO",
            history: Object.freeze([...candidate.history, ...historical]),
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

    measureProgress(input) {
      calls.measureProgress += 1;
      const before = input.before as ContentSearchState;
      const after = input.after as ContentSearchState;
      const improved = progressFingerprint(before) !== progressFingerprint(after);
      return { improved, reason: improved ? "facts_improved" as const : "none" as const, comparable: true };
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
