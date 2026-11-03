// `nn-code value-flow` public entry. The reusable API and the direct
// `dist/cli-value-flow.js` executable share the same recursive-goal path.
// All persistence is routed through the shared `UsageLogRun` v2 lifecycle
// (start -> source_observed/node_expanded/relation_resolved/relation_unknown
// -> finish); no hand-built JSONL writer or parallel log file exists here.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RecursiveGoalLimits } from "./workflow/recursive-goal/contracts.js";
import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SCENARIO_ID,
  DEFAULT_READ_ONLY_SESSION_ID,
  type CliFilesystemSandbox,
  type SessionRef,
} from "./adapters/cli/filesystem-sandbox.js";
import {
  buildInitialState,
  createValueFlowAdapter,
  createValueFlowDependencies,
} from "./adapters/cli/value-flow-recursive.js";
import {
  createUsageLogRun,
  disabledUsageLog,
  failedUsageLog,
  isAllowedUsageLogKind,
  USAGE_LOG_UNKNOWN_EXCERPT_LIMIT,
  type UsageLogResult,
  type UsageLogRun,
} from "./adapters/cli/nn-code-usage-log.js";
import {
  VALUE_FLOW_REQUEST_SCHEMA,
  VALUE_FLOW_ROOT_EVALUATOR,
  VALUE_FLOW_ROOT_SELECTOR,
  readCliValueFlowGoal,
  readValueFlowState,
  type CliValueFlowGoal,
  type CliValueFlowMaxDepth,
  type CliValueFlowResultMode,
  type ValueFlowLoggingState,
  type ValueFlowRunResult,
  type ValueFlowState,
} from "./adapters/cli/value-flow-contract.js";

export type ValueFlowResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  limits?: RecursiveGoalLimits;
  signal?: AbortSignal;
  continuation?: unknown;
  runLogDir?: string;
  runLogPath?: string;
  // Default is enabled. `--no-log` sets this to false so no file is created
  // and no byte is persisted for the whole request.
  loggingEnabled?: boolean;
}>;

export type CliValueFlowCliOptions = Readonly<{
  root: string;
  goal: CliValueFlowGoal;
  requestId?: string;
  logDir?: string;
  runLogPath?: string;
  loggingEnabled?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code && code !== "undefined") return code;
  }
  return null;
}

let cachedCliVersion: string | null = null;

function readCliVersion(): string {
  if (cachedCliVersion !== null) return cachedCliVersion;
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`Invalid package.json version at ${pkgPath}`);
  }
  cachedCliVersion = parsed.version.trim();
  return cachedCliVersion;
}

function latestState(value: unknown): ValueFlowState | null {
  const report = value as {
    report?: { states?: readonly { value?: unknown }[] } | null;
  } | null;
  const states = report?.report?.states;
  if (states === undefined || states.length === 0) return null;
  const last = states[states.length - 1]?.value;
  return isRecord(last) ? readValueFlowState(last) : null;
}

function rootEvaluation(value: unknown): Readonly<{
  result: "satisfied" | "unsatisfied" | "unknown" | "not_evaluated";
}> {
  const report = value as {
    report?: { rootEvaluation?: { state?: unknown; result?: unknown } | null } | null;
  } | null;
  const evaluation = report?.report?.rootEvaluation;
  if (evaluation === null || evaluation === undefined || evaluation.state !== "evaluated") {
    return Object.freeze({ result: "not_evaluated" as const });
  }
  const result = evaluation.result;
  if (result !== "satisfied" && result !== "unsatisfied" && result !== "unknown") {
    return Object.freeze({ result: "not_evaluated" as const });
  }
  return Object.freeze({ result });
}

function control(value: unknown): Readonly<{
  outcome: string | null;
  stopReason: string | null;
}> {
  const report = value as {
    report?: { control?: { outcome?: unknown; stopReason?: unknown } | null } | null;
  } | null;
  const current = report?.report?.control;
  return Object.freeze({
    outcome: typeof current?.outcome === "string" ? current.outcome : null,
    stopReason: typeof current?.stopReason === "string" ? current.stopReason : null,
  });
}

function safeRequestId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : `cli-value-flow-${Date.now().toString(36)}`;
}

function safeRunIdSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `run-${cleaned}`;
}

function deriveResult(
  goal: CliValueFlowGoal,
  response: unknown,
  finalState: ValueFlowState | null,
  logging: ValueFlowLoggingState,
): ValueFlowRunResult {
  const stop = control(response);
  const root = rootEvaluation(response);
  const budgetStopped = stop.outcome === "exceeded"
    && (stop.stopReason === "budget" || stop.stopReason === "too_many_attempts");
  let status: ValueFlowRunResult["status"];
  let resolution: string;
  if (budgetStopped) {
    status = "unknown";
    resolution = "budget_exhausted";
  } else if (finalState?.termination !== null && finalState?.termination !== undefined) {
    status = finalState.termination.status;
    resolution = finalState.termination.resolution;
  } else if (root.result === "satisfied") {
    status = "achieved";
    resolution = "complete";
  } else if (root.result === "unsatisfied") {
    status = "failed";
    resolution = "not_satisfied";
  } else {
    status = "unknown";
    resolution = "insufficient_evidence";
  }

  return Object.freeze({
    kind: "cli.programming.value_flow.result" as const,
    status,
    resolution,
    provenanceSemantics: "static_may_provenance" as const,
    scorerSource: "deterministic_baseline:VF-Baseline-0" as const,
    modelRef: null,
    logging,
    anchorSiteId: finalState?.anchorSiteId ?? null,
    sites: finalState?.sites ?? Object.freeze([]),
    edges: finalState?.edges ?? Object.freeze([]),
    unresolvedSites: finalState?.unresolvedSites ?? Object.freeze([]),
    runLogPath: logging.runLogPath,
    counters: finalState?.counters ?? Object.freeze({
      sandboxApiCalls: 0,
      searchCalls: 0,
      fileReadCalls: 0,
      candidateFilesRead: 0,
      searchMatchesSeen: 0,
      totalRelaxations: 0,
    }),
    finalState,
    continuation: response,
  });
}

function loggingFromInitError(error: unknown): UsageLogResult {
  const code = errorCode(error) ?? "LOG_WRITE_FAILED";
  return Object.freeze({
    enabled: true,
    state: "failed" as const,
    runLogPath: null,
    reason: code === "SANDBOX_ESCAPE" ? "LOG_ROOT_INSIDE_PROTECTED_REPO" : code,
  });
}

function normalizeLogging(logging: UsageLogResult): ValueFlowLoggingState {
  if (logging.state === "failed" && logging.reason === "SANDBOX_ESCAPE") {
    return Object.freeze({
      enabled: true,
      state: "failed" as const,
      runLogPath: logging.runLogPath,
      reason: "LOG_ROOT_INSIDE_PROTECTED_REPO" as const,
    });
  }
  return Object.freeze({
    enabled: logging.enabled,
    state: logging.state,
    runLogPath: logging.runLogPath,
    reason: logging.reason,
  });
}

function boundedResultReceipt(finalState: ValueFlowState | null): Readonly<Record<string, unknown>> {
  return Object.freeze({
    anchorSiteId: finalState?.anchorSiteId ?? null,
    siteCount: finalState?.sites.length ?? 0,
    edgeCount: finalState?.edges.length ?? 0,
    unresolvedSiteCount: finalState?.unresolvedSites.length ?? 0,
    searchMatchesSeen: finalState?.counters.searchMatchesSeen ?? 0,
    candidateFilesRead: finalState?.counters.candidateFilesRead ?? 0,
    streamedEventKinds: Object.freeze([
      "source_observed",
      "node_expanded",
      "relation_resolved",
      "relation_unknown",
    ]),
    scorerSource: "deterministic_baseline:VF-Baseline-0" as const,
    modelRef: null,
  });
}

function exitCodeForStatus(status: ValueFlowRunResult["status"]): number {
  return status === "achieved" ? 0 : status === "unknown" ? 2 : 1;
}

