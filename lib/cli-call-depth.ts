// Slice CD-1 public entry: `runCliCalleeCallGraphGoal`.
//
// The request is the only source of the intended meaning. It binds the target
// session through the caller-supplied sandbox, builds the deterministic state,
// and drives the existing 3N2E recursive-goal controller. All reads flow
// through the adapter; the AST policy is pure and performs no OS access.
import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import type { RecursiveGoalLimits } from "./workflow/recursive-goal/contracts.js";
import { join, relative } from "node:path";
import {
  createReadOnlyCliFilesystemSandbox,
  type CliFilesystemSandbox,
  type SessionRef,
  type SessionSnapshot,
} from "./adapters/cli/filesystem-sandbox.js";
import {
  buildInitialState,
  createCallDepthAdapter,
  createCallDepthDependencies,
} from "./adapters/cli/call-depth-recursive.js";
import {
  CALL_DEPTH_ROOT_EVALUATOR,
  CALL_DEPTH_ROOT_SELECTOR,
  CALL_DEPTH_REQUEST_SCHEMA,
  CALL_DEPTH_SUPPORTED_LANGUAGES,
  readCalleeCallGraphGoal,
  routeCallDepthLanguage,
  type CallDepthCoverage,
  type CallDepthRequestedLanguage,
  type CallDepthRunResult,
  type CallDepthState,
  type CallDepthSupportedLanguage,
  type CallDepthTextCandidate,
  type CliCalleeCallGraphGoal,
} from "./adapters/cli/call-depth-contract.js";
import {
  createReadOnlyContentSearchSandbox,
  runCliContentSearchGoal,
} from "./cli-content-search.js";
import type { ContentSearchDomainProjection } from "./adapters/cli/content-search-contract.js";
import {
  expandTextHit,
  recordTextExpansionFailure,
  textCoverageStatus,
} from "./adapters/cli/call-depth-text.js";
import { CALL_DEPTH_ACTUAL_PARSER } from "./filters/cli-call-depth-policy.js";
import {
  CLI_COMMAND_HEADS,
  CLI_COMMAND_PREDICATES,
  CLI_COMMAND_PROPERTIES,
  CLI_COMMAND_WIRES,
  validateCliCommandProfile,
  type CliCommandProfile,
} from "./filters/cli-command-policy.js";

export type CallDepthResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  limits?: RecursiveGoalLimits;
  language?: string | null;
  signal?: AbortSignal;
  continuation?: unknown;
}>;

function latestState(value: unknown): CallDepthState | null {
  const report = value as {
    report?: { states?: readonly { value?: unknown }[] } | null;
  } | null;
  if (report?.report?.states === undefined) return null;
  const states = report.report.states;
  if (states.length === 0) return null;
  const last = states[states.length - 1]?.value;
  if (last === null || typeof last !== "object") return null;
  return last as CallDepthState;
}

function rootResultOf(value: unknown): Readonly<{
  result: "satisfied" | "unsatisfied" | "unknown" | "not_evaluated";
  satisfaction: number | null;
}> {
  const report = value as {
    report?: {
      rootEvaluation?: {
        state?: unknown;
        result?: unknown;
        satisfaction?: unknown;
      } | null;
      control?: { outcome?: unknown; stopReason?: unknown } | null;
    } | null;
  } | null;
  const evaluation = report?.report?.rootEvaluation;
  if (evaluation === null || evaluation === undefined || evaluation.state !== "evaluated") {
    return Object.freeze({ result: "not_evaluated", satisfaction: null });
  }
  const result = evaluation.result;
  if (result !== "satisfied" && result !== "unsatisfied" && result !== "unknown") {
    return Object.freeze({ result: "not_evaluated", satisfaction: null });
  }
  const satisfaction = typeof evaluation.satisfaction === "number" ? evaluation.satisfaction : null;
  return Object.freeze({ result, satisfaction });
}

function stopOf(value: unknown): Readonly<{ outcome: string | null; stopReason: string | null }> {
  const report = value as {
    report?: { control?: { outcome?: unknown; stopReason?: unknown } | null } | null;
  } | null;
  const control = report?.report?.control;
  return Object.freeze({
    outcome: typeof control?.outcome === "string" ? control.outcome : null,
    stopReason: typeof control?.stopReason === "string" ? control.stopReason : null,
  });
}

