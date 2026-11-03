// `nn-code value-flow` pure analysis policy. No I/O happens here: source text,
// search matches and candidate paths are injected by the caller. The module
// implements the flow-sensitive reaching-definitions engine, path-stack cycle
// versus diamond-join distinction, the single-line 15-feature candidate
// extractor (never sees unread file text/AST), and the frozen `VF-Baseline-0`.
import * as ts from "typescript";
import { declSpanOf, lineColOf, parseSourceFile } from "./cli-call-depth-policy.js";
import type {
  BranchConditionFact,
  BranchConditionKind,
  CliValueFlowGoal,
  DeclSpan,
  ValueFlowEdgeKind,
  ValueFlowProvenancePrecision,
  ValueFlowUnresolvedSite,
  ValuePointRole,
} from "../adapters/cli/value-flow-contract.js";
import { valueFlowWithinScope } from "../adapters/cli/value-flow-contract.js";

export type SearchMatch = Readonly<{
  path: string;
  line: number;
  column: number;
  preview: string;
}>;

export type ValueFlowCorpusFile = Readonly<{
  relPath: string;
  sourceText: string;
}>;

export type FileScopeHeader = Readonly<{
  key: string;
  chain: readonly string[];
  bodySpan: { startLine: number; endLine: number };
  relPath: string;
  exported: boolean;
  nodeStart: number;
  nodeEnd: number;
  parentKey: string | null;
  declaredSymbols: readonly string[];
  freeReadSymbols: readonly string[];
  calledIdentifierNames: readonly string[];
  allIdentifierNames: readonly string[];
  params: readonly Readonly<{
    name: string;
    declarationSpan: DeclSpan;
    pointSpan: DeclSpan;
    initializerSpan: DeclSpan | null;
  }>[];
}>;

export type RawImportRecord = Readonly<{
  localName: string;
  specifier: string;
  importedName: string;
}>;

export type RawExportRecord = Readonly<{
  exportedName: string;
  localName: string | null;
  specifier: string | null;
  sourceName: string | null;
  isStar: boolean;
}>;

export type FileScopeHeaderIndex = Readonly<{
  relPath: string;
  scopes: readonly FileScopeHeader[];
  rawImports: readonly RawImportRecord[];
  rawExports: readonly RawExportRecord[];
  importedBindings: readonly Readonly<{
    bindingName: string;
    moduleSpecifier: string;
    importedName: string;
  }>[];
  exportedNames: readonly string[];
}>;

export type ValueFlowSiteFact = Readonly<{
  siteId: string;
  declId: string | null;
  filePath: string;
  symbolName: string;
  lexicalScopeChain: readonly string[];
  pointRole: ValuePointRole;
  declSpan: DeclSpan;
  pointSpan: DeclSpan;
  minDepth: number;
  expanded: boolean;
}>;

export type ValueFlowEdgeSummary = Readonly<{
  fromSiteId: string;
  toSiteId: string;
  edgeKind: ValueFlowEdgeKind;
  accessPath: string | null;
  provenancePrecision: ValueFlowProvenancePrecision;
  branchConditionAlternatives: readonly (readonly BranchConditionFact[])[];
  branchConditions: readonly BranchConditionFact[];
  isCycleEdge: boolean;
  evidenceSpan: DeclSpan;
}>;

export type ValueFlowAnalysisInput = Readonly<{
  goal: CliValueFlowGoal;
  corpus: readonly ValueFlowCorpusFile[];
  searchCandidates?: readonly string[];
  // In-scope relPaths known from directory enumeration. They let import
  // specifiers resolve to files that are not read yet. Omitting them means the
  // analyzer can only resolve imports against the already-read corpus.
  knownFiles?: readonly string[];
  budgetExhausted?: boolean;
  // Per-file pure-value header indexes built once when `read_source_file`
  // writes the source into the request WorkingSet. When absent the analyzer
  // builds them itself (direct API/tests); `indexParseCount` then reflects
  // those internal builds.
  fileHeaderByPath?: ReadonlyMap<string, FileScopeHeaderIndex>;
}>;

export type ValueFlowStageDiagnostics = Readonly<{
  indexParseCount: number;
  evalParseCount: number;
  poolFactsAllocated: number;
  poolChainsAllocated: number;
  poolChainSetsAllocated: number;
  reachableEdgesMaterialized: number;
  analyzerSites: number;
  analyzerEdges: number;
  poolCleared: boolean;
}>;

export type ValueFlowAnalysisOutput = Readonly<{
  anchorSiteId: string | null;
  anchorRole: ValuePointRole | null;
  anchorResolved: boolean;
  sites: readonly ValueFlowSiteFact[];
  edges: readonly ValueFlowEdgeSummary[];
  unresolvedSites: readonly ValueFlowUnresolvedSite[];
  status: "achieved" | "unknown" | "failed" | "rejected";
  resolution: string;
  nextCandidates: readonly string[];
  totalRelaxations: number;
  reachableSites: number;
  stageDiagnostics: ValueFlowStageDiagnostics;
}>;

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function spanOf(sourceFile: ts.SourceFile, node: ts.Node): DeclSpan {
  return declSpanOf(sourceFile, node);
}

function spanId(span: DeclSpan): string {
  return `${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`;
}

function textOf(sourceFile: ts.SourceFile, node: ts.Node, limit = 120): string {
  const text = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

// Property access carries the field identity of a value (`state.fileReadIo`
// is `.fileReadIo`, not just `state`). Callers reuse this to annotate
// `arg_to_param` edges so a cross-file argument keeps its field path.
function accessPathOf(expression: ts.Expression): string | null {
  const parts: string[] = [];
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  return parts.length === 0 ? null : `.${parts.join(".")}`;
}

function lineSpanOfNode(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

// Callers of an exported symbol live in source files, not in native `.c`,
// markdown or JSON siblings. Only these extensions can hold value-flow facts.
const VALUE_FLOW_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isValueFlowSourceFile(relPath: string): boolean {
  return VALUE_FLOW_SOURCE_EXTENSIONS.some(extension => relPath.endsWith(extension));
}

function rawImportBindings(
  file: FileInfo,
): readonly Readonly<{ bindingName: string; moduleSpecifier: string; importedName: string }>[] {
  const bindings: { bindingName: string; moduleSpecifier: string; importedName: string }[] = [];
  for (const statement of file.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (clause.name !== undefined) {
      bindings.push({
        bindingName: clause.name.text,
        moduleSpecifier,
        importedName: "default",
      });
    }
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({
          bindingName: element.name.text,
          moduleSpecifier,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    } else if (named !== undefined && ts.isNamespaceImport(named)) {
      bindings.push({
        bindingName: named.name.text,
        moduleSpecifier,
        importedName: "*",
      });
    }
  }
  return Object.freeze(bindings.map(binding => Object.freeze(binding)));
}

function exportedNames(sourceFile: ts.SourceFile): readonly string[] {
  const out = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const text = ts.isIdentifier(statement.expression) ? statement.expression.text : null;
      if (text !== null) out.add(text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) ?? []
      : [];
    const isExport = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && isExport) {
      out.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined && isExport) {
      out.add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && isExport) {
      for (const declaration of statement.declarationList.declarations) {
        const bind: string[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) bind.push(node.text);
          else ts.forEachChild(node, visit);
        };
        visit(declaration.name);
        for (const name of bind) out.add(name);
      }
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) out.add(element.name.text);
      }
    }
  }
  return Object.freeze([...out]);
}

/** Pure per-file header index. It never retains a `ts.SourceFile` or node. */
export function buildFileScopeHeaderIndex(relPath: string, sourceText: string): FileScopeHeaderIndex {
  const parsed = parseSourceFile(relPath, sourceText).sourceFile;
  const file: FileInfo = Object.freeze({ relPath, sourceFile: parsed });
  const scopes = collectScopes(file).map(scope => Object.freeze({
    key: scope.key,
    chain: Object.freeze([...scope.chain]),
    bodySpan: Object.freeze({ ...scope.bodySpan }),
    relPath,
    exported: scope.exported,
    nodeStart: scope.nodeStart,
    nodeEnd: scope.nodeEnd,
    parentKey: scope.parentKey,
    declaredSymbols: Object.freeze([...scope.declaredSymbols]),
    freeReadSymbols: Object.freeze([...scope.freeReadSymbols]),
    calledIdentifierNames: Object.freeze([...scope.calledIdentifierNames]),
    allIdentifierNames: Object.freeze([...scope.allIdentifierNames]),
    params: Object.freeze(scope.params.map(param => Object.freeze({
      name: ts.isIdentifier(param.name) ? param.name.text : "$destructure",
      declarationSpan: spanOf(parsed, param),
      pointSpan: spanOf(parsed, ts.isIdentifier(param.name) ? param.name : param),
      initializerSpan: param.initializer === undefined ? null : spanOf(parsed, param.initializer),
    }))),
  }));
  const rawImports = collectRawImports(parsed);
  const rawExports = collectRawExports(parsed);
  return Object.freeze({
    relPath,
    scopes: Object.freeze(scopes),
    rawImports,
    rawExports,
    importedBindings: rawImportBindings(file),
    exportedNames: exportedNames(parsed),
  });
}

// ---------------------------------------------------------------------------
// Canonical DNF branch-condition identities.
//
// The three levels are numeric and include `relPath` in their identity:
//   FactId -> ChainId -> ChainSetId
//
// FactId 0 is reserved. ChainId 0 is the empty conjunction. ChainSetId 0 is
// the singleton disjunction { [] }. Chains are ordered by the canonical
// relPath/line/column/kind key; chain sets are ordered by ChainId. There is no
// chain-count cap, so intersection observes every May alternative.
// ---------------------------------------------------------------------------

type PoolFactRecord = Readonly<{
  relPath: string;
  dedupKey: string;
  orderKey: string;
  fact: BranchConditionFact;
}>;

function factOrderKey(relPath: string, fact: BranchConditionFact): string {
  const line = String(fact.conditionSpan.startLine).padStart(10, "0");
  const column = String(fact.conditionSpan.startColumn).padStart(10, "0");
  return `${relPath}\u0000${line}\u0000${column}\u0000${fact.kind}`;
}

class BranchConditionPool {
  private readonly factByKey = new Map<string, number>();
  private readonly facts: PoolFactRecord[] = [Object.freeze({
    relPath: "",
    dedupKey: "",
    orderKey: "",
    fact: Object.freeze({
      relPath: "",
      kind: "if_true",
      conditionText: null,
      conditionSpan: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    }),
  })];
  private readonly chainByKey = new Map<string, number>();
  private readonly chains: Int32Array[] = [new Int32Array(0)];
  private readonly setByKey = new Map<string, number>();
  private readonly sets: Int32Array[] = [new Int32Array([0])];
  private readonly extendMemo = new Map<string, number>();
  private readonly applyMemo = new Map<string, number>();
  private readonly unionMemo = new Map<string, number>();
  private factsAllocated = 0;
  private chainsAllocated = 0;
  private chainSetsAllocated = 0;

  factId(relPath: string, fact: BranchConditionFact): number {
    const key =
      `${relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`
      + `:${fact.conditionSpan.endLine}:${fact.conditionSpan.endColumn}:${fact.conditionText ?? ""}`;
    const existing = this.factByKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.facts.length;
    this.factByKey.set(key, id);
    this.facts.push(Object.freeze({
      relPath,
      dedupKey: `${relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`,
      orderKey: factOrderKey(relPath, fact),
      fact,
    }));
    this.factsAllocated += 1;
    return id;
  }

  fact(id: number): BranchConditionFact {
    const record = this.facts[id];
    if (record === undefined) throw new RangeError(`unknown FactId ${id}`);
    return record.fact;
  }

  chain(id: number): Int32Array {
    const chain = this.chains[id];
    if (chain === undefined) throw new RangeError(`unknown ChainId ${id}`);
    return chain;
  }

  chainSet(id: number): Int32Array {
    const set = this.sets[id];
    if (set === undefined) throw new RangeError(`unknown ChainSetId ${id}`);
    return set;
  }

  private internChain(factIds: readonly number[]): number {
    const canonical = [...new Set(factIds)]
      .filter(id => id !== 0)
      .sort((left, right) => {
        const leftFact = this.facts[left];
        const rightFact = this.facts[right];
        if (leftFact === undefined || rightFact === undefined) return left - right;
        return leftFact.orderKey < rightFact.orderKey ? -1 : leftFact.orderKey > rightFact.orderKey ? 1 : left - right;
      });
    const deduped: number[] = [];
    const seen = new Set<string>();
    for (const id of canonical) {
      const record = this.facts[id];
      if (record === undefined || seen.has(record.dedupKey)) continue;
      seen.add(record.dedupKey);
      deduped.push(id);
    }
    if (deduped.length === 0) return 0;
    const key = deduped.join(",");
    const existing = this.chainByKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.chains.length;
    this.chainByKey.set(key, id);
    this.chains.push(Int32Array.from(deduped));
    this.chainsAllocated += 1;
    return id;
  }

  chainIdForFacts(chain: readonly BranchConditionFact[]): number {
    if (chain.length === 0) return 0;
    return this.internChain(chain.map(fact => this.factId(fact.relPath, fact)));
  }

  private internChainSet(chainIds: readonly number[]): number {
    const canonical = [...new Set(chainIds)].sort((left, right) => left - right);
    if (canonical.length === 0) return 0;
    const key = canonical.join(",");
    const existing = this.setByKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.sets.length;
    this.setByKey.set(key, id);
    this.sets.push(Int32Array.from(canonical));
    this.chainSetsAllocated += 1;
    return id;
  }

  chainSetForChain(chain: readonly BranchConditionFact[]): number {
    return this.internChainSet([this.chainIdForFacts(chain)]);
  }

  extendChainId(chainId: number, factId: number): number {
    const memoKey = `${chainId}:${factId}`;
    const memo = this.extendMemo.get(memoKey);
    if (memo !== undefined) return memo;
    const chain = this.chain(chainId);
    const incoming = this.facts[factId];
    if (incoming === undefined) throw new RangeError(`unknown FactId ${factId}`);
    for (const existingId of chain) {
      if (this.facts[existingId]?.dedupKey === incoming.dedupKey) {
        this.extendMemo.set(memoKey, chainId);
        return chainId;
      }
    }
    const extended = this.internChain([...chain, factId]);
    this.extendMemo.set(memoKey, extended);
    return extended;
  }

  applyBranchToSet(setId: number, factId: number): number {
    const memoKey = `${setId}:${factId}`;
    const memo = this.applyMemo.get(memoKey);
    if (memo !== undefined) return memo;
    const applied = this.internChainSet(
      [...this.chainSet(setId)].map(chainId => this.extendChainId(chainId, factId)),
    );
    this.applyMemo.set(memoKey, applied);
    return applied;
  }

