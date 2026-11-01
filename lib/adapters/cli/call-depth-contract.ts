// Deterministic call-depth domain contract for Slice CD-1.
// This file only defines types and structural guards. It performs no I/O and
// holds no AST state, so both the adapter and the public entry can share it.
import type { ObservedObjectRef, OsInteger } from "./entry-inspection.js";

export const CALL_DEPTH_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;
export const CALL_DEPTH_EVIDENCE_KIND = "cli.call-depth.evidence.v1" as const;
export const CALL_DEPTH_EFFECT_KIND = "cli.call-depth.effect.v1" as const;
export const CALL_DEPTH_RECEIPT_KIND = "cli.call-depth.receipt.v1" as const;
export const CALL_DEPTH_MAX_SOURCE_FILE_BYTES = 1_048_576 as const;

export const CALL_DEPTH_COMPOSITE_SKILL = "call-depth.composite";
export const CALL_DEPTH_ATOMIC_SKILL = "call-depth.atomic";
export const CALL_DEPTH_ROOT_EVALUATOR = "call-depth-root";
export const CALL_DEPTH_ATOMIC_EVALUATOR = "call-depth-action";
export const CALL_DEPTH_ROOT_SELECTOR = "call-depth-root-selector";
export const CALL_DEPTH_ATOMIC_SELECTOR = "call-depth-action-selector";

export const CALL_DEPTH_EFFECTS = Object.freeze(["filesystem.read"] as const);

export type CallDepthStatus = "achieved" | "unmet" | "unknown" | "rejected" | "failed";

export type CallDepthResolution =
  | "complete"
  | "entry_not_found"
  | "ambiguous_entry_symbol"
  | "partial"
  | "insufficient_evidence"
  | "budget_exhausted"
  | "interrupted"
  | "rejected"
  | "failed"
  | "UNSUPPORTED_LANGUAGE"
  | "LANGUAGE_MISMATCH"
  | "FILE_TYPE_UNSUPPORTED";

export type CallDepthMaxDepth = 0 | 1 | 2 | 3;

export type DeclSpan = Readonly<{
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}>;

export type CliCalleeCallGraphGoal = Readonly<{
  kind: "cli.programming.callee_call_graph";
  entryFile: string;
  entrySymbol: string;
  entryLexicalPath?: string;
  maxDepth: CallDepthMaxDepth;
  direction: "callee";
  scopePaths: readonly string[];
  satisfactionThreshold: 1.0;
}>;

export type CallDepthAction =
  | Readonly<{ actionId: string; kind: "read_source_file"; relPath: string }>
  | Readonly<{ actionId: string; kind: "relax_call_graph" }>
  | Readonly<{ actionId: string; kind: "verify_source_consistency"; relPath: string }>;

export type CallDepthActionGoal = Readonly<{
  kind: "cli.call-depth-action";
  action: CallDepthAction;
}>;

export type CallDepthDomainGoal = CliCalleeCallGraphGoal | CallDepthActionGoal;

export type CallGraphNodeFact = Readonly<{
  nodeId: string;
  filePath: string;
  symbolName: string;
  lexicalScopeChain: string;
  minDepth: number;
  bodyExtracted: boolean;
  declSpan: DeclSpan;
  nameSpan: DeclSpan;
  fileObjectRef: ObservedObjectRef | null;
}>;

export type CallGraphResolvedEdgeFact = Readonly<{
  callerId: string;
  calleeId: string;
  edgeKind: "resolved_in_repo";
  isCycleEdge: boolean;
  calleeInDegree: number;
  callsiteSpan: DeclSpan;
  evidenceSnippet: string;
}>;

export type CallDepthUnresolvedKind =
  | "unresolved_dynamic"
  | "out_of_scope_external"
  | "unresolved_missing_or_ambiguous_target";

export type CallDepthUnresolvedCallsite = Readonly<{
  callerId: string;
  calleeExpr: string;
  callsiteSpan: DeclSpan;
  kind: CallDepthUnresolvedKind;
  reasonCode: string;
}>;

export type CallDepthSourceFileFact = Readonly<{
  relPath: string;
  fileObjectRef: ObservedObjectRef;
  dev: OsInteger;
  ino: OsInteger;
  size: number;
  initialBytesBase64: string;
  sourceText: string;
  verifiedUnchangedAtClosure: boolean;
}>;