function deriveRunResult(
  goal: CliCalleeCallGraphGoal,
  response: unknown,
  finalState: CallDepthState | null,
  route: ReturnType<typeof routeCallDepthLanguage>,
  textCandidates: readonly CallDepthTextCandidate[],
  textCoverage: CallDepthCoverage["text"],
  semanticStatus: CallDepthCoverage["semantic"]["status"],
  reasonCode: string | null,
): CallDepthRunResult {
  const root = rootResultOf(response);
  const stop = stopOf(response);
  const budgetStopped = stop.outcome === "exceeded"
    && (stop.stopReason === "budget" || stop.stopReason === "too_many_attempts");
  const interrupted = !budgetStopped && (stop.outcome === "exceeded"
    || stop.outcome === "cancelled"
    || stop.outcome === "stalled"
    || stop.stopReason === "budget"
    || stop.stopReason === "cancel"
    || stop.stopReason === "no_progress");

  let status: CallDepthRunResult["status"];
  let resolution: CallDepthRunResult["resolution"];
  if (budgetStopped) {
    status = "unknown";
    resolution = "budget_exhausted";
  } else if (interrupted) {
    status = "unknown";
    resolution = "interrupted";
  } else if (finalState?.termination !== null && finalState?.termination !== undefined) {
    status = finalState.termination.status;
    resolution = finalState.termination.resolution;
  } else if (root.result === "satisfied") {
    status = "achieved";
    resolution = "complete";
  } else if (root.result === "unsatisfied") {
    status = "unmet";
    resolution = finalState?.entryResolution === "ok" || finalState?.entryResolution === undefined
      ? "entry_not_found"
      : finalState.entryResolution;
  } else if (finalState?.sourceConsistencyFailed === true || finalState?.truncated === true) {
    status = "unknown";
    resolution = "insufficient_evidence";
  } else {
    status = "unknown";
    resolution = "insufficient_evidence";
  }

  const maxDepthOfNodes = finalState === null
    ? 0
    : finalState.nodes.reduce((max, node) => Math.max(max, node.minDepth), 0);
  const achievedDepth = finalState === null ? 0 : maxDepthOfNodes;
  const actualParser = CALL_DEPTH_ACTUAL_PARSER;
  return Object.freeze({
    status,
    resolution,
    entryNodeId: finalState?.entryNodeId ?? null,
    requestedMaxDepth: goal.maxDepth,
    achievedDepth,
    nodes: finalState?.nodes ?? Object.freeze([]),
    edges: finalState?.edges ?? Object.freeze([]),
    unresolvedCallsites: finalState?.unresolvedCallsites ?? Object.freeze([]),
    counters: finalState?.counters ?? Object.freeze({
      filesReadCount: 0,
      initialAstFileReadCalls: 0,
      closureVerifyFileReadCalls: 0,
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
      totalRelaxations: 0,
      closureVerifiedFilesCount: 0,
      sandboxApiCalls: 0,
    }),
    requestedLanguage: route.requestedLanguage,
    actualParser,
    supportedLanguages: CALL_DEPTH_SUPPORTED_LANGUAGES,
    textCandidates,
    coverage: coverageOf(
      goal,
      achievedDepth,
      finalState,
      route,
      textCoverage,
      semanticStatus,
    ),
    reasonCode,
    finalState,
    response,
  });
}

type TextSearchOutcome = Readonly<{
  candidates: readonly CallDepthTextCandidate[];
  coverage: CallDepthCoverage["text"];
  errors: readonly string[];
}>;

const TEXT_SCAN = Object.freeze({
  maxBytesPerFile: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  chunkSize: 64 * 1024,
  maxDirectoryDepth: 1024,
  maxStaleRetries: 1,
});

const TEXT_LIMITS = Object.freeze({
  maxTransitions: 1_000_000,
  maxDepth: 1000,
  maxDerivedGoals: 1_000_000,
});

/**
 * Deterministic head routing for the read-only text scan.
 *
 * The content-search recursion reuses the shared `cli-file-property` workflow,
 * whose list/inspect atoms select a command head from `cli.command-policy.v1`.
 * A zero profile selects the default `unsupported` head, so the scan cannot
 * start. This one-hot routing profile only makes the two fixed read heads
 * reachable (`ls` for `directory.entries`, `entry.inspect` for `type`); it is
 * not a fitted model and never claims calibrated/adopted state.
 */
