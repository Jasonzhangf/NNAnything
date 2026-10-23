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
  readReadCompositionCursor,
  readReadCompositionEffectFact,
  readReadCompositionEvidencePayload,
  readReadCompositionGoal,
  readReadCompositionReceiptPayload,
  readReadCompositionState,
  type ReadCompositionBindings,
  type ReadCompositionCandidate,
  type ReadCompositionEffectFact,
  type ReadCompositionEvidencePayload,
  type ReadCompositionFileRef,
  type ReadCompositionGoal,
  type ReadCompositionInspectGoal,
  type ReadCompositionListGoal,
  type ReadCompositionReadFact,
  type ReadCompositionReadGoal,
  type ReadCompositionReceiptPayload,
  type ReadCompositionRequest,
  type ReadCompositionState,
} from "./read-composition-contract.js";
import { decideReadRoot, readListingFacts, readRootFact, type ReadListingFacts } from "../../filters/cli-read-composition.js";
import type { ExplicitFileState } from "../../filters/cli-state.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { CliCommandSample, CliCommandTransition } from "../../nodes/cli-command.js";
import type { PathRef } from "../../filters/cli-file-property.js";
import type { CliFilesystemSandbox, DirectoryRef, SemanticCallReceipt, SessionRef } from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";

export const READ_ROOT_COMPOSITE_SKILL = "read-composition.composite";
export const READ_LIST_ATOMIC_SKILL = "read-composition.list";
export const READ_INSPECT_ATOMIC_SKILL = "read-composition.inspect";
export const READ_READ_ATOMIC_SKILL = "read-composition.read";
export const READ_ROOT_EVALUATOR = "read-composition-root";
export const READ_LIST_EVALUATOR = "read-composition-list";
export const READ_INSPECT_EVALUATOR = "read-composition-inspect";
export const READ_READ_EVALUATOR = "read-composition-read";
export const READ_ROOT_SELECTOR = "read-composition-root-selector";
export const READ_LIST_SELECTOR = "read-composition-list-selector";
export const READ_INSPECT_SELECTOR = "read-composition-inspect-selector";
export const READ_READ_SELECTOR = "read-composition-read-selector";

const EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