export type CallDepthPartialSourceFact = Readonly<{
  relPath: string;
  dev: OsInteger;
  ino: OsInteger;
  size: number;
  bytesRead: number;
  complete: false;
  truncated: true;
}>;

export type CallDepthOpenCallsite = Readonly<{
  callerId: string;
  callsiteSpan: DeclSpan;
  calleeExpr: string;
  rootId: string | null;
}>;

export type CallDepthCounters = Readonly<{
  filesReadCount: number;
  initialAstFileReadCalls: number;
  closureVerifyFileReadCalls: number;
  bodyExtractedCount: number;
  closedCallsiteCount: number;
  totalRelaxations: number;
  closureVerifiedFilesCount: number;
  sandboxApiCalls: number;
}>;

export type CallDepthTermination = Readonly<{
  status: CallDepthStatus;
  resolution: CallDepthResolution;
}>;

export type CallDepthState = Readonly<{
  stateId: string;
  session: Readonly<{
    id: string;
    cwd: string;
    revision: number;
    grantedEffects: readonly string[];
  }>;
  entryFile: string;
  entrySymbol: string;
  entryLexicalPath: string | null;
  maxDepth: CallDepthMaxDepth;
  entryResolved: boolean;
  entryResolution: "ok" | "entry_not_found" | "ambiguous_entry_symbol";
  entryNodeId: string | null;
  files: readonly CallDepthSourceFileFact[];
  partialSources: readonly CallDepthPartialSourceFact[];
  missingFiles: readonly string[];
  nodes: readonly CallGraphNodeFact[];
  edges: readonly CallGraphResolvedEdgeFact[];
  unresolvedCallsites: readonly CallDepthUnresolvedCallsite[];
  openCallsites: readonly CallDepthOpenCallsite[];
  pendingReads: readonly string[];
  relaxPending: boolean;
  sourceConsistencyFailed: boolean;
  truncated: boolean;
  termination: CallDepthTermination | null;
  lastCompletedActionId: string | null;
  counters: CallDepthCounters;
}>;

export type CallDepthBindings = Readonly<{
  session: {
    kind: "cli.session";
    scenarioId: string;
    sessionId: string;
  };
  scopePaths: readonly string[];
}>;

export type CallDepthEvidencePayload = Readonly<{
  kind: typeof CALL_DEPTH_EVIDENCE_KIND;
  transitionId: string;
  stateId: string;
  actionId: string;
  actionKind: CallDepthAction["kind"];
  relPath: string | null;
  status: "succeeded" | "failed" | "unknown";
  code: string | null;
  bytesRead: number | null;
  endObserved: boolean | null;
}>;

