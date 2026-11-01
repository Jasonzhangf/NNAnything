// nn-code symbols: public subcommand for the Rust symbol-table slice.
//
// This module owns the public entry: request validation, scope discovery
// (entry.list + entry.inspect), exact filter handoff and the single
// nnanything.cli-symbols.result.v1 exit. The language adapter only receives an
// explicit list of repo-relative regular .rs files; it never performs
// directory discovery itself.

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ContentSearchFileCondition } from "./adapters/cli/content-search-contract.js";
import { resolveCapabilities } from "./adapters/cli/directory-command-search.js";
import { runDirectoryListHelper } from "./adapters/cli/directory-listing.js";
import { runEntryInspectHelper } from "./adapters/cli/entry-inspection.js";
import {
  createUsageLogRun,
  disabledUsageLog,
  failedUsageLog,
  resolvePhysicalPath,
  resolveUsageLogRoot,
  type UsageLogResult,
  type UsageLogRun,
} from "./adapters/cli/nn-code-usage-log.js";
import { runKotlinSymbolTable } from "./adapters/cli/kotlin-symbol-table-adapter.js";
import { runRustSymbolTable } from "./adapters/cli/rust-symbol-table-adapter.js";
import { validateKotlinSymbolRequest } from "./filters/kotlin-symbol-table-policy.js";
import {
  validateRustSymbolRequest,
  type RustEdition,
} from "./filters/rust-symbol-table-policy.js";

export const SYMBOLS_REQUEST_SCHEMA = "nnanything.cli-symbols.request.v1";
export const SYMBOLS_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export const SYMBOLS_HELP_TEXT = [
  "nn-code symbols - Rust and Kotlin symbol declaration tables (read-only)",
  "",
  "Usage:",
  "  nn-code symbols --repo <path> --language <rust|rs|kotlin|kt> --scope <prefix> [options]",
  "",
  "Required arguments:",
  "  --repo <path>          Target repository root (absolute or cwd-relative; read-only)",
  "  --language <rust|rs|kotlin|kt>   Source language (rust or kotlin)",
  "  --scope <prefix>       Repo-relative path; repeatable or comma-separated",
  "",
  "Optional arguments:",
  "  --symbol <name>        Exact short symbol name (case-sensitive, no fuzzy match)",
  "  --file <path>          Exact repo-relative file path (intersected with --symbol)",
  "  --edition <2015|2018|2021|2024>            rust-only edition (default 2021; Cargo.toml is not read)",
  "  --ignore-policy <no_ignore>                      default no_ignore (only no_ignore is supported)",
  "  --log-dir <dir>        Per-run usage log directory (env: NN_CODE_LOG_DIR)",
  "  --no-log               Disable persistent logging for this invocation",
  "  --compact              Emit single-line JSON on stdout",
  "  --help, -h             Show this help and exit 0",
  "",
  "Kotlin requires a JDK 17 and the four Kotlin compiler jars on disk. The java",
  "binary and jars are resolved from NN_CODE_KOTLIN_JAVA_BIN / NN_CODE_KOTLIN_JARS,",
  "JAVA_HOME, PATH, or the standard Gradle/Maven artifact caches.",
  "",
  "Not accepted (calls-only): --entry-file, --entry-symbol, --entry-lexical-path, --max-depth,",
  "                           --request-id, --diagnostics-file, --verbose",
  "",
  "Result: single nnanything.cli-symbols.result.v1 JSON object on stdout.",
  'Request rejection: {"status":"rejected","reasonCode":...} on stdout with exit code 4.',
].join("\n");

const EXIT_CODES = Object.freeze({ ok: 0, error: 1, rejected: 4 } as const);
const SUPPORTED_LANGUAGES = Object.freeze(["rust", "rs", "kotlin", "kt"] as const);
const EDITIONS: readonly RustEdition[] = Object.freeze(["2015", "2018", "2021", "2024"]);
const IGNORE_POLICIES = Object.freeze(["no_ignore", "respect_vcs_ignore"] as const);
// Discovery reuses the same regular-file condition the content-search contract
// defines; symlinks are never followed.
const FILE_CONDITION: ContentSearchFileCondition = Object.freeze({ type: "regular" });