  unionChainSets(leftSetId: number, rightSetId: number): number {
    const low = Math.min(leftSetId, rightSetId);
    const high = Math.max(leftSetId, rightSetId);
    const memoKey = `${low}:${high}`;
    const memo = this.unionMemo.get(memoKey);
    if (memo !== undefined) return memo;
    const union = this.internChainSet([
      ...this.chainSet(leftSetId),
      ...this.chainSet(rightSetId),
    ]);
    this.unionMemo.set(memoKey, union);
    return union;
  }

  materializeAlternatives(setId: number): readonly (readonly BranchConditionFact[])[] {
    return Object.freeze([...this.chainSet(setId)].map(chainId =>
      Object.freeze([...this.chain(chainId)].map(factId => this.fact(factId)))));
  }

  intersectChainSet(setId: number): readonly BranchConditionFact[] {
    const set = this.chainSet(setId);
    const first = set[0];
    if (first === undefined) return Object.freeze([]);
    const firstChain = this.chain(first);
    if (firstChain.length === 0) return Object.freeze([]);
    const shared = new Set<number>(firstChain);
    for (const chainId of set) {
      const chain = this.chain(chainId);
      const present = new Set(chain);
      for (const factId of [...shared]) if (!present.has(factId)) shared.delete(factId);
    }
    return Object.freeze(
      [...firstChain]
        .filter(factId => shared.has(factId))
        .map(factId => this.fact(factId)),
    );
  }

  allocatedFacts(): number {
    return this.factsAllocated;
  }

  allocatedChains(): number {
    return this.chainsAllocated;
  }

  allocatedChainSets(): number {
    return this.chainSetsAllocated;
  }

  clear(): void {
    this.factByKey.clear();
    this.facts.length = 1;
    this.chainByKey.clear();
    this.chains.length = 1;
    this.setByKey.clear();
    this.sets.length = 1;
    this.extendMemo.clear();
    this.applyMemo.clear();
    this.unionMemo.clear();
    this.factsAllocated = 0;
    this.chainsAllocated = 0;
    this.chainSetsAllocated = 0;
  }
}

function canonicalizeChain(chain: readonly BranchConditionFact[]): readonly BranchConditionFact[] {
  if (chain.length === 0) return Object.freeze([]);
  const seen = new Set<string>();
  const out: BranchConditionFact[] = [];
  for (const fact of chain) {
    const key = `${fact.relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  out.sort((left, right) => {
    const pathDelta = left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0;
    if (pathDelta !== 0) return pathDelta;
    const lineDelta = left.conditionSpan.startLine - right.conditionSpan.startLine;
    return lineDelta !== 0 ? lineDelta : left.conditionSpan.startColumn - right.conditionSpan.startColumn;
  });
  return Object.freeze(out);
}

function chainKey(chain: readonly BranchConditionFact[]): string {
  if (chain.length === 0) return "";
  return canonicalizeChain(chain)
    .map(fact => `${fact.relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`)
    .join("|");
}

function extendChain(
  chain: readonly BranchConditionFact[],
  fact: BranchConditionFact,
): readonly BranchConditionFact[] {
  return canonicalizeChain([...chain, fact]);
}

function intersectChains(
  alternatives: readonly (readonly BranchConditionFact[])[],
): readonly BranchConditionFact[] {
  if (alternatives.length === 0) return Object.freeze([]);
  const first = alternatives[0] ?? [];
  if (alternatives.length === 1) return canonicalizeChain(first);
  const keys = new Set(first.map(fact =>
    `${fact.relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`));
  for (let index = 1; index < alternatives.length; index += 1) {
    const chainKeys = new Set((alternatives[index] ?? []).map(fact =>
      `${fact.relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`));
    for (const key of [...keys]) if (!chainKeys.has(key)) keys.delete(key);
  }
  return canonicalizeChain(first.filter(fact => keys.has(
    `${fact.relPath}\u0000${fact.kind}:${fact.conditionSpan.startLine}:${fact.conditionSpan.startColumn}`,
  )));
}

function posixDirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

function posixNormalize(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function identifierAt(preview: string, column: number): { symbol: string; start: number } {
  const start = Math.max(0, Math.min(Math.max(column - 1, 0), preview.length));
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(preview.slice(start));
  return match === null ? { symbol: "", start } : { symbol: match[0], start };
}

function firstCallParenOffset(afterSymbol: string): number {
  let offset = 0;
  while (offset < afterSymbol.length && /\s/.test(afterSymbol[offset] ?? "")) offset += 1;
  if (afterSymbol[offset] === "<") {
    let depth = 0;
    for (; offset < afterSymbol.length; offset += 1) {
      if (afterSymbol[offset] === "<") depth += 1;
      else if (afterSymbol[offset] === ">") {
        depth -= 1;
        if (depth === 0) { offset += 1; break; }
      }
    }
    while (offset < afterSymbol.length && /\s/.test(afterSymbol[offset] ?? "")) offset += 1;
  }
  return afterSymbol[offset] === "(" ? offset : -1;
}

function callParenInner(text: string, openOffset: number): string | null {
  let depth = 0;
  for (let index = openOffset; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openOffset + 1, index);
    }
  }
  return null;
}

function countTopLevelArgs(inner: string): { count: number; spread: boolean } {
  let depth = 0;
  let count = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; current += ch; }
    else if (ch === ")" || ch === "]" || ch === "}") { depth -= 1; current += ch; }
    else if (ch === "," && depth === 0) {
      if (current.trim().length > 0) count += 1;
      current = "";
    } else current += ch;
  }
  if (current.trim().length > 0) count += 1;
  return { count, spread: inner.includes("...") };
}

function hasAssignmentLike(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "=") continue;
    const prev = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    if (prev === "=" || next === "=" || prev === "!" || prev === "<" || prev === ">") continue;
    return true;
  }
  return false;
}

function hasUnbalancedOpenParen(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/**
 * `H_R` single-line observable feature vector: strictly 15 dimensions
 * (r00..r10 + m00..m03) matching `value-flow-plan.md` §3.2 and
 * `value-flow-training-design.md` §2.2. It can only observe one
 * `SearchMatch { path, line, column, preview }` and must never receive unread
 * file text or a teacher AST.
 */
export function extractUnreadSearchCandidateFeatures(
  direction: "origin" | "sink",
  targetParamIndex: number,
  exportedModulePath: string,
  searchMatch: SearchMatch,
): readonly number[] {
  const preview = searchMatch.preview;
  const located = identifierAt(preview, searchMatch.column);
  const afterSymbol = preview.slice(located.start + located.symbol.length);
  const beforeMatch = preview.slice(0, located.start);
  const parenOffset = firstCallParenOffset(afterSymbol);

  const r00 = direction === "origin" ? 1 : 0;
  const r01 = direction === "sink" ? 1 : 0;
  const r02 = posixDirname(searchMatch.path) === posixDirname(exportedModulePath) ? 1 : 0;
  const r03 = /test|spec|fixture|mock/i.test(searchMatch.path) ? 1 : 0;
  const r04 = parenOffset >= 0 ? 1 : 0;
  const r05 = r04 === 1 && callParenInner(afterSymbol, parenOffset) !== null ? 1 : 0;
  const r06 = hasAssignmentLike(beforeMatch)
    || /return\s*$/.test(beforeMatch)
    || beforeMatch.includes("=>")
    || hasUnbalancedOpenParen(beforeMatch)
    ? 1
    : 0;
  const trimmedBefore = beforeMatch.trim();
  const r07 = r04 === 1 && (trimmedBefore === "" || trimmedBefore === "await" || trimmedBefore === "void") ? 1 : 0;
  const r08 = beforeMatch.includes("//")
    || beforeMatch.includes("/*")
    || /import\s+type\b/.test(preview)
    || /export\s+type\b/.test(preview)
    || /\binterface\s+[A-Za-z_$]/.test(preview)
    || /\btype\s+[A-Za-z_$]/.test(preview)
    ? 1
    : 0;
  const r09 = /^\s*(import|export|function|async\s+function)\b/.test(preview) ? 1 : 0;

  let r10 = 0;
  if (r01 === 1) r10 = 1;
  else if (r00 === 1 && r05 === 1) {
    const inner = callParenInner(afterSymbol, parenOffset);
    if (inner !== null) {
      const { count, spread } = countTopLevelArgs(inner);
      r10 = spread || count >= targetParamIndex + 1 ? 1 : 0;
    }
  }

  const m00 = r04 === 1 && r05 === 1 ? 1 : 0;
  const m01 = r04 === 1 && r06 === 0 && r07 === 1 ? 1 : 0;
  const m02 = 1;
  // m03: when the candidate line lives in a different module than the exported
  // symbol, the real import/require binding cannot be verified from the single
  // line alone. Same-file hits are known to be same-file (not "verified"), so
  // this is the r7 locked `candPath !== exportedModulePath ? 1 : 0` mask.
  const m03 = searchMatch.path === exportedModulePath ? 0 : 1;
  return Object.freeze([r00, r01, r02, r03, r04, r05, r06, r07, r08, r09, r10, m00, m01, m02, m03]);
}

/** Frozen deterministic `VF-Baseline-0` ordering (no training). */
export function sortSearchCandidatesByVfBaseline(
  candidates: readonly SearchMatch[],
  direction: "origin" | "sink",
  targetParamIndex: number,
  exportedModulePath: string,
): readonly SearchMatch[] {
  function rank(candidate: SearchMatch): number {
    return vfBaselinePriorityTier(direction, targetParamIndex, exportedModulePath, candidate);
  }
  return Object.freeze([...candidates].sort((left, right) => {
    const delta = rank(left) - rank(right);
    if (delta !== 0) return delta;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  }));
}

/** Deterministic `VF-Baseline-0` lexical tier. Never a neural score. */
export function vfBaselinePriorityTier(
  direction: "origin" | "sink",
  targetParamIndex: number,
  exportedModulePath: string,
  candidate: SearchMatch,
): 1 | 2 | 3 | 4 {
  const f = extractUnreadSearchCandidateFeatures(direction, targetParamIndex, exportedModulePath, candidate);
  if ((f[2] ?? 0) === 1 && (f[4] ?? 0) === 1 && (f[8] ?? 0) === 0 && (f[9] ?? 0) === 0) return 1;
  if ((f[4] ?? 0) === 1 && (f[8] ?? 0) === 0 && (f[9] ?? 0) === 0) return 2;
  if ((f[9] ?? 0) === 1 && (f[8] ?? 0) === 0) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Flow-sensitive reaching definitions.
// ---------------------------------------------------------------------------

type DeclReachingDefs = Map<string, number>;
type ReachingDefs = Map<string, DeclReachingDefs>;

type SiteRecord = {
  siteId: string;
  declId: string | null;
  filePath: string;
  symbolName: string;
  chain: readonly string[];
  pointRole: ValuePointRole;
  declSpan: DeclSpan;
  pointSpan: DeclSpan;
};

type EdgeRecord = {
  fromSiteId: string;
  toSiteId: string;
  edgeKind: ValueFlowEdgeKind;
  accessPath: string | null;
  evidenceSpan: DeclSpan;
  chainSetId: number;
  inLoop: boolean;
};

type CallRecord = {
  fromFile: string;
  calleeName: string;
  callResultSiteId: string;
  callArgSiteIds: readonly string[];
  callArgAccessPaths: readonly (string | null)[];
  span: DeclSpan;
};

type FileInfo = Readonly<{ relPath: string; sourceFile: ts.SourceFile }>;
type ScopeInfo = Readonly<{
  file: FileInfo;
  chain: readonly string[];
  body: ts.Node;
  params: readonly ts.ParameterDeclaration[];
  key: string;
  exported: boolean;
  bodySpan: { startLine: number; endLine: number };
  nodeStart: number;
  nodeEnd: number;
  parentKey: string | null;
  declaredSymbols: readonly string[];
  freeReadSymbols: readonly string[];
  calledIdentifierNames: readonly string[];
  allIdentifierNames: readonly string[];
}>;

type Analyzer = {
  sites: Map<string, SiteRecord>;
  edges: Map<string, EdgeRecord>;
  unresolved: Map<string, ValueFlowUnresolvedSite>;
  calls: CallRecord[];
  scopeReturns: Map<string, string[]>;
  scopeParams: Map<string, string[]>;
  functionNames: Map<string, string[]>;
  scopeExported: Map<string, boolean>;
  scopeBodySpans: Map<string, { startLine: number; endLine: number }>;
  moduleReachingDefs: Map<string, ReachingDefs>;
  // Per-file imported binding names that were actually used by the analyzer.
  // Only these can pull an unread import target into the candidate frontier;
  // imports that no value-flow fact touches never expand the read set.
  referencedImports: Map<string, Set<string>>;
  // The intern pool lives only for the duration of one `ValueFlowAnalyzer.run()`
  // frame. It is cleared immediately after `traverse()` materializes the reachable
  // edges, so no intermediate FactId / Chain / ChainSet survives.
  pool: BranchConditionPool;
  poolAllocatedFacts: number;
  poolAllocatedChains: number;
  poolAllocatedChainSets: number;
};

type EvalContext = {
  file: FileInfo;
  chain: readonly string[];
  scopeKey: string;
  symbols: Map<string, string>;
  activeBranch: readonly BranchConditionFact[];
  inLoop: boolean;
};

type EvalResult = Readonly<{ roots: readonly string[]; rd: ReachingDefs }>;

function rdClone(rd: ReachingDefs): ReachingDefs {
  const out: ReachingDefs = new Map();
  for (const [declId, decl] of rd) {
    out.set(declId, new Map(decl));
  }
  return out;
}

function rdJoinInto(pool: BranchConditionPool, target: ReachingDefs, source: ReachingDefs): void {
  for (const [declId, decl] of source) {
    const targetDecl = target.get(declId) ?? new Map<string, number>();
    for (const [defId, chainSetId] of decl) {
      const previous = targetDecl.get(defId);
      if (previous === undefined) {
        targetDecl.set(defId, chainSetId);
      } else {
        // r8: no `if_true`/`if_false` complementary reduction anywhere. The
        // union is the exact DNF join; the single-AST pass-through rule at
        // each IfStatement/ConditionalExpression exit is the only
        // simplification mechanism, so cross-iteration facts survive.
        targetDecl.set(defId, pool.unionChainSets(previous, chainSetId));
      }
    }
    target.set(declId, targetDecl);
  }
}

function rdKey(rd: ReachingDefs): string {
  const parts: string[] = [];
  for (const declId of [...rd.keys()].sort()) {
    const decl = rd.get(declId);
    if (decl === undefined) continue;
    const defs: string[] = [];
    for (const defId of [...decl.keys()].sort()) {
      const chainSetId = decl.get(defId);
      if (chainSetId !== undefined) defs.push(`${defId}[${chainSetId}]`);
    }
    parts.push(`${declId}=>${defs.join(",")}`);
  }
  return parts.join("|");
}

function rdApplyBranch(pool: BranchConditionPool, rd: ReachingDefs, factId: number): ReachingDefs {
  const out: ReachingDefs = new Map();
  for (const [declId, decl] of rd) {
    const declOut: DeclReachingDefs = new Map();
    for (const [defId, chainSetId] of decl) declOut.set(defId, pool.applyBranchToSet(chainSetId, factId));
    out.set(declId, declOut);
  }
  return out;
}

function rdStrongAssign(
  rd: ReachingDefs,
  declId: string,
  defSiteId: string,
  chainSetId: number,
): void {
  rd.set(declId, new Map([[defSiteId, chainSetId]]));
}

function declIdFor(filePath: string, chain: readonly string[], symbol: string, declSpan: DeclSpan): string {
  return `${filePath}#${chain.join(".")}:${symbol}@decl(${spanId(declSpan)})`;
}

function siteIdFor(
  filePath: string,
  chain: readonly string[],
  symbol: string,
  role: ValuePointRole,
  pointSpan: DeclSpan,
  declSpan: DeclSpan,
): string {
  return `${filePath}#${chain.join(".")}:${symbol}@${role}(${spanId(pointSpan)})[decl:${declSpan.startLine}:${declSpan.startColumn}]`;
}

function chainSingle(pool: BranchConditionPool, branch: readonly BranchConditionFact[]): number {
  return pool.chainSetForChain(branch);
}

function declDefsEqual(
  left: DeclReachingDefs | undefined,
  right: DeclReachingDefs | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.size !== right.size) return false;
  for (const [defId, chainSetId] of left) {
    if (right.get(defId) !== chainSetId) return false;
  }
  return true;
}

function addSite(a: Analyzer, record: SiteRecord): string {
  if (!a.sites.has(record.siteId)) a.sites.set(record.siteId, record);
  return record.siteId;
}

function addEdge(
  a: Analyzer,
  from: string,
  to: string,
  kind: ValueFlowEdgeKind,
  accessPath: string | null,
  span: DeclSpan,
  chainSetId: number,
  inLoop: boolean,
): void {
  const key = [from, to, kind, accessPath ?? "", spanId(span)].join("\u0000");
  const existing = a.edges.get(key);
  if (existing === undefined) {
    a.edges.set(key, { fromSiteId: from, toSiteId: to, edgeKind: kind, accessPath, evidenceSpan: span, chainSetId, inLoop });
    return;
  }
  existing.chainSetId = a.pool.unionChainSets(existing.chainSetId, chainSetId);
  existing.inLoop = existing.inLoop || inLoop;
}

function bindingLeaves(
  name: ts.BindingName,
  visit: (identifier: ts.Identifier, accessPath: string | null) => void,
  accessPath: string | null = null,
): void {
  if (ts.isIdentifier(name)) { visit(name, accessPath); return; }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : null;
      bindingLeaves(element.name, visit, property === null ? accessPath : `${accessPath ?? ""}.${property}`);
    }
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      bindingLeaves(element.name, visit, `${accessPath ?? ""}[${index}]`);
    });
  }
}

