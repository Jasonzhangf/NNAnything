#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CALL_DEPTH_REQUEST_SCHEMA } from "./adapters/cli/call-depth-contract.js";
import {
  createUsageLogRun,
  disabledUsageLog,
  failedUsageLog,
  isWithin,
  projectCallDepthUsageEvents,
  resolvePhysicalPath,
  resolveUsageLogRoot,
  USAGE_LOG_DEFAULT_SUBPATH,
  type UsageLogResult,
  type UsageLogRun,
} from "./adapters/cli/nn-code-usage-log.js";
import {
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SESSION_ID,
  runCliCalleeCallGraphGoal,
  type CallDepthRunResult,
  type CliCalleeCallGraphGoal,
} from "./cli-call-depth.js";
import { normalizeCallDepthLanguage } from "./adapters/cli/call-depth-contract.js";
import { runCliSymbols } from "./cli-symbols.js";

const CLI_NAME = "nn-code";
const CALLS_SUBCOMMAND = "calls";
const DEFAULT_REQUEST_ID = "nn-code-calls-live";
const VALID_MAX_DEPTHS = Object.freeze([0, 1, 2, 3] as const);
const SUPPORTED_DIRECTION = "callee";
const SKILL_ENTRY_PATH = "~/.agents/skills/nn-code/SKILL.md";
const SEMANTIC_CONTRACT_VERSION = CALL_DEPTH_REQUEST_SCHEMA;
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
  language: string | null;
  diagnosticsFile: string | null;
  logDir: string | null;
  compact: boolean;
  noLog: boolean;
  verbose: boolean;
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

type ReportContext = Readonly<{
  cliVersion: string | null;
  runId: string;
  logging: UsageLogResult;
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
    `  ${CLI_NAME} symbols --repo <path> --language <rust|rs> --scope <prefix> [options]`,
    "",
    `Subcommands:`,
    `  ${CALLS_SUBCOMMAND}                      Deterministic read-only callee call graph (see below)`,
    `  symbols                       Read-only Rust symbol declaration table; run "${CLI_NAME} symbols --help" for details`,
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
    "  --language <language>                 Explicit source language: typescript|ts, javascript|js.",
    "                                        rust|rs, cpp|c++|cxx, kotlin|kt, java, swift are valid but",
    "                                        currently return UNSUPPORTED_LANGUAGE with a real text scan.",
    "                                        Omitted: keep the existing TypeScript/JavaScript parser and",
    "                                        only check the entry-file extension; this is not automatic",
    "                                        repository language detection.",
    "  --entry-lexical-path <chain>          Dot-separated lexical chain for nested functions (e.g. declarationsOf.walk)",
    `  --request-id <id>                     Request identifier (default: ${DEFAULT_REQUEST_ID})`,
    "  --log-dir <dir>                       Directory for per-run logs outside --repo",
    `                                          (env: NN_CODE_LOG_DIR; default: ~/${USAGE_LOG_DEFAULT_SUBPATH})`,
    "  --diagnostics-file <path>             Write opt-in deep diagnostics (finalState + response) outside --repo",
    "                                          (user-owned export; not managed by the per-root rotation limit)",
    "  --no-log                              Disable all persistent logging for this invocation",
    "  --verbose                             Emit the full structured relation JSON plus coverage evidence",
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
    "Run Logs:",
    `  - Per-run log location: ~/${USAGE_LOG_DEFAULT_SUBPATH}/<runId>.jsonl (JSONL: start, events, finish).`,
    "  - Each selected log root has an independent 10,000,000,000 byte capacity. The oldest",
    "    completed run is rotated first; active runs are never rotated.",
    '  - stdout carries a "logging" field: { enabled, state, runLogPath, reason }.',
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

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function lastOptionValue(argv: readonly string[], name: string): string | null {
  const values = extractOptionValues(argv, name);
  return values.length > 0 ? values[values.length - 1] ?? null : null;
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
  let language: string | null = null;
  let diagnosticsFile: string | null = null;
  let logDir: string | null = null;
  let compact = false;
  let noLog = false;
  let verbose = false;
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
    if (arg === "--no-log") {
      noLog = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
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
                  : arg === "--language"
                    ? "language"
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
    } else if (valueArg === "language") {
      language = value;
    } else if (valueArg === "diagnosticsFile") {
      diagnosticsFile = value;
    } else if (valueArg === "logDir") {
      logDir = value;
    }
  }

  if (help) return { help };
  if (noLog && (logDir !== null || diagnosticsFile !== null)) {
    return { help, error: new TypeError("--no-log conflicts with --log-dir and --diagnostics-file") };
  }
  if (repoCount > 1) return { help, error: new TypeError("duplicate --repo argument is not allowed") };
  if (repo === null || repo.length === 0) return { help, error: new TypeError("--repo is required") };
  if (entryFile === null || entryFile.length === 0) return { help, error: new TypeError("--entry-file is required") };
  if (entrySymbol === null || entrySymbol.length === 0) return { help, error: new TypeError("--entry-symbol is required") };
  if (entryLexicalPath !== null && entryLexicalPath.length === 0) {
    return { help, error: new TypeError("--entry-lexical-path must not be empty") };
  }
  if (maxDepth === null) return { help, error: new TypeError("--max-depth is required") };
  if (requestId !== null && requestId.length === 0) return { help, error: new TypeError("--request-id must not be empty") };
  if (language !== null && normalizeCallDepthLanguage(language) === null) {
    return { help, error: new TypeError(`unknown --language value: ${language}`) };
  }
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
      language,
      diagnosticsFile,
      logDir,
      compact,
      noLog,
      verbose,
    },
  };
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