type IgnorePolicy = typeof IGNORE_POLICIES[number];

type RejectedError = Readonly<{ status: "rejected"; reasonCode: string; message: string }>;

type ParsedSymbols = Readonly<{
  repo: string;
  scope: readonly string[];
  language: string;
  symbol: string | null;
  file: string | null;
  edition: RustEdition | null;
  ignorePolicy: IgnorePolicy | null;
  logDir: string | null;
  compact: boolean;
  noLog: boolean;
}>;

type ParseOutcome =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "error"; error: RejectedError }>
  | Readonly<{ kind: "value"; value: ParsedSymbols }>;

type SkipRecord = Readonly<{ file: string; reason: string }>;

type Discovery = Readonly<{
  files: readonly string[];
  skipped: readonly SkipRecord[];
  partialReasons: readonly string[];
}>;

type DiscoveryAccumulator = {
  files: string[];
  skipped: SkipRecord[];
  partialReasons: string[];
  seenRealFiles: Set<string>;
  seenScopeReal: Set<string>;
  seenDirectoryReal: Set<string>;
};

type DiscoveryOutcome =
  | Readonly<{ kind: "ok"; discovery: Discovery }>
  | Readonly<{ kind: "rejected"; error: RejectedError }>;

type ScopeCheck =
  | Readonly<{ kind: "directory"; abs: string; real: string }>
  | Readonly<{ kind: "file"; abs: string }>
  | Readonly<{ kind: "skipped"; reason: string }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function rejected(reasonCode: string, message: string): RejectedError {
  return Object.freeze({ status: "rejected" as const, reasonCode, message });
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function optionValues(argv: readonly string[], name: string): string[] {
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

function normalizedScopes(values: readonly string[]): string[] {
  const scope: string[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const normalized = part.trim().replace(/\\/g, "/");
      if (normalized.length > 0) scope.push(normalized);
    }
  }
  return [...new Set(scope)];
}

function parseSymbolsArgs(argv: readonly string[]): ParseOutcome {
  let repo: string | null = null;
  let repoCount = 0;
  let language: string | null = null;
  let symbol: string | null = null;
  let file: string | null = null;
  let edition: string | null = null;
  let ignorePolicy: string | null = null;
  let logDir: string | null = null;
  let compact = false;
  let noLog = false;
  const rawScopes: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--compact") {
      compact = true;
      continue;
    }
    if (arg === "--no-log") {
      noLog = true;
      continue;
    }
    const valueArg = arg === "--repo"
      ? "repo"
      : arg === "--scope"
        ? "scope"
        : arg === "--language"
          ? "language"
          : arg === "--symbol"
            ? "symbol"
            : arg === "--file"
              ? "file"
              : arg === "--edition"
                ? "edition"
                : arg === "--ignore-policy" || arg === "--ignorePolicy"
                  ? "ignorePolicy"
                  : arg === "--log-dir"
                    ? "logDir"
                    : null;
    if (valueArg === null) {
      return { kind: "error", error: rejected("unknown_argument", `unknown argument: ${arg}`) };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return { kind: "error", error: rejected("missing_value", `missing value for ${arg}`) };
    }
    index += 1;
    switch (valueArg) {
      case "repo":
        repo = value;
        repoCount += 1;
        break;
      case "scope":
        rawScopes.push(value);
        break;
      case "language":
        language = value;
        break;
      case "symbol":
        symbol = value;
        break;
      case "file":
        file = value;
        break;
      case "edition":
        edition = value;
        break;
      case "ignorePolicy":
        ignorePolicy = value;
        break;
      case "logDir":
        logDir = value;
        break;
      default:
        break;
    }
  }

  if (repoCount > 1) {
    return { kind: "error", error: rejected("duplicate_argument", "duplicate --repo argument is not allowed") };
  }
  if (repo === null || repo.length === 0) {
    return { kind: "error", error: rejected("missing_repo", "--repo is required") };
  }
  if (language === null || language.length === 0) {
    return { kind: "error", error: rejected("missing_language", "--language is required") };
  }
  const scope = normalizedScopes(rawScopes);
  if (scope.length === 0) {
    return { kind: "error", error: rejected("missing_scope", "--scope is required") };
  }
  const normalizedLanguage = language.toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(normalizedLanguage as (typeof SUPPORTED_LANGUAGES)[number])) {
    return {
      kind: "error",
      error: rejected("UNSUPPORTED_LANGUAGE", `unsupported language: ${language}`),
    };
  }
  const kotlinLanguage = normalizedLanguage === "kotlin" || normalizedLanguage === "kt";
  if (symbol !== null && (symbol.length === 0 || /[\s\0]/.test(symbol))) {
    return { kind: "error", error: rejected("invalid_symbol", "symbol must be a non-empty name without whitespace") };
  }
  if (file !== null && file.length === 0) {
    return { kind: "error", error: rejected("invalid_file", "file must be a non-empty repo-relative path") };
  }
  if (kotlinLanguage && edition !== null) {
    return { kind: "error", error: rejected("invalid_edition", "--edition is only supported for rust|rs") };
  }
  if (edition !== null && !EDITIONS.includes(edition as RustEdition)) {
    return { kind: "error", error: rejected("invalid_edition", "edition must be one of 2015|2018|2021|2024") };
  }
  if (ignorePolicy !== null && !IGNORE_POLICIES.includes(ignorePolicy as IgnorePolicy)) {
    return { kind: "error", error: rejected("invalid_ignore_policy", "ignorePolicy must be no_ignore or respect_vcs_ignore") };
  }
  if (logDir !== null && logDir.length === 0) {
    return { kind: "error", error: rejected("invalid_log_dir", "--log-dir must not be empty") };
  }

  return {
    kind: "value",
    value: Object.freeze({
      repo,
      scope: Object.freeze(scope),
      language: normalizedLanguage,
      symbol,
      file,
      edition: edition as RustEdition | null,
      ignorePolicy: ignorePolicy as IgnorePolicy | null,
      logDir,
      compact,
      noLog,
    }),
  };
}

