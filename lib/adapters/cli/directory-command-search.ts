import { spawn } from "node:child_process";
import { accessSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Command-level recursive directory search executor for the SC product
 * integration slice. It owns the fs PATH probe, ripgrep/grep/find argument
 * construction, streaming process capture, incremental cross-chunk parsing
 * and exit-code coverage classification. It never generates shell text and
 * never reads outside the physical directory passed by the sandbox.
 */

export type CommandSearchFileFilter = Readonly<{
  exactBasename?: string;
  suffix?: string;
}>;

export type CommandSearchIgnorePolicy = "no_ignore" | "respect_vcs_ignore";

export type CommandSearchLimits = Readonly<{
  maxStdoutBytes?: number;
  maxDepth?: number;
  timeoutMs?: number;
}>;

export type CliCommandFileFilter = CommandSearchFileFilter;
export type CliCommandIgnorePolicy = CommandSearchIgnorePolicy;
export type CliCommandSearchLimits = CommandSearchLimits;

export type CommandSearchTool =
  | "rg"
  | "rg_files"
  | "grep_bsd"
  | "grep_gnu"
  | "find_P";

export type CommandMatchedLineRecord = Readonly<{
  relPath: string;
  lineNumber: number;
  lineByteLength: number;
  lineText: string;
  matchedLineHasTrailingLF: boolean | "unobservable_in_grep_stream";
}>;

export type CommandSpawnLedgerEntry = Readonly<{
  purpose: "search_command" | "probe_grep_version";
  toolUsed?: CommandSearchTool;
  cmd: string;
  args: readonly string[];
  cwd?: string;
  exitCode: number | null;
  stdoutBytesRead?: number;
  stdoutChunkCount?: number;
  crossChunkRecordSplits?: number;
  unterminatedRemainderBytes?: number;
}>;

export type CommandSearchExecResult = Readonly<{
  toolUsed: CommandSearchTool;
  executable: string;
  argv: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytesRead: number;
  stdoutChunkCount: number;
  crossChunkRecordSplits: number;
  unterminatedRemainderBytes: number;
  unterminatedFragmentDiscarded: boolean;
  stderr: string;
  normalCompleted: boolean;
  coverage: "complete" | "partial";
  reasons: readonly string[];
  matchedEntries: readonly string[];
  matchedLines: readonly CommandMatchedLineRecord[];
  queryMatches: 1;
  spawnLedger: readonly CommandSpawnLedgerEntry[];
}>;

export type StreamingProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrUtf8: string;
  stdoutBytesRead: number;
  stdoutChunkCount: number;
  stdoutTruncated: boolean;
  timedOut: boolean;
}>;

export function escapeGlobMeta(literal: string): string {
  return String(literal).replace(/([*?[\]{}!\\])/g, "\\$1");
}

/** Pure filesystem PATH lookup with zero child processes (no `which`). */
export function findBinaryOnPathFs(binName: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binName);
    try {
      const st = statSync(candidate);
      if (st.isFile()) {
        accessSync(candidate, 0o1);
        return candidate;
      }
    } catch {
      // continue searching PATH
    }
  }
  return null;
}

export function runStreamingProcess(input: Readonly<{
  cmd: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  onStdoutChunk?: (chunk: Buffer) => void;
}>): Promise<StreamingProcessResult> {
  const {
    cmd,
    args,
    cwd,
    timeoutMs = 60000,
    maxStdoutBytes,
    onStdoutChunk,
  } = input;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderrUtf8 = "";
    let stdoutBytesRead = 0;
    let stdoutChunkCount = 0;
    let stdoutTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutChunkCount += 1;
      const previousBytes = stdoutBytesRead;
      stdoutBytesRead += chunk.length;
      if (maxStdoutBytes !== undefined && stdoutBytesRead > maxStdoutBytes) {
        stdoutTruncated = true;
        const allowedLength = Math.max(0, maxStdoutBytes - previousBytes);
        if (allowedLength > 0 && onStdoutChunk !== undefined) {
          onStdoutChunk(chunk.subarray(0, allowedLength));
        }
        child.kill("SIGTERM");
        return;
      }
      if (onStdoutChunk !== undefined) onStdoutChunk(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrUtf8 += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        signal,
        stderrUtf8,
        stdoutBytesRead,
        stdoutChunkCount,
        stdoutTruncated,
        timedOut,
      });
    });
  });
}

