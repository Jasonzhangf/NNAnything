// Kotlin single-file symbol-table adapter. Backend is the fixed Kotlin PSI JVM
// driver `ExtractKotlinSymbols`. One batch JVM is started per request and its
// JSON stdout is parsed as the unified `nnanything.cli-symbols.result.v1`
// result. Directory enumeration, ignore handling, and scope dedup are owned by
// the public entry; this module processes an explicit list of repo-relative
// regular Kotlin files, never follows symlinks, and skips non-regular entries.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectKotlinSymbolTableResult,
  validateKotlinSymbolRequest,
  type KotlinCoverageRecord,
  type KotlinDeclaredIn,
  type KotlinIgnorePolicy,
  type KotlinOwnerKind,
  type KotlinParserRecord,
  type KotlinPsiError,
  type KotlinPsiErrorFile,
  type KotlinSpan,
  type KotlinSymbolKind,
  type KotlinSymbolRecord,
  type KotlinSymbolTableOutcome,
  type KotlinVisibility,
} from "../../filters/kotlin-symbol-table-policy.js";

const JAVA_BIN = "/opt/homebrew/opt/openjdk@17/bin/java";

const KOTLIN_JARS = Object.freeze([
  "/Users/fanzhang/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.0/8cfa2b049a4006d94474296df4abd9b50f288821/kotlin-compiler-embeddable-2.2.0.jar",
  "/Users/fanzhang/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.2.0/fdfc65fbc42fda253a26f61dac3c0aca335fae96/kotlin-stdlib-2.2.0.jar",
  "/Users/fanzhang/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0/ac1dc37a30a93150b704022f8d895ee1bd3a36b3/kotlinx-coroutines-core-jvm-1.8.0.jar",
  "/Users/fanzhang/.gradle/caches/modules-2/files-2.1/org.jetbrains.intellij.deps/trove4j/1.0.20200330/3afb14d5f9ceb459d724e907a21145e8ff394f02/trove4j-1.0.20200330.jar",
]);

export type KotlinSymbolTableAdapterOptions = Readonly<{
  javaBin?: string;
  kotlinJars?: readonly string[];
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
  psiErrorCount: number;
  psiErrors: readonly KotlinPsiError[];
  symbolCount: number;
  failed: boolean;
  failureReason?: string;
}>;

type JavaPayload = Readonly<{
  peakJvmUsedBytes: number;
  jvmMaxMemoryBytes: number;
  fileReports: readonly JavaFileReport[];
  symbols: readonly KotlinSymbolRecord[];
}>;

function rejected(reasonCode: string, message: string): KotlinSymbolTableOutcome {
  return Object.freeze({ status: "rejected", reasonCode, message });
}

// Directory enumeration, ignore handling, and scope dedup belong to the
// public entry. This layer only verifies the explicit repo-relative file list
// it was handed: symlinks are never followed and non-regular files are skipped.
async function selectFiles(
  repoAbs: string,
  entries: readonly string[],
): Promise<SelectedFiles> {
  const files: string[] = [];
  const skipped: FileFailure[] = [];
  const failed: FileFailure[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    const file = rawEntry.replace(/\\/g, "/");
    const abs = path.resolve(repoAbs, file);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);

    let stats;
    try {
      stats = await lstat(abs);
    } catch (error) {
      failed.push({ file, reason: `stat_failed: ${(error as Error).message}` });
      continue;
    }
    if (stats.isSymbolicLink()) {
      skipped.push({ file, reason: "symlink_not_followed" });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ file, reason: "not_regular_file" });
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