function isContained(baseAbs: string, targetAbs: string): boolean {
  const rel = relative(baseAbs, targetAbs);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) return false;
  return true;
}

function repoRelative(repoAbs: string, abs: string): string {
  return relative(repoAbs, abs).split("/").join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks each path component of a repo-relative scope without following symlinks. */
async function checkScopePath(repoAbs: string, scope: string): Promise<ScopeCheck> {
  const abs = resolve(repoAbs, scope);
  if (!isContained(repoAbs, abs)) {
    return { kind: "invalid", reason: "scope_escape" };
  }
  const parts = scope.split("/");
  let current = repoAbs;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] ?? "");
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      return { kind: "invalid", reason: `scope_not_found: ${errorMessage(error)}` };
    }
    if (stats.isSymbolicLink()) {
      return { kind: "skipped", reason: "SYMLINK_PATH_COMPONENT" };
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      return { kind: "invalid", reason: "scope_not_a_directory" };
    }
  }
  let stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    return { kind: "invalid", reason: `scope_not_found: ${errorMessage(error)}` };
  }
  if (stats.isDirectory()) {
    let real: string;
    try {
      real = await realpath(abs);
    } catch (error) {
      return { kind: "invalid", reason: `scope_realpath_failed: ${errorMessage(error)}` };
    }
    return { kind: "directory", abs, real };
  }
  if (stats.isFile()) {
    return { kind: "file", abs };
  }
  return { kind: "invalid", reason: "scope_not_a_file_or_directory" };
}

