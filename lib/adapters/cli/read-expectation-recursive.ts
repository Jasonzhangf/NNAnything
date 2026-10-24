// 本域 adapter：把读取期待单元接进既有 runRecursiveGoal。
// 根 Goal 由真实覆盖/数量/当前证据评价；模型只决定“当前需要什么”，
// 由固定绑定生成子 Goal；子 Goal 的真实读取结果更新显式 State。
import { runRecursiveGoal } from "../../workflow/recursive-goal/module.js";
import { readAtomicReceipt } from "../../workflow/recursive-goal/contracts.js";
import type {
  AtomicReceipt,
  DerivationInput,
  DerivationReceipt,
  EnabledEvaluator,
  EnabledSkill,
  EvaluationInput,
  EvaluationReceipt,
  FactSnapshot,
  RecursiveGoalAdapter,
  RecursiveGoalComparators,
  RecursiveGoalDependencies,
  RecursiveGoalLimits,
  RecursiveGoalRequestEnvelope,
  RecursiveGoalResponse,
  SelectionInput,
  SelectorBinding,
  SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import {
  measureBase,
  measureReasoning,
  superviseReasoning,
  coversRange,
  measureQuantity,
  mergeCoverage,
  requestedRange,
} from "../../filters/cli-read-expectation.js";
import type {
  BaseLabel,
  BaseVector,
  CoverageInterval,
  ReadAttempt,
  ReadContext,
  ReadFailure,
  ReadObservation,
  ReadRequest,
  ReasoningLabel,
  ReasoningVector,
} from "./read-expectation-contract.js";
import type { CliFilesystemSandbox, SessionRef } from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";
import type { ReadFeedbackUnit } from "../../training/cli-read-expectation-load.js";

export const READ_EXPECTATION_COMPOSITE_SKILL = "read-expectation.composite";
export const READ_EXPECTATION_READ_SKILL = "read-expectation.read";
export const READ_EXPECTATION_ROOT_EVALUATOR = "read-expectation-root";
export const READ_EXPECTATION_READ_EVALUATOR = "read-expectation-read";
export const READ_EXPECTATION_ROOT_SELECTOR = "read-expectation-root-selector";
export const READ_EXPECTATION_READ_SELECTOR = "read-expectation-read-selector";

const EFFECTS = Object.freeze(["filesystem.read"] as const);
/** Codes a controller may safely repeat: the read crossed no effect boundary. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EINTR", "EAGAIN", "EBUSY"]);
const REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

export type ReadExpectationRootGoal = Readonly<{
  kind: "cli.read-expectation.cover";
  path: string;
  requirement: ReadRequest;
}>;

export type ReadExpectationRangeGoal = Readonly<{
  kind: "cli.read-expectation.range";
  range: Readonly<{ offset: number; length: number }>;
  reason: "initial" | "remaining" | "retry" | "rebind";
}>;

export type ReadExpectationGoal = ReadExpectationRootGoal | ReadExpectationRangeGoal;

/** What the model decided for one real attempt, kept as provenance. */
export type ReadExpectationDecision = Readonly<{
  attemptId: string;
  range: Readonly<{ offset: number; length: number }>;
  basePrediction: Readonly<Record<BaseLabel, 0 | 1>>;
  prediction: ReasoningLabel;
  allowed: readonly ReasoningLabel[];
  legal: boolean;
}>;

export type ReadExpectationAttemptRecord = Readonly<{
  attemptId: string;
  range: Readonly<{ offset: number; length: number }>;
  status: "succeeded" | "failed";
  observation: ReadObservation | null;
  failure: ReadFailure | null;
  covered: readonly CoverageInterval[];
}>;

export type ReadExpectationState = Readonly<{
  stateId: string;
  session: Readonly<{ id: string; cwd: string; revision: number; grantedEffects: readonly string[] }>;
  path: string;
  fileRef: ObservedObjectRef | null;
  coverage: readonly CoverageInterval[];
  attempts: readonly ReadExpectationAttemptRecord[];
  reads: number;
}>;

export type ReadExpectationEvidencePayload = Readonly<{
  kind: "cli.read-expectation.receipt.v1";
  attemptId: string;
  stateId: string;
  range: Readonly<{ offset: number; length: number }>;
  observation: ReadObservation | null;
  failure: ReadFailure | null;
}>;

export type ReadExpectationEffectFact = Readonly<{ kind: "filesystem.read"; path: string }>;

export type ReadExpectationReceiptPayload = Readonly<{
  kind: "file.read";
  status: "succeeded" | "failed";
  bytesRead: number | null;
  code: string | null;
}>;

type ReadExpectationCursor = Readonly<{ round: number }>;

export type ReadExpectationRunResult = Readonly<{
  response: RecursiveGoalResponse<unknown, ReadExpectationState, ReadExpectationBindings, ReadExpectationEvidencePayload, ReadExpectationEffectFact, ReadExpectationReceiptPayload, ReadExpectationCursor>;
  decisions: readonly ReadExpectationDecision[];
  finalState: ReadExpectationState | null;
}>;

export type ReadExpectationBindings = Readonly<{
  session: SessionRef;
  fileRef: ObservedObjectRef;
  requirement: ReadRequest;
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

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function readAttemptObservation(value: unknown): ReadObservation | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("observation must be an object or null");
  const identity = isRecord(value.identity) ? value.identity : {};
  return Object.freeze({
    offset: nonnegativeInteger(value.offset, "observation.offset"),
    length: nonnegativeInteger(value.length, "observation.length"),
    size: nonnegativeInteger(value.size, "observation.size"),
    bytes: nonEmpty(value.bytes, "observation.bytes"),
    bytesRead: nonnegativeInteger(value.bytesRead, "observation.bytesRead"),
    eof: value.eof === true,
    dev: identity.dev as number | string,
    ino: identity.ino as number | string,
  });
}

function readAttemptFailure(value: unknown): ReadFailure | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("failure must be an object or null");
  return Object.freeze({
    stage: (value.stage === "validate" ? "validate" : "observe") as "observe" | "validate",
    code: nonEmpty(value.code, "failure.code"),
    message: typeof value.message === "string" ? value.message : "",
    executorInvoked: value.executorInvoked === true,
  });
}