function normalizeRelPath(scopeRoot: string, rawPath: string): string {
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(scopeRoot, rawPath);
  const rel = relative(scopeRoot, resolved);
  return rel.split(sep).join("/");
}

const sep = "/";

function matchesFileFilter(
  relPath: string,
  fileFilter: CommandSearchFileFilter | null,
): boolean {
  if (fileFilter === null) return true;
  const base = basename(relPath);
  if (fileFilter.exactBasename !== undefined && base !== fileFilter.exactBasename) {
    return false;
  }
  if (fileFilter.suffix !== undefined && !relPath.endsWith(fileFilter.suffix)) {
    return false;
  }
  return true;
}

function hasSubdirsBeyondDepth(scopeRoot: string, maxDepth: number): boolean {
  function walk(directory: string, depth: number): boolean {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // An uninspectable subtree cannot be claimed complete.
      return true;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) return true;
        if (walk(join(directory, entry.name), depth + 1)) return true;
      }
    }
    return false;
  }
  return walk(scopeRoot, 0);
}

export type IncrementalStreamResult = Readonly<{
  matchedEntries: readonly string[];
  matchedLines: readonly CommandMatchedLineRecord[];
  crossChunkRecordSplits: number;
  unterminatedRemainderBytes: number;
  unterminatedFragmentDiscarded: boolean;
  parseIncomplete: boolean;
}>;

/**
 * Creates an incremental stream parser. `pushChunk` consumes only records
 * terminated by their record delimiter (`\n` for rg JSON/grep NUL records,
 * `\0` for rg --files/find -print0). A trailing fragment without the closing
 * delimiter is retained, reported as `unterminatedRemainderBytes`, and never
 * flushed as a fake complete match at stream end.
 */
