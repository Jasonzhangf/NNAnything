// Kotlin single-file/scope symbol-table policy. This module owns request
// validation, exact symbol/file filtering, and the public result projection.
// It performs no filesystem or process work.

export const KOTLIN_SYMBOL_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export type KotlinSymbolKind =
  | "class"
  | "object"
  | "interface"
  | "companion_object"
  | "enum_class"
  | "enum_entry"
  | "data_class"
  | "annotation_class"
  | "method"
  | "function"
  | "extension_function"
  | "property"
  | "type_alias";

export type KotlinOwnerKind =
  | "class"
  | "object"
  | "interface"
  | "companion_object"
  | "enum_class"
  | "enum_entry";

export type KotlinVisibility = "public" | "internal" | "private" | "protected" | "unknown";

export type KotlinDeclaredIn =
  | "class_body"
  | "primary_constructor"
  | "file"
  | "object_body"
  | "interface_body"
  | "local_scope";

export type KotlinSpan = Readonly<{
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}>;

export type KotlinPsiError = Readonly<{
  line: number;
  column: number;
  errorDescription: string;
}>;

export type KotlinSymbolRecord = Readonly<{
  symbolId: string;
  name: string;
  kind: KotlinSymbolKind;
  file: string;
  declSpan: KotlinSpan;
  nameSpan: KotlinSpan | null;
  nameSpanSource: string;
  lexicalScope: readonly string[];
  ownerType: string | null;
  ownerKind: KotlinOwnerKind | null;
  receiverType: string | null;
  modifiers: readonly string[];
  visibility: KotlinVisibility;
  declaredIn: KotlinDeclaredIn;
  parseStatus: "complete" | "partial_syntax_error";
}>;

export type KotlinPsiErrorFile = Readonly<{
  file: string;
  errors: readonly KotlinPsiError[];
}>;

export type KotlinParserRecord = Readonly<{
  backend: "kotlin_psi_factory";
  compilerVersion: "2.2.0";
  invocation: string;
  semanticBinding: false;
}>;

export type KotlinCoverageRecord = Readonly<{
  scopeFilesDiscovered: number;
  scopeFilesParsed: number;
  scopeFilesFailed: readonly Readonly<{ file: string; reason: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
  psiErrorFiles: readonly KotlinPsiErrorFile[];
  partial: boolean;
  partialReasons: readonly string[];
  truncated: boolean;
  parserInvocations: number;
  notes: readonly string[];
}>;

export type KotlinIgnorePolicy = "no_ignore" | "respect_vcs_ignore";

export type KotlinSymbolTableRequest = Readonly<{
  repo: string;
  language: "kotlin";
  scope: readonly string[];
  files: readonly string[];
  symbol: string | null;
  file: string | null;
  ignorePolicy: KotlinIgnorePolicy;
}>;

export type KotlinSymbolRequestError = Readonly<{
  status: "rejected";
  reasonCode: string;
  message: string;
}>;

export type KotlinSymbolValidation =
  | Readonly<{ ok: true; request: KotlinSymbolTableRequest }>
  | Readonly<{ ok: false; error: KotlinSymbolRequestError }>;

export type KotlinSymbolTableResult = Readonly<{
  schema: string;
  language: "kotlin";
  repo: string;
  scope: readonly string[];
  parser: KotlinParserRecord;
  symbols: readonly KotlinSymbolRecord[];
  coverage: KotlinCoverageRecord;
  boundaries: Readonly<{
    projectModulePath: "unknown";
    generatedSources: "not_materialized";
    composeXmlEventBindings: "not_resolved";
    reflectionBindings: "not_resolved";
    jniBindings: "not_resolved";
  }>;
}>;

export type KotlinSymbolTableOutcome =
  | Readonly<{ status: "ok"; result: KotlinSymbolTableResult }>
  | KotlinSymbolRequestError;

const NUL = String.fromCharCode(0);

function rejected(reasonCode: string, message: string): KotlinSymbolValidation {
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

export function isKotlinSourceFile(value: string): boolean {
  return value.endsWith(".kt") || value.endsWith(".kts");
}

export function validateKotlinSymbolRequest(raw: unknown): KotlinSymbolValidation {
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
  if (record["language"] !== "kotlin") {
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
  // repo-relative regular Kotlin files here. This module never traverses dirs.
  if (!Array.isArray(record["files"])) {
    return rejected("missing_files", "files must be an array of repo-relative .kt/.kts paths");
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
    if (!isKotlinSourceFile(normalized)) {
      return rejected("invalid_file", `files[${index}] must end with .kt or .kts`);
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

  let ignorePolicy: KotlinIgnorePolicy = "no_ignore";
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
      language: "kotlin",
      scope: Object.freeze(scope),
      files: Object.freeze(files),
      symbol,
      file,
      ignorePolicy,
    }),
  });
}

export function filterKotlinSymbols(
  symbols: readonly KotlinSymbolRecord[],
  symbol: string | null,
  file: string | null,
): readonly KotlinSymbolRecord[] {
  const filtered = symbols.filter(entry => {
    const nameOk = symbol === null || entry.name === symbol;
    const fileOk = file === null || entry.file === file;
    return nameOk && fileOk;
  });
  return Object.freeze(filtered);
}

export function projectKotlinSymbolTableResult(
  request: KotlinSymbolTableRequest,
  parser: KotlinParserRecord,
  symbols: readonly KotlinSymbolRecord[],
  coverage: KotlinCoverageRecord,
): KotlinSymbolTableResult {
  return Object.freeze({
    schema: KOTLIN_SYMBOL_RESULT_SCHEMA,
    language: "kotlin",
    repo: request.repo,
    scope: request.scope,
    parser,
    symbols: Object.freeze(filterKotlinSymbols(symbols, request.symbol, request.file)),
    coverage,
    boundaries: Object.freeze({
      projectModulePath: "unknown",
      generatedSources: "not_materialized",
      composeXmlEventBindings: "not_resolved",
      reflectionBindings: "not_resolved",
      jniBindings: "not_resolved",
    }),
  });
}