/**
 * Verifies a discovered `.rs` candidate is a regular file through the real
 * entry.inspect observation and that its physical path stays inside the repo.
 * Returns true only when the file should be handed to the language adapter.
 */
async function inspectCandidate(
  repoReal: string,
  abs: string,
  rel: string,
  acc: DiscoveryAccumulator,
): Promise<boolean> {
  const inspect = await runEntryInspectHelper({ absolutePath: abs, followSymlinks: false });
  if (!inspect.ok) {
    acc.skipped.push({ file: rel, reason: inspect.error.code });
    acc.partialReasons.push(`${rel}: ${inspect.error.code}`);
    return false;
  }
  const kind = inspect.observation.entryKind;
  if (kind !== FILE_CONDITION.type) {
    const reason = kind === "symlink" ? "SYMLINK_PATH_COMPONENT" : `not_a_regular_file:${String(kind)}`;
    acc.skipped.push({ file: rel, reason });
    acc.partialReasons.push(`${rel}: ${reason}`);
    return false;
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    const reason = `realpath_failed: ${errorMessage(error)}`;
    acc.skipped.push({ file: rel, reason });
    acc.partialReasons.push(`${rel}: ${reason}`);
    return false;
  }
  if (!isContained(repoReal, real)) {
    const reason = "PATH_ESCAPES_REPO_ROOT";
    acc.skipped.push({ file: rel, reason });
    acc.partialReasons.push(`${rel}: ${reason}`);
    return false;
  }
  if (acc.seenRealFiles.has(real)) return false;
  acc.seenRealFiles.add(real);
  return true;
}

async function walkScopeDirectory(
  repoReal: string,
  absDirectory: string,
  acc: DiscoveryAccumulator,
  matches: (name: string) => boolean,
): Promise<void> {
  let directoryReal: string;
  try {
    directoryReal = await realpath(absDirectory);
  } catch (error) {
    const rel = repoRelative(repoReal, absDirectory);
    acc.skipped.push({ file: rel, reason: `realpath_failed: ${errorMessage(error)}` });
    acc.partialReasons.push(`${rel}: realpath_failed`);
    return;
  }
  // Overlapping scopes converge on the same physical directory set; each
  // physical directory is listed at most once.
  if (acc.seenDirectoryReal.has(directoryReal)) return;
  acc.seenDirectoryReal.add(directoryReal);

  const relDirectory = repoRelative(repoReal, absDirectory);
  const listing = await runDirectoryListHelper({
    configuredDirectory: absDirectory,
    physicalDirectory: absDirectory,
  });
  if (!listing.ok) {
    acc.skipped.push({ file: relDirectory, reason: listing.error.code });
    acc.partialReasons.push(`${relDirectory}: ${listing.error.code}`);
    return;
  }
  if (listing.observation.coverage === "partial") {
    acc.partialReasons.push(`${relDirectory}: listing_partial`);
  }
  for (const entry of listing.observation.entries) {
    const rel = repoRelative(repoReal, entry.path);
    if (entry.type === "symlink") {
      acc.skipped.push({ file: rel, reason: "SYMLINK_PATH_COMPONENT" });
      acc.partialReasons.push(`${rel}: SYMLINK_PATH_COMPONENT`);
      continue;
    }
    if (entry.type === "directory") {
      await walkScopeDirectory(repoReal, entry.path, acc, matches);
      continue;
    }
    if (entry.type !== "file") {
      if (matches(entry.name)) {
        const reason = `non_regular_entry:${entry.type}`;
        acc.skipped.push({ file: rel, reason });
        acc.partialReasons.push(`${rel}: ${reason}`);
      }
      continue;
    }
    if (!matches(entry.name)) continue;
    const accepted = await inspectCandidate(repoReal, entry.path, rel, acc);
    if (accepted) acc.files.push(rel);
  }
}

function isRustSourceName(name: string): boolean {
  return name.endsWith(".rs");
}

