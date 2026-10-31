// Slice CD-1 deterministic composite workflow. All source observation flows
// through the injected sandbox; the AST policy stays pure. Each closure
// consistency re-read is its own finite atomic action so the existing
// recursive-goal controller records budget, continuation and evidence per file.
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
  CALL_DEPTH_ATOMIC_EVALUATOR,
  CALL_DEPTH_ATOMIC_SELECTOR,
  CALL_DEPTH_ATOMIC_SKILL,
  CALL_DEPTH_COMPOSITE_SKILL,
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
  withinScope,
  type CallDepthAction,
  type CallDepthActionGoal,
  type CallDepthBindings,
  type CallDepthCursor,
  type CallDepthDomainGoal,
  type CallDepthEffectFact,
  type CallDepthEvidencePayload,
  type CallDepthMaxDepth,
  type CallDepthState,
  type CallGraphNodeFact,
  type CallGraphResolvedEdgeFact,
  type CallDepthUnresolvedCallsite,
  type CliCalleeCallGraphGoal,
  type DeclSpan,
} from "./call-depth-contract.js";
import { readSemanticCliCall } from "./filesystem-sandbox.js";
import {
  extractCallsites,
  nodeIdFor,
  parseSourceFile,
  resolveCallsite,
  resolveEntry,
  spanKey,
  type DeclInfo,
  type ModuleStore,
  type SourceFileInfo,
} from "../../filters/cli-call-depth-policy.js";
import type {
  DirectoryRef,
  FileReadObservation,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import type { CliFilesystemSandbox } from "./filesystem-sandbox.js";
import type { ObservedObjectRef, OsInteger } from "./entry-inspection.js";

export const CALL_DEPTH_SKILLS = Object.freeze([
  Object.freeze({
    id: CALL_DEPTH_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.callee-call-graph",
    evaluatorId: CALL_DEPTH_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...CALL_DEPTH_EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: CALL_DEPTH_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "cli.call-depth.step",
    evaluatorId: CALL_DEPTH_ATOMIC_EVALUATOR,
    requiredEffects: Object.freeze([...CALL_DEPTH_EFFECTS]),
    allowedEffects: Object.freeze([...CALL_DEPTH_EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const CALL_DEPTH_EVALUATORS = Object.freeze([
  Object.freeze({
    id: CALL_DEPTH_ROOT_EVALUATOR,
    goalType: "cli.programming.callee_call_graph",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: CALL_DEPTH_ATOMIC_EVALUATOR,
    goalType: "cli.call-depth-action",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const CALL_DEPTH_SELECTORS = Object.freeze([
  Object.freeze({ id: CALL_DEPTH_ROOT_SELECTOR, skillIds: Object.freeze([CALL_DEPTH_COMPOSITE_SKILL]) }),
  Object.freeze({ id: CALL_DEPTH_ATOMIC_SELECTOR, skillIds: Object.freeze([CALL_DEPTH_ATOMIC_SKILL]) }),
]);

export type CallDepthAdapter = RecursiveGoalAdapter<
  CallDepthDomainGoal,
  CallDepthState,
  CallDepthBindings,
  CallDepthEvidencePayload,
  CallDepthEffectFact,
  SemanticCallReceipt,
  CallDepthCursor
>;

export type CallDepthAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
}>;

export type CallDepthAdapterHandle = Readonly<{
  adapter: CallDepthAdapter;
  setState(state: CallDepthState): void;
  getState(): CallDepthState | null;
  calls: Readonly<Record<
    | "validateRequest"
    | "supports"
    | "evaluate"
    | "select"
    | "derive"
    | "executeAtomic"
    | "validateAtomicReceipt"
    | "measureProgress",
    number
  >>;
}>;

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const CALL_DEPTH_COMPARATORS: RecursiveGoalComparators<
  CallDepthDomainGoal,
  CallDepthBindings,
  CallDepthState,
  CallDepthEvidencePayload
> = Object.freeze({
  sameGoal: jsonEqual,
  sameBindings: jsonEqual,
  sameFacts: (
    left: FactSnapshot<CallDepthState, CallDepthEvidencePayload>,
    right: FactSnapshot<CallDepthState, CallDepthEvidencePayload>,
  ) => jsonEqual(left, right),
});

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

export function buildInitialState(
  goal: CliCalleeCallGraphGoal,
  snapshot: SessionSnapshot,
  requestId: string,
): CallDepthState {
  const absolute = goal.entryFile.startsWith("/");
  const segments = goal.entryFile.split("/");
  const escapes = segments.includes("..");
  const granted = snapshot.grantedEffects.includes("filesystem.read");
  if (absolute || escapes || !withinScope(goal.entryFile, goal.scopePaths) || !granted) {
    return rejectedInitial(goal, snapshot, requestId);
  }
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
    missingFiles: Object.freeze([]),
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    unresolvedCallsites: Object.freeze([]),
    openCallsites: Object.freeze([]),
    pendingReads: Object.freeze([goal.entryFile]),
    relaxPending: true,
    sourceConsistencyFailed: false,
    truncated: false,
    termination: null,
    lastCompletedActionId: null,
    counters: zeroCounters(),
  });
}

type Analysis = Readonly<{
  nodes: readonly CallGraphNodeFact[];
  edges: readonly CallGraphResolvedEdgeFact[];
  unresolvedCallsites: readonly CallDepthUnresolvedCallsite[];
  pendingReads: readonly string[];
  entryResolved: boolean;
  entryResolution: "ok" | "entry_not_found" | "ambiguous_entry_symbol";
  entryNodeId: string | null;
  termination: CallDepthState["termination"];
  bodyExtractedCount: number;
  closedCallsiteCount: number;
}>;

type NodeRecord = Readonly<{ decl: DeclInfo; callerChain: string }>;

type EdgeDraft = Readonly<{
  callerId: string;
  calleeId: string;
  callsiteSpan: DeclSpan;
  evidenceSnippet: string;
}>;

type UnresolvedDraft = Readonly<{
  callerId: string;
  calleeExpr: string;
  callsiteSpan: DeclSpan;
  kind: CallDepthUnresolvedCallsite["kind"];
  reasonCode: string;
}>;

function kindOfResolution(resolution: { kind: string }): CallDepthUnresolvedCallsite["kind"] | null {
  if (resolution.kind === "dynamic") return "unresolved_dynamic";
  if (resolution.kind === "external") return "out_of_scope_external";
  if (resolution.kind === "unresolved") return "unresolved_missing_or_ambiguous_target";
  return null;
}

function reachable(from: string, to: string, adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

function analyze(
  state: CallDepthState,
  scopePaths: readonly string[],
  astCache: ReadonlyMap<string, SourceFileInfo>,
): Analysis {
  const pending = new Set<string>();
  const store: ModuleStore = Object.freeze({
    get: (relPath: string) => astCache.get(relPath),
    has: (relPath: string) => astCache.has(relPath),
    isMissing: (relPath: string) => state.missingFiles.includes(relPath),
    request: (relPath: string) => { pending.add(relPath); },
  });
  const pendingReads = () => Object.freeze([...pending].filter(relPath => !astCache.has(relPath)));

  const entryInfo = astCache.get(state.entryFile);
  if (entryInfo === undefined) {
    const missing = state.missingFiles.includes(state.entryFile);
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedCallsites: Object.freeze([]),
      pendingReads: missing ? Object.freeze([]) : Object.freeze([state.entryFile]),
      entryResolved: false,
      entryResolution: missing ? "entry_not_found" as const : "ok" as const,
      entryNodeId: null,
      termination: missing
        ? Object.freeze({ status: "unmet" as const, resolution: "entry_not_found" as const })
        : null,
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
    });
  }

  const entry = resolveEntry(entryInfo, state.entrySymbol, state.entryLexicalPath ?? undefined);
  if (entry.status === "not_found") {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedCallsites: Object.freeze([]),
      pendingReads: pendingReads(),
      entryResolved: false,
      entryResolution: "entry_not_found" as const,
      entryNodeId: null,
      termination: Object.freeze({ status: "unmet" as const, resolution: "entry_not_found" as const }),
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
    });
  }
  if (entry.status === "ambiguous") {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedCallsites: Object.freeze([]),
      pendingReads: pendingReads(),
      entryResolved: false,
      entryResolution: "ambiguous_entry_symbol" as const,
      entryNodeId: null,
      termination: Object.freeze({ status: "unmet" as const, resolution: "ambiguous_entry_symbol" as const }),
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
    });
  }

  const entryNodeId = nodeIdFor(entry.decl.file, entry.decl.chain, entry.decl.span);
  const nodesById = new Map<string, NodeRecord>();
  nodesById.set(entryNodeId, Object.freeze({ decl: entry.decl, callerChain: entry.decl.chain }));
  const edgeDrafts = new Map<string, EdgeDraft>();
  const unresolvedDrafts = new Map<string, UnresolvedDraft>();
  const extracted = new Set<string>();

  function depths(): Map<string, number> {
    const depth = new Map<string, number>();
    depth.set(entryNodeId, 0);
    const adjacency = new Map<string, string[]>();
    for (const draft of edgeDrafts.values()) {
      const list = adjacency.get(draft.callerId) ?? [];
      list.push(draft.calleeId);
      adjacency.set(draft.callerId, list);
    }
    const queue = [entryNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = depth.get(current) ?? 0;
      for (const next of adjacency.get(current) ?? []) {
        const candidate = currentDepth + 1;
        const existing = depth.get(next);
        if (existing === undefined || candidate < existing) {
          depth.set(next, candidate);
          queue.push(next);
        }
      }
    }
    return depth;
  }

  for (;;) {
    const currentDepths = depths();
    let extractedAny = false;
    for (const [nodeId, record] of nodesById) {
      const depth = currentDepths.get(nodeId);
      if (depth === undefined || depth >= state.maxDepth || extracted.has(nodeId)) continue;
      const info = astCache.get(record.decl.file);
      if (info === undefined || record.decl.body === undefined) {
        extracted.add(nodeId);
        continue;
      }
      extracted.add(nodeId);
      extractedAny = true;
      const callsites = extractCallsites(
        info,
        record.decl.body,
        record.decl.params ?? Object.freeze([]),
        record.decl.chain,
      );
      for (const callsite of callsites) {
        const resolution = resolveCallsite(store, scopePaths, record.decl.file, callsite);
        if (resolution.kind === "pending") continue;
        if (resolution.kind === "resolved") {
          const calleeId = nodeIdFor(resolution.originFile, resolution.decl.chain, resolution.decl.span);
          if (!nodesById.has(calleeId)) {
            nodesById.set(calleeId, Object.freeze({ decl: resolution.decl, callerChain: resolution.decl.chain }));
          }
          const key = `${nodeId}\u0000${calleeId}\u0000${spanKey(callsite.span)}`;
          if (!edgeDrafts.has(key)) {
            edgeDrafts.set(key, Object.freeze({
              callerId: nodeId,
              calleeId,
              callsiteSpan: callsite.span,
              evidenceSnippet: callsite.calleeExpr,
            }));
          }
          continue;
        }
        const kind = kindOfResolution(resolution);
        if (kind === null) continue;
        const unresolvedKey = `${nodeId}\u0000${spanKey(callsite.span)}\u0000${kind}\u0000${resolution.reason ?? ""}`;
        if (!unresolvedDrafts.has(unresolvedKey)) {
          unresolvedDrafts.set(unresolvedKey, Object.freeze({
            callerId: nodeId,
            calleeExpr: callsite.calleeExpr,
            callsiteSpan: callsite.span,
            kind,
            reasonCode: resolution.reason ?? "UNKNOWN",
          }));
        }
      }
    }
    const afterDepths = depths();
    const reopened = [...nodesById.keys()].some(nodeId => {
      const depth = afterDepths.get(nodeId);
      return depth !== undefined && depth < state.maxDepth && !extracted.has(nodeId);
    });
    if (!extractedAny && !reopened) break;
    if (!extractedAny && reopened) {
      // Depth relaxation reopened a node; loop extracts it next round.
      continue;
    }
  }

  const finalDepths = depths();
  const adjacency = new Map<string, string[]>();
  for (const draft of edgeDrafts.values()) {
    const list = adjacency.get(draft.callerId) ?? [];
    list.push(draft.calleeId);
    adjacency.set(draft.callerId, list);
  }
  const inDegree = new Map<string, number>();
  for (const draft of edgeDrafts.values()) {
    inDegree.set(draft.calleeId, (inDegree.get(draft.calleeId) ?? 0) + 1);
  }
  const edges = Object.freeze([...edgeDrafts.values()]
    .filter(draft => finalDepths.has(draft.callerId) && finalDepths.has(draft.calleeId))
    .map(draft => Object.freeze({
      callerId: draft.callerId,
      calleeId: draft.calleeId,
      edgeKind: "resolved_in_repo" as const,
      isCycleEdge: reachable(draft.calleeId, draft.callerId, adjacency),
      calleeInDegree: inDegree.get(draft.calleeId) ?? 0,
      callsiteSpan: draft.callsiteSpan,
      evidenceSnippet: draft.evidenceSnippet,
    })));
  const nodes = Object.freeze([...nodesById.entries()]
    .filter(([nodeId]) => finalDepths.has(nodeId))
    .map(([nodeId, record]) => Object.freeze({
      nodeId,
      filePath: record.decl.file,
      symbolName: record.decl.name,
      lexicalScopeChain: record.decl.chain,
      minDepth: finalDepths.get(nodeId) ?? 0,
      bodyExtracted: extracted.has(nodeId),
      declSpan: record.decl.span,
      fileObjectRef: fileRefOf(state, record.decl.file),
    }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)));
  const unresolvedCallsites = Object.freeze([...unresolvedDrafts.values()]
    .filter(draft => finalDepths.has(draft.callerId))
    .map(draft => Object.freeze({
      callerId: draft.callerId,
      calleeExpr: draft.calleeExpr,
      callsiteSpan: draft.callsiteSpan,
      kind: draft.kind,
      reasonCode: draft.reasonCode,
    })));

  return Object.freeze({
    nodes,
    edges,
    unresolvedCallsites,
    pendingReads: pendingReads(),
    entryResolved: true,
    entryResolution: "ok" as const,
    entryNodeId,
    termination: null,
    bodyExtractedCount: nodes.filter(node => node.bodyExtracted).length,
    closedCallsiteCount: edges.length + unresolvedCallsites.length,
  });
}

function fileRefOf(state: CallDepthState, relPath: string): ObservedObjectRef | null {
  return state.files.find(file => file.relPath === relPath)?.fileObjectRef ?? null;
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

function atomicFacts(goal: CallDepthActionGoal, state: CallDepthState): boolean {
  return state.lastCompletedActionId === goal.action.actionId;
}

function supports(input: SupportsInput<CallDepthDomainGoal, CallDepthBindings>): boolean {
  if (input.skill.id === CALL_DEPTH_COMPOSITE_SKILL) {
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
  if (state.pendingReads.length > 0) {
    return Object.freeze({
      actionId: `${requestId}:read:${state.files.length}:${state.pendingReads[0]}`,
      kind: "read_source_file" as const,
      relPath: state.pendingReads[0]!,
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

export function createCallDepthAdapter(input: CallDepthAdapterInput): CallDepthAdapterHandle {
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
  const astCache = new Map<string, SourceFileInfo>();
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

  function emptyEffect(id: string, runId: string | null, invoked: boolean): CallDepthEffectFact {
    return Object.freeze({ kind: CALL_DEPTH_EFFECT_KIND, transitionId: id, runId, invoked });
  }

  function makeReceipt(
    contextRequestId: string,
    sequenceForAction: number,
    action: CallDepthAction,
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
        // The continuation payload carries observed file facts but not the
        // parsed AST; repopulate the in-memory cache without new I/O.
        for (const file of current?.files ?? []) {
          astCache.set(file.relPath, parseSourceFile(file.relPath, file.sourceText));
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
        const result = atomicFacts(callback.goal, state)
          ? evaluation(CALL_DEPTH_ATOMIC_EVALUATOR, "satisfied", 100, evidenceRefs)
          : evaluation(CALL_DEPTH_ATOMIC_EVALUATOR, "unknown", null, evidenceRefs);
        return result;
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
              action,
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
            action,
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
            action,
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
            action,
            next,
            evidenceFor(requestId, actionSequence, action, "failed", code, null, null),
            rejected ? "rejected" : "failed",
            [diagnostic(transitionIdFor(requestId, actionSequence), "observation",
              rejected ? "effect_denied" : "execution_failed", message, code)],
          );
        }

        const observation: FileReadObservation = receipt.execution.observation;
        if (observation.end_observed !== true) {
          const next = withState(Object.freeze({
            ...before,
            stateId: stateIdFor(requestId, actionSequence),
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
            action,
            next,
            evidenceFor(requestId, actionSequence, action, "unknown", "SOURCE_TRUNCATED", observation.bytesRead, false),
            "succeeded",
            [],
          );
        }

        const sourceText = decode(observation.bytes);
        astCache.set(relPath, parseSourceFile(relPath, sourceText));
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
          action,
          next,
          evidenceFor(requestId, actionSequence, action, "succeeded", null, observation.bytesRead, true),
          "succeeded",
          [],
        );
      }

      if (action.kind === "relax_call_graph") {
        const result = analyze(before, callback.bindings.scopePaths, astCache);
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
          action,
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
          action,
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
        action,
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

export function createCallDepthDependencies(
  created: CallDepthAdapterHandle,
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  CallDepthDomainGoal,
  CallDepthState,
  CallDepthBindings,
  CallDepthEvidencePayload,
  CallDepthEffectFact,
  SemanticCallReceipt,
  CallDepthCursor
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: CALL_DEPTH_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: CALL_DEPTH_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: CALL_DEPTH_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: CALL_DEPTH_COMPARATORS,
    grantedEffects: new Set(CALL_DEPTH_EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
