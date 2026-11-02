// Java single-file symbol-table adapter. Backend is the fixed JDK
// `javac` compiler-tree driver `ExtractJavaSymbols` (public
// `com.sun.source`/`javax.tools` APIs only). One batch JVM is started per
// request and its NDJSON stdout is consumed line by line so that symbols from
// already-completed files survive a mid-batch JVM failure. Directory
// enumeration, ignore handling, and scope dedup are owned by the public entry;
// this module processes an explicit list of repo-relative regular Java files,
// never follows symlinks, and skips non-regular entries.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectJavaSymbolTableResult,
  validateJavaSymbolRequest,
  type JavaCoverageRecord,
  type JavaDeclaredIn,
  type JavaIgnorePolicy,
  type JavaNameSpanSource,
  type JavaOwnerKind,
  type JavaParserRecord,
  type JavaSpan,
  type JavaSymbolKind,
  type JavaSymbolRecord,
  type JavaSymbolTableOutcome,
  type JavaSyntaxError,
  type JavaSyntaxErrorFile,
  type JavaVisibility,
} from "../../filters/java-symbol-table-policy.js";

const REQUIRED_JAVA_MAJOR = 17;

export type JavaSymbolTableAdapterOptions = Readonly<{
  javaBin?: string;
  driverClassDir?: string;
  timeoutMs?: number;
}>;

type FileFailure = Readonly<{ file: string; reason: string }>;

type SelectedFiles = Readonly<{
  files: readonly string[];
  skipped: readonly FileFailure[];
  failed: readonly FileFailure[];
}>;

type JavaFileReport = Readonly<{
  file: string;
  parseStatus: "complete" | "partial_syntax_error";
  syntaxErrorCount: number;
  syntaxErrors: readonly JavaSyntaxError[];
  failed: boolean;
  failureReason?: string;
  unconfirmedNameSpans: number;
  symbols: readonly JavaSymbolRecord[];
}>;

type JavaSummary = Readonly<{
  jdkVersion: string;
  peakJvmUsedBytes: number;
  jvmMaxMemoryBytes: number;
}>;

function rejected(reasonCode: string, message: string): JavaSymbolTableOutcome {
  return Object.freeze({ status: "rejected", reasonCode, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function probeJavaTool(candidate: string): boolean {
  const run = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (run.error !== undefined || run.status !== 0) return false;
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const match = /(?:java|openjdk)\s+(\d+)/i.exec(output) ?? /version\s+"?(\d+)/i.exec(output);
  if (match === null) return false;
  const major = Number.parseInt(match[1] ?? "0", 10);
  return Number.isSafeInteger(major) && major >= REQUIRED_JAVA_MAJOR;
}

function resolveJava(options: JavaSymbolTableAdapterOptions): { path: string | null; label: string } {
  if (options.javaBin !== undefined && options.javaBin.length > 0) {
    // An explicit caller/test injection is trusted without probing.
    return { path: options.javaBin, label: options.javaBin };
  }
  const candidates: Array<{ path: string; label: string }> = [];
  for (const envName of ["NN_CODE_JAVA_BIN", "NN_CODE_KOTLIN_JAVA_BIN"]) {
    const value = process.env[envName];
    if (value !== undefined && value.length > 0) {
      candidates.push({ path: value, label: value });
    }
  }
  const javaHome = process.env.JAVA_HOME;
  if (javaHome !== undefined && javaHome.length > 0) {
    candidates.push({ path: path.join(javaHome, "bin", "java"), label: `$JAVA_HOME/bin/java` });
  }
  candidates.push({ path: "/opt/homebrew/opt/openjdk@17/bin/java", label: "openjdk@17" });
  const fromPath = findOnPath("java");
  if (fromPath !== null) candidates.push({ path: fromPath, label: fromPath });

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    if (probeJavaTool(candidate.path)) return candidate;
  }
  return { path: null, label: "java" };
}

// Directory enumeration, ignore handling, and scope dedup belong to the
// public entry. This layer only verifies the explicit repo-relative file list
// it was handed: symlinks are never followed and non-regular files are skipped.
async function selectFiles(repoAbs: string, entries: readonly string[]): Promise<SelectedFiles> {
  const files: string[] = [];
  const skipped: FileFailure[] = [];
  const failed: FileFailure[] = [];
  const seen = new Set<string>();
  let physicalRepo: string | null = null;

  for (const rawEntry of entries) {
    const file = rawEntry.replace(/\\/g, "/");
    const abs = path.resolve(repoAbs, file);
    if (seen.has(abs)) continue;
    seen.add(abs);

    if (file.includes("\n") || file.includes("\r")) {
      skipped.push({ file, reason: "path_contains_newline" });
      continue;
    }

    const components = file.split("/");
    let current = repoAbs;
    let finalIsFile = false;
    let excluded = false;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index] ?? "");
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        failed.push({ file, reason: `stat_failed: ${errorMessage(error)}` });
        excluded = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        skipped.push({ file, reason: "symlink_not_followed" });
        excluded = true;
        break;
      }
      if (index === components.length - 1) {
        finalIsFile = stats.isFile();
      }
    }
    if (excluded) continue;
    if (!finalIsFile) {
      skipped.push({ file, reason: "not_regular_file" });
      continue;
    }
    try {
      physicalRepo ??= await realpath(repoAbs);
      const physicalFile = await realpath(current);
      if (physicalFile !== physicalRepo && !physicalFile.startsWith(physicalRepo + path.sep)) {
        skipped.push({ file, reason: "outside_repo" });
        continue;
      }
    } catch (error) {
      failed.push({ file, reason: `realpath_failed: ${errorMessage(error)}` });
      continue;
    }
    files.push(file);
  }

  files.sort();
  return Object.freeze({
    files: Object.freeze(files),
    skipped: Object.freeze(skipped),
    failed: Object.freeze(failed),
  });
}

function readStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
  return Object.freeze(value as string[]);
}

function readSpan(value: unknown): JavaSpan {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("span must be an object");
  }
  const span = value as Record<string, unknown>;
  for (const key of ["startLine", "startCol", "endLine", "endCol"]) {
    if (typeof span[key] !== "number" || !Number.isSafeInteger(span[key])) {
      throw new TypeError(`span.${key} must be an integer`);
    }
  }
  return Object.freeze({
    startLine: span["startLine"] as number,
    startCol: span["startCol"] as number,
    endLine: span["endLine"] as number,
    endCol: span["endCol"] as number,
  });
}

function readSymbol(value: unknown): JavaSymbolRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("symbol must be an object");
  }
  const record = value as Record<string, unknown>;
  const required = ["symbolId", "name", "kind", "file", "declSpan", "lexicalScope", "visibility", "declaredIn", "parseStatus"];
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`symbol.${key} is missing`);
    }
  }
  const lexicalScope = readStringArray(record["lexicalScope"], "symbol.lexicalScope");
  const modifiers = readStringArray(record["modifiers"], "symbol.modifiers");
  return Object.freeze({
    symbolId: String(record["symbolId"]),
    name: String(record["name"]),
    kind: record["kind"] as JavaSymbolKind,
    file: String(record["file"]),
    declSpan: readSpan(record["declSpan"]),
    nameSpan: record["nameSpan"] === null || record["nameSpan"] === undefined ? null : readSpan(record["nameSpan"]),
    nameSpanSource: (record["nameSpanSource"] ?? "unknown") as JavaNameSpanSource,
    packageName: record["packageName"] === null || record["packageName"] === undefined ? null : String(record["packageName"]),
    lexicalScope,
    ownerType: record["ownerType"] === null || record["ownerType"] === undefined ? null : String(record["ownerType"]),
    ownerKind: record["ownerKind"] === null || record["ownerKind"] === undefined ? null : (record["ownerKind"] as JavaOwnerKind),
    modifiers,
    visibility: record["visibility"] as JavaVisibility,
    declaredIn: record["declaredIn"] as JavaDeclaredIn,
    parseStatus: record["parseStatus"] === "partial_syntax_error" ? "partial_syntax_error" : "complete",
  });
}

function readSyntaxError(value: unknown): JavaSyntaxError {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("syntax error must be an object");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    line: Number(record["line"] ?? 0),
    column: Number(record["column"] ?? 0),
    message: String(record["message"] ?? ""),
  });
}

function readFileReport(value: unknown): JavaFileReport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("file report must be an object");
  }
  const record = value as Record<string, unknown>;
  const syntaxErrors = Array.isArray(record["syntaxErrors"])
    ? Object.freeze((record["syntaxErrors"] as unknown[]).map(readSyntaxError))
    : Object.freeze([]);
  const symbols = Array.isArray(record["symbols"])
    ? Object.freeze((record["symbols"] as unknown[]).map(readSymbol))
    : Object.freeze([]);
  return Object.freeze({
    file: String(record["file"] ?? ""),
    parseStatus: record["parseStatus"] === "partial_syntax_error" ? "partial_syntax_error" : "complete",
    syntaxErrorCount: Number(record["syntaxErrorCount"] ?? syntaxErrors.length),
    syntaxErrors,
    failed: record["failed"] === true,
    ...(record["failureReason"] === undefined ? {} : { failureReason: String(record["failureReason"]) }),
    unconfirmedNameSpans: Number(record["unconfirmedNameSpans"] ?? 0),
    symbols,
  });
}