export type CallDepthEffectFact = Readonly<{
  kind: typeof CALL_DEPTH_EFFECT_KIND;
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type CallDepthReceiptPayload = Readonly<{
  kind: typeof CALL_DEPTH_RECEIPT_KIND;
  actionKind: CallDepthAction["kind"];
  status: "succeeded" | "failed";
  code: string | null;
}>;

export type CallDepthCursor = Readonly<{ phase: "execute" | "closed" }>;

export const CALL_DEPTH_SUPPORTED_LANGUAGES = Object.freeze([
  "typescript",
  "javascript",
] as const);

export type CallDepthSupportedLanguage = typeof CALL_DEPTH_SUPPORTED_LANGUAGES[number];
export type CallDepthRequestedLanguage =
  | CallDepthSupportedLanguage
  | "rust"
  | "cpp"
  | "kotlin"
  | "java"
  | "swift";

export type CallDepthLanguageRoute = Readonly<{
  requestedLanguage: CallDepthRequestedLanguage | null;
  entryLanguage: CallDepthRequestedLanguage | null;
  parserLanguage: CallDepthSupportedLanguage | null;
  supported: boolean;
  mismatch: boolean;
  unsupportedEntryFileType: boolean;
}>;

export type CallDepthTextDisposition =
  | "unclassified"
  | "definition"
  | "confirmed_call"
  | "other_binding"
  | "non_code"
  | "unknown";

export type CallDepthTextCandidate = Readonly<{
  candidateId: string;
  filePath: string;
  line: number;
  column: number;
  span: DeclSpan;
  byteSpan: Readonly<{ start: number; end: number }>;
  matchedText: string;
  preview: string;
  matchedNeedle: string;
  disposition: CallDepthTextDisposition;
  evidenceRefs: readonly string[];
}>;

export type CallDepthTextCoverage = Readonly<{
  complete: boolean;
  status: "complete" | "partial" | "failed" | "not_run";
  cardinality: "all";
  recursion: "nested";
  matchedFiles: number;
  scannedFiles: number;
  unresolvedFiles: number;
  typeMismatches: number;
  failures: readonly string[];
  unreadFiles: readonly string[];
  exclusions: Readonly<{
    hiddenEntries: "included";
    vcsIgnore: "not_applied";
    binaryFiles: "not_classified";
    symlinks: "not_followed";
  }>;
  scanConditions: Readonly<{
    needle: string;
    caseSensitive: true;
    literal: true;
    mustContain: true;
  }>;
}>;

export type CallDepthSemanticCoverage = Readonly<{
  complete: boolean;
  status: "complete" | "partial" | "not_attempted" | "unsupported" | "mismatch" | "failed";
  parser: CallDepthSupportedLanguage | null;
  requestedMaxDepth: CallDepthMaxDepth;
  achievedDepth: number;
  depthBounded: true;
  truncated: boolean;
  sourceConsistencyFailed: boolean;
}>;

export type CallDepthCoverage = Readonly<{
  scope: Readonly<{
    paths: readonly string[];
    entryFile: string;
    scopePrefixMatch: true;
  }>;
  text: CallDepthTextCoverage;
  semantic: CallDepthSemanticCoverage;
  languageSupport: Readonly<{
    requested: CallDepthRequestedLanguage | null;
    entryFile: CallDepthRequestedLanguage | null;
    supported: boolean;
    supportedLanguages: readonly CallDepthSupportedLanguage[];
    actualParser: CallDepthSupportedLanguage | null;
  }>;
}>;

export type CallDepthRunResult = Readonly<{
  status: CallDepthStatus;
  resolution: CallDepthResolution;
  entryNodeId: string | null;
  requestedMaxDepth: CallDepthMaxDepth;
  achievedDepth: number;
  nodes: readonly CallGraphNodeFact[];
  edges: readonly CallGraphResolvedEdgeFact[];
  unresolvedCallsites: readonly CallDepthUnresolvedCallsite[];
  counters: CallDepthCounters;
  requestedLanguage: CallDepthRequestedLanguage | null;
  actualParser: CallDepthSupportedLanguage | null;
  supportedLanguages: readonly CallDepthSupportedLanguage[];
  textCandidates: readonly CallDepthTextCandidate[];
  coverage: CallDepthCoverage;
  reasonCode: string | null;
  finalState: CallDepthState | null;
  response: unknown;
}>;

const LANGUAGE_ALIASES: Readonly<Record<string, CallDepthRequestedLanguage>> = Object.freeze({
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  rust: "rust",
  rs: "rust",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  kotlin: "kotlin",
  kt: "kotlin",
  java: "java",
  swift: "swift",
});

const LANGUAGE_EXTENSIONS: Readonly<Record<CallDepthRequestedLanguage, readonly string[]>> = Object.freeze({
  typescript: Object.freeze([".ts", ".tsx", ".mts", ".cts"]),
  javascript: Object.freeze([".js", ".jsx", ".mjs", ".cjs"]),
  rust: Object.freeze([".rs"]),
  cpp: Object.freeze([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]),
  kotlin: Object.freeze([".kt", ".kts"]),
  java: Object.freeze([".java"]),
  swift: Object.freeze([".swift"]),
});

export function normalizeCallDepthLanguage(value: string): CallDepthRequestedLanguage | null {
  return LANGUAGE_ALIASES[value.toLowerCase()] ?? null;
}

export function languageOfEntryFile(entryFile: string): CallDepthRequestedLanguage | null {
  const lower = entryFile.toLowerCase();
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.some(extension => lower.endsWith(extension))) {
      return language as CallDepthRequestedLanguage;
    }
  }
  return null;
}