export function createIncrementalStreamParser(input: Readonly<{
  toolUsed: CommandSearchTool;
  scopeRoot: string;
  fileFilter: CommandSearchFileFilter | null;
}>) {
  const { toolUsed, scopeRoot, fileFilter } = input;
  const filteredMatches: CommandMatchedLineRecord[] = [];
  const matchedFileSet = new Set<string>();
  let remainder: Buffer = Buffer.alloc(0);
  let crossChunkRecordSplits = 0;
  let parseIncomplete = false;

  function consumeRgJsonLine(lineBuffer: Buffer): void {
    const line = lineBuffer.toString("utf8").trim();
    if (line.length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) return;
    let rawPath = pathOf(event.data, "path.text");
    if (rawPath === null) {
      const encodedPath = pathOf(event.data, "path.bytes");
      if (encodedPath === null) {
        parseIncomplete = true;
        return;
      }
      const decodedPath = decodeUtf8Base64(encodedPath);
      if (decodedPath === null) {
        parseIncomplete = true;
        return;
      }
      rawPath = decodedPath.text;
    }
    const relPath = normalizeRelPath(scopeRoot, rawPath);
    if (!matchesFileFilter(relPath, fileFilter)) return;
    const rawLineText = pathOf(event.data, "lines.text");
    const encodedLine = pathOf(event.data, "lines.bytes");
    let lineText: string;
    let lineByteLength: number;
    let hasLF: boolean;
    if (rawLineText !== null) {
      hasLF = rawLineText.endsWith("\n");
      lineText = hasLF ? rawLineText.slice(0, -1) : rawLineText;
      lineByteLength = Buffer.byteLength(lineText, "utf8");
    } else if (encodedLine !== null) {
      const decodedLine = decodeUtf8Base64(encodedLine);
      if (decodedLine === null) {
        matchedFileSet.add(relPath);
        parseIncomplete = true;
        return;
      }
      hasLF = decodedLine.bytes.length > 0
        && decodedLine.bytes[decodedLine.bytes.length - 1] === 0x0a;
      lineText = hasLF ? decodedLine.text.slice(0, -1) : decodedLine.text;
      lineByteLength = hasLF ? decodedLine.bytes.length - 1 : decodedLine.bytes.length;
    } else {
      matchedFileSet.add(relPath);
      parseIncomplete = true;
      return;
    }
    const lineNumber = numberOr(event.data, "line_number", -1);
    filteredMatches.push({
      relPath,
      lineNumber,
      lineByteLength,
      lineText: lineText.length <= 4096 ? lineText : `${lineText.slice(0, 256)}...[+${lineText.length - 256} chars]`,
      matchedLineHasTrailingLF: hasLF,
    });
    matchedFileSet.add(relPath);
  }

  function consumeGrepNullRecord(recordBuffer: Buffer): void {
    let offset = 0;
    while (offset < recordBuffer.length) {
      const nulIndex = recordBuffer.indexOf(0x00, offset);
      if (nulIndex === -1) break;
      const colonIndex = recordBuffer.indexOf(0x3a, nulIndex + 1);
      if (colonIndex === -1) break;
      const lfIndex = recordBuffer.indexOf(0x0a, colonIndex + 1);
      if (lfIndex === -1) break;
      const rawFilePath = recordBuffer.subarray(offset, nulIndex).toString("utf8");
      const lineNumber = Number.parseInt(recordBuffer.subarray(nulIndex + 1, colonIndex).toString("ascii"), 10);
      const byteLength = lfIndex - (colonIndex + 1);
      const lineSlice = recordBuffer.subarray(colonIndex + 1, lfIndex);
      const lineText = byteLength <= 4096
        ? lineSlice.toString("utf8")
        : `${lineSlice.subarray(0, 256).toString("utf8")}...[+${byteLength - 256} bytes]`;
      const relPath = normalizeRelPath(scopeRoot, rawFilePath);
      if (matchesFileFilter(relPath, fileFilter)) {
        filteredMatches.push({
          relPath,
          lineNumber,
          lineByteLength: byteLength,
          lineText,
          matchedLineHasTrailingLF: "unobservable_in_grep_stream",
        });
        matchedFileSet.add(relPath);
      }
      offset = lfIndex + 1;
    }
  }

  function pushChunk(chunk: Buffer): void {
    const hadCarryover = remainder.length > 0;
    remainder = hadCarryover ? Buffer.concat([remainder, chunk]) : chunk;
    if (toolUsed === "rg") {
      let start = 0;
      let completedInChunk = 0;
      while (true) {
        const lfIndex = remainder.indexOf(0x0a, start);
        if (lfIndex === -1) break;
        consumeRgJsonLine(remainder.subarray(start, lfIndex));
        completedInChunk += 1;
        start = lfIndex + 1;
      }
      if (hadCarryover && completedInChunk > 0) crossChunkRecordSplits += 1;
      remainder = remainder.subarray(start);
      return;
    }
    if (toolUsed === "grep_bsd" || toolUsed === "grep_gnu") {
      const beforeCount = filteredMatches.length;
      consumeGrepNullRecord(remainder);
      if (hadCarryover && filteredMatches.length > beforeCount) crossChunkRecordSplits += 1;
      // Remainder after the last complete record is retained. Because the
      // grep record parser only consumes null-terminated path + line fields
      // and waits for the terminating LF, the slice inside consumeGrepNullRecord
      // advances; recompute the unused tail by re-parsing offsets.
      remainder = remainderAfterGrepRecords(remainder);
      return;
    }
    if (toolUsed === "rg_files" || toolUsed === "find_P") {
      let start = 0;
      let completedInChunk = 0;
      while (true) {
        const nulIndex = remainder.indexOf(0x00, start);
        if (nulIndex === -1) break;
        if (nulIndex > start) {
          const rawPath = remainder.subarray(start, nulIndex).toString("utf8");
          const relPath = normalizeRelPath(scopeRoot, rawPath);
          if (matchesFileFilter(relPath, fileFilter)) matchedFileSet.add(relPath);
          completedInChunk += 1;
        }
        start = nulIndex + 1;
      }
      if (hadCarryover && completedInChunk > 0) crossChunkRecordSplits += 1;
      remainder = remainder.subarray(start);
    }
  }

  function remainderAfterGrepRecords(buffer: Buffer): Buffer {
    let offset = 0;
    while (offset < buffer.length) {
      const nulIndex = buffer.indexOf(0x00, offset);
      if (nulIndex === -1) break;
      const colonIndex = buffer.indexOf(0x3a, nulIndex + 1);
      if (colonIndex === -1) break;
      const lfIndex = buffer.indexOf(0x0a, colonIndex + 1);
      if (lfIndex === -1) break;
      offset = lfIndex + 1;
    }
    return buffer.subarray(offset);
  }

  function finish(): IncrementalStreamResult {
    return {
      matchedEntries: Array.from(matchedFileSet).sort(),
      matchedLines: Object.freeze([...filteredMatches]),
      crossChunkRecordSplits,
      unterminatedRemainderBytes: remainder.length,
      unterminatedFragmentDiscarded: remainder.length > 0,
      parseIncomplete,
    };
  }

  return { pushChunk, finish };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeUtf8Base64(value: string): Readonly<{ bytes: Buffer; text: string }> | null {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0) return null;
    return Object.freeze({
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    });
  } catch {
    return null;
  }
}

