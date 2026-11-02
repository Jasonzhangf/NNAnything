// Java single-file/scope symbol-table policy. This module owns request
// validation, exact symbol/file filtering, and the public result projection.
// It performs no filesystem or process work; the adapter starts the
// `ExtractJavaSymbols` batch JVM and this module only shapes its output.

export const JAVA_SYMBOL_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export type JavaSymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "enum_constant"
  | "record"
  | "record_component"
  | "annotation_interface"
  | "method"
  | "constructor"
  | "field";

export type JavaOwnerKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "annotation_interface";

export type JavaVisibility = "public" | "protected" | "private" | "package_private" | "local";

export type JavaNameSpanSource = "header_scanner" | "anonymous_type" | "unknown";

export type JavaDeclaredIn =
  | "file"
  | "class_body"
  | "interface_body"
  | "enum_body"
  | "record_header"
  | "record_body"
  | "annotation_body"
  | "anonymous_class_body"
  | "local_scope";

export type JavaSpan = Readonly<{
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}>;

export type JavaSyntaxError = Readonly<{
  line: number;
  column: number;
  message: string;
}>;

export type JavaSymbolRecord = Readonly<{
  symbolId: string;
  name: string;
  kind: JavaSymbolKind;
  file: string;
  declSpan: JavaSpan;
  nameSpan: JavaSpan | null;
  nameSpanSource: JavaNameSpanSource;
  packageName: string | null;
  lexicalScope: readonly string[];
  ownerType: string | null;
  ownerKind: JavaOwnerKind | null;
  modifiers: readonly string[];
  visibility: JavaVisibility;
  declaredIn: JavaDeclaredIn;
  parseStatus: "complete" | "partial_syntax_error";
}>;

export type JavaSyntaxErrorFile = Readonly<{
  file: string;
  errors: readonly JavaSyntaxError[];
}>;

export type JavaParserRecord = Readonly<{
  backend: "javac_compiler_tree";
  jdkVersion: string;
  invocation: string;
  semanticBinding: false;
}>;

export type JavaCoverageRecord = Readonly<{
  scopeFilesDiscovered: number;
  scopeFilesParsed: number;
  scopeFilesFailed: readonly Readonly<{ file: string; reason: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
  syntaxErrorFiles: readonly JavaSyntaxErrorFile[];
  partial: boolean;
  partialReasons: readonly string[];
  truncated: boolean;
  parserInvocations: number;
  notes: readonly string[];
}>;

export type JavaIgnorePolicy = "no_ignore" | "respect_vcs_ignore";

export type JavaSymbolTableRequest = Readonly<{
  repo: string;
  language: "java";
  scope: readonly string[];
  files: readonly string[];
  symbol: string | null;
  file: string | null;
  ignorePolicy: JavaIgnorePolicy;
}>;

export type JavaSymbolRequestError = Readonly<{
  status: "rejected";
  reasonCode: string;
  message: string;
}>;

export type JavaSymbolValidation =
  | Readonly<{ ok: true; request: JavaSymbolTableRequest }>
  | Readonly<{ ok: false; error: JavaSymbolRequestError }>;

export type JavaSymbolTableResult = Readonly<{
  schema: string;
  language: "java";
  repo: string;
  scope: readonly string[];
  parser: JavaParserRecord;
  symbols: readonly JavaSymbolRecord[];
  coverage: JavaCoverageRecord;
  boundaries: Readonly<{
    projectModulePath: "unknown";
    classpathTypeResolution: "not_resolved";
    annotationProcessorGeneratedSources: "not_materialized";
    androidXmlBindings: "not_resolved";
    reflectionBindings: "not_resolved";
    jniBindings: "not_resolved";
  }>;
}>;

export type JavaSymbolTableOutcome =
  | Readonly<{ status: "ok"; result: JavaSymbolTableResult }>
  | JavaSymbolRequestError;

const NUL = String.fromCharCode(0);

function rejected(reasonCode: string, message: string): JavaSymbolValidation {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ status: "rejected", reasonCode, message }),
  });
}

export function normalizeRepoRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isSafeRepoRelative(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes(NUL)) {
    return false;
  }
  const parts = value.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return false;
    }
  }
  return true;
}

export function isSafeScopePath(value: string): boolean {
  return value === "." || isSafeRepoRelative(value);
}

export function isJavaSourceFile(value: string): boolean {
  return value.endsWith(".java");
}

