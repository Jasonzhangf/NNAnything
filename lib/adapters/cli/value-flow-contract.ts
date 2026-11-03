// `nn-code value-flow` domain contract: flow-sensitive program-point value-flow
// types and structural guards. This file performs no I/O and holds no AST
// state; the pure AST analysis lives in `lib/filters/cli-value-flow-policy.ts`
// and the sandbox-driven state machine lives in
// `lib/adapters/cli/value-flow-recursive.ts`.
import type { ObservedObjectRef } from "./entry-inspection.js";

export const VALUE_FLOW_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;
export const VALUE_FLOW_EVIDENCE_KIND = "cli.value-flow.evidence.v1" as const;
export const VALUE_FLOW_EFFECT_KIND = "cli.value-flow.effect.v1" as const;
export const VALUE_FLOW_RECEIPT_KIND = "cli.value-flow.receipt.v1" as const;

export const VALUE_FLOW_COMPOSITE_SKILL = "value-flow.composite";
export const VALUE_FLOW_ATOMIC_SKILL = "value-flow.atomic";
export const VALUE_FLOW_ROOT_EVALUATOR = "value-flow-root";
export const VALUE_FLOW_ATOMIC_EVALUATOR = "value-flow-action";
export const VALUE_FLOW_ROOT_SELECTOR = "value-flow-root-selector";
export const VALUE_FLOW_ATOMIC_SELECTOR = "value-flow-action-selector";

export const VALUE_FLOW_EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

// H_R training/logging constants. Product requests do not read these at
// runtime; the usage-log and sample converter consumers share them as the
// single neutral contract.
export const VALUE_FLOW_HR_UNIT_ID = "cli.value-flow.candidate-relevance.v1" as const;
export const VALUE_FLOW_FEATURE_SCHEMA = "cli.value-flow.candidate-features.v1" as const;

export const VALUE_FLOW_FEATURE_NAMES = Object.freeze([
  "r00_dir_is_origin",
  "r01_dir_is_sink",
  "r02_same_dir_as_exported_module",
  "r03_is_test_or_fixture_path",
  "r04_same_line_has_call_open_paren",
  "r05_same_line_call_parens_closed",
  "r06_same_line_has_receive_or_return_prefix",
  "r07_same_line_is_standalone_stmt_prefix",
  "r08_same_line_has_comment_or_type_syntax",
  "r09_same_line_is_import_or_decl_header",
  "r10_same_line_arg_count_covers_target",
  "m00_mask_arg_count_observable",
  "m01_mask_multiline_receive_unobserved",
  "m02_mask_enclosing_block_comment_or_template_unknown",
  "m03_mask_cross_file_module_binding_unverified",
] as const);

export const VALUE_FLOW_LABELS = Object.freeze(["holds", "insufficient", "refuted"] as const);
export const VALUE_FLOW_HR_ARCHITECTURE = Object.freeze([15, 16, 16, 3] as const);
export const VALUE_FLOW_HR_PARAMETER_COUNT = 579 as const;

export type ValueFlowLabel = (typeof VALUE_FLOW_LABELS)[number];
export type ValueFlowPartition = "train" | "dev" | "verification";

export type DeclSpan = Readonly<{
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}>;

export type CliValueFlowDirection = "origin" | "sink";
export type CliValueFlowMaxDepth = 0 | 1 | 2 | 3;
export type CliValueFlowResultMode = "all" | "one";

export interface CliValueFlowGoal {
  readonly kind: "cli.programming.value_flow";
  readonly anchorFile: string;
  readonly anchorSymbol: string;
  readonly anchorLexicalPath?: string;
  readonly anchorLine?: number;
  readonly anchorColumn?: number;
  readonly direction: CliValueFlowDirection;
  readonly maxDepth: CliValueFlowMaxDepth;
  readonly scopePaths: readonly string[];
  readonly resultMode?: CliValueFlowResultMode;
  readonly maxCandidateFileReads?: number;
  readonly satisfactionThreshold: 1.0;
}

export type ValuePointRole =
  | "def_init"
  | "def_param"
  | "def_destructure"
  | "def_import"
  | "def_assign"
  | "use_read"
  | "fn_return"
  | "call_arg"
  | "call_result"
  | "expr_leaf";