function isKotlinSourceName(name: string): boolean {
  return name.endsWith(".kt") || name.endsWith(".kts");
}

async function discoverScopeFiles(
  repoAbs: string,
  repoReal: string,
  scope: readonly string[],
  matches: (name: string) => boolean,
): Promise<DiscoveryOutcome> {
  const acc: DiscoveryAccumulator = {
    files: [],
    skipped: [],
    partialReasons: [],
    seenRealFiles: new Set<string>(),
    seenScopeReal: new Set<string>(),
    seenDirectoryReal: new Set<string>(),
  };
  for (const entry of scope) {
    const checked = await checkScopePath(repoAbs, entry);
    if (checked.kind === "invalid") {
      return { kind: "rejected", error: rejected("invalid_scope", `${entry}: ${checked.reason}`) };
    }
    if (checked.kind === "skipped") {
      acc.skipped.push({ file: entry, reason: checked.reason });
      acc.partialReasons.push(`${entry}: ${checked.reason}`);
      continue;
    }
    if (checked.kind === "file") {
      if (!matches(entry)) continue;
      const accepted = await inspectCandidate(repoReal, checked.abs, entry, acc);
      if (accepted) acc.files.push(entry);
      continue;
    }
    if (acc.seenScopeReal.has(checked.real)) continue;
    acc.seenScopeReal.add(checked.real);
    await walkScopeDirectory(repoReal, checked.real, acc, matches);
  }
  return {
    kind: "ok",
    discovery: Object.freeze({
      files: Object.freeze(acc.files),
      skipped: Object.freeze(acc.skipped),
      partialReasons: Object.freeze(acc.partialReasons),
    }),
  };
}

async function discoverRustScopeFiles(
  repoAbs: string,
  repoReal: string,
  scope: readonly string[],
): Promise<DiscoveryOutcome> {
  return discoverScopeFiles(repoAbs, repoReal, scope, isRustSourceName);
}

async function discoverKotlinScopeFiles(
  repoAbs: string,
  repoReal: string,
  scope: readonly string[],
): Promise<DiscoveryOutcome> {
  return discoverScopeFiles(repoAbs, repoReal, scope, isKotlinSourceName);
}

function mergeSkipped(first: readonly SkipRecord[], second: readonly SkipRecord[]): SkipRecord[] {
  const seen = new Map<string, string>();
  for (const entry of [...first, ...second]) {
    if (!seen.has(entry.file)) seen.set(entry.file, entry.reason);
  }
  return [...seen].map(([file, reason]) => ({ file, reason }));
}

function mergeReasons(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}

function logWriteErrorFromLogging(logging: UsageLogResult): Readonly<Record<string, unknown>> | null {
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

type ErrorContext = Readonly<{
  cliVersion: string | null;
  runId: string;
  logging: UsageLogResult;
  logWriteError: Readonly<Record<string, unknown>> | null;
}>;

function reportSymbolsError(stage: string, error: unknown, context: ErrorContext): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const record = err as Error & { code?: unknown; syscall?: unknown; path?: unknown };
  const payload: Record<string, unknown> = {
    stage,
    name: err.name,
    message: err.message,
    code: typeof record.code === "string" ? record.code : null,
    syscall: typeof record.syscall === "string" ? record.syscall : null,
    path: typeof record.path === "string" ? record.path : null,
    cliVersion: context.cliVersion,
    runId: context.runId,
    runLogPath: context.logging.runLogPath,
    logging: context.logging,
  };
  if (context.logWriteError !== null) payload.logWriteError = context.logWriteError;
  process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  process.exitCode = EXIT_CODES.error;
}

