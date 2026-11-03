// `nn-code value-flow` recursive-goal adapter. It drives the deterministic
// value-flow state machine over the existing 3N2E `runRecursiveGoal` controller
// and the shared read-only CLI filesystem sandbox. All filesystem work flows
// through `sandbox.execute`; the AST analysis itself is pure policy.
import type {
  AdapterDiagnostic,
  AtomicReceipt,
  DerivationInput,
  EnabledEvaluator,
  EnabledSkill,
  EvaluationInput,
  EvaluationReceipt,
  FactSnapshot,
  IntermediateCondition,
  RecursiveGoalAdapter,
  RecursiveGoalContinuationGuards,
  RecursiveGoalDependencies,
  RecursiveGoalRequestEnvelope,
  SelectorBinding,
  SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import { readAtomicReceipt } from "../../workflow/recursive-goal/contracts.js";
import {
  VALUE_FLOW_ATOMIC_EVALUATOR,
  VALUE_FLOW_ATOMIC_SELECTOR,
  VALUE_FLOW_ATOMIC_SKILL,
  VALUE_FLOW_COMPOSITE_SKILL,
  VALUE_FLOW_EFFECTS,
  VALUE_FLOW_EFFECT_KIND,
  VALUE_FLOW_EVIDENCE_KIND,
  VALUE_FLOW_ROOT_EVALUATOR,
  VALUE_FLOW_ROOT_SELECTOR,
  isActionGoal,
  readCliValueFlowGoal,
  readValueFlowBindings,
  readValueFlowCursor,
  readValueFlowDomainGoal,
  readValueFlowEffectFact,
  readValueFlowEvidencePayload,
  readValueFlowState,
  type CliValueFlowDirection,
  type CliValueFlowGoal,
  type CliValueFlowMaxDepth,
  type CliValueFlowResultMode,
  type ValueFlowAction,
  type ValueFlowActionGoal,
  type ValueFlowBindings,
  type ValueFlowCounters,
  type ValueFlowCursor,
  type ValueFlowDomainGoal,
  type ValueFlowEffectFact,
  type ValueFlowEvidencePayload,
  type ValueFlowSearchFailure,
  type ValueFlowState,
  type ValueFlowTermination,
} from "./value-flow-contract.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  FileReadObservation,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import {
  analyzeValueFlow,
  buildFileScopeHeaderIndex,
  sortSearchCandidatesByVfBaseline,
  vfBaselinePriorityTier,
  type FileScopeHeaderIndex,
  type SearchMatch,
  type ValueFlowAnalysisOutput,
  type ValueFlowCorpusFile,
} from "../../filters/cli-value-flow-policy.js";
import type { ObservedObjectRef } from "./entry-inspection.js";

const EFFECTS = VALUE_FLOW_EFFECTS;
const BASELINE_SCORER = "deterministic_baseline:VF-Baseline-0" as const;
const BASELINE_MODEL_REF = null;

