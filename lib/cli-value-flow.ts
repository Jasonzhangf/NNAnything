// `nn-code value-flow` public entry. The reusable API and the direct
// `dist/cli-value-flow.js` executable share the same recursive-goal path.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  runLogPath?: string;
  loggingEnabled?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function deriveResult(
  goal: CliValueFlowGoal,
  response: unknown,
  finalState: ValueFlowState | null,
  runLogPath: string | null,
  logging: ValueFlowRunResult["logging"],
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
    runLogPath,
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

type RunLogEvent = Readonly<Record<string, unknown>>;

function runLogEvent(
  runId: string,
  seq: number,
  kind: string,
  startedAt: number,
  extra: Readonly<Record<string, unknown>> = Object.freeze({}),
): RunLogEvent {
  return Object.freeze({
    ...extra,
    schema: "nnanything.cli-value-flow.run-log.v1" as const,
    runId,
    seq,
    kind,
    observedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  });
}

async function appendRunLogLines(path: string, lines: readonly string[]): Promise<void> {
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

function errorReason(prefix: string, error: unknown): string {
  return `${prefix}:${error instanceof Error ? error.message : String(error)}`;
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
  const startedAt = Date.now();
  const runLogDir = resources.runLogDir === undefined
    ? join(tmpdir(), "nn-code-value-flow")
    : resolve(resources.runLogDir);
  const defaultRunLogPath = join(runLogDir, `${requestId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  const runLogPath = resources.runLogPath === undefined
    ? defaultRunLogPath
    : resolve(resources.runLogPath);
  const loggingEnabled = resources.loggingEnabled !== false;
  let seq = 0;
  let logging: ValueFlowLoggingState;
  let logPath: string | null = null;
  // Incremental JSONL observation stream. The adapter's `emit` callback is
  // attached only when a log file is live; each emitted event is written as a
  // single line and never buffered across the whole run, so no full state or
  // source text is ever retained for a later one-shot serialization.
  const pendingLogLines: string[] = [];
  let logWriteChain: Promise<void> = Promise.resolve();
  function enqueueRunLogEvent(kind: string, payload: Readonly<Record<string, unknown>>): void {
    if (logPath === null || logging.state === "failed") return;
    const line = JSON.stringify(runLogEvent(requestId, seq, kind, startedAt, payload));
    seq += 1;
    pendingLogLines.push(line);
    logWriteChain = logWriteChain.then(async () => {
      const batch = pendingLogLines.splice(0, pendingLogLines.length);
      if (batch.length === 0) return;
      try {
        await appendRunLogLines(logPath as string, batch);
      } catch (error) {
        logging = Object.freeze({
          enabled: true,
          state: "partial" as const,
          runLogPath: logPath,
          reason: errorReason("log_event_failed", error),
        });
      }
    });
  }
  if (!loggingEnabled) {
    // `--no-log` closes before any mkdir or byte write. The query still runs
    // and returns its in-memory result; only persistence is disabled.
    logging = Object.freeze({
      enabled: false,
      state: "disabled" as const,
      runLogPath: null,
      reason: "disabled_by_no_log",
    });
  } else {
    try {
      await mkdir(dirname(runLogPath), { recursive: true });
      await writeFile(runLogPath, `${JSON.stringify(runLogEvent(requestId, seq, "start", startedAt, {
        request: Object.freeze({ ...goal, requestId }),
        cliContract: "nnanything.cli-value-flow.run-log.v1" as const,
        modelRef: null,
      }))}\n`, "utf8");
      seq += 1;
      logPath = runLogPath;
      logging = Object.freeze({
        enabled: true,
        state: "partial" as const,
        runLogPath: logPath,
        reason: null,
      });
    } catch (error) {
      logging = Object.freeze({
        enabled: true,
        state: "failed" as const,
        runLogPath: null,
        reason: errorReason("log_start_failed", error),
      });
    }
  }
  const created = createValueFlowAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    ...(logPath === null ? {} : { emit: enqueueRunLogEvent }),
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
  const result = deriveResult(goal, response, finalState, logPath, logging);
  if (logging.enabled && logging.state !== "failed" && logPath !== null) {
    // A normal run appends the deterministic baseline ranking and the finish
    // receipt. `modelRef` is null in this entry, so only `baseline_rank`
    // events are emitted; no neural `decision` event or fabricated
    // probabilities ever appear. `sourceText` is never written.
    try {
      await logWriteChain;
      const lines: string[] = [];
      for (const match of finalState?.searchMatches ?? []) {
        lines.push(JSON.stringify(runLogEvent(requestId, seq, "baseline_rank", startedAt, {
          relPath: match.relPath,
          line: match.line,
          column: match.column,
          priorityTier: match.priorityTier,
          scorerSource: match.scorerSource,
          modelRef: match.modelRef,
        })));
        seq += 1;
      }
      lines.push(JSON.stringify(runLogEvent(requestId, seq, "finish", startedAt, {
        status: result.status,
        resolution: result.resolution,
        nodes: (finalState?.sites ?? []).length,
        edges: (finalState?.edges ?? []).length,
        unresolved: (finalState?.unresolvedSites ?? []).length,
        anchorSiteId: result.anchorSiteId,
        modelRef: null,
      })));
      seq += 1;
      await appendRunLogLines(logPath, lines);
      logging = Object.freeze({
        enabled: true,
        state: "complete" as const,
        runLogPath: logPath,
        reason: null,
      });
    } catch (error) {
      logging = Object.freeze({
        enabled: true,
        state: "partial" as const,
        runLogPath: logPath,
        reason: errorReason("log_finish_failed", error),
      });
    }
  }
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
  if (noLog && runLogPath !== undefined) {
    throw new TypeError("--no-log conflicts with --run-log-path");
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
      "--run-log-path <path>         explicit incremental JSONL run log path",
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