function readCoverage(value: unknown): readonly CoverageInterval[] {
  if (!Array.isArray(value)) throw new TypeError("coverage must be an array");
  return Object.freeze(value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(`coverage[${index}] must be a pair`);
    return Object.freeze([nonnegativeInteger(entry[0], `coverage[${index}].start`), nonnegativeInteger(entry[1], `coverage[${index}].end`)]) as CoverageInterval;
  }));
}

function readRequest(value: unknown): ReadRequest {
  if (!isRecord(value)) throw new TypeError("request must be an object");
  const shape = value.shape;
  const mode = value.mode;
  if (shape !== "head" && shape !== "tail" && shape !== "range") throw new TypeError("request.shape is invalid");
  if (mode !== "up_to" && mode !== "exact") throw new TypeError("request.mode is invalid");
  return Object.freeze({
    shape,
    mode,
    quantity: nonnegativeInteger(value.quantity, "request.quantity"),
    offset: nonnegativeInteger(value.offset, "request.offset"),
    length: nonnegativeInteger(value.length, "request.length"),
  });
}

function readAttemptRecord(value: unknown): ReadExpectationAttemptRecord {
  if (!isRecord(value)) throw new TypeError("attempt record must be an object");
  const range = isRecord(value.range) ? value.range : {};
  return Object.freeze({
    attemptId: nonEmpty(value.attemptId, "attempt.attemptId"),
    range: Object.freeze({
      offset: nonnegativeInteger(range.offset, "attempt.range.offset"),
      length: nonnegativeInteger(range.length, "attempt.range.length"),
    }),
    status: value.status === "succeeded" ? "succeeded" : "failed",
    observation: readAttemptObservation(value.observation ?? null),
    failure: readAttemptFailure(value.failure ?? null),
    covered: readCoverage(value.covered ?? []),
  });
}

function readState(value: unknown): ReadExpectationState {
  if (!isRecord(value)) throw new TypeError("read expectation state must be an object");
  const session = isRecord(value.session) ? value.session : {};
  const granted = session.grantedEffects;
  if (!Array.isArray(granted)) throw new TypeError("state.session.grantedEffects must be an array");
  const attempts = value.attempts;
  if (!Array.isArray(attempts)) throw new TypeError("state.attempts must be an array");
  return Object.freeze({
    stateId: nonEmpty(value.stateId, "state.stateId"),
    session: Object.freeze({
      id: nonEmpty(session.id, "state.session.id"),
      cwd: nonEmpty(session.cwd, "state.session.cwd"),
      revision: nonnegativeInteger(session.revision, "state.session.revision"),
      grantedEffects: Object.freeze(granted.map(entry => nonEmpty(entry, "state.session.grantedEffects entry"))),
    }),
    path: nonEmpty(value.path, "state.path"),
    fileRef: (value.fileRef ?? null) as ObservedObjectRef | null,
    coverage: readCoverage(value.coverage),
    attempts: Object.freeze(attempts.map(readAttemptRecord)),
    reads: nonnegativeInteger(value.reads, "state.reads"),
  });
}

function readBindings(value: unknown): ReadExpectationBindings {
  if (!isRecord(value)) throw new TypeError("read expectation bindings must be an object");
  return Object.freeze({
    session: value.session as SessionRef,
    fileRef: value.fileRef as ObservedObjectRef,
    requirement: readRequest(value.requirement),
  });
}

