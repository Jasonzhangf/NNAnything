#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SESSION_ID,
  runCliCalleeCallGraphGoal,
  type CallDepthRunResult,
  type CliCalleeCallGraphGoal,
} from "./cli-call-depth.js";

const CLI_NAME = "nn-code";
const CALLS_SUBCOMMAND = "calls";
const DEFAULT_REQUEST_ID = "nn-code-calls-live";
const VALID_MAX_DEPTHS = Object.freeze([0, 1, 2, 3] as const);
const SUPPORTED_DIRECTION = "callee";
const DEFAULT_LOG_SUBPATH = ".local/state/nn-code/runs";
const LOG_DIR_ENV_NAME = "NN_CODE_LOG_DIR";
const SKILL_ENTRY_PATH = "~/.agents/skills/nn-code/SKILL.md";
const EXIT_CODES = Object.freeze({ achieved: 0, error: 1, unmet: 2, unknown: 3, rejected: 4, failed: 5 } as const);

type CliStage = "args" | "init" | "execute" | "cleanup";

type ParsedArgs = {
  subcommand: "calls";
  repo: string;
  entryFile: string;
  entrySymbol: string;
  entryLexicalPath: string | null;
  maxDepth: number;
  scopePaths: readonly string[];
  requestId: string;
  diagnosticsFile: string | null;
  logDir: string | null;
  compact: boolean;
};

type ParseResult = {
  help: boolean;
  error?: Error;
  value?: ParsedArgs;
};

type LogWriteError = Readonly<{
  stage: "log_write";
  name: string;
  message: string;
  code: string | null;
  path: string | null;
}>;

type RunEcho = Readonly<{
  cliVersion: string | null;
  runId: string | null;
  runLogPath: string | null;
  logWriteError: LogWriteError | null;
}>;

function readPackageVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`Invalid package.json version at ${pkgPath}`);
  }
  return parsed.version.trim();
}