function logWriteErrorFromLogging(logging: UsageLogResult): LogWriteError | null {
  const partialPersistenceFailure = logging.state === "partial"
    && (logging.reason === "LOG_STORE_BUSY" || logging.reason === "LOG_CAPACITY_EXCEEDED");
  if (logging.state !== "failed" && !partialPersistenceFailure) return null;
  const code = logging.reason;
  const message = logging.state === "failed"
    ? (code ?? "log write failed")
    : `usage log persistence was incomplete: ${code}`;
  return Object.freeze({
    stage: "log_write" as const,
    name: "Error",
    message,
    code,
    path: logging.runLogPath,
  });
}

async function validateDiagnosticsPath(repoRoot: string, rawPath: string): Promise<void> {
  const physicalTarget = await resolvePhysicalPath(rawPath);
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
    requestedLanguage: result.requestedLanguage,
    actualParser: result.actualParser,
    supportedLanguages: result.supportedLanguages,
    reasonCode: result.reasonCode,
    textCandidates: result.textCandidates,
    coverage: result.coverage,
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

function coverageOf(result: CallDepthRunResult): Record<string, unknown> {
  return {
    counters: result.counters,
    nodesCount: result.nodes.length,
    edgesCount: result.edges.length,
    unresolvedCount: result.unresolvedCallsites.length,
    achievedDepth: result.achievedDepth,
    requestedMaxDepth: result.requestedMaxDepth,
    requestedLanguage: result.requestedLanguage,
    actualParser: result.actualParser,
    supportedLanguages: result.supportedLanguages,
    reasonCode: result.reasonCode,
    coverage: result.coverage,
    truncated: result.finalState?.truncated ?? false,
    sourceConsistencyFailed: result.finalState?.sourceConsistencyFailed ?? false,
    missingFiles: result.finalState?.missingFiles ?? [],
  };
}

function resultReceiptOf(result: CallDepthRunResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nodes: projectNodes(result.nodes),
    edges: result.edges,
    unresolvedCallsites: result.unresolvedCallsites,
    textCandidates: result.textCandidates,
  });
}

function typedRequest(args: ParsedArgs): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "cli.programming.callee_call_graph",
    repoRoot: resolve(process.cwd(), args.repo),
    entryFile: args.entryFile,
    entrySymbol: args.entrySymbol,
    ...(args.entryLexicalPath === null ? {} : { entryLexicalPath: args.entryLexicalPath }),
    maxDepth: args.maxDepth,
    direction: SUPPORTED_DIRECTION,
    scopePaths: args.scopePaths,
    requestId: args.requestId,
    ...(args.language === null ? {} : { language: args.language }),
  });
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

function reportError(stage: CliStage, error: unknown, context: ReportContext): void {
  const fact = errorFact(stage, error);
  const errorPayload: Record<string, unknown> = {
    stage: fact.stage,
    name: fact.name,
    message: fact.message,
    code: fact.code,
    syscall: fact.syscall,
    path: fact.path,
    cliVersion: context.cliVersion,
    runId: context.runId,
    runLogPath: context.logging.runLogPath,
    logging: context.logging,
  };
  if (context.logWriteError !== null) {
    errorPayload.logWriteError = context.logWriteError;
  }
  process.stderr.write(`${JSON.stringify({ error: errorPayload })}\n`);
  process.exitCode = EXIT_CODES.error;
}