function collectRawImports(sourceFile: ts.SourceFile): readonly RawImportRecord[] {
  const out: RawImportRecord[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) {
      out.push(Object.freeze({ localName: clause.name.text, specifier, importedName: "default" }));
    }
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        out.push(Object.freeze({
          localName: element.name.text,
          specifier,
          importedName: element.propertyName?.text ?? element.name.text,
        }));
      }
    } else if (named !== undefined && ts.isNamespaceImport(named)) {
      out.push(Object.freeze({ localName: named.name.text, specifier, importedName: "*" }));
    }
  }
  return Object.freeze(out);
}

function collectRawExports(sourceFile: ts.SourceFile): readonly RawExportRecord[] {
  const out: RawExportRecord[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      out.push(Object.freeze({
        exportedName: ts.isIdentifier(statement.expression) ? statement.expression.text : "default",
        localName: ts.isIdentifier(statement.expression) ? statement.expression.text : null,
        specifier: null,
        sourceName: null,
        isStar: false,
      }));
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      const clause = statement.exportClause;
      if (clause === undefined) {
        out.push(Object.freeze({ exportedName: "*", localName: null, specifier, sourceName: "*", isStar: true }));
      } else if (ts.isNamespaceExport(clause)) {
        out.push(Object.freeze({ exportedName: clause.name.text, localName: null, specifier, sourceName: "*", isStar: false }));
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          out.push(Object.freeze({
            exportedName: element.name.text,
            localName: specifier === null ? (element.propertyName?.text ?? element.name.text) : null,
            specifier,
            sourceName: specifier === null ? null : (element.propertyName?.text ?? element.name.text),
            isStar: false,
          }));
        }
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const isExport = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExport) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      out.push(Object.freeze({ exportedName: statement.name.text, localName: statement.name.text, specifier: null, sourceName: null, isStar: false }));
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      out.push(Object.freeze({ exportedName: statement.name.text, localName: statement.name.text, specifier: null, sourceName: null, isStar: false }));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindingLeaves(declaration.name, identifier => {
          out.push(Object.freeze({ exportedName: identifier.text, localName: identifier.text, specifier: null, sourceName: null, isStar: false }));
        });
      }
    }
  }
  return Object.freeze(out);
}

function isNestedScopeNode(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isClassDeclaration(node);
}

function pushChildren(stack: ts.Node[], node: ts.Node): void {
  ts.forEachChild(node, child => {
    stack.push(child);
  });
}

type ScopeHeaderStats = Readonly<{
  declaredSymbols: readonly string[];
  freeReadSymbols: readonly string[];
  calledIdentifierNames: readonly string[];
  allIdentifierNames: readonly string[];
}>;

/**
 * Pure-value per-scope symbol facts used by the E1-E4 scope closure. Runs with
 * an explicit stack so a 3000-deep unrelated binary expression cannot overflow
 * the call stack while a sibling scope is indexed. Nested function/class bodies
 * belong to their own scopes and are not descended here.
 */
function collectScopeHeaderStats(
  body: ts.Node,
  params: readonly ts.ParameterDeclaration[],
): ScopeHeaderStats {
  const declared = new Set<string>();
  for (const param of params) bindingLeaves(param.name, identifier => declared.add(identifier.text));

  const declaredStack: ts.Node[] = [body];
  while (declaredStack.length > 0) {
    const node = declaredStack.pop();
    if (node === undefined) continue;
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name !== undefined
    ) {
      declared.add(node.name.text);
      continue;
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) continue;
    if (ts.isVariableDeclaration(node)) {
      bindingLeaves(node.name, identifier => declared.add(identifier.text));
      if (node.initializer !== undefined) declaredStack.push(node.initializer);
      continue;
    }
    if (ts.isParameter(node)) {
      bindingLeaves(node.name, identifier => declared.add(identifier.text));
      if (node.initializer !== undefined) declaredStack.push(node.initializer);
      continue;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) continue;
    if (ts.isImportSpecifier(node)) { declared.add(node.name.text); continue; }
    if (ts.isImportClause(node)) { if (node.name !== undefined) declared.add(node.name.text); continue; }
    if (ts.isNamespaceImport(node)) { declared.add(node.name.text); continue; }
    pushChildren(declaredStack, node);
  }

  const reads = new Set<string>();
  const called = new Set<string>();
  const all = new Set<string>(declared);
  const readStack: ts.Node[] = [body];
  while (readStack.length > 0) {
    const node = readStack.pop();
    if (node === undefined) continue;
    if (isNestedScopeNode(node)) continue;
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer !== undefined) readStack.push(node.initializer);
      continue;
    }
    if (ts.isParameter(node)) {
      if (node.initializer !== undefined) readStack.push(node.initializer);
      continue;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) continue;
    if (ts.isPropertyAccessExpression(node)) {
      readStack.push(node.expression);
      continue;
    }
    if (ts.isPropertyAssignment(node)) {
      readStack.push(node.initializer);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      reads.add(node.name.text);
      all.add(node.name.text);
      continue;
    }
    if (ts.isBindingElement(node)) {
      if (node.initializer !== undefined) readStack.push(node.initializer);
      continue;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let root: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
        root = ts.isPropertyAccessExpression(root) ? root.expression : root.expression;
      }
      if (ts.isIdentifier(root)) called.add(root.text);
      readStack.push(node.expression);
      for (const argument of node.arguments ?? []) readStack.push(argument);
      continue;
    }
    if (ts.isIdentifier(node)) {
      reads.add(node.text);
      all.add(node.text);
      continue;
    }
    pushChildren(readStack, node);
  }

  const freeRead = [...reads].filter(name => !declared.has(name)).sort();
  return Object.freeze({
    declaredSymbols: Object.freeze([...declared].sort()),
    freeReadSymbols: Object.freeze(freeRead),
    calledIdentifierNames: Object.freeze([...called].sort()),
    allIdentifierNames: Object.freeze([...all].sort()),
  });
}

function collectScopes(file: FileInfo): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];
  const moduleKey = `${file.relPath}::`;
  const moduleSpan = lineSpanOfNode(file.sourceFile, file.sourceFile);
  const moduleStats = collectScopeHeaderStats(file.sourceFile, Object.freeze([]));
  scopes.push(Object.freeze({
    file,
    chain: Object.freeze([]) as readonly string[],
    body: file.sourceFile,
    params: Object.freeze([]) as readonly ts.ParameterDeclaration[],
    key: moduleKey,
    exported: true,
    bodySpan: moduleSpan,
    nodeStart: 0,
    nodeEnd: file.sourceFile.end,
    parentKey: null,
    ...moduleStats,
  }));
  function functionName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
    if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text;
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    const start = lineColOf(file.sourceFile, node.getStart(file.sourceFile));
    return `$fn${start.line}_${start.column}`;
  }
  function isExported(node: ts.Node): boolean {
    return ts.canHaveModifiers(node)
      && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  }
  const stack: { node: ts.Node; parentChain: readonly string[]; parentKey: string | null }[] = [];
  const rootChildren: ts.Node[] = [];
  ts.forEachChild(file.sourceFile, child => {
    rootChildren.push(child);
  });
  for (let index = rootChildren.length - 1; index >= 0; index -= 1) {
    const node = rootChildren[index];
    if (node !== undefined) stack.push({ node, parentChain: Object.freeze([]) as readonly string[], parentKey: moduleKey });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const { node, parentChain, parentKey } = current;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const name = functionName(node);
      const chain = Object.freeze([...parentChain, name]);
      const bodySpan = lineSpanOfNode(file.sourceFile, node.body ?? node);
      const bodyNode = node.body ?? node;
      const stats = collectScopeHeaderStats(bodyNode, node.parameters);
      scopes.push(Object.freeze({
        file,
        chain,
        body: bodyNode,
        params: Object.freeze([...node.parameters]),
        key: `${file.relPath}::${chain.join(".")}`,
        exported: isExported(node),
        bodySpan,
        nodeStart: node.getStart(file.sourceFile),
        nodeEnd: node.getEnd(),
        parentKey,
        ...stats,
      }));
      const key = `${file.relPath}::${chain.join(".")}`;
      const children: ts.Node[] = [];
      ts.forEachChild(bodyNode, child => {
        children.push(child);
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push({ node: child, parentChain: chain, parentKey: key });
      }
      continue;
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const name = ts.isIdentifier(node.name)
          ? node.name.text
          : `$fn${lineColOf(file.sourceFile, node.getStart(file.sourceFile)).line}`;
        const chain = Object.freeze([...parentChain, name]);
        const bodySpan = lineSpanOfNode(file.sourceFile, init.body);
        const stats = collectScopeHeaderStats(init.body, init.parameters);
        const key = `${file.relPath}::${chain.join(".")}`;
        scopes.push(Object.freeze({
          file,
          chain,
          body: init.body,
          params: Object.freeze([...init.parameters]),
          key,
          exported: isExported(node.parent.parent ?? node),
          bodySpan,
          nodeStart: node.getStart(file.sourceFile),
          nodeEnd: node.getEnd(),
          parentKey,
          ...stats,
        }));
        const children: ts.Node[] = [];
        ts.forEachChild(init.body, child => {
          children.push(child);
        });
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child !== undefined) stack.push({ node: child, parentChain: chain, parentKey: key });
        }
        continue;
      }
    }
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child, parentChain, parentKey });
    }
  }
  return scopes;
}

function bodyStatements(body: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(body) || ts.isBlock(body)) return body.statements;
  return Object.freeze([]);
}

function collectScopeDeclarations(scope: ScopeInfo): Map<string, string> {
  const declarations = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isClassDeclaration(node)
    ) return;
    if (ts.isVariableDeclaration(node)) {
      bindingLeaves(node.name, identifier => {
        const declSpan = spanOf(scope.file.sourceFile, identifier);
        declarations.set(identifier.text, declIdFor(scope.file.relPath, scope.chain, identifier.text, declSpan));
      });
    }
    ts.forEachChild(node, visit);
  }
  if (ts.isSourceFile(scope.body) || ts.isBlock(scope.body)) {
    for (const statement of scope.body.statements) visit(statement);
  } else visit(scope.body);
  return declarations;
}