function buildUsageText(cliVersion: string): string {
  const maxDepthUsage = VALID_MAX_DEPTHS.join("|");
  return [
    `${CLI_NAME} v${cliVersion} - Deterministic read-only code relation CLI`,
    "",
    "Usage:",
    `  ${CLI_NAME} ${CALLS_SUBCOMMAND} --repo <path> --entry-file <repoRelativePath> --entry-symbol <symbol> --max-depth <${maxDepthUsage}> --scope <prefix> [options]`,
    "",
    `Required arguments (${CLI_NAME} ${CALLS_SUBCOMMAND}):`,
    "  --repo <path>                         Target repository root path (opened strictly read-only)",
    "  --entry-file <repoRelativePath>       Entry source file relative to --repo (e.g. lib/cli-call-depth.ts)",
    '  --entry-symbol <symbol>               Callable symbol name in --entry-file (or "default")',
    `  --max-depth <${maxDepthUsage}>                 Callee expansion depth:`,
    "                                          0 = locate entry declaration span only (bodyExtracted: false)",
    "                                          1..3 = expand direct static callees up to maxDepth hops",
    "  --scope <prefix>                      In-scope repo-relative path prefix (repeatable or comma-separated,",
    '                                          matches relPath === prefix || relPath.startsWith(prefix + "/"))',
    "",
    "Optional arguments:",
    "  --entry-lexical-path <chain>          Dot-separated lexical chain for nested functions (e.g. declarationsOf.walk)",
    `  --request-id <id>                     Request identifier (default: ${DEFAULT_REQUEST_ID})`,
    "  --log-dir <dir>                       Directory for per-run logs outside --repo",
    `                                          (env: ${LOG_DIR_ENV_NAME}; default: ~/${DEFAULT_LOG_SUBPATH})`,
    "  --diagnostics-file <path>             Write opt-in deep diagnostics (finalState + response) outside --repo",
    "  --compact                             Emit single-line JSON on stdout",
    "  --help, -h                            Show this help and exit 0",
    "",
    "Direction, Depth & Expected Unresolved Boundaries (Not Bugs):",
    '  - Direction is fixed to "callee" (who is called by the entry function and its transitive callees).',
    '  - Nodes at minDepth === requestedMaxDepth have bodyExtracted: false by contract (status is still "achieved").',
    '  - "truncated: true" only occurs when a source file exceeds 1 MiB (1048576 bytes), never for normal maxDepth cutoff.',
    "  - Expected unresolvedCallsites[] categories (normal static boundaries, not tool bugs):",
    '      * kind: "unresolved_dynamic"',
    "          - UNRESOLVED_CALLEE_EXPRESSION: chained/computed callee such as a().b()",
    "          - LEXICAL_PARAM_OR_VARIABLE_CALL: call on a parameter, local non-function variable, or object method (obj.method())",
    '          - NAMESPACE_MEMBER_ACCESS: call on namespace import (import * as ts from "typescript"; ts.isIdentifier(...))',
    '      * kind: "out_of_scope_external"',
    '          - EXTERNAL_MODULE_SPECIFIER: bare package ("node:fs") or relative import outside --scope',
    "          - UNSHADOWED_BUILTIN_GLOBAL: unshadowed ECMAScript/Node global (Object.freeze, Math.max, Buffer.from, etc.)",
    '      * kind: "unresolved_missing_or_ambiguous_target": missing file/export, type-only import, or conflicting export *',
    "",
    "Exit Codes (Non-zero 2/3/4/5 are valid structured semantic outcomes on stdout, NOT crashes):",
    '  0  status === "achieved"  Complete callee call graph within --max-depth and --scope (stdout JSON)',
    '  2  status === "unmet"     Entry file/symbol not found or ambiguous_entry_symbol (stdout JSON)',
    '  3  status === "unknown"   Insufficient evidence: >1 MiB file truncated or concurrent file edit detected (stdout JSON)',
    '  4  status === "rejected"  Request rejected: e.g. --entry-file outside --scope or sandbox escape (stdout JSON)',
    '  5  status === "failed"    Workflow execution failed (stdout JSON)',
    '  1  CLI usage/init/runtime/cleanup error (structured {"error":{...}} on stderr)',
    "",
    "Run Logs & Dedicated Agent Skill:",
    `  - Per-run log location: ~/${DEFAULT_LOG_SUBPATH}/<timestamp>-<pid>-<id>.json`,
    '    (Every stdout/stderr JSON response includes "runLogPath" pointing to the saved run log.)',
    `  - Agent usage & bug-reporting Skill: ${SKILL_ENTRY_PATH}`,
    "",
    "Examples:",
    "  # 1. Inspect depth-1 callees of runCliCalleeCallGraphGoal from any working directory (e.g. /tmp):",
    "  nn-code calls --repo /Volumes/extension/code/NNAnything \\",
    "    --entry-file lib/cli-call-depth.ts \\",
    "    --entry-symbol runCliCalleeCallGraphGoal \\",
    "    --max-depth 1 --scope lib --request-id demo-d1",
    "",
    "  # 2. Query a nested local function (declarationsOf.walk) at depth 1 with compact JSON:",
    "  nn-code calls --repo /Volumes/extension/code/NNAnything \\",
    "    --entry-file lib/filters/cli-call-depth-policy.ts \\",
    "    --entry-symbol walk --entry-lexical-path declarationsOf.walk \\",
    "    --max-depth 1 --scope lib --compact",
  ].join("\n");
}

function extractOptionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === name) {
      const value = argv[index + 1];
      if (value !== undefined) {
        values.push(value);
        index += 1;
      }
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

function parseArgs(argv: readonly string[]): ParseResult {
  let help = false;
  let repo: string | null = null;
  let repoCount = 0;
  let entryFile: string | null = null;
  let entrySymbol: string | null = null;
  let entryLexicalPath: string | null = null;
  let maxDepth: number | null = null;
  let requestId: string | null = null;
  let diagnosticsFile: string | null = null;
  let logDir: string | null = null;
  let compact = false;
  const scopes: string[] = [];

  const normalized = argv[0] === CALLS_SUBCOMMAND || argv[0] === "call-depth" ? argv.slice(1) : argv;

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--compact") {
      compact = true;
      continue;
    }
    const valueArg = arg === "--scope"
      ? "scope"
      : arg === "--repo"
        ? "repo"
        : arg === "--entry-file"
          ? "entryFile"
          : arg === "--entry-symbol"
            ? "entrySymbol"
            : arg === "--entry-lexical-path"
              ? "entryLexicalPath"
              : arg === "--max-depth"
                ? "maxDepth"
                : arg === "--request-id"
                  ? "requestId"
                  : arg === "--diagnostics-file"
                    ? "diagnosticsFile"
                    : arg === "--log-dir"
                      ? "logDir"
                      : null;
    if (valueArg === null) {
      return { help, error: new TypeError(`unknown argument: ${arg}`) };
    }
    const value = normalized[index + 1];
    if (value === undefined) {
      return { help, error: new TypeError(`missing value for ${arg}`) };
    }
    index += 1;
    if (valueArg === "scope") {
      scopes.push(value);
    } else if (valueArg === "repo") {
      repo = value;
      repoCount += 1;
    } else if (valueArg === "entryFile") {
      entryFile = value;
    } else if (valueArg === "entrySymbol") {
      entrySymbol = value;
    } else if (valueArg === "entryLexicalPath") {
      entryLexicalPath = value;
    } else if (valueArg === "maxDepth") {
      if (!/^-?\d+$/.test(value)) {
        return { help, error: new TypeError("--max-depth must be an integer") };
      }
      maxDepth = Number(value);
    } else if (valueArg === "requestId") {
      requestId = value;
    } else if (valueArg === "diagnosticsFile") {
      diagnosticsFile = value;
    } else if (valueArg === "logDir") {
      logDir = value;
    }
  }

  if (help) return { help };
  if (repoCount > 1) return { help, error: new TypeError("duplicate --repo argument is not allowed") };
  if (repo === null || repo.length === 0) return { help, error: new TypeError("--repo is required") };
  if (entryFile === null || entryFile.length === 0) return { help, error: new TypeError("--entry-file is required") };
  if (entrySymbol === null || entrySymbol.length === 0) return { help, error: new TypeError("--entry-symbol is required") };
  if (entryLexicalPath !== null && entryLexicalPath.length === 0) {
    return { help, error: new TypeError("--entry-lexical-path must not be empty") };
  }
  if (maxDepth === null) return { help, error: new TypeError("--max-depth is required") };
  if (requestId !== null && requestId.length === 0) return { help, error: new TypeError("--request-id must not be empty") };
  if (diagnosticsFile !== null && diagnosticsFile.length === 0) {
    return { help, error: new TypeError("--diagnostics-file must not be empty") };
  }
  if (logDir !== null && logDir.length === 0) {
    return { help, error: new TypeError("--log-dir must not be empty") };
  }

  const scopePaths = scopes
    .flatMap(scope => scope.split(","))
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0);
  if (scopePaths.length === 0) return { help, error: new TypeError("--scope is required") };

  return {
    help,
    value: {
      subcommand: CALLS_SUBCOMMAND,
      repo,
      entryFile,
      entrySymbol,
      entryLexicalPath,
      maxDepth,
      scopePaths: Object.freeze(scopePaths),
      requestId: requestId ?? DEFAULT_REQUEST_ID,
      diagnosticsFile,
      logDir,
      compact,
    },
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function errorCode(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code && code !== "undefined") return code;
  }
  return null;
}

function errorFact(stage: CliStage, error: unknown): Readonly<{
  stage: CliStage;
  name: string;
  message: string;
  code: string | null;
  syscall: string | null;
  path: string | null;
}> {
  const err = error instanceof Error ? error : new Error(String(error));
  const record = err as Error & { code?: unknown; syscall?: unknown; path?: unknown };
  return Object.freeze({
    stage,
    name: err.name,
    message: err.message,
    code: typeof record.code === "string" ? record.code : null,
    syscall: typeof record.syscall === "string" ? record.syscall : null,
    path: typeof record.path === "string" ? record.path : null,
  });
}