function textScanRoutingProfile(): CliCommandProfile {
  const weights = CLI_COMMAND_HEADS.map(() => CLI_COMMAND_WIRES.map(() => 0));
  const set = (head: typeof CLI_COMMAND_HEADS[number], wire: typeof CLI_COMMAND_WIRES[number]): void => {
    const row = CLI_COMMAND_HEADS.indexOf(head);
    const column = CLI_COMMAND_WIRES.indexOf(wire);
    if (row < 0 || column < 0) throw new TypeError(`Unknown text-scan route ${head} x ${wire}`);
    weights[row]![column] = 1;
  };
  set("ls", "goalListDirectory");
  set("ls", "property.directory.entries");
  set("ls", "predicate.observe.entries");
  set("entry.inspect", "property.type");
  set("entry.inspect", "predicate.observe.inspect");
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function textFailureMessages(fact: ContentSearchDomainProjection["rootFact"]): readonly string[] {
  if (fact === null) return Object.freeze([]);
  if (fact.kind === "partial" || fact.kind === "insufficient_evidence") {
    return Object.freeze([...fact.reasons]);
  }
  if (fact.kind === "failed") {
    return Object.freeze(fact.errors.map(error => {
      const path = typeof error?.path === "string" ? error.path : "<scope>";
      const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
      return `${path}:${code}`;
    }));
  }
  if (fact.kind === "rejected") return Object.freeze(["search_rejected"]);
  if (fact.kind === "interrupted") return Object.freeze(["search_interrupted"]);
  return Object.freeze([]);
}

async function collectTextSearch(
  goal: CliCalleeCallGraphGoal,
  resources: CallDepthResources,
  requestId: string,
): Promise<TextSearchOutcome> {
  // The text scan runs on its own read-only handle over the same scenario root.
  // It must not share the caller's file-read observer, otherwise the extra scan
  // reads would change the AST contract counters or in-place-rewrite probes.
  const textSandbox = await createReadOnlyCliFilesystemSandbox({
    root: resources.sandbox.scenarioRoot,
    scenarioId: resources.session.scenarioId,
    sessionId: resources.session.sessionId,
  });
  const textSession = textSandbox.bindSession(resources.session.sessionId);
  const searchSandbox = createReadOnlyContentSearchSandbox(textSandbox);
  const profile = textScanRoutingProfile();
  const byId = new Map<string, CallDepthTextCandidate>();
  const errors: string[] = [];
  const unreadFiles: string[] = [];
  let searched = false;
  let complete = true;
  let matchedFiles = 0;
  let scannedFiles = 0;
  let unresolvedFiles = 0;
  let typeMismatches = 0;
  const session = textSandbox.getSession(textSession);
  const scopes = [...new Set(goal.scopePaths)];

  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]!;
    const absoluteScope = scope === "." || scope === ""
      ? textSandbox.scenarioRoot
      : join(textSandbox.scenarioRoot, scope);
    let directory;
    try {
      const relativeScope = relative(session.cwd, absoluteScope) || ".";
      directory = await textSandbox.bindDirectory(textSession, relativeScope);
    } catch (error) {
      complete = false;
      errors.push(`scope ${scope}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let result;
    try {
      result = await runCliContentSearchGoal({
        requestId: `${requestId}:text-${index}`,
        goal: {
          kind: "file.property",
          property: "file.property.content.bytes",
          target: {
            kind: "cli.content-search-scope",
            directory,
            fileCondition: null,
            cardinality: "all",
            recursion: "nested",
          },
          requirement: {
            kind: "contains",
            predicate: {
              kind: "contains",
              needle: goal.entrySymbol,
              encoding: "utf8",
            },
          },
        },
        satisfactionThreshold: 100,
      }, {
        sandbox: searchSandbox,
        session: textSession,
        profile,
        scan: TEXT_SCAN,
        limits: TEXT_LIMITS,
      });
    } catch (error) {
      complete = false;
      errors.push(`scope ${scope}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const domain = result.domain;
    if (domain.status === "failed" || domain.status === "rejected") {
      complete = false;
      errors.push(...textFailureMessages(domain.rootFact));
      for (const error of domain.rootFact === null || domain.rootFact.kind !== "failed"
        ? []
        : domain.rootFact.errors) {
        if (typeof error.path === "string" && error.path.length > 0) unreadFiles.push(error.path);
      }
      continue;
    }
    searched = true;
    matchedFiles += domain.matches.length;
    scannedFiles += domain.denominators.candidatesScanned;
    unresolvedFiles += domain.denominators.candidatesUnresolved;
    typeMismatches += domain.denominators.typeMismatches;
    if (domain.coverage !== "complete") complete = false;
    errors.push(...textFailureMessages(domain.rootFact));
    for (const hit of domain.matches) {
      const expanded = await expandTextHit(textSandbox.scenarioRoot, hit, searchSandbox);
      for (const candidate of expanded.candidates) {
        byId.set(candidate.candidateId, candidate);
      }
      complete = recordTextExpansionFailure(complete, errors, unreadFiles, expanded.failure);
    }
  }

  const candidates = [...byId.values()].sort((left, right) =>
    left.filePath === right.filePath
      ? left.byteSpan.start - right.byteSpan.start
      : left.filePath < right.filePath ? -1 : 1
  );
  const uniqueErrors = [...new Set(errors)];
  const status = textCoverageStatus(complete, searched);
  await textSandbox.cleanup();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    coverage: Object.freeze({
      complete: complete && searched,
      status,
      cardinality: "all" as const,
      recursion: "nested" as const,
      matchedFiles,
      scannedFiles,
      unresolvedFiles,
      typeMismatches,
      failures: Object.freeze(uniqueErrors),
      unreadFiles: Object.freeze(unreadFiles),
      exclusions: Object.freeze({
        hiddenEntries: "included" as const,
        vcsIgnore: "not_applied" as const,
        binaryFiles: "not_classified" as const,
        symlinks: "not_followed" as const,
      }),
      scanConditions: Object.freeze({
        needle: goal.entrySymbol,
        caseSensitive: true as const,
        literal: true as const,
        mustContain: true as const,
      }),
    }),
    errors: Object.freeze(uniqueErrors),
  });
}