export interface ValueSiteNode {
  readonly siteId: string;
  readonly declId: string | null;
  readonly filePath: string;
  readonly symbolName: string;
  readonly lexicalScopeChain: readonly string[];
  readonly pointRole: ValuePointRole;
  readonly declSpan: DeclSpan;
  readonly pointSpan: DeclSpan;
  readonly minDepth: number;
  readonly expanded: boolean;
  readonly fileObjectRef: ObservedObjectRef | null;
}

export type BranchConditionKind =
  | "if_true"
  | "if_false"
  | "switch_case"
  | "switch_default"
  | "ternary_true"
  | "ternary_false"
  | "short_circuit_rhs"
  | "loop_body";

export interface BranchConditionFact {
  // File-scoped identity: the relative repository path that owns this
  // condition. Two files that contain the same text at the same line/column
  // must never be merged into one fact or one chain position.
  readonly relPath: string;
  readonly kind: BranchConditionKind;
  readonly conditionText: string | null;
  readonly conditionSpan: DeclSpan;
}

export type ValueFlowProvenancePrecision =
  | "exact_unconditional"
  | "may_branch_disjunction"
  | "may_loop_fixpoint";

export type ValueFlowEdgeKind =
  | "reaching_def"
  | "local_init"
  | "local_assign"
  | "destructure_extract"
  | "arg_to_param"
  | "return_from_fn"
  | "return_to_call_lhs";

export interface ValueFlowEdgeFact {
  readonly fromSiteId: string;
  readonly toSiteId: string;
  readonly edgeKind: ValueFlowEdgeKind;
  readonly accessPath: string | null;
  readonly provenancePrecision: ValueFlowProvenancePrecision;
  readonly branchConditionAlternatives: readonly (readonly BranchConditionFact[])[];
  readonly branchConditions: readonly BranchConditionFact[];
  readonly isCycleEdge: boolean;
  readonly evidenceSpan: DeclSpan;
}

export interface ValueFlowUnresolvedSite {
  readonly kind:
    | "unverified_cross_file_caller_coverage"
    | "unsupported_subexpression_mutation_order"
    | "unresolved_import_or_export"
    | "ambiguous_anchor_symbol"
    | "anchor_not_found"
    | "unresolved_missing_or_ambiguous_target";
  readonly reasonCode: string;
  readonly siteSpan: DeclSpan;
}

export interface CliValueFlowGoalResult {
  readonly kind: "cli.programming.value_flow.result";
  readonly status: "achieved" | "unknown" | "failed" | "rejected";
  readonly resolution: string;
  readonly provenanceSemantics: "static_may_provenance";
  readonly scorerSource:
    | "deterministic_baseline:VF-Baseline-0"
    | "neural_unit:cli.value-flow.candidate-relevance.v1";
  readonly modelRef: string | null;
  readonly logging: ValueFlowLoggingState;
  readonly anchorSiteId: string | null;
  readonly sites: readonly ValueSiteNode[];
  readonly edges: readonly ValueFlowEdgeFact[];
  readonly unresolvedSites: readonly ValueFlowUnresolvedSite[];
  readonly runLogPath: string | null;
}

export type ValueFlowLoggingState = Readonly<{
  enabled: boolean;
  state: "complete" | "partial" | "disabled" | "failed";
  runLogPath: string | null;
  reason: string | null;
}>;

export type ValueFlowAction =
  | Readonly<{ actionId: string; kind: "search_candidates"; symbol: string }>
  | Readonly<{ actionId: string; kind: "read_source_file"; relPath: string }>;

export type ValueFlowActionGoal = Readonly<{
  kind: "cli.value-flow-action";
  action: ValueFlowAction;
}>;

export type ValueFlowDomainGoal = CliValueFlowGoal | ValueFlowActionGoal;

export type ValueFlowFileFact = Readonly<{
  relPath: string;
  fileObjectRef: ObservedObjectRef | null;
  size: number;
}>;

export type ValueFlowSearchCandidate = Readonly<{
  relPath: string;
  line: number;
  column: number;
  preview: string;
  score: number;
  priorityTier: 1 | 2 | 3 | 4;
  scorerSource:
    | "deterministic_baseline:VF-Baseline-0"
    | "neural_unit:cli.value-flow.candidate-relevance.v1";
  modelRef: string | null;
}>;