async function resolveThroughNearestExistingAncestor(candidatePath: string): Promise<string> {
  const absoluteCandidate = resolve(process.cwd(), candidatePath);
  let current = absoluteCandidate;
  while (true) {
    try {
      const physicalAncestor = await realpath(current);
      const suffix = relative(current, absoluteCandidate);
      return suffix.length === 0 ? physicalAncestor : resolve(physicalAncestor, suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Unable to resolve physical ancestor for path: ${candidatePath}`);
      }
      current = parent;
    }
  }
}

function resolveRunLogDir(argLogDir: string | null): string {
  if (argLogDir !== null && argLogDir.length > 0) {
    return resolve(process.cwd(), argLogDir);
  }
  const envLogDir = process.env[LOG_DIR_ENV_NAME];
  if (typeof envLogDir === "string" && envLogDir.length > 0) {
    return resolve(process.cwd(), envLogDir);
  }
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (typeof xdgStateHome === "string" && xdgStateHome.length > 0 && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, "nn-code", "runs");
  }
  return join(homedir(), DEFAULT_LOG_SUBPATH);
}

async function validateDiagnosticsPath(repoRoot: string, rawPath: string): Promise<void> {
  const physicalTarget = await resolveThroughNearestExistingAncestor(rawPath);
  if (isWithin(repoRoot, physicalTarget)) {
    throw new TypeError("diagnostics file must not be written inside the target repository");
  }
}

async function writeDiagnostics(
  rawPath: string,
  diagnostics: Readonly<{ finalState: unknown; response: unknown }>,
): Promise<void> {
  const target = resolve(process.cwd(), rawPath);
  await writeFile(target, JSON.stringify(diagnostics, null, 2));
}

function projectNodes(nodes: CallDepthRunResult["nodes"]): unknown[] {
  return nodes.map(node => ({
    nodeId: node.nodeId,
    filePath: node.filePath,
    symbolName: node.symbolName,
    lexicalScopeChain: node.lexicalScopeChain,
    minDepth: node.minDepth,
    bodyExtracted: node.bodyExtracted,
    declSpan: node.declSpan,
  }));
}

function projectResult(
  result: CallDepthRunResult,
  repoRoot: string,
  requestId: string,
  scopePaths: readonly string[],
): unknown {
  return {
    repoRoot,
    requestId,
    scopePaths,
    status: result.status,
    resolution: result.resolution,
    entryNodeId: result.entryNodeId,
    requestedMaxDepth: result.requestedMaxDepth,
    achievedDepth: result.achievedDepth,
    entryResolution: result.finalState?.entryResolution ?? null,
    truncated: result.finalState?.truncated ?? false,
    sourceConsistencyFailed: result.finalState?.sourceConsistencyFailed ?? false,
    missingFiles: result.finalState?.missingFiles ?? [],
    nodes: projectNodes(result.nodes),
    edges: result.edges,
    unresolvedCallsites: result.unresolvedCallsites,
    counters: result.counters,
  };
}

function completedOutcome(result: CallDepthRunResult, exitCode: number): unknown {
  return {
    stage: "completed",
    exitCode,
    status: result.status,
    resolution: result.resolution,
    entryNodeId: result.entryNodeId,
    entryResolution: result.finalState?.entryResolution ?? null,
    requestedMaxDepth: result.requestedMaxDepth,
    achievedDepth: result.achievedDepth,
    truncated: result.finalState?.truncated ?? false,
    sourceConsistencyFailed: result.finalState?.sourceConsistencyFailed ?? false,
    missingFiles: result.finalState?.missingFiles ?? [],
  };
}

function summarize(result: CallDepthRunResult): unknown {
  return {
    nodesCount: result.nodes.length,
    edgesCount: result.edges.length,
    unresolvedCount: result.unresolvedCallsites.length,
    counters: result.counters,
  };
}

function resultReceipt(result: CallDepthRunResult): unknown {
  return {
    nodes: projectNodes(result.nodes),
    edges: result.edges,
    unresolvedCallsites: result.unresolvedCallsites,
  };
}

function sanitizedArgv(args: ParsedArgs | null): Record<string, unknown> {
  if (args === null) {
    return {
      subcommand: CALLS_SUBCOMMAND,
      repo: null,
      entryFile: null,
      entrySymbol: null,
      entryLexicalPath: null,
      maxDepth: null,
      scopePaths: null,
      requestId: null,
      diagnosticsFile: null,
      logDir: null,
      compact: false,
    };
  }
  return {
    subcommand: args.subcommand,
    repo: args.repo,
    entryFile: args.entryFile,
    entrySymbol: args.entrySymbol,
    entryLexicalPath: args.entryLexicalPath,
    maxDepth: args.maxDepth,
    scopePaths: args.scopePaths,
    requestId: args.requestId,
    diagnosticsFile: args.diagnosticsFile,
    logDir: args.logDir,
    compact: args.compact,
  };
}

function buildRunLog(input: Readonly<{
  cliVersion: string;
  runId: string;
  startedAt: string;
  startedAtMs: number;
  subcommand: string;
  cwd: string;
  sanitizedArgv: Record<string, unknown>;
  repoRoot: string | null;
  diagnosticsFilePath: string | null;
  outcome: unknown;
  summary: unknown | null;
  resultReceipt: unknown | null;
  error: unknown | null;
}>): unknown {
  const finishedAtMs = Date.now();
  return {
    schema: "nnanything.nn-code.run-log.v1",
    subcommand: input.subcommand,
    cliVersion: input.cliVersion,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - input.startedAtMs,
    cwd: input.cwd,
    sanitizedArgv: input.sanitizedArgv,
    repoRoot: input.repoRoot,
    diagnosticsFilePath: input.diagnosticsFilePath,
    outcome: input.outcome,
    summary: input.summary,
    resultReceipt: input.resultReceipt,
    error: input.error,
  };
}

async function writeRunLog(params: Readonly<{
  logDir: string;
  runId: string;
  runLog: unknown;
  protectedRepoRoots: readonly string[];
  protectionFailure: unknown;
}>): Promise<{ runLogPath: string | null; logWriteError: LogWriteError | null }> {
  const candidateLogPath = join(params.logDir, `${params.runId}.json`);
  try {
    if (params.protectionFailure !== null) {
      throw params.protectionFailure;
    }
    const physicalLogDir = await resolveThroughNearestExistingAncestor(params.logDir);
    for (const repoRoot of params.protectedRepoRoots) {
      if (isWithin(repoRoot, physicalLogDir)) {
        throw Object.assign(new Error("Log directory must be outside target repository"), { code: "SANDBOX_ESCAPE" });
      }
    }
    await mkdir(params.logDir, { recursive: true });
    await writeFile(candidateLogPath, JSON.stringify(params.runLog, null, 2));
    return { runLogPath: candidateLogPath, logWriteError: null };
  } catch (error) {
    const record = error as { code?: unknown };
    return {
      runLogPath: null,
      logWriteError: Object.freeze({
        stage: "log_write" as const,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        code: typeof record.code === "string" ? record.code : null,
        path: candidateLogPath,
      }),
    };
  }
}

function exitCodeForStatus(status: CallDepthRunResult["status"]): number {
  switch (status) {
    case "achieved": return EXIT_CODES.achieved;
    case "unmet": return EXIT_CODES.unmet;
    case "unknown": return EXIT_CODES.unknown;
    case "rejected": return EXIT_CODES.rejected;
    case "failed": return EXIT_CODES.failed;
    default: return EXIT_CODES.error;
  }
}

function warnLogWrite(logWriteError: LogWriteError): void {
  process.stderr.write(`${JSON.stringify({ warning: logWriteError })}\n`);
}

function reportError(stage: CliStage, error: unknown, echo: RunEcho): void {
  const fact = errorFact(stage, error);
  const errorPayload: Record<string, unknown> = {
    stage: fact.stage,
    name: fact.name,
    message: fact.message,
    code: fact.code,
    syscall: fact.syscall,
    path: fact.path,
    cliVersion: echo.cliVersion,
    runId: echo.runId,
    runLogPath: echo.runLogPath,
  };
  if (echo.logWriteError !== null) {
    errorPayload.logWriteError = echo.logWriteError;
  }
  process.stderr.write(`${JSON.stringify({ error: errorPayload })}\n`);
  process.exitCode = EXIT_CODES.error;
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = `${startedAt.replace(/[-:.]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;

  let cliVersion: string;
  try {
    cliVersion = readPackageVersion();
  } catch (error) {
    reportError("init", error, { cliVersion: null, runId, runLogPath: null, logWriteError: null });
    return;
  }

  const rawArgv = process.argv.slice(2);
  const rawRepos = extractOptionValues(rawArgv, "--repo");
  const rawLogDirValues = extractOptionValues(rawArgv, "--log-dir");
  const rawLogDir = rawLogDirValues.length > 0 ? rawLogDirValues[rawLogDirValues.length - 1] ?? null : null;

  let parsedValue: ParsedArgs | null = null;
  let logDir: string;
  try {
    logDir = resolveRunLogDir(rawLogDir);
  } catch (error) {
    reportError("args", error, { cliVersion, runId, runLogPath: null, logWriteError: null });
    return;
  }

  const protectedRepoRoots: string[] = [];
  let protectionFailure: unknown = null;
  const repoCandidates = rawRepos.length > 0 ? rawRepos : [process.cwd()];
  for (const candidate of repoCandidates) {
    try {
      protectedRepoRoots.push(await resolveThroughNearestExistingAncestor(candidate));
    } catch (error) {
      protectionFailure = error;
      break;
    }
  }

  const finalizeError = async (
    stage: CliStage,
    error: unknown,
    repoRoot: string | null,
    diagnosticsFilePath: string | null,
  ): Promise<void> => {
    const fact = errorFact(stage, error);
    const runLog = buildRunLog({
      cliVersion,
      runId,
      startedAt,
      startedAtMs,
      subcommand: CALLS_SUBCOMMAND,
      cwd: process.cwd(),
      sanitizedArgv: sanitizedArgv(parsedValue),
      repoRoot,
      diagnosticsFilePath,
      outcome: { stage: fact.stage, exitCode: EXIT_CODES.error },
      summary: null,
      resultReceipt: null,
      error: fact,
    });
    const { runLogPath, logWriteError } = await writeRunLog({
      logDir,
      runId,
      runLog,
      protectedRepoRoots,
      protectionFailure,
    });
    if (logWriteError !== null) {
      warnLogWrite(logWriteError);
    }
    reportError(stage, error, { cliVersion, runId, runLogPath, logWriteError });
  };

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rawArgv);
  } catch (error) {
    await finalizeError("args", error, null, null);
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${buildUsageText(cliVersion)}\n`);
    process.exitCode = EXIT_CODES.achieved;
    return;
  }
  if (parsed.error !== undefined) {
    await finalizeError("args", parsed.error, null, null);
    return;
  }
  if (parsed.value === undefined) {
    await finalizeError("args", new TypeError("invalid arguments"), null, null);
    return;
  }

  parsedValue = parsed.value;
  const args = parsed.value;
  logDir = resolveRunLogDir(args.logDir);

  const repoRoot = resolve(process.cwd(), args.repo);
  let sandbox;
  try {
    sandbox = await createReadOnlyCliFilesystemSandbox({
      root: repoRoot,
      sessionId: DEFAULT_READ_ONLY_SESSION_ID,
    });
  } catch (error) {
    await finalizeError("init", error, null, null);
    return;
  }

  protectedRepoRoots.push(sandbox.scenarioRoot);

  if (args.diagnosticsFile !== null) {
    try {
      await validateDiagnosticsPath(sandbox.scenarioRoot, args.diagnosticsFile);
    } catch (error) {
      try {
        await sandbox.cleanup();
      } catch (cleanupError) {
        await finalizeError("cleanup", cleanupError, sandbox.scenarioRoot, null);
        return;
      }
      await finalizeError("args", error, sandbox.scenarioRoot, null);
      return;
    }
  }

  const rootGoal: CliCalleeCallGraphGoal = {
    kind: "cli.programming.callee_call_graph",
    entryFile: args.entryFile,
    entrySymbol: args.entrySymbol,
    ...(args.entryLexicalPath === null ? {} : { entryLexicalPath: args.entryLexicalPath }),
    maxDepth: args.maxDepth as CliCalleeCallGraphGoal["maxDepth"],
    direction: SUPPORTED_DIRECTION,
    scopePaths: args.scopePaths,
    satisfactionThreshold: 1.0,
  };

  let result: CallDepthRunResult | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  try {
    const session = sandbox.bindSession(DEFAULT_READ_ONLY_SESSION_ID);
    result = await runCliCalleeCallGraphGoal(
      { requestId: args.requestId, rootGoal },
      { sandbox, session },
    );
  } catch (error) {
    runError = error;
  } finally {
    try {
      await sandbox.cleanup();
    } catch (error) {
      cleanupError = error;
    }
  }

  const repoPhysicalRoot: string = sandbox.scenarioRoot;
  if (cleanupError !== undefined) {
    await finalizeError("cleanup", cleanupError, repoPhysicalRoot, args.diagnosticsFile);
    return;
  }
  if (runError !== undefined) {
    await finalizeError("execute", runError, repoPhysicalRoot, args.diagnosticsFile);
    return;
  }
  if (result === undefined) {
    await finalizeError("execute", new Error("call-depth run returned no result"), repoPhysicalRoot, args.diagnosticsFile);
    return;
  }

  const diagnosticsFilePath = args.diagnosticsFile === null
    ? null
    : resolve(process.cwd(), args.diagnosticsFile);
  if (args.diagnosticsFile !== null) {
    try {
      await writeDiagnostics(args.diagnosticsFile, {
        finalState: result.finalState,
        response: result.response,
      });
    } catch (error) {
      await finalizeError("args", error, repoPhysicalRoot, null);
      return;
    }
  }

  const exitCode = exitCodeForStatus(result.status);
  const runLog = buildRunLog({
    cliVersion,
    runId,
    startedAt,
    startedAtMs,
    subcommand: CALLS_SUBCOMMAND,
    cwd: process.cwd(),
    sanitizedArgv: sanitizedArgv(parsedValue),
    repoRoot: repoPhysicalRoot,
    diagnosticsFilePath,
    outcome: completedOutcome(result, exitCode),
    summary: summarize(result),
    resultReceipt: resultReceipt(result),
    error: null,
  });
  const { runLogPath, logWriteError } = await writeRunLog({
    logDir,
    runId,
    runLog,
    protectedRepoRoots,
    protectionFailure,
  });
  if (logWriteError !== null) {
    warnLogWrite(logWriteError);
  }

  const payload: Record<string, unknown> = {
    cliVersion,
    runId,
    runLogPath,
    ...projectResult(result, repoPhysicalRoot, args.requestId, args.scopePaths) as Record<string, unknown>,
  };
  if (logWriteError !== null) {
    payload.logWriteError = logWriteError;
  }
  process.stdout.write(`${JSON.stringify(payload, null, args.compact ? undefined : 2)}\n`);
  process.exitCode = exitCode;
}

main().catch(error => {
  reportError("execute", error, { cliVersion: null, runId: null, runLogPath: null, logWriteError: null });
});