export async function runCliValueFlowGoal(
  rawRequest: unknown,
  resources: ValueFlowResources,
): Promise<ValueFlowRunResult> {
  const raw = isRecord(rawRequest) ? rawRequest : null;
  const goal = readCliValueFlowGoal(raw?.rootGoal ?? raw?.goal ?? rawRequest);
  const requestId = safeRequestId(raw?.requestId);
  const sessionSnapshot = resources.sandbox.getSession(resources.session);
  const state = buildInitialState(goal, sessionSnapshot, requestId);
  const loggingEnabled = resources.loggingEnabled !== false;
  const cliVersion = readCliVersion();

  let logRun: UsageLogRun | null = null;
  let initError: unknown = null;
  if (loggingEnabled) {
    const explicitPath = resources.runLogPath === undefined ? undefined : resolve(resources.runLogPath);
    let root: string;
    let runId: string;
    if (explicitPath !== undefined) {
      if (!explicitPath.endsWith(".jsonl")) {
        throw new TypeError("--run-log-path must end with .jsonl");
      }
      const base = basename(explicitPath);
      const name = base.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new TypeError("--run-log-path must use a safe run-id filename segment");
      }
      root = dirname(explicitPath);
      runId = name;
    } else if (resources.runLogDir !== undefined) {
      root = resolve(resources.runLogDir);
      runId = `${safeRunIdSegment(requestId)}-${Date.now().toString(36)}`;
    } else {
      root = join(tmpdir(), "nn-code-value-flow");
      runId = safeRunIdSegment(requestId);
    }
    try {
      logRun = createUsageLogRun({
        root,
        runId,
        protectedRoots: [resources.sandbox.scenarioRoot],
        pid: process.pid,
        owner: `nn-code:value-flow:${process.pid}`,
      });
      await logRun.start({
        request: Object.freeze({ repoRoot: resources.sandbox.scenarioRoot, ...goal }),
        cliVersion,
        semanticContractVersion: VALUE_FLOW_REQUEST_SCHEMA,
        modelRef: null,
      });
    } catch (error) {
      initError = error;
      logRun = null;
    }
  }

  const eventPromises: Promise<boolean>[] = [];
  const created = createValueFlowAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    ...(logRun === null
      ? {}
      : {
          emit: (kind, payload) => {
            if (isAllowedUsageLogKind(kind) && kind !== "start" && kind !== "finish") {
              const promise = logRun.event({ kind, body: payload });
              eventPromises.push(promise);
            }
          },
          reserveExcerptBytes: requested => logRun?.reserveExcerptBytes(requested)
            ?? Math.max(0, Math.min(requested, USAGE_LOG_UNKNOWN_EXCERPT_LIMIT)),
        }),
  });
  let response: unknown;
  try {
    response = await runRecursiveGoal(
      {
        schema: VALUE_FLOW_REQUEST_SCHEMA,
        requestId,
        rootGoal: goal,
        satisfactionThreshold: 100,
        rootBindings: Object.freeze({
          session: Object.freeze({
            kind: "cli.session" as const,
            scenarioId: resources.session.scenarioId,
            sessionId: resources.session.sessionId,
          }),
          scopePaths: goal.scopePaths,
        }),
        state,
        rootEvaluatorId: VALUE_FLOW_ROOT_EVALUATOR,
        rootSelectorId: VALUE_FLOW_ROOT_SELECTOR,
        ...(resources.limits === undefined ? {} : { limits: resources.limits }),
        ...(resources.continuation === undefined ? {} : { continuation: resources.continuation }),
      },
      createValueFlowDependencies(created, resources.signal),
    );
  } finally {
    created.disposeWorkingSet();
  }
  const finalState = created.getState() ?? latestState(response);
  const provisionalLogging = logRun === null
    ? (initError === null ? disabledUsageLog() : loggingFromInitError(initError))
    : normalizeLogging(logRun.status());
  const result = deriveResult(goal, response, finalState, provisionalLogging);

  if (logRun !== null) {
    // Await every streamed event before the finish line so the file stays in
    // append order (source_observed/node_expanded/relation_resolved/
    // relation_unknown then finish) and none is dropped by a racing write.
    try {
      await Promise.all(eventPromises);
    } catch {
      // A single failed event append is surfaced through logRun.status(); the
      // remaining events and the finish line still proceed best-effort.
    }
    // A normal run streams its facts already through the adapter `emit`
    // callback; the finish line carries only bounded counts and references
    // (never full sites/edges/unresolvedSites/searchMatches arrays). `modelRef`
    // is null in this entry, so no neural `decision` or legacy `baseline_rank`
    // event is ever emitted. Logging failure never changes the query outcome.
    try {
      await logRun.finish({
        outcome: Object.freeze({
          stage: "completed" as const,
          exitCode: exitCodeForStatus(result.status),
          status: result.status,
          resolution: result.resolution,
          anchorSiteId: result.anchorSiteId,
        }),
        coverage: finalState === null ? null : Object.freeze({ ...finalState.counters }),
        resultReceipt: boundedResultReceipt(finalState),
        error: null,
      });
    } catch (error) {
      // Persistence failure is recorded by logRun.status(); the query result,
      // resolution and exit code remain unchanged.
      void error;
    }
  }

  const logging = logRun === null
    ? provisionalLogging
    : normalizeLogging(logRun.status());
  return Object.freeze({ ...result, logging, runLogPath: logging.runLogPath });
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function parseInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new TypeError(`${flag} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${flag} is out of range`);
  return number;
}

