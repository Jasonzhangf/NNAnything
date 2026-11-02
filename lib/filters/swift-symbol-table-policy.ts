// Swift symbol-table policy. This module owns request validation, exact
// symbol/file filtering, and result projection. Process and source parsing
// stay in the Swift adapter.

export const SWIFT_SYMBOL_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export type SwiftSymbolKind =
  | "struct"
  | "class"
  | "actor"
  | "enum"
  | "enum_case"
  | "protocol"
  | "extension"
  | "typealias"
  | "function"
  | "method"
  | "initializer"
  | "deinitializer"
  | "subscript"
  | "property"
  | "variable";

export type SwiftOwnerKind =
  | "struct"
  | "class"
  | "actor"
  | "enum"
  | "protocol"
  | "extension";

export type SwiftVisibility =
  | "open"
  | "public"
  | "package"
  | "internal"
  | "fileprivate"
  | "private"
  | "local";

export type SwiftDeclaredIn =
  | "file"
  | "struct_body"
  | "class_body"
  | "actor_body"
  | "enum_body"
  | "protocol_body"
  | "extension_body"
  | "local_scope";

export type SwiftSpan = Readonly<{
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}>;

export type SwiftSymbolRecord = Readonly<{
  symbolId: string;
  name: string;
  fullName: string;
  kind: SwiftSymbolKind;
  file: string;
  declSpan: SwiftSpan;
  nameSpan: SwiftSpan | null;
  nameSpanSource: string;
  lexicalScope: readonly string[];
  ownerType: string | null;
  ownerKind: SwiftOwnerKind | null;
  modifiers: readonly string[];
  visibility: SwiftVisibility;
  declaredIn: SwiftDeclaredIn;
  parseStatus: "complete" | "partial_syntax_error";
}>;

export type SwiftSyntaxError = Readonly<{
  line: number;
  column: number;
  message: string;
}>;

export type SwiftSyntaxErrorFile = Readonly<{
  file: string;
  errors: readonly SwiftSyntaxError[];
}>;

export type SwiftParserRecord = Readonly<{
  backend: "swiftc_dump_parse";
  compilerVersion: string;
  invocation: "swiftc -dump-parse <file>";
  semanticBinding: false;
}>;

export type SwiftCoverageRecord = Readonly<{
  scopeFilesDiscovered: number;
  scopeFilesParsed: number;
  scopeFilesFailed: readonly Readonly<{ file: string; reason: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
  syntaxErrorFiles: readonly SwiftSyntaxErrorFile[];
  partial: boolean;
  partialReasons: readonly string[];
  truncated: boolean;
  parserInvocations: number;
  notes: readonly string[];
}>;

export type SwiftSymbolTableRequest = Readonly<{
  repo: string;
  language: "swift";
  scope: readonly string[];
  files: readonly string[];
  symbol: string | null;
  file: string | null;
}>;

export type SwiftSymbolRequestError = Readonly<{
  status: "rejected";
  reasonCode: string;
  message: string;
}>;

export type SwiftSymbolValidation =
  | Readonly<{ ok: true; request: SwiftSymbolTableRequest }>
  | Readonly<{ ok: false; error: SwiftSymbolRequestError }>;

export type SwiftSymbolTableResult = Readonly<{
  schema: string;
  language: "swift";
  repo: string;
  scope: readonly string[];
  parser: SwiftParserRecord;
  symbols: readonly SwiftSymbolRecord[];
  coverage: SwiftCoverageRecord;
  boundaries: Readonly<{
    projectModulePath: "unknown";
    swiftMacros: "not_expanded";
    protocolWitnessDispatch: "not_resolved";
    objcInteropBindings: "not_resolved";
    swiftUiViewGraph: "not_resolved";
  }>;
}>;

export type SwiftSymbolTableOutcome =
  | Readonly<{ status: "ok"; result: SwiftSymbolTableResult }>
  | SwiftSymbolRequestError;

const NUL = String.fromCharCode(0);

function rejected(reasonCode: string, message: string): SwiftSymbolValidation {
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
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

export function isSafeScopePath(value: string): boolean {
  return value === "." || isSafeRepoRelative(value);
}

export function isSwiftSourceFile(value: string): boolean {
  return value.endsWith(".swift");
}

export function validateSwiftSymbolRequest(raw: unknown): SwiftSymbolValidation {
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
  if (record["language"] !== "swift") {
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

  if (!Array.isArray(record["files"])) {
    return rejected("missing_files", "files must be an array of repo-relative .swift paths");
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
    if (!isSwiftSourceFile(normalized)) {
      return rejected("invalid_file", `files[${index}] must end with .swift`);
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

  return Object.freeze({
    ok: true,
    request: Object.freeze({
      repo: record["repo"],
      language: "swift",
      scope: Object.freeze(scope),
      files: Object.freeze(files),
      symbol,
      file,
    }),
  });
}

export function spanKey(span: SwiftSpan): string {
  return `${span.startLine}:${span.startCol}-${span.endLine}:${span.endCol}`;
}

export function symbolIdFor(file: string, fullName: string, span: SwiftSpan): string {
  return `${file}#${fullName}@${spanKey(span)}`;
}

export function filterSwiftSymbols(
  symbols: readonly SwiftSymbolRecord[],
  symbol: string | null,
  file: string | null,
): readonly SwiftSymbolRecord[] {
  const filtered = symbols.filter(entry => {
    const symbolOk = symbol === null
      ? true
      : symbol.includes("(")
        ? entry.fullName === symbol
        : entry.name === symbol;
    const fileOk = file === null || entry.file === file;
    return symbolOk && fileOk;
  });
  return Object.freeze(filtered);
}

export function projectSwiftSymbolTableResult(
  request: SwiftSymbolTableRequest,
  parser: SwiftParserRecord,
  symbols: readonly SwiftSymbolRecord[],
  coverage: SwiftCoverageRecord,
): SwiftSymbolTableResult {
  return Object.freeze({
    schema: SWIFT_SYMBOL_RESULT_SCHEMA,
    language: "swift",
    repo: request.repo,
    scope: request.scope,
    parser,
    symbols: Object.freeze(filterSwiftSymbols(symbols, request.symbol, request.file)),
    coverage,
    boundaries: Object.freeze({
      projectModulePath: "unknown",
      swiftMacros: "not_expanded",
      protocolWitnessDispatch: "not_resolved",
      objcInteropBindings: "not_resolved",
      swiftUiViewGraph: "not_resolved",
    }),
  });
}

