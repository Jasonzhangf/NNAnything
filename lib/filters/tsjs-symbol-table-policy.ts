// TypeScript / JavaScript single-file symbol-table policy. This module owns the
// request contract, exact symbol/file filtering and the public result
// projection. It performs no filesystem, process or AST work; the adapter owns
// `ts.createSourceFile` and the explicit-stack walk.

export const TSJS_SYMBOL_RESULT_SCHEMA = "nnanything.cli-symbols.result.v1";

export type TsJsLanguage = "typescript" | "javascript";

export type TsJsSymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "accessor"
  | "class"
  | "interface"
  | "type_alias"
  | "enum"
  | "enum_member"
  | "namespace"
  | "property"
  | "variable";

export type TsJsNameSpanSource =
  | "identifier"
  | "default_keyword"
  | "constructor_keyword"
  | "cjs_export_target"
  | "module_literal"
  | "computed_literal"
  | "none";

export type TsJsOwnerKind =
  | "class"
  | "interface"
  | "enum"
  | "namespace"
  | "commonjs_exports"
  | null;

export type TsJsVisibility = "exported" | "public" | "protected" | "private" | "module_private";

export type TsJsModuleSystem = "esm" | "cjs" | "script" | "ambient_dts";

export type TsJsDeclaredIn =
  | "file"
  | "namespace_body"
  | "class_body"
  | "interface_body"
  | "enum_body"
  | "primary_constructor"
  | "commonjs_export"
  | "local_scope";

export type TsJsParseStatus = "complete" | "partial_syntax_error";

export type TsJsSpan = Readonly<{
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}>;

export type TsJsSymbolRecord = Readonly<{
  symbolId: string;
  name: string;
  kind: TsJsSymbolKind;
  file: string;
  declSpan: TsJsSpan;
  nameSpan: TsJsSpan | null;
  nameSpanSource: TsJsNameSpanSource;
  lexicalScope: readonly string[];
  ownerType: string | null;
  ownerKind: TsJsOwnerKind;
  modifiers: readonly string[];
  visibility: TsJsVisibility;
  moduleSystem: TsJsModuleSystem;
  declaredIn: TsJsDeclaredIn;
  parseStatus: TsJsParseStatus;
}>;

export type TsJsDynamicMemberBoundary = Readonly<{
  boundaryKind: "class_computed_member" | "interface_computed_member" | "commonjs_computed_export";
  memberKind: "method" | "accessor" | "property" | "export_assignment";
  expressionText: string;
  file: string;
  declSpan: TsJsSpan;
  expressionSpan: TsJsSpan;
  lexicalScope: readonly string[];
  ownerType: string | null;
  reason: "DYNAMIC_COMPUTED_NAME";
}>;

export type TsJsRuntimeSelectorRole =
  | "selector_candidate_table"
  | "runtime_selector_dependency"
  | "static_selected_member";

export type TsJsRuntimeSelectorRoleFact = Readonly<{
  factRef: string;
  role: TsJsRuntimeSelectorRole;
  state: "known";
  value: string | null;
  evidenceRefs: readonly string[];
}>;

export type TsJsInlineCallableIdentity = Readonly<{
  declarationRef: string;
  moduleRef: string;
  span: TsJsSpan;
  syntaxKind: "arrow_function" | "function_expression";
}>;

export type TsJsRuntimeCallableTable = Readonly<{
  tableRef: string;
  members: readonly Readonly<{
    name: string;
    initializerRef: string;
    callableIdentity: TsJsInlineCallableIdentity | null;
  }>[];
}>;

export type TsJsRuntimeSelectorObservation = Readonly<{
  observationRef: string;
  callSiteRef: string;
  sourceReadRef: string;
  binding: Readonly<{
    symbolRef: string;
    callSiteRef: string;
    role: "member";
    bindingMode: "dynamic";
    resolution: Readonly<{
      status: "dynamic";
      reason: "dynamic_undecidable";
      evidenceRefs: readonly string[];
    }>;
    declarationRefs: readonly [];
    scopeRef: null;
    evidenceRefs: readonly string[];
  }>;
  facts: readonly (TsJsRuntimeSelectorRoleFact & Readonly<{
    role: "selector_candidate_table" | "runtime_selector_dependency";
  }>)[];
  callableTable?: TsJsRuntimeCallableTable;
  sourceReadReceipt: Readonly<{
    receiptId: string;
    actionRef: string;
    action: "read_source";
    origin: "source_observation";
    outcome: "success";
    targetRef: string;
    result: readonly string[];
    evidenceRefs: readonly string[];
    modules: readonly Readonly<{
      file: string;
      textLength: number;
      lineCount: number;
    }>[];
  }>;
}>;