function readSpan(value: unknown): KotlinSpan {
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

function readSymbol(value: unknown): KotlinSymbolRecord {
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
    symbolId: record["symbolId"] as string,
    name: record["name"] as string,
    kind: record["kind"] as KotlinSymbolKind,
    file: record["file"] as string,
    declSpan: readSpan(record["declSpan"]),
    nameSpan: record["nameSpan"] === null || record["nameSpan"] === undefined ? null : readSpan(record["nameSpan"]),
    nameSpanSource: String(record["nameSpanSource"] ?? ""),
    lexicalScope,
    ownerType: record["ownerType"] === null || record["ownerType"] === undefined ? null : String(record["ownerType"]),
    ownerKind: record["ownerKind"] === null || record["ownerKind"] === undefined ? null : record["ownerKind"] as KotlinOwnerKind,
    receiverType: record["receiverType"] === null || record["receiverType"] === undefined ? null : String(record["receiverType"]),
    modifiers,
    visibility: record["visibility"] as KotlinVisibility,
    declaredIn: record["declaredIn"] as KotlinDeclaredIn,
    parseStatus: record["parseStatus"] as "complete" | "partial_syntax_error",
  });
}

function readPsiError(value: unknown): KotlinPsiError {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("psi error must be an object");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    line: record["line"] as number,
    column: record["column"] as number,
    errorDescription: String(record["errorDescription"] ?? ""),
  });
}

function readFileReport(value: unknown): JavaFileReport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("file report must be an object");
  }
  const record = value as Record<string, unknown>;
  const psiErrors = Array.isArray(record["psiErrors"])
    ? Object.freeze((record["psiErrors"] as unknown[]).map(readPsiError))
    : Object.freeze([]);
  return Object.freeze({
    file: String(record["file"] ?? ""),
    parseStatus: record["parseStatus"] === "partial_syntax_error" ? "partial_syntax_error" : "complete",
    psiErrorCount: Number(record["psiErrorCount"] ?? 0),
    psiErrors,
    symbolCount: Number(record["symbolCount"] ?? 0),
    failed: record["failed"] === true,
    ...(record["failureReason"] === undefined ? {} : { failureReason: String(record["failureReason"]) }),
  });
}

function readJavaPayload(value: unknown): JavaPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("JVM driver output must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["fileReports"]) || !Array.isArray(record["symbols"])) {
    throw new TypeError("JVM driver output must contain fileReports and symbols arrays");
  }
  return Object.freeze({
    peakJvmUsedBytes: Number(record["peakJvmUsedBytes"] ?? 0),
    jvmMaxMemoryBytes: Number(record["jvmMaxMemoryBytes"] ?? 0),
    fileReports: Object.freeze((record["fileReports"] as unknown[]).map(readFileReport)),
    symbols: Object.freeze((record["symbols"] as unknown[]).map(readSymbol)),
  });
}

