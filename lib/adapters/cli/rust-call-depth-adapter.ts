// Deterministic Rust call-depth adapter for `nn-code calls --language rust`.
// This module reuses the Batch A recursive-goal contract and adapter shape.
// It only replaces the parser/module resolver and keeps the same 3N2E
// controller, evidence records and source-consistency checks.
import {
  readAtomicReceipt,
  readRecursiveGoalContinuation,
  type AdapterDiagnostic,
  type AtomicReceipt,
  type DerivationInput,
  type EvaluationInput,
  type FactSnapshot,
  type RecursiveGoalContinuationGuards,
  type RecursiveGoalRequestEnvelope,
  type SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import {
  CALL_DEPTH_ATOMIC_EVALUATOR,
  CALL_DEPTH_ATOMIC_SELECTOR,
  CALL_DEPTH_ATOMIC_SKILL,
  CALL_DEPTH_EFFECTS,
  CALL_DEPTH_EFFECT_KIND,
  CALL_DEPTH_EVIDENCE_KIND,
  CALL_DEPTH_MAX_SOURCE_FILE_BYTES,
  CALL_DEPTH_ROOT_EVALUATOR,
  CALL_DEPTH_ROOT_SELECTOR,
  readCallDepthBindings,
  readCallDepthCursor,
  readCallDepthDomainGoal,
  readCallDepthEffectFact,
  readCallDepthEvidencePayload,
  readCallDepthState,
  readCalleeCallGraphGoal,
  type CallDepthAction,
  type CallDepthBindings,
  type CallDepthCursor,
  type CallDepthDomainGoal,
  type CallDepthEffectFact,
  type CallDepthEvidencePayload,
  type CallDepthState,
  type CallGraphNodeFact,
  type CallGraphResolvedEdgeFact,
  type CallDepthUnresolvedCallsite,
  type CliCalleeCallGraphGoal,
} from "./call-depth-contract.js";
import { readSemanticCliCall } from "./filesystem-sandbox.js";
import type {
  CliFilesystemSandbox,
  FileReadObservation,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";
import {
  analyzeRustCalls,
  parseRustSourceFile,
  type RustFileInfo,
  type RustModuleStore,
} from "../../filters/rust-call-depth-policy.js";
import {
  buildInitialState,
  createCallDepthDependencies,
  type CallDepthAdapter,
  type CallDepthAdapterHandle,
} from "./call-depth-recursive.js";

export type RustCallDepthAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
}>;

export type RustCallDepthAdapterHandle = CallDepthAdapterHandle;

type RustAnalysisMapped = Omit<ReturnType<typeof analyzeRustCalls>, "nodes" | "unresolvedCallsites"> & {
  readonly nodes: readonly CallGraphNodeFact[];
  readonly unresolvedCallsites: readonly CallDepthUnresolvedCallsite[];
};

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function zeroCounters() {
  return Object.freeze({
    filesReadCount: 0,
    initialAstFileReadCalls: 0,
    closureVerifyFileReadCalls: 0,
    bodyExtractedCount: 0,
    closedCallsiteCount: 0,
    totalRelaxations: 0,
    closureVerifiedFilesCount: 0,
    sandboxApiCalls: 0,
  });
}

function frozenSession(value: SessionSnapshot): CallDepthState["session"] {
  return Object.freeze({
    id: value.id,
    cwd: value.cwd,
    revision: value.revision,
    grantedEffects: Object.freeze([...value.grantedEffects]),
  });
}

function rejectedInitial(goal: CliCalleeCallGraphGoal, snapshot: SessionSnapshot, requestId: string): CallDepthState {
  return Object.freeze({
    stateId: `${requestId}:state-0`,
    session: frozenSession(snapshot),
    entryFile: goal.entryFile,
    entrySymbol: goal.entrySymbol,
    entryLexicalPath: goal.entryLexicalPath ?? null,
    maxDepth: goal.maxDepth,
    entryResolved: false,
    entryResolution: "ok" as const,
    entryNodeId: null,
    files: Object.freeze([]),
    partialSources: Object.freeze([]),
    missingFiles: Object.freeze([]),
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    unresolvedCallsites: Object.freeze([]),
    openCallsites: Object.freeze([]),
    pendingReads: Object.freeze([]),
    relaxPending: false,
    sourceConsistencyFailed: false,
    truncated: false,
    termination: Object.freeze({ status: "rejected" as const, resolution: "rejected" as const }),
    lastCompletedActionId: null,
    counters: zeroCounters(),
  });
}

function stateIdFor(requestId: string, sequence: number): string {
  return `${requestId}:state-${sequence}`;
}

function transitionIdFor(requestId: string, sequence: number): string {
  return `${requestId}:transition-${sequence}`;
}

function evidenceIdFor(requestId: string, sequence: number): string {
  return `${requestId}:evidence-${sequence}`;
}

function nextAction(state: CallDepthState, requestId: string): CallDepthAction | null {
  if (state.termination !== null) return null;
  if (state.entryResolution !== "ok") return null;
  if (state.truncated || state.sourceConsistencyFailed) return null;
  const pending = state.pendingReads[0];
  if (pending !== undefined) {
    return Object.freeze({
      actionId: `${requestId}:read:${state.files.length}:${pending}`,
      kind: "read_source_file" as const,
      relPath: pending,
    });
  }
  if (state.relaxPending) {
    return Object.freeze({
      actionId: `${requestId}:relax:${state.counters.totalRelaxations}`,
      kind: "relax_call_graph" as const,
    });
  }
  const unverified = state.files.find(file => !file.verifiedUnchangedAtClosure);
  if (unverified !== undefined) {
    return Object.freeze({
      actionId: `${requestId}:verify:${state.counters.closureVerifiedFilesCount}:${unverified.relPath}`,
      kind: "verify_source_consistency" as const,
      relPath: unverified.relPath,
    });
  }
  return null;
}

function receiptPayload(value: unknown): SemanticCallReceipt {
  const receipt = value as SemanticCallReceipt;
  readSemanticCliCall(receipt.call);
  return receipt;
}

function diagnostic(
  id: string,
  stage: "execution" | "binding" | "observation",
  code: "effect_denied" | "execution_failed" | "invalid_binding" | "evidence_unavailable",
  message: string,
  nativeCode: string,
): AdapterDiagnostic {
  return Object.freeze({
    diagnosticId: id,
    code,
    stage,
    sourceCategory: "cli.call_depth",
    message,
    nativeCode,
    refs: Object.freeze([id]),
  });
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "UNKNOWN";
}

function decode(bytes: string): string {
  return Buffer.from(bytes, "base64").toString("utf8");
}

function fileRefOf(state: CallDepthState, relPath: string): ObservedObjectRef | null {
  return state.files.find(file => file.relPath === relPath)?.fileObjectRef ?? null;
}

function evaluation(
  evaluatorId: string,
  result: "satisfied" | "unsatisfied" | "unknown",
  satisfaction: number | null,
  evidenceRefs: readonly string[],
): {
  evaluatorId: string;
  result: "satisfied" | "unsatisfied" | "unknown";
  satisfaction: number | null;
  necessaryConditionsMet: boolean;
  evidenceRefs: readonly string[];
} {
  return Object.freeze({
    evaluatorId,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function stateEvidenceRefs(
  state: CallDepthState,
  evidence: readonly { id: string; stateRef: string; validity: string }[],
): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function rootFacts(state: CallDepthState): "satisfied" | "unsatisfied" | "unknown" {
  if (state.termination !== null) {
    return state.termination.status === "achieved" ? "satisfied" : "unsatisfied";
  }
  if (state.truncated || state.sourceConsistencyFailed) return "unknown";
  if (state.entryResolution !== "ok") return "unsatisfied";
  if (
    state.entryResolved
    && !state.relaxPending
    && state.pendingReads.length === 0
    && state.files.length > 0
    && state.files.every(file => file.verifiedUnchangedAtClosure)
  ) {
    return "satisfied";
  }
  return "unknown";
}

function atomicFacts(goal: CallDepthDomainGoal, state: CallDepthState): boolean {
  return goal.kind === "cli.call-depth-action"
    && state.lastCompletedActionId === goal.action.actionId;
}

function supports(input: SupportsInput<CallDepthDomainGoal, CallDepthBindings>): boolean {
  if (input.skill.id === "call-depth.composite") {
    return input.goal.kind === "cli.programming.callee_call_graph";
  }
  if (input.skill.id === CALL_DEPTH_ATOMIC_SKILL) {
    return input.goal.kind === "cli.call-depth-action";
  }
  return false;
}

function condition(
  id: string,
  action: CallDepthAction,
  bindings: CallDepthBindings,
) {
  return Object.freeze({
    id,
    goal: Object.freeze({ kind: "cli.call-depth-action" as const, action }),
    bindings,
    satisfactionThreshold: 100,
    evaluatorId: CALL_DEPTH_ATOMIC_EVALUATOR,
    selectorId: CALL_DEPTH_ATOMIC_SELECTOR,
    mode: "atomic" as const,
    dependsOn: Object.freeze([]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...CALL_DEPTH_EFFECTS]),
  });
}

export function createRustCallDepthAdapter(input: RustCallDepthAdapterInput): RustCallDepthAdapterHandle {
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
  let current: CallDepthState | null = null;
  const rustCache = new Map<string, RustFileInfo>();
  const guards: RecursiveGoalContinuationGuards<
    CallDepthDomainGoal,
    CallDepthState,
    CallDepthBindings,
    CallDepthEvidencePayload,
    CallDepthEffectFact,
    SemanticCallReceipt,
    CallDepthCursor
  > = Object.freeze({
    goal: readCallDepthDomainGoal,
    state: readCallDepthState,
    bindings: readCallDepthBindings,
    evidencePayload: readCallDepthEvidencePayload,
    effectFact: readCallDepthEffectFact,
    receiptPayload,
    cursor: readCallDepthCursor,
    sameEffectFact: jsonEqual,
    sameFacts: jsonEqual,
    sameGoal: jsonEqual,
    sameBindings: jsonEqual,
    sameCursor: jsonEqual,
  });

  function sameSession(left: SessionRef, right: SessionRef): boolean {
    return left.scenarioId === right.scenarioId && left.sessionId === right.sessionId;
  }

  function makeReceipt(
    contextRequestId: string,
    sequenceForAction: number,
    nextState: CallDepthState,
    evidence: CallDepthEvidencePayload,
    outcome: "succeeded" | "failed" | "rejected",
    errors: readonly AdapterDiagnostic[],
    sandboxReceipt: SemanticCallReceipt | null = null,
  ): AtomicReceipt<CallDepthState, CallDepthEvidencePayload, CallDepthEffectFact, SemanticCallReceipt> {
    const id = transitionIdFor(contextRequestId, sequenceForAction);
    return Object.freeze({
      runId: sandboxReceipt === null ? null : sandboxReceipt.execution.runId,
      executorInvoked: outcome === "succeeded",
      outcome,
      sourceResult: sandboxReceipt === null ? null : Object.freeze({
        tag: "cli.call-depth.receipt.v1" as const,
        value: sandboxReceipt,
      }),
      newState: Object.freeze({ id: nextState.stateId, value: nextState }),
      evidence: Object.freeze([Object.freeze({
        id: evidenceIdFor(contextRequestId, sequenceForAction),
        stateRef: nextState.stateId,
        payload: evidence,
        validity: "valid" as const,
      })]),
      executionErrors: Object.freeze([...errors]),
      verificationErrors: Object.freeze([]),
      effect: Object.freeze({
        knowledge: "none",
        confirmedEffects: Object.freeze([]),
        receiptRef: null,
      }),
    });
  }

  function evidenceFor(
    requestId: string,
    sequenceForAction: number,
    action: CallDepthAction,
    status: "succeeded" | "failed" | "unknown",
    code: string | null,
    bytesRead: number | null,
    endObserved: boolean | null,
  ): CallDepthEvidencePayload {
    return Object.freeze({
      kind: CALL_DEPTH_EVIDENCE_KIND,
      transitionId: transitionIdFor(requestId, sequenceForAction),
      stateId: stateIdFor(requestId, sequenceForAction),
      actionId: action.actionId,
      actionKind: action.kind,
      relPath: action.kind === "relax_call_graph" ? null : action.relPath,
      status,
      code,
      bytesRead,
      endObserved,
    });
  }

  function withState(next: CallDepthState): CallDepthState {
    current = next;
    return next;
  }

  function analyze(
    state: CallDepthState,
    scopePaths: readonly string[],
  ): RustAnalysisMapped {
    const pending = new Set<string>();
    const store: RustModuleStore = Object.freeze({
      get: (relPath: string) => rustCache.get(relPath),
      has: (relPath: string) => rustCache.has(relPath),
      isMissing: (relPath: string) => state.missingFiles.includes(relPath),
      request: (relPath: string) => { pending.add(relPath); },
    });
    const result = analyzeRustCalls(
      store,
      scopePaths,
      state.entryFile,
      state.entrySymbol,
      state.maxDepth,
    );
    const nodes = Object.freeze(result.nodes.map(node => Object.freeze({
      ...node,
      fileObjectRef: fileRefOf(state, node.filePath),
    })));
    const unresolvedCallsites = Object.freeze(result.unresolvedCallsites.map(item => Object.freeze({
      callerId: item.callerId,
      calleeExpr: item.calleeExpr,
      callsiteSpan: item.callsiteSpan,
      kind: item.kind as CallDepthUnresolvedCallsite["kind"],
      reasonCode: item.reasonCode,
      targetSymbolClue: item.targetSymbolClue,
      missingEvidence: item.missingEvidence,
      coverageStatus: item.coverageStatus,
      moduleSpecifierClue: item.moduleSpecifierClue,
      candidateModulePath: item.candidateModulePath,
      bindingDeclarationSpan: item.bindingDeclarationSpan,
    })));
    return Object.freeze({
      ...result,
      nodes,
      unresolvedCallsites,
    });
  }

  const adapter: CallDepthAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = readCalleeCallGraphGoal(request.rootGoal);
      const bindings = readCallDepthBindings(request.rootBindings);
      if (!sameSession(bindings.session, input.session)) {
        throw new TypeError("call-depth bindings session does not match the adapter session");
      }
      if (
        request.rootEvaluatorId !== CALL_DEPTH_ROOT_EVALUATOR
        || request.rootSelectorId !== CALL_DEPTH_ROOT_SELECTOR
        || request.satisfactionThreshold !== 100
      ) {
        throw new TypeError("call-depth evaluator, selector or threshold is unsupported");
      }
      const state = readCallDepthState(request.state);
      if (
        state.entryFile !== rootGoal.entryFile
        || state.entrySymbol !== rootGoal.entrySymbol
        || state.maxDepth !== rootGoal.maxDepth
      ) {
        throw new TypeError("call-depth state does not match the root goal");
      }
      const continuation = request.continuation === undefined || request.continuation === null
        ? null
        : readRecursiveGoalContinuation(request.continuation, guards);
      if (continuation !== null) {
        let maximum = 0;
        for (const record of continuation.states) {
          const match = /:state-(\d+)$/.exec(record.id);
          const value = match === null ? 0 : Number(match[1]);
          if (Number.isSafeInteger(value) && value > maximum) maximum = value;
        }
        sequence = maximum;
        const last = continuation.states.at(-1);
        if (last !== undefined) current = last.value;
        for (const file of current?.files ?? []) {
          rustCache.set(file.relPath, parseRustSourceFile(file.relPath, file.sourceText));
        }
      }
      current ??= state;
      return Object.freeze({
        requestId: request.requestId,
        rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: bindings,
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

    async evaluate(callback: EvaluationInput<CallDepthDomainGoal, CallDepthState, CallDepthBindings, CallDepthEvidencePayload>) {
      calls.evaluate += 1;
      const state = callback.state;
      const evidenceRefs = stateEvidenceRefs(state, callback.evidence);
      if (callback.goal.kind === "cli.call-depth-action") {
        return atomicFacts(callback.goal, state)
          ? evaluation(CALL_DEPTH_ATOMIC_EVALUATOR, "satisfied", 100, evidenceRefs)
          : evaluation(CALL_DEPTH_ATOMIC_EVALUATOR, "unknown", null, evidenceRefs);
      }
      const fact = rootFacts(state);
      return fact === "satisfied"
        ? evaluation(CALL_DEPTH_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs)
        : fact === "unsatisfied"
          ? evaluation(CALL_DEPTH_ROOT_EVALUATOR, "unsatisfied", 0, evidenceRefs)
          : evaluation(CALL_DEPTH_ROOT_EVALUATOR, "unknown", null, evidenceRefs);
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
        CallDepthDomainGoal,
        CallDepthState,
        CallDepthBindings,
        CallDepthEvidencePayload,
        CallDepthCursor
      >,
    ) {
      calls.derive += 1;
      if (callback.goal.kind === "cli.call-depth-action") {
        return Object.freeze({
          conditions: Object.freeze([]),
          nextCursor: Object.freeze({ phase: "closed" as const }),
          expansion: "closed" as const,
        });
      }
      const action = nextAction(callback.state, callback.context.requestId);
      if (action === null) {
        return Object.freeze({
          conditions: Object.freeze([]),
          nextCursor: Object.freeze({ phase: "closed" as const }),
          expansion: "closed" as const,
        });
      }
      return Object.freeze({
        conditions: Object.freeze([
          condition(`${callback.context.requestId}:condition:${action.actionId}`, action, callback.bindings),
        ]),
        nextCursor: Object.freeze({ phase: "execute" as const }),
        expansion: "more" as const,
      });
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      if (
        callback.skill.id !== CALL_DEPTH_ATOMIC_SKILL
        || callback.goal.kind !== "cli.call-depth-action"
      ) {
        throw new TypeError("call-depth executeAtomic received an unsupported atomic action");
      }
      const action = callback.goal.action;
      const before = callback.state;
      sequence += 1;
      const actionSequence = sequence;
      const requestId = callback.context.requestId;

      if (action.kind === "read_source_file") {
        const relPath = action.relPath;
        let ref: ObservedObjectRef;
        try {
          ref = await input.sandbox.bindFile(input.session, relPath);
        } catch (bindingError) {
          const code = errorCodeOf(bindingError);
          if (code === "ENOENT") {
            const next = withState(Object.freeze({
              ...before,
              stateId: stateIdFor(requestId, actionSequence),
              missingFiles: Object.freeze([...before.missingFiles, relPath]),
              pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
              relaxPending: true,
              lastCompletedActionId: action.actionId,
              counters: Object.freeze({
                ...before.counters,
                sandboxApiCalls: before.counters.sandboxApiCalls,
              }),
            }));
            return makeReceipt(
              requestId,
              actionSequence,
              next,
              evidenceFor(requestId, actionSequence, action, "failed", "ENOENT", null, null),
              "succeeded",
              [],
            );
          }
          const rejected = code === "EFFECT_DENIED" || code === "SANDBOX_ESCAPE";
          const next = withState(Object.freeze({
            ...before,
            stateId: stateIdFor(requestId, actionSequence),
            pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
            termination: Object.freeze({
              status: rejected ? "rejected" as const : "unknown" as const,
              resolution: rejected ? "rejected" as const : "insufficient_evidence" as const,
            }),
            lastCompletedActionId: action.actionId,
          }));
          const error = diagnostic(
            transitionIdFor(requestId, actionSequence),
            "binding",
            rejected ? "effect_denied" : "invalid_binding",
            bindingError instanceof Error ? bindingError.message : String(bindingError),
            code,
          );
          return makeReceipt(
            requestId,
            actionSequence,
            next,
            evidenceFor(requestId, actionSequence, action, "failed", code, null, null),
            rejected ? "rejected" : "failed",
            [error],
          );
        }

        let receipt: SemanticCallReceipt;
        try {
          receipt = await input.sandbox.execute({
            operation: "file.read",
            parameters: { ref, offset: 0, length: CALL_DEPTH_MAX_SOURCE_FILE_BYTES },
          });
        } catch (error) {
          const next = withState(Object.freeze({
            ...before,
            stateId: stateIdFor(requestId, actionSequence),
            pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
            termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" as const }),
            lastCompletedActionId: action.actionId,
            counters: Object.freeze({
              ...before.counters,
              sandboxApiCalls: before.counters.sandboxApiCalls + 1,
            }),
          }));
          return makeReceipt(
            requestId,
            actionSequence,
            next,
            evidenceFor(requestId, actionSequence, action, "unknown", errorCodeOf(error), null, null),
            "failed",
            [diagnostic(transitionIdFor(requestId, actionSequence), "observation", "execution_failed",
              error instanceof Error ? error.message : String(error), errorCodeOf(error))],
          );
        }

        const sandboxApiCalls = before.counters.sandboxApiCalls + 1;
        if (receipt.execution.status !== "succeeded" || receipt.execution.observation.kind !== "file.read") {
          const code = receipt.execution.status === "failed" ? receipt.execution.error.code : "UNKNOWN";
          const rejected = code === "EFFECT_DENIED" || code === "SANDBOX_ESCAPE";
          const next = withState(Object.freeze({
            ...before,
            stateId: stateIdFor(requestId, actionSequence),
            pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
            termination: Object.freeze({
              status: rejected ? "rejected" as const : "unknown" as const,
              resolution: rejected ? "rejected" as const : "insufficient_evidence" as const,
            }),
            lastCompletedActionId: action.actionId,
            counters: Object.freeze({ ...before.counters, sandboxApiCalls }),
          }));
          const message = receipt.execution.status === "failed" ? receipt.execution.error.message : "file.read returned no observation";
          return makeReceipt(
            requestId,
            actionSequence,
            next,
            evidenceFor(requestId, actionSequence, action, "failed", code, null, null),
            rejected ? "rejected" : "failed",
            [diagnostic(transitionIdFor(requestId, actionSequence), "observation",
              rejected ? "effect_denied" : "execution_failed", message, code)],
          );
        }

        const observation: FileReadObservation = receipt.execution.observation;
        if (observation.end_observed !== true) {
          const partialSource = Object.freeze({
            relPath,
            dev: observation.identity.dev,
            ino: observation.identity.ino,
            size: observation.size,
            bytesRead: observation.bytesRead,
            complete: false as const,
            truncated: true as const,
          });
          const next = withState(Object.freeze({
            ...before,
            stateId: stateIdFor(requestId, actionSequence),
            partialSources: Object.freeze([
              ...before.partialSources.filter(item => item.relPath !== relPath),
              partialSource,
            ]),
            pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
            truncated: true,
            termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" as const }),
            lastCompletedActionId: action.actionId,
            counters: Object.freeze({
              ...before.counters,
              filesReadCount: before.counters.filesReadCount + 1,
              initialAstFileReadCalls: before.counters.initialAstFileReadCalls + 1,
              sandboxApiCalls,
            }),
          }));
          return makeReceipt(
            requestId,
            actionSequence,
            next,
            evidenceFor(requestId, actionSequence, action, "unknown", "SOURCE_TRUNCATED", observation.bytesRead, false),
            "succeeded",
            [],
          );
        }

        const sourceText = decode(observation.bytes);
        rustCache.set(relPath, parseRustSourceFile(relPath, sourceText));
        const fileFact = Object.freeze({
          relPath,
          fileObjectRef: ref,
          dev: observation.identity.dev,
          ino: observation.identity.ino,
          size: observation.size,
          initialBytesBase64: observation.bytes,
          sourceText,
          verifiedUnchangedAtClosure: false,
        });
        const files = Object.freeze([
          ...before.files.filter(file => file.relPath !== relPath),
          fileFact,
        ]);
        const next = withState(Object.freeze({
          ...before,
          stateId: stateIdFor(requestId, actionSequence),
          files,
          pendingReads: Object.freeze(before.pendingReads.filter(item => item !== relPath)),
          relaxPending: true,
          lastCompletedActionId: action.actionId,
          counters: Object.freeze({
            ...before.counters,
            filesReadCount: before.counters.filesReadCount + 1,
            initialAstFileReadCalls: before.counters.initialAstFileReadCalls + 1,
            sandboxApiCalls,
          }),
        }));
        return makeReceipt(
          requestId,
          actionSequence,
          next,
          evidenceFor(requestId, actionSequence, action, "succeeded", null, observation.bytesRead, true),
          "succeeded",
          [],
        );
      }

      if (action.kind === "relax_call_graph") {
        const result = analyze(before, callback.bindings.scopePaths);
        const feedback = result.entryResolution !== "ok";
        const next = withState(Object.freeze({
          ...before,
          stateId: stateIdFor(requestId, actionSequence),
          entryResolved: result.entryResolved,
          entryResolution: result.entryResolution,
          entryNodeId: result.entryNodeId,
          nodes: result.nodes,
          edges: result.edges,
          unresolvedCallsites: result.unresolvedCallsites,
          openCallsites: Object.freeze([]),
          pendingReads: result.pendingReads,
          relaxPending: false,
          termination: result.termination,
          lastCompletedActionId: action.actionId,
          counters: Object.freeze({
            ...before.counters,
            bodyExtractedCount: result.bodyExtractedCount,
            closedCallsiteCount: result.closedCallsiteCount,
            totalRelaxations: before.counters.totalRelaxations + 1,
          }),
        }));
        return makeReceipt(
          requestId,
          actionSequence,
          next,
          evidenceFor(requestId, actionSequence, action, feedback ? "unknown" : "succeeded", null, null, null),
          "succeeded",
          [],
        );
      }

      const file = before.files.find(item => item.relPath === action.relPath);
      if (file === undefined) {
        throw new TypeError("call-depth consistency check has no observed file");
      }
      const receipt = await input.sandbox.execute({
        operation: "file.read",
        parameters: { ref: file.fileObjectRef, offset: 0, length: CALL_DEPTH_MAX_SOURCE_FILE_BYTES },
      });
      const sandboxApiCalls = before.counters.sandboxApiCalls + 1;
      const closureVerifyFileReadCalls = before.counters.closureVerifyFileReadCalls + 1;
      const unchanged = receipt.execution.status === "succeeded"
        && receipt.execution.observation.kind === "file.read"
        && receipt.execution.observation.end_observed === true
        && receipt.execution.observation.size === file.size
        && receipt.execution.observation.identity.dev === file.dev
        && receipt.execution.observation.identity.ino === file.ino
        && receipt.execution.observation.bytes === file.initialBytesBase64;
      if (!unchanged) {
        const code = receipt.execution.status === "failed"
          ? receipt.execution.error.code
          : "SOURCE_CHANGED";
        const next = withState(Object.freeze({
          ...before,
          stateId: stateIdFor(requestId, actionSequence),
          sourceConsistencyFailed: true,
          termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" as const }),
          lastCompletedActionId: action.actionId,
          counters: Object.freeze({
            ...before.counters,
            closureVerifyFileReadCalls,
            sandboxApiCalls,
          }),
        }));
        return makeReceipt(
          requestId,
          actionSequence,
          next,
          evidenceFor(requestId, actionSequence, action, "failed", code, null, null),
          "succeeded",
          [],
        );
      }
      const files = Object.freeze(before.files.map(item => item.relPath === action.relPath
        ? Object.freeze({ ...item, verifiedUnchangedAtClosure: true })
        : item));
      const next = withState(Object.freeze({
        ...before,
        stateId: stateIdFor(requestId, actionSequence),
        files,
        lastCompletedActionId: action.actionId,
        counters: Object.freeze({
          ...before.counters,
          closureVerifyFileReadCalls,
          closureVerifiedFilesCount: files.filter(item => item.verifiedUnchangedAtClosure).length,
          sandboxApiCalls,
        }),
      }));
      return makeReceipt(
        requestId,
        actionSequence,
        next,
        evidenceFor(requestId, actionSequence, action, "succeeded", null,
          receipt.execution.status === "succeeded" ? receipt.execution.observation.bytesRead : null, true),
        "succeeded",
        [],
      );
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, guards);
    },

    measureProgress(callback) {
      calls.measureProgress += 1;
      const before = callback.before;
      const after = callback.after;
      const fingerprint = (state: CallDepthState) => JSON.stringify({
        files: state.files.map(file => file.relPath),
        missing: state.missingFiles,
        pendingReads: state.pendingReads,
        relaxPending: state.relaxPending,
        nodes: state.nodes.map(node => `${node.nodeId}:${node.minDepth}`),
        edges: state.edges.length,
        unresolved: state.unresolvedCallsites.length,
        verified: state.counters.closureVerifiedFilesCount,
        relaxations: state.counters.totalRelaxations,
        termination: state.termination,
      });
      const improved = fingerprint(before) !== fingerprint(after);
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
    setState(state: CallDepthState) {
      const match = /:state-(\d+)$/.exec(state.stateId);
      if (match !== null) {
        const value = Number(match[1]);
        if (Number.isSafeInteger(value) && value > sequence) sequence = value;
      }
      current = state;
    },
    getState() {
      return current;
    },
  });
}

export function createRustCallDepthDependencies(
  created: RustCallDepthAdapterHandle,
  signal?: AbortSignal,
) {
  return createCallDepthDependencies(created, signal);
}