export type TsJsStaticSelectedSelectorObservation = Readonly<{
  observationRef: string;
  callSiteRef: string;
  sourceReadRef: string;
  selection: Readonly<{
    selectionKind: "static_selected";
    selectorLiteral: string;
    selectedMemberName: string;
    selectedMemberRef: string;
    selectedDeclarationRef: string;
    selectedModuleRef: string;
  }>;
  binding: Readonly<{
    symbolRef: string;
    callSiteRef: string;
    role: "member";
    bindingMode: "bound";
    resolution: Readonly<{
      status: "resolved";
      declarationRef: string;
      moduleRef: string;
      evidenceRefs: readonly string[];
    }>;
    declarationRefs: readonly string[];
    scopeRef: null;
    evidenceRefs: readonly string[];
  }>;
  facts: readonly TsJsRuntimeSelectorRoleFact[];
  callableTable: TsJsRuntimeCallableTable;
  sourceReadReceipt: TsJsRuntimeSelectorObservation["sourceReadReceipt"];
}>;

export type TsJsRuntimeSelectorGap = Readonly<{
  gapRef: string;
  callSiteRef: string | null;
  reason:
    | "module_not_in_read_set"
    | "read_failed"
    | "parse_error"
    | "dependency_not_parameter"
    | "table_not_finite_callable"
    | "table_not_connected"
    | "ambiguous_selector_chain"
    | "unsupported_selector_shape"
    | "static_selected_member_missing"
    | "static_alias_unsupported";
  evidenceRefs: readonly string[];
}>;

export type TsJsParseError = Readonly<{
  line: number;
  column: number;
  message: string;
}>;

export type TsJsParseErrorFile = Readonly<{
  file: string;
  errors: readonly TsJsParseError[];
}>;

export type TsJsParserRecord = Readonly<{
  backend: "typescript_compiler_ast";
  compilerVersion: string;
  invocation: string;
  semanticBinding: false;
}>;

export type TsJsCoverageRecord = Readonly<{
  scopeFilesDiscovered: number;
  scopeFilesParsed: number;
  scopeFilesFailed: readonly Readonly<{ file: string; reason: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
  parseErrorFiles: readonly TsJsParseErrorFile[];
  partial: boolean;
  partialReasons: readonly string[];
  truncated: boolean;
  parserInvocations: number;
  notes: readonly string[];
}>;

export type TsJsSymbolTableRequest = Readonly<{
  repo: string;
  language: TsJsLanguage;
  scope: readonly string[];
  files: readonly string[];
  symbol: string | null;
  file: string | null;
}>;

export type TsJsSymbolRequestError = Readonly<{
  status: "rejected";
  reasonCode: string;
  message: string;
}>;

export type TsJsSymbolValidation =
  | Readonly<{ ok: true; request: TsJsSymbolTableRequest }>
  | Readonly<{ ok: false; error: TsJsSymbolRequestError }>;

export type TsJsSymbolTableResult = Readonly<{
  schema: string;
  language: TsJsLanguage;
  repo: string;
  scope: readonly string[];
  parser: TsJsParserRecord;
  symbols: readonly TsJsSymbolRecord[];
  dynamicMemberBoundaries: readonly TsJsDynamicMemberBoundary[];
  runtimeSelectorObservations: readonly TsJsRuntimeSelectorObservation[];
  staticSelectedSelectorObservations: readonly TsJsStaticSelectedSelectorObservation[];
  runtimeSelectorGaps: readonly TsJsRuntimeSelectorGap[];
  coverage: TsJsCoverageRecord;
  boundaries: Readonly<{
    projectModulePath: "unknown";
    typeCheckerSemanticBinding: "not_resolved";
    dynamicComputedProperties: "not_resolved";
    commonjsDynamicRequire: "not_resolved";
    reExportTargetResolution: "not_resolved";
  }>;
}>;

export type TsJsSymbolTableOutcome =
  | Readonly<{ status: "ok"; result: TsJsSymbolTableResult }>
  | TsJsSymbolRequestError;

const NUL = String.fromCharCode(0);

const TYPESCRIPT_LANGUAGES = Object.freeze(["typescript", "ts"] as const);
const JAVASCRIPT_LANGUAGES = Object.freeze(["javascript", "js"] as const);

function rejected(reasonCode: string, message: string): TsJsSymbolValidation {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ status: "rejected", reasonCode, message }),
  });
}