export async function runKotlinSymbolTable(
  rawRequest: unknown,
  options: KotlinSymbolTableAdapterOptions = {},
): Promise<KotlinSymbolTableOutcome> {
  const validation = validateKotlinSymbolRequest(rawRequest);
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
    const coverage: KotlinCoverageRecord = Object.freeze({
      scopeFilesDiscovered: selected.skipped.length,
      scopeFilesParsed: 0,
      scopeFilesFailed: selected.failed,
      skipped: selected.skipped,
      psiErrorFiles: Object.freeze([]),
      partial: selected.failed.length > 0 || selected.skipped.length > 0,
      partialReasons: Object.freeze([...selected.failed, ...selected.skipped].map(entry => `${entry.file}: ${entry.reason}`)),
      truncated: false,
      parserInvocations: 0,
      notes: Object.freeze(["no regular kotlin source files supplied"]),
    });
    const parser: KotlinParserRecord = Object.freeze({
      backend: "kotlin_psi_factory",
      compilerVersion: "2.2.0",
      invocation: "<no JVM batch started>",
      semanticBinding: false,
    });
    return Object.freeze({ status: "ok", result: projectKotlinSymbolTableResult(request, parser, Object.freeze([]), coverage) });
  }

  const javaBin = options.javaBin ?? JAVA_BIN;
  const jars = options.kotlinJars ?? KOTLIN_JARS;
  const driverClassDir = options.driverClassDir
    ?? path.resolve(dirname(fileURLToPath(import.meta.url)), "kotlin-symbol-jvm");
  const missing = [
    ...(!existsSync(javaBin) ? [javaBin] : []),
    ...jars.filter(jar => !existsSync(jar)),
    ...(!existsSync(driverClassDir) ? [driverClassDir] : []),
  ];
  if (missing.length > 0) {
    return rejected("parser_unavailable", `missing JVM runtime: ${missing.join(", ")}`);
  }

  const classpath = [driverClassDir, ...jars].join(path.delimiter);
  const invocation = `${javaBin} -Xmx256m -cp ${classpath} ExtractKotlinSymbols <file...>`;
  const args = ["-Xmx256m", "-cp", classpath, "ExtractKotlinSymbols", repoAbs, ...files];
  const run = spawnSync(javaBin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
  });

  if (run.error !== undefined) {
    return rejected("parser_failed", `failed to start Kotlin JVM driver: ${run.error.message}`);
  }
  if (run.status !== 0) {
    const stderr = typeof run.stderr === "string" ? run.stderr.trim() : "";
    return rejected("parser_failed", `Kotlin JVM driver exited ${String(run.status)}: ${stderr.slice(0, 1000)}`);
  }

  let payload: JavaPayload;
  try {
    payload = readJavaPayload(JSON.parse(typeof run.stdout === "string" ? run.stdout : String(run.stdout)));
  } catch (error) {
    return rejected("parser_failed", `invalid Kotlin JVM driver output: ${(error as Error).message}`);
  }

  const parsedReports = payload.fileReports.filter(report => !report.failed);
  const failedReports = payload.fileReports.filter(report => report.failed);
  const scopeFilesFailed = Object.freeze([
    ...selected.failed,
    ...failedReports.map(report => ({ file: report.file, reason: report.failureReason ?? "parse_failed" })),
  ]);
  const psiErrorFiles: readonly KotlinPsiErrorFile[] = Object.freeze(
    parsedReports
      .filter(report => report.parseStatus === "partial_syntax_error")
      .map(report => Object.freeze({ file: report.file, errors: report.psiErrors })),
  );
  const partialReasons = Object.freeze([
    ...selected.failed.map(entry => `${entry.file}: ${entry.reason}`),
    ...selected.skipped.map(entry => `${entry.file}: ${entry.reason}`),
    ...failedReports.map(entry => `${entry.file}: ${entry.failureReason ?? "parse_failed"}`),
    ...psiErrorFiles.map(entry => `${entry.file}: ${entry.errors.length} PSI error(s)`),
  ]);
  const partial = scopeFilesFailed.length > 0 || selected.skipped.length > 0 || psiErrorFiles.length > 0;
  const notes = Object.freeze([
    `ignorePolicy=${request.ignorePolicy}`,
    "symlinks are never followed; duplicate file entries are deduplicated by physical path",
    `peakJvmUsedBytes=${payload.peakJvmUsedBytes}; jvmMaxMemoryBytes=${payload.jvmMaxMemoryBytes}`,
    "semanticBinding=false; no binding or call edges are produced",
  ]);

  const coverage: KotlinCoverageRecord = Object.freeze({
    scopeFilesDiscovered: files.length + selected.skipped.length,
    scopeFilesParsed: parsedReports.length,
    scopeFilesFailed,
    skipped: selected.skipped,
    psiErrorFiles,
    partial,
    partialReasons,
    truncated: false,
    parserInvocations: 1,
    notes,
  });

  const parser: KotlinParserRecord = Object.freeze({
    backend: "kotlin_psi_factory",
    compilerVersion: "2.2.0",
    invocation,
    semanticBinding: false,
  });

  const symbols = Object.freeze(payload.symbols.map(entry => Object.freeze({ ...entry })));
  return Object.freeze({
    status: "ok",
    result: projectKotlinSymbolTableResult(request, parser, symbols, coverage),
  });
}

export function createKotlinSymbolTableAdapter(
  options: KotlinSymbolTableAdapterOptions = {},
): Readonly<{
  symbols: (request: unknown) => Promise<KotlinSymbolTableOutcome>;
}> {
  return Object.freeze({
    symbols: (request: unknown) => runKotlinSymbolTable(request, options),
  });
}