function readEvidencePayload(value: unknown): ReadExpectationEvidencePayload {
  if (!isRecord(value)) throw new TypeError("evidence payload must be an object");
  const range = isRecord(value.range) ? value.range : {};
  return Object.freeze({
    kind: "cli.read-expectation.receipt.v1",
    attemptId: nonEmpty(value.attemptId, "evidence.attemptId"),
    stateId: nonEmpty(value.stateId, "evidence.stateId"),
    range: Object.freeze({
      offset: nonnegativeInteger(range.offset, "evidence.range.offset"),
      length: nonnegativeInteger(range.length, "evidence.range.length"),
    }),
    observation: readAttemptObservation(value.observation ?? null),
    failure: readAttemptFailure(value.failure ?? null),
  });
}

function readEffectFact(value: unknown): ReadExpectationEffectFact {
  if (!isRecord(value)) throw new TypeError("effect fact must be an object");
  return Object.freeze({ kind: "filesystem.read", path: nonEmpty(value.path, "effect.path") });
}

function readReceiptPayload(value: unknown): ReadExpectationReceiptPayload {
  if (!isRecord(value)) throw new TypeError("receipt payload must be an object");
  const bytesRead = value.bytesRead;
  return Object.freeze({
    kind: "file.read",
    status: value.status === "succeeded" ? "succeeded" : "failed",
    bytesRead: bytesRead === null || bytesRead === undefined ? null : nonnegativeInteger(bytesRead, "receipt.bytesRead"),
    code: value.code === null || value.code === undefined ? null : nonEmpty(value.code, "receipt.code"),
  });
}