export const VALUE_FLOW_SKILLS = Object.freeze([
  Object.freeze({
    id: VALUE_FLOW_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "programming.value_flow",
    evaluatorId: VALUE_FLOW_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: VALUE_FLOW_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "programming.value_flow.step",
    evaluatorId: VALUE_FLOW_ATOMIC_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const VALUE_FLOW_EVALUATORS = Object.freeze([
  Object.freeze({
    id: VALUE_FLOW_ROOT_EVALUATOR,
    goalType: "cli.programming.value_flow",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: VALUE_FLOW_ATOMIC_EVALUATOR,
    goalType: "cli.value-flow-action",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const VALUE_FLOW_SELECTORS = Object.freeze([
  Object.freeze({ id: VALUE_FLOW_ROOT_SELECTOR, skillIds: Object.freeze([VALUE_FLOW_COMPOSITE_SKILL]) }),
  Object.freeze({ id: VALUE_FLOW_ATOMIC_SELECTOR, skillIds: Object.freeze([VALUE_FLOW_ATOMIC_SKILL]) }),
]);

export type ValueFlowAdapter = RecursiveGoalAdapter<
  ValueFlowDomainGoal,
  ValueFlowState,
  ValueFlowBindings,
  ValueFlowEvidencePayload,
  ValueFlowEffectFact,
  SemanticCallReceipt,
  ValueFlowCursor
>;

export type ValueFlowAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  emit?: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
}>;

export type ValueFlowAdapterHandle = Readonly<{
  adapter: ValueFlowAdapter;
  issuedRefs: () => readonly ObservedObjectRef[];
  getState: () => ValueFlowState | null;
  disposeWorkingSet: () => void;
}>;

type ValueFlowWorkingSet = {
  readonly sourceByPath: Map<string, Readonly<{
    sourceText: string;
    fileObjectRef: ObservedObjectRef;
    size: number;
  }>>;
  readonly fileHeaderByPath: Map<string, FileScopeHeaderIndex>;
  readonly searchedScopes: Set<string>;
  rebuildingSources: boolean;
};

export const VALUE_FLOW_COMPARATORS = Object.freeze({
  sameGoal: (left: ValueFlowDomainGoal, right: ValueFlowDomainGoal) =>
    JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: ValueFlowBindings, right: ValueFlowBindings) =>
    JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<ValueFlowState, ValueFlowEvidencePayload>,
    right: FactSnapshot<ValueFlowState, ValueFlowEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

export function buildInitialState(
  goal: CliValueFlowGoal,
  snapshot: SessionSnapshot,
  requestId: string,
): ValueFlowState {
  return Object.freeze({
    stateId: `${requestId}:state:initial`,
    session: Object.freeze({
      id: snapshot.id,
      cwd: snapshot.cwd,
      revision: snapshot.revision,
      grantedEffects: Object.freeze([...snapshot.grantedEffects]),
    }),
    anchorFile: goal.anchorFile,
    anchorSymbol: goal.anchorSymbol,
    anchorLexicalPath: goal.anchorLexicalPath ?? null,
    anchorLine: goal.anchorLine ?? null,
    anchorColumn: goal.anchorColumn ?? null,
    direction: goal.direction,
    maxDepth: goal.maxDepth,
    resultMode: goal.resultMode ?? "all",
    scopePaths: Object.freeze([...goal.scopePaths]),
    maxCandidateFileReads: goal.maxCandidateFileReads ?? null,
    files: Object.freeze([]),
    searchMatches: Object.freeze([]),
    searchFailures: Object.freeze([]),
    pendingSearches: Object.freeze([...goal.scopePaths]),
    pendingReads: Object.freeze([goal.anchorFile]),
    anchorSiteId: null,
    sites: Object.freeze([]),
    edges: Object.freeze([]),
    unresolvedSites: Object.freeze([]),
    termination: null,
    lastCompletedActionId: null,
    stageDiagnostics: null,
    counters: Object.freeze({
      sandboxApiCalls: 0,
      searchCalls: 0,
      fileReadCalls: 0,
      candidateFilesRead: 0,
      searchMatchesSeen: 0,
      totalRelaxations: 0,
    }),
  });
}

function evaluation(result: "satisfied" | "unsatisfied" | "unknown", satisfaction: number | null, evidenceRefs: readonly string[] = []): EvaluationReceipt {
  return Object.freeze({
    evaluatorId: VALUE_FLOW_ROOT_EVALUATOR,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function stateEvidenceRefs(
  state: ValueFlowState,
  evidence: readonly { id: string; stateRef: string; validity: string }[],
): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function atomicEvaluation(
  goal: ValueFlowActionGoal,
  state: ValueFlowState,
  evidenceRefs: readonly string[],
): EvaluationReceipt {
  const done = state.lastCompletedActionId === goal.action.actionId;
  return Object.freeze({
    evaluatorId: VALUE_FLOW_ATOMIC_EVALUATOR,
    result: done ? "satisfied" : "unknown",
    satisfaction: done ? 100 : null,
    necessaryConditionsMet: done,
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function supports(input: SupportsInput<ValueFlowDomainGoal, ValueFlowBindings>): boolean {
  if (input.skill.id === VALUE_FLOW_COMPOSITE_SKILL) return input.goal.kind === "cli.programming.value_flow";
  if (input.skill.id === VALUE_FLOW_ATOMIC_SKILL) return input.goal.kind === "cli.value-flow-action";
  return false;
}

function condition(
  id: string,
  action: ValueFlowAction,
  bindings: ValueFlowBindings,
): IntermediateCondition<ValueFlowDomainGoal, ValueFlowBindings> {
  return Object.freeze({
    id,
    goal: Object.freeze({ kind: "cli.value-flow-action" as const, action }),
    bindings,
    satisfactionThreshold: 100,
    evaluatorId: VALUE_FLOW_ATOMIC_EVALUATOR,
    selectorId: VALUE_FLOW_ATOMIC_SELECTOR,
    mode: "atomic" as const,
    dependsOn: Object.freeze([]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...EFFECTS]),
  });
}

function stateId(requestId: string, sequence: number): string {
  return `${requestId}:state:${sequence}`;
}

function transitionId(requestId: string, sequence: number): string {
  return `${requestId}:transition:${sequence}`;
}

function evidenceId(requestId: string, sequence: number): string {
  return `${requestId}:evidence:${sequence}`;
}

function frozenSession(value: SessionSnapshot): ValueFlowState["session"] {
  return Object.freeze({
    id: value.id,
    cwd: value.cwd,
    revision: value.revision,
    grantedEffects: Object.freeze([...value.grantedEffects]),
  });
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

// The atomic `sourceResult` receipt must never retain a full source-text copy.
// `FileReadObservation.bytes` is a base64 mirror of the whole read range; the
// request-level WorkingSet is the single owner of source text. The stripped
// receipt keeps the observation shape (offsets, sizes, identity) and drops the
// byte payload.
function stripReceiptBytes(semantic: SemanticCallReceipt): SemanticCallReceipt {
  const execution = semantic.execution;
  if (execution.status !== "succeeded") return semantic;
  const observation = execution.observation;
  if (observation.kind !== "file.read" && observation.kind !== "file.read.lines") return semantic;
  return Object.freeze({
    ...semantic,
    execution: Object.freeze({
      ...execution,
      observation: Object.freeze({ ...observation, bytes: "" }),
    }),
  }) as unknown as SemanticCallReceipt;
}

function firstLineSpan(sourceText: string): Readonly<{ startLine: number; startColumn: number; endLine: number; endColumn: number }> {
  const line = sourceText.split("\n")[0] ?? "";
  return Object.freeze({ startLine: 1, startColumn: 1, endLine: 1, endColumn: Math.max(1, line.length + 1) });
}

function uniqueSearchPaths(state: ValueFlowState): readonly string[] {
  return Object.freeze([...new Set(state.searchMatches.map(match => match.relPath))]);
}

function baselineScore(priorityTier: 1 | 2 | 3 | 4): number {
  return (5 - priorityTier) / 4;
}

function makeSearchFailure(
  state: ValueFlowState,
  scopePath: string,
  operation: ValueFlowSearchFailure["operation"],
  stage: string,
  code: string,
  message: string,
  runId: string | null,
  executorInvoked: boolean,
): ValueFlowSearchFailure {
  return Object.freeze({
    scopePath,
    operation,
    stage,
    code,
    message,
    runId,
    executorInvoked,
    unfinishedScopePaths: Object.freeze(
      state.pendingSearches.includes(scopePath)
        ? state.pendingSearches
        : state.pendingSearches.slice(1),
    ),
    unfinishedCandidates: Object.freeze(
      scopePath === state.pendingSearches[0]
        ? [...new Set(state.searchMatches.map(match => match.relPath).filter(relPath =>
            relPath === scopePath || relPath.startsWith(`${scopePath}/`)))]
        : [],
    ),
  });
}

function columnOf(line: string, symbol: string): number {
  const index = line.indexOf(symbol);
  return index < 0 ? 1 : index + 1;
}

function notRead(state: ValueFlowState): (relPath: string) => boolean {
  const read = new Set(state.files.map(file => file.relPath));
  return (relPath: string) => !read.has(relPath);
}

function applyAnalysis(
  state: ValueFlowState,
  analysis: ValueFlowAnalysisOutput,
  options: { readonly searched: boolean; readonly budgetExhausted: boolean; readonly session: SessionSnapshot },
): ValueFlowState {
  const remaining = analysis.nextCandidates.filter(notRead(state)).filter(candidate => candidate !== state.anchorFile || state.files.length === 0);
  const budget = state.maxCandidateFileReads;
  const slots = budget === null ? remaining.length : Math.max(0, budget - state.counters.candidateFilesRead);
  const queued = budget === null ? remaining : remaining.slice(0, slots);
  const exhausted = options.budgetExhausted || (budget !== null && remaining.length > slots);
  const pendingReads = Object.freeze(queued.filter(relPath => !state.files.some(file => file.relPath === relPath)));
  const pendingSearches = options.searched ? Object.freeze([]) : state.pendingSearches;
  const done = pendingReads.length === 0 && pendingSearches.length === 0;
  const searchIncomplete = state.searchFailures.length > 0;
  const termination: ValueFlowTermination | null = done
    ? Object.freeze({
        status: exhausted || searchIncomplete ? "unknown" : analysis.status,
        resolution: exhausted
          ? "budget_exhausted"
          : searchIncomplete
            ? "insufficient_evidence"
            : analysis.resolution,
      })
    : null;
  const refByPath = new Map(state.files.map(file => [file.relPath, file.fileObjectRef] as const));
  const sites = Object.freeze(analysis.sites.map(site => Object.freeze({
    ...site,
    fileObjectRef: refByPath.get(site.filePath) ?? null,
  })));
  return Object.freeze({
    ...state,
    session: frozenSession(options.session),
    anchorSiteId: analysis.anchorSiteId,
    sites,
    edges: analysis.edges,
    unresolvedSites: analysis.unresolvedSites,
    pendingReads,
    pendingSearches,
    termination,
    stageDiagnostics: analysis.stageDiagnostics,
    counters: Object.freeze({
      ...state.counters,
      totalRelaxations: state.counters.totalRelaxations + analysis.totalRelaxations,
    }),
  });
}

export function createValueFlowAdapter(input: ValueFlowAdapterInput): ValueFlowAdapterHandle {
  const issuedRefs: ObservedObjectRef[] = [];
  const knownFiles: string[] = [];
  const observedSites = new Set<string>();
  const observedEdges = new Set<string>();
  const observedUnknowns = new Set<string>();
  let sequence = 0;
  let latest: ValueFlowState | null = null;
  const workingSet: ValueFlowWorkingSet = {
    sourceByPath: new Map(),
    fileHeaderByPath: new Map(),
    searchedScopes: new Set(),
    rebuildingSources: false,
  };

  function emit(kind: string, payload: Readonly<Record<string, unknown>>): void {
    input.emit?.(kind, payload);
  }

  // Incremental, bounded observation events. These carry identifiers and
  // lexical metadata only: never source text, raw bytes, or file contents.
  function emitAnalysis(analysis: ReturnType<typeof analyzeValueFlow>): void {
    for (const site of analysis.sites) {
      if (observedSites.has(site.siteId)) continue;
      observedSites.add(site.siteId);
      emit("node_expanded", Object.freeze({
        siteId: site.siteId,
        filePath: site.filePath,
        symbolName: site.symbolName,
        pointRole: site.pointRole,
      }));
    }
    for (const edge of analysis.edges) {
      const key = `${edge.edgeKind}\u0000${edge.fromSiteId}\u0000${edge.toSiteId}`;
      if (observedEdges.has(key)) continue;
      observedEdges.add(key);
      emit("relation_resolved", Object.freeze({
        edgeKind: edge.edgeKind,
        fromSiteId: edge.fromSiteId,
        toSiteId: edge.toSiteId,
      }));
    }
    for (const unknown of analysis.unresolvedSites) {
      const key = `${unknown.kind}\u0000${unknown.reasonCode}`;
      if (observedUnknowns.has(key)) continue;
      observedUnknowns.add(key);
      emit("relation_unknown", Object.freeze({
        unknownKind: unknown.kind,
        reasonCode: unknown.reasonCode,
      }));
    }
  }

  function disposeWorkingSet(): void {
    workingSet.sourceByPath.clear();
    workingSet.fileHeaderByPath.clear();
    workingSet.searchedScopes.clear();
    knownFiles.length = 0;
    latest = null;
  }

  function sourceOf(relPath: string): string | null {
    const value = workingSet.sourceByPath.get(relPath);
    return value === undefined ? null : value.sourceText;
  }

  function corpusFromWorkingSet(state: ValueFlowState): readonly ValueFlowCorpusFile[] {
    const corpus: ValueFlowCorpusFile[] = [];
    for (const file of state.files) {
      const sourceText = sourceOf(file.relPath);
      if (sourceText === null) {
        throw new Error(`value-flow WorkingSet source missing for ${file.relPath}; a fresh run must re-read the file`);
      }
      corpus.push(Object.freeze({ relPath: file.relPath, sourceText }));
    }
    return Object.freeze(corpus);
  }

  function hasWorkingSetSupport(state: ValueFlowState): boolean {
    for (const file of state.files) {
      const source = workingSet.sourceByPath.get(file.relPath);
      if (source === undefined || source.fileObjectRef !== file.fileObjectRef) return false;
      const header = workingSet.fileHeaderByPath.get(file.relPath);
      if (header === undefined || header.relPath !== file.relPath) return false;
    }
    // A scope can complete with zero matches. Absence of a searchMatch alone
    // is not enough to prove the scope was searched by this process.
    for (const scopePath of state.scopePaths) {
      if (!state.pendingSearches.includes(scopePath) && !workingSet.searchedScopes.has(scopePath)) {
        return false;
      }
    }
    for (const match of state.searchMatches) {
      if (!workingSet.searchedScopes.has(posixScopeOf(match.relPath))) return false;
    }
    return true;
  }

  function resetForRebuild(state: ValueFlowState): ValueFlowState {
    // A continuation that lost its WorkingSet must not replay old observations
    // as new facts. Files, sites, edges, searches and search results are
    // invalidated together; the counters stay monotonic and the historical
    // state prefix remains in the controller.
    knownFiles.length = 0;
    workingSet.sourceByPath.clear();
    workingSet.fileHeaderByPath.clear();
    workingSet.searchedScopes.clear();
    return Object.freeze({
      ...state,
      files: Object.freeze([]),
      searchFailures: Object.freeze([]),
      searchMatches: Object.freeze([]),
      // The in-memory knownFiles list and the analyzer's read cache are
      // request-scoped. A continuation rebuild must not reuse the old
      // directory enumeration as facts.
      pendingSearches: Object.freeze([...state.scopePaths]),
      pendingReads: Object.freeze([state.anchorFile]),
      anchorSiteId: null,
      sites: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedSites: Object.freeze([]),
      termination: null,
      lastCompletedActionId: null,
      stageDiagnostics: null,
    });
  }

  function rebuildStateForContinuation(state: ValueFlowState): ValueFlowState {
    if (hasWorkingSetSupport(state)) return state;
    workingSet.rebuildingSources = true;
    return resetForRebuild(state);
  }

  const guards: RecursiveGoalContinuationGuards<
    ValueFlowDomainGoal,
    ValueFlowState,
    ValueFlowBindings,
    ValueFlowEvidencePayload,
    ValueFlowEffectFact,
    SemanticCallReceipt,
    ValueFlowCursor
  > = Object.freeze({
    goal: readValueFlowDomainGoal,
    state: readValueFlowState,
    bindings: readValueFlowBindings,
    evidencePayload: readValueFlowEvidencePayload,
    effectFact: readValueFlowEffectFact,
    sameEffectFact: (
      left: ValueFlowEffectFact,
      right: ValueFlowEffectFact,
    ) => JSON.stringify(left) === JSON.stringify(right),
    receiptPayload: (value: unknown) => value as SemanticCallReceipt,
    cursor: readValueFlowCursor,
    sameGoal: (left: ValueFlowDomainGoal, right: ValueFlowDomainGoal) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left: ValueFlowBindings, right: ValueFlowBindings) => JSON.stringify(left) === JSON.stringify(right),
    sameCursor: (left: ValueFlowCursor, right: ValueFlowCursor) => JSON.stringify(left) === JSON.stringify(right),
  });

  function receipt(
    callback: { readonly context: { readonly requestId: string } },
    current: number,
    semantic: SemanticCallReceipt,
    nextState: ValueFlowState,
    actionId: string,
    action: ValueFlowAction,
    status: "succeeded" | "failed",
  ): AtomicReceipt<ValueFlowState, ValueFlowEvidencePayload, ValueFlowEffectFact, SemanticCallReceipt> {
    const completedState = status === "succeeded"
      ? Object.freeze({ ...nextState, lastCompletedActionId: action.actionId })
      : nextState;
    latest = completedState;
    const id = transitionId(callback.context.requestId, current);
    const payload: ValueFlowEvidencePayload = Object.freeze({
      kind: VALUE_FLOW_EVIDENCE_KIND,
      transitionId: id,
      stateId: stateId(callback.context.requestId, current),
      actionId,
      actionKind: action.kind,
      relPath: action.kind === "read_source_file" ? action.relPath : null,
      status,
      code: semantic.execution?.status === "failed" ? semantic.execution.error.code : null,
    });
    return Object.freeze({
      runId: semantic.execution?.runId ?? null,
      executorInvoked: semantic.execution?.executorInvoked ?? false,
      outcome: status === "succeeded" ? "succeeded" as const : "failed" as const,
      sourceResult: Object.freeze({ tag: "cli.value-flow.receipt.v1", value: stripReceiptBytes(semantic) }) as unknown as AtomicReceipt<ValueFlowState, ValueFlowEvidencePayload, ValueFlowEffectFact, SemanticCallReceipt>["sourceResult"],
      newState: Object.freeze({ id: stateId(callback.context.requestId, current), value: Object.freeze({ ...completedState, stateId: stateId(callback.context.requestId, current) }) }),
      evidence: Object.freeze([Object.freeze({ id: evidenceId(callback.context.requestId, current), stateRef: stateId(callback.context.requestId, current), payload, validity: "valid" as const })]),
      executionErrors: Object.freeze(status === "succeeded" ? [] : [executionError(callback.context.requestId, current, semantic)]),
      verificationErrors: Object.freeze([]),
      effect: Object.freeze({ knowledge: "none" as const, confirmedEffects: Object.freeze([]), receiptRef: null }),
    });
  }

  function executionError(requestId: string, current: number, semantic: SemanticCallReceipt): AdapterDiagnostic {
    const code = semantic.execution?.status === "failed" ? semantic.execution.error.code : "EXECUTION_FAILED";
    return Object.freeze({
      diagnosticId: `${transitionId(requestId, current)}:execution`,
      code: code === "EFFECT_DENIED" ? "effect_denied" : "execution_failed",
      stage: "execution",
      sourceCategory: "cli.value_flow",
      message: semantic.execution?.status === "failed" ? semantic.execution.error.message : "value-flow sandbox execution failed",
      nativeCode: code,
      refs: Object.freeze([]),
    });
  }

  const adapter: ValueFlowAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      const goal = readCliValueFlowGoal(request.rootGoal);
      const bindings = readValueFlowBindings(request.rootBindings);
      let state = readValueFlowState(request.state);
      if (request.rootEvaluatorId !== VALUE_FLOW_ROOT_EVALUATOR || request.rootSelectorId !== VALUE_FLOW_ROOT_SELECTOR) {
        throw new TypeError("value-flow evaluator or selector is unsupported");
      }
      // A resumed request can only re-derive facts from a WorkingSet that is
      // present in this process. When the continuation arrives without it, the
      // files/sites/edges/search state is invalidated before the controller
      // replays pending work, so stale observations are never reused as facts.
      if (request.continuation !== null && request.continuation !== undefined) {
        state = rebuildStateForContinuation(state);
      }
      latest = state;
      return Object.freeze({
        requestId: request.requestId,
        rootGoal: goal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: bindings,
        state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        continuation: request.continuation === undefined ? null : request.continuation as never,
        ...(request.initialObservation === undefined ? {} : { initialObservation: request.initialObservation as never }),
        ...(request.retryPolicy === undefined ? {} : { retryPolicy: request.retryPolicy }),
        ...(request.planning === undefined ? {} : { planning: request.planning as never }),
      });
    },
    supports(callback) {
      return supports(callback);
    },
    async evaluate(callback: EvaluationInput<ValueFlowDomainGoal, ValueFlowState, ValueFlowBindings, ValueFlowEvidencePayload>) {
      const evidenceRefs = stateEvidenceRefs(callback.state, callback.evidence);
      if (callback.goal.kind === "cli.value-flow-action") {
        return atomicEvaluation(callback.goal, callback.state, evidenceRefs);
      }
      const termination = callback.state.termination;
      if (termination === null) return evaluation("unknown", null, evidenceRefs);
      return termination.status === "achieved"
        ? evaluation("satisfied", 100, evidenceRefs)
        : evaluation("unsatisfied", 0, evidenceRefs);
    },
    async select(callback) {
      const first = callback.candidates[0];
      return first === undefined
        ? { kind: "no_capability" as const, searchedSkillIds: [] }
        : { kind: "selected" as const, skillId: first.id };
    },
    async derive(callback) {
      if (callback.goal.kind === "cli.value-flow-action") {
        return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ phase: "closed" as const }), expansion: "closed" as const });
      }
      const state = callback.state;
      if (state.termination !== null) {
        return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ phase: "closed" as const }), expansion: "closed" as const });
      }
      const action: ValueFlowAction | null = state.pendingReads.length > 0
        ? Object.freeze({
            actionId: `${callback.context.requestId}:read:${state.counters.fileReadCalls}:${state.pendingReads[0]}`,
            kind: "read_source_file" as const,
            relPath: state.pendingReads[0] as string,
          })
        : state.pendingSearches.length > 0
          ? Object.freeze({
              actionId: `${callback.context.requestId}:search:${state.counters.searchCalls}:${state.pendingSearches[0]}`,
              kind: "search_candidates" as const,
              symbol: state.anchorSymbol,
            })
          : null;
      if (action === null) {
        return Object.freeze({ conditions: Object.freeze([]), nextCursor: Object.freeze({ phase: "closed" as const }), expansion: "closed" as const });
      }
      const goal = Object.freeze({ kind: "cli.value-flow-action" as const, action });
      return Object.freeze({
        conditions: Object.freeze([condition(action.actionId, action, callback.bindings) as never]),
        nextCursor: Object.freeze({ phase: "execute" as const }),
        expansion: "more" as const,
      });
    },
    async executeAtomic(callback) {
      sequence += 1;
      const current = sequence;
      if (callback.goal.kind !== "cli.value-flow-action") throw new TypeError("value-flow executeAtomic requires an action goal");
      const action = callback.goal.action;
      const state = callback.state;
      if (action.kind === "read_source_file") {
        let semantic: SemanticCallReceipt;
        let fullText = "";
        let totalSize = 0;
        let lastRead: FileReadObservation | null = null;
        let readCount = 0;
        const sessionSnapshot = input.sandbox.getSession(input.session);
        let failedSemantic: SemanticCallReceipt | null = null;
        try {
          let ref: ObservedObjectRef;
          try {
            ref = await input.sandbox.bindFile(input.session, action.relPath);
          } catch (error) {
            const failure = Object.freeze({
              call: { operation: "file.read" as const, parameters: { ref: null, offset: 0, length: 0 } } as unknown as SemanticCallReceipt["call"],
              status: "failed" as const,
              session_before: sessionSnapshot,
              session_after: sessionSnapshot,
              execution: Object.freeze({
                status: "failed" as const,
                runId: "binding-failed",
                executorInvoked: false,
                error: Object.freeze({ operation: "file.read" as const, stage: "authorize" as const, code: "binding_identity_missing" as const, message: error instanceof Error ? error.message : String(error) }),
              }),
            }) as unknown as SemanticCallReceipt;
            failedSemantic = failure;
            const failedState = Object.freeze({
              ...state,
              termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" }),
            });
            return receipt(callback, current, failure, failedState, action.actionId, action, "failed");
          }
          issuedRefs.push(ref);
          // Read to the real file end in fixed-size chunks. 1 MiB is only the
          // chunk size; it is not an authorized caller budget or an excuse to
          // report a false ANCHOR_NOT_FOUND for a file larger than one chunk.
          const CHUNK = 1_048_576;
          let offset = 0;
          let truncated = false;
          for (;;) {
            readCount += 1;
            const readSemantic = await input.sandbox.execute({
              operation: "file.read",
              parameters: { ref, offset, length: CHUNK },
            });
            semantic = readSemantic;
            if (readSemantic.execution.status !== "succeeded" || readSemantic.execution.observation.kind !== "file.read") {
              truncated = fullText.length > 0;
              break;
            }
            const observation = readSemantic.execution.observation;
            lastRead = observation;
            totalSize = observation.size;
            fullText += decodeBase64(observation.bytes);
            if (observation.bytesRead === 0 || observation.end_observed || offset + observation.bytesRead >= observation.size) {
              break;
            }
            offset += observation.bytesRead;
          }
          if (truncated) {
            failedSemantic = semantic!;
            const fileSpan = firstLineSpan(fullText);
            const failedState = Object.freeze({
              ...state,
              counters: Object.freeze({ ...state.counters, sandboxApiCalls: state.counters.sandboxApiCalls + readCount, fileReadCalls: state.counters.fileReadCalls + readCount }),
              unresolvedSites: Object.freeze([
                ...state.unresolvedSites,
                Object.freeze({ kind: "unresolved_missing_or_ambiguous_target" as const, reasonCode: "TRUNCATED_FILE_UNVERIFIED" as const, siteSpan: fileSpan }),
              ]),
              termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" as const }),
            });
            return receipt(callback, current, semantic, failedState, action.actionId, action, "failed");
          }
        } catch (error) {
          const readFailure = Object.freeze({
            call: { operation: "file.read" as const, parameters: { ref: null, offset: 0, length: 0 } },
            status: "failed" as const,
            session_before: sessionSnapshot,
            session_after: sessionSnapshot,
            execution: Object.freeze({
              status: "failed" as const,
              runId: "read-failed",
              executorInvoked: false,
              error: Object.freeze({ operation: "file.read" as const, stage: "observe" as const, code: "EXECUTION_FAILED" as const, message: error instanceof Error ? error.message : String(error) }),
            }),
          }) as unknown as SemanticCallReceipt;
          semantic = readFailure;
          failedSemantic = readFailure;
        }
        if (semantic.execution.status === "failed") {
          if (failedSemantic !== null) semantic = failedSemantic;
          const failedState = Object.freeze({
            ...state,
            searchFailures: state.searchFailures,
            counters: Object.freeze({ ...state.counters, sandboxApiCalls: state.counters.sandboxApiCalls + readCount, fileReadCalls: state.counters.fileReadCalls + readCount }),
            termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" }),
          });
          return receipt(callback, current, semantic, failedState, action.actionId, action, "failed");
        }
        const observation = semantic.execution.observation;
        if (observation.kind !== "file.read") {
          const failedState = Object.freeze({
            ...state,
            counters: Object.freeze({ ...state.counters, sandboxApiCalls: state.counters.sandboxApiCalls + readCount, fileReadCalls: state.counters.fileReadCalls + readCount }),
            termination: Object.freeze({ status: "unknown" as const, resolution: "insufficient_evidence" }),
          });
          return receipt(callback, current, semantic, failedState, action.actionId, action, "failed");
        }
        const read: FileReadObservation = lastRead ?? observation;
        const sourceText = fullText || decodeBase64(read.bytes);
        workingSet.sourceByPath.set(
          action.relPath,
          Object.freeze({ sourceText, fileObjectRef: read.ref, size: totalSize || read.size }),
        );
        workingSet.fileHeaderByPath.set(
          action.relPath,
          buildFileScopeHeaderIndex(action.relPath, sourceText),
        );
        emit("source_observed", Object.freeze({
          relPath: action.relPath,
          size: totalSize || read.size,
        }));
        if (!knownFiles.includes(action.relPath)) knownFiles.push(action.relPath);
        const files = Object.freeze([
          ...state.files.filter(file => file.relPath !== action.relPath),
          Object.freeze({ relPath: action.relPath, fileObjectRef: read.ref, size: totalSize || read.size }),
        ]);
        const pendingReads = Object.freeze(state.pendingReads.slice(1));
        const next = Object.freeze({
          ...state,
          files,
          pendingReads,
          session: frozenSession(semantic.session_after),
          counters: Object.freeze({
            ...state.counters,
            sandboxApiCalls: state.counters.sandboxApiCalls + readCount,
            fileReadCalls: state.counters.fileReadCalls + readCount,
            candidateFilesRead: state.counters.candidateFilesRead + 1,
          }),
        });
        const corpus = corpusFromWorkingSet(next);
        // Analyze once per completed candidate batch, not after every file.
        // The next batch comes from the same full-corpus analysis, so this
        // defers work without dropping import or caller edges.
        if (pendingReads.length > 0 || state.pendingSearches.length > 0) {
          return receipt(callback, current, semantic, next, action.actionId, action, "succeeded");
        }
        const analysis = analyzeValueFlow({
          goal: analysisGoal(state),
          corpus,
          searchCandidates: uniqueSearchPaths(state),
          knownFiles,
          fileHeaderByPath: workingSet.fileHeaderByPath,
        });
        emitAnalysis(analysis);
        const applied = applyAnalysis(next, analysis, { searched: true, budgetExhausted: false, session: semantic.session_after });
        return receipt(callback, current, semantic, applied, action.actionId, action, "succeeded");
      }

      // Search action.
      const scopePath = state.pendingSearches[0] as string;
      let semantic: SemanticCallReceipt | null = null;
      let listFailure: Omit<ValueFlowSearchFailure, "scopePath" | "unfinishedScopePaths" | "unfinishedCandidates"> | null = null;
      let contentFailure: Omit<ValueFlowSearchFailure, "scopePath" | "unfinishedScopePaths" | "unfinishedCandidates"> | null = null;
      let listAttempted = false;
      let contentAttempted = false;
      const matches: SearchMatch[] = [];
      let directoryEntries: string[] = [];
      try {
        const directory = await input.sandbox.bindDirectory(input.session, scopePath);
        listAttempted = true;
        const listSemantic = await input.sandbox.execute({
          operation: "directory.search.entries",
          parameters: {
            session: input.session,
            directory,
            fileFilter: null,
            ignorePolicy: "respect_vcs_ignore",
          },
        });
        if (listSemantic.execution.status === "failed") {
          listFailure = {
            operation: "directory.search.entries",
            stage: listSemantic.execution.error.stage ?? "execute",
            code: listSemantic.execution.error.code ?? "SEARCH_ENTRIES_FAILED",
            message: listSemantic.execution.error.message,
            runId: listSemantic.execution.runId,
            executorInvoked: listSemantic.execution.executorInvoked,
          };
        } else if (listSemantic.execution.observation.kind === "directory.search.entries") {
          directoryEntries = listSemantic.execution.observation.matchedEntries.map(entry =>
            scopePath === "." ? entry : `${scopePath}/${entry}`);
          for (const entry of directoryEntries) if (!knownFiles.includes(entry)) knownFiles.push(entry);
        } else {
          listFailure = {
            operation: "directory.search.entries",
            stage: "observe",
            code: "SEARCH_ENTRIES_OBSERVATION_MISMATCH",
            message: "directory.search.entries returned a non-entries observation",
            runId: listSemantic.execution.runId,
            executorInvoked: listSemantic.execution.executorInvoked,
          };
        }
        contentAttempted = true;
        semantic = await input.sandbox.execute({
          operation: "directory.search.content",
          parameters: {
            session: input.session,
            directory,
            queryLiteral: state.anchorSymbol,
            fileFilter: null,
            ignorePolicy: "respect_vcs_ignore",
          },
        });
        if (semantic.execution.status === "failed") {
          contentFailure = {
            operation: "directory.search.content",
            stage: semantic.execution.error.stage ?? "execute",
            code: semantic.execution.error.code ?? "SEARCH_CONTENT_FAILED",
            message: semantic.execution.error.message,
            runId: semantic.execution.runId,
            executorInvoked: semantic.execution.executorInvoked,
          };
        } else if (semantic.execution.observation.kind === "directory.search.content") {
          for (const line of semantic.execution.observation.matchedLines) {
            const relPath = scopePath === "." ? line.relPath : `${scopePath}/${line.relPath}`;
            matches.push(Object.freeze({
              path: relPath,
              line: line.lineNumber,
              column: columnOf(line.lineText, state.anchorSymbol),
              preview: line.lineText,
            }));
          }
        } else {
          contentFailure = {
            operation: "directory.search.content",
            stage: "observe",
            code: "SEARCH_CONTENT_OBSERVATION_MISMATCH",
            message: "directory.search.content returned a non-content observation",
            runId: semantic.execution.runId,
            executorInvoked: semantic.execution.executorInvoked,
          };
        }
      } catch (error) {
        // A thrown sandbox call is not the same as a zero-match result. Keep
        // the real operation/stage and the original error text so the search
        // failure is observable, never rewritten into a generic bind failure
        // or collapsed into "no matches". `contentAttempted` is set before the
        // content call, so it alone tells us which stage threw.
        const message = error instanceof Error ? error.message : String(error);
        if (contentAttempted) {
          contentFailure = {
            operation: "directory.search.content",
            stage: "execute",
            code: "SEARCH_CONTENT_FAILED",
            message,
            runId: null,
            executorInvoked: false,
          };
        } else if (listAttempted) {
          listFailure = {
            operation: "directory.search.entries",
            stage: "execute",
            code: "SEARCH_ENTRIES_FAILED",
            message,
            runId: null,
            executorInvoked: false,
          };
        } else {
          listFailure = {
            operation: "directory.search.entries",
            stage: "authorize",
            code: "SEARCH_DIRECTORY_BIND_FAILED",
            message,
            runId: null,
            executorInvoked: false,
          };
        }
        semantic = null;
      }
      const ranked = sortSearchCandidatesByVfBaseline(matches, state.direction, 0, state.anchorFile);
      const paths = Object.freeze([...new Set(ranked.map(match => match.path))]);
      const searchSucceeded = listFailure === null && contentFailure === null && semantic !== null;
      if (searchSucceeded) workingSet.searchedScopes.add(scopePath);
      const searchFailureList: ValueFlowSearchFailure[] = [];
      for (const failure of [listFailure, contentFailure]) {
        if (failure === null) continue;
        searchFailureList.push(makeSearchFailure(
          state,
          scopePath,
          failure.operation,
          failure.stage,
          failure.code,
          failure.message,
          failure.runId,
          failure.executorInvoked,
        ));
      }
      const searchedState = Object.freeze({
        ...state,
        session: semantic === null ? state.session : frozenSession(semantic.session_after),
        pendingSearches: searchSucceeded
          ? Object.freeze(state.pendingSearches.slice(1))
          : Object.freeze(
              state.pendingSearches.includes(scopePath)
                ? state.pendingSearches
                : Object.freeze([scopePath, ...state.pendingSearches.filter(item => item !== scopePath)]),
            ),
        searchMatches: Object.freeze([...state.searchMatches, ...ranked.map(match => {
          const priorityTier = vfBaselinePriorityTier(state.direction, 0, state.anchorFile, match);
          return Object.freeze({
            relPath: match.path,
            line: match.line,
            column: match.column,
            preview: match.preview,
            score: baselineScore(priorityTier),
            priorityTier,
            scorerSource: BASELINE_SCORER,
            modelRef: BASELINE_MODEL_REF,
          });
        })]),
        searchFailures: Object.freeze([...state.searchFailures, ...searchFailureList]),
        counters: Object.freeze({
          ...state.counters,
          sandboxApiCalls: state.counters.sandboxApiCalls + (listAttempted ? 1 : 0) + (contentAttempted ? 1 : 0),
          searchCalls: state.counters.searchCalls + (contentAttempted ? 1 : 0),
          searchMatchesSeen: state.counters.searchMatchesSeen + ranked.length,
        }),
      });
      const effectiveFailure = listFailure ?? contentFailure;
      const failedSemantic = semantic === null
        ? Object.freeze({
            call: { operation: "directory.search.content" as const, parameters: { session: input.session, directory: { kind: "cli.directory" as const, scenarioId: input.session.scenarioId, sessionId: input.session.sessionId, path: scopePath }, queryLiteral: state.anchorSymbol, fileFilter: null, ignorePolicy: "respect_vcs_ignore" as const } },
            status: "failed" as const,
            session_before: state.session as unknown as SessionSnapshot,
            session_after: state.session as unknown as SessionSnapshot,
            execution: Object.freeze({
              status: "failed" as const,
              runId: effectiveFailure?.runId ?? "search-failed",
              executorInvoked: effectiveFailure?.executorInvoked ?? false,
              error: Object.freeze({
                operation: effectiveFailure?.operation ?? "directory.search.content",
                stage: effectiveFailure?.stage ?? "authorize",
                code: effectiveFailure?.code ?? "SEARCH_UNAVAILABLE",
                message: effectiveFailure?.message ?? "value-flow candidate search is unavailable",
              }),
            }),
          }) as unknown as SemanticCallReceipt
        : semantic;
      const analysis = analyzeValueFlow({
        goal: analysisGoal(state),
        corpus: corpusFromWorkingSet(searchedState),
        searchCandidates: paths,
        knownFiles: Object.freeze([...knownFiles]),
        fileHeaderByPath: workingSet.fileHeaderByPath,
      });
      emitAnalysis(analysis);
      const applied = applyAnalysis(searchedState, analysis, {
        searched: searchedState.pendingSearches.length === 0,
        budgetExhausted: false,
        session: failedSemantic.execution.status === "succeeded"
          ? failedSemantic.session_after
          : state.session as unknown as SessionSnapshot,
      });
      return receipt(
        callback,
        current,
        failedSemantic,
        applied,
        action.actionId,
        action,
        searchSucceeded ? "succeeded" : "failed",
      );
    },
    validateAtomicReceipt(raw: unknown) {
      return readAtomicReceipt(raw, guards);
    },
    measureProgress(callback) {
      const before = callback.before as ValueFlowState;
      const after = callback.after as ValueFlowState;
      const improved = before.files.length !== after.files.length
        || before.pendingReads.length !== after.pendingReads.length
        || before.termination !== after.termination;
      return { improved, reason: improved ? "facts_improved" as const : "none" as const, comparable: true };
    },
  };

  return Object.freeze({
    adapter,
    issuedRefs: () => Object.freeze([...issuedRefs]),
    getState: () => latest,
    disposeWorkingSet,
  });
}

function analysisGoal(state: ValueFlowState): CliValueFlowGoal {
  return Object.freeze({
    kind: "cli.programming.value_flow" as const,
    anchorFile: state.anchorFile,
    anchorSymbol: state.anchorSymbol,
    ...(state.anchorLexicalPath === null ? {} : { anchorLexicalPath: state.anchorLexicalPath }),
    ...(state.anchorLine === null ? {} : { anchorLine: state.anchorLine }),
    ...(state.anchorColumn === null ? {} : { anchorColumn: state.anchorColumn }),
    direction: state.direction,
    maxDepth: state.maxDepth,
            scopePaths: Object.freeze([...state.scopePaths]),
    resultMode: state.resultMode,
    ...(state.maxCandidateFileReads === null ? {} : { maxCandidateFileReads: state.maxCandidateFileReads }),
    satisfactionThreshold: 1.0 as const,
  });
}

function posixScopeOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index <= 0 ? "." : relPath.slice(0, index);
}

export function createValueFlowDependencies(
  created: ValueFlowAdapterHandle,
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  ValueFlowDomainGoal,
  ValueFlowState,
  ValueFlowBindings,
  ValueFlowEvidencePayload,
  ValueFlowEffectFact,
  SemanticCallReceipt,
  ValueFlowCursor
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: VALUE_FLOW_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: VALUE_FLOW_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: VALUE_FLOW_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: VALUE_FLOW_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function valueFlowDirectionOf(state: ValueFlowState): CliValueFlowDirection {
  return state.direction;
}

export function valueFlowDepthOf(state: ValueFlowState): CliValueFlowMaxDepth {
  return state.maxDepth;
}

export function valueFlowResultModeOf(state: ValueFlowState): CliValueFlowResultMode {
  return state.resultMode;
}

export function valueFlowCountersOf(state: ValueFlowState): ValueFlowCounters {
  return state.counters;
}