function writeJson(payload: unknown, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, compact ? undefined : 2)}\n`);
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/**
 * Runs the `nn-code symbols` subcommand against an explicit argv slice (without
 * the leading `symbols` token). It writes the structured result to stdout,
 * routes request rejections through one `status:"rejected"` exit, and sets
 * `process.exitCode` itself.
 */
export async function runCliSymbols(
  argv: readonly string[],
  options: Readonly<{ cliVersion?: string | null }> = {},
): Promise<void> {
  const cliVersion = options.cliVersion ?? null;
  const runId = makeRunId();
  const compactRequested = hasFlag(argv, "--compact");

  const parsed = parseSymbolsArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${SYMBOLS_HELP_TEXT}\n`);
    process.exitCode = EXIT_CODES.ok;
    return;
  }
  if (parsed.kind === "error") {
    writeJson(
      { ...parsed.error, cliVersion, runId, logging: disabledUsageLog() },
      compactRequested,
    );
    process.exitCode = EXIT_CODES.rejected;
    return;
  }
  const args = parsed.value;

  let logRun: UsageLogRun | null = null;
  if (!args.noLog) {
    let logRoot: string;
    try {
      const protectedRoots = [await resolvePhysicalPath(resolve(process.cwd(), args.repo))];
      logRoot = resolveUsageLogRoot(args.logDir);
      logRun = createUsageLogRun({
        root: logRoot,
        runId,
        protectedRoots,
        pid: process.pid,
        owner: `nn-code-symbols:${process.pid}`,
      });
      await logRun.start({
        request: {
          schema: SYMBOLS_REQUEST_SCHEMA,
          repo: args.repo,
          language: args.language,
          scope: args.scope,
          symbol: args.symbol,
          file: args.file,
          edition: args.edition,
          ignorePolicy: args.ignorePolicy ?? "no_ignore",
        },
        cliVersion: cliVersion ?? "unknown",
        semanticContractVersion: SYMBOLS_REQUEST_SCHEMA,
        modelRef: null,
      });
    } catch (error) {
      reportSymbolsError("args", error, {
        cliVersion,
        runId,
        logging: failedUsageLog("LOG_INIT_FAILED"),
        logWriteError: null,
      });
      return;
    }
  }

  const finishRejected = async (error: RejectedError): Promise<void> => {
    if (logRun !== null) {
      await logRun.finish({
        outcome: {
          stage: "rejected",
          exitCode: EXIT_CODES.rejected,
          reasonCode: error.reasonCode,
          message: error.message,
        },
        coverage: null,
        resultReceipt: null,
        error: null,
      });
    }
    const logging = logRun === null ? disabledUsageLog() : logRun.status();
    writeJson(
      { ...error, cliVersion, runId, logging, runLogPath: logging.runLogPath },
      args.compact,
    );
    process.exitCode = EXIT_CODES.rejected;
  };

  const repoAbs = resolve(process.cwd(), args.repo);
  const kotlinLanguage = args.language === "kotlin" || args.language === "kt";
  const validation = kotlinLanguage
    ? validateKotlinSymbolRequest({
        repo: repoAbs,
        language: "kotlin",
        scope: [...args.scope],
        files: [],
        ...(args.symbol === null ? {} : { symbol: args.symbol }),
        ...(args.file === null ? {} : { file: args.file }),
        ignorePolicy: args.ignorePolicy ?? "no_ignore",
      })
    : validateRustSymbolRequest({
        repo: repoAbs,
        language: "rust",
        scope: [...args.scope],
        files: [],
        ...(args.symbol === null ? {} : { symbol: args.symbol }),
        ...(args.file === null ? {} : { file: args.file }),
        ...(args.edition === null ? {} : { edition: args.edition }),
      });
  if (!validation.ok) {
    await finishRejected(rejected(validation.error.reasonCode, validation.error.message));
    return;
  }
  const request = validation.request;

  const ignorePolicy: IgnorePolicy = args.ignorePolicy ?? "no_ignore";
  if (ignorePolicy === "respect_vcs_ignore") {
    try {
      await resolveCapabilities(false, true);
    } catch (error) {
      await finishRejected(rejected(
        "respect_vcs_ignore_requires_ripgrep",
        `respect_vcs_ignore is unavailable: ${errorMessage(error)}`,
      ));
      return;
    }
    // This slice's directory discovery (runDirectoryListHelper) does not apply
    // VCS-ignore rules; honoring the label without filtering would be a silent
    // downgrade. The contract fixes the first version to no_ignore.
    await finishRejected(rejected(
      "respect_vcs_ignore_not_implemented",
      "respect_vcs_ignore is not implemented in this slice; use --ignore-policy no_ignore",
    ));
    return;
  }

  let repoReal: string;
  try {
    repoReal = await realpath(repoAbs);
    const stats = await lstat(repoReal);
    if (!stats.isDirectory()) throw new TypeError("repo is not a directory");
  } catch (error) {
    await finishRejected(rejected("invalid_repo", `repo is not a readable directory: ${errorMessage(error)}`));
    return;
  }

  const discovered = kotlinLanguage
    ? await discoverKotlinScopeFiles(repoAbs, repoReal, request.scope)
    : await discoverRustScopeFiles(repoAbs, repoReal, request.scope);
  if (discovered.kind === "rejected") {
    await finishRejected(discovered.error);
    return;
  }
  const discovery = discovered.discovery;

  let adapterOutcome;
  try {
    adapterOutcome = kotlinLanguage
      ? await runKotlinSymbolTable({
          repo: repoAbs,
          language: "kotlin",
          scope: [...request.scope],
          files: [...discovery.files],
          ...(args.symbol === null ? {} : { symbol: args.symbol }),
          ...(args.file === null ? {} : { file: args.file }),
          ignorePolicy: args.ignorePolicy ?? "no_ignore",
        })
      : await runRustSymbolTable({
          repo: repoAbs,
          language: "rust",
          scope: [...request.scope],
          files: [...discovery.files],
          ...(args.symbol === null ? {} : { symbol: args.symbol }),
          ...(args.file === null ? {} : { file: args.file }),
          ...(args.edition === null ? {} : { edition: args.edition }),
        });
  } catch (error) {
    const logging = logRun === null ? failedUsageLog("LOG_WRITE_FAILED") : logRun.status();
    reportSymbolsError("execute", error, {
      cliVersion,
      runId,
      logging,
      logWriteError: logWriteErrorFromLogging(logging),
    });
    return;
  }
  if (adapterOutcome.status !== "ok") {
    await finishRejected(rejected(adapterOutcome.reasonCode, adapterOutcome.message));
    return;
  }

  const base = adapterOutcome.result;
  const macroBoundaries = "macroBoundaries" in base ? base.macroBoundaries.length : 0;
  const skipped = mergeSkipped(base.coverage.skipped, discovery.skipped);
  const partialReasons = mergeReasons(base.coverage.partialReasons, discovery.partialReasons);
  const coverage: Record<string, unknown> = {
    ...base.coverage,
    skipped,
    partial: base.coverage.partial || skipped.length > 0 || partialReasons.length > 0,
    partialReasons,
    ignorePolicy,
  };

  if (logRun !== null) {
    await logRun.finish({
      outcome: {
        stage: "completed",
        exitCode: EXIT_CODES.ok,
        language: base.language,
        symbols: base.symbols.length,
        macroBoundaries,
        partial: coverage.partial === true,
        skipped: skipped.length,
      },
      coverage,
      resultReceipt: {
        symbols: base.symbols.length,
        macroBoundaries,
        files: discovery.files.length,
      },
      error: null,
    });
  }
  const logging = logRun === null ? disabledUsageLog() : logRun.status();
  const logWriteError = logWriteErrorFromLogging(logging);
  if (logWriteError !== null) {
    process.stderr.write(`${JSON.stringify({ warning: logWriteError })}\n`);
  }

  writeJson(
    {
      ...base,
      coverage,
      ...(logWriteError === null ? {} : { logWriteError }),
      cliVersion,
      runId,
      logging,
      runLogPath: logging.runLogPath,
    },
    args.compact,
  );
  process.exitCode = EXIT_CODES.ok;
}
