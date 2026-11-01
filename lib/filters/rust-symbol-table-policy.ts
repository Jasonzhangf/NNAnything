// Rust single-file symbol-table policy. This file owns request validation,
// exact symbol/file filtering, and the public result projection. It has no
// process or filesystem responsibilities; the adapter streams and parses the
// rustc AST dump.

export const RUST_SYMBOL_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export type RustSymbolKind =
  | "function"
  | "method"
  | "struct"
  | "enum"
  | "trait"
  | "module";

export type RustVisibility = "pub" | "pub(restricted)" | "private";
export type RustEdition = "2015" | "2018" | "2021" | "2024";

export type RustSpan = Readonly<{
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}>;

export type RustSymbolRecord = Readonly<{
  symbolId: string;
  name: string;
  kind: RustSymbolKind;
  file: string;
  declSpan: RustSpan;
  nameSpan: RustSpan | null;
  nameSpanSource: string;
  lexicalScope: readonly string[];
  projectModulePath: "unknown";
  ownerType: string | null;
  implTrait: string | null;
  visibility: RustVisibility;
  cfgConditional: boolean;
  cfgAttributes: readonly string[];
  parseStatus: "complete" | "partial_syntax_error";
}>;

export type RustMacroBoundary = Readonly<{
  boundaryKind: "macro_rules_definition" | "unexpanded_item_macro_call";
  macroName: string;
  file: string;
  declSpan: RustSpan;
  rawInvocationPreview?: string;
}>;

export type RustParserRecord = Readonly<{
  backend: "rustc_ast_unpretty";
  toolchain: string;
  edition: RustEdition;
  editionSource: "default" | "request";
  invocation: string;
  semanticBinding: false;
}>;

export type RustCoverageRecord = Readonly<{
  scopeFilesDiscovered: number;
  scopeFilesParsed: number;
  scopeFilesFailed: readonly Readonly<{ file: string; reason: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
  partial: boolean;
  partialReasons: readonly string[];
  truncated: boolean;
  parserInvocations: number;
  notes: readonly string[];
}>;

export type RustSymbolTableRequest = Readonly<{
  repo: string;
  language: "rust";
  scope: readonly string[];
  files: readonly string[];
  symbol: string | null;
  file: string | null;
  edition: RustEdition;
  editionSource: "default" | "request";
}>;

export type RustSymbolRequestError = Readonly<{
  status: "rejected";
  reasonCode: string;
  message: string;
}>;

export type RustSymbolValidation =
  | Readonly<{ ok: true; request: RustSymbolTableRequest }>
  | Readonly<{ ok: false; error: RustSymbolRequestError }>;

export type RustSymbolTableResult = Readonly<{
  schema: string;
  language: "rust";
  repo: string;
  scope: readonly string[];
  parser: RustParserRecord;
  symbols: readonly RustSymbolRecord[];
  macroBoundaries: readonly RustMacroBoundary[];
  coverage: RustCoverageRecord;
  boundaries: Readonly<{
    macroGeneratedDeclarations: "not_expanded";
    cfgConditionalDeclarations: "listed_with_cfgConditional_true";
    projectModulePath: "unknown";
    externalCrates: "not_resolved";
  }>;
}>;

export type RustSymbolTableOutcome =
  | Readonly<{ status: "ok"; result: RustSymbolTableResult }>
  | RustSymbolRequestError;

export function isRustEdition(value: string): value is RustEdition {
  return value === "2015" || value === "2018" || value === "2021" || value === "2024";
}

function rejected(reasonCode: string, message: string): RustSymbolValidation {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ status: "rejected", reasonCode, message }),
  });
}