function readCursor(value: unknown): ReadExpectationCursor {
  if (!isRecord(value)) throw new TypeError("cursor must be an object");
  return Object.freeze({ round: nonnegativeInteger(value.round, "cursor.round") });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const COMPARATORS: RecursiveGoalComparators<unknown, ReadExpectationBindings, ReadExpectationState, ReadExpectationEvidencePayload> = Object.freeze({
  sameGoal: sameJson,
  sameBindings: sameJson,
  sameFacts: (left: FactSnapshot<ReadExpectationState, ReadExpectationEvidencePayload>, right: FactSnapshot<ReadExpectationState, ReadExpectationEvidencePayload>) => sameJson(left, right),
});

const DOMAIN_GUARDS = Object.freeze({
  goal: (value: unknown) => value,
  state: readState,
  bindings: readBindings,
  evidencePayload: readEvidencePayload,
  effectFact: readEffectFact,
  sameEffectFact: sameJson,
  receiptPayload: readReceiptPayload,
  cursor: readCursor,
  sameGoal: COMPARATORS.sameGoal,
  sameBindings: COMPARATORS.sameBindings,
  sameFacts: COMPARATORS.sameFacts as (left: unknown, right: unknown) => boolean,
  sameCursor: sameJson,
});

export const READ_EXPECTATION_SKILLS: readonly EnabledSkill[] = Object.freeze([
  Object.freeze({
    id: READ_EXPECTATION_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.read.expectation",
    evaluatorId: READ_EXPECTATION_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: READ_EXPECTATION_READ_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "cli.read.range",
    evaluatorId: READ_EXPECTATION_READ_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    // A read that crossed no effect boundary may be repeated by the controller.
    retry: "completed_no_effect",
    effectClass: "read_only",
  }),
]);

export const READ_EXPECTATION_EVALUATORS: readonly EnabledEvaluator[] = Object.freeze([
  Object.freeze({
    id: READ_EXPECTATION_ROOT_EVALUATOR,
    goalType: "cli.read-expectation.cover",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_EXPECTATION_READ_EVALUATOR,
    goalType: "cli.read-expectation.range",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const READ_EXPECTATION_SELECTORS: readonly SelectorBinding[] = Object.freeze([
  Object.freeze({ id: READ_EXPECTATION_ROOT_SELECTOR, skillIds: Object.freeze([READ_EXPECTATION_COMPOSITE_SKILL]) }),
  Object.freeze({ id: READ_EXPECTATION_READ_SELECTOR, skillIds: Object.freeze([READ_EXPECTATION_READ_SKILL]) }),
]);

function isRootGoal(value: unknown): boolean {
  return isRecord(value) && value.kind === "cli.read-expectation.cover";
}

function isRangeGoal(value: unknown): boolean {
  return isRecord(value) && value.kind === "cli.read-expectation.range";
}

function supports(input: SupportsInput<unknown, ReadExpectationBindings>): boolean {
  if (input.skill.id === READ_EXPECTATION_COMPOSITE_SKILL) return isRootGoal(input.goal);
  if (input.skill.id === READ_EXPECTATION_READ_SKILL) return isRangeGoal(input.goal);
  return false;
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

function stateEvidenceRefs(state: ReadExpectationState, evidence: readonly { id: string; stateRef: string; validity: string }[]): readonly string[] {
  return evidence.filter(item => item.validity === "valid" && item.stateRef === state.stateId).map(item => item.id);
}

/** Root satisfaction uses real coverage and quantity only; the model never decides it. */
function rootSatisfied(
  state: ReadExpectationState,
  requirement: ReadRequest,
  admitted: boolean,
  context: ReadContext,
): boolean | null {
  const last = state.attempts.at(-1);
  if (last === undefined) return null;
  if (last.failure !== null) return false;
  const attempt = attemptOf(last, priorOf(state), requirement);
  const quantity = measureQuantity(attempt, declaredContext(admitted, context));
  if (quantity.known === 0) return null;
  return quantity.qtyMet === 1;
}

function rangeCovered(state: ReadExpectationState, goal: ReadExpectationRangeGoal): boolean {
  const last = state.attempts.at(-1);
  if (last === undefined || last.observation === null) return false;
  const start = goal.range.offset;
  const end = start + goal.range.length;
  if (coversRange(last.covered, start, end)) return true;
  // A bounded read at a confirmed end is complete even when it returned fewer bytes.
  return last.observation.offset + last.observation.bytesRead >= last.observation.size
    && start + goal.range.length > last.observation.size
    && start <= last.observation.offset + last.observation.bytesRead;
}

/**
 * The model sees the user requirement and everything already obtained, not the
 * bounded child range: the requirement is what the decision is about.
 */
function attemptOf(
  record: ReadExpectationAttemptRecord,
  prior: readonly CoverageInterval[],
  requirement: ReadRequest,
): ReadAttempt {
  return Object.freeze({
    request: requirement,
    observation: record.observation,
    failure: record.failure,
    priorCoverage: Object.freeze([...prior]),
  });
}

function priorOf(state: ReadExpectationState): readonly CoverageInterval[] {
  return mergeCoverage(state.attempts.slice(0, -1).flatMap(attempt => attempt.covered));
}

/**
 * Retry facts come from the declared retry policy only. The controller owns how
 * many repeats actually happen; the domain never keeps its own copy.
 */
function declaredContext(admitted: boolean, context: ReadContext): ReadContext {
  return Object.freeze({
    target: context.target,
    bindingReissuable: context.bindingReissuable,
    retryEligible: admitted,
    retryBudgetLeft: admitted ? 1 : 0,
    retryExhausted: !admitted,
    skills: context.skills,
  });
}

function nextGap(state: ReadExpectationState, requirement: ReadRequest): Readonly<{ offset: number; length: number }> | null {
  const size = state.attempts.reduce<number | null>((found, attempt) => found ?? attempt.observation?.size ?? null, null);
  const endConfirmed = state.attempts.some(attempt => attempt.observation !== null
    && attempt.range.offset + attempt.observation.bytesRead >= attempt.observation.size);
  const [needStart, needEnd] = requestedRange(
    {
      request: requirement,
      observation: { offset: 0, length: requirement.length, size: size ?? 0, bytes: "", bytesRead: 0, eof: false, dev: 0, ino: 0 },
      failure: null,
      priorCoverage: [],
    } as ReadAttempt,
    endConfirmed,
    size ?? 0,
  );
  const merged = state.coverage;
  for (let cursor = needStart; cursor < needEnd; cursor += 1) {
    const covered = merged.some(([start, end]) => cursor >= start && cursor < end);
    if (!covered) {
      let end = cursor + 1;
      while (end < needEnd && !merged.some(([start, stop]) => end >= start && end < stop)) end += 1;
      return Object.freeze({ offset: cursor, length: end - cursor });
    }
  }
  return null;
}

function condition(
  id: string,
  goal: ReadExpectationGoal,
  bindings: ReadExpectationBindings,
  selectorId: string,
  evaluatorId: string,
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
    allowedEffects: Object.freeze([...EFFECTS]),
  });
}

export type ReadExpectationPolicy = "learned" | "baseline";

export type ReadExpectationAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  unit: ReadFeedbackUnit;
  context: ReadContext;
  requirement: ReadRequest;
  path: string;
  fileRef: ObservedObjectRef;
  retryBudget: number;
  /** Harness-owned I/O cap: one read never asks for more bytes than this. */
  maxReadBytes: number;
  /** `baseline` follows the same controller without the learned units. */
  policy: ReadExpectationPolicy;
}>;

export function createReadExpectationAdapter(input: ReadExpectationAdapterInput) {
  const decisions: ReadExpectationDecision[] = [];
  const calls = { validateRequest: 0, supports: 0, evaluate: 0, select: 0, derive: 0, executeAtomic: 0, validateAtomicReceipt: 0, measureProgress: 0 };
  let state: ReadExpectationState | null = null;
  let sequence = 0;

  function initialState(requestId: string): ReadExpectationState {
    const snapshot = input.sandbox.getSession(input.session);
    return Object.freeze({
      stateId: `${requestId}:state:initial`,
      session: Object.freeze({
        id: snapshot.id,
        cwd: snapshot.cwd,
        revision: snapshot.revision,
        grantedEffects: Object.freeze([...snapshot.grantedEffects]),
      }),
      path: input.path,
      fileRef: input.fileRef,
      coverage: Object.freeze([]),
      attempts: Object.freeze([]),
      reads: 0,
    });
  }

  function computeDecision(record: ReadExpectationAttemptRecord, prior: readonly CoverageInterval[], requirement: ReadRequest) {
    const attempt = attemptOf(record, prior, requirement);
    const baseVector: BaseVector = measureBase(attempt);
    const basePrediction = input.unit.inferBase(baseVector);
    const context = declaredContext(input.retryBudget > 0, input.context);
    const vector: ReasoningVector = measureReasoning(basePrediction, attempt, context);
    const prediction = input.unit.inferReasoning(vector);
    const oracle = superviseReasoning(attempt, context);
    return { prediction, allowed: oracle.allowed, basePrediction, legal: oracle.allowed.includes(prediction) };
  }

  const adapter: RecursiveGoalAdapter<
    unknown,
    ReadExpectationState,
    ReadExpectationBindings,
    ReadExpectationEvidencePayload,
    ReadExpectationEffectFact,
    ReadExpectationReceiptPayload,
    ReadExpectationCursor
  > = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = request.rootGoal;
      if (!isRootGoal(rootGoal)) throw new TypeError("read expectation root goal must be a cover goal");
      const rootBindings = readBindings(request.rootBindings);
      const restored = readState(request.state);
      state = restored;
      if (request.rootEvaluatorId !== READ_EXPECTATION_ROOT_EVALUATOR || request.rootSelectorId !== READ_EXPECTATION_ROOT_SELECTOR) {
        throw new TypeError("read expectation request evaluator or selector is unsupported");
      }
      return Object.freeze({
        requestId: request.requestId,
        rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state: restored,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation: null,
        // The admitted retry policy is the controller's, so it must pass
        // through unchanged.
        ...(request.retryPolicy === undefined ? {} : { retryPolicy: request.retryPolicy }),
      });
    },

    supports(callback) {
      calls.supports += 1;
      return supports(callback);
    },

    async evaluate(callback: EvaluationInput<unknown, ReadExpectationState, ReadExpectationBindings, ReadExpectationEvidencePayload>) {
      calls.evaluate += 1;
      const evidenceRefs = stateEvidenceRefs(callback.state, callback.evidence);
      if (isRootGoal(callback.goal)) {
        const goal = callback.goal as ReadExpectationRootGoal;
        const satisfied = rootSatisfied(callback.state, goal.requirement, input.retryBudget > 0, input.context);
        if (satisfied === true) return evaluation(READ_EXPECTATION_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
        if (satisfied === false) return evaluation(READ_EXPECTATION_ROOT_EVALUATOR, "unsatisfied", 0, evidenceRefs);
        return evaluation(READ_EXPECTATION_ROOT_EVALUATOR, "unknown", null, []);
      }
      const goal = callback.goal as ReadExpectationRangeGoal;
      if (rangeCovered(callback.state, goal)) {
        return evaluation(READ_EXPECTATION_READ_EVALUATOR, "satisfied", 100, evidenceRefs);
      }
      const last = callback.state.attempts.at(-1);
      if (last !== undefined && last.failure !== null) {
        return evaluation(READ_EXPECTATION_READ_EVALUATOR, "unsatisfied", 0, evidenceRefs);
      }
      return evaluation(READ_EXPECTATION_READ_EVALUATOR, "unknown", null, []);
    },

    async select(callback: SelectionInput<unknown, ReadExpectationState, ReadExpectationBindings, ReadExpectationEvidencePayload>) {
      calls.select += 1;
      const first = callback.candidates[0];
      return first === undefined
        ? { kind: "no_capability" as const, searchedSkillIds: [] }
        : { kind: "selected" as const, skillId: first.id };
    },

    async derive(callback: DerivationInput<unknown, ReadExpectationState, ReadExpectationBindings, ReadExpectationEvidencePayload, ReadExpectationCursor>): Promise<DerivationReceipt<ReadExpectationGoal, ReadExpectationBindings, ReadExpectationCursor>> {
      calls.derive += 1;
      const round = callback.cursor === null ? 0 : callback.cursor.round;
      const bindings = callback.bindings;
      const required = bindings.requirement;
      const currentState = state ?? callback.state;
      // First round: read the head of the requested range.
      if (currentState.attempts.length === 0) {
        const firstLength = Math.max(1, Math.min(required.length === 0 ? 1 : required.length, input.maxReadBytes));
        const first = Object.freeze({ kind: "cli.read-expectation.range" as const, range: Object.freeze({ offset: required.offset, length: firstLength }), reason: "initial" as const });
        return Object.freeze({
          conditions: Object.freeze([condition(`read-${round}`, first, bindings, READ_EXPECTATION_READ_SELECTOR, READ_EXPECTATION_READ_EVALUATOR)]),
          nextCursor: Object.freeze({ round: round + 1 }),
          expansion: "more" as const,
        });
      }
      // The model decides what is needed next, from the real last attempt.
      const last = currentState.attempts.at(-1)!;
      const prior = priorOf(currentState);
      if (input.policy === "baseline") {
        const gap = nextGap(currentState, required);
        if (gap === null) {
          return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ round: round + 1 }), expansion: "closed" as const });
        }
        const length = Math.max(1, Math.min(gap.length, input.maxReadBytes));
        const child = Object.freeze({ kind: "cli.read-expectation.range" as const, range: Object.freeze({ offset: gap.offset, length }), reason: "remaining" as const });
        return Object.freeze({
          conditions: Object.freeze([condition(`read-${round}`, child, bindings, READ_EXPECTATION_READ_SELECTOR, READ_EXPECTATION_READ_EVALUATOR)]),
          nextCursor: Object.freeze({ round: round + 1 }),
          expansion: "more" as const,
        });
      }
      const decided = computeDecision(last, prior, required);
      decisions.push(Object.freeze({
        attemptId: last.attemptId,
        range: last.range,
        basePrediction: decided.basePrediction,
        prediction: decided.prediction,
        allowed: decided.allowed,
        legal: decided.legal,
      }));
      if (!decided.legal) {
        // Wrong model output stops the chain here: no illegal operation follows.
        throw new TypeError(
          `read expectation model predicted ${decided.prediction} outside the oracle allowed set [${decided.allowed.join(", ")}]`,
        );
      }
      if (decided.prediction === "condition_met") {
        return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ round: round + 1 }), expansion: "closed" as const });
      }
      if (decided.prediction === "need_remaining_data") {
        const gap = nextGap(currentState, required);
        if (gap === null) {
          return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ round: round + 1 }), expansion: "closed" as const });
        }
        const bounded = Object.freeze({ offset: gap.offset, length: Math.max(1, Math.min(gap.length, input.maxReadBytes)) });
        const child = Object.freeze({ kind: "cli.read-expectation.range" as const, range: bounded, reason: "remaining" as const });
        return Object.freeze({
          conditions: Object.freeze([condition(`read-${round}`, child, bindings, READ_EXPECTATION_READ_SELECTOR, READ_EXPECTATION_READ_EVALUATOR)]),
          nextCursor: Object.freeze({ round: round + 1 }),
          expansion: "more" as const,
        });
      }
      if (decided.prediction === "retry_current_read") {
        const child = Object.freeze({ kind: "cli.read-expectation.range" as const, range: last.range, reason: "retry" as const });
        return Object.freeze({
          conditions: Object.freeze([condition(`read-${round}`, child, bindings, READ_EXPECTATION_READ_SELECTOR, READ_EXPECTATION_READ_EVALUATOR)]),
          nextCursor: Object.freeze({ round: round + 1 }),
          expansion: "more" as const,
        });
      }
      if (decided.prediction === "need_current_target") {
        const child = Object.freeze({ kind: "cli.read-expectation.range" as const, range: last.range, reason: "rebind" as const });
        return Object.freeze({
          conditions: Object.freeze([condition(`read-${round}`, child, bindings, READ_EXPECTATION_READ_SELECTOR, READ_EXPECTATION_READ_EVALUATOR)]),
          nextCursor: Object.freeze({ round: round + 1 }),
          expansion: "more" as const,
        });
      }
      // terminal_error and need_observation stop the chain without claiming success.
      return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ round: round + 1 }), expansion: "closed" as const });
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      sequence += 1;
      const current = sequence;
      const goal = callback.goal as ReadExpectationRangeGoal;
      const requestId = callback.context.requestId;
      const previous = state!;
      let ref = previous.fileRef ?? input.fileRef;
      if (goal.reason === "rebind") {
        ref = await input.sandbox.bindFile(input.session, previous.path);
      }
      await input.sandbox.validateObservedObject(ref);
      const receipt = await input.sandbox.execute({
        operation: "file.read",
        parameters: { ref, offset: goal.range.offset, length: goal.range.length },
      });
      const observation = receipt.status === "succeeded" ? readObservationOf(receipt) : null;
      const failure = receipt.status === "succeeded" ? null : readFailureOf(receipt);
      const attemptId = `${requestId}:attempt:${current}`;
      const nextStateId = `${requestId}:state:${current}`;
      const covered = observation === null ? Object.freeze([]) : Object.freeze([Object.freeze([observation.offset, observation.offset + observation.bytesRead]) as CoverageInterval]);
      const attempt: ReadExpectationAttemptRecord = Object.freeze({
        attemptId,
        range: Object.freeze({ offset: goal.range.offset, length: goal.range.length }),
        status: receipt.status === "succeeded" ? "succeeded" : "failed",
        observation,
        failure,
        covered,
      });
      const merged = mergeCoverage([...previous.coverage, ...covered]);
      const nextState: ReadExpectationState = Object.freeze({
        ...previous,
        stateId: nextStateId,
        fileRef: ref,
        coverage: merged,
        attempts: Object.freeze([...previous.attempts, attempt]),
        reads: previous.reads + 1,
      });
      state = nextState;
      const evidence = Object.freeze([
        Object.freeze({
          id: `${attemptId}:evidence`,
          stateRef: nextStateId,
          payload: Object.freeze({
            kind: "cli.read-expectation.receipt.v1" as const,
            attemptId,
            stateId: nextStateId,
            range: Object.freeze({ offset: goal.range.offset, length: goal.range.length }),
            observation,
            failure,
          }),
          validity: "valid" as const,
        }),
      ]);
      // A file read confirms no side effect, so the controller's bounded retry
      // policy may treat a transient failure as safely repeatable.
      const effectKnowledge = "none" as const;
      const atomic: AtomicReceipt<ReadExpectationState, ReadExpectationEvidencePayload, ReadExpectationEffectFact, ReadExpectationReceiptPayload> = Object.freeze({
        runId: typeof (receipt as { execution?: { runId?: unknown } }).execution?.runId === "string"
          ? (receipt as { execution: { runId: string } }).execution.runId
          : null,
        executorInvoked: (receipt as { execution?: { executorInvoked?: unknown } }).execution?.executorInvoked === true,
        // A retryable read error completed as a no-effect step, so the controller
        // may repeat it under its own bounded retry policy. A terminal error
        // stays a real failure and stops the run. No receipt at all is unknown.
        outcome: outcomeOf(observation, failure),
        sourceResult: Object.freeze({
          tag: "file.read",
          value: Object.freeze({
            kind: "file.read" as const,
            status: receipt.status === "succeeded" ? "succeeded" as const : "failed" as const,
            bytesRead: observation?.bytesRead ?? null,
            code: failure?.code ?? null,
          }),
        }),
        newState: Object.freeze({ id: nextStateId, value: nextState }),
        evidence,
        executionErrors: Object.freeze([]),
        verificationErrors: Object.freeze([]),
        effect: Object.freeze({
          knowledge: effectKnowledge,
          confirmedEffects: Object.freeze([]),
          receiptRef: null,
        }),
      });
      return atomic;
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt<
        ReadExpectationState,
        ReadExpectationEvidencePayload,
        ReadExpectationEffectFact,
        ReadExpectationReceiptPayload
      >(raw, DOMAIN_GUARDS);
    },

    assessRetry(callback) {
      const payload = callback.atomicResult.sourceResult;
      const value = payload === null ? null : (payload as { value?: unknown }).value;
      const code = isRecord(value) && typeof value.code === "string" ? value.code : null;
      const evidenceRefs = callback.evaluation.evidenceRefs;
      if (code === null || evidenceRefs.length === 0) {
        return Object.freeze({ kind: "stop" as const, reason: "evidence_insufficient" as const });
      }
      if (!TRANSIENT_CODES.has(code)) {
        return Object.freeze({ kind: "stop" as const, reason: "unsupported_retry" as const });
      }
      return Object.freeze({ kind: "safe_same_failure" as const, failureKey: `file.read:${code}`, evidenceRefs: Object.freeze([evidenceRefs[0]!]) });
    },

    measureProgress(callback) {
      calls.measureProgress += 1;
      const beforeBytes = callback.before.coverage.reduce((sum, [start, end]) => sum + (end - start), 0);
      const afterBytes = callback.after.coverage.reduce((sum, [start, end]) => sum + (end - start), 0);
      if (afterBytes > beforeBytes) {
        return Object.freeze({ improved: true, reason: "obligation_reduced" as const, comparable: true });
      }
      // A definite failure that was not seen before is new information about the
      // target, so the run is not going in circles.
      const seen = new Set(callback.before.attempts.map(attempt => `${attempt.status}:${attempt.failure?.code ?? ""}`));
      const last = callback.after.attempts.at(-1);
      const fresh = last !== undefined && !seen.has(`${last.status}:${last.failure?.code ?? ""}`);
      return fresh
        ? Object.freeze({ improved: true, reason: "facts_improved" as const, comparable: true })
        : Object.freeze({ improved: false, reason: "none" as const, comparable: true });
    },
  };

  return Object.freeze({
    adapter,
    decisions,
    calls,
    initialState,
    getState: () => state,
    setState: (next: ReadExpectationState) => { state = next; },
  });
}