export type ValueFlowSearchFailure = Readonly<{
  scopePath: string;
  operation: "directory.search.entries" | "directory.search.content";
  stage: string;
  code: string;
  message: string;
  runId: string | null;
  executorInvoked: boolean;
  unfinishedScopePaths: readonly string[];
  unfinishedCandidates: readonly string[];
}>;

export type ValueFlowCounters = Readonly<{
  sandboxApiCalls: number;
  searchCalls: number;
  fileReadCalls: number;
  candidateFilesRead: number;
  searchMatchesSeen: number;
  totalRelaxations: number;
}>;

export type ValueFlowStageDiagnostics = Readonly<{
  indexParseCount: number;
  evalParseCount: number;
  poolFactsAllocated: number;
  poolChainsAllocated: number;
  poolChainSetsAllocated: number;
  reachableEdgesMaterialized: number;
  analyzerSites: number;
  analyzerEdges: number;
  poolCleared: boolean;
}>;

export type ValueFlowTermination = Readonly<{
  status: "achieved" | "unknown" | "failed" | "rejected";
  resolution: string;
}>;

export interface ValueFlowState {
  readonly stateId: string;
  readonly session: Readonly<{
    id: string;
    cwd: string;
    revision: number;
    grantedEffects: readonly string[];
  }>;
  readonly anchorFile: string;
  readonly anchorSymbol: string;
  readonly anchorLexicalPath: string | null;
  readonly anchorLine: number | null;
  readonly anchorColumn: number | null;
  readonly direction: CliValueFlowDirection;
  readonly maxDepth: CliValueFlowMaxDepth;
  readonly resultMode: CliValueFlowResultMode;
  readonly scopePaths: readonly string[];
  readonly maxCandidateFileReads: number | null;
  readonly files: readonly ValueFlowFileFact[];
  readonly searchMatches: readonly ValueFlowSearchCandidate[];
  readonly searchFailures: readonly ValueFlowSearchFailure[];
  readonly pendingSearches: readonly string[];
  readonly pendingReads: readonly string[];
  readonly anchorSiteId: string | null;
  readonly sites: readonly ValueSiteNode[];
  readonly edges: readonly ValueFlowEdgeFact[];
  readonly unresolvedSites: readonly ValueFlowUnresolvedSite[];
  readonly termination: ValueFlowTermination | null;
  readonly lastCompletedActionId: string | null;
  readonly counters: ValueFlowCounters;
  readonly stageDiagnostics: ValueFlowStageDiagnostics | null;
}

export type ValueFlowBindings = Readonly<{
  session: {
    kind: "cli.session";
    scenarioId: string;
    sessionId: string;
  };
  scopePaths: readonly string[];
}>;

export type ValueFlowEvidencePayload = Readonly<{
  kind: typeof VALUE_FLOW_EVIDENCE_KIND;
  transitionId: string;
  stateId: string;
  actionId: string;
  actionKind: ValueFlowAction["kind"];
  relPath: string | null;
  status: "succeeded" | "failed" | "unknown";
  code: string | null;
}>;

