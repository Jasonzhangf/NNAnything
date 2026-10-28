import type {
  AdapterDiagnostic,
  AtomicReceipt,
  DerivationInput,
  EnabledEvaluator,
  EnabledSkill,
  EvaluationInput,
  EvaluationReceipt,
  FactSnapshot,
  RecursiveGoalAdapter,
  RecursiveGoalComparators,
  RecursiveGoalDependencies,
  RecursiveGoalRequestEnvelope,
  SelectorBinding,
  SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import {
  readAtomicReceipt,
  readRecursiveGoalContinuation,
  type RecursiveGoalContinuationGuards,
} from "../../workflow/recursive-goal/contracts.js";
import {
  COMMAND_SEARCH_EFFECT_KIND,
  COMMAND_SEARCH_EVIDENCE_KIND,
  createCommandSearchDomainGuards,
  readCommandSearchEffectFact,
  readCommandSearchEvidencePayload,
  readCommandSearchState,
  normalizeCommandSearchContinuation,
  restoredCommandSearchSequence,
  validateCommandSearchBindings,
  validateCommandSearchRequest,
  type CommandSearchBindings,
  type CommandSearchDomainGuards,
  type CommandSearchEffectFact,
  type CommandSearchEvidencePayload,
  type CommandSearchGoal,
  type CommandSearchReadFact,
  type CommandSearchRequest,
  type CommandSearchRdeaStep,
  type CommandSearchSlot,
  type CommandSearchSlotFact,
  type CommandSearchState,
  type CommandSearchStepReceipt,
} from "./command-search-contract.js";
import {
  commandSearchStepFromEvaluation,
  evaluateCommandSearchRdea,
  type CliHybridSearchModel,
  type CommandSearchRdeaEvaluation,
} from "../../filters/cli-command-search.js";
import type {
  CliCommandSearchLimits,
  CommandSpawnLedgerEntry,
  DirectorySearchContentObservation,
  DirectorySearchEntriesObservation,
  DirectoryRef,
  FileReadLinesObservation,
  FileReadObservation,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import type { CliFilesystemSandbox } from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";

export const COMMAND_SEARCH_ROOT_SKILL = "command-search.composite";
export const COMMAND_SEARCH_ATOMIC_SKILL = "command-search.atomic";
export const COMMAND_SEARCH_ROOT_EVALUATOR = "command-search-root";
export const COMMAND_SEARCH_ATOMIC_EVALUATOR = "command-search-atomic";
export const COMMAND_SEARCH_ROOT_SELECTOR = "command-search-root-selector";
export const COMMAND_SEARCH_ATOMIC_SELECTOR = "command-search-atomic-selector";

const EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

export const COMMAND_SEARCH_SKILLS = Object.freeze([
  Object.freeze({
    id: COMMAND_SEARCH_ROOT_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "command.search",
    evaluatorId: COMMAND_SEARCH_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: COMMAND_SEARCH_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "command.search.step",
    evaluatorId: COMMAND_SEARCH_ATOMIC_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const COMMAND_SEARCH_EVALUATORS = Object.freeze([
  Object.freeze({
    id: COMMAND_SEARCH_ROOT_EVALUATOR,
    goalType: "cli.command-search.root",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: COMMAND_SEARCH_ATOMIC_EVALUATOR,
    goalType: "cli.command-search.atomic.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const COMMAND_SEARCH_SELECTORS = Object.freeze([
  Object.freeze({
    id: COMMAND_SEARCH_ROOT_SELECTOR,
    skillIds: Object.freeze([COMMAND_SEARCH_ROOT_SKILL]),
  }),
  Object.freeze({
    id: COMMAND_SEARCH_ATOMIC_SELECTOR,
    skillIds: Object.freeze([COMMAND_SEARCH_ATOMIC_SKILL]),
  }),
]);

export type CommandSearchActionGoal = Readonly<{
  kind: "cli.command-search-action";
  action:
    | Readonly<{
        kind: "search";
        slot: CommandSearchSlot;
        operation: "directory.search.entries" | "directory.search.content";
      }>
    | Readonly<{
        kind: "read";
        slot: CommandSearchSlot;
      }>;
}>;

export type CommandSearchDomainGoal = CommandSearchGoal | CommandSearchActionGoal;

export type CommandSearchAdapter = RecursiveGoalAdapter<
  CommandSearchDomainGoal,
  CommandSearchState,
  CommandSearchBindings,
  CommandSearchEvidencePayload,
  CommandSearchEffectFact,
  SemanticCallReceipt,
  { readonly phase: "execute" | "closed" }
>;

export type CommandSearchAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  l2Model: CliHybridSearchModel;
  explicitLimits?: CliCommandSearchLimits;
}>;

export type CommandSearchAdapterHandle = Readonly<{
  adapter: CommandSearchAdapter;
  issuedRefs: () => readonly ObservedObjectRef[];
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

export const COMMAND_SEARCH_COMPARATORS: RecursiveGoalComparators<
  CommandSearchDomainGoal,
  CommandSearchBindings,
  CommandSearchState,
  CommandSearchEvidencePayload
> = Object.freeze({
  sameGoal: (left: CommandSearchDomainGoal, right: CommandSearchDomainGoal) =>
    JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: CommandSearchBindings, right: CommandSearchBindings) =>
    JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
    right: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function readActionGoal(value: unknown): CommandSearchActionGoal {
  const input = isRecord(value) ? value : null;
  if (input === null) throw new TypeError("command search action goal must be an object");
  exactKeys(input, ["kind", "action"], "command search action goal");
  if (input.kind !== "cli.command-search-action") {
    throw new TypeError("command search action goal.kind is invalid");
  }
  const action = isRecord(input.action) ? input.action : null;
  if (action === null) throw new TypeError("command search action goal.action must be an object");
  if (action.kind === "search") {
    exactKeys(action, ["kind", "slot", "operation"], "command search action goal.action");
    if (action.slot !== "s0" && action.slot !== "s1") {
      throw new TypeError("command search action goal.action.slot is invalid");
    }
    if (
      action.operation !== "directory.search.entries"
      && action.operation !== "directory.search.content"
    ) {
      throw new TypeError("command search action goal.action.operation is invalid");
    }
    return Object.freeze({
      kind: "cli.command-search-action",
      action: Object.freeze({
        kind: "search",
        slot: action.slot,
        operation: action.operation,
      }),
    });
  }
  if (action.kind === "read") {
    exactKeys(action, ["kind", "slot"], "command search action goal.action");
    if (action.slot !== "s0" && action.slot !== "s1") {
      throw new TypeError("command search action goal.action.slot is invalid");
    }
    return Object.freeze({
      kind: "cli.command-search-action",
      action: Object.freeze({ kind: "read", slot: action.slot }),
    });
  }
  throw new TypeError("command search action goal.action.kind must be search or read");
}

function readDomainGoal(value: unknown): CommandSearchDomainGoal {
  if (isRecord(value) && value.kind === "cli.command-search-action") {
    return readActionGoal(value);
  }
  return validateCommandSearchRequest({ requestId: "continuation-goal", goal: value }).goal;
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

function stateEvidenceRefs(
  state: CommandSearchState,
  evidence: readonly { id: string; stateRef: string; validity: string }[],
): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function slotsOf(state: CommandSearchState): readonly CommandSearchSlotFact[] {
  return Object.freeze([
    ...(state.slotReceipts.s0 === null ? [] : [state.slotReceipts.s0]),
    ...(state.s1Enabled && state.slotReceipts.s1 !== null ? [state.slotReceipts.s1] : []),
  ]);
}

function hasTerminalHit(state: CommandSearchState): boolean {
  return slotsOf(state).some(fact =>
    fact.matchedEntries.length > 0
    && (
      state.cardinality === "one"
      || (fact.normalCompleted && fact.coverage === "complete")
    ),
  );
}

function anyPartial(state: CommandSearchState): boolean {
  return slotsOf(state).some(fact => !fact.normalCompleted || fact.coverage !== "complete");
}

function allEnabledSlotsComplete(state: CommandSearchState): boolean {
  const enabled = state.s1Enabled ? 2 : 1;
  const facts = slotsOf(state);
  return facts.length === enabled
    && facts.every(fact => fact.normalCompleted && fact.coverage === "complete");
}

function rootResult(state: CommandSearchState, bindings: CommandSearchBindings): EvaluationReceipt {
  const evidenceRefs = Object.freeze([]) as readonly string[];
  const hit = hasTerminalHit(state);
  if (bindings.followUpRead !== null) {
    if (hit && state.readReceipt !== null) {
      return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
    }
    if (!hit && allEnabledSlotsComplete(state)) {
      return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "unsatisfied", 0, evidenceRefs);
    }
    return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "unknown", null, evidenceRefs);
  }
  if (hit) {
    return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (anyPartial(state)) {
    return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "unknown", null, evidenceRefs);
  }
  if (allEnabledSlotsComplete(state)) {
    return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "unsatisfied", 0, evidenceRefs);
  }
  return evaluation(COMMAND_SEARCH_ROOT_EVALUATOR, "unknown", null, evidenceRefs);
}

function atomicResult(
  goal: CommandSearchActionGoal,
  state: CommandSearchState,
): EvaluationReceipt {
  if (goal.action.kind === "search") {
    const fact = goal.action.slot === "s0" ? state.slotReceipts.s0 : state.slotReceipts.s1;
    return fact !== null && fact.operation === goal.action.operation
      ? evaluation(COMMAND_SEARCH_ATOMIC_EVALUATOR, "satisfied", 100, [])
      : evaluation(COMMAND_SEARCH_ATOMIC_EVALUATOR, "unknown", null, []);
  }
  return state.readReceipt !== null && state.readReceipt.slot === goal.action.slot
    ? evaluation(COMMAND_SEARCH_ATOMIC_EVALUATOR, "satisfied", 100, [])
    : evaluation(COMMAND_SEARCH_ATOMIC_EVALUATOR, "unknown", null, []);
}

function supports(input: SupportsInput<CommandSearchDomainGoal, CommandSearchBindings>): boolean {
  if (input.skill.id === COMMAND_SEARCH_ROOT_SKILL) {
    return input.goal.kind === "file.property"
      && input.goal.target.kind === "cli.command-search-scope";
  }
  if (input.skill.id === COMMAND_SEARCH_ATOMIC_SKILL) {
    return input.goal.kind === "cli.command-search-action";
  }
  return false;
}

function condition(
  id: string,
  goal: CommandSearchActionGoal,
  bindings: CommandSearchBindings,
) {
  return Object.freeze({
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId: COMMAND_SEARCH_ATOMIC_EVALUATOR,
    selectorId: COMMAND_SEARCH_ATOMIC_SELECTOR,
    mode: "atomic" as const,
    dependsOn: Object.freeze([]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...EFFECTS]),
  });
}

function stateId(requestId: string, sequence: number): string {
  return `${requestId}:state-${sequence}`;
}

function transitionId(requestId: string, sequence: number): string {
  return `${requestId}:transition-${sequence}`;
}

function evidenceId(requestId: string, sequence: number): string {
  return `${requestId}:evidence-${sequence}`;
}

function frozenSession(value: SessionSnapshot): SessionSnapshot {
  return Object.freeze({
    id: value.id,
    cwd: value.cwd,
    grantedEffects: Object.freeze([...value.grantedEffects]),
    revision: value.revision,
  });
}

function appendTrace(
  state: CommandSearchState,
  evaluationValue: CommandSearchRdeaEvaluation,
  commandReceipt: CommandSearchStepReceipt | null,
): CommandSearchState {
  const step = commandSearchStepFromEvaluation(
    state.stepTrace.length,
    evaluationValue,
    commandReceipt,
  );
  return Object.freeze({
    ...state,
    stepTrace: Object.freeze([...state.stepTrace, step]),
  });
}

function terminalDecision(step: CommandSearchRdeaEvaluation): boolean {
  return step.D.predictedLabel === "RETURN_RESULT"
    || step.D.predictedLabel === "REPORT_NO_MATCH";
}

function postCommandState(
  state: CommandSearchState,
  bindings: CommandSearchBindings,
  model: CliHybridSearchModel,
): CommandSearchState {
  const post = evaluateCommandSearchRdea(model, {
    goalKind: bindings.goalKind,
    cardinality: bindings.cardinality,
    s1Enabled: bindings.scopeRefs.length > 1,
    lastSearchedSlot: state.lastSearchedSlot,
    slotReceipts: state.slotReceipts,
    readReceipt: state.readReceipt,
    followUpRead: bindings.followUpRead,
  });
  return terminalDecision(post) || (bindings.followUpRead !== null && state.readReceipt !== null)
    ? appendTrace(state, post, null)
    : state;
}

function slotFactFromObservation(
  slot: CommandSearchSlot,
  directory: DirectoryRef,
  observation: DirectorySearchEntriesObservation | DirectorySearchContentObservation,
): CommandSearchSlotFact {
  const base = {
    slot,
    operation: observation.kind,
    directory,
    toolUsed: observation.toolUsed,
    exitCode: observation.exitCode,
    queryMatches: 1 as const,
    normalCompleted: observation.normalCompleted,
    coverage: observation.coverage,
    reasons: Object.freeze([...observation.reasons]),
    matchedEntries: Object.freeze([...observation.matchedEntries]),
    stdoutBytesRead: observation.stdoutBytesRead,
    stdoutChunkCount: observation.stdoutChunkCount,
    crossChunkRecordSplits: observation.crossChunkRecordSplits,
    unterminatedRemainderBytes: observation.unterminatedRemainderBytes,
    unterminatedFragmentDiscarded: observation.unterminatedFragmentDiscarded,
  };
  return observation.kind === "directory.search.content"
    ? Object.freeze({
        ...base,
        operation: "directory.search.content",
        matchedLines: Object.freeze([...observation.matchedLines]),
      })
    : Object.freeze({
        ...base,
        operation: "directory.search.entries",
        matchedLines: Object.freeze([]),
      });
}

function readFactFromObservation(
  slot: CommandSearchSlot,
  relPath: string,
  fileRef: ObservedObjectRef,
  observation: FileReadObservation | FileReadLinesObservation,
): CommandSearchReadFact {
  return Object.freeze({
    slot,
    relPath,
    fileRef,
    operation: observation.kind,
    bytesRead: observation.bytesRead,
    logicalLines: observation.kind === "file.read.lines" ? observation.logicalLines : null,
    requestedCount: observation.kind === "file.read.lines" ? observation.requestedCount : null,
    bytesBase64: observation.bytes,
    identity: Object.freeze({
      dev: observation.identity.dev,
      ino: observation.identity.ino,
    }),
  });
}

function executionErrors(
  receipt: SemanticCallReceipt,
  id: string,
): readonly AdapterDiagnostic[] {
  if (receipt.execution.status !== "failed") return Object.freeze([]);
  const code = receipt.execution.error.code;
  const bindingFailure =
    code === "binding_identity_missing"
    || code === "FINAL_SYMLINK"
    || code === "NOT_DIRECTORY"
    || code === "INVALID_REQUEST";
  return Object.freeze([
    Object.freeze({
      diagnosticId: `${id}:execution`,
      code:
        code === "EFFECT_DENIED"
          ? "effect_denied" as const
          : bindingFailure
            ? "invalid_binding" as const
            : "execution_failed" as const,
      stage: bindingFailure ? "binding" as const : "execution" as const,
      sourceCategory: "cli.command_search",
      message: receipt.execution.error.message,
      nativeCode: code,
      refs: Object.freeze([id]),
    }),
  ]);
}

function atomicOutcome(receipt: SemanticCallReceipt): "succeeded" | "failed" | "rejected" {
  if (receipt.execution.status === "succeeded") return "succeeded";
  return receipt.execution.error.code === "EFFECT_DENIED"
    || receipt.execution.error.code === "binding_identity_missing"
    || receipt.execution.error.code === "FINAL_SYMLINK"
    || receipt.execution.error.code === "NOT_DIRECTORY"
    ? "rejected"
    : "failed";
}

function searchActionForDLabel(
  goalKind: CommandSearchBindings["goalKind"],
  label: string,
): CommandSearchActionGoal["action"] | null {
  const literal = goalKind === "g3.literal-search";
  const operation = literal ? "directory.search.content" : "directory.search.entries";
  if ((literal ? "SEARCH_LITERAL_S0" : "SEARCH_TARGET_S0") === label) {
    return Object.freeze({ kind: "search", slot: "s0", operation });
  }
  if ((literal ? "SEARCH_LITERAL_S1" : "SEARCH_TARGET_S1") === label) {
    return Object.freeze({ kind: "search", slot: "s1", operation });
  }
  if (label === "READ_TARGET_S0") return Object.freeze({ kind: "read", slot: "s0" });
  if (label === "READ_TARGET_S1") return Object.freeze({ kind: "read", slot: "s1" });
  return null;
}

function actionReceiptOf(
  action: CommandSearchActionGoal["action"],
  readMode: "lines" | "bytes" = "bytes",
): CommandSearchStepReceipt {
  return action.kind === "search"
    ? Object.freeze({ slot: action.slot, operation: action.operation })
    : Object.freeze({
        slot: action.slot,
        operation: readMode === "lines" ? "file.read.lines" : "file.read",
      });
}

function progressFingerprint(state: CommandSearchState): string {
  return JSON.stringify({
    slots: state.slotReceipts,
    read: state.readReceipt,
    refs: state.issuedRefs,
    ledger: state.spawnLedger,
  });
}

function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.scenarioId === right.scenarioId && left.sessionId === right.sessionId;
}

export function createCommandSearchAdapter(input: CommandSearchAdapterInput): CommandSearchAdapterHandle {
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
  let pendingEvaluation: CommandSearchRdeaEvaluation | null = null;
  let pendingAction: CommandSearchActionGoal["action"] | null = null;
  const issuedRefs: ObservedObjectRef[] = [];
  const publicGuards: CommandSearchDomainGuards = createCommandSearchDomainGuards({
    session: input.session,
    modelRef: input.l2Model.ref,
  });
  const guards: RecursiveGoalContinuationGuards<
    CommandSearchDomainGoal,
    CommandSearchState,
    CommandSearchBindings,
    CommandSearchEvidencePayload,
    CommandSearchEffectFact,
    SemanticCallReceipt,
    { readonly phase: "execute" | "closed" }
  > = Object.freeze({
    ...publicGuards,
    goal: readDomainGoal,
    state: readCommandSearchState,
    bindings: (value: unknown) =>
      validateCommandSearchBindings(value, input.session, input.l2Model.ref),
    evidencePayload: readCommandSearchEvidencePayload,
    effectFact: readCommandSearchEffectFact,
    receiptPayload: (value: unknown) => {
      const receipt = value as SemanticCallReceipt;
      if (!isRecord(receipt) || !isRecord(receipt.call)) {
        throw new TypeError("command search receipt payload must be a semantic call receipt");
      }
      const operation = receipt.call.operation;
      if (operation !== "directory.search.entries" && operation !== "directory.search.content") {
        throw new TypeError("command search receipt payload must be a command search receipt");
      }
      return receipt;
    },
    cursor: (value: unknown) => {
      const cursor = isRecord(value) ? value : null;
      if (cursor === null) throw new TypeError("command search cursor must be an object");
      exactKeys(cursor, ["phase"], "command search cursor");
      if (cursor.phase !== "execute" && cursor.phase !== "closed") {
        throw new TypeError("command search cursor.phase is invalid");
      }
      return Object.freeze({ phase: cursor.phase });
    },
    sameEffectFact: (left: CommandSearchEffectFact, right: CommandSearchEffectFact) =>
      JSON.stringify(left) === JSON.stringify(right),
    sameGoal: (left: CommandSearchDomainGoal, right: CommandSearchDomainGoal) =>
      JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left: CommandSearchBindings, right: CommandSearchBindings) =>
      JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (
      left: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
      right: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
    ) => JSON.stringify(left) === JSON.stringify(right),
    sameCursor: (
      left: { readonly phase: "execute" | "closed" },
      right: { readonly phase: "execute" | "closed" },
    ) => JSON.stringify(left) === JSON.stringify(right),
  });

  function emptyEffectFact(id: string, runId: string | null, invoked: boolean): CommandSearchEffectFact {
    return Object.freeze({
      kind: COMMAND_SEARCH_EFFECT_KIND,
      transitionId: id,
      runId,
      invoked,
    });
  }

  function receiptResult(
    callback: { readonly context: { readonly requestId: string } },
    current: number,
    receipt: SemanticCallReceipt,
    nextState: CommandSearchState,
    evidence: readonly CommandSearchEvidencePayload[],
  ): AtomicReceipt<
    CommandSearchState,
    CommandSearchEvidencePayload,
    CommandSearchEffectFact,
    SemanticCallReceipt
  > {
    const id = transitionId(callback.context.requestId, current);
    return Object.freeze({
      runId: receipt.execution.runId,
      executorInvoked: receipt.execution.executorInvoked,
      outcome: atomicOutcome(receipt),
      sourceResult:
        receipt.call.operation === "directory.search.entries"
        || receipt.call.operation === "directory.search.content"
          ? Object.freeze({ tag: "cli.command-search.receipt.v1", value: receipt })
          : null,
      newState: Object.freeze({
        id: stateId(callback.context.requestId, current),
        value: Object.freeze({
          ...nextState,
          stateId: stateId(callback.context.requestId, current),
        }),
      }),
      evidence: Object.freeze(evidence.map((payload, index) => Object.freeze({
        id: evidenceId(callback.context.requestId, current + index),
        stateRef: stateId(callback.context.requestId, current),
        payload,
        validity: "valid" as const,
      }))),
      executionErrors: executionErrors(receipt, id),
      verificationErrors: Object.freeze([]),
      effect: Object.freeze({
        knowledge: "none",
        confirmedEffects: Object.freeze([]),
        receiptRef: null,
      }),
    });
  }

  const adapter: CommandSearchAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = validateCommandSearchRequest({
        requestId: request.requestId,
        goal: request.rootGoal,
      }).goal;
      const rootBindings = validateCommandSearchBindings(
        request.rootBindings,
        input.session,
        input.l2Model.ref,
      );
      if (!sameSession(rootBindings.session, input.session)) {
        throw new TypeError("command search bindings session does not match the adapter session");
      }
      for (const scopeRef of rootBindings.scopeRefs) {
        await input.sandbox.validateDirectoryRef(scopeRef);
      }
      const state = readCommandSearchState(request.state);
      if (
        state.goalKind !== rootBindings.goalKind
        || state.cardinality !== rootBindings.cardinality
        || state.s1Enabled !== (rootBindings.scopeRefs.length > 1)
      ) {
        throw new TypeError("command search state does not match root bindings");
      }
      if (
        request.rootEvaluatorId !== COMMAND_SEARCH_ROOT_EVALUATOR
        || request.rootSelectorId !== COMMAND_SEARCH_ROOT_SELECTOR
        || request.satisfactionThreshold !== 100
      ) {
        throw new TypeError("command search evaluator, selector or threshold is unsupported");
      }
      const continuation = request.continuation === undefined || request.continuation === null
        ? null
        : readRecursiveGoalContinuation(
            normalizeCommandSearchContinuation(request.continuation),
            guards,
          );
      if (continuation !== null) {
        sequence = Math.max(sequence, restoredCommandSearchSequence(continuation));
      }
      return Object.freeze({
        requestId: request.requestId,
        rootGoal,
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
      const goal = callback.goal;
      const state = callback.state as CommandSearchState;
      const evidenceRefs = stateEvidenceRefs(state, callback.evidence);
      if (goal.kind === "cli.command-search-action") {
        const receipt = atomicResult(goal, state);
        return evidenceRefs.length === 0
          ? receipt
          : Object.freeze({ ...receipt, evidenceRefs: Object.freeze(evidenceRefs) });
      }
      const root = rootResult(state, callback.bindings);
      return evidenceRefs.length === 0
        ? root
        : Object.freeze({ ...root, evidenceRefs: Object.freeze(evidenceRefs) });
    },

    async select(callback) {
      calls.select += 1;
      const first = callback.candidates[0];
      return first === undefined
        ? { kind: "no_capability" as const, searchedSkillIds: [] }
        : { kind: "selected" as const, skillId: first.id };
    },

    async derive(
      callback: DerivationInput<
        CommandSearchDomainGoal,
        CommandSearchState,
        CommandSearchBindings,
        CommandSearchEvidencePayload,
        { readonly phase: "execute" | "closed" }
      >,
    ) {
      calls.derive += 1;
      if (callback.goal.kind === "cli.command-search-action") {
        return Object.freeze({
          conditions: Object.freeze([]),
          nextCursor: Object.freeze({ phase: "closed" as const }),
          expansion: "closed" as const,
        });
      }
      const state = callback.state;
      const bindings = callback.bindings;
      const decision = evaluateCommandSearchRdea(input.l2Model, {
        goalKind: bindings.goalKind,
        cardinality: bindings.cardinality,
        s1Enabled: bindings.scopeRefs.length > 1,
        lastSearchedSlot: state.lastSearchedSlot,
        slotReceipts: state.slotReceipts,
        readReceipt: state.readReceipt,
        followUpRead: bindings.followUpRead,
      });
      if (anyPartial(state) && !hasTerminalHit(state)) {
        pendingEvaluation = null;
        pendingAction = null;
        return Object.freeze({
          conditions: Object.freeze([]),
          nextCursor: Object.freeze({ phase: "closed" as const }),
          expansion: "closed" as const,
        });
      }
      const action = searchActionForDLabel(bindings.goalKind, decision.D.predictedLabel);
      if (action === null) {
        pendingEvaluation = null;
        pendingAction = null;
        return Object.freeze({
          conditions: Object.freeze([]),
          nextCursor: Object.freeze({ phase: "closed" as const }),
          expansion: "closed" as const,
        });
      }
      if (action.kind === "search") {
        const existing = action.slot === "s0" ? state.slotReceipts.s0 : state.slotReceipts.s1;
        if (existing !== null) {
          pendingEvaluation = null;
          pendingAction = null;
          return Object.freeze({
            conditions: Object.freeze([]),
            nextCursor: Object.freeze({ phase: "closed" as const }),
            expansion: "closed" as const,
          });
        }
      } else {
        const slotFact = action.slot === "s0" ? state.slotReceipts.s0 : state.slotReceipts.s1;
        if (
          bindings.followUpRead === null
          || slotFact === null
          || slotFact.matchedEntries.length === 0
          || state.readReceipt !== null
        ) {
          pendingEvaluation = null;
          pendingAction = null;
          return Object.freeze({
            conditions: Object.freeze([]),
            nextCursor: Object.freeze({ phase: "closed" as const }),
            expansion: "closed" as const,
          });
        }
      }
      pendingEvaluation = decision;
      pendingAction = action;
      const ordinal = state.stepTrace.length + callback.conditions.length;
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            `command-search-action:${ordinal}:${action.kind}:${action.slot}`,
            Object.freeze({ kind: "cli.command-search-action", action }),
            bindings,
          ),
        ]),
        nextCursor: Object.freeze({ phase: "execute" as const }),
        expansion: "more" as const,
      });
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      sequence += 1;
      const current = sequence;
      if (
        callback.skill.id !== COMMAND_SEARCH_ATOMIC_SKILL
        || callback.goal.kind !== "cli.command-search-action"
      ) {
        throw new TypeError("command search executeAtomic received an unsupported atomic action");
      }
      const action = callback.goal.action;
      const bindings = callback.bindings;
      let decision: CommandSearchRdeaEvaluation;
      let decisionAction: CommandSearchActionGoal["action"];
      if (pendingEvaluation === null || pendingAction === null) {
        decision = evaluateCommandSearchRdea(input.l2Model, {
          goalKind: bindings.goalKind,
          cardinality: bindings.cardinality,
          s1Enabled: bindings.scopeRefs.length > 1,
          lastSearchedSlot: callback.state.lastSearchedSlot,
          slotReceipts: callback.state.slotReceipts,
          readReceipt: callback.state.readReceipt,
          followUpRead: bindings.followUpRead,
        });
        const reconstructed = searchActionForDLabel(bindings.goalKind, decision.D.predictedLabel);
        if (reconstructed === null) {
          throw new TypeError("command search executeAtomic has no model decision");
        }
        decisionAction = reconstructed;
      } else {
        decision = pendingEvaluation;
        decisionAction = pendingAction;
      }
      if (
        action.kind !== decisionAction.kind
        || action.slot !== decisionAction.slot
        || (
          action.kind === "search"
          && decisionAction.kind === "search"
          && action.operation !== decisionAction.operation
        )
      ) {
        throw new TypeError("command search executeAtomic goal does not match the model decision");
      }
      pendingEvaluation = decision;
      pendingAction = decisionAction;
      const slotIndex = action.slot === "s0" ? 0 : 1;
      const directory = bindings.scopeRefs[slotIndex];
      if (directory === undefined) {
        throw new TypeError("command search selected an unavailable fallback slot");
      }
      if (action.kind === "search") {
        const call = action.operation === "directory.search.content"
          ? {
              operation: "directory.search.content" as const,
              parameters: {
                session: input.session,
                directory,
                queryLiteral: bindings.queryLiteral!,
                fileFilter: bindings.fileFilter,
                ignorePolicy: bindings.ignorePolicy,
                ...(input.explicitLimits === undefined
                  ? {}
                  : { explicitLimits: input.explicitLimits }),
              },
            }
          : {
              operation: "directory.search.entries" as const,
              parameters: {
                session: input.session,
                directory,
                fileFilter: bindings.fileFilter,
                ignorePolicy: bindings.ignorePolicy,
                ...(input.explicitLimits === undefined
                  ? {}
                  : { explicitLimits: input.explicitLimits }),
              },
            };
        const receipt = await input.sandbox.execute(call);
        const commandReceipt = actionReceiptOf(action);
        let nextState = appendTrace(callback.state, decision, commandReceipt);
        const evidence: CommandSearchEvidencePayload[] = [];
        if (receipt.execution.status === "succeeded") {
          const observation = receipt.execution.observation;
          if (
            observation.kind === "directory.search.entries"
            || observation.kind === "directory.search.content"
          ) {
            const fact = slotFactFromObservation(action.slot, directory, observation);
            const slotReceipts = Object.freeze({
              s0: action.slot === "s0" ? fact : nextState.slotReceipts.s0,
              s1: action.slot === "s1" ? fact : nextState.slotReceipts.s1,
            });
            const ledger: CommandSpawnLedgerEntry[] = [
              ...nextState.spawnLedger,
              ...observation.spawnLedger,
            ];
            nextState = Object.freeze({
              ...nextState,
              session: frozenSession(receipt.session_after),
              slotReceipts,
              lastSearchedSlot: action.slot,
              spawnLedger: Object.freeze(ledger),
            });
            nextState = postCommandState(nextState, bindings, input.l2Model);
          }
          evidence.push(Object.freeze({
            kind: COMMAND_SEARCH_EVIDENCE_KIND,
            transitionId: transitionId(callback.context.requestId, current),
            stateId: stateId(callback.context.requestId, current),
            receipt,
          }));
        } else {
          evidence.push(Object.freeze({
            kind: COMMAND_SEARCH_EVIDENCE_KIND,
            transitionId: transitionId(callback.context.requestId, current),
            stateId: stateId(callback.context.requestId, current),
            receipt,
          }));
        }
        pendingEvaluation = null;
        pendingAction = null;
        return receiptResult(callback, current, receipt, nextState, evidence);
      }

      const slotFact = action.slot === "s0"
        ? callback.state.slotReceipts.s0
        : callback.state.slotReceipts.s1;
      const relPath = slotFact?.matchedEntries[0];
      if (slotFact === null || relPath === undefined || bindings.followUpRead === null) {
        throw new TypeError("command search read action has no matched entry or read contract");
      }
      const scopePath = directory.path;
      const targetRelPath = scopePath === "." || scopePath === ""
        ? relPath
        : `${scopePath.replace(/\/+$/, "")}/${relPath}`;
      let fileRef: ObservedObjectRef;
      try {
        fileRef = await input.sandbox.bindFile(input.session, targetRelPath);
      } catch (error) {
        const id = transitionId(callback.context.requestId, current);
        const code = isRecord(error) && typeof error.code === "string"
          ? error.code
          : "binding_identity_missing";
        const failure: AdapterDiagnostic = Object.freeze({
          diagnosticId: `${id}:binding`,
          code: code === "EFFECT_DENIED" ? "effect_denied" : "invalid_binding",
          stage: "binding",
          sourceCategory: "cli.command_search",
          message: error instanceof Error ? error.message : String(error),
          nativeCode: code,
          refs: Object.freeze([id]),
        });
        pendingEvaluation = null;
        pendingAction = null;
        return Object.freeze({
          runId: null,
          executorInvoked: false,
          outcome: "rejected",
          sourceResult: null,
          newState: Object.freeze({
            id: stateId(callback.context.requestId, current),
            value: Object.freeze({
              ...callback.state,
              stateId: stateId(callback.context.requestId, current),
            }),
          }),
          evidence: Object.freeze([]),
          executionErrors: Object.freeze([failure]),
          verificationErrors: Object.freeze([]),
          effect: Object.freeze({
            knowledge: "none",
            confirmedEffects: Object.freeze([]),
            receiptRef: null,
          }),
        });
      }
      issuedRefs.push(fileRef);
      const readCall = bindings.followUpRead.mode === "lines"
        ? {
            operation: "file.read.lines" as const,
            parameters: {
              ref: fileRef,
              anchor: bindings.followUpRead.anchor,
              count: bindings.followUpRead.count,
            },
          }
        : {
            operation: "file.read" as const,
            parameters: {
              ref: fileRef,
              offset: bindings.followUpRead.offset,
              length: bindings.followUpRead.length,
            },
          };
      const receipt = await input.sandbox.execute(readCall);
      let nextState = appendTrace(
        callback.state,
        decision,
        actionReceiptOf(action, bindings.followUpRead.mode),
      );
      const evidence: CommandSearchEvidencePayload[] = [];
      if (receipt.execution.status === "succeeded") {
        const observation = receipt.execution.observation;
        if (observation.kind === "file.read" || observation.kind === "file.read.lines") {
          nextState = Object.freeze({
            ...nextState,
            session: frozenSession(receipt.session_after),
            readReceipt: readFactFromObservation(action.slot, relPath, fileRef, observation),
            issuedRefs: Object.freeze([...nextState.issuedRefs, fileRef]),
          });
          nextState = postCommandState(nextState, bindings, input.l2Model);
          evidence.push(Object.freeze({
            kind: COMMAND_SEARCH_EVIDENCE_KIND,
            transitionId: transitionId(callback.context.requestId, current),
            stateId: stateId(callback.context.requestId, current),
            receipt,
          }));
        }
      } else {
        nextState = Object.freeze({
          ...nextState,
          session: frozenSession(receipt.session_after),
          issuedRefs: Object.freeze([...nextState.issuedRefs, fileRef]),
        });
      }
      pendingEvaluation = null;
      pendingAction = null;
      return receiptResult(callback, current, receipt, nextState, evidence);
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, guards);
    },

    measureProgress(callback) {
      calls.measureProgress += 1;
      const improved =
        progressFingerprint(callback.before as CommandSearchState)
        !== progressFingerprint(callback.after as CommandSearchState);
      return {
        improved,
        reason: improved ? "facts_improved" as const : "none" as const,
        comparable: true,
      };
    },
  };

  return Object.freeze({
    adapter,
    calls,
    issuedRefs: () => Object.freeze([...issuedRefs]),
  });
}

export function createCommandSearchDependencies(
  created: CommandSearchAdapterHandle,
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  CommandSearchDomainGoal,
  CommandSearchState,
  CommandSearchBindings,
  CommandSearchEvidencePayload,
  CommandSearchEffectFact,
  SemanticCallReceipt,
  { readonly phase: "execute" | "closed" }
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: COMMAND_SEARCH_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: COMMAND_SEARCH_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: COMMAND_SEARCH_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: COMMAND_SEARCH_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