function resolveModuleSpecifier(
  fromRelPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posixNormalize(`${posixDirname(fromRelPath)}/${specifier}`);
  const stem = base.replace(/\.js$/, "").replace(/\.mjs$/, "").replace(/\.cjs$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${stem}/index.ts`];
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}

function readImports(
  file: FileInfo,
  known: ReadonlySet<string>,
): Map<string, { file: string; importedName: string }[]> {
  const bindings = new Map<string, { file: string; importedName: string }[]>();
  for (const statement of file.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveModuleSpecifier(file.relPath, statement.moduleSpecifier.text, known);
    if (target === null) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const list = bindings.get(element.name.text) ?? [];
        list.push({ file: target, importedName });
        bindings.set(element.name.text, list);
      }
    }
  }
  return bindings;
}

function readImportsFromHeader(
  header: FileScopeHeaderIndex,
  known: ReadonlySet<string>,
): Map<string, { file: string; importedName: string }[]> {
  const bindings = new Map<string, { file: string; importedName: string }[]>();
  for (const record of header.rawImports) {
    const target = resolveModuleSpecifier(header.relPath, record.specifier, known);
    if (target === null) continue;
    const list = bindings.get(record.localName) ?? [];
    list.push({ file: target, importedName: record.importedName });
    bindings.set(record.localName, list);
  }
  return bindings;
}

function makeFact(
  pool: BranchConditionPool,
  relPath: string,
  sourceFile: ts.SourceFile,
  kind: BranchConditionKind,
  node: ts.Node,
): BranchConditionFact {
  const fact = Object.freeze({
    relPath,
    kind,
    conditionText: kind === "switch_default" ? null : textOf(sourceFile, node, 80),
    conditionSpan: spanOf(sourceFile, node),
  });
  pool.factId(relPath, fact);
  return fact;
}

export class ValueFlowAnalyzer {
  private readonly a: Analyzer = {
    sites: new Map(),
    edges: new Map(),
    unresolved: new Map(),
    calls: [],
    scopeReturns: new Map(),
    scopeParams: new Map(),
    functionNames: new Map(),
    scopeExported: new Map(),
    scopeBodySpans: new Map(),
    moduleReachingDefs: new Map(),
    referencedImports: new Map(),
    pool: new BranchConditionPool(),
    poolAllocatedFacts: 0,
    poolAllocatedChains: 0,
    poolAllocatedChainSets: 0,
  };
  private readonly files = new Map<string, FileInfo>();
  private readonly activeSourceFiles = new Map<string, ts.SourceFile>();
  private readonly globalSymbols = new Map<string, Map<string, string>>();
  private readonly imports = new Map<string, Map<string, { file: string; importedName: string }[]>>();
  private readonly importSiteByDecl = new Map<string, string>();
  private readonly knownFiles = new Set<string>();
  private readonly searchPaths: readonly string[];
  private assignEpoch = 0;
  private readonly lastAssignEpoch = new Map<string, number>();
  private analyzedSourceFiles = new Set<string>();
  // Pure-value header indexes live for the request WorkingSet; the analyzer
  // reads them for scope selection and only parses a file when one of its
  // scopes is actually selected into the scope worklist.
  private readonly headerByPath = new Map<string, FileScopeHeaderIndex>();
  private readonly headerByKey = new Map<string, FileScopeHeader>();
  private readonly scopeInfosByPath = new Map<string, ScopeInfo[]>();
  private readonly readFiles = new Set<string>();
  private readonly readFileOrder: string[] = [];
  private readonly sourceTextByPath = new Map<string, string>();
  private readonly analyzedScopeKeys = new Set<string>();
  private evalParseCount = 0;
  private indexParseCount = 0;
  // Per-scope import closure, computed once at construction. This is the set of
  // in-scope files that are reachable from the already-read corpus by forward
  // import edges (through already-read files only). It is the honest source of
  // "not yet read but in scope and plausibly reachable".
  private readonly importClosure = new Set<string>();
  // Reverse index from a resolved export to every importer of that binding.
  // It follows named re-exports and `export *` chains so origin queries can
  // find callers that import through a barrel file.
  private readonly importersOf = new Map<string, { importerFile: string; localName: string }[]>();

  constructor(
    private readonly goal: CliValueFlowGoal,
    corpus: readonly ValueFlowCorpusFile[],
    knownFiles: readonly string[] = [],
    searchCandidates: readonly string[] = [],
    private readonly fileHeaderByPath: ReadonlyMap<string, FileScopeHeaderIndex> | null = null,
  ) {
    this.searchPaths = Object.freeze([...new Set(searchCandidates)]);
    for (const file of corpus) {
      this.knownFiles.add(file.relPath);
      this.readFiles.add(file.relPath);
      this.readFileOrder.push(file.relPath);
    }
    for (const relPath of knownFiles) this.knownFiles.add(relPath);
    for (const file of corpus) {
      const cached = this.fileHeaderByPath?.get(file.relPath);
      if (cached !== undefined) {
        this.headerByPath.set(file.relPath, cached);
      } else {
        this.headerByPath.set(file.relPath, buildFileScopeHeaderIndex(file.relPath, file.sourceText));
        this.indexParseCount += 1;
      }
      this.sourceTextByPath.set(file.relPath, file.sourceText);
    }
    for (const [relPath, header] of this.headerByPath) {
      this.imports.set(relPath, readImportsFromHeader(header, this.knownFiles));
      for (const scope of header.scopes) this.headerByKey.set(scope.key, scope);
      const functionKeys = header.scopes
        .filter(scope => scope.chain.length > 0)
        .map(scope => scope.key);
      this.a.functionNames.set(relPath, functionKeys);
    }
    this.buildImporterIndex();
    this.computeImportClosure();
  }

  private buildImporterIndex(): void {
    for (const header of this.headerByPath.values()) {
      for (const record of header.rawImports) {
        const targetFile = resolveModuleSpecifier(header.relPath, record.specifier, this.knownFiles);
        if (targetFile === null) continue;
        const origins = this.resolveExportedFromFile(targetFile, record.importedName, new Set());
        for (const origin of origins) {
          if (origin.targetFileUnread) continue;
          const key = `${origin.originFile}\u0000${origin.originLocalName}`;
          const entries = this.importersOf.get(key) ?? [];
          if (!entries.some(entry => entry.importerFile === header.relPath && entry.localName === record.localName)) {
            entries.push({ importerFile: header.relPath, localName: record.localName });
            this.importersOf.set(key, entries);
          }
        }
      }
    }
  }

  private computeImportClosure(): void {
    const seen = new Set<string>();
    const queue = [...this.readFileOrder];
    while (queue.length > 0) {
      const relPath = queue.shift() as string;
      const targets = this.imports.get(relPath) ?? new Map();
      for (const imported of targets.values()) {
        for (const target of imported) {
          if (this.importClosure.has(target.file)) continue;
          if (!valueFlowWithinScope(target.file, this.goal.scopePaths)) continue;
          this.importClosure.add(target.file);
          if (!seen.has(target.file)) {
            seen.add(target.file);
            queue.push(target.file);
          }
        }
      }
    }
    // Do not report files that are already read.
    for (const read of this.readFileOrder) this.importClosure.delete(read);
  }

  private sourceFor(relPath: string): string {
    const text = this.sourceTextByPath.get(relPath);
    if (text === undefined) throw new Error(`value-flow source missing for ${relPath}`);
    return text;
  }

  private fileInfoFor(relPath: string, header: FileScopeHeader): FileInfo {
    let parsed = this.activeSourceFiles.get(relPath);
    if (parsed === undefined) {
      parsed = parseSourceFile(relPath, this.sourceFor(relPath)).sourceFile;
      this.activeSourceFiles.set(relPath, parsed);
      this.evalParseCount += 1;
      // Materialize the whole file's ScopeInfo list once so every selected
      // scope is interpreted against the same real AST.
      const infoList = collectScopes(Object.freeze({ relPath, sourceFile: parsed }));
      this.scopeInfosByPath.set(relPath, infoList);
    }
    const infoList = this.scopeInfosByPath.get(relPath);
    if (infoList === undefined) throw new Error(`value-flow scope info missing for ${relPath}`);
    const match = infoList.find(info => info.key === header.key && info.nodeStart === header.nodeStart && info.nodeEnd === header.nodeEnd);
    if (match === undefined) throw new Error(`value-flow scope ${header.key} not found in ${relPath}`);
    return Object.freeze({ relPath, sourceFile: parsed as ts.SourceFile });
  }

  private ensureFileAnalyzed(relPath: string): void {
    if (this.analyzedSourceFiles.has(relPath)) return;
    this.analyzedSourceFiles.add(relPath);
    const header = this.headerByPath.get(relPath);
    if (header === undefined) throw new Error(`value-flow header missing for ${relPath}`);
    // Parse once for this run; every selected scope in the file is then
    // interpreted from the same activeSourceFiles entry.
    this.fileInfoFor(relPath, header.scopes[0] as FileScopeHeader);
  }

  private analyzeOneScope(key: string): void {
    if (this.analyzedScopeKeys.has(key)) return;
    const header = this.headerByKey.get(key);
    if (header === undefined) return;
    this.analyzedScopeKeys.add(key);
    this.ensureFileAnalyzed(header.relPath);
    const scope = this.scopeFor(header);
    this.analyzeScope(scope);
  }

  private drainScopeWorklist(worklist: readonly string[], enqueued: ReadonlySet<string>): void {
    // Process lexical parents before children so `analyzeScope` can inherit
    // module/ancestor reaching definitions. Use a small DFS stack ordered so
    // the module scope is analyzed first and parent scopes are never skipped.
    const queue = [...worklist];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const key = queue.pop() as string;
      if (visited.has(key)) continue;
      visited.add(key);
      const header = this.headerByKey.get(key);
      if (header === undefined) continue;
      // E1: analyze the module scope and all lexical ancestors first.
      const ancestorPath: string[] = [];
      let parentKey = header.parentKey;
      while (parentKey !== null) {
        ancestorPath.push(parentKey);
        const parentHeader = this.headerByKey.get(parentKey);
        parentKey = parentHeader?.parentKey ?? null;
      }
      for (let index = ancestorPath.length - 1; index >= 0; index -= 1) {
        this.analyzeOneScope(ancestorPath[index] as string);
      }
      this.analyzeOneScope(key);
    }
    this.linkCalls();
  }

  private scopeFor(header: FileScopeHeader): ScopeInfo {
    const headerIndex = this.headerByPath.get(header.relPath);
    const relPath = header.relPath;
    if (headerIndex !== undefined) {
      const precise = headerIndex.scopes.find(scope =>
        scope.key === header.key
        && scope.nodeStart === header.nodeStart
        && scope.nodeEnd === header.nodeEnd);
      if (precise !== undefined) {
        const parsed = this.activeSourceFiles.get(relPath);
        if (parsed !== undefined) {
          const infoList = this.scopeInfosByPath.get(relPath);
          if (infoList !== undefined) {
            const scope = infoList.find(info =>
              info.key === precise.key
              && info.nodeStart === precise.nodeStart
              && info.nodeEnd === precise.nodeEnd);
            if (scope !== undefined) return scope;
          }
        }
      }
    }
    // Fallback: build a ScopeInfo directly from the header metadata.
    const info = collectScopes(Object.freeze({ relPath, sourceFile: this.activeSourceFiles.get(relPath) as ts.SourceFile })).find(
      scope => scope.key === header.key,
    );
    if (info === undefined) {
      if (header.chain.length === 0) {
        return Object.freeze({
          file: Object.freeze({ relPath, sourceFile: this.activeSourceFiles.get(relPath) as ts.SourceFile }),
          chain: header.chain,
          body: this.activeSourceFiles.get(relPath) as ts.SourceFile,
          params: Object.freeze([]),
          key: header.key,
          exported: header.exported,
          bodySpan: header.bodySpan,
          nodeStart: header.nodeStart,
          nodeEnd: header.nodeEnd,
          parentKey: header.parentKey,
          declaredSymbols: header.declaredSymbols,
          freeReadSymbols: header.freeReadSymbols,
          calledIdentifierNames: header.calledIdentifierNames,
          allIdentifierNames: header.allIdentifierNames,
        });
      }
      throw new Error(`value-flow scope ${header.key} could not be materialized`);
    }
    return info;
  }

  private seedScopeBySymbolAndSpan(fileRelPath: string, symbolName: string): readonly string[] {
    const header = this.headerByPath.get(fileRelPath);
    if (header === undefined) return Object.freeze([]);
    const out: string[] = [];
    for (const scope of header.scopes) {
      if (!scope.allIdentifierNames.includes(symbolName)) continue;
      if (this.goal.anchorLexicalPath !== undefined && !this.chainMatches(scope.chain)) continue;
      if (this.goal.anchorLine !== undefined && !this.scopeCoversAnchorLine(scope)) continue;
      out.push(scope.key);
    }
    return Object.freeze(out);
  }

  private resolveAnchorFromHeader(header: FileScopeHeaderIndex): { siteId: string; role: ValuePointRole } | null {
    const site = this.resolveAnchorFromSites(header);
    if (site !== null) return site;
    return null;
  }

  private resolveAnchorFromSites(header: FileScopeHeaderIndex): { siteId: string; role: ValuePointRole } | null {
    const preference: ValuePointRole[] = ["def_param", "def_init", "def_destructure", "def_import", "def_assign", "use_read", "fn_return", "call_arg", "call_result", "expr_leaf"];
    const candidates = [...this.a.sites.values()].filter(site =>
      site.filePath === header.relPath
      && site.symbolName === this.goal.anchorSymbol
      && this.chainMatches(site.chain)
      && this.lineMatches(site.pointSpan));
    if (candidates.length === 0) {
      const sameLine = [...this.a.sites.values()].filter(site =>
        site.filePath === header.relPath
        && site.symbolName === this.goal.anchorSymbol
        && this.chainMatches(site.chain)
        && (this.goal.anchorLine === undefined || site.pointSpan.startLine <= this.goal.anchorLine)
        && (this.goal.anchorLine === undefined || site.pointSpan.endLine >= this.goal.anchorLine));
      if (sameLine.length > 0) {
        sameLine.sort((left, right) => preference.indexOf(left.pointRole) - preference.indexOf(right.pointRole));
        const best = sameLine[0];
        return best === undefined ? null : { siteId: best.siteId, role: best.pointRole };
      }
      const fnReturns = [...this.a.sites.values()].filter(site =>
        site.filePath === header.relPath
        && site.pointRole === "fn_return"
        && (site.chain[site.chain.length - 1] === this.goal.anchorSymbol)
        && (this.goal.anchorLine === undefined
          || (site.pointSpan.startLine <= this.goal.anchorLine && site.pointSpan.endLine >= this.goal.anchorLine)));
      if (fnReturns.length > 0) {
        const best = fnReturns[0];
        return best === undefined ? null : { siteId: best.siteId, role: best.pointRole };
      }
      return null;
    }
    candidates.sort((left, right) => preference.indexOf(left.pointRole) - preference.indexOf(right.pointRole));
    const best = candidates[0];
    return best === undefined ? null : { siteId: best.siteId, role: best.pointRole };
  }

  private hasAnyAnchorCandidateInHeaders(header: FileScopeHeaderIndex): boolean {
    let count = 0;
    for (const scope of header.scopes) {
      if (!scope.allIdentifierNames.includes(this.goal.anchorSymbol)) continue;
      if (this.goal.anchorLexicalPath !== undefined && !this.chainMatches(scope.chain)) continue;
      count += 1;
    }
    return count > 1;
  }

  private growScopeWorklistFromReachable(
    sites: readonly ValueFlowSiteFact[],
    worklist: string[],
    enqueued: Set<string>,
  ): readonly string[] {
    const added: string[] = [];
    const addKeys = (...keys: readonly string[]): void => {
      for (const key of keys) {
        if (enqueued.has(key)) continue;
        enqueued.add(key);
        worklist.push(key);
        added.push(key);
      }
    };
    // E2: for `sink` queries, any scope that captures an outer/module symbol
    // read in a reachable site must itself be analyzed.
    if (this.goal.direction === "sink") {
      const reachableScopeKeys = new Set<string>();
      for (const site of sites) {
        const header = this.headerByPath.get(site.filePath);
        if (header === undefined || site.lexicalScopeChain === undefined) continue;
        const scopeKey = `${site.filePath}::${site.lexicalScopeChain.join(".")}`;
        reachableScopeKeys.add(scopeKey);
        const scope = this.headerByKey.get(scopeKey);
        if (scope === undefined) continue;
        const symbol = site.symbolName;
        // Any child scope that has this symbol in its freeReadSymbols (i.e.
        // not shadowed by its own declarations) captures the outer binding.
        for (const child of header.scopes) {
          if (!child.freeReadSymbols.includes(symbol)) continue;
          // find the lexical owner of the symbol in the child's ancestor chain
          if (this.lexicalBindOwner(child, symbol) === scopeKey) {
            addKeys(child.key);
          }
        }
      }
    }
    // E3: expand callees reached through a call whose argument or result
    // participates in the reachable graph.
    for (const call of this.a.calls) {
      const callSite = this.a.sites.get(call.callResultSiteId);
      if (callSite === undefined) continue;
      const argReached = call.callArgSiteIds.some(arg => {
        const argSite = this.a.sites.get(arg);
        return argSite !== undefined && sites.some(site => site.siteId === argSite.siteId);
      });
      const resultReached = sites.some(site => site.siteId === call.callResultSiteId);
      if (!argReached && !resultReached) continue;
      const targets = this.resolveCalleeKeys(call.fromFile, call.calleeName);
      for (const target of targets) addKeys(target, `${target.split("::").slice(0, 1).join("::")}::`);
    }
    // E4: for `origin` queries, pull in the target function's callers and the
    // importers of exported module values; for `sink`, pull in the exporters
    // of module values consumed at a reached def_import site.
    if (this.goal.direction === "origin") {
      for (const site of sites) {
        if (site.pointRole !== "def_param") continue;
        const scopeKey = `${site.filePath}::${site.lexicalScopeChain.join(".")}`;
        const scopeHeader = this.headerByKey.get(scopeKey);
        if (scopeHeader === undefined) continue;
        const fnName = scopeHeader.chain[scopeHeader.chain.length - 1];
        if (fnName === undefined) continue;
        // Same-file callers: scopes whose calledIdentifierNames includes the
        // function name (not shadowed).
        const ownerHeader = this.headerByPath.get(site.filePath);
        if (ownerHeader !== undefined) {
          for (const candidate of ownerHeader.scopes) {
            if (candidate.key === scopeKey) continue;
            if (candidate.freeReadSymbols.includes(fnName)) addKeys(candidate.key);
          }
        }
        // Cross-file callers: importers of the exported function name,
        // including importers that reach it through named re-exports or
        // `export *` barrels.
        for (const importer of this.importersForExport(site.filePath, fnName)) {
          if (importer.importerFile === site.filePath) continue;
          const importerHeader = this.headerByPath.get(importer.importerFile);
          if (importerHeader === undefined) continue;
          for (const candidate of importerHeader.scopes) {
            if (candidate.freeReadSymbols.includes(importer.localName) || candidate.calledIdentifierNames.includes(importer.localName)) {
              addKeys(candidate.key);
            }
          }
        }
      }
      // Origin module-value importers: any reached def_import site pulls the
      // exporting module scope into the analysis.
      for (const site of sites) {
        if (site.pointRole !== "def_import") continue;
        const headerIndex = this.headerByPath.get(site.filePath);
        if (headerIndex === undefined) continue;
        const importRecord = headerIndex.rawImports.find(record => record.localName === site.symbolName);
        if (importRecord === undefined) continue;
        const origin = this.resolveExportedSymbol(importRecord.specifier, importRecord.importedName);
        for (const candidate of origin) {
          if (!candidate.targetFileUnread) addKeys(`${candidate.originFile}::`);
        }
      }
    } else if (this.goal.direction === "sink") {
      for (const site of sites) {
        if (site.pointRole !== "def_init" && site.pointRole !== "def_destructure" && site.pointRole !== "def_assign") continue;
        if (site.lexicalScopeChain.length !== 0) continue;
        const headerIndex = this.headerByPath.get(site.filePath);
        const exported = headerIndex?.rawExports.some(record =>
          record.exportedName === site.symbolName && record.specifier === null) ?? false;
        if (!exported) continue;
        for (const importer of this.importersForExport(site.filePath, site.symbolName)) {
          addKeys(`${importer.importerFile}::`);
          const importerHeader = this.headerByPath.get(importer.importerFile);
          if (importerHeader === undefined) continue;
          for (const child of importerHeader.scopes) {
            if (child.freeReadSymbols.includes(importer.localName) || child.calledIdentifierNames.includes(importer.localName)) {
              addKeys(child.key);
            }
          }
        }
      }
      // A sink anchor whose reachable site is a function return (or the
      // anchor itself is the exported function) must pull every importer that
      // consumes the returned value, exactly like the module-value def_*
      // branch above. Without this, a `parseSourceFile` return anchor sees
      // only its own site and misses the cross-file `return_to_call_lhs` edges.
      for (const site of sites) {
        if (site.pointRole !== "fn_return") continue;
        const fnName = site.lexicalScopeChain[site.lexicalScopeChain.length - 1];
        if (fnName === undefined) continue;
        const headerIndex = this.headerByPath.get(site.filePath);
        const exported = headerIndex?.rawExports.some(record =>
          record.exportedName === fnName && record.specifier === null) ?? false;
        if (!exported) continue;
        for (const importer of this.importersForExport(site.filePath, fnName)) {
          addKeys(`${importer.importerFile}::`);
          const importerHeader = this.headerByPath.get(importer.importerFile);
          if (importerHeader === undefined) continue;
          for (const child of importerHeader.scopes) {
            if (child.freeReadSymbols.includes(importer.localName) || child.calledIdentifierNames.includes(importer.localName)) {
              addKeys(child.key);
            }
          }
        }
      }
    }
    return Object.freeze(added);
  }

  private resolveCalleeKeys(fromFile: string, name: string): readonly string[] {
    const explicit = [...this.headerByKey.values()]
      .filter(header => header.relPath === fromFile && header.chain[header.chain.length - 1] === name);
    if (explicit.length > 0) return Object.freeze(explicit.map(header => header.key));
    const imports = this.imports.get(fromFile)?.get(name);
    if (imports !== undefined) {
      const out: string[] = [];
      for (const imported of imports) {
        for (const origin of this.resolveExportedFromFile(imported.file, imported.importedName, new Set())) {
          if (origin.targetFileUnread) continue;
          const candidates = [...this.headerByKey.values()].filter(header =>
            header.relPath === origin.originFile
            && header.chain[header.chain.length - 1] === origin.originLocalName);
          for (const candidate of candidates) out.push(candidate.key);
        }
      }
      return Object.freeze([...new Set(out)]);
    }
    return Object.freeze([]);
  }

  private importersForExport(
    originFile: string,
    originLocalName: string,
  ): readonly { importerFile: string; localName: string }[] {
    return Object.freeze(this.importersOf.get(`${originFile}\u0000${originLocalName}`) ?? []);
  }

  private lexicalBindOwner(child: FileScopeHeader, symbol: string): string | null {
    let header: FileScopeHeader | undefined = child;
    let guard = 0;
    while (header !== undefined && guard < 64) {
      const parentHeader = this.headerByKey.get(header.parentKey ?? "");
      if (parentHeader === undefined) break;
      if (parentHeader.declaredSymbols.includes(symbol)) return parentHeader.key;
      header = parentHeader;
      guard += 1;
    }
    return null;
  }

  private resolveExportedSymbol(
    specifier: string,
    exportedName: string,
    visited: ReadonlySet<string> = new Set(),
  ): readonly Readonly<{ originFile: string; originLocalName: string; targetFileUnread: boolean }>[] {
    const fromRelPath = this.anchorFileForSpecifier(specifier);
    return this.resolveExportedFromFile(fromRelPath, exportedName, visited);
  }

  private anchorFileForSpecifier(specifier: string): string {
    if (!specifier.startsWith(".")) return "";
    const base = posixNormalize(`${posixDirname(this.goal.anchorFile)}/${specifier}`);
    const stem = base.replace(/\.js$/, "").replace(/\.mjs$/, "").replace(/\.cjs$/, "");
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${stem}/index.ts`];
    for (const candidate of candidates) if (this.knownFiles.has(candidate)) return candidate;
    return base;
  }

  private resolveExportedFromFile(
    targetFile: string,
    exportedName: string,
    visited: ReadonlySet<string>,
  ): readonly Readonly<{ originFile: string; originLocalName: string; targetFileUnread: boolean }>[] {
    if (targetFile === "" || visited.has(targetFile)) return Object.freeze([]);
    const headerIndex = this.headerByPath.get(targetFile);
    if (headerIndex === undefined) {
      return Object.freeze([Object.freeze({ originFile: targetFile, originLocalName: exportedName, targetFileUnread: true })]);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(targetFile);
    const direct = headerIndex.rawExports.filter(record =>
      record.exportedName === exportedName && record.specifier === null);
    if (direct.length > 0) {
      return Object.freeze(direct.map(record => Object.freeze({
        originFile: targetFile,
        originLocalName: record.localName ?? exportedName,
        targetFileUnread: false,
      })));
    }
    const reexports = headerIndex.rawExports.filter(record =>
      record.exportedName === exportedName && record.specifier !== null);
    const out: { originFile: string; originLocalName: string; targetFileUnread: boolean }[] = [];
    for (const record of reexports) {
      const resolved = this.resolveExportedFromFile(
        this.resolveSpecifierFrom(targetFile, record.specifier as string),
        record.sourceName ?? exportedName,
        nextVisited,
      );
      out.push(...resolved);
    }
    if (out.length === 0) {
      for (const record of headerIndex.rawExports) {
        if (!record.isStar || record.specifier === null) continue;
        const resolved = this.resolveExportedFromFile(
          this.resolveSpecifierFrom(targetFile, record.specifier),
          exportedName,
          nextVisited,
        );
        out.push(...resolved);
      }
    }
    return Object.freeze(out);
  }

  private resolveSpecifierFrom(targetFile: string, specifier: string): string {
    if (!specifier.startsWith(".")) return "";
    const base = posixNormalize(`${posixDirname(targetFile)}/${specifier}`);
    const stem = base.replace(/\.js$/, "").replace(/\.mjs$/, "").replace(/\.cjs$/, "");
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${stem}/index.ts`];
    for (const candidate of candidates) if (this.knownFiles.has(candidate)) return candidate;
    return base;
  }

  run(): ValueFlowAnalysisOutput {
    const anchorHeader = this.headerByPath.get(this.goal.anchorFile);
    if (anchorHeader === undefined) {
      const diagnostics = this.snapshotDiagnostics(0);
      this.clearAnalysisState();
      return this.output(
        null,
        null,
        Object.freeze([]),
        Object.freeze([]),
        Object.freeze([]),
        "unknown",
        "anchor_file_unread",
        Object.freeze([]),
        0,
        { ...diagnostics, poolCleared: true },
      );
    }
    // Select the initial scope worklist: the anchor file's module scope plus
    // every candidate scope that contains the anchor symbol and matches the
    // optional lexical path / line constraints. Each scope's lexical ancestors
    // are added by E1. The E1-E4 closure then grows the worklist until the
    // reachable graph stops changing.
    const worklist: string[] = [];
    const enqueued = new Set<string>();
    const queueScope = (key: string): void => {
      if (enqueued.has(key)) return;
      enqueued.add(key);
      worklist.push(key);
    };
    queueScope(`${this.goal.anchorFile}::`);
    for (const scope of anchorHeader.scopes) {
      const symbolMatch = scope.allIdentifierNames.includes(this.goal.anchorSymbol);
      const lineMatch = this.goal.anchorLine === undefined || this.scopeCoversAnchorLine(scope);
      if (!symbolMatch && !lineMatch) continue;
      if (this.goal.anchorLexicalPath !== undefined && !this.chainMatches(scope.chain)) continue;
      queueScope(scope.key);
    }
    this.drainScopeWorklist(worklist, enqueued);
    let anchorMatch = this.resolveAnchorFromHeader(anchorHeader);
    if (anchorMatch === null) {
      const kind = this.hasAnyAnchorCandidateInHeaders(anchorHeader) ? "ambiguous_anchor_symbol" : "anchor_not_found";
      const unresolved: ValueFlowUnresolvedSite[] = [{
        kind,
        reasonCode: kind === "ambiguous_anchor_symbol" ? "AMBIGUOUS_ANCHOR_SYMBOL" : "ANCHOR_NOT_FOUND",
        siteSpan: anchorHeader.scopes[0]?.bodySpan
          ? { startLine: anchorHeader.scopes[0].bodySpan.startLine, startColumn: 1, endLine: anchorHeader.scopes[0].bodySpan.endLine, endColumn: 1 }
          : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      }];
      const next = this.nextImportCandidates(new Set([...this.readFileOrder]));
      const diagnostics = this.snapshotDiagnostics(0);
      this.clearAnalysisState();
      return this.output(
        null,
        null,
        Object.freeze([]),
        Object.freeze([]),
        Object.freeze(unresolved),
        "unknown",
        "insufficient_evidence",
        Object.freeze(next),
        0,
        { ...diagnostics, poolCleared: true },
      );
    }
    // After the initial closure we may still need to grow the scope set from
    // E3/E4 callee/caller discovery. Run a second fixed-point pass until the
    // reachable graph is stable. The worklist drain returns the newly-added
    // scopes so we can re-link calls and re-traverse.
    for (;;) {
      this.drainScopeWorklist(worklist, enqueued);
      this.linkCalls();
      const anchorResolved = this.resolveAnchorFromHeader(anchorHeader);
      if (anchorResolved === null) break;
      const traversalNow = this.traverse(anchorResolved.siteId);
      const added = this.growScopeWorklistFromReachable(traversalNow.sites, worklist, enqueued);
      if (added.length === 0) break;
      anchorMatch = anchorResolved;
    }
    const traversal = this.traverse(anchorMatch.siteId);
    const diagnostics = this.snapshotDiagnostics(traversal.edges.length);
    const unresolvedList = [...this.a.unresolved.values()];
    const frontierFiles = new Set(traversal.sites.map(site => site.filePath));
    const nextCandidates = this.nextCandidates(frontierFiles);
    let status: ValueFlowAnalysisOutput["status"] = "achieved";
    let resolution = "complete";
    if (this.goal.resultMode !== "one" && nextCandidates.length > 0) {
      // More in-scope files may contain cross-file value-flow edges.
      status = "unknown";
      resolution = "insufficient_evidence";
    }
    // B-b: forward imports are not reverse callers. When the anchor is a
    // parameter of an exported function and direction is origin, an in-scope
    // caller that has not been read leaves cross-file caller coverage open.
    // Report only the open-world boundary, never guessed caller identities.
    if (
      this.goal.resultMode !== "one"
      && this.goal.direction === "origin"
      && anchorMatch.role === "def_param"
      && this.unreadInScopeFiles().length > 0
      && (() => {
        const anchorSite = this.a.sites.get(anchorMatch.siteId);
        if (anchorSite === undefined) return false;
        const scopeKey = `${anchorSite.filePath}::${anchorSite.chain.join(".")}`;
        return this.a.scopeExported.get(scopeKey) === true;
      })()
    ) {
      if (!unresolvedList.some(item => item.kind === "unverified_cross_file_caller_coverage")) {
        const anchorSite = this.a.sites.get(anchorMatch.siteId);
        unresolvedList.push(Object.freeze({
          kind: "unverified_cross_file_caller_coverage" as const,
          reasonCode: "EXPORT_CALLER_ALIAS_OR_REEXPORT_OPEN_WORLD",
          siteSpan: anchorSite?.pointSpan ?? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        }));
      }
      status = "unknown";
      resolution = "insufficient_evidence";
    }
    // Any retained unresolved site makes this analysis incomplete, including
    // unsupported mutation ordering outside the currently traversed chain.
    if (unresolvedList.length > 0) {
      status = "unknown";
      resolution = "insufficient_evidence";
    }
    if (this.goal.resultMode === "one" && traversal.sites.length <= 1) {
      status = "unknown";
      resolution = "insufficient_evidence";
    }
    this.clearAnalysisState();
    return this.output(
      anchorMatch.siteId,
      anchorMatch.role,
      traversal.sites,
      traversal.edges,
      Object.freeze(unresolvedList),
      status,
      resolution,
      Object.freeze(nextCandidates),
      traversal.relaxations,
      { ...diagnostics, poolCleared: true },
    );
  }

  private snapshotDiagnostics(reachableEdgesMaterialized: number): ValueFlowStageDiagnostics {
    return Object.freeze({
      indexParseCount: this.indexParseCount,
      evalParseCount: this.evalParseCount,
      poolFactsAllocated: this.a.pool.allocatedFacts(),
      poolChainsAllocated: this.a.pool.allocatedChains(),
      poolChainSetsAllocated: this.a.pool.allocatedChainSets(),
      reachableEdgesMaterialized,
      analyzerSites: this.a.sites.size,
      analyzerEdges: this.a.edges.size,
      poolCleared: false,
    });
  }

  private clearAnalysisState(): void {
    this.a.pool.clear();
    this.a.sites.clear();
    this.a.edges.clear();
    this.a.moduleReachingDefs.clear();
    this.importSiteByDecl.clear();
    this.activeSourceFiles.clear();
    this.scopeInfosByPath.clear();
    this.sourceTextByPath.clear();
    this.analyzedScopeKeys.clear();
    this.analyzedSourceFiles.clear();
    this.lastAssignEpoch.clear();
  }

  private output(
    anchorSiteId: string | null,
    anchorRole: ValuePointRole | null,
    sites: readonly ValueFlowSiteFact[],
    edges: readonly ValueFlowEdgeSummary[],
    unresolvedSites: readonly ValueFlowUnresolvedSite[],
    status: ValueFlowAnalysisOutput["status"],
    resolution: string,
    nextCandidates: readonly string[],
    totalRelaxations: number,
    stageDiagnostics: ValueFlowStageDiagnostics,
  ): ValueFlowAnalysisOutput {
    return Object.freeze({
      anchorSiteId,
      anchorRole,
      anchorResolved: anchorSiteId !== null,
      sites,
      edges,
      unresolvedSites,
      status,
      resolution,
      nextCandidates,
      totalRelaxations,
      reachableSites: sites.length,
      stageDiagnostics,
    });
  }

  private nextImportCandidates(frontierFiles: ReadonlySet<string>): string[] {
    const out = new Set<string>();
    // A file becomes a next-read candidate only when:
    //   1. A value-flow fact in a file that the current traversal actually
    //      reaches references one of the import names it exports,
    //   2. It is in scope,
    //   3. It is not yet read.
    // This prevents the full import closure (which can be 191 files for
    // scope `lib`) from entering the read queue when only one binding is
    // used by the anchor's traversal.
    for (const relPath of frontierFiles) {
      const referenced = this.a.referencedImports.get(relPath);
      if (referenced === undefined) continue;
      const imports = this.imports.get(relPath);
      if (imports === undefined) continue;
      for (const [bindingName, targets] of imports) {
        if (!referenced.has(bindingName)) continue;
        for (const target of targets) {
          if (!this.readFiles.has(target.file) && valueFlowWithinScope(target.file, this.goal.scopePaths)) {
            out.add(target.file);
          }
        }
      }
    }
    return [...out].sort();
  }

  private nextCandidates(frontierFiles: ReadonlySet<string>): string[] {
    const out = new Set<string>(this.nextImportCandidates(frontierFiles));
    for (const relPath of this.searchPaths) if (!this.readFiles.has(relPath)) out.add(relPath);
    // `all` must close the anchor's own directory even when a sibling file
    // does not contain the anchor symbol literally. Wider scopes keep their
    // unread files in the open-world caller gate instead of reading the whole
    // repository as a side effect of a narrow anchor.
    const anchorDirectory = posixDirname(this.goal.anchorFile);
    for (const relPath of this.knownFiles) {
      if (this.readFiles.has(relPath)) continue;
      if (!valueFlowWithinScope(relPath, this.goal.scopePaths)) continue;
      if (!isValueFlowSourceFile(relPath)) continue;
      if (posixDirname(relPath) === anchorDirectory) out.add(relPath);
    }
    return [...out].sort();
  }

  private unreadInScopeFiles(): string[] {
    return [...this.knownFiles]
      .filter(relPath => !this.readFiles.has(relPath))
      .filter(relPath => valueFlowWithinScope(relPath, this.goal.scopePaths))
      // Only source files can carry caller value-flow facts. Native `.c`,
      // markdown and JSON siblings in the same directory cannot be callers.
      .filter(relPath => isValueFlowSourceFile(relPath))
      .sort();
  }

  private strongAssign(
    rd: ReachingDefs,
    declId: string,
    defSiteId: string,
    branch: readonly BranchConditionFact[],
  ): void {
    rdStrongAssign(rd, declId, defSiteId, chainSingle(this.a.pool, branch));
    this.lastAssignEpoch.set(declId, ++this.assignEpoch);
  }

  private analyzeScope(scope: ScopeInfo): void {
    const symbols = new Map<string, string>();
    const importSiteByDecl = new Map<string, string>();
    const global = this.globalSymbols.get(scope.file.relPath);
    if (global !== undefined) for (const [name, decl] of global) symbols.set(name, decl);
    // Inner scopes inherit the module's import declarations. Recreating them
    // under the inner lexical chain creates a different declId and breaks the
    // reaching-definition edge from the actual import binding.
    if (scope.chain.length === 0) {
      for (const declaration of this.imports.get(scope.file.relPath)?.entries() ?? []) {
        const [name, targets] = declaration;
        const first = targets[0];
        if (first === undefined) continue;
        const identifierSpan = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
        const declSpan = identifierSpan;
        const declId = declIdFor(scope.file.relPath, scope.chain, name, declSpan);
        const siteId = siteIdFor(scope.file.relPath, scope.chain, name, "def_import", declSpan, declSpan);
        addSite(this.a, {
          siteId, declId, filePath: scope.file.relPath, symbolName: name, chain: scope.chain,
          pointRole: "def_import", declSpan, pointSpan: declSpan,
        });
        symbols.set(name, declId);
        importSiteByDecl.set(declId, siteId);
        this.importSiteByDecl.set(declId, siteId);
      }
    }
    const localDeclarations = collectScopeDeclarations(scope);
    for (const [name, decl] of localDeclarations) symbols.set(name, decl);

    let rd: ReachingDefs = new Map();
    const paramSites: string[] = [];
    const ctx: EvalContext = {
      file: scope.file,
      chain: scope.chain,
      scopeKey: scope.key,
      symbols,
      activeBranch: Object.freeze([]) as readonly BranchConditionFact[],
      inLoop: false,
    };
    // Record metadata for every interpreted scope so caller/export gates can
    // distinguish read callers from open-world unread files without guessing.
    this.a.scopeBodySpans.set(scope.key, scope.bodySpan);
    this.a.scopeExported.set(scope.key, scope.exported);
    for (const param of scope.params) {
      const identifier = ts.isIdentifier(param.name) ? param.name : null;
      if (identifier === null) continue;
      const declSpan = spanOf(scope.file.sourceFile, param);
      const pointSpan = spanOf(scope.file.sourceFile, identifier);
      const declId = localDeclarations.get(identifier.text) ?? declIdFor(scope.file.relPath, scope.chain, identifier.text, declSpan);
      symbols.set(identifier.text, declId);
      const siteId = siteIdFor(scope.file.relPath, scope.chain, identifier.text, "def_param", pointSpan, declSpan);
      addSite(this.a, {
        siteId, declId, filePath: scope.file.relPath, symbolName: identifier.text, chain: scope.chain,
        pointRole: "def_param", declSpan, pointSpan,
      });
      paramSites.push(siteId);
      this.strongAssign(rd, declId, siteId, []);
      // A parameter default (`io: FileReadIo = defaultIo`) is the parameter's
      // own initialization when no caller supplies an argument. Record it as a
      // local_init so origin queries can see `defaultIo` as a source of `io`.
      if (param.initializer !== undefined) {
        const init = this.evalExpression(param.initializer, rd, ctx);
        for (const root of init.roots) {
          addEdge(this.a, root, siteId, "local_init", null, spanOf(scope.file.sourceFile, param.initializer), chainSingle(this.a.pool, ctx.activeBranch), false);
        }
        rd = init.rd;
      }
    }
    this.a.scopeParams.set(scope.key, paramSites);
    // Function keys are pre-registered for all scopes in `run()` before any
    // scope is interpreted, so imported callees resolve independent of the
    // order files were read into the corpus.

    if (scope.chain.length === 0) {
      // Module scope: seed import def sites and evaluate top-level statements.
      for (const statement of bodyStatements(scope.body)) {
        if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
        const symbol = statement.name.text;
        const pointSpan = spanOf(scope.file.sourceFile, statement.name);
        const declSpan = spanOf(scope.file.sourceFile, statement);
        const declId = localDeclarations.get(symbol) ?? declIdFor(scope.file.relPath, scope.chain, symbol, pointSpan);
        symbols.set(symbol, declId);
        const siteId = siteIdFor(scope.file.relPath, scope.chain, symbol, "def_init", pointSpan, declSpan);
        addSite(this.a, {
          siteId, declId, filePath: scope.file.relPath, symbolName: symbol, chain: scope.chain,
          pointRole: "def_init", declSpan, pointSpan,
        });
        this.strongAssign(rd, declId, siteId, []);
      }
      for (const [name, declId] of symbols) {
        const importSiteId = importSiteByDecl.get(declId);
        if (importSiteId !== undefined) this.strongAssign(rd, declId, importSiteId, []);
      }
      const moduleSymbols = new Map(symbols);
      this.globalSymbols.set(scope.file.relPath, moduleSymbols);
      const moduleRd = this.interpretStatements(bodyStatements(scope.body), rd, ctx);
      this.a.moduleReachingDefs.set(scope.file.relPath, moduleRd);
      return;
    }

    const rdWithModule = rdClone(rd);
    const moduleRd = this.a.moduleReachingDefs.get(scope.file.relPath);
    if (moduleRd !== undefined) rdJoinInto(this.a.pool, rdWithModule, moduleRd);
    this.interpretStatements(bodyStatements(scope.body), rdWithModule, ctx);
  }

  private interpretStatements(statements: readonly ts.Statement[], rdIn: ReachingDefs, ctx: EvalContext): ReachingDefs {
    let rd = rdIn;
    for (const statement of statements) rd = this.interpretStatement(statement, rd, ctx);
    return rd;
  }

  private interpretStatement(statement: ts.Statement, rd: ReachingDefs, ctx: EvalContext): ReachingDefs {
    if (ts.isVariableStatement(statement)) {
      let current = rd;
      for (const declaration of statement.declarationList.declarations) current = this.interpretVariableDeclaration(declaration, current, ctx);
      return current;
    }
    if (ts.isExpressionStatement(statement)) return this.evalExpression(statement.expression, rd, ctx).rd;
    if (ts.isReturnStatement(statement)) {
      if (statement.expression === undefined) return rd;
      const result = this.evalExpression(statement.expression, rd, ctx);
      const pointSpan = spanOf(ctx.file.sourceFile, statement);
      const symbolName = "return";
      const siteId = siteIdFor(ctx.file.relPath, ctx.chain, symbolName, "fn_return", spanOf(ctx.file.sourceFile, statement.expression), pointSpan);
      addSite(this.a, {
        siteId, declId: null, filePath: ctx.file.relPath, symbolName, chain: ctx.chain,
        pointRole: "fn_return", declSpan: pointSpan, pointSpan,
      });
      for (const root of result.roots) addEdge(this.a, root, siteId, "return_from_fn", null, pointSpan, chainSingle(this.a.pool, ctx.activeBranch), ctx.inLoop);
      const returns = this.a.scopeReturns.get(ctx.scopeKey) ?? [];
      returns.push(siteId);
      this.a.scopeReturns.set(ctx.scopeKey, returns);
      return result.rd;
    }
    if (ts.isIfStatement(statement)) {
      const conditionRd = this.evalExpression(statement.expression, rd, ctx).rd;
      const trueFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "if_true", statement.expression);
      const falseFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "if_false", statement.expression);
      const trueFactId = this.a.pool.factId(ctx.file.relPath, trueFact);
      const falseFactId = this.a.pool.factId(ctx.file.relPath, falseFact);
      const trueCtx: EvalContext = {
        ...ctx,
        activeBranch: canonicalizeChain([...ctx.activeBranch, trueFact]),
      };
      const falseCtx: EvalContext = {
        ...ctx,
        activeBranch: canonicalizeChain([...ctx.activeBranch, falseFact]),
      };
      const epochBeforeBranches = this.assignEpoch;
      const thenIn = rdApplyBranch(this.a.pool, conditionRd, trueFactId);
      const elseIn = rdApplyBranch(this.a.pool, conditionRd, falseFactId);
      const thenRd = this.interpretStatement(statement.thenStatement, thenIn, trueCtx);
      const elseRd = statement.elseStatement === undefined
        ? elseIn
        : this.interpretStatement(statement.elseStatement, elseIn, falseCtx);
      const joined = rdClone(thenRd);
      rdJoinInto(this.a.pool, joined, elseRd);
      for (const [declId, preDeclDefs] of conditionRd) {
        if (
          (this.lastAssignEpoch.get(declId) ?? 0) <= epochBeforeBranches
          && declDefsEqual(thenRd.get(declId), thenIn.get(declId))
          && declDefsEqual(elseRd.get(declId), elseIn.get(declId))
        ) {
          joined.set(declId, new Map(preDeclDefs));
        }
      }
      return joined;
    }
    if (ts.isForStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      return this.interpretLoop(statement, rd, ctx);
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const iterRd = this.evalExpression(statement.expression, rd, ctx).rd;
      let bodyIn = iterRd;
      if (ts.isVariableDeclarationList(statement.initializer)) {
        bodyIn = statement.initializer.declarations.reduce(
          (current, declaration) => this.interpretVariableDeclaration(declaration, current, ctx),
          iterRd,
        );
      }
      const loopFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "loop_body", statement.expression);
      const loopFactId = this.a.pool.factId(ctx.file.relPath, loopFact);
      const loopCtx: EvalContext = { ...ctx, activeBranch: canonicalizeChain([...ctx.activeBranch, loopFact]), inLoop: true };
      return this.interpretStatement(statement.statement, rdApplyBranch(this.a.pool, bodyIn, loopFactId), loopCtx);
    }
    if (ts.isBlock(statement)) return this.interpretStatements(statement.statements, rd, ctx);
    if (ts.isSwitchStatement(statement)) {
      let current = this.evalExpression(statement.expression, rd, ctx).rd;
      for (const clause of statement.caseBlock.clauses) {
        const fact = ts.isCaseClause(clause)
          ? makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "switch_case", clause)
          : makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "switch_default", clause);
        const clauseCtx: EvalContext = { ...ctx, activeBranch: canonicalizeChain([...ctx.activeBranch, fact]) };
        current = this.interpretStatements(clause.statements, rdApplyBranch(this.a.pool, current, this.a.pool.factId(ctx.file.relPath, fact)), clauseCtx);
      }
      return current;
    }
    if (ts.isTryStatement(statement)) {
      let current = this.interpretStatements(statement.tryBlock.statements, rd, ctx);
      if (statement.catchClause !== undefined) current = this.interpretStatements(statement.catchClause.block.statements, current, ctx);
      if (statement.finallyBlock !== undefined) current = this.interpretStatements(statement.finallyBlock.statements, current, ctx);
      return current;
    }
    if (ts.isThrowStatement(statement) && statement.expression !== undefined) {
      return this.evalExpression(statement.expression, rd, ctx).rd;
    }
    return rd;
  }

  private interpretLoop(statement: ts.ForStatement | ts.WhileStatement | ts.DoStatement, rdIn: ReachingDefs, ctx: EvalContext): ReachingDefs {
    let initRd = rdIn;
    let testNode: ts.Node | null = null;
    let body: ts.Statement;
    let update: ts.Expression | null = null;
    if (ts.isForStatement(statement)) {
      if (statement.initializer !== undefined) {
        initRd = ts.isVariableDeclarationList(statement.initializer)
          ? statement.initializer.declarations.reduce((rd, declaration) => this.interpretVariableDeclaration(declaration, rd, ctx), initRd)
          : this.evalExpression(statement.initializer, initRd, ctx).rd;
      }
      testNode = statement.condition ?? statement;
      update = statement.incrementor ?? null;
      body = statement.statement;
    } else if (ts.isWhileStatement(statement)) {
      testNode = statement.expression;
      body = statement.statement;
    } else {
      testNode = statement.expression;
      body = statement.statement;
    }
    const loopFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "loop_body", testNode);
    const loopFactId = this.a.pool.factId(ctx.file.relPath, loopFact);
    const loopCtx: EvalContext = { ...ctx, activeBranch: canonicalizeChain([...ctx.activeBranch, loopFact]), inLoop: true };
    const entry = rdClone(initRd);
    let head = rdClone(initRd);
    const seen = new Set<string>();
    for (;;) {
      const key = rdKey(head);
      if (seen.has(key)) break;
      seen.add(key);
      let bodyIn = rdApplyBranch(this.a.pool, head, loopFactId);
      if (ts.isDoStatement(statement)) bodyIn = rdApplyBranch(this.a.pool, initRd, loopFactId);
      let bodyOut = this.interpretStatement(body, bodyIn, loopCtx);
      if (update !== null) bodyOut = this.evalExpression(update, bodyOut, loopCtx).rd;
      const next = rdClone(entry);
      rdJoinInto(this.a.pool, next, bodyOut);
      head = next;
    }
    return head;
  }

  private interpretVariableDeclaration(declaration: ts.VariableDeclaration, rdIn: ReachingDefs, ctx: EvalContext): ReachingDefs {
    let rd = rdIn;
    let initializerRoots: readonly string[] = Object.freeze([]);
    if (declaration.initializer !== undefined) {
      const result = this.evalExpression(declaration.initializer, rd, ctx);
      rd = result.rd;
      initializerRoots = result.roots;
    }
    const declSpan = spanOf(ctx.file.sourceFile, declaration);
    if (ts.isIdentifier(declaration.name)) {
      const symbol = declaration.name.text;
      const pointSpan = spanOf(ctx.file.sourceFile, declaration.name);
      const declId = ctx.symbols.get(symbol) ?? declIdFor(ctx.file.relPath, ctx.chain, symbol, pointSpan);
      ctx.symbols.set(symbol, declId);
      const siteId = siteIdFor(ctx.file.relPath, ctx.chain, symbol, "def_init", pointSpan, declSpan);
      addSite(this.a, { siteId, declId, filePath: ctx.file.relPath, symbolName: symbol, chain: ctx.chain, pointRole: "def_init", declSpan, pointSpan });
      for (const root of initializerRoots) addEdge(this.a, root, siteId, "local_init", null, pointSpan, chainSingle(this.a.pool, ctx.activeBranch), ctx.inLoop);
      this.strongAssign(rd, declId, siteId, ctx.activeBranch);
      return rd;
    }
    const sourceRoots = initializerRoots;
    bindingLeaves(declaration.name, (identifier, accessPath) => {
      const symbol = identifier.text;
      const pointSpan = spanOf(ctx.file.sourceFile, identifier);
      const declId = ctx.symbols.get(symbol) ?? declIdFor(ctx.file.relPath, ctx.chain, symbol, pointSpan);
      ctx.symbols.set(symbol, declId);
      const siteId = siteIdFor(ctx.file.relPath, ctx.chain, symbol, "def_destructure", pointSpan, declSpan);
      addSite(this.a, { siteId, declId, filePath: ctx.file.relPath, symbolName: symbol, chain: ctx.chain, pointRole: "def_destructure", declSpan, pointSpan });
      for (const root of sourceRoots) addEdge(this.a, root, siteId, "destructure_extract", accessPath, pointSpan, chainSingle(this.a.pool, ctx.activeBranch), ctx.inLoop);
      this.strongAssign(rd, declId, siteId, ctx.activeBranch);
    });
    return rd;
  }

  private evalExpression(expression: ts.Expression, rdIn: ReachingDefs, ctx: EvalContext): EvalResult {
    const expr = unwrapExpression(expression);
    if (ts.isIdentifier(expr)) {
      if (this.imports.get(ctx.file.relPath)?.has(expr.text)) {
        const referenced = this.a.referencedImports.get(ctx.file.relPath) ?? new Set<string>();
        referenced.add(expr.text);
        this.a.referencedImports.set(ctx.file.relPath, referenced);
      }
      const pointSpan = spanOf(ctx.file.sourceFile, expr);
      const declId = ctx.symbols.get(expr.text) ?? null;
      const siteId = siteIdFor(ctx.file.relPath, ctx.chain, expr.text, "use_read", pointSpan, pointSpan);
      addSite(this.a, { siteId, declId, filePath: ctx.file.relPath, symbolName: expr.text, chain: ctx.chain, pointRole: "use_read", declSpan: pointSpan, pointSpan });
      const decl = declId === null ? undefined : rdIn.get(declId);
      if (decl !== undefined) {
        for (const [defSiteId, chains] of decl) addEdge(this.a, defSiteId, siteId, "reaching_def", null, pointSpan, chains, ctx.inLoop);
      }
      return { roots: Object.freeze([siteId]), rd: rdIn };
    }
    if (
      ts.isStringLiteral(expr) || ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr)
      || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isRegularExpressionLiteral(expr)
      || expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword
      || expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.ThisKeyword
      || expr.kind === ts.SyntaxKind.SuperKeyword
    ) {
      return { roots: Object.freeze([this.leaf(expr, ctx)]), rd: rdIn };
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return this.evalExpression(expr.expression, rdIn, ctx);
    }
    if (ts.isElementAccessExpression(expr)) {
      const base = this.evalExpression(expr.expression, rdIn, ctx);
      const index = this.evalExpression(expr.argumentExpression, base.rd, ctx);
      return { roots: Object.freeze([...base.roots, ...index.roots]), rd: index.rd };
    }
    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
      return this.evalCall(expr, rdIn, ctx);
    }
    if (ts.isBinaryExpression(expr)) {
      if (expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        const left = this.evalExpression(expr.left, rdIn, ctx);
        return this.evalExpression(expr.right, left.rd, ctx);
      }
      const operator = expr.operatorToken.kind;
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
        if (operator !== ts.SyntaxKind.EqualsToken) {
          this.addUnresolved("unsupported_subexpression_mutation_order", "EMBEDDED_ASSIGNMENT_OR_UPDATE_EXPR", spanOf(ctx.file.sourceFile, expr));
        }
        const right = this.evalExpression(expr.right, rdIn, ctx);
        if (ts.isIdentifier(expr.left) && operator === ts.SyntaxKind.EqualsToken) {
          const symbol = expr.left.text;
          const declId = ctx.symbols.get(symbol) ?? declIdFor(ctx.file.relPath, ctx.chain, symbol, spanOf(ctx.file.sourceFile, expr.left));
          ctx.symbols.set(symbol, declId);
          const pointSpan = spanOf(ctx.file.sourceFile, expr.left);
          const siteId = siteIdFor(ctx.file.relPath, ctx.chain, symbol, "def_assign", pointSpan, pointSpan);
          addSite(this.a, { siteId, declId, filePath: ctx.file.relPath, symbolName: symbol, chain: ctx.chain, pointRole: "def_assign", declSpan: pointSpan, pointSpan });
          for (const root of right.roots) addEdge(this.a, root, siteId, "local_assign", null, pointSpan, chainSingle(this.a.pool, ctx.activeBranch), ctx.inLoop);
          this.strongAssign(right.rd, declId, siteId, ctx.activeBranch);
          return { roots: Object.freeze([siteId]), rd: right.rd };
        }
        const left = this.evalExpression(expr.left, right.rd, ctx);
        return { roots: right.roots, rd: left.rd };
      }
      const left = this.evalExpression(expr.left, rdIn, ctx);
      const right = this.evalExpression(expr.right, left.rd, ctx);
      return { roots: Object.freeze([...left.roots, ...right.roots]), rd: right.rd };
    }
    if (ts.isConditionalExpression(expr)) {
      const condition = this.evalExpression(expr.condition, rdIn, ctx);
      const trueFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "ternary_true", expr.condition);
      const falseFact = makeFact(this.a.pool, ctx.file.relPath, ctx.file.sourceFile, "ternary_false", expr.condition);
      const trueFactId = this.a.pool.factId(ctx.file.relPath, trueFact);
      const falseFactId = this.a.pool.factId(ctx.file.relPath, falseFact);
      const epochBeforeBranches = this.assignEpoch;
      const trueIn = rdApplyBranch(this.a.pool, condition.rd, trueFactId);
      const falseIn = rdApplyBranch(this.a.pool, condition.rd, falseFactId);
      const trueResult = this.evalExpression(expr.whenTrue, trueIn, { ...ctx, activeBranch: canonicalizeChain([...ctx.activeBranch, trueFact]) });
      const falseResult = this.evalExpression(expr.whenFalse, falseIn, { ...ctx, activeBranch: canonicalizeChain([...ctx.activeBranch, falseFact]) });
      const joined = rdClone(trueResult.rd);
      rdJoinInto(this.a.pool, joined, falseResult.rd);
      for (const [declId, preDeclDefs] of condition.rd) {
        if (
          (this.lastAssignEpoch.get(declId) ?? 0) <= epochBeforeBranches
          && declDefsEqual(trueResult.rd.get(declId), trueIn.get(declId))
          && declDefsEqual(falseResult.rd.get(declId), falseIn.get(declId))
        ) {
          joined.set(declId, new Map(preDeclDefs));
        }
      }
      return { roots: Object.freeze([...trueResult.roots, ...falseResult.roots]), rd: joined };
    }
    if (ts.isAwaitExpression(expr)) return this.evalExpression(expr.expression, rdIn, ctx);
    if (ts.isTemplateExpression(expr)) {
      let rd = rdIn;
      const roots: string[] = [];
      for (const span of expr.templateSpans) {
        const part = this.evalExpression(span.expression, rd, ctx);
        rd = part.rd;
        roots.push(...part.roots);
      }
      return { roots: Object.freeze(roots.length > 0 ? roots : [this.leaf(expr, ctx)]), rd };
    }
    if (ts.isObjectLiteralExpression(expr)) {
      let rd = rdIn;
      const roots: string[] = [];
      for (const property of expr.properties) {
        if (ts.isPropertyAssignment(property)) {
          const part = this.evalExpression(property.initializer, rd, ctx);
          rd = part.rd;
          roots.push(...part.roots);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const part = this.evalExpression(property.name, rd, ctx);
          rd = part.rd;
          roots.push(...part.roots);
        } else if (ts.isSpreadAssignment(property)) {
          const part = this.evalExpression(property.expression, rd, ctx);
          rd = part.rd;
          roots.push(...part.roots);
        }
      }
      return { roots: Object.freeze(roots.length > 0 ? roots : [this.leaf(expr, ctx)]), rd };
    }
    if (ts.isArrayLiteralExpression(expr)) {
      let rd = rdIn;
      const roots: string[] = [];
      for (const element of expr.elements) {
        const part = this.evalExpression(element, rd, ctx);
        rd = part.rd;
        roots.push(...part.roots);
      }
      return { roots: Object.freeze(roots.length > 0 ? roots : [this.leaf(expr, ctx)]), rd };
    }
    if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
      const operand = ts.isPrefixUnaryExpression(expr) ? expr.operand : expr.operand;
      if (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken) {
          this.addUnresolved("unsupported_subexpression_mutation_order", "EMBEDDED_ASSIGNMENT_OR_UPDATE_EXPR", spanOf(ctx.file.sourceFile, expr));
      }
      return this.evalExpression(operand, rdIn, ctx);
    }
    return { roots: Object.freeze([this.leaf(expr, ctx)]), rd: rdIn };
  }

  private evalCall(expr: ts.CallExpression | ts.NewExpression, rdIn: ReachingDefs, ctx: EvalContext): EvalResult {
    let rd = rdIn;
    const callee = expr.expression;
    let receiverRoots: string[] = [];
    if (ts.isIdentifier(callee)) {
      rd = this.evalExpression(callee, rd, ctx).rd;
    } else if (ts.isPropertyAccessExpression(callee)) {
      // A method call's result value depends on its receiver object as well as
      // its arguments (e.g. `prefix.slice(...)` derives from `prefix`). Keep
      // those receiver roots so loop back-edges such as `prefix =
      // prefix.slice(...)` form a real reaching-definition cycle.
      const receiver = this.evalExpression(callee.expression, rd, ctx);
      rd = receiver.rd;
      receiverRoots = [...receiver.roots];
    }
    const argRoots: string[] = [];
    const argSites: string[] = [];
    const argAccessPaths: (string | null)[] = [];
    for (const argument of expr.arguments ?? []) {
      const result = this.evalExpression(argument, rd, ctx);
      rd = result.rd;
      argRoots.push(...result.roots);
      const accessPath = accessPathOf(argument);
      argAccessPaths.push(accessPath);
      const pointSpan = spanOf(ctx.file.sourceFile, argument);
      const argSymbol = accessPath === null ? textOf(ctx.file.sourceFile, argument, 40) : textOf(ctx.file.sourceFile, argument, 80);
      const siteId = siteIdFor(ctx.file.relPath, ctx.chain, argSymbol, "call_arg", pointSpan, pointSpan);
      addSite(this.a, { siteId, declId: null, filePath: ctx.file.relPath, symbolName: argSymbol, chain: ctx.chain, pointRole: "call_arg", declSpan: pointSpan, pointSpan });
      for (const root of result.roots) addEdge(this.a, root, siteId, "arg_to_param", accessPath, pointSpan, chainSingle(this.a.pool, ctx.activeBranch), ctx.inLoop);
      argSites.push(siteId);
    }
    const valueRoots = [...receiverRoots, ...argRoots];
    const calleeName = ts.isIdentifier(callee) ? callee.text : null;
    if (calleeName === null) {
      return { roots: Object.freeze(valueRoots.length > 0 ? valueRoots : [this.leaf(expr, ctx)]), rd };
    }
    const target = this.resolveCallee(ctx.file.relPath, calleeName);
    if (target === null) {
      return { roots: Object.freeze(valueRoots.length > 0 ? valueRoots : [this.leaf(expr, ctx)]), rd };
    }
    const callSpan = spanOf(ctx.file.sourceFile, expr);
    const resultSiteId = siteIdFor(ctx.file.relPath, ctx.chain, "call", "call_result", callSpan, callSpan);
    addSite(this.a, { siteId: resultSiteId, declId: null, filePath: ctx.file.relPath, symbolName: "call", chain: ctx.chain, pointRole: "call_result", declSpan: callSpan, pointSpan: callSpan });
    this.a.calls.push({
      fromFile: ctx.file.relPath,
      calleeName,
      callResultSiteId: resultSiteId,
      callArgSiteIds: Object.freeze(argSites),
      callArgAccessPaths: Object.freeze(argAccessPaths),
      span: callSpan,
    });
    return { roots: Object.freeze([resultSiteId]), rd };
  }

  private leaf(expr: ts.Expression, ctx: EvalContext): string {
    const pointSpan = spanOf(ctx.file.sourceFile, expr);
    const siteId = siteIdFor(ctx.file.relPath, ctx.chain, textOf(ctx.file.sourceFile, expr, 24), "expr_leaf", pointSpan, pointSpan);
    addSite(this.a, {
      siteId, declId: null, filePath: ctx.file.relPath, symbolName: textOf(ctx.file.sourceFile, expr, 24),
      chain: ctx.chain, pointRole: "expr_leaf", declSpan: pointSpan, pointSpan,
    });
    return siteId;
  }

  private addUnresolved(
    kind: ValueFlowUnresolvedSite["kind"],
    reasonCode: string,
    siteSpan: DeclSpan,
  ): void {
    const key = `${kind}:${reasonCode}:${spanId(siteSpan)}`;
    if (!this.a.unresolved.has(key)) {
      this.a.unresolved.set(key, Object.freeze({ kind, reasonCode, siteSpan }));
    }
  }

  private resolveCallee(fromFile: string, name: string): string | null {
    const local = (this.a.functionNames.get(fromFile) ?? []).filter(key => key.endsWith(`::${name}`) || key.endsWith(`.${name}`));
    if (local.length === 1) return local[0] ?? null;
    const imports = this.imports.get(fromFile)?.get(name);
    if (imports !== undefined) {
      for (const imported of imports) {
        const candidates = (this.a.functionNames.get(imported.file) ?? []).filter(key =>
          key.endsWith(`::${imported.importedName}`) || key.endsWith(`.${imported.importedName}`));
        if (candidates.length === 1) return candidates[0] ?? null;
      }
    }
    return null;
  }

  private linkCalls(): void {
    for (const call of this.a.calls) {
      const target = this.resolveCallee(call.fromFile, call.calleeName);
      if (target === null) continue;
      const params = this.a.scopeParams.get(target) ?? [];
      call.callArgSiteIds.forEach((argSiteId, index) => {
        const paramSite = params[index];
        if (paramSite !== undefined) {
          const accessPath = call.callArgAccessPaths[index] ?? null;
          addEdge(this.a, argSiteId, paramSite, "arg_to_param", accessPath, call.span, chainSingle(this.a.pool, []), false);
        }
      });
      const returns = this.a.scopeReturns.get(target) ?? [];
      for (const returnSite of returns) {
        addEdge(this.a, returnSite, call.callResultSiteId, "return_to_call_lhs", null, call.span, chainSingle(this.a.pool, []), false);
      }
    }
    this.linkModuleBindings();
  }

  private linkModuleBindings(): void {
    for (const [fromFile, bindings] of this.imports) {
      const moduleSymbols = this.globalSymbols.get(fromFile);
      if (moduleSymbols === undefined) continue;
      for (const [localName, targets] of bindings) {
        const importDeclId = moduleSymbols.get(localName);
        const importSiteId = importDeclId === undefined ? undefined : this.importSiteByDecl.get(importDeclId);
        const importSite = importSiteId === undefined ? undefined : this.a.sites.get(importSiteId);
        if (importSiteId === undefined || importSite === undefined) continue;
        for (const target of targets) {
          const origins = this.resolveExportedFromFile(target.file, target.importedName, new Set());
          for (const origin of origins) {
            if (origin.targetFileUnread) continue;
            const originSymbols = this.globalSymbols.get(origin.originFile);
            const originDeclId = originSymbols?.get(origin.originLocalName);
            const originDefs = originDeclId === undefined
              ? undefined
              : this.a.moduleReachingDefs.get(origin.originFile)?.get(originDeclId);
            if (originDefs === undefined) continue;
            for (const [defSiteId, chainSetId] of originDefs) {
              addEdge(this.a, defSiteId, importSiteId, "reaching_def", null, importSite.pointSpan, chainSetId, false);
            }
          }
        }
      }
    }
  }

  private chainMatches(chain: readonly string[]): boolean {
    const path = this.goal.anchorLexicalPath;
    if (path === undefined) return true;
    const joined = chain.join(".");
    return joined === path || joined.endsWith(`.${path}`) || chain[chain.length - 1] === path;
  }

  private lineMatches(span: DeclSpan): boolean {
    if (this.goal.anchorLine !== undefined && span.startLine !== this.goal.anchorLine) return false;
    if (this.goal.anchorColumn !== undefined && span.startColumn !== this.goal.anchorColumn) return false;
    return true;
  }

  // A scope owns an anchor line when the line falls inside its body block or
  // inside one of its parameter declarations. Multi-line signatures place
  // parameter anchors before the body block, so the body span alone would drop
  // the very scope that resolves the anchor (`rawRequest`, `io`, `relPath`).
  private scopeCoversAnchorLine(scope: FileScopeHeader): boolean {
    const line = this.goal.anchorLine;
    if (line === undefined) return true;
    if (scope.bodySpan.startLine <= line && scope.bodySpan.endLine >= line) return true;
    for (const param of scope.params) {
      if (param.pointSpan.startLine <= line && param.pointSpan.endLine >= line) return true;
      if (param.declarationSpan.startLine <= line && param.declarationSpan.endLine >= line) return true;
    }
    return false;
  }

  // Only edges that actually derive a new value consume depth. Reaching
  // definitions, the callee-return binding and the caller-side argument
  // capture are identity/plumbing: they resolve which value is meant, so they
  // never push the frontier deeper. The callee-side `arg_to_param` binding is
  // the real crossing of a call boundary and does count.
  private edgeWeight(edge: EdgeRecord): number {
    if (edge.edgeKind === "reaching_def" || edge.edgeKind === "return_to_call_lhs") return 0;
    if (edge.edgeKind === "arg_to_param") {
      const target = this.a.sites.get(edge.toSiteId);
      return target?.pointRole === "call_arg" ? 0 : 1;
    }
    return 1;
  }

  private traverse(anchorSiteId: string): { sites: ValueFlowSiteFact[]; edges: ValueFlowEdgeSummary[]; relaxations: number } {
    const edges = [...this.a.edges.values()];
    const incoming = new Map<string, EdgeRecord[]>();
    const outgoing = new Map<string, EdgeRecord[]>();
    for (const edge of edges) {
      (incoming.get(edge.toSiteId) ?? incoming.set(edge.toSiteId, []).get(edge.toSiteId) ?? []).push(edge);
      (outgoing.get(edge.fromSiteId) ?? outgoing.set(edge.fromSiteId, []).get(edge.fromSiteId) ?? []).push(edge);
    }
    const minDepth = new Map<string, number>();
    const expanded = new Map<string, number>();
    const reachedEdges = new Map<string, { edge: EdgeRecord; cycle: boolean }>();
    let relaxations = 0;

    // Explicit DFS work stack with one in-place path set. The recursive
    // `visit` allocated a fresh `Set([...ancestors, next])` per step, which is
    // the deep-node growth source; the frame stack keeps exactly the current
    // root-to-node path in `ancestors` and mutates it on enter/exit.
    type TraverseFrame = { siteId: string; depth: number; adjacency: EdgeRecord[]; index: number };
    const adjacencyOf = (siteId: string): EdgeRecord[] =>
      this.goal.direction === "origin" ? incoming.get(siteId) ?? [] : outgoing.get(siteId) ?? [];
    const ancestors = new Set<string>([anchorSiteId]);
    const stack: TraverseFrame[] = [{
      siteId: anchorSiteId,
      depth: 0,
      adjacency: adjacencyOf(anchorSiteId),
      index: 0,
    }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      if (frame.index >= frame.adjacency.length) {
        stack.pop();
        ancestors.delete(frame.siteId);
        continue;
      }
      const edge = frame.adjacency[frame.index];
      frame.index += 1;
      if (edge === undefined) continue;
      const next = this.goal.direction === "origin" ? edge.fromSiteId : edge.toSiteId;
      const candidateDepth = frame.depth + this.edgeWeight(edge);
      if (candidateDepth > this.goal.maxDepth) continue;
      const cycle = next === frame.siteId || ancestors.has(next);
      const edgeKey = [edge.fromSiteId, edge.toSiteId, edge.edgeKind, edge.accessPath ?? "", spanId(edge.evidenceSpan)].join("\u0000");
      const existing = reachedEdges.get(edgeKey);
      if (existing === undefined) reachedEdges.set(edgeKey, { edge, cycle });
      else if (cycle) existing.cycle = true;
      if (cycle) continue;
      const previous = minDepth.get(next);
      if (previous === undefined || candidateDepth < previous) {
        if (previous !== undefined) relaxations += 1;
        minDepth.set(next, candidateDepth);
      }
      const expandedAt = expanded.get(next);
      if (expandedAt !== undefined && expandedAt <= candidateDepth) continue;
      expanded.set(next, candidateDepth);
      ancestors.add(next);
      stack.push({ siteId: next, depth: candidateDepth, adjacency: adjacencyOf(next), index: 0 });
    }
    minDepth.set(anchorSiteId, 0);

    const sites: ValueFlowSiteFact[] = [];
    for (const [siteId, depth] of minDepth) {
      const record = this.a.sites.get(siteId);
      if (record === undefined) continue;
      sites.push(Object.freeze({
        siteId: record.siteId,
        declId: record.declId,
        filePath: record.filePath,
        symbolName: record.symbolName,
        lexicalScopeChain: record.chain,
        pointRole: record.pointRole,
        declSpan: record.declSpan,
        pointSpan: record.pointSpan,
        minDepth: depth,
        expanded: expanded.has(siteId),
      }));
    }
    const summaries: ValueFlowEdgeSummary[] = [];
    for (const { edge, cycle } of reachedEdges.values()) {
      const alternatives = this.a.pool.materializeAlternatives(edge.chainSetId);
      summaries.push(Object.freeze({
        fromSiteId: edge.fromSiteId,
        toSiteId: edge.toSiteId,
        edgeKind: edge.edgeKind,
        accessPath: edge.accessPath,
        provenancePrecision: this.provenance(alternatives, edge.inLoop),
        branchConditionAlternatives: alternatives,
        branchConditions: this.a.pool.intersectChainSet(edge.chainSetId),
        isCycleEdge: cycle,
        evidenceSpan: edge.evidenceSpan,
      }));
    }
    return { sites, edges: summaries, relaxations };
  }

  private provenance(
    alternatives: readonly (readonly BranchConditionFact[])[],
    inLoop: boolean,
  ): ValueFlowProvenancePrecision {
    if (inLoop || alternatives.some(chain => chain.some(fact => fact.kind === "loop_body"))) return "may_loop_fixpoint";
    if (alternatives.length > 1 || alternatives.some(chain => chain.length > 0)) return "may_branch_disjunction";
    return "exact_unconditional";
  }
}