function defaultScope(anchorFile: string): string {
  const directory = posix.dirname(anchorFile);
  return directory === "." ? "." : directory;
}

export function parseCliValueFlowArgs(argv: readonly string[]): CliValueFlowCliOptions {
  let root = process.cwd();
  let explicitRoot: string | null = null;
  let requestId: string | undefined;
  let logDir: string | undefined;
  let runLogPath: string | undefined;
  let noLog = false;
  let anchorFile: string | undefined;
  let anchorSymbol: string | undefined;
  let anchorLexicalPath: string | undefined;
  let anchorLine: number | undefined;
  let anchorColumn: number | undefined;
  let direction: "origin" | "sink" = "origin";
  let maxDepth: CliValueFlowMaxDepth = 3;
  let resultMode: CliValueFlowResultMode = "all";
  let maxCandidateFileReads: number | undefined;
  const scopePaths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo" || argument === "--root") {
      // `--repo` is the documented primary argument; `--root` stays as an alias.
      const value = resolve(requireValue(argv, index, argument));
      if (explicitRoot !== null && explicitRoot !== value) {
        throw new TypeError("--repo and --root must not disagree");
      }
      explicitRoot = value;
      root = value;
      index += 1;
    } else if (argument === "--request-id") {
      requestId = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--log-dir") {
      logDir = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--run-log-path") {
      runLogPath = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--no-log") {
      noLog = true;
    } else if (argument === "--anchor-file") {
      anchorFile = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--anchor-symbol") {
      anchorSymbol = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--anchor-lexical-path") {
      anchorLexicalPath = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--anchor-line") {
      anchorLine = parseInteger(requireValue(argv, index, argument), argument);
      index += 1;
    } else if (argument === "--anchor-column") {
      anchorColumn = parseInteger(requireValue(argv, index, argument), argument);
      index += 1;
    } else if (argument === "--direction") {
      const value = requireValue(argv, index, argument);
      if (value !== "origin" && value !== "sink") throw new TypeError("--direction must be origin or sink");
      direction = value;
      index += 1;
    } else if (argument === "--max-depth") {
      const value = parseInteger(requireValue(argv, index, argument), argument);
      if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
        throw new TypeError("--max-depth must be 0, 1, 2, or 3");
      }
      maxDepth = value;
      index += 1;
    } else if (argument === "--scope") {
      const value = requireValue(argv, index, argument);
      scopePaths.push(...value.split(",").map(entry => entry.trim()).filter(Boolean));
      index += 1;
    } else if (argument === "--result-mode") {
      const value = requireValue(argv, index, argument);
      if (value !== "all" && value !== "one") throw new TypeError("--result-mode must be all or one");
      resultMode = value;
      index += 1;
    } else if (argument === "--max-candidate-file-reads") {
      maxCandidateFileReads = parseInteger(requireValue(argv, index, argument), argument);
      if (maxCandidateFileReads < 1) throw new TypeError("--max-candidate-file-reads must be positive");
      index += 1;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (anchorFile === undefined) throw new TypeError("--anchor-file is required");
  if (anchorSymbol === undefined) throw new TypeError("--anchor-symbol is required");
  if (noLog && (logDir !== undefined || runLogPath !== undefined)) {
    throw new TypeError("--no-log cannot be combined with --log-dir or --run-log-path");
  }
  if (logDir !== undefined && runLogPath !== undefined) {
    throw new TypeError("--log-dir and --run-log-path are mutually exclusive");
  }
  if (runLogPath !== undefined) {
    const resolved = resolve(runLogPath);
    const base = basename(resolved);
    if (!base.endsWith(".jsonl")) {
      throw new TypeError("--run-log-path must end with .jsonl");
    }
    const name = base.slice(0, -".jsonl".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new TypeError("--run-log-path must use a safe run-id filename segment");
    }
  }
  const scopes = scopePaths.length > 0 ? Object.freeze(scopePaths) : Object.freeze([defaultScope(anchorFile)]);
  const goal = readCliValueFlowGoal({
    kind: "cli.programming.value_flow",
    anchorFile,
    anchorSymbol,
    ...(anchorLexicalPath === undefined ? {} : { anchorLexicalPath }),
    ...(anchorLine === undefined ? {} : { anchorLine }),
    ...(anchorColumn === undefined ? {} : { anchorColumn }),
    direction,
    maxDepth,
    scopePaths: scopes,
    resultMode,
    ...(maxCandidateFileReads === undefined ? {} : { maxCandidateFileReads }),
    satisfactionThreshold: 1,
  });
  return Object.freeze({
    root: resolve(root),
    goal,
    ...(requestId === undefined ? {} : { requestId }),
    ...(logDir === undefined ? {} : { logDir }),
    ...(runLogPath === undefined ? {} : { runLogPath }),
    ...(noLog ? { loggingEnabled: false } : {}),
  });
}