function outcomeOf(observation: ReadObservation | null, failure: ReadFailure | null): "succeeded" | "failed" | "unknown" {
  if (observation !== null) return "succeeded";
  if (failure === null) return "unknown";
  return TRANSIENT_CODES.has(failure.code) ? "succeeded" : "failed";
}

function readObservationOf(receipt: unknown): ReadObservation {
  const observation = (receipt as { execution: { observation: Record<string, unknown> } }).execution.observation;
  const identity = isRecord(observation.identity) ? observation.identity : {};
  return Object.freeze({
    offset: Number(observation.offset),
    length: Number(observation.length),
    size: Number(observation.size),
    bytes: String(observation.bytes),
    bytesRead: Number(observation.bytesRead),
    eof: observation.eof === true,
    dev: identity.dev as number | string,
    ino: identity.ino as number | string,
  });
}

function readFailureOf(receipt: unknown): ReadFailure {
  const error = (receipt as { execution: { error: Record<string, unknown> } }).execution.error;
  return Object.freeze({
    stage: (error.stage === "validate" ? "validate" : "observe") as "observe" | "validate",
    code: String(error.code),
    message: typeof error.message === "string" ? error.message : "",
    executorInvoked: (receipt as { execution: { executorInvoked?: unknown } }).execution.executorInvoked === true,
  });
}