function pathOf(record: Record<string, unknown>, dotted: string): string | null {
  let current: unknown = record;
  for (const part of dotted.split(".")) {
    if (!isRecord(current)) return null;
    if (!Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

function numberOr(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveCommands(input: Readonly<{
  needGrepFlavor: boolean;
  respectVcsIgnore: boolean;
  spawnLedger: CommandSpawnLedgerEntry[];
}>): Promise<Readonly<{
  rg: string | null;
  grep: string | null;
  grepFlavor: "unprobed" | "bsd" | "gnu";
  find: string | null;
}>> {
  return resolveCapabilities(input.needGrepFlavor, input.respectVcsIgnore, input.spawnLedger);
}

export async function resolveCapabilities(
  needGrepFlavor: boolean,
  respectVcsIgnore = false,
  spawnLedger: CommandSpawnLedgerEntry[] = [],
): Promise<Readonly<{
  rg: string | null;
  grep: string | null;
  grepFlavor: "unprobed" | "bsd" | "gnu";
  find: string | null;
}>> {
  const rg = findBinaryOnPathFs("rg");
  const grep = findBinaryOnPathFs("grep");
  const find = findBinaryOnPathFs("find");
  if (respectVcsIgnore && rg === null) {
    throw new TypeError("respect_vcs_ignore requires ripgrep on PATH");
  }
  let grepFlavor: "unprobed" | "bsd" | "gnu" = "unprobed";
  if (needGrepFlavor && grep !== null) {
    let versionOutput = "";
    const versionResult = await runStreamingProcess({
      cmd: grep,
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 10000,
      onStdoutChunk: (chunk) => {
        versionOutput += chunk.toString("utf8");
      },
    });
    spawnLedger.push({
      purpose: "probe_grep_version",
      cmd: grep,
      args: ["--version"],
      exitCode: versionResult.exitCode,
    });
    const firstLine = `${versionOutput + (versionResult.stderrUtf8 ?? "")}`.trim().split("\n")[0] ?? "";
    if (firstLine.includes("BSD grep")) grepFlavor = "bsd";
    else if (firstLine.includes("GNU grep")) grepFlavor = "gnu";
  }
  return { rg, grep, grepFlavor, find };
}

function buildSearchArgs(input: Readonly<{
  actionKind: "SEARCH_LITERAL" | "SEARCH_TARGET";
  rg: string | null;
  grep: string | null;
  grepFlavor: "unprobed" | "bsd" | "gnu";
  find: string | null;
  queryLiteral: string;
  fileFilter: CommandSearchFileFilter | null;
  ignorePolicy: CommandSearchIgnorePolicy;
  explicitLimits: CommandSearchLimits | undefined;
}>): Readonly<{
  cmd: string;
  args: readonly string[];
  toolUsed: CommandSearchTool;
}> {
  const { actionKind, rg, grep, grepFlavor, find, queryLiteral, fileFilter, ignorePolicy, explicitLimits } = input;
  const ignoreArgs = ignorePolicy === "no_ignore"
    ? ["--no-ignore", "--hidden"]
    : ["--no-require-git"];
  const depthArgs = explicitLimits?.maxDepth === undefined
    ? []
    : ["--max-depth", String(explicitLimits.maxDepth + 1)];
  const filterArgs: string[] = [];
  if (fileFilter?.exactBasename !== undefined) {
    filterArgs.push("-g", escapeGlobMeta(fileFilter.exactBasename));
  } else if (fileFilter?.suffix !== undefined) {
    filterArgs.push("-g", `*${escapeGlobMeta(fileFilter.suffix)}`);
  }

  if (actionKind === "SEARCH_LITERAL") {
    if (rg !== null) {
      return {
        cmd: rg,
        args: ["--json", "-n", "-F", "--no-follow", ...ignoreArgs, ...depthArgs, ...filterArgs, "-e", queryLiteral, "--", "."],
        toolUsed: "rg",
      };
    }
    if (grep !== null && (grepFlavor === "bsd" || grepFlavor === "gnu")) {
      const noFollowRecursiveArgs = grepFlavor === "bsd" ? ["-R", "-p"] : ["-r"];
      const includeArgs: string[] = [];
      if (fileFilter?.exactBasename !== undefined) {
        includeArgs.push(`--include=${escapeGlobMeta(fileFilter.exactBasename)}`);
      } else if (fileFilter?.suffix !== undefined) {
        includeArgs.push(`--include=*${escapeGlobMeta(fileFilter.suffix)}`);
      }
      return {
        cmd: grep,
        args: ["-H", "--null", ...noFollowRecursiveArgs, "-n", "-F", "-I", ...includeArgs, "-e", queryLiteral, "--", "."],
        toolUsed: grepFlavor === "bsd" ? "grep_bsd" : "grep_gnu",
      };
    }
    throw new TypeError("Neither rg nor grep is available for literal search");
  }

  if (rg !== null) {
    return {
      cmd: rg,
      args: ["--files", "--null", "--no-follow", ...ignoreArgs, ...depthArgs, ...filterArgs, "--", "."],
      toolUsed: "rg_files",
    };
  }
  if (find !== null) {
    const findDepthArgs = explicitLimits?.maxDepth === undefined
      ? []
      : ["-maxdepth", String(explicitLimits.maxDepth + 1)];
    const findFilterArgs: string[] = [];
    if (fileFilter?.exactBasename !== undefined) {
      findFilterArgs.push("-name", escapeGlobMeta(fileFilter.exactBasename));
    } else if (fileFilter?.suffix !== undefined) {
      findFilterArgs.push("-name", `*${escapeGlobMeta(fileFilter.suffix)}`);
    }
    return {
      cmd: find,
      args: ["-P", ".", ...findDepthArgs, "-type", "f", ...findFilterArgs, "-print0"],
      toolUsed: "find_P",
    };
  }
  throw new TypeError("Neither rg nor find is available for target search");
}

export async function runDirectorySearchCommand(input: Readonly<{
  actionKind: "SEARCH_LITERAL" | "SEARCH_TARGET";
  physicalDirectory: string;
  queryLiteral: string;
  fileFilter: CommandSearchFileFilter | null;
  ignorePolicy: CommandSearchIgnorePolicy;
  explicitLimits: CommandSearchLimits | undefined;
  capabilities: Readonly<{
    rg: string | null;
    grep: string | null;
    grepFlavor: "unprobed" | "bsd" | "gnu";
    find: string | null;
  }>;
  spawnLedger: CommandSpawnLedgerEntry[];
}>): Promise<CommandSearchExecResult> {
  const { actionKind, physicalDirectory, queryLiteral, fileFilter, ignorePolicy, explicitLimits, capabilities, spawnLedger } = input;
  const built = buildSearchArgs({
    actionKind,
    rg: capabilities.rg,
    grep: capabilities.grep,
    grepFlavor: capabilities.grepFlavor,
    find: capabilities.find,
    queryLiteral,
    fileFilter,
    ignorePolicy,
    explicitLimits,
  });
  if (
    (built.toolUsed === "grep_bsd" || built.toolUsed === "grep_gnu")
    && explicitLimits?.maxDepth !== undefined
  ) {
    throw Object.assign(
      new TypeError("grep search does not support an explicit maxDepth"),
      { code: "UNSUPPORTED_GREP_MAX_DEPTH" },
    );
  }
  const streamParser = createIncrementalStreamParser({
    toolUsed: built.toolUsed,
    scopeRoot: physicalDirectory,
    fileFilter,
  });
  const stream = await runStreamingProcess({
    cmd: built.cmd,
    args: built.args,
    cwd: physicalDirectory,
    timeoutMs: explicitLimits?.timeoutMs ?? 60000,
    ...(explicitLimits?.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: explicitLimits.maxStdoutBytes }),
    onStdoutChunk: (chunk) => streamParser.pushChunk(chunk),
  });
  const parsed = streamParser.finish();
  spawnLedger.push({
    purpose: "search_command",
    toolUsed: built.toolUsed,
    cmd: built.cmd,
    args: built.args,
    cwd: physicalDirectory,
    exitCode: stream.exitCode,
    stdoutBytesRead: stream.stdoutBytesRead,
    stdoutChunkCount: stream.stdoutChunkCount,
    crossChunkRecordSplits: parsed.crossChunkRecordSplits,
    unterminatedRemainderBytes: parsed.unterminatedRemainderBytes,
  });
  const reasons: string[] = [];
  let normalCompleted = false;
  let coverage: "complete" | "partial" = "complete";

  if (stream.timedOut) {
    normalCompleted = false;
    coverage = "partial";
    reasons.push("timeout");
  } else if (stream.stdoutTruncated) {
    normalCompleted = false;
    coverage = "partial";
    reasons.push("stdout_max_bytes_exceeded");
  } else if (parsed.unterminatedRemainderBytes > 0) {
    normalCompleted = false;
    coverage = "partial";
    reasons.push("unterminated_stdout_fragment");
  } else {
    const textToolExitOk =
      (stream.exitCode === 0 || stream.exitCode === 1) && stream.stderrUtf8.length === 0;
    const findExitOk = stream.exitCode === 0 && stream.stderrUtf8.length === 0;
    const exitedOk = built.toolUsed === "find_P" ? findExitOk : textToolExitOk;
    if (exitedOk) {
      normalCompleted = true;
      coverage = "complete";
    } else {
      normalCompleted = false;
      coverage = "partial";
      if (
        stream.stderrUtf8.includes("Permission denied") ||
        stream.stderrUtf8.includes("Operation not permitted") ||
        (built.toolUsed === "find_P" && stream.exitCode === 1)
      ) {
        reasons.push("permission_denied");
      } else {
        reasons.push("command_partial_or_error");
      }
    }
  }

  if (parsed.parseIncomplete) {
    normalCompleted = false;
    coverage = "partial";
    if (!reasons.includes("unrepresentable_byte_record")) {
      reasons.push("unrepresentable_byte_record");
    }
  }

  if (explicitLimits?.maxDepth !== undefined && hasSubdirsBeyondDepth(physicalDirectory, explicitLimits.maxDepth)) {
    normalCompleted = false;
    coverage = "partial";
    if (!reasons.includes("depth_limit")) reasons.push("depth_limit");
  }

  return {
    toolUsed: built.toolUsed,
    executable: built.cmd,
    argv: Object.freeze([...built.args]),
    exitCode: stream.exitCode,
    signal: stream.signal,
    stdoutBytesRead: stream.stdoutBytesRead,
    stdoutChunkCount: stream.stdoutChunkCount,
    crossChunkRecordSplits: parsed.crossChunkRecordSplits,
    unterminatedRemainderBytes: parsed.unterminatedRemainderBytes,
    unterminatedFragmentDiscarded: parsed.unterminatedFragmentDiscarded,
    stderr: stream.stderrUtf8,
    normalCompleted,
    coverage,
    reasons: Object.freeze(reasons),
    matchedEntries: parsed.matchedEntries,
    matchedLines: parsed.matchedLines,
    queryMatches: 1,
    spawnLedger: Object.freeze([...spawnLedger]),
  };
}