export type ValueFlowEffectFact = Readonly<{
  kind: typeof VALUE_FLOW_EFFECT_KIND;
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type ValueFlowCursor = Readonly<{ phase: "execute" | "closed" }>;

export type ValueFlowRunResult = CliValueFlowGoalResult & Readonly<{
  counters: ValueFlowCounters;
  finalState: ValueFlowState | null;
  continuation: unknown;
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function isCliValueFlowMaxDepth(value: unknown): value is CliValueFlowMaxDepth {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export function readCliValueFlowGoal(value: unknown): CliValueFlowGoal {
  if (!isRecord(value)) throw new TypeError("value-flow root goal must be an object");
  if (value.kind !== "cli.programming.value_flow") {
    throw new TypeError("value-flow root goal kind must be cli.programming.value_flow");
  }
  const anchorFile = nonEmpty(value.anchorFile, "rootGoal.anchorFile");
  const anchorSymbol = nonEmpty(value.anchorSymbol, "rootGoal.anchorSymbol");
  const anchorLexicalPath = value.anchorLexicalPath === undefined
    ? undefined
    : nonEmpty(value.anchorLexicalPath, "rootGoal.anchorLexicalPath");
  const anchorLine = value.anchorLine === undefined
    ? undefined
    : nonNegativeInteger(value.anchorLine, "rootGoal.anchorLine");
  const anchorColumn = value.anchorColumn === undefined
    ? undefined
    : nonNegativeInteger(value.anchorColumn, "rootGoal.anchorColumn");
  if (value.direction !== "origin" && value.direction !== "sink") {
    throw new TypeError('rootGoal.direction must be "origin" or "sink"');
  }
  if (!isCliValueFlowMaxDepth(value.maxDepth)) {
    throw new TypeError("rootGoal.maxDepth must be 0, 1, 2, or 3");
  }
  if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0) {
    throw new TypeError("rootGoal.scopePaths must be a non-empty array");
  }
  const scopePaths = value.scopePaths.map((entry, index) =>
    nonEmpty(entry, `rootGoal.scopePaths[${index}]`));
  const resultMode = value.resultMode === undefined ? "all" : value.resultMode;
  if (resultMode !== "all" && resultMode !== "one") {
    throw new TypeError('rootGoal.resultMode must be "all" or "one"');
  }
  const maxCandidateFileReads = optionalPositiveInteger(
    value.maxCandidateFileReads,
    "rootGoal.maxCandidateFileReads",
  );
  if (value.satisfactionThreshold !== 1.0) {
    throw new TypeError("rootGoal.satisfactionThreshold must be 1.0");
  }
  return Object.freeze({
    kind: "cli.programming.value_flow" as const,
    anchorFile,
    anchorSymbol,
    ...(anchorLexicalPath === undefined ? {} : { anchorLexicalPath }),
    ...(anchorLine === undefined ? {} : { anchorLine }),
    ...(anchorColumn === undefined ? {} : { anchorColumn }),
    direction: value.direction,
    maxDepth: value.maxDepth,
    scopePaths: Object.freeze(scopePaths),
    ...(value.resultMode === undefined ? {} : { resultMode }),
    ...(maxCandidateFileReads === undefined ? {} : { maxCandidateFileReads }),
    satisfactionThreshold: 1.0 as const,
  });
}

export function readValueFlowAction(value: unknown): ValueFlowAction {
  if (!isRecord(value)) throw new TypeError("value-flow action must be an object");
  const actionId = nonEmpty(value.actionId, "action.actionId");
  if (value.kind === "search_candidates") {
    return Object.freeze({
      actionId,
      kind: "search_candidates" as const,
      symbol: nonEmpty(value.symbol, "action.symbol"),
    });
  }
  if (value.kind === "read_source_file") {
    return Object.freeze({
      actionId,
      kind: "read_source_file" as const,
      relPath: nonEmpty(value.relPath, "action.relPath"),
    });
  }
  throw new TypeError("action.kind is unsupported");
}

export function readValueFlowDomainGoal(value: unknown): ValueFlowDomainGoal {
  if (!isRecord(value)) throw new TypeError("value-flow goal must be an object");
  if (value.kind === "cli.programming.value_flow") return readCliValueFlowGoal(value);
  if (value.kind === "cli.value-flow-action") {
    return Object.freeze({
      kind: "cli.value-flow-action" as const,
      action: readValueFlowAction(value.action),
    });
  }
  throw new TypeError("value-flow goal kind is unsupported");
}

export function isRootGoal(value: unknown): value is CliValueFlowGoal {
  return isRecord(value) && value.kind === "cli.programming.value_flow";
}

export function isActionGoal(value: unknown): value is ValueFlowActionGoal {
  return isRecord(value) && value.kind === "cli.value-flow-action";
}

export function readValueFlowBindings(value: unknown): ValueFlowBindings {
  if (!isRecord(value)) throw new TypeError("value-flow bindings must be an object");
  const session = value.session;
  if (!isRecord(session)) throw new TypeError("value-flow bindings.session must be an object");
  if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0) {
    throw new TypeError("value-flow bindings.scopePaths must be a non-empty array");
  }
  return Object.freeze({
    session: Object.freeze({
      kind: "cli.session" as const,
      scenarioId: nonEmpty(session.scenarioId, "bindings.session.scenarioId"),
      sessionId: nonEmpty(session.sessionId, "bindings.session.sessionId"),
    }),
    scopePaths: Object.freeze(value.scopePaths.map((entry, index) =>
      nonEmpty(entry, `bindings.scopePaths[${index}]`))),
  });
}

function readSessionSnapshot(value: unknown): ValueFlowState["session"] {
  if (!isRecord(value)) throw new TypeError("state.session must be an object");
  if (!Array.isArray(value.grantedEffects)) throw new TypeError("state.session.grantedEffects must be an array");
  return Object.freeze({
    id: nonEmpty(value.id, "state.session.id"),
    cwd: nonEmpty(value.cwd, "state.session.cwd"),
    revision: nonNegativeInteger(value.revision, "state.session.revision"),
    grantedEffects: Object.freeze(value.grantedEffects.map((entry, index) =>
      nonEmpty(entry, `state.session.grantedEffects[${index}]`))),
  });
}

export function readValueFlowState(value: unknown): ValueFlowState {
  if (!isRecord(value)) throw new TypeError("value-flow state must be an object");
  const stateId = nonEmpty(value.stateId, "state.stateId");
  if (!isCliValueFlowMaxDepth(value.maxDepth)) throw new TypeError("state.maxDepth is invalid");
  const resultMode = value.resultMode === "all" ? "all" : value.resultMode === "one" ? "one" : null;
  if (resultMode === null) throw new TypeError("state.resultMode is invalid");
  if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0) {
    throw new TypeError("state.scopePaths must be a non-empty array");
  }
  const termination = value.termination === null || value.termination === undefined
    ? null
    : Object.freeze({
        status: nonEmpty(
          (value.termination as Record<string, unknown>).status,
          "state.termination.status",
        ) as ValueFlowTermination["status"],
        resolution: nonEmpty(
          (value.termination as Record<string, unknown>).resolution,
          "state.termination.resolution",
        ),
      });
  const stageDiagnostics = value.stageDiagnostics === null || value.stageDiagnostics === undefined
    ? null
    : (() => {
        if (!isRecord(value.stageDiagnostics)) {
          throw new TypeError("state.stageDiagnostics must be an object");
        }
        return Object.freeze({
          indexParseCount: nonNegativeInteger(value.stageDiagnostics.indexParseCount, "state.stageDiagnostics.indexParseCount"),
          evalParseCount: nonNegativeInteger(value.stageDiagnostics.evalParseCount, "state.stageDiagnostics.evalParseCount"),
          poolFactsAllocated: nonNegativeInteger(value.stageDiagnostics.poolFactsAllocated, "state.stageDiagnostics.poolFactsAllocated"),
          poolChainsAllocated: nonNegativeInteger(value.stageDiagnostics.poolChainsAllocated, "state.stageDiagnostics.poolChainsAllocated"),
          poolChainSetsAllocated: nonNegativeInteger(value.stageDiagnostics.poolChainSetsAllocated, "state.stageDiagnostics.poolChainSetsAllocated"),
          reachableEdgesMaterialized: nonNegativeInteger(value.stageDiagnostics.reachableEdgesMaterialized, "state.stageDiagnostics.reachableEdgesMaterialized"),
          analyzerSites: nonNegativeInteger(value.stageDiagnostics.analyzerSites, "state.stageDiagnostics.analyzerSites"),
          analyzerEdges: nonNegativeInteger(value.stageDiagnostics.analyzerEdges, "state.stageDiagnostics.analyzerEdges"),
          poolCleared: value.stageDiagnostics.poolCleared === true,
        });
      })();
  const files = Array.isArray(value.files)
    ? Object.freeze(value.files.map((entry, index) => {
        if (!isRecord(entry)) throw new TypeError(`state.files[${index}] must be an object`);
        // Old states may carry a non-contract `sourceText` mirror. Drop it at
        // the boundary; source text is owned by the request WorkingSet.
        return Object.freeze({
          relPath: nonEmpty(entry.relPath, `state.files[${index}].relPath`),
          fileObjectRef: entry.fileObjectRef === null || entry.fileObjectRef === undefined
            ? null
            : entry.fileObjectRef as ValueFlowFileFact["fileObjectRef"],
          size: nonNegativeInteger(entry.size, `state.files[${index}].size`),
        });
      }))
    : Object.freeze([]);
  const searchMatches = Array.isArray(value.searchMatches)
    ? Object.freeze(value.searchMatches.map((entry, index) => {
        if (!isRecord(entry)) throw new TypeError(`state.searchMatches[${index}] must be an object`);
        if (entry.scorerSource !== "deterministic_baseline:VF-Baseline-0"
          && entry.scorerSource !== "neural_unit:cli.value-flow.candidate-relevance.v1") {
          throw new TypeError(`state.searchMatches[${index}].scorerSource is invalid`);
        }
        if (entry.priorityTier !== 1 && entry.priorityTier !== 2 && entry.priorityTier !== 3 && entry.priorityTier !== 4) {
          throw new TypeError(`state.searchMatches[${index}].priorityTier is invalid`);
        }
        return Object.freeze({
          relPath: nonEmpty(entry.relPath, `state.searchMatches[${index}].relPath`),
          line: nonNegativeInteger(entry.line, `state.searchMatches[${index}].line`),
          column: nonNegativeInteger(entry.column, `state.searchMatches[${index}].column`),
          preview: typeof entry.preview === "string"
            ? entry.preview
            : (() => { throw new TypeError(`state.searchMatches[${index}].preview must be a string`); })(),
          score: entry.score as number,
          priorityTier: entry.priorityTier,
          scorerSource: entry.scorerSource,
          modelRef: entry.modelRef === null || entry.modelRef === undefined
            ? null
            : nonEmpty(entry.modelRef, `state.searchMatches[${index}].modelRef`),
        });
      }))
    : Object.freeze([]);
  return Object.freeze({
    stateId,
    session: readSessionSnapshot(value.session),
    anchorFile: nonEmpty(value.anchorFile, "state.anchorFile"),
    anchorSymbol: nonEmpty(value.anchorSymbol, "state.anchorSymbol"),
    anchorLexicalPath: value.anchorLexicalPath === null ? null : nonEmpty(value.anchorLexicalPath, "state.anchorLexicalPath"),
    anchorLine: value.anchorLine === null || value.anchorLine === undefined ? null : nonNegativeInteger(value.anchorLine, "state.anchorLine"),
    anchorColumn: value.anchorColumn === null || value.anchorColumn === undefined ? null : nonNegativeInteger(value.anchorColumn, "state.anchorColumn"),
    direction: value.direction === "sink" ? "sink" : value.direction === "origin" ? "origin" : null as never,
    maxDepth: value.maxDepth,
    resultMode,
    scopePaths: Object.freeze(value.scopePaths.map((entry, index) =>
      nonEmpty(entry, `state.scopePaths[${index}]`))),
    maxCandidateFileReads: value.maxCandidateFileReads === null || value.maxCandidateFileReads === undefined
      ? null
      : nonNegativeInteger(value.maxCandidateFileReads, "state.maxCandidateFileReads"),
    files,
    searchMatches,
    searchFailures: Array.isArray(value.searchFailures)
      ? Object.freeze(value.searchFailures.map((entry, index) => {
          if (!isRecord(entry)) throw new TypeError(`state.searchFailures[${index}] must be an object`);
          return Object.freeze({
            scopePath: nonEmpty(entry.scopePath, `state.searchFailures[${index}].scopePath`),
            operation: entry.operation === "directory.search.entries"
              ? "directory.search.entries" as const
              : entry.operation === "directory.search.content"
                ? "directory.search.content" as const
                : (() => {
                    throw new TypeError(`state.searchFailures[${index}].operation is invalid`);
                  })(),
            stage: nonEmpty(entry.stage, `state.searchFailures[${index}].stage`),
            code: nonEmpty(entry.code, `state.searchFailures[${index}].code`),
            message: nonEmpty(entry.message, `state.searchFailures[${index}].message`),
            runId: entry.runId === null || entry.runId === undefined
              ? null
              : nonEmpty(entry.runId, `state.searchFailures[${index}].runId`),
            executorInvoked: entry.executorInvoked === true,
            unfinishedScopePaths: Array.isArray(entry.unfinishedScopePaths)
              ? Object.freeze(entry.unfinishedScopePaths.map((value, nestedIndex) =>
                  nonEmpty(value, `state.searchFailures[${index}].unfinishedScopePaths[${nestedIndex}]`)))
              : Object.freeze([]),
            unfinishedCandidates: Array.isArray(entry.unfinishedCandidates)
              ? Object.freeze(entry.unfinishedCandidates.map((value, nestedIndex) =>
                  nonEmpty(value, `state.searchFailures[${index}].unfinishedCandidates[${nestedIndex}]`)))
              : Object.freeze([]),
          });
        }))
      : Object.freeze([]),
    pendingSearches: Array.isArray(value.pendingSearches)
      ? Object.freeze(value.pendingSearches.map((entry, index) =>
          nonEmpty(entry, `state.pendingSearches[${index}]`)))
      : Object.freeze([]),
    pendingReads: Array.isArray(value.pendingReads)
      ? Object.freeze(value.pendingReads.map((entry, index) =>
          nonEmpty(entry, `state.pendingReads[${index}]`)))
      : Object.freeze([]),
    anchorSiteId: value.anchorSiteId === null || value.anchorSiteId === undefined ? null : nonEmpty(value.anchorSiteId, "state.anchorSiteId"),
    sites: value.sites as readonly ValueSiteNode[],
    edges: value.edges as readonly ValueFlowEdgeFact[],
    unresolvedSites: value.unresolvedSites as readonly ValueFlowUnresolvedSite[],
    termination,
    lastCompletedActionId:
      value.lastCompletedActionId === null || value.lastCompletedActionId === undefined
        ? null
        : nonEmpty(value.lastCompletedActionId, "state.lastCompletedActionId"),
    stageDiagnostics,
    counters: Object.freeze({
      sandboxApiCalls: nonNegativeInteger((value.counters as Record<string, unknown>).sandboxApiCalls, "counters.sandboxApiCalls"),
      searchCalls: nonNegativeInteger((value.counters as Record<string, unknown>).searchCalls, "counters.searchCalls"),
      fileReadCalls: nonNegativeInteger((value.counters as Record<string, unknown>).fileReadCalls, "counters.fileReadCalls"),
      candidateFilesRead: nonNegativeInteger((value.counters as Record<string, unknown>).candidateFilesRead, "counters.candidateFilesRead"),
      searchMatchesSeen: nonNegativeInteger((value.counters as Record<string, unknown>).searchMatchesSeen, "counters.searchMatchesSeen"),
      totalRelaxations: nonNegativeInteger((value.counters as Record<string, unknown>).totalRelaxations, "counters.totalRelaxations"),
    }),
  });
}