function readSummary(value: unknown): JavaSummary {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("summary must be an object");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    jdkVersion: String(record["jdkVersion"] ?? "unknown"),
    peakJvmUsedBytes: Number(record["peakJvmUsedBytes"] ?? 0),
    jvmMaxMemoryBytes: Number(record["jvmMaxMemoryBytes"] ?? 0),
  });
}

type StreamResult = Readonly<{
  reports: readonly JavaFileReport[];
  summary: JavaSummary | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
}>;

function streamDriver(
  javaBin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<StreamResult> {
  return new Promise(resolveOutcome => {
    const reports: JavaFileReport[] = [];
    let summary: JavaSummary | null = null;
    let stderr = "";
    let timedOut = false;
    const child = spawn(javaBin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = child.stdout;
    if (stdout === null) {
      resolveOutcome({ reports, summary, exitCode: null, signal: null, timedOut, stderr: "no stdout pipe" });
      return;
    }
    const reader = createInterface({ input: stdout });
    reader.on("line", line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        stderr += `invalid NDJSON line: ${trimmed.slice(0, 200)}\n`;
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const type = (parsed as Record<string, unknown>)["type"];
      try {
        if (type === "file") {
          reports.push(readFileReport(parsed));
        } else if (type === "summary") {
          summary = readSummary(parsed);
        }
      } catch (error) {
        stderr += `invalid driver line: ${errorMessage(error)}\n`;
      }
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    timer?.unref?.();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timer !== null) clearTimeout(timer);
      resolveOutcome({ reports, summary, exitCode, signal, timedOut, stderr });
    };
    child.on("error", error => {
      stderr += `failed to start java: ${errorMessage(error)}\n`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export async function runJavaSymbolTable(
  rawRequest: unknown,
  options: JavaSymbolTableAdapterOptions = {},
): Promise<JavaSymbolTableOutcome> {
  const validation = validateJavaSymbolRequest(rawRequest);
  if (!validation.ok) {
    return validation.error;
  }
  const request = validation.request;
  if (request.ignorePolicy === "respect_vcs_ignore") {
    return rejected("capability_missing", "respect_vcs_ignore requires ripgrep, which is not wired for this slice");
  }

  const repoAbs = path.resolve(request.repo);
  const selected = await selectFiles(repoAbs, request.files);
  const files = selected.files;

  if (files.length === 0) {
    const coverage: JavaCoverageRecord = Object.freeze({
      scopeFilesDiscovered: selected.skipped.length,
      scopeFilesParsed: 0,
      scopeFilesFailed: selected.failed,
      skipped: selected.skipped,
      syntaxErrorFiles: Object.freeze([]),
      partial: selected.failed.length > 0 || selected.skipped.length > 0,
      partialReasons: Object.freeze([...selected.failed, ...selected.skipped].map(entry => `${entry.file}: ${entry.reason}`)),
      truncated: false,
      parserInvocations: 0,
      notes: Object.freeze(["no regular java source files supplied"]),
    });
    const parser: JavaParserRecord = Object.freeze({
      backend: "javac_compiler_tree",
      jdkVersion: "unknown",
      invocation: "<no JVM batch started>",
      semanticBinding: false,
    });
    return Object.freeze({ status: "ok", result: projectJavaSymbolTableResult(request, parser, Object.freeze([]), coverage) });
  }

  const java = resolveJava(options);
  const driverClassDir = options.driverClassDir
    ?? path.resolve(dirname(fileURLToPath(import.meta.url)), "java-symbol-jvm");
  const classFile = path.join(driverClassDir, "ExtractJavaSymbols.class");
  if (java.path === null || !existsSync(java.path)) {
    return rejected(
      "JAVA_COMPILER_UNAVAILABLE",
      `missing JDK 17+ java runtime: ${java.path ?? java.label}`,
    );
  }
  if (!existsSync(classFile)) {
    return rejected(
      "JAVA_DRIVER_NOT_BUILT",
      `missing ExtractJavaSymbols.class; run node scripts/build-java-symbol-jvm.mjs (looked for ${classFile})`,
    );
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "nnanything-java-symbols-"));
  const argFile = path.join(tempDir, "files.txt");
  writeFileSync(argFile, `${files.join("\n")}\n`, "utf8");
  const args = [
    "-Dfile.encoding=UTF-8",
    "-cp",
    driverClassDir,
    "ExtractJavaSymbols",
    repoAbs,
    argFile,
  ];
  const invocation = `${java.path} -Dfile.encoding=UTF-8 -cp ${driverClassDir} ExtractJavaSymbols <repo> <argFile>`;
  try {
    const streamed = await streamDriver(java.path, args, options.timeoutMs ?? 180_000);
    const completedFiles = new Set(streamed.reports.map(report => report.file));
    const unprocessed = files.filter(file => !completedFiles.has(file));
    const interrupted = unprocessed.length > 0;
    const interruptionReason = interrupted
      ? `jvm_batch_interrupted: ${streamed.timedOut ? "timeout" : (streamed.signal ?? String(streamed.exitCode))}`
      : null;

    const parsedReports = streamed.reports.filter(report => !report.failed);
    const failedReports = streamed.reports.filter(report => report.failed);
    const scopeFilesFailed = Object.freeze([
      ...selected.failed,
      ...failedReports.map(report => ({ file: report.file, reason: report.failureReason ?? "parse_failed" })),
      ...unprocessed.map(file => ({ file, reason: interruptionReason ?? "unprocessed" })),
    ]);
    const syntaxErrorFiles: readonly JavaSyntaxErrorFile[] = Object.freeze(
      parsedReports
        .filter(report => report.parseStatus === "partial_syntax_error" && report.syntaxErrors.length > 0)
        .map(report => Object.freeze({ file: report.file, errors: report.syntaxErrors })),
    );
    const unconfirmedNameSpans = parsedReports.reduce((sum, report) => sum + report.unconfirmedNameSpans, 0);
    const partialReasons = Object.freeze([
      ...selected.failed.map(entry => `${entry.file}: ${entry.reason}`),
      ...selected.skipped.map(entry => `${entry.file}: ${entry.reason}`),
      ...failedReports.map(entry => `${entry.file}: ${entry.failureReason ?? "parse_failed"}`),
      ...syntaxErrorFiles.map(entry => `${entry.file}: partial_syntax_error`),
      ...(unconfirmedNameSpans > 0 ? ["unconfirmed_name_span"] : []),
      ...(interrupted ? [`jvm_batch_interrupted_after_${streamed.reports.length}_of_${files.length}_files`] : []),
    ]);
    const partial = scopeFilesFailed.length > 0
      || selected.skipped.length > 0
      || syntaxErrorFiles.length > 0
      || unconfirmedNameSpans > 0
      || interrupted;
    const symbols = Object.freeze(parsedReports.flatMap(report => report.symbols.map(symbol => Object.freeze({ ...symbol }))));
    const notes = Object.freeze([
      `ignorePolicy=${request.ignorePolicy}`,
      "symlinks are never followed in any path component; duplicate file entries are deduplicated by resolved path",
      `peakJvmUsedBytes=${streamed.summary?.peakJvmUsedBytes ?? 0}; jvmMaxMemoryBytes=${streamed.summary?.jvmMaxMemoryBytes ?? 0}`,
      "semanticBinding=false; parse-only compiler trees without classpath or module resolution",
    ]);
    const coverage: JavaCoverageRecord = Object.freeze({
      scopeFilesDiscovered: files.length + selected.skipped.length,
      scopeFilesParsed: parsedReports.length,
      scopeFilesFailed,
      skipped: selected.skipped,
      syntaxErrorFiles,
      partial,
      partialReasons,
      truncated: false,
      parserInvocations: 1,
      notes,
    });
    const parser: JavaParserRecord = Object.freeze({
      backend: "javac_compiler_tree",
      jdkVersion: streamed.summary?.jdkVersion ?? "unknown",
      invocation,
      semanticBinding: false,
    });
    return Object.freeze({
      status: "ok",
      result: projectJavaSymbolTableResult(request, parser, symbols, coverage),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createJavaSymbolTableAdapter(
  options: JavaSymbolTableAdapterOptions = {},
): Readonly<{
  symbols: (request: unknown) => Promise<JavaSymbolTableOutcome>;
}> {
  return Object.freeze({
    symbols: (request: unknown) => runJavaSymbolTable(request, options),
  });
}