export function analyzeValueFlow(input: ValueFlowAnalysisInput): ValueFlowAnalysisOutput {
  try {
    const analyzer = new ValueFlowAnalyzer(
      input.goal,
      input.corpus,
      input.knownFiles ?? Object.freeze([]),
      input.searchCandidates ?? Object.freeze([]),
      input.fileHeaderByPath ?? null,
    );
    const result = analyzer.run();
    return input.budgetExhausted === true
      ? Object.freeze({ ...result, status: "unknown", resolution: "budget_exhausted" })
      : result;
  } catch (error) {
    // E: a RangeError from recursive AST interpretation is a legal boundary,
    // not a silent crash. Only the confirmed stack-overflow type maps to
    // STACK_OVERFLOW_OR_PARSE_LIMIT; any other error keeps its real name.
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      const anchorFile = input.corpus.find(file => file.relPath === input.goal.anchorFile);
      const siteSpan = anchorFile === undefined
        ? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }
        : thisAnchorSpan(anchorFile);
      return Object.freeze({
        anchorSiteId: null,
        anchorRole: null,
        anchorResolved: false,
        sites: Object.freeze([]),
        edges: Object.freeze([]),
        unresolvedSites: Object.freeze([Object.freeze({
          kind: "unresolved_missing_or_ambiguous_target" as const,
          reasonCode: "STACK_OVERFLOW_OR_PARSE_LIMIT" as const,
          siteSpan,
        })]),
        status: "unknown" as const,
        resolution: "insufficient_evidence",
        nextCandidates: Object.freeze([]),
        totalRelaxations: 0,
        reachableSites: 0,
        stageDiagnostics: Object.freeze({
          indexParseCount: 0,
          evalParseCount: 0,
          poolFactsAllocated: 0,
          poolChainsAllocated: 0,
          poolChainSetsAllocated: 0,
          reachableEdgesMaterialized: 0,
          analyzerSites: 0,
          analyzerEdges: 0,
          poolCleared: true,
        }),
      });
    }
    throw error;
  }
}

function thisAnchorSpan(file: { relPath: string; sourceText: string }): DeclSpan {
  const lines = file.sourceText.split("\n");
  if (lines.length === 0) return { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
  return { startLine: 1, startColumn: 1, endLine: 1, endColumn: Math.max(1, lines[0]?.length ?? 1) };
}

export { spanOf, spanId, textOf, unwrapExpression, canonicalizeChain, chainKey, extendChain, intersectChains, makeFact, lineColOf };