export function readValueFlowEvidencePayload(value: unknown): ValueFlowEvidencePayload {
  if (!isRecord(value)) throw new TypeError("evidence payload must be an object");
  if (value.kind !== VALUE_FLOW_EVIDENCE_KIND) throw new TypeError("evidence payload kind is invalid");
  return Object.freeze({
    kind: VALUE_FLOW_EVIDENCE_KIND,
    transitionId: nonEmpty(value.transitionId, "evidence.transitionId"),
    stateId: nonEmpty(value.stateId, "evidence.stateId"),
    actionId: nonEmpty(value.actionId, "evidence.actionId"),
    actionKind: nonEmpty(value.actionKind, "evidence.actionKind") as ValueFlowAction["kind"],
    relPath: value.relPath === null || value.relPath === undefined ? null : nonEmpty(value.relPath, "evidence.relPath"),
    status: value.status === "succeeded" || value.status === "failed" ? value.status : "unknown",
    code: value.code === null || value.code === undefined ? null : nonEmpty(value.code, "evidence.code"),
  });
}

export function readValueFlowEffectFact(value: unknown): ValueFlowEffectFact {
  if (!isRecord(value)) throw new TypeError("effect fact must be an object");
  if (value.kind !== VALUE_FLOW_EFFECT_KIND) throw new TypeError("effect fact kind is invalid");
  return Object.freeze({
    kind: VALUE_FLOW_EFFECT_KIND,
    transitionId: nonEmpty(value.transitionId, "effect.transitionId"),
    runId: value.runId === null || value.runId === undefined ? null : nonEmpty(value.runId, "effect.runId"),
    invoked: value.invoked === true,
  });
}

export function readValueFlowCursor(value: unknown): ValueFlowCursor {
  if (!isRecord(value)) throw new TypeError("cursor must be an object");
  if (value.phase !== "execute" && value.phase !== "closed") {
    throw new TypeError("cursor.phase must be execute or closed");
  }
  return Object.freeze({ phase: value.phase });
}

export function valueFlowWithinScope(relPath: string, scopePaths: readonly string[]): boolean {
  return scopePaths.some(scope => relPath === scope || relPath.startsWith(`${scope}/`));
}