function coverageOf(
  goal: CliCalleeCallGraphGoal,
  achievedDepth: number,
  finalState: CallDepthState | null,
  route: ReturnType<typeof routeCallDepthLanguage>,
  text: CallDepthCoverage["text"],
  semanticStatus: CallDepthCoverage["semantic"]["status"],
): CallDepthCoverage {
  const parserInvoked = semanticStatus === "complete" || semanticStatus === "partial";
  const actualParser = parserInvoked ? CALL_DEPTH_ACTUAL_PARSER : null;
  return Object.freeze({
    scope: Object.freeze({
      paths: goal.scopePaths,
      entryFile: goal.entryFile,
      scopePrefixMatch: true as const,
    }),
    text,
    semantic: Object.freeze({
      complete: semanticStatus === "complete",
      status: semanticStatus,
      parser: actualParser,
      requestedMaxDepth: goal.maxDepth,
      achievedDepth,
      depthBounded: true as const,
      truncated: finalState?.truncated ?? false,
      sourceConsistencyFailed: finalState?.sourceConsistencyFailed ?? false,
    }),
    languageSupport: Object.freeze({
      requested: route.requestedLanguage,
      entryFile: route.entryLanguage,
      supported: route.supported,
      supportedLanguages: CALL_DEPTH_SUPPORTED_LANGUAGES,
      actualParser,
    }),
  });
}

function spanContains(
  outer: CallDepthTextCandidate["span"],
  inner: CallDepthTextCandidate["span"],
): boolean {
  const startsWithin = inner.startLine > outer.startLine
    || (inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn);
  const endsWithin = inner.endLine < outer.endLine
    || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsWithin && endsWithin;
}

function classifyTextCandidate(
  candidate: CallDepthTextCandidate,
  result: CallDepthRunResult,
): CallDepthTextCandidate {
  const callerOf = (callerId: string) =>
    result.nodes.find(node => node.nodeId === callerId) ?? null;
  for (const edge of result.edges) {
    const caller = callerOf(edge.callerId);
    if (caller !== null
      && caller.filePath === candidate.filePath
      && spanContains(edge.callsiteSpan, candidate.span)) {
      return Object.freeze({ ...candidate, disposition: "confirmed_call" });
    }
  }
  for (const node of result.nodes) {
    if (node.filePath === candidate.filePath
      && node.symbolName === candidate.matchedText
      && spanContains(node.declSpan, candidate.span)) {
      return Object.freeze({ ...candidate, disposition: "definition" });
    }
  }
  for (const unresolved of result.unresolvedCallsites) {
    const caller = callerOf(unresolved.callerId);
    if (caller !== null
      && caller.filePath === candidate.filePath
      && spanContains(unresolved.callsiteSpan, candidate.span)) {
      return Object.freeze({
        ...candidate,
        disposition: "unknown",
        evidenceRefs: Object.freeze([...candidate.evidenceRefs, `callsite:${unresolved.callerId}`]),
      });
    }
  }
  return candidate;
}