function isSafeRepoRelative(value: string): boolean {
  const nul = String.fromCharCode(0);
  if (value.length === 0 || value.startsWith("/") || value.includes(nul)) {
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

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

export function validateRustSymbolRequest(raw: unknown): RustSymbolValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return rejected("invalid_request", "request must be an object");
  }
  const record = raw as Record<string, unknown>;

  if (typeof record["repo"] !== "string" || record["repo"].length === 0) {
    return rejected("missing_repo", "repo must be a non-empty absolute path");
  }
  if (!record["repo"].startsWith("/")) {
    return rejected("invalid_repo", "repo must be an absolute path");
  }

  if (typeof record["language"] !== "string" || record["language"].length === 0) {
    return rejected("missing_language", "language is required");
  }
  if (record["language"] !== "rust") {
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
    const normalized = normalizeRelative(entry);
    if (!isSafeRepoRelative(normalized)) {
      return rejected("scope_escape", `scope[${index}] escapes the repository`);
    }
    scope.push(normalized);
  }

  if (!Array.isArray(record["files"])) {
    return rejected("missing_files", "files must be an array of repo-relative .rs paths");
  }
  const files: string[] = [];
  for (let index = 0; index < record["files"].length; index += 1) {
    const entry = record["files"][index];
    if (typeof entry !== "string" || entry.length === 0) {
      return rejected("invalid_file", `files[${index}] must be a non-empty repo-relative path`);
    }
    const normalized = normalizeRelative(entry);
    if (!isSafeRepoRelative(normalized) || !normalized.endsWith(".rs")) {
      return rejected("file_escape", `files[${index}] must be a repo-relative .rs path`);
    }
    files.push(normalized);
  }

  let symbol: string | null = null;
  if (record["symbol"] !== undefined) {
    if (typeof record["symbol"] !== "string" || record["symbol"].length === 0) {
      return rejected("invalid_symbol", "symbol must be a non-empty string");
    }
    symbol = record["symbol"];
  }

  let file: string | null = null;
  if (record["file"] !== undefined) {
    if (typeof record["file"] !== "string" || record["file"].length === 0) {
      return rejected("invalid_file", "file must be a non-empty repo-relative path");
    }
    const normalized = normalizeRelative(record["file"]);
    if (!isSafeRepoRelative(normalized)) {
      return rejected("file_escape", "file escapes the repository");
    }
    file = normalized;
  }

  let edition: RustEdition = "2021";
  let editionSource: "default" | "request" = "default";
  if (record["edition"] !== undefined) {
    if (typeof record["edition"] !== "string" || !isRustEdition(record["edition"])) {
      return rejected("invalid_edition", "edition must be one of 2015|2018|2021|2024");
    }
    edition = record["edition"];
    editionSource = "request";
  }

  return Object.freeze({
    ok: true,
    request: Object.freeze({
      repo: record["repo"],
      language: "rust",
      scope: Object.freeze(scope),
      files: Object.freeze(files),
      symbol,
      file,
      edition,
      editionSource,
    }),
  });
}

export function spanKey(span: RustSpan): string {
  return `${span.startLine}:${span.startCol}-${span.endLine}:${span.endCol}`;
}

export function symbolIdFor(file: string, name: string, span: RustSpan): string {
  return `${file}#${name}@${spanKey(span)}`;
}

export function filterRustSymbols(
  symbols: readonly RustSymbolRecord[],
  symbol: string | null,
  file: string | null,
): readonly RustSymbolRecord[] {
  const filtered = symbols.filter(entry => {
    const nameOk = symbol === null || entry.name === symbol;
    const fileOk = file === null || entry.file === file;
    return nameOk && fileOk;
  });
  return Object.freeze(filtered);
}

export function filterRustMacroBoundaries(
  boundaries: readonly RustMacroBoundary[],
  file: string | null,
): readonly RustMacroBoundary[] {
  if (file === null) {
    return Object.freeze(boundaries.slice());
  }
  return Object.freeze(boundaries.filter(entry => entry.file === file));
}

export function projectRustSymbolTableResult(
  request: RustSymbolTableRequest,
  parser: RustParserRecord,
  symbols: readonly RustSymbolRecord[],
  macroBoundaries: readonly RustMacroBoundary[],
  coverage: RustCoverageRecord,
): RustSymbolTableResult {
  return Object.freeze({
    schema: RUST_SYMBOL_RESULT_SCHEMA,
    language: "rust",
    repo: request.repo,
    scope: request.scope,
    parser,
    symbols: Object.freeze(filterRustSymbols(symbols, request.symbol, request.file)),
    macroBoundaries: Object.freeze(filterRustMacroBoundaries(macroBoundaries, request.file)),
    coverage,
    boundaries: Object.freeze({
      macroGeneratedDeclarations: "not_expanded",
      cfgConditionalDeclarations: "listed_with_cfgConditional_true",
      projectModulePath: "unknown",
      externalCrates: "not_resolved",
    }),
  });
}