export async function runCliValueFlowCli(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write([
      "Usage: cli-value-flow --repo <path> --anchor-file <path> --anchor-symbol <name> [options]",
      "",
      "--repo <path>                 repository root (primary)",
      "--root <path>                 alias for --repo",
      "--anchor-file <path>          file containing the anchor",
      "--anchor-symbol <name>        symbol or parameter to trace",
      "--anchor-lexical-path <path>  lexical function path",
      "--anchor-line <number>        1-based anchor line",
      "--anchor-column <number>      1-based anchor column",
      "--direction <origin|sink>     value-flow direction",
      "--max-depth <0|1|2|3>         traversal depth",
      "--scope <path[,path]>         in-scope directories",
      "--result-mode <all|one>       all paths or first path",
      "--max-candidate-file-reads <n> explicit candidate read budget",
      "--log-dir <dir>               per-run log directory outside --repo",
      "--run-log-path <file.jsonl>   explicit per-run JSONL run log path",
      "--no-log                      disable all persistence for this run",
      "",
    ].join("\n"));
    return 0;
  }
  try {
    const options = parseCliValueFlowArgs(argv);
    const sandbox = await createReadOnlyCliFilesystemSandbox({
      root: options.root,
      scenarioId: DEFAULT_READ_ONLY_SCENARIO_ID,
      sessionId: DEFAULT_READ_ONLY_SESSION_ID,
      allowReadOnlySearch: true,
    });
    try {
      const session = sandbox.bindSession(DEFAULT_READ_ONLY_SESSION_ID);
      const result = await runCliValueFlowGoal({
        requestId: options.requestId ?? `cli-value-flow-${Date.now().toString(36)}`,
        rootGoal: options.goal,
      }, {
        sandbox,
        session,
        ...(options.logDir === undefined ? {} : { runLogDir: options.logDir }),
        ...(options.runLogPath === undefined ? {} : { runLogPath: options.runLogPath }),
        ...(options.loggingEnabled === false ? { loggingEnabled: false } : {}),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === "achieved" ? 0 : result.status === "unknown" ? 2 : 1;
    } finally {
      await sandbox.cleanup();
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "rejected",
      resolution: "invalid_request_or_execution_error",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCliValueFlowCli(process.argv.slice(2));
}