export function routeCallDepthLanguage(
  requestedLanguage: string | null,
  entryFile: string,
): CallDepthLanguageRoute {
  const requested = requestedLanguage === null
    ? null
    : normalizeCallDepthLanguage(requestedLanguage);
  if (requestedLanguage !== null && requested === null) {
    throw new TypeError(`unknown --language value: ${requestedLanguage}`);
  }
  const entryLanguage = languageOfEntryFile(entryFile);
  const parserLanguage = requested === "typescript" || requested === "javascript"
    ? requested
    : requested === null && (entryLanguage === "typescript" || entryLanguage === "javascript" || entryLanguage === null)
      ? "typescript"
      : null;
  const supported = requested === null ? parserLanguage !== null : requested === "typescript" || requested === "javascript";
  const mismatch = requested === null
    ? false
    : entryLanguage !== null && (
        requested === "typescript"
          ? entryLanguage !== "typescript" && entryLanguage !== "javascript"
          : requested === "javascript"
            ? entryLanguage !== "typescript" && entryLanguage !== "javascript"
            : entryLanguage !== requested
      );
  return Object.freeze({
    requestedLanguage: requested,
    entryLanguage,
    parserLanguage,
    supported,
    mismatch,
    unsupportedEntryFileType: requested === null
      && entryLanguage !== null
      && entryLanguage !== "typescript"
      && entryLanguage !== "javascript",
  });
}

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

export function isCallDepthMaxDepth(value: unknown): value is CallDepthMaxDepth {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export function readCalleeCallGraphGoal(value: unknown): CliCalleeCallGraphGoal {
  if (!isRecord(value)) throw new TypeError("call-depth root goal must be an object");
  if (value.kind !== "cli.programming.callee_call_graph") {
    throw new TypeError("call-depth root goal kind must be cli.programming.callee_call_graph");
  }
  const entryFile = nonEmpty(value.entryFile, "rootGoal.entryFile");
  const entrySymbol = nonEmpty(value.entrySymbol, "rootGoal.entrySymbol");
  const entryLexicalPath = value.entryLexicalPath === undefined
    ? undefined
    : nonEmpty(value.entryLexicalPath, "rootGoal.entryLexicalPath");
  if (!isCallDepthMaxDepth(value.maxDepth)) {
    throw new TypeError("rootGoal.maxDepth must be 0, 1, 2, or 3");
  }
  if (value.direction !== "callee") {
    throw new TypeError('rootGoal.direction must be "callee"');
  }
  if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0) {
    throw new TypeError("rootGoal.scopePaths must be a non-empty array");
  }
  const scopePaths = value.scopePaths.map((entry, index) =>
    nonEmpty(entry, `rootGoal.scopePaths[${index}]`));
  if (value.satisfactionThreshold !== 1.0) {
    throw new TypeError("rootGoal.satisfactionThreshold must be 1.0");
  }
  return Object.freeze({
    kind: "cli.programming.callee_call_graph" as const,
    entryFile,
    entrySymbol,
    ...(entryLexicalPath === undefined ? {} : { entryLexicalPath }),
    maxDepth: value.maxDepth,
    direction: "callee" as const,
    scopePaths: Object.freeze(scopePaths),
    satisfactionThreshold: 1.0 as const,
  });
}

export function readCallDepthAction(value: unknown): CallDepthAction {
  if (!isRecord(value)) throw new TypeError("action must be an object");
  const actionId = nonEmpty(value.actionId, "action.actionId");
  if (value.kind === "read_source_file" || value.kind === "verify_source_consistency") {
    return Object.freeze({
      actionId,
      kind: value.kind,
      relPath: nonEmpty(value.relPath, "action.relPath"),
    });
  }
  if (value.kind === "relax_call_graph") {
    return Object.freeze({ actionId, kind: "relax_call_graph" as const });
  }
  throw new TypeError("action.kind is unsupported");
}

export function readCallDepthDomainGoal(value: unknown): CallDepthDomainGoal {
  if (!isRecord(value)) throw new TypeError("call-depth goal must be an object");
  if (value.kind === "cli.programming.callee_call_graph") return readCalleeCallGraphGoal(value);
  if (value.kind === "cli.call-depth-action") {
    return Object.freeze({ kind: "cli.call-depth-action" as const, action: readCallDepthAction(value.action) });
  }
  throw new TypeError("call-depth goal kind is unsupported");
}

