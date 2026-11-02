// Kotlin single-file symbol-table adapter. Backend is the fixed Kotlin PSI JVM
// driver `ExtractKotlinSymbols`. One batch JVM is started per request and its
// JSON stdout is parsed as the unified `nnanything.cli-symbols.result.v1`
// result. Directory enumeration, ignore handling, and scope dedup are owned by
// the public entry; this module processes an explicit list of repo-relative
// regular Kotlin files, never follows symlinks, and skips non-regular entries.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
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

const REQUIRED_KOTLIN_ARTIFACTS = Object.freeze([
  "kotlin-compiler-embeddable",
  "kotlin-stdlib",
  "kotlinx-coroutines-core-jvm",
  "trove4j",
] as const);

const CACHE_SEARCH_MAX_DIRECTORIES = 20_000;
const CACHE_SEARCH_MAX_DEPTH = 8;

export type KotlinSymbolTableAdapterOptions = Readonly<{
  javaBin?: string;
  kotlinJars?: readonly string[];
  driverClassDir?: string;
  timeoutMs?: number;
}>;

function artifactVersion(base: string, name: string): string | null {
  if (!base.startsWith(`${name}-`) || !base.endsWith(".jar")) return null;
  const stem = base.slice(name.length + 1, -".jar".length);
  if (stem.endsWith("-sources") || stem.endsWith("-javadoc") || stem.endsWith("-tests")) return null;
  // Excludes sibling artifacts such as kotlin-stdlib-jdk8 whose remaining
  // prefix is not a version number.
  if (!/^[0-9]/.test(stem)) return null;
  return stem;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
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

function resolveJava(options: KotlinSymbolTableAdapterOptions): { path: string | null; label: string } {
  if (options.javaBin !== undefined && options.javaBin.length > 0) {
    return { path: options.javaBin, label: options.javaBin };
  }
  const explicit = process.env.NN_CODE_KOTLIN_JAVA_BIN;
  if (explicit !== undefined && explicit.length > 0) {
    return { path: explicit, label: explicit };
  }
  const javaHome = process.env.JAVA_HOME;
  if (javaHome !== undefined && javaHome.length > 0) {
    const candidate = path.join(javaHome, "bin", "java");
    return { path: candidate, label: candidate };
  }
  const fromPath = findOnPath("java");
  if (fromPath !== null) return { path: fromPath, label: fromPath };
  return { path: null, label: "java" };
}

function cacheRoots(): readonly string[] {
  const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(homedir(), ".gradle");
  return Object.freeze([
    path.join(gradleHome, "caches", "modules-2", "files-2.1"),
    path.join(homedir(), ".m2", "repository"),
  ]);
}

function collectArtifactJars(root: string, buckets: Map<string, string[]>): void {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length > 0 && scanned < CACHE_SEARCH_MAX_DIRECTORIES) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    scanned += 1;
    if (current.depth >= CACHE_SEARCH_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
          if (artifactVersion(entry.name, name) !== null) {
            const bucket = buckets.get(name) ?? [];
            bucket.push(full);
            buckets.set(name, bucket);
          }
        }
      }
    }
  }
}

function preferNewest(candidates: readonly string[], artifactName: string): string | null {
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map(file => ({ file, version: artifactVersion(path.basename(file), artifactName) ?? "" }))
    .sort((left, right) => compareVersions(right.version, left.version));
  return ranked[0]?.file ?? null;
}

function resolveExplicitJars(candidates: readonly string[]): { jars: string[]; missing: string[]; invalid: string[] } {
  const jars = [...candidates];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
    const matches = jars.filter(jar => artifactVersion(path.basename(jar), name) !== null);
    if (matches.length === 0) {
      missing.push(name);
    } else if (matches.length > 1) {
      invalid.push(`${name}: ${matches.join(", ")}`);
    }
  }
  return { jars, missing, invalid };
}

function resolveJars(options: KotlinSymbolTableAdapterOptions): { jars: string[]; missing: string[]; invalid: string[] } {
  if (options.kotlinJars !== undefined) {
    return resolveExplicitJars(options.kotlinJars);
  }
  const explicit = process.env.NN_CODE_KOTLIN_JARS;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const jars = explicit.split(path.delimiter).map(value => value.trim()).filter(value => value.length > 0);
    return resolveExplicitJars(jars);
  }

  const buckets = new Map<string, string[]>();
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) buckets.set(name, []);
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue;
    collectArtifactJars(root, buckets);
  }
  const jars: string[] = [];
  const missing: string[] = [];
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
    const chosen = preferNewest(buckets.get(name) ?? [], name);
    if (chosen === null) missing.push(name);
    else jars.push(chosen);
  }
  return { jars, missing, invalid: [] };
}

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
  let physicalRepo: string | null = null;

  for (const rawEntry of entries) {
    const file = rawEntry.replace(/\\/g, "/");
    const abs = path.resolve(repoAbs, file);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);

    const components = file.split("/");
    let current = repoAbs;
    let finalIsFile = false;
    let rejected = false;
    let index = 0;
    for (const component of components) {
      current = path.join(current, component);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        failed.push({ file, reason: `stat_failed: ${(error as Error).message}` });
        rejected = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        skipped.push({ file, reason: "symlink_not_followed" });
        rejected = true;
        break;
      }
      if (index === components.length - 1) {
        finalIsFile = stats.isFile();
      }
      index += 1;
    }
    if (rejected) {
      continue;
    }
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
      failed.push({ file, reason: `realpath_failed: ${(error as Error).message}` });
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

  const java = resolveJava(options);
  const resolvedJars = resolveJars(options);
  if (resolvedJars.invalid.length > 0) {
    const details = [`ambiguous Kotlin JVM artifacts: ${resolvedJars.invalid.join("; ")}`];
    if (resolvedJars.missing.length > 0) details.push(`missing required Kotlin JVM artifacts: ${resolvedJars.missing.join(", ")}`);
    return rejected("parser_unavailable", details.join("; "));
  }
  const driverClassDir = options.driverClassDir
    ?? path.resolve(dirname(fileURLToPath(import.meta.url)), "kotlin-symbol-jvm");
  const javaBin = java.path;
  const jars = resolvedJars.jars;
  const missing: string[] = [];
  if (javaBin === null) {
    missing.push(java.label);
  } else if (!existsSync(javaBin)) {
    missing.push(javaBin);
  }
  missing.push(...resolvedJars.missing);
  missing.push(...jars.filter(jar => !existsSync(jar)));
  if (!existsSync(driverClassDir)) missing.push(driverClassDir);
  if (missing.length > 0) {
    return rejected("parser_unavailable", `missing JVM runtime: ${missing.join(", ")}`);
  }
  if (javaBin === null) {
    return rejected("parser_unavailable", "missing JVM runtime: java");
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
    "symlinks are never followed in any path component; duplicate file entries are deduplicated by resolved path",
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