function emptyCounters(): CallDepthRunResult["counters"] {
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

function noParserResult(
  goal: CliCalleeCallGraphGoal,
  route: ReturnType<typeof routeCallDepthLanguage>,
  text: TextSearchOutcome,
  resolution: "UNSUPPORTED_LANGUAGE" | "LANGUAGE_MISMATCH" | "FILE_TYPE_UNSUPPORTED",
): CallDepthRunResult {
  const semanticStatus: CallDepthCoverage["semantic"]["status"] =
    resolution === "LANGUAGE_MISMATCH" ? "mismatch" : "unsupported";
  return Object.freeze({
    status: "unknown",
    resolution,
    entryNodeId: null,
    requestedMaxDepth: goal.maxDepth,
    achievedDepth: 0,
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    unresolvedCallsites: Object.freeze([]),
    counters: emptyCounters(),
    requestedLanguage: route.requestedLanguage,
    actualParser: null,
    supportedLanguages: CALL_DEPTH_SUPPORTED_LANGUAGES,
    textCandidates: text.candidates,
    coverage: coverageOf(goal, 0, null, route, text.coverage, semanticStatus),
    reasonCode: resolution,
    finalState: null,
    response: null,
  });
}

export async function runCliCalleeCallGraphGoal(
  rawRequest: unknown,
  resources: CallDepthResources,
): Promise<CallDepthRunResult> {
  // Validate the request before touching any sandbox state.
  const raw = rawRequest as Readonly<Record<string, unknown>> | null;
  const goalValue = raw?.rootGoal ?? raw?.goal ?? raw;
  const goal = readCalleeCallGraphGoal(goalValue);
  const requestId = typeof raw?.requestId === "string" && raw.requestId.length > 0
    ? raw.requestId
    : "cli-call-depth";
  const route = routeCallDepthLanguage(resources.language ?? null, goal.entryFile);
  const text = await collectTextSearch(goal, resources, requestId);
  if (!route.supported || route.mismatch || route.unsupportedEntryFileType) {
    return noParserResult(
      goal,
      route,
      text,
      route.unsupportedEntryFileType
        ? "FILE_TYPE_UNSUPPORTED"
        : route.mismatch
          ? "LANGUAGE_MISMATCH"
          : "UNSUPPORTED_LANGUAGE",
    );
  }
  const scopePaths = goal.scopePaths;
  const sessionSnapshot: SessionSnapshot = resources.sandbox.getSession(resources.session);
  const state = buildInitialState(goal, sessionSnapshot, requestId);
  const created = createCallDepthAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
  });
  created.setState(state);
  const response = await runRecursiveGoal(
    {
      schema: CALL_DEPTH_REQUEST_SCHEMA,
      requestId,
      rootGoal: goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: Object.freeze({
          kind: "cli.session" as const,
          scenarioId: resources.session.scenarioId,
          sessionId: resources.session.sessionId,
        }),
        scopePaths,
      }),
      state,
      rootEvaluatorId: CALL_DEPTH_ROOT_EVALUATOR,
      rootSelectorId: CALL_DEPTH_ROOT_SELECTOR,
      ...(resources.limits === undefined ? {} : { limits: resources.limits }),
      ...(resources.continuation === undefined ? {} : { continuation: resources.continuation }),
    },
    createCallDepthDependencies(created, resources.signal),
  );
  const finalState = created.getState() ?? latestState(response);
  const parsed = deriveRunResult(
    goal,
    response,
    finalState,
    route,
    text.candidates,
    text.coverage,
    "partial",
    null,
  );
  const semanticStatus: CallDepthCoverage["semantic"]["status"] =
    parsed.status === "achieved" && parsed.resolution === "complete" ? "complete" : "partial";
  return Object.freeze({
    ...parsed,
    textCandidates: Object.freeze(text.candidates.map(candidate => classifyTextCandidate(candidate, parsed))),
    coverage: coverageOf(goal, parsed.achievedDepth, finalState, route, text.coverage, semanticStatus),
  });
}

export {
  createCliFilesystemSandbox,
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SCENARIO_ID,
  DEFAULT_READ_ONLY_SESSION_ID,
} from "./adapters/cli/filesystem-sandbox.js";
export { readCalleeCallGraphGoal } from "./adapters/cli/call-depth-contract.js";
export type {
  CallDepthRunResult,
  CallDepthState,
  CliCalleeCallGraphGoal,
} from "./adapters/cli/call-depth-contract.js";