export function isRootGoal(value: unknown): value is CliCalleeCallGraphGoal {
  return isRecord(value) && value.kind === "cli.programming.callee_call_graph";
}

export function isActionGoal(value: unknown): value is CallDepthActionGoal {
  return isRecord(value) && value.kind === "cli.call-depth-action";
}

export function readCallDepthBindings(value: unknown): CallDepthBindings {
  if (!isRecord(value)) throw new TypeError("call-depth bindings must be an object");
  const session = value.session;
  if (!isRecord(session)) throw new TypeError("call-depth bindings.session must be an object");
  if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0) {
    throw new TypeError("call-depth bindings.scopePaths must be a non-empty array");
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

export function readCallDepthState(value: unknown): CallDepthState {
  if (!isRecord(value)) throw new TypeError("call-depth state must be an object");
  const session = value.session;
  if (!isRecord(session)) throw new TypeError("call-depth state.session must be an object");
  if (!Array.isArray(session.grantedEffects)) throw new TypeError("state.session.grantedEffects must be an array");
  const counters = value.counters;
  if (!isRecord(counters)) throw new TypeError("call-depth state.counters must be an object");
  for (const key of ["files", "partialSources", "missingFiles", "nodes", "edges", "unresolvedCallsites", "openCallsites", "pendingReads"] as const) {
    if (!Array.isArray(value[key])) throw new TypeError(`call-depth state.${key} must be an array`);
  }
  if (!isCallDepthMaxDepth(value.maxDepth)) throw new TypeError("call-depth state.maxDepth is invalid");
  if (value.entryResolution !== "ok" && value.entryResolution !== "entry_not_found" && value.entryResolution !== "ambiguous_entry_symbol") {
    throw new TypeError("call-depth state.entryResolution is invalid");
  }
  const stateId = nonEmpty(value.stateId, "state.stateId");
  return Object.freeze({
    stateId,
    session: Object.freeze({
      id: nonEmpty(session.id, "state.session.id"),
      cwd: nonEmpty(session.cwd, "state.session.cwd"),
      revision: nonNegativeInteger(session.revision, "state.session.revision"),
      grantedEffects: Object.freeze(session.grantedEffects.map((entry, index) =>
        nonEmpty(entry, `state.session.grantedEffects[${index}]`))),
    }),
    entryFile: nonEmpty(value.entryFile, "state.entryFile"),
    entrySymbol: nonEmpty(value.entrySymbol, "state.entrySymbol"),
    entryLexicalPath: value.entryLexicalPath === null ? null : nonEmpty(value.entryLexicalPath, "state.entryLexicalPath"),
    maxDepth: value.maxDepth,
    entryResolved: value.entryResolved === true,
    entryResolution: value.entryResolution,
    entryNodeId: value.entryNodeId === null ? null : nonEmpty(value.entryNodeId, "state.entryNodeId"),
    files: value.files as readonly CallDepthSourceFileFact[],
    partialSources: value.partialSources as readonly CallDepthPartialSourceFact[],
    missingFiles: value.missingFiles as readonly string[],
    nodes: value.nodes as readonly CallGraphNodeFact[],
    edges: value.edges as readonly CallGraphResolvedEdgeFact[],
    unresolvedCallsites: value.unresolvedCallsites as readonly CallDepthUnresolvedCallsite[],
    openCallsites: value.openCallsites as readonly CallDepthOpenCallsite[],
    pendingReads: value.pendingReads as readonly string[],
    relaxPending: value.relaxPending === true,
    sourceConsistencyFailed: value.sourceConsistencyFailed === true,
    truncated: value.truncated === true,
    termination: value.termination === null || value.termination === undefined
      ? null
      : Object.freeze({
          status: nonEmpty((value.termination as Record<string, unknown>).status, "state.termination.status") as CallDepthStatus,
          resolution: nonEmpty((value.termination as Record<string, unknown>).resolution, "state.termination.resolution") as CallDepthResolution,
        }),
    lastCompletedActionId: value.lastCompletedActionId === null ? null : nonEmpty(value.lastCompletedActionId, "state.lastCompletedActionId"),
    counters: Object.freeze({
      filesReadCount: nonNegativeInteger(counters.filesReadCount, "counters.filesReadCount"),
      initialAstFileReadCalls: nonNegativeInteger(counters.initialAstFileReadCalls, "counters.initialAstFileReadCalls"),
      closureVerifyFileReadCalls: nonNegativeInteger(counters.closureVerifyFileReadCalls, "counters.closureVerifyFileReadCalls"),
      bodyExtractedCount: nonNegativeInteger(counters.bodyExtractedCount, "counters.bodyExtractedCount"),
      closedCallsiteCount: nonNegativeInteger(counters.closedCallsiteCount, "counters.closedCallsiteCount"),
      totalRelaxations: nonNegativeInteger(counters.totalRelaxations, "counters.totalRelaxations"),
      closureVerifiedFilesCount: nonNegativeInteger(counters.closureVerifiedFilesCount, "counters.closureVerifiedFilesCount"),
      sandboxApiCalls: nonNegativeInteger(counters.sandboxApiCalls, "counters.sandboxApiCalls"),
    }),
  });
}

export function readCallDepthEvidencePayload(value: unknown): CallDepthEvidencePayload {
  if (!isRecord(value)) throw new TypeError("evidence payload must be an object");
  if (value.kind !== CALL_DEPTH_EVIDENCE_KIND) throw new TypeError("evidence payload kind is invalid");
  return Object.freeze({
    kind: CALL_DEPTH_EVIDENCE_KIND,
    transitionId: nonEmpty(value.transitionId, "evidence.transitionId"),
    stateId: nonEmpty(value.stateId, "evidence.stateId"),
    actionId: nonEmpty(value.actionId, "evidence.actionId"),
    actionKind: nonEmpty(value.actionKind, "evidence.actionKind") as CallDepthAction["kind"],
    relPath: value.relPath === null ? null : nonEmpty(value.relPath, "evidence.relPath"),
    status: value.status === "succeeded" || value.status === "failed" ? value.status : "unknown",
    code: value.code === null || value.code === undefined ? null : nonEmpty(value.code, "evidence.code"),
    bytesRead: value.bytesRead === null || value.bytesRead === undefined ? null : nonNegativeInteger(value.bytesRead, "evidence.bytesRead"),
    endObserved: value.endObserved === true ? true : value.endObserved === false ? false : null,
  });
}

export function readCallDepthEffectFact(value: unknown): CallDepthEffectFact {
  if (!isRecord(value)) throw new TypeError("effect fact must be an object");
  if (value.kind !== CALL_DEPTH_EFFECT_KIND) throw new TypeError("effect fact kind is invalid");
  return Object.freeze({
    kind: CALL_DEPTH_EFFECT_KIND,
    transitionId: nonEmpty(value.transitionId, "effect.transitionId"),
    runId: value.runId === null || value.runId === undefined ? null : nonEmpty(value.runId, "effect.runId"),
    invoked: value.invoked === true,
  });
}

export function readCallDepthReceiptPayload(value: unknown): CallDepthReceiptPayload {
  if (!isRecord(value)) throw new TypeError("receipt payload must be an object");
  if (value.kind !== CALL_DEPTH_RECEIPT_KIND) throw new TypeError("receipt payload kind is invalid");
  return Object.freeze({
    kind: CALL_DEPTH_RECEIPT_KIND,
    actionKind: nonEmpty(value.actionKind, "receipt.actionKind") as CallDepthAction["kind"],
    status: value.status === "succeeded" ? "succeeded" : "failed",
    code: value.code === null || value.code === undefined ? null : nonEmpty(value.code, "receipt.code"),
  });
}

export function readCallDepthCursor(value: unknown): CallDepthCursor {
  if (!isRecord(value)) throw new TypeError("cursor must be an object");
  if (value.phase !== "execute" && value.phase !== "closed") {
    throw new TypeError("cursor.phase must be execute or closed");
  }
  return Object.freeze({ phase: value.phase });
}

export function withinScope(relPath: string, scopePaths: readonly string[]): boolean {
  return scopePaths.some(scope => relPath === scope || relPath.startsWith(`${scope}/`));
}