export function validateJavaSymbolRequest(raw: unknown): JavaSymbolValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return rejected("invalid_request", "request must be an object");
  }
  const record = raw as Record<string, unknown>;

  if (typeof record["repo"] !== "string" || record["repo"].length === 0) {
    return rejected("missing_repo", "repo must be a non-empty absolute path");
  }
  if (!record["repo"].startsWith("/") || record["repo"].includes(NUL)) {
    return rejected("invalid_repo", "repo must be an absolute path");
  }

  if (typeof record["language"] !== "string" || record["language"].length === 0) {
    return rejected("missing_language", "language is required");
  }
  if (record["language"] !== "java") {
    return rejected("unsupported_language", `unsupported language: ${String(record["language"])}`);
  }

  if (!Array.isArray(record["scope"])) {
    return rejected("missing_scope", "scope must be an array of repo-relative paths");
  }
  const scope: string[] = [];
  for (let index = 0; index < record["scope"].length; index += 1) {
    const entry = record["scope"][index];
    if (typeof entry !== "string" || entry.length === 0) {
      return rejected("invalid_scope", `scope[${index}] must be a non-empty repo-relative path`);
    }
    const normalized = normalizeRepoRelative(entry);
    if (!isSafeScopePath(normalized)) {
      return rejected("scope_escape", `scope[${index}] escapes the repository`);
    }
    scope.push(normalized);
  }
  if (scope.length === 0) {
    return rejected("missing_scope", "scope must contain at least one repo-relative path");
  }

  // The public entry owns directory discovery and passes the already-selected
  // repo-relative regular .java files here. This module never traverses dirs.
  if (!Array.isArray(record["files"])) {
    return rejected("missing_files", "files must be an array of repo-relative .java paths");
  }
  const files: string[] = [];
  for (let index = 0; index < record["files"].length; index += 1) {
    const entry = record["files"][index];
    if (typeof entry !== "string" || entry.length === 0) {
      return rejected("invalid_file", `files[${index}] must be a non-empty repo-relative path`);
    }
    const normalized = normalizeRepoRelative(entry);
    if (!isSafeRepoRelative(normalized)) {
      return rejected("file_escape", `files[${index}] escapes the repository`);
    }
    if (!isJavaSourceFile(normalized)) {
      return rejected("invalid_file", `files[${index}] must end with .java`);
    }
    files.push(normalized);
  }

  let symbol: string | null = null;
  if (record["symbol"] !== undefined) {
    if (typeof record["symbol"] !== "string" || record["symbol"].length === 0 || record["symbol"].includes(NUL)) {
      return rejected("invalid_symbol", "symbol must be a non-empty string without NUL");
    }
    symbol = record["symbol"];
  }

  let file: string | null = null;
  if (record["file"] !== undefined) {
    if (typeof record["file"] !== "string" || record["file"].length === 0) {
      return rejected("invalid_file", "file must be a non-empty repo-relative path");
    }
    const normalized = normalizeRepoRelative(record["file"]);
    if (!isSafeRepoRelative(normalized)) {
      return rejected("file_escape", "file escapes the repository");
    }
    file = normalized;
  }

  let ignorePolicy: JavaIgnorePolicy = "no_ignore";
  if (record["ignorePolicy"] !== undefined) {
    if (record["ignorePolicy"] !== "no_ignore" && record["ignorePolicy"] !== "respect_vcs_ignore") {
      return rejected("invalid_ignore_policy", "ignorePolicy must be no_ignore or respect_vcs_ignore");
    }
    ignorePolicy = record["ignorePolicy"];
  }

  return Object.freeze({
    ok: true,
    request: Object.freeze({
      repo: record["repo"],
      language: "java",
      scope: Object.freeze(scope),
      files: Object.freeze(files),
      symbol,
      file,
      ignorePolicy,
    }),
  });
}

export function filterJavaSymbols(
  symbols: readonly JavaSymbolRecord[],
  symbol: string | null,
  file: string | null,
): readonly JavaSymbolRecord[] {
  const filtered = symbols.filter(entry => {
    const nameOk = symbol === null || entry.name === symbol;
    const fileOk = file === null || entry.file === file;
    return nameOk && fileOk;
  });
  return Object.freeze(filtered);
}

export function projectJavaSymbolTableResult(
  request: JavaSymbolTableRequest,
  parser: JavaParserRecord,
  symbols: readonly JavaSymbolRecord[],
  coverage: JavaCoverageRecord,
): JavaSymbolTableResult {
  return Object.freeze({
    schema: JAVA_SYMBOL_RESULT_SCHEMA,
    language: "java",
    repo: request.repo,
    scope: request.scope,
    parser,
    symbols: Object.freeze(filterJavaSymbols(symbols, request.symbol, request.file)),
    coverage,
    boundaries: Object.freeze({
      projectModulePath: "unknown",
      classpathTypeResolution: "not_resolved",
      annotationProcessorGeneratedSources: "not_materialized",
      androidXmlBindings: "not_resolved",
      reflectionBindings: "not_resolved",
      jniBindings: "not_resolved",
    }),
  });
}