export const READ_COMPOSITION_SKILLS = Object.freeze([
  Object.freeze({
    id: READ_ROOT_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.read-composition",
    evaluatorId: READ_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: READ_LIST_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.list",
    evaluatorId: READ_LIST_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: READ_INSPECT_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.inspect",
    evaluatorId: READ_INSPECT_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: READ_READ_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "file.read",
    evaluatorId: READ_READ_EVALUATOR,
    requiredEffects: Object.freeze(["filesystem.read"]),
    allowedEffects: Object.freeze(["filesystem.read"]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const READ_COMPOSITION_EVALUATORS = Object.freeze([
  Object.freeze({
    id: READ_ROOT_EVALUATOR,
    goalType: "file.property.content.bytes.equals",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_LIST_EVALUATOR,
    goalType: "file.property.directory.entries.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_INSPECT_EVALUATOR,
    goalType: "file.property.type.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_READ_EVALUATOR,
    goalType: "file.property.content.bytes.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const READ_COMPOSITION_SELECTORS = Object.freeze([
  Object.freeze({ id: READ_ROOT_SELECTOR, skillIds: Object.freeze([READ_ROOT_COMPOSITE_SKILL]) }),
  Object.freeze({ id: READ_LIST_SELECTOR, skillIds: Object.freeze([READ_LIST_ATOMIC_SKILL]) }),
  Object.freeze({ id: READ_INSPECT_SELECTOR, skillIds: Object.freeze([READ_INSPECT_ATOMIC_SKILL]) }),
  Object.freeze({ id: READ_READ_SELECTOR, skillIds: Object.freeze([READ_READ_ATOMIC_SKILL]) }),
]);

export const READ_COMPOSITION_COMPARATORS: RecursiveGoalComparators<
  unknown,
  unknown,
  ReadCompositionState,
  ReadCompositionEvidencePayload
> = Object.freeze({
  sameGoal: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<ReadCompositionState, ReadCompositionEvidencePayload>,
    right: FactSnapshot<ReadCompositionState, ReadCompositionEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

export type ReadCompositionAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

export type ReadCompositionAdapter = RecursiveGoalAdapter<
  unknown,
  ReadCompositionState,
  unknown,
  ReadCompositionEvidencePayload,
  ReadCompositionEffectFact,
  ReadCompositionReceiptPayload,
  unknown
>;

export type ReadCompositionAdapterHandle = Readonly<{
  adapter: ReadCompositionAdapter;
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
  return readReadCompositionGoal(value);
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("read composition bindings must be an object");
  exactKeys(value, ["session", "directory", "name", "requiredType", "range", "expectedBase64"], "read composition bindings");
  const range = value.range as Record<string, unknown>;
  if (!isRecord(range)) throw new TypeError("read composition bindings.range must be an object");
  const offset = nonnegativeInteger(range.offset, "read composition bindings.range.offset");
  const length = nonnegativeInteger(range.length, "read composition bindings.range.length");
  const expectedBase64 = value.expectedBase64;
  if (
    typeof expectedBase64 !== "string" ||
    Buffer.from(expectedBase64, "base64").length !== length ||
    Buffer.from(Buffer.from(expectedBase64, "base64")).toString("base64") !== expectedBase64
  ) {
    throw new TypeError("read composition bindings.expectedBase64 must be canonical base64 for the range length");
  }
  return Object.freeze({
    session: value.session,
    directory: value.directory,
    name: nonEmpty(value.name, "read composition bindings.name"),
    requiredType: value.requiredType === "regular" ? "regular" : (() => { throw new TypeError("read composition bindings.requiredType must be regular"); })(),
    range: Object.freeze({ offset, length }),
    expectedBase64,
  });
}

function readState(value: unknown): ReadCompositionState {
  if (!isRecord(value)) throw new TypeError("read composition state must be an object");
  return readReadCompositionState(value);
}

function readSessionSnapshot(value: unknown): ReadCompositionState["session"] {
  if (!isRecord(value)) throw new TypeError("read composition session snapshot must be an object");
  exactKeys(value, ["id", "cwd", "revision", "grantedEffects"], "read composition session snapshot");
  const grantedEffects = value.grantedEffects;
  if (!Array.isArray(grantedEffects) || grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError("read composition session snapshot grantedEffects must be a string array");
  }
  return Object.freeze({
    id: nonEmpty(value.id, "read composition session snapshot id"),
    cwd: absolutePath(value.cwd, "read composition session snapshot cwd"),
    revision: nonnegativeInteger(value.revision, "read composition session snapshot revision"),
    grantedEffects: Object.freeze([...grantedEffects]),
  });
}

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readReadCompositionEvidencePayload,
  effectFact: readReadCompositionEffectFact,
  sameEffectFact: (left: ReadCompositionEffectFact, right: ReadCompositionEffectFact) =>
    JSON.stringify(left) === JSON.stringify(right),
  receiptPayload: readReadCompositionReceiptPayload,
  cursor: readReadCompositionCursor,
  sameGoal: READ_COMPOSITION_COMPARATORS.sameGoal,
  sameBindings: READ_COMPOSITION_COMPARATORS.sameBindings,
  sameFacts: READ_COMPOSITION_COMPARATORS.sameFacts,
  sameCursor: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
});

function stateEvidenceRefs(state: ReadCompositionState, evidence: readonly { id: string; stateRef: string; validity: string }[]): readonly string[] {
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

function listingKnowledge(state: ReadCompositionState, bindings: ReadCompositionBindings): {
  coverage: "complete" | "partial" | null;
  candidate: ReadCompositionCandidate | null;
} {
  const listing = state.listing;
  if (listing === null) {
    return { coverage: null, candidate: null };
  }
  return {
    coverage: listing.coverage,
    candidate: candidateFromListing(listing, bindings.name),
  };
}

async function evaluateRoot(
  input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>,
  request: ReadCompositionRequest,
): Promise<EvaluationReceipt> {
  const bindings = input.bindings as ReadCompositionBindings;
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const decision = decideReadRoot(
    input.state,
    bindings.name,
    Buffer.from(bindings.expectedBase64, "base64"),
    bindings.range,
    transitionsOf(input.evidence),
  );
  if (decision.result === "satisfied") {
    return evaluation(READ_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (decision.result === "unsatisfied") {
    return evaluation(READ_ROOT_EVALUATOR, "unsatisfied", 0, []);
  }
  return evaluation(READ_ROOT_EVALUATOR, "unknown", null, []);
}

function transitionsOf(evidence: readonly { payload: ReadCompositionEvidencePayload }[]): readonly CliCommandTransition[] {
  const transitions = evidence
    .flatMap(item =>
      item.payload.kind === "cli.read-composition.transition.v1"
        ? [item.payload.transition]
        : [],
    );
  return Object.freeze([...transitions]);
}

async function evaluateList(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const listing = input.state.listing;
  if (
    listing !== null &&
    listing.coverage === "complete" &&
    listing.errors.length === 0 &&
    listing.sourceRun !== null
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_LIST_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const goal = input.goal as ReadCompositionInspectGoal;
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
    return evaluation(READ_INSPECT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_INSPECT_EVALUATOR, "unknown", null, []);
}

async function evaluateRead(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const goal = input.goal as ReadCompositionReadGoal;
  const read = input.state.read;
  if (process.env.NN_DEBUG_READ_EVAL === "1") {
    console.error("DEBUG_READ_EVAL", JSON.stringify({
      hasRead: read !== null,
      read,
      goalRefSourceRun: goal.target.ref.sourceRun,
      stateFileRef: input.state.fileRef,
    }));
  }
  if (
    read !== null &&
    read.sourceRun !== null &&
    read.refSourceRun === goal.target.ref.sourceRun &&
    read.revision === goal.target.ref.sessionRevision &&
    read.offset === goal.requirement.range.offset &&
    read.length === goal.requirement.range.length &&
    read.bytes !== null &&
    read.bytesRead !== null &&
    read.eof !== null &&
    read.identity.dev !== null &&
    read.identity.ino !== null
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_READ_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_READ_EVALUATOR, "unknown", null, []);
}

function supports(input: SupportsInput<unknown, unknown>): boolean {
  if (input.skill.id === READ_ROOT_COMPOSITE_SKILL) {
    return isRootGoal(input.goal);
  }
  if (input.skill.id === READ_LIST_ATOMIC_SKILL) {
    return isListGoal(input.goal);
  }
  if (input.skill.id === READ_INSPECT_ATOMIC_SKILL) {
    return isInspectGoal(input.goal);
  }
  if (input.skill.id === READ_READ_ATOMIC_SKILL) {
    return isReadGoal(input.goal);
  }
  return false;
}

function isRootGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.content.bytes"
    && isRecord(value.target)
    && value.target.kind === "cli.exact-child"
    && isRecord(value.requirement)
    && value.requirement.kind === "equals";
}

function isListGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.directory.entries"
    && isRecord(value.requirement)
    && value.requirement.kind === "observed";
}

function isInspectGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.type"
    && isRecord(value.target)
    && value.target.kind === "cli.entry-query"
    && value.target.followSymlinks === false;
}

function isReadGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.content.bytes"
    && isRecord(value.target)
    && value.target.kind === "cli.file"
    && isRecord(value.requirement)
    && value.requirement.kind === "observed";
}

async function select(input: SelectionInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>) {
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

function listGoal(bindings: unknown, cwd: string): ReadCompositionListGoal {
  const input = bindings as Readonly<{ directory: DirectoryObjectRef }>;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: policyDirectoryRef(input.directory, cwd),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function inspectGoal(bindings: unknown, candidatePath: string): ReadCompositionInspectGoal {
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

function readGoalFromBindings(bindings: unknown, ref: ObservedObjectRef): ReadCompositionReadGoal {
  const input = bindings as ReadCompositionBindings;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({
      kind: "cli.file",
      ref,
      requiredType: "regular",
    }),
    requirement: Object.freeze({
      kind: "observed",
      range: input.range,
    }),
  });
}

async function derive(input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>) {
  if (!isRootGoal(input.goal) || input.skill.id !== READ_ROOT_COMPOSITE_SKILL) {
    throw new TypeError("read composition composite derivation received an incompatible frame");
  }
  const cursor = input.cursor as Readonly<{ phase: "listed" | "inspected" | "read" | "closed" }> | null;
  const phase = cursor === null ? "initial" : cursor.phase;
  const bindings = input.bindings as ReadCompositionBindings;
  const listing = listingKnowledge(input.state, bindings);
  if (phase === "initial") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "observe-direct-entries",
          listGoal(input.bindings, input.state.session.cwd),
          input.bindings,
          READ_LIST_SELECTOR,
          READ_LIST_EVALUATOR,
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
          inspectGoal(input.bindings, listing.candidate.path),
          input.bindings,
          READ_INSPECT_SELECTOR,
          READ_INSPECT_EVALUATOR,
          EFFECTS,
        ),
      ]),
      nextCursor: Object.freeze({ phase: "inspected" }),
      expansion: "more",
    });
  }
  if (
    phase === "inspected" &&
    input.state.fileRef !== null
  ) {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "read-trusted-range",
          readGoalFromBindings(input.bindings, input.state.fileRef),
          input.bindings,
          READ_READ_SELECTOR,
          READ_READ_EVALUATOR,
          ["filesystem.read"],
        ),
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
    goal: ReadCompositionListGoal;
    satisfactionThreshold: number;
    state: ReadCompositionState;
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
    goal: ReadCompositionInspectGoal;
    satisfactionThreshold: number;
    state: ReadCompositionState;
  }>,
) {
  return policy.step({
    goal: input.goal,
    satisfactionThreshold: input.satisfactionThreshold,
    state: input.state.cli,
  });
}

async function executeRead(
  sandbox: CliFilesystemSandbox,
  input: Readonly<{
    goal: ReadCompositionReadGoal;
    state: ReadCompositionState;
  }>,
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
      message: failure?.message ?? (transition.reason.length === 0 ? "read command rejected" : transition.reason),
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
      message: failure?.message ?? (transition.reason.length === 0 ? "read command failed" : transition.reason),
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

function listingFromTransition(transition: CliCommandTransition): ReadCompositionState["listing"] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "directory.list") return null;
  return Object.freeze({
    sourceRun: receipt.execution.runId,
    coverage: observation.coverage,
    directoryRef: null,
    errors: Object.freeze(
      observation.errors.map(error => `${error.name}:${error.code}:${error.message}`),
    ),
    candidateNames: Object.freeze([]),
    entries: Object.freeze(
      observation.entries.map(entry => Object.freeze({
        name: entry.name,
        path: entry.path,
        type: entry.type,
      })),
    ),
  });
}