export function createReadExpectationDependencies(
  created: ReturnType<typeof createReadExpectationAdapter>,
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  ReadExpectationState,
  ReadExpectationBindings,
  ReadExpectationEvidencePayload,
  ReadExpectationEffectFact,
  ReadExpectationReceiptPayload,
  ReadExpectationCursor
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: READ_EXPECTATION_SKILLS,
    enabledEvaluators: READ_EXPECTATION_EVALUATORS,
    selectors: READ_EXPECTATION_SELECTORS,
    comparators: COMPARATORS,
    grantedEffects: new Set<string>(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}

export type ReadExpectationGoalResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  fileRef: ObservedObjectRef;
  unit: ReadFeedbackUnit;
  context: ReadContext;
  request: ReadRequest;
  path: string;
  maxReadBytes?: number;
  policy?: ReadExpectationPolicy;
  limits?: RecursiveGoalLimits;
  retryBudget?: number;
  signal?: AbortSignal;
}>;

/**
 * The single public entry for both consumers: the model's current requirement
 * binds a child Goal, runRecursiveGoal executes it, and the root is evaluated
 * from real coverage.
 */
export async function runCliReadExpectationGoal(
  rawRequest: Readonly<{ requestId: string; requirement: ReadRequest; path: string }>,
  resources: ReadExpectationGoalResources,
): Promise<ReadExpectationRunResult> {
  const created = createReadExpectationAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    unit: resources.unit,
    context: resources.context,
    requirement: resources.request,
    path: resources.path,
    fileRef: resources.fileRef,
    retryBudget: resources.retryBudget ?? 0,
    maxReadBytes: resources.maxReadBytes ?? Number.MAX_SAFE_INTEGER,
    policy: resources.policy ?? "learned",
  });
  const state = created.initialState(rawRequest.requestId);
  created.setState(state);
  const rootGoal: ReadExpectationRootGoal = Object.freeze({
    kind: "cli.read-expectation.cover",
    path: resources.path,
    requirement: resources.request,
  });
  const bindings: ReadExpectationBindings = Object.freeze({
    session: resources.session,
    fileRef: resources.fileRef,
    requirement: resources.request,
  });
  const response = await runRecursiveGoal(
    {
      schema: REQUEST_SCHEMA,
      requestId: rawRequest.requestId,
      rootGoal,
      satisfactionThreshold: 100,
      rootBindings: bindings,
      state,
      rootEvaluatorId: READ_EXPECTATION_ROOT_EVALUATOR,
      rootSelectorId: READ_EXPECTATION_ROOT_SELECTOR,
      // One bounded read costs several controller transitions; the default cap
      // covers the trajectories this domain actually runs.
      limits: resources.limits ?? Object.freeze({ maxTransitions: 60, maxDepth: 5, maxDerivedGoals: 12 }),
      ...(resources.retryBudget !== undefined && resources.retryBudget > 0
        ? {
            retryPolicy: {
              kind: "bounded_strategy_retry.v1" as const,
              selectorId: READ_EXPECTATION_READ_SELECTOR,
              strategySkillIds: [READ_EXPECTATION_READ_SKILL],
              // The controller marks a strategy exhausted once the failure count
              // reaches the limit, so one admitted repeat needs room for two.
              sameFailureLimit: resources.retryBudget + 1,
              maxAtomicAttempts: resources.retryBudget + 2,
            },
          }
        : {}),
    },
    createReadExpectationDependencies(created, resources.signal),
  );
  return Object.freeze({
    response: response as ReadExpectationRunResult["response"],
    decisions: Object.freeze([...created.decisions]),
    finalState: created.getState(),
  });
}