export function normalizeTsJsLanguage(value: string): TsJsLanguage | null {
  const lower = value.toLowerCase();
  if (lower === "typescript" || lower === "ts") return "typescript";
  if (lower === "javascript" || lower === "js") return "javascript";
  return null;
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

export function isTypeScriptSourceName(value: string): boolean {
  return (
    value.endsWith(".ts") ||
    value.endsWith(".tsx") ||
    value.endsWith(".mts") ||
    value.endsWith(".cts")
  );
}

export function isJavaScriptSourceName(value: string): boolean {
  return (
    value.endsWith(".js") ||
    value.endsWith(".jsx") ||
    value.endsWith(".mjs") ||
    value.endsWith(".cjs")
  );
}

export function isTsJsSourceName(value: string): boolean {
  return isTypeScriptSourceName(value) || isJavaScriptSourceName(value);
}

export function validateTsJsSymbolRequest(raw: unknown): TsJsSymbolValidation {
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
  const language = normalizeTsJsLanguage(record["language"]);
  if (language === null) {
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

  const matchesLanguage = (value: string): boolean =>
    language === "typescript" ? isTypeScriptSourceName(value) : isJavaScriptSourceName(value);

  // The public entry owns directory discovery and passes the already-selected
  // repo-relative regular files here. This module never traverses directories.
  if (!Array.isArray(record["files"])) {
    return rejected("missing_files", "files must be an array of repo-relative source paths");
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
    if (!matchesLanguage(normalized)) {
      return rejected(
        "invalid_file",
        `files[${index}] is not a ${language} source file`,
      );
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
      language,
      scope: Object.freeze(scope),
      files: Object.freeze(files),
      symbol,
      file,
    }),
  });
}

export function spanKey(span: TsJsSpan): string {
  return `${span.startLine}:${span.startCol}-${span.endLine}:${span.endCol}`;
}

export function symbolIdFor(file: string, name: string, span: TsJsSpan): string {
  return `${file}#${name}@${spanKey(span)}`;
}

export function filterTsJsSymbols(
  symbols: readonly TsJsSymbolRecord[],
  symbol: string | null,
  file: string | null,
): readonly TsJsSymbolRecord[] {
  const filtered = symbols.filter(entry => {
    const nameOk = symbol === null || entry.name === symbol;
    const fileOk = file === null || entry.file === file;
    return nameOk && fileOk;
  });
  return Object.freeze(filtered);
}

export function filterTsJsDynamicMemberBoundaries(
  boundaries: readonly TsJsDynamicMemberBoundary[],
  file: string | null,
): readonly TsJsDynamicMemberBoundary[] {
  if (file === null) {
    return Object.freeze(boundaries.slice());
  }
  return Object.freeze(boundaries.filter(entry => entry.file === file));
}

export function projectTsJsSymbolTableResult(
  request: TsJsSymbolTableRequest,
  parser: TsJsParserRecord,
  symbols: readonly TsJsSymbolRecord[],
  dynamicMemberBoundaries: readonly TsJsDynamicMemberBoundary[],
  coverage: TsJsCoverageRecord,
  runtimeSelectorObservations: readonly TsJsRuntimeSelectorObservation[] = [],
  runtimeSelectorGaps: readonly TsJsRuntimeSelectorGap[] = [],
  staticSelectedSelectorObservations: readonly TsJsStaticSelectedSelectorObservation[] = [],
): TsJsSymbolTableResult {
  return Object.freeze({
    schema: TSJS_SYMBOL_RESULT_SCHEMA,
    language: request.language,
    repo: request.repo,
    scope: request.scope,
    parser,
    symbols: Object.freeze(filterTsJsSymbols(symbols, request.symbol, request.file)),
    dynamicMemberBoundaries: Object.freeze(
      filterTsJsDynamicMemberBoundaries(dynamicMemberBoundaries, request.file),
    ),
    runtimeSelectorObservations: Object.freeze(runtimeSelectorObservations.slice()),
    staticSelectedSelectorObservations: Object.freeze(
      staticSelectedSelectorObservations.slice(),
    ),
    runtimeSelectorGaps: Object.freeze(runtimeSelectorGaps.slice()),
    coverage,
    boundaries: Object.freeze({
      projectModulePath: "unknown",
      typeCheckerSemanticBinding: "not_resolved",
      dynamicComputedProperties: "not_resolved",
      commonjsDynamicRequire: "not_resolved",
      reExportTargetResolution: "not_resolved",
    }),
  });
}

// Kept for parity with the language registry; the array form is used by the
// public entry when it lists languages. No behaviour depends on ordering.
export const TSJS_SUPPORTED_LANGUAGE_LABELS: readonly string[] = Object.freeze([
  ...TYPESCRIPT_LANGUAGES,
  ...JAVASCRIPT_LANGUAGES,
]);