function candidateFromListing(
  listing: ReadCompositionState["listing"],
  name: string,
): ReadCompositionCandidate | null {
  if (listing === null || listing.coverage !== "complete") return null;
  const entry = (() => {
    const matches = listing.entries.filter(entry => entry.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  })();
  if (entry === undefined) return null;
  return Object.freeze({
    name: entry.name,
    path: entry.path,
    listedType: entry.type,
    listingRun: listing.sourceRun,
  });
}

let stateSequence = 0;

function nextStateId(requestId: string): string {
  stateSequence += 1;
  return `${requestId}:state-${stateSequence}`;
}

function inspectedFromInspect(transition: CliCommandTransition): ReadCompositionState["inspected"] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  return Object.freeze({
    sourceRun: receipt.execution.runId,
    type: snapshot.kind,
    identity: Object.freeze({
      dev: snapshot.dev,
      ino: snapshot.ino,
    }),
    sessionRevision: transition.session_before.revision,
    absolutePath: observation.configuredPath,
  });
}

function readFactFromReceipt(
  receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>,
  refSourceRun: string | null,
  revision: number | null,
  ref: ReadCompositionFileRef,
): ReadCompositionReadFact | null {
  if (receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "file.read") return null;
  return Object.freeze({
    ref,
    sourceRun: receipt.execution.runId,
    refSourceRun,
    revision,
    offset: observation.offset,
    length: observation.length,
    bytes: observation.bytes,
    bytesRead: observation.bytesRead,
    size: observation.size,
    eof: observation.eof,
    identity: Object.freeze({
      dev: observation.identity.dev,
      ino: observation.identity.ino,
    }),
  });
}