async function finishWithError(
  logRun: UsageLogRun | null,
  stage: CliStage,
  error: unknown,
  fallback: UsageLogResult,
): Promise<UsageLogResult> {
  if (logRun === null) return fallback;
  await logRun.finish({
    outcome: { stage, exitCode: EXIT_CODES.error },
    coverage: null,
    resultReceipt: null,
    error: errorFact(stage, error),
  });
  return logRun.status();
}

async function executeQuery(
  args: ParsedArgs,
  logRun: UsageLogRun | null,
  cliVersion: string,
  runId: string,
  fallbackLogging: UsageLogResult,
): Promise<void> {
  const repoRoot = resolve(process.cwd(), args.repo);
  let sandbox;
  try {
    sandbox = await createReadOnlyCliFilesystemSandbox({
      root: repoRoot,
      sessionId: DEFAULT_READ_ONLY_SESSION_ID,
    });
  } catch (error) {
    const logging = await finishWithError(logRun, "init", error, fallbackLogging);
    reportError("init", error, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }

  if (args.diagnosticsFile !== null) {
    try {
      await validateDiagnosticsPath(sandbox.scenarioRoot, args.diagnosticsFile);
    } catch (error) {
      try {
        await sandbox.cleanup();
      } catch (cleanupError) {
        const logging = await finishWithError(logRun, "cleanup", cleanupError, fallbackLogging);
        reportError("cleanup", cleanupError, {
          cliVersion,
          runId,
          logging,
          logWriteError: logWriteErrorFromLogging(logging),
        });
        return;
      }
      const logging = await finishWithError(logRun, "args", error, fallbackLogging);
      reportError("args", error, {
        cliVersion,
        runId,
        logging,
        logWriteError: logWriteErrorFromLogging(logging),
      });
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
      { sandbox, session, language: args.language },
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
    const logging = await finishWithError(logRun, "cleanup", cleanupError, fallbackLogging);
    reportError("cleanup", cleanupError, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }
  if (runError !== undefined) {
    const logging = await finishWithError(logRun, "execute", runError, fallbackLogging);
    reportError("execute", runError, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }
  if (result === undefined) {
    const error = new Error("call-depth run returned no result");
    const logging = await finishWithError(logRun, "execute", error, fallbackLogging);
    reportError("execute", error, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
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
      const logging = await finishWithError(logRun, "args", error, fallbackLogging);
      reportError("args", error, {
        cliVersion,
        runId,
        logging,
        logWriteError: logWriteErrorFromLogging(logging),
      });
      return;
    }
  }

  if (logRun !== null) {
    const events = projectCallDepthUsageEvents({
      result,
      repoRoot: repoPhysicalRoot,
      reserveExcerptBytes: requested => logRun.reserveExcerptBytes(requested),
    });
    for (const event of events) {
      const persisted = await logRun.event(event);
      if (!persisted) break;
    }
    await logRun.finish({
      outcome: {
        stage: "completed",
        exitCode: exitCodeForStatus(result.status),
        status: result.status,
        resolution: result.resolution,
        entryNodeId: result.entryNodeId,
        requestedMaxDepth: result.requestedMaxDepth,
        achievedDepth: result.achievedDepth,
        truncated: result.finalState?.truncated ?? false,
        sourceConsistencyFailed: result.finalState?.sourceConsistencyFailed ?? false,
        missingFiles: result.finalState?.missingFiles ?? [],
      },
      coverage: coverageOf(result),
      resultReceipt: resultReceiptOf(result),
      error: null,
    });
  }

  const logging = logRun === null ? fallbackLogging : logRun.status();
  const logWriteError = logWriteErrorFromLogging(logging);
  if (logWriteError !== null) {
    warnLogWrite(logWriteError);
  }

  const payload: Record<string, unknown> = {
    cliVersion,
    runId,
    logging,
    runLogPath: logging.runLogPath,
    ...projectResult(result, repoPhysicalRoot, args.requestId, args.scopePaths) as Record<string, unknown>,
  };
  if (args.verbose) {
    payload.coverage = coverageOf(result);
  }
  if (logWriteError !== null) {
    payload.logWriteError = logWriteError;
  }
  process.stdout.write(`${JSON.stringify(payload, null, args.compact ? undefined : 2)}\n`);
  process.exitCode = exitCodeForStatus(result.status);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = `${startedAt.replace(/[-:.]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;

  let cliVersion: string;
  try {
    cliVersion = readPackageVersion();
  } catch (error) {
    const logging = failedUsageLog("LOG_INIT_FAILED");
    reportError("init", error, {
      cliVersion: null,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }

  const rawArgv = process.argv.slice(2);

  if (rawArgv[0] === "symbols") {
    await runCliSymbols(rawArgv.slice(1), { cliVersion });
    return;
  }

  if (hasFlag(rawArgv, "--help") || hasFlag(rawArgv, "-h")) {
    process.stdout.write(`${buildUsageText(cliVersion)}\n`);
    process.exitCode = EXIT_CODES.achieved;
    return;
  }

  const noLog = hasFlag(rawArgv, "--no-log");
  const rawLogDir = lastOptionValue(rawArgv, "--log-dir");
  const rawDiagnostics = lastOptionValue(rawArgv, "--diagnostics-file");
  if (noLog && (rawLogDir !== null || rawDiagnostics !== null)) {
    reportError("args", new TypeError("--no-log conflicts with --log-dir and --diagnostics-file"), {
      cliVersion,
      runId,
      logging: disabledUsageLog(),
      logWriteError: null,
    });
    return;
  }

  const parsed = parseArgs(rawArgv);

  const protectedRepoRoots: string[] = [];
  let protectionError: unknown = null;
  const rawRepos = extractOptionValues(rawArgv, "--repo");
  const repoCandidates = rawRepos.length > 0 ? rawRepos : [process.cwd()];
  for (const candidate of repoCandidates) {
    try {
      protectedRepoRoots.push(await resolvePhysicalPath(candidate));
    } catch (error) {
      protectionError = error;
      break;
    }
  }

  if (noLog) {
    if (parsed.error !== undefined) {
      reportError("args", parsed.error, {
        cliVersion,
        runId,
        logging: disabledUsageLog(),
        logWriteError: null,
      });
      return;
    }
    if (parsed.value === undefined) {
      reportError("args", new TypeError("invalid arguments"), {
        cliVersion,
        runId,
        logging: disabledUsageLog(),
        logWriteError: null,
      });
      return;
    }
    await executeQuery(parsed.value, null, cliVersion, runId, disabledUsageLog());
    return;
  }

  let logRun: UsageLogRun | null = null;
  if (protectionError === null) {
    let logRoot: string;
    try {
      logRoot = resolveUsageLogRoot(parsed.value?.logDir ?? rawLogDir);
    } catch (error) {
      reportError("args", error, {
        cliVersion,
        runId,
        logging: failedUsageLog("LOG_INIT_FAILED"),
        logWriteError: null,
      });
      return;
    }
    try {
      logRun = createUsageLogRun({
        root: logRoot,
        runId,
        protectedRoots: protectedRepoRoots,
        pid: process.pid,
        owner: `nn-code:${process.pid}`,
      });
    } catch (error) {
      reportError("args", error, {
        cliVersion,
        runId,
        logging: failedUsageLog("LOG_INIT_FAILED"),
        logWriteError: null,
      });
      return;
    }
    await logRun.start({
      request: parsed.value === undefined ? null : typedRequest(parsed.value),
      cliVersion,
      semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
      modelRef: null,
    });
  }

  const effectiveLogging = (): UsageLogResult => {
    if (protectionError !== null) {
      return failedUsageLog(errorCode(protectionError) ?? "LOG_WRITE_FAILED");
    }
    return logRun?.status() ?? failedUsageLog("LOG_INIT_FAILED");
  };

  if (parsed.error !== undefined) {
    const logging = logRun === null
      ? effectiveLogging()
      : await finishWithError(logRun, "args", parsed.error, effectiveLogging());
    reportError("args", parsed.error, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }
  if (parsed.value === undefined) {
    const error = new TypeError("invalid arguments");
    const logging = logRun === null
      ? effectiveLogging()
      : await finishWithError(logRun, "args", error, effectiveLogging());
    reportError("args", error, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }

  await executeQuery(parsed.value, logRun, cliVersion, runId, effectiveLogging());
}

main().catch(error => {
  const logging = failedUsageLog("LOG_INIT_FAILED");
  reportError("execute", error, {
    cliVersion: null,
    runId: "unknown",
    logging,
    logWriteError: null,
  });
});
