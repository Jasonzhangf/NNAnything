#!/usr/bin/env node
import { realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  createReadOnlyCliFilesystemSandbox,
  DEFAULT_READ_ONLY_SESSION_ID,
  runCliCalleeCallGraphGoal,
  type CallDepthRunResult,
  type CliCalleeCallGraphGoal,
} from "./cli-call-depth.js";

const USAGE = [
  "Usage: nn-call-depth",
  "  --repo <path>                         Target repository path (required)",
  "  --entry-file <repoRelativePath>       Entry file relative to the repo (required)",
  "  --entry-symbol <symbol>               Entry symbol name (required)",
  "  --entry-lexical-path <chain>          Dot-separated lexical scope chain (optional)",
  "  --max-depth <0|1|2|3>                 Maximum call depth (required)",
  "  --scope <prefix>                      Scope path prefix; repeatable or comma separated (required)",
  "  --request-id <id>                     Request id (default cli-call-depth-live)",
  "  --diagnostics-file <path>             Write raw diagnostics outside the repo (optional)",
  "  --compact                             Emit single-line JSON",
  "  --help, -h                            Show this help",
].join("\n");

type CliStage = "args" | "init" | "execute" | "cleanup";

type ParsedArgs = {
  repo: string;
  entryFile: string;
  entrySymbol: string;
  entryLexicalPath: string | null;
  maxDepth: number;
  scopePaths: readonly string[];
  requestId: string;
  diagnosticsFile: string | null;
  compact: boolean;
};

type ParseResult = {
  help: boolean;
  error?: Error;
  value?: ParsedArgs;
};

function parseArgs(argv: readonly string[]): ParseResult {
  let help = false;
  let repo: string | null = null;
  let entryFile: string | null = null;
  let entrySymbol: string | null = null;
  let entryLexicalPath: string | null = null;
  let maxDepth: number | null = null;
  let requestId: string | null = null;
  let diagnosticsFile: string | null = null;
  let compact = false;
  const scopes: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
                    : null;
    if (valueArg === null) {
      return { help, error: new TypeError(`unknown argument: ${arg}`) };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return { help, error: new TypeError(`missing value for ${arg}`) };
    }
    index += 1;
    if (valueArg === "scope") {
      scopes.push(value);
    } else if (valueArg === "repo") {
      repo = value;
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
    }
  }

  if (help) return { help };
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

  const scopePaths = scopes
    .flatMap(scope => scope.split(","))
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0);
  if (scopePaths.length === 0) return { help, error: new TypeError("--scope is required") };

  return {
    help,
    value: {
      repo,
      entryFile,
      entrySymbol,
      entryLexicalPath,
      maxDepth,
      scopePaths: Object.freeze(scopePaths),
      requestId: requestId ?? "cli-call-depth-live",
      diagnosticsFile,
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function validateDiagnosticsPath(scenarioRoot: string, rawPath: string): Promise<void> {
  const target = resolve(process.cwd(), rawPath);
  if (isWithin(scenarioRoot, target)) {
    throw new TypeError("diagnostics file must not be written inside the target repository");
  }

  let physicalParent: string;
  try {
    physicalParent = await realpath(dirname(target));
  } catch (error) {
    throw Object.assign(
      new TypeError(`diagnostics file parent directory is not resolvable: ${errorText(error)}`),
      { code: errorCode(error) ?? "ENOENT" },
    );
  }
  if (isWithin(scenarioRoot, physicalParent)) {
    throw Object.assign(
      new TypeError("diagnostics file parent resolves inside the target repository"),
      { code: "SANDBOX_ESCAPE" },
    );
  }

  try {
    const physicalTarget = await realpath(target);
    if (isWithin(scenarioRoot, physicalTarget)) {
      throw Object.assign(
        new TypeError("diagnostics file resolves inside the target repository through a symlink"),
        { code: "SANDBOX_ESCAPE" },
      );
    }
  } catch (error) {
    if (errorCode(error) === "SANDBOX_ESCAPE") throw error;
  }
}

async function writeDiagnostics(
  rawPath: string,
  diagnostics: Readonly<{ finalState: unknown; response: unknown }>,
): Promise<void> {
  const target = resolve(process.cwd(), rawPath);
  await writeFile(target, JSON.stringify(diagnostics, null, 2));
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
    nodes: result.nodes.map(node => ({
      nodeId: node.nodeId,
      filePath: node.filePath,
      symbolName: node.symbolName,
      lexicalScopeChain: node.lexicalScopeChain,
      minDepth: node.minDepth,
      bodyExtracted: node.bodyExtracted,
      declSpan: node.declSpan,
    })),
    edges: result.edges,
    unresolvedCallsites: result.unresolvedCallsites,
    counters: result.counters,
  };
}

function exitCodeForStatus(status: CallDepthRunResult["status"]): number {
  switch (status) {
    case "achieved": return 0;
    case "unmet": return 2;
    case "unknown": return 3;
    case "rejected": return 4;
    case "failed": return 5;
    default: return 1;
  }
}

function reportError(stage: CliStage, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const record = err as Error & { code?: unknown; syscall?: unknown; path?: unknown };
  process.stderr.write(`${JSON.stringify({
    error: {
      stage,
      name: err.name,
      message: err.message,
      code: typeof record.code === "string" ? record.code : null,
      syscall: typeof record.syscall === "string" ? record.syscall : null,
      path: typeof record.path === "string" ? record.path : null,
    },
  })}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    reportError("args", error);
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (parsed.error !== undefined) {
    reportError("args", parsed.error);
    return;
  }

  const args = parsed.value;
  if (args === undefined) {
    reportError("args", new TypeError("invalid arguments"));
    return;
  }
  const repoRoot = resolve(process.cwd(), args.repo);
  let sandbox;
  try {
    sandbox = await createReadOnlyCliFilesystemSandbox({
      root: repoRoot,
      sessionId: DEFAULT_READ_ONLY_SESSION_ID,
    });
  } catch (error) {
    reportError("init", error);
    return;
  }

  if (args.diagnosticsFile !== null) {
    try {
      await validateDiagnosticsPath(sandbox.scenarioRoot, args.diagnosticsFile);
    } catch (error) {
      try {
        await sandbox.cleanup();
      } catch (cleanupError) {
        reportError("cleanup", cleanupError);
        return;
      }
      reportError("args", error);
      return;
    }
  }

  const rootGoal: CliCalleeCallGraphGoal = {
    kind: "cli.programming.callee_call_graph",
    entryFile: args.entryFile,
    entrySymbol: args.entrySymbol,
    ...(args.entryLexicalPath === null ? {} : { entryLexicalPath: args.entryLexicalPath }),
    maxDepth: args.maxDepth as CliCalleeCallGraphGoal["maxDepth"],
    direction: "callee",
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

  if (cleanupError !== undefined) {
    reportError("cleanup", cleanupError);
    return;
  }
  if (runError !== undefined) {
    reportError("execute", runError);
    return;
  }
  if (result === undefined) {
    reportError("execute", new Error("call-depth run returned no result"));
    return;
  }

  if (args.diagnosticsFile !== null) {
    try {
      await writeDiagnostics(args.diagnosticsFile, {
        finalState: result.finalState,
        response: result.response,
      });
    } catch (error) {
      reportError("args", error);
      return;
    }
  }

  const payload = projectResult(result, sandbox.scenarioRoot, args.requestId, args.scopePaths);
  process.stdout.write(`${JSON.stringify(payload, null, args.compact ? undefined : 2)}\n`);
  process.exitCode = exitCodeForStatus(result.status);
}

main().catch(error => {
  reportError("execute", error);
});