function atomicReceipt(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    transition: CliCommandTransition;
    expectedHead: string;
    session: SessionRef;
    state: ReadCompositionState;
    nextState?: ReadCompositionState | null;
  }>,
): AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload> {
  const transition = input.transition;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextId = nextStateId(input.context.requestId);
  const carried = input.nextState ?? input.state;
  const nextState = Object.freeze({
    id: nextId,
    value: Object.freeze({
      stateId: nextId,
      session: transition.session_after,
      cli: transition.observed_state_after,
      listing: carried.listing,
      candidate: carried.candidate,
      inspected: carried.inspected,
      fileRef: carried.fileRef,
      read: carried.read,
    }),
  });
  const evidence = Object.freeze([
    Object.freeze({
      id: evidenceId(input.context.requestId, input.sequence),
      stateRef: nextState.id,
      payload: Object.freeze({
        kind: "cli.read-composition.transition.v1" as const,
        transitionId: id,
        stateId: nextState.id,
        transition,
      }),
      validity: "valid" as const,
    }),
  ]);
  const errors = transitionDiagnostics(transition, id);
  const effect: AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload>["effect"] = Object.freeze({
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

function readAtomicReceiptFromSandbox(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;
    session: SessionRef;
    state: ReadCompositionState;
    ref: ObservedObjectRef;
    expectedHead: "file.read";
    range: Readonly<{ offset: number; length: number }>;
    read: ReadCompositionReadFact | null;
  }>,
): AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload> {
  const receipt = input.receipt;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextId = nextStateId(input.context.requestId);
  const nextState = Object.freeze({
    id: nextId,
    value: Object.freeze({
      stateId: nextId,
      session: receipt.session_after,
      cli: input.state.cli,
      listing: input.state.listing,
      candidate: input.state.candidate,
      inspected: input.state.inspected,
      fileRef: null,
      read: input.read,
    }),
  });
  const failure = receipt.execution.status === "failed" ? receipt.execution.error : null;
  const executionErrors = failure === null
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
  const effect: AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload>["effect"] = Object.freeze({
    knowledge: "none",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
  const readReceipt = Object.freeze({
    kind: "cli.file.read.receipt.v1" as const,
    receipt,
    ref: input.ref as ReadCompositionFileRef,
  });
  return Object.freeze({
    runId: receipt.execution.runId,
    executorInvoked: receipt.execution.executorInvoked,
    outcome: failure === null ? "succeeded" as const : "failed" as const,
    sourceResult: Object.freeze({
      tag: "cli.file.read.receipt.v1",
      value: readReceipt,
    }),
    newState: nextState,
    evidence: Object.freeze([
      Object.freeze({
        id: evidenceId(input.context.requestId, input.sequence),
        stateRef: nextState.id,
        payload: Object.freeze({
          kind: "cli.read-composition.read.v1" as const,
          transitionId: id,
          stateId: nextId,
          receipt,
          ref: input.ref as ReadCompositionFileRef,
        }),
        validity: "valid" as const,
      }),
    ]),
    executionErrors,
    verificationErrors: Object.freeze([]),
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
  let ref: ObservedObjectRef;
  try {
    ref = await sandbox.bindFile(session, observation.configuredPath);
  } catch {
    return null;
  }
  if (
    ref.kind !== "cli.file" ||
    ref.type !== "regular" ||
    ref.absolutePath !== observation.configuredPath ||
    String(ref.identity.dev) !== String(snapshot.dev) ||
    String(ref.identity.ino) !== String(snapshot.ino) ||
    ref.sessionRevision !== transition.session_before.revision
  ) {
    return null;
  }
  return ref;
}

function stateWithListing(state: ReadCompositionState, listing: ReadCompositionState["listing"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef: state.fileRef,
    read: state.read,
  });
}

function stateWithInspected(state: ReadCompositionState, inspected: ReadCompositionState["inspected"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected,
    fileRef: state.fileRef,
    read: state.read,
  });
}

function stateWithFileRef(state: ReadCompositionState, fileRef: ReadCompositionFileRef | null): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef,
    read: state.read,
  });
}

function stateWithRead(state: ReadCompositionState, read: ReadCompositionState["read"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef: read === null ? state.fileRef : null,
    read,
  });
}

export function createReadCompositionAdapter(input: ReadCompositionAdapterInput) {
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
  let debugSeq = 0;

  const adapter: ReadCompositionAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = readReadCompositionGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      await validateDirectoryBinding({
        sandbox: input.sandbox,
        rootBindings,
      });
      const state = readReadCompositionState(request.state);
      const root = rootGoal as ReadCompositionGoal;
      const session = input.session;
      if (
        root.kind !== "file.property" ||
        root.property !== "file.property.content.bytes" ||
        root.requirement.kind !== "equals"
      ) {
        throw new TypeError("read composition root goal must be a content.bytes equals goal");
      }
      if (
        root.target.directory.scenarioId !== session.scenarioId ||
        root.target.directory.sessionId !== session.sessionId ||
        state.session.id !== session.sessionId
      ) {
        throw new TypeError("read composition request must identify the bound session");
      }
      if (
        request.rootEvaluatorId !== READ_ROOT_EVALUATOR ||
        request.rootSelectorId !== READ_ROOT_SELECTOR
      ) {
        throw new TypeError("read composition request evaluator or selector is unsupported");
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
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        const debugGoal = callback.goal as { property?: unknown; requirement?: unknown };
        const debugState = callback.state as ReadCompositionState;
        console.error("DEBUG_EVAL_CALL", JSON.stringify({
          seq: debugSeq,
          property: debugGoal.property,
          requirement: debugGoal.requirement,
          hasRead: debugState.read !== null,
          hasListing: debugState.listing !== null,
          hasFileRef: debugState.fileRef !== null,
        }));
      }
      const input = callback as EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>;
      const goal = input.goal as Readonly<{ property: string; requirement: Readonly<{ kind: string }> }>;
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "equals") {
        return evaluateRoot(input, input.bindings as unknown as ReadCompositionRequest);
      }
      if (goal.property === "file.property.directory.entries" && goal.requirement.kind === "observed") {
        return evaluateList(input);
      }
      if (goal.property === "file.property.type") {
        return evaluateInspect(input);
      }
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "observed") {
        return evaluateRead(input);
      }
      throw new TypeError("read composition evaluator received an unsupported goal");
    },

    async select(callback) {
      calls.select += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_SELECT", JSON.stringify({ seq: debugSeq }));
      }
      return select(callback);
    },

    async derive(callback) {
      calls.derive += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_DERIVE", JSON.stringify({ seq: debugSeq }));
      }
      return derive(callback);
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_EXECUTE", JSON.stringify({ seq: debugSeq, skillId: callback.skill.id }));
      }
      sequence += 1;
      const current = sequence;
      const listSelected = callback.skill.id === READ_LIST_ATOMIC_SKILL;
      const inspectSelected = callback.skill.id === READ_INSPECT_ATOMIC_SKILL;
      const readSelected = callback.skill.id === READ_READ_ATOMIC_SKILL;
      if (!listSelected && !inspectSelected && !readSelected) {
        throw new TypeError("read composition executeAtomic received an unsupported skill");
      }
      if (listSelected) {
        const transition = await executeList(policy, {
          goal: callback.goal as ReadCompositionListGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "ls";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          const receipt = atomicReceipt({
            context: callback.context,
            sequence: current,
            transition,
            expectedHead,
            session: input.session,
            state: callback.state,
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
        const listing = listingFromTransition(transition);
        const nextState = stateWithListing(callback.state, listing);
        const receipt = atomicReceipt({
          context: callback.context,
          sequence: current,
          transition,
          expectedHead,
          session: input.session,
          state: callback.state,
          nextState,
        });
        return receipt;
      }
      if (inspectSelected) {
        const transition = await executeInspect(policy, {
          goal: callback.goal as ReadCompositionInspectGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "entry.inspect";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          const receipt = atomicReceipt({
            context: callback.context,
            sequence: current,
            transition,
            expectedHead,
            session: input.session,
            state: callback.state,
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
        const inspected = inspectedFromInspect(transition);
        const ref = await issueObservedRef(input.sandbox, input.session, transition);
        let fileRef: ReadCompositionFileRef | null = null;
        if (ref !== null && inspected !== null && inspected.type === "regular") {
          fileRef = Object.freeze({
            kind: "cli.file",
            scenarioId: ref.scenarioId,
            sessionId: ref.sessionId,
            type: "regular",
            identity: Object.freeze({
              dev: ref.identity.dev,
              ino: ref.identity.ino,
            }),
            sourceRun: ref.sourceRun,
            sessionRevision: ref.sessionRevision,
            absolutePath: ref.absolutePath,
          });
        }
        const nextState = stateWithFileRef(stateWithInspected(callback.state, inspected), fileRef);
        const receipt = atomicReceipt({
          context: callback.context,
          sequence: current,
          transition,
          expectedHead,
          session: input.session,
          state: callback.state,
          nextState,
        });
        return receipt;
      }
      const goal = callback.goal as ReadCompositionReadGoal;
      const sandboxReceipt = await executeRead(input.sandbox, {
        goal,
        state: callback.state,
      });
      const receipt = readAtomicReceiptFromSandbox({
        context: callback.context,
        sequence: current,
        receipt: sandboxReceipt,
        session: input.session,
        state: callback.state,
        ref: goal.target.ref,
        expectedHead: "file.read",
        range: goal.requirement.range,
        read: sandboxReceipt.status === "succeeded"
          ? readFactFromReceipt(
              sandboxReceipt,
              goal.target.ref.sourceRun,
              sandboxReceipt.session_before.revision,
              goal.target.ref as ReadCompositionFileRef,
            )
          : null,
      });
      return receipt;
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

  return Object.freeze({
    adapter,
    calls,
  });
}

function listingEntriesOf(transition: CliCommandTransition): readonly { name: string; path: string; type: "file" | "directory" | "symlink" | "other" | "unknown" }[] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return Object.freeze([]);
  const observation = receipt.execution.observation;
  return observation.kind === "directory.list"
    ? Object.freeze(observation.entries.map(entry => Object.freeze({
        name: entry.name,
        path: entry.path,
        type: entry.type as "file" | "directory" | "symlink" | "other" | "unknown",
      })))
    : Object.freeze([]);
}

export function createReadCompositionDependencies(
  created: { adapter: ReadCompositionAdapter },
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  ReadCompositionState,
  unknown,
  ReadCompositionEvidencePayload,
  ReadCompositionEffectFact,
  ReadCompositionReceiptPayload,
  unknown
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: READ_COMPOSITION_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: READ_COMPOSITION_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: READ_COMPOSITION_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: READ_COMPOSITION_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
