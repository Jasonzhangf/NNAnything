// Deterministic Rust call-graph policy for `nn-code calls --language rust`.
// The parser is tree-sitter-rust. This module performs no OS I/O: source text
// is supplied by the caller through the injected ModuleStore. Every edge is
// backed by an explicit crate/module/use/inherent-impl binding; anything that
// needs trait resolution, macro expansion or cfg activation stays structured
// unknown. No fallback name matching fabricates an edge.
import Parser from "tree-sitter";
import RustLanguage from "tree-sitter-rust";
import { withinScope } from "./cli-call-depth-policy.js";
import type {
  CallDepthUnresolvedKind,
  CallGraphNodeFact,
  CallGraphResolvedEdgeFact,
  DeclSpan,
} from "../adapters/cli/call-depth-contract.js";

export const RUST_CALL_DEPTH_ACTUAL_PARSER = "tree-sitter-rust" as const;

export type RustUnresolvedKind = CallDepthUnresolvedKind | "unsupported_syntax";
export type RustCoverageStatus =
  | "boundary_not_expanded"
  | "locatable_candidate_unverified"
  | "truly_dynamic_unlocatable";

export type RustUnresolvedCallsite = Readonly<{
  callerId: string;
  calleeExpr: string;
  callsiteSpan: DeclSpan;
  kind: RustUnresolvedKind;
  reasonCode: string;
  targetSymbolClue: string | null;
  missingEvidence: readonly string[];
  coverageStatus: RustCoverageStatus;
  moduleSpecifierClue: string | null;
  candidateModulePath: string | null;
  bindingDeclarationSpan: DeclSpan | null;
}>;

export type RustParam = Readonly<{
  name: string;
  typeText: string | null;
  span: DeclSpan;
}>;

export type RustDecl = Readonly<{
  name: string;
  chain: string;
  typeName: string | null;
  implKind: "fn" | "inherent" | "trait";
  traitName: string | null;
  span: DeclSpan;
  nameSpan: DeclSpan;
  body: Parser.SyntaxNode | null;
  params: readonly RustParam[];
  modulePath: readonly string[];
  isCfgGated: boolean;
}>;

export type RustUse = Readonly<{
  name: string;
  targetSegments: readonly string[] | null;
  globBase: readonly string[] | null;
  span: DeclSpan;
}>;

export type RustMod = Readonly<{ name: string; span: DeclSpan; inline: boolean }>;

export type RustType = Readonly<{ name: string; span: DeclSpan; isCfgGated: boolean }>;

export type RustFileInfo = Readonly<{
  relPath: string;
  srcDir: string;
  modulePath: readonly string[];
  sourceText: string;
  decls: readonly RustDecl[];
  traitMethods: readonly Readonly<{ typeName: string; methodName: string; span: DeclSpan }>[];
  traitMethodNames: readonly string[];
  types: readonly RustType[];
  uses: readonly RustUse[];
  mods: readonly RustMod[];
  genericParams: ReadonlySet<string>;
}>;

export type RustModuleStore = Readonly<{
  get(relPath: string): RustFileInfo | undefined;
  has(relPath: string): boolean;
  isMissing(relPath: string): boolean;
  request(relPath: string): void;
}>;

export type RustAnalysis = Readonly<{
  nodes: readonly CallGraphNodeFact[];
  edges: readonly CallGraphResolvedEdgeFact[];
  unresolvedCallsites: readonly RustUnresolvedCallsite[];
  pendingReads: readonly string[];
  entryResolved: boolean;
  entryResolution: "ok" | "entry_not_found" | "ambiguous_entry_symbol";
  entryNodeId: string | null;
  termination: Readonly<{ status: "unmet"; resolution: "entry_not_found" | "ambiguous_entry_symbol" }> | null;
  bodyExtractedCount: number;
  closedCallsiteCount: number;
}>;

type CallsiteShape = "ident" | "scoped" | "method" | "macro";

type RustCallsite = Readonly<{
  shape: CallsiteShape;
  calleeExpr: string;
  span: DeclSpan;
  name: string;
  segments: readonly string[];
  methodName: string | null;
  receiverExpr: string | null;
}>;

type Resolution =
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "resolved"; originFile: string; decl: RustDecl }>
  | Readonly<{
      kind: "unresolved";
      reasonCode: string;
      unresolvedKind: RustUnresolvedKind;
      targetSymbolClue: string | null;
      missingEvidence: readonly string[];
      coverageStatus: RustCoverageStatus;
      moduleSpecifierClue: string | null;
      candidateModulePath: string | null;
      bindingDeclarationSpan: DeclSpan | null;
    }>;

const EXTERNAL_ROOTS = new Set([
  "std", "core", "alloc", "tokio", "serde", "serde_json", "serde_yaml", "futures",
  "futures_util", "async_trait", "thiserror", "regex", "reqwest", "toml", "tracing",
  "log", "uuid", "bytes", "http", "hyper", "axum", "anyhow", "rand", "time",
]);

const parser = new Parser();
parser.setLanguage(RustLanguage as never);

let declarationCache: WeakMap<Parser.SyntaxNode, RustFileInfo> | null = null;
void declarationCache;

function spanOf(node: Parser.SyntaxNode): DeclSpan {
  return Object.freeze({
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  });
}

function spanText(source: string, node: Parser.SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function splitCrateSrc(relPath: string): Readonly<{ srcDir: string; within: string }> | null {
  const norm = normalizePath(relPath);
  if (norm === "src/lib.rs" || norm === "src/main.rs" || norm.startsWith("src/")) {
    return Object.freeze({ srcDir: "src", within: norm.slice(4) });
  }
  const marker = "/src/";
  const index = norm.lastIndexOf(marker);
  if (index < 0) return null;
  return Object.freeze({
    srcDir: `${norm.slice(0, index)}/src`,
    within: norm.slice(index + marker.length),
  });
}

export function rustSrcDirOf(relPath: string): string {
  const split = splitCrateSrc(relPath);
  return split === null ? "" : split.srcDir;
}

export function rustModulePathOf(relPath: string): readonly string[] {
  const split = splitCrateSrc(relPath);
  if (split === null) return Object.freeze([]);
  const within = split.within;
  if (within === "lib.rs" || within === "main.rs") return Object.freeze([]);
  const segments = within.split("/");
  const last = segments.at(-1) ?? "";
  if (last === "mod.rs") return Object.freeze(segments.slice(0, -1));
  return Object.freeze([...segments.slice(0, -1), last.replace(/\.rs$/, "")]);
}

function segmentsOf(node: Parser.SyntaxNode): readonly string[] {
  if (node.type === "scoped_identifier") {
    const left = node.namedChildren[0];
    const right = node.namedChild(1);
    if (left === undefined || left === null || right === undefined || right === null) return Object.freeze([node.text]);
    return Object.freeze([...segmentsOf(left), right.text]);
  }
  if (node.type === "identifier" || node.type === "crate" || node.type === "super" || node.type === "self" || node.type === "metavariable") {
    return Object.freeze([node.text]);
  }
  return Object.freeze([node.text]);
}

function lastNamed(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.namedChild(node.namedChildCount - 1);
}

function isCfgAttribute(node: Parser.SyntaxNode): boolean {
  if (node.type !== "attribute_item") return false;
  const attribute = node.namedChildren[0];
  if (attribute === undefined || attribute.type !== "attribute") return false;
  const head = attribute.namedChildren[0];
  return head !== undefined && (head.text === "cfg" || head.text === "cfg_attr");
}

function parametersOf(fn: Parser.SyntaxNode, source: string): readonly RustParam[] {
  const paramsNode = fn.childForFieldName("parameters");
  if (paramsNode === null) return Object.freeze([]);
  const out: RustParam[] = [];
  for (const child of paramsNode.namedChildren) {
    if (child.type === "self_parameter") {
      out.push(Object.freeze({ name: "self", typeText: "Self", span: spanOf(child) }));
      continue;
    }
    if (child.type !== "parameter") continue;
    const pattern = child.namedChild(0);
    const typeNode = lastNamed(child);
    if (pattern === null || typeNode === null || pattern.type !== "identifier") continue;
    out.push(Object.freeze({
      name: pattern.text,
      typeText: spanText(source, typeNode).trim(),
      span: spanOf(pattern),
    }));
  }
  return Object.freeze(out);
}

function directChildren(node: Parser.SyntaxNode): readonly Parser.SyntaxNode[] {
  return node.namedChildren;
}

function collectDecls(source: string, modulePath: readonly string[]): Readonly<{
  decls: readonly RustDecl[];
  types: readonly RustType[];
  traitMethods: readonly Readonly<{ typeName: string; methodName: string; span: DeclSpan }>[];
  traitMethodNames: readonly string[];
  genericParams: ReadonlySet<string>;
}> {
  const decls: RustDecl[] = [];
  const types: RustType[] = [];
  const traitMethods: { typeName: string; methodName: string; span: DeclSpan }[] = [];
  const traitMethodNames = new Set<string>();
  const genericParams = new Set<string>();
  const root = parser.parse(source).rootNode;

  function fnDecl(fn: Parser.SyntaxNode, typeName: string | null, implKind: "fn" | "inherent" | "trait", traitName: string | null, cfg: boolean): RustDecl {
    const nameNode = fn.childForFieldName("name");
    const body = fn.childForFieldName("body");
    const name = nameNode === null ? "" : nameNode.text;
    const params = parametersOf(fn, source);
    for (const parameter of params) {
      if (parameter.typeText !== null && /^[A-Z]$/.test(parameter.typeText)) genericParams.add(parameter.typeText);
    }
    const typeParameters = fn.namedChildren.find(child => child.type === "type_parameters");
    if (typeParameters !== undefined) {
      for (const child of typeParameters.namedChildren) {
        if (child.type === "type_identifier") genericParams.add(child.text);
        if (child.type === "constrained_type_parameter") {
          const first = child.namedChildren[0];
          if (first !== undefined && first.type === "type_identifier") genericParams.add(first.text);
        }
      }
    }
    return Object.freeze({
      name,
      chain: typeName === null ? name : `${typeName}::${name}`,
      typeName,
      implKind,
      traitName,
      span: spanOf(fn),
      nameSpan: nameNode === null ? spanOf(fn) : spanOf(nameNode),
      body,
      params,
      modulePath,
      isCfgGated: cfg,
    });
  }

  function walk(node: Parser.SyntaxNode, cfg: boolean): void {
    let pendingCfg = false;
    for (const child of directChildren(node)) {
      if (child.type === "attribute_item") {
        pendingCfg = isCfgAttribute(child);
        continue;
      }
      const gated = cfg || pendingCfg;
      pendingCfg = false;
      if (child.type === "function_item") {
        decls.push(fnDecl(child, null, "fn", null, gated));
        continue;
      }
      if (child.type === "struct_item") {
        const nameNode = child.childForFieldName("name");
        if (nameNode !== null) types.push(Object.freeze({ name: nameNode.text, span: spanOf(child), isCfgGated: gated }));
        continue;
      }
      if (child.type === "trait_item") {
        const nameNode = child.childForFieldName("name");
        const traitName = nameNode === null ? "" : nameNode.text;
        const body = child.childForFieldName("body");
        for (const item of body?.namedChildren ?? []) {
          if (item.type === "function_signature_item" || item.type === "function_item") {
            const method = item.childForFieldName("name");
            if (method !== null) {
              traitMethodNames.add(method.text);
              traitMethods.push(Object.freeze({ typeName: traitName, methodName: method.text, span: spanOf(item) }));
            }
          }
        }
        continue;
      }
      if (child.type === "impl_item") {
        const traitNode = child.childForFieldName("trait");
        const typeNode = child.childForFieldName("type");
        const body = child.childForFieldName("body");
        if (typeNode === null || body === null) continue;
        const typeName = typeNode.type === "type_identifier" ? typeNode.text : typeNode.text;
        const traitName = traitNode === null ? null : traitNode.text;
        for (const item of body.namedChildren) {
          let methodCfg = false;
          if (item.type === "attribute_item") { methodCfg = isCfgAttribute(item); continue; }
          if (item.type !== "function_item") { methodCfg = false; continue; }
          const decl = fnDecl(item, typeName, traitName === null ? "inherent" : "trait", traitName, gated || methodCfg);
          if (traitName !== null) {
            traitMethodNames.add(decl.name);
            traitMethods.push(Object.freeze({ typeName, methodName: decl.name, span: decl.span }));
          } else {
            decls.push(decl);
          }
          methodCfg = false;
        }
        continue;
      }
      if (child.type === "mod_item") {
        const body = child.childForFieldName("body");
        if (body !== null) {
          const nameNode = child.childForFieldName("name");
          walk(body, gated || (nameNode === null ? false : false));
        }
        continue;
      }
    }
  }

  walk(root, false);
  return Object.freeze({
    decls: Object.freeze(decls),
    types: Object.freeze(types),
    traitMethods: Object.freeze(traitMethods),
    traitMethodNames: Object.freeze([...traitMethodNames]),
    genericParams,
  });
}

function collectUses(source: string): readonly RustUse[] {
  const tree = parser.parse(source);
  const uses: RustUse[] = [];

  function pushNamed(segments: readonly string[], alias: string | null, node: Parser.SyntaxNode): void {
    const name = alias ?? segments.at(-1) ?? "";
    if (name.length === 0 || segments.length === 0) return;
    uses.push(Object.freeze({ name, targetSegments: Object.freeze([...segments]), globBase: null, span: spanOf(node) }));
  }

  function walkUseList(base: readonly string[], node: Parser.SyntaxNode): void {
    if (node.type === "use_list") {
      for (const item of node.namedChildren) walkUseList(base, item);
      return;
    }
    if (node.type === "identifier") {
      pushNamed([...base, node.text], null, node);
      return;
    }
    if (node.type === "self") {
      pushNamed(base, null, node);
      return;
    }
    if (node.type === "use_as_clause") {
      const original = node.namedChildren[0];
      const alias = node.namedChild(1);
      if (original === undefined || alias === null) return;
      const originalSegments = node.type === "use_as_clause" ? segmentsOf(original) : Object.freeze([original.text]);
      pushNamed([...base, ...originalSegments], alias.text, node);
      return;
    }
    if (node.type === "scoped_use_list") {
      const left = node.namedChildren[0];
      const list = node.namedChild(1);
      if (left === undefined || list === null) return;
      walkUseList([...base, ...segmentsOf(left)], list);
      return;
    }
    if (node.type === "scoped_identifier") {
      pushNamed([...base, ...segmentsOf(node)], null, node);
      return;
    }
  }

  for (const item of tree.rootNode.namedChildren) {
    if (item.type !== "use_declaration") continue;
    const argument = item.childForFieldName("argument") ?? item.namedChildren.find(child => child.type !== "visibility_modifier") ?? null;
    if (argument === null) continue;
    if (argument.type === "use_wildcard") {
      const base = argument.namedChild(0);
      if (base !== null) {
        const baseSegments = base.type === "scoped_identifier" ? [...segmentsOf(base)] : [...segmentsOf(base)];
        uses.push(Object.freeze({
          name: "*",
          targetSegments: Object.freeze(baseSegments),
          globBase: Object.freeze(baseSegments),
          span: spanOf(item),
        }));
      }
      continue;
    }
    if (argument.type === "scoped_use_list") {
      const left = argument.namedChildren[0];
      const list = argument.namedChild(1);
      if (left === undefined || list === null) continue;
      walkUseList(segmentsOf(left), list);
      continue;
    }
    if (argument.type === "use_as_clause") {
      const original = argument.namedChildren[0];
      const alias = argument.namedChild(1);
      if (original === undefined || alias === null) continue;
      pushNamed(segmentsOf(original), alias.text, item);
      continue;
    }
    if (argument.type === "identifier" || argument.type === "scoped_identifier") {
      pushNamed(segmentsOf(argument), null, item);
    }
  }
  return Object.freeze(uses);
}

function collectMods(source: string): readonly RustMod[] {
  const tree = parser.parse(source);
  const mods: RustMod[] = [];
  for (const item of tree.rootNode.namedChildren) {
    if (item.type !== "mod_item") continue;
    const nameNode = item.childForFieldName("name");
    if (nameNode === null) continue;
    mods.push(Object.freeze({ name: nameNode.text, span: spanOf(item), inline: item.childForFieldName("body") !== null }));
  }
  return Object.freeze(mods);
}

export function parseRustSourceFile(relPath: string, sourceText: string): RustFileInfo {
  const srcDir = rustSrcDirOf(relPath);
  const modulePath = rustModulePathOf(relPath);
  const declarations = collectDecls(sourceText, modulePath);
  return Object.freeze({
    relPath,
    srcDir,
    modulePath,
    sourceText,
    decls: declarations.decls,
    traitMethods: declarations.traitMethods,
    traitMethodNames: declarations.traitMethodNames,
    types: declarations.types,
    uses: collectUses(sourceText),
    mods: collectMods(sourceText),
    genericParams: declarations.genericParams,
  });
}

export type RustEntryStatus = "found" | "ambiguous" | "not_found";

export type RustEntryResult =
  | Readonly<{ status: "found"; decl: RustDecl }>
  | Readonly<{ status: "ambiguous" }>
  | Readonly<{ status: "not_found" }>;

export function resolveRustEntry(info: RustFileInfo, entrySymbol: string): RustEntryResult {
  const separators = entrySymbol.split("::").filter(part => part.length > 0);
  const pick = separators.length >= 2
    ? info.decls.filter(decl => decl.typeName === separators[0] && decl.name === separators[1])
    : info.decls.filter(decl => decl.name === entrySymbol);
  if (pick.length === 0) return Object.freeze({ status: "not_found" as const });
  if (pick.length > 1) return Object.freeze({ status: "ambiguous" as const });
  return Object.freeze({ status: "found" as const, decl: pick[0]! });
}

function nodeIdOf(decl: RustDecl, filePath: string): string {
  return `${filePath}#${decl.chain}`;
}

function tryFiles(
  store: RustModuleStore,
  candidates: readonly string[],
): Readonly<{ kind: "found"; path: string; info: RustFileInfo }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> {
  const present: { path: string; info: RustFileInfo }[] = [];
  let pending = false;
  for (const candidate of candidates) {
    const info = store.get(candidate);
    if (info !== undefined) { present.push({ path: candidate, info }); continue; }
    if (store.isMissing(candidate)) continue;
    store.request(candidate);
    pending = true;
  }
  if (present.length > 1) return Object.freeze({ kind: "ambiguous" as const });
  if (present.length === 1) return Object.freeze({ kind: "found" as const, ...present[0]! });
  if (pending) return Object.freeze({ kind: "pending" as const });
  return Object.freeze({ kind: "missing" as const });
}

function fileForModule(
  store: RustModuleStore,
  srcDir: string,
  moduleSegments: readonly string[],
): Readonly<{ kind: "found"; path: string; info: RustFileInfo }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> {
  if (moduleSegments.length === 0) {
    return tryFiles(store, [`${srcDir}/lib.rs`, `${srcDir}/main.rs`]);
  }
  const joined = moduleSegments.join("/");
  return tryFiles(store, [`${srcDir}/${joined}.rs`, `${srcDir}/${joined}/mod.rs`]);
}

function moduleContextSegments(
  caller: RustFileInfo,
  segments: readonly string[],
): Readonly<{ context: readonly string[]; rest: readonly string[] }> | null {
  const first = segments[0];
  if (first === undefined) return null;
  if (first === "crate") return Object.freeze({ context: Object.freeze([]), rest: segments.slice(1) });
  if (first === "self") return Object.freeze({ context: caller.modulePath, rest: segments.slice(1) });
  if (first === "super") {
    let context = [...caller.modulePath];
    let index = 0;
    while (segments[index] === "super") {
      context = context.slice(0, -1);
      index += 1;
    }
    return Object.freeze({ context: Object.freeze(context), rest: segments.slice(index) });
  }
  return null;
}

function findOwnUse(info: RustFileInfo, name: string): RustUse | undefined {
  return info.uses.find(item => item.name === name && item.globBase === null);
}

function findGlobUses(info: RustFileInfo): readonly RustUse[] {
  return info.uses.filter(item => item.globBase !== null);
}

type TypeRef = Readonly<{
  typeName: string;
  moduleSegments: readonly string[] | null;
  externalCrate: string | null;
  dynamic: boolean;
}>;

function stripOuterType(typeText: string): string {
  let text = typeText.trim();
  for (;;) {
    if (text.startsWith("&")) { text = text.slice(1).trim(); continue; }
    if (text.startsWith("mut ")) { text = text.slice(4).trim(); continue; }
    const wrapper = /^(?:Arc|Box|Rc)<(.+)>$/.exec(text);
    if (wrapper !== null) { text = wrapper[1]!.trim(); continue; }
    break;
  }
  return text;
}

function typeRefFromText(typeText: string | null, caller: RustFileInfo, callerDecl: RustDecl): TypeRef | null {
  if (typeText === null) return null;
  const stripped = stripOuterType(typeText);
  if (stripped.includes("dyn ") || stripped.startsWith("impl ")) {
    return Object.freeze({ typeName: stripped, moduleSegments: null, externalCrate: null, dynamic: true });
  }
  if (stripped === "Self") {
    if (callerDecl.typeName === null) return null;
    return Object.freeze({ typeName: callerDecl.typeName, moduleSegments: caller.modulePath, externalCrate: null, dynamic: false });
  }
  const segments = stripped.replace(/<.*$/s, "").trim().split("::").filter(part => part.length > 0);
  if (segments.length === 0) return null;
  const last = segments.at(-1)!;
  if (caller.genericParams.has(last) || /^[A-Z]$/.test(last) && caller.genericParams.has(last)) {
    return Object.freeze({ typeName: last, moduleSegments: null, externalCrate: null, dynamic: true });
  }
  if (/^[A-Z]$/.test(last)) {
    return Object.freeze({ typeName: last, moduleSegments: null, externalCrate: null, dynamic: true });
  }
  if (segments.length === 1) {
    return Object.freeze({ typeName: last, moduleSegments: null, externalCrate: null, dynamic: false });
  }
  const head = segments[0]!;
  const moduleSegments = segments.slice(0, -1);
  if (head === "crate" || head === "super" || head === "self") {
    return Object.freeze({ typeName: last, moduleSegments, externalCrate: null, dynamic: false });
  }
  if (head === "std" || head === "core" || EXTERNAL_ROOTS.has(head)) {
    return Object.freeze({ typeName: last, moduleSegments, externalCrate: head, dynamic: false });
  }
  return Object.freeze({ typeName: last, moduleSegments, externalCrate: null, dynamic: false });
}

function localBindingFor(receiver: string, callerDecl: RustDecl, caller: RustFileInfo): Readonly<{
  typeText: string | null;
  span: DeclSpan | null;
  isClosure: boolean;
}> | null {
  const parameter = callerDecl.params.find(item => item.name === receiver);
  if (parameter !== undefined) {
    return Object.freeze({ typeText: parameter.typeText, span: parameter.span, isClosure: parameter.typeText !== null && parameter.typeText.includes("Fn") });
  }
  const body = callerDecl.body;
  if (body === null) return null;
  const source = caller.sourceText;
  for (const declaration of body.descendantsOfType("let_declaration")) {
    const pattern = declaration.namedChild(0);
    if (pattern === null || pattern.type !== "identifier" || pattern.text !== receiver) continue;
    const initializer = declaration.namedChild(1);
    if (initializer === null) return Object.freeze({ typeText: null, span: spanOf(pattern), isClosure: false });
    if (initializer.type === "closure_expression") {
      return Object.freeze({ typeText: null, span: spanOf(declaration), isClosure: true });
    }
    if (initializer.type === "call_expression") {
      const callee = calleeNodeOf(initializer);
      if (callee !== null && callee.type === "scoped_identifier") {
        const segments = segmentsOf(callee);
        if (segments.length === 2) {
          return Object.freeze({ typeText: segments[0]!, span: spanOf(declaration), isClosure: false });
        }
      }
      return Object.freeze({ typeText: null, span: spanOf(declaration), isClosure: false });
    }
    if (initializer.type === "struct_expression") {
      const typeNode = initializer.childForFieldName("type") ?? initializer.namedChild(0);
      if (typeNode !== null) return Object.freeze({ typeText: typeNode.text, span: spanOf(declaration), isClosure: false });
    }
    const typeAnnotation = declaration.childForFieldName("type");
    if (typeAnnotation !== null) return Object.freeze({ typeText: typeAnnotation.text, span: spanOf(declaration), isClosure: false });
    return Object.freeze({ typeText: null, span: spanOf(declaration), isClosure: false });
  }
  return null;
  void source;
}

function calleeNodeOf(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let node = call.namedChild(0);
  while (node !== null && node.type === "generic_function") {
    node = node.namedChild(0);
  }
  return node;
}

function resolveSymbol(
  store: RustModuleStore,
  info: RustFileInfo,
  symbol: string,
  visited: Set<string>,
): Readonly<{ kind: "found"; file: string; decl: RustDecl }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> {
  const direct = info.decls.find(decl => decl.typeName === null && decl.name === symbol);
  if (direct !== undefined) return Object.freeze({ kind: "found" as const, file: info.relPath, decl: direct });
  const reexport = findOwnUse(info, symbol);
  if (reexport !== undefined && reexport.targetSegments !== null) {
    const key = `${info.relPath}:${symbol}`;
    if (visited.has(key)) return Object.freeze({ kind: "missing" as const });
    visited.add(key);
    return resolvePathToSymbol(store, info, reexport.targetSegments, visited);
  }
  return Object.freeze({ kind: "missing" as const });
}

function resolvePathToSymbol(
  store: RustModuleStore,
  caller: RustFileInfo,
  segments: readonly string[],
  visited: Set<string>,
): Readonly<{ kind: "found"; file: string; decl: RustDecl }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> {
  if (segments.length < 2) return Object.freeze({ kind: "missing" as const });
  const symbol = segments.at(-1)!;
  let path: readonly string[] = segments.slice(0, -1);
  const context = moduleContextSegments(caller, path);
  if (context !== null) {
    path = Object.freeze([...context.context, ...context.rest]);
  } else {
    const head = path[0]!;
    const ownMod = caller.mods.find(mod => mod.name === head);
    if (ownMod !== undefined) {
      path = Object.freeze([...caller.modulePath, ...path]);
    } else {
      const use = findOwnUse(caller, head);
      if (use !== undefined && use.targetSegments !== null) {
        const base = use.targetSegments.slice(0, -1);
        path = Object.freeze([...base, ...path.slice(1)]);
      } else if (EXTERNAL_ROOTS.has(head)) {
        return Object.freeze({ kind: "missing" as const });
      } else {
        const target = resolveExternalCrateFile(store, caller, head, path.slice(1));
        if (target === null) return Object.freeze({ kind: "pending" as const });
        if (target.kind !== "found") return target;
        return resolveSymbol(store, target.info, symbol, visited);
      }
    }
  }
  const target = fileForModule(store, caller.srcDir, path);
  if (target.kind !== "found") return target;
  return resolveSymbol(store, target.info, symbol, visited);
}

function resolveExternalCrateFile(
  store: RustModuleStore,
  caller: RustFileInfo,
  crateName: string,
  moduleSegments: readonly string[],
): Readonly<{ kind: "found"; path: string; info: RustFileInfo }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> | null {
  const scopeBase = caller.srcDir.replace(/\/src$/, "");
  const parent = scopeBase.slice(0, Math.max(0, scopeBase.lastIndexOf("/")));
  const candidateDir = `${parent}/${crateName.replace(/_/g, "-")}/src`;
  if (candidateDir === caller.srcDir || candidateDir.startsWith("src")) return null;
  const target = fileForModule(store, candidateDir, moduleSegments);
  if (target.kind === "missing") {
    const root = fileForModule(store, `${parent}/${crateName.replace(/_/g, "-")}/src`, []);
    if (root.kind === "found") return root;
  }
  return target;
}

function findInherentMethod(
  store: RustModuleStore,
  caller: RustFileInfo,
  typeRef: TypeRef,
  methodName: string,
  visited: Set<string>,
): Readonly<{
  kind: "found"; file: string; decl: RustDecl; collision: boolean
}> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> | Readonly<{ kind: "dynamic" }> {
  if (typeRef.dynamic) return Object.freeze({ kind: "dynamic" as const });
  const candidates: RustFileInfo[] = [];
  const sameFileInherent = caller.decls.some(decl => decl.typeName === typeRef.typeName && decl.name === methodName);
  if (sameFileInherent) candidates.push(caller);
  if (!sameFileInherent) {
    const use = findOwnUse(caller, typeRef.typeName);
    if (use !== undefined && use.targetSegments !== null) {
      const key = `${caller.relPath}:type:${typeRef.typeName}`;
      if (!visited.has(key)) {
        visited.add(key);
        const target = resolvePathToType(store, caller, use.targetSegments, typeRef.typeName, visited);
        if (target.kind !== "found") return target;
        candidates.push(target.info);
      }
    }
    if (candidates.length === 0 && typeRef.moduleSegments !== null) {
      const context = moduleContextSegments(caller, typeRef.moduleSegments);
      const path = context === null ? typeRef.moduleSegments : [...context.context, ...context.rest];
      const target = fileForModule(store, caller.srcDir, path);
      if (target.kind === "pending" || target.kind === "ambiguous") return target;
      if (target.kind === "found") candidates.push(target.info);
    }
  }
  for (const candidate of candidates) {
    const decl = candidate.decls.find(item => item.typeName === typeRef.typeName && item.name === methodName);
    if (decl !== undefined) {
      const collision = candidate.traitMethods.some(item => item.typeName === typeRef.typeName && item.methodName === methodName);
      return Object.freeze({ kind: "found" as const, file: candidate.relPath, decl, collision });
    }
  }
  return Object.freeze({ kind: "missing" as const });
}

function resolvePathToType(
  store: RustModuleStore,
  caller: RustFileInfo,
  segments: readonly string[],
  typeName: string,
  visited: Set<string>,
): Readonly<{ kind: "found"; path: string; info: RustFileInfo }> | Readonly<{ kind: "pending" }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "ambiguous" }> {
  const moduleSegments = segments.length > 0 ? segments.slice(0, -1) : segments;
  const context = moduleContextSegments(caller, moduleSegments);
  let target: ReturnType<typeof fileForModule> | null = null;
  if (context !== null) {
    target = fileForModule(store, caller.srcDir, [...context.context, ...context.rest]);
  } else {
    const head = moduleSegments[0];
    const ownMod = head === undefined ? undefined : caller.mods.find(mod => mod.name === head);
    if (ownMod !== undefined) {
      target = fileForModule(store, caller.srcDir, [...caller.modulePath, ...moduleSegments]);
    } else if (head !== undefined && !EXTERNAL_ROOTS.has(head)) {
      target = resolveExternalCrateFile(store, caller, head, moduleSegments.slice(1));
    } else if (head === undefined) {
      target = fileForModule(store, caller.srcDir, []);
    }
  }
  if (target === null) return Object.freeze({ kind: "missing" as const });
  if (target.kind !== "found") return target;
  if (target.info.types.some(type => type.name === typeName) || target.info.decls.some(decl => decl.typeName === typeName)) {
    return target;
  }
  void visited;
  return Object.freeze({ kind: "missing" as const });
}

function unresolved(
  reasonCode: string,
  unresolvedKind: RustUnresolvedKind,
  targetSymbolClue: string | null,
  missingEvidence: readonly string[],
  coverageStatus: RustCoverageStatus,
  moduleSpecifierClue: string | null = null,
  candidateModulePath: string | null = null,
  bindingDeclarationSpan: DeclSpan | null = null,
): Resolution {
  return Object.freeze({
    kind: "unresolved" as const,
    reasonCode,
    unresolvedKind,
    targetSymbolClue,
    missingEvidence,
    coverageStatus,
    moduleSpecifierClue,
    candidateModulePath,
    bindingDeclarationSpan,
  });
}

function concreteReceiver(
  receiver: string,
  receiverNode: string | null,
  callerDecl: RustDecl,
  caller: RustFileInfo,
): Readonly<{ typeRef: TypeRef; shadow: boolean; closure: boolean; span: DeclSpan | null }> | null {
  if (receiver === "self") {
    const ref = callerDecl.typeName === null ? null : Object.freeze({
      typeName: callerDecl.typeName,
      moduleSegments: caller.modulePath,
      externalCrate: null,
      dynamic: false,
    });
    return ref === null ? null : Object.freeze({ typeRef: ref, shadow: false, closure: false, span: null });
  }
  const binding = localBindingFor(receiver, callerDecl, caller);
  if (binding === null) {
    return null;
  }
  if (binding.isClosure) return Object.freeze({
    typeRef: Object.freeze({ typeName: receiver, moduleSegments: null, externalCrate: null, dynamic: true }),
    shadow: true,
    closure: true,
    span: binding.span,
  });
  const typeRef = typeRefFromText(binding.typeText, caller, callerDecl);
  if (typeRef === null) return null;
  return Object.freeze({ typeRef, shadow: false, closure: false, span: binding.span });
}

function resolveRustCallsite(
  store: RustModuleStore,
  blockedOutside: ReadonlySet<string>,
  caller: RustFileInfo,
  callerDecl: RustDecl,
  callsite: RustCallsite,
): Resolution {
  if (callsite.shape === "macro") {
    return unresolved(
      "RUST_MACRO_INVOCATION_UNEXPANDED",
      "unsupported_syntax",
      callsite.name,
      Object.freeze(["macro_expansion_not_evaluated"]),
      "boundary_not_expanded",
    );
  }

  if (callsite.shape === "method") {
    const receiver = callsite.receiverExpr;
    const methodName = callsite.methodName;
    if (receiver === null || methodName === null) return Object.freeze({ kind: "skip" as const });
    if (receiver.includes("(") || receiver.includes(".") && receiver !== "self") {
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "truly_dynamic_unlocatable");
    }
    const concrete = concreteReceiver(receiver, null, callerDecl, caller);
    if (concrete === null) {
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "truly_dynamic_unlocatable", null, null, null);
    }
    if (concrete.shadow && concrete.closure) {
      return unresolved("LEXICAL_PARAM_OR_CLOSURE_CALL", "unresolved_dynamic", null,
        Object.freeze(["runtime_callback_or_higher_order_value"]), "truly_dynamic_unlocatable", null, null, concrete.span);
    }
    if (concrete.typeRef.dynamic) {
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", null, null, concrete.span);
    }
    const visited = new Set<string>();
    const method = findInherentMethod(store, caller, concrete.typeRef, methodName, visited);
    if (method.kind === "pending") return Object.freeze({ kind: "pending" as const });
    if (method.kind === "dynamic") return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
      Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", null, caller.relPath, concrete.span);
    if (method.kind === "missing") return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
      Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", null, caller.relPath, concrete.span);
    if (method.kind === "ambiguous") return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
      Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", null, caller.relPath, concrete.span);
    if (method.collision) return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", methodName,
      Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", null, method.file, concrete.span);
    return Object.freeze({ kind: "resolved" as const, originFile: method.file, decl: method.decl });
  }

  if (callsite.shape === "scoped") {
    const segments = callsite.segments;
    if (segments.length === 0) return Object.freeze({ kind: "skip" as const });
    const symbol = segments.at(-1)!;
    const head = segments[0]!;

    if (head === "Self") {
      if (callerDecl.typeName === null) return Object.freeze({ kind: "skip" as const });
      const typeRef = Object.freeze({ typeName: callerDecl.typeName, moduleSegments: caller.modulePath, externalCrate: null, dynamic: false });
      const method = findInherentMethod(store, caller, typeRef, symbol, new Set<string>());
      if (method.kind === "pending") return Object.freeze({ kind: "pending" as const });
      if (method.kind === "found" && !method.collision) return Object.freeze({ kind: "resolved" as const, originFile: method.file, decl: method.decl });
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", symbol,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified");
    }

    const context = moduleContextSegments(caller, segments);
    if (context !== null) {
      const path = Object.freeze([...context.context, ...context.rest]);
      const target = fileForModule(store, caller.srcDir, path.slice(0, -1));
      if (target.kind === "pending") return Object.freeze({ kind: "pending" as const });
      if (target.kind === "found") {
        const resolved = resolveSymbol(store, target.info, symbol, new Set<string>());
        if (resolved.kind === "pending") return Object.freeze({ kind: "pending" as const });
        if (resolved.kind === "found") return Object.freeze({ kind: "resolved" as const, originFile: resolved.file, decl: resolved.decl });
      }
      const moduleSegments = path.slice(0, -1);
      const candidateModulePath = blockedModuleCandidate(blockedOutside, caller.srcDir, moduleSegments);
      if (candidateModulePath !== null) {
        return unresolved("TARGET_OUTSIDE_DECLARED_SCOPE", "out_of_scope_internal", symbol,
          Object.freeze(["target_outside_declared_scope"]), "boundary_not_expanded",
          segments.slice(0, -1).join("::"), candidateModulePath);
      }
      return unresolved("TARGET_OUTSIDE_DECLARED_SCOPE", "unresolved_missing_or_ambiguous_target", symbol,
        Object.freeze(["module_or_symbol_not_found_in_scope"]), "locatable_candidate_unverified", path.join("::"));
    }

    const ownMod = caller.mods.find(mod => mod.name === head);
    if (ownMod !== undefined) {
      const target = fileForModule(store, caller.srcDir, [...caller.modulePath, head, ...segments.slice(1, -1)]);
      if (target.kind === "pending") return Object.freeze({ kind: "pending" as const });
      if (target.kind === "found") {
        const resolved = resolveSymbol(store, target.info, symbol, new Set<string>());
        if (resolved.kind === "pending") return Object.freeze({ kind: "pending" as const });
        if (resolved.kind === "found") return Object.freeze({ kind: "resolved" as const, originFile: resolved.file, decl: resolved.decl });
      }
      return unresolved("MODULE_SYMBOL_NOT_FOUND", "unresolved_missing_or_ambiguous_target", symbol,
        Object.freeze(["module_or_symbol_not_found_in_scope"]), "locatable_candidate_unverified", segments.join("::"));
    }

    const use = findOwnUse(caller, head);
    if (use !== undefined && use.targetSegments !== null) {
      if (use.targetSegments.length > 1) {
        const resolved = resolvePathToSymbol(store, caller, [...use.targetSegments.slice(0, -1), symbol], new Set<string>());
        if (resolved.kind === "pending") return Object.freeze({ kind: "pending" as const });
        if (resolved.kind === "found") return Object.freeze({ kind: "resolved" as const, originFile: resolved.file, decl: resolved.decl });
      }
      const typeRef = typeRefFromText(use.targetSegments.at(-1) ?? head, caller, callerDecl);
      if (typeRef !== null) {
        const method = findInherentMethod(store, caller, typeRef, symbol, new Set<string>());
        if (method.kind === "pending") return Object.freeze({ kind: "pending" as const });
        if (method.kind === "found" && !method.collision) return Object.freeze({ kind: "resolved" as const, originFile: method.file, decl: method.decl });
      }
    }

    const typeRef = Object.freeze({ typeName: head, moduleSegments: null, externalCrate: null, dynamic: false });
    const ownType = caller.types.find(type => type.name === head) !== undefined;
    if (ownType) {
      const method = findInherentMethod(store, caller, typeRef, symbol, new Set<string>());
      if (method.kind === "pending") return Object.freeze({ kind: "pending" as const });
      if (method.kind === "found") {
        if (method.collision) return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", symbol,
          Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified");
        return Object.freeze({ kind: "resolved" as const, originFile: method.file, decl: method.decl });
      }
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", symbol,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified");
    }

    if (EXTERNAL_ROOTS.has(head) || head === "serde_json") {
      return unresolved("EXTERNAL_CRATE_OR_STD_CALL", "out_of_scope_external", symbol,
        Object.freeze(["external_crate_or_out_of_scope_target"]), "boundary_not_expanded", segments.slice(0, -1).join("::"));
    }

    const external = resolveExternalCrateFile(store, caller, head, segments.slice(1, -1));
    if (external === null) {
      return unresolved("RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "unresolved_dynamic", symbol,
        Object.freeze(["receiver_type_or_trait_impl_unverified"]), "locatable_candidate_unverified", segments.join("::"));
    }
    if (external.kind === "pending") return Object.freeze({ kind: "pending" as const });
    if (external.kind === "found") {
      const resolved = resolveSymbol(store, external.info, symbol, new Set<string>());
      if (resolved.kind === "pending") return Object.freeze({ kind: "pending" as const });
      if (resolved.kind === "found") return Object.freeze({ kind: "resolved" as const, originFile: resolved.file, decl: resolved.decl });
    }
    return unresolved("EXTERNAL_CRATE_OR_STD_CALL", "out_of_scope_external", symbol,
      Object.freeze(["external_crate_or_out_of_scope_target"]), "boundary_not_expanded", segments.join("::"));
  }

  // ident call
  const name = callsite.name;
  const binding = localBindingFor(name, callerDecl, caller);
  if (binding !== null) {
    return unresolved("LEXICAL_PARAM_OR_CLOSURE_CALL", "unresolved_dynamic", null,
      Object.freeze(["runtime_callback_or_higher_order_value"]), "truly_dynamic_unlocatable", null, null, binding.span);
  }
  const use = findOwnUse(caller, name);
  if (use !== undefined && use.targetSegments !== null) {
    const resolved = resolvePathToSymbol(store, caller, use.targetSegments, new Set<string>());
    if (resolved.kind === "pending") return Object.freeze({ kind: "pending" as const });
    if (resolved.kind === "found") return Object.freeze({ kind: "resolved" as const, originFile: resolved.file, decl: resolved.decl });
    return unresolved("TARGET_OUTSIDE_DECLARED_SCOPE", "unresolved_missing_or_ambiguous_target", name,
      Object.freeze(["module_or_symbol_not_found_in_scope"]), "locatable_candidate_unverified", use.targetSegments.join("::"));
  }
  const sameModule = caller.decls.filter(decl => decl.typeName === null && decl.name === name);
  if (sameModule.length > 0) {
    const active = sameModule.filter(decl => !decl.isCfgGated);
    if (sameModule.length > 1 || active.length === 0) {
      return unresolved("RUST_CFG_CONDITIONAL_TARGET", "unresolved_dynamic", name,
        Object.freeze(["cfg_condition_unverified"]), "locatable_candidate_unverified", null, caller.relPath);
    }
    return Object.freeze({ kind: "resolved" as const, originFile: caller.relPath, decl: active[0]! });
  }
  const globs = findGlobUses(caller);
  if (globs.length > 0) {
    return unresolved("RUST_GLOB_USE_AMBIGUOUS_TARGET", "unresolved_missing_or_ambiguous_target", name,
      Object.freeze(["glob_use_resolution_unverified"]), "locatable_candidate_unverified",
      globs.map(item => item.globBase?.join("::") ?? "*").join(", "));
  }
  return unresolved("UNRESOLVED_IDENTIFIER_CALL", "unresolved_missing_or_ambiguous_target", name,
    Object.freeze(["callee_binding_not_found"]), "truly_dynamic_unlocatable");
}

function callerTraitMethod(caller: RustFileInfo, callerDecl: RustDecl, methodName: string): boolean {
  if (callerDecl.implKind === "trait" && callerDecl.traitName !== null) return true;
  return caller.traitMethodNames.includes(methodName);
}

function extractCallsites(caller: RustFileInfo, decl: RustDecl): readonly RustCallsite[] {
  if (decl.body === null) return Object.freeze([]);
  const callsites: RustCallsite[] = [];
  const source = caller.sourceText;
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "macro_invocation") {
      const nameNode = node.namedChild(0);
      const name = nameNode === null ? "macro" : nameNode.text;
      callsites.push(Object.freeze({
        shape: "macro" as const,
        calleeExpr: `${name}!`,
        span: spanOf(node),
        name,
        segments: Object.freeze([name]),
        methodName: null,
        receiverExpr: null,
      }));
    } else if (node.type === "call_expression") {
      const callee = calleeNodeOf(node);
      if (callee !== null) {
        if (callee.type === "identifier") {
          callsites.push(Object.freeze({
            shape: "ident" as const,
            calleeExpr: source.slice(callee.startIndex, callee.endIndex),
            span: spanOf(callee),
            name: callee.text,
            segments: Object.freeze([callee.text]),
            methodName: null,
            receiverExpr: null,
          }));
        } else if (callee.type === "scoped_identifier") {
          const segments = segmentsOf(callee);
          callsites.push(Object.freeze({
            shape: "scoped" as const,
            calleeExpr: source.slice(callee.startIndex, callee.endIndex),
            span: spanOf(callee),
            name: segments.at(-1) ?? callee.text,
            segments,
            methodName: null,
            receiverExpr: null,
          }));
        } else if (callee.type === "field_expression") {
          const receiverNode = callee.namedChild(0);
          const methodNode = callee.namedChild(1);
          if (receiverNode !== null && methodNode !== null) {
            callsites.push(Object.freeze({
              shape: "method" as const,
              calleeExpr: source.slice(callee.startIndex, methodNode.endIndex),
              span: spanOf(callee),
              name: methodNode.text,
              segments: Object.freeze([methodNode.text]),
              methodName: methodNode.text,
              receiverExpr: source.slice(receiverNode.startIndex, receiverNode.endIndex),
            }));
          }
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(decl.body);
  return Object.freeze(callsites);
}

function moduleCandidates(
  srcDir: string,
  moduleSegments: readonly string[],
): readonly string[] {
  if (moduleSegments.length === 0) return Object.freeze([`${srcDir}/lib.rs`, `${srcDir}/main.rs`]);
  const joined = moduleSegments.join("/");
  return Object.freeze([`${srcDir}/${joined}.rs`, `${srcDir}/${joined}/mod.rs`]);
}

function blockedModuleCandidate(
  blockedOutside: ReadonlySet<string>,
  srcDir: string,
  moduleSegments: readonly string[],
): string | null {
  return moduleCandidates(srcDir, moduleSegments).find(path => blockedOutside.has(path)) ?? null;
}

export function analyzeRustCalls(
  store: RustModuleStore,
  scopePaths: readonly string[],
  entryFile: string,
  entrySymbol: string,
  maxDepth: number,
): RustAnalysis {
  const pending = new Set<string>();
  const blockedOutside = new Set<string>();
  const inScope = (relPath: string): boolean => withinScope(normalizePath(relPath), scopePaths);
  const requestStore: RustModuleStore = Object.freeze({
    get: (relPath: string) => {
      if (!inScope(relPath)) {
        blockedOutside.add(normalizePath(relPath));
        return undefined;
      }
      return store.get(relPath);
    },
    has: (relPath: string) => {
      if (!inScope(relPath)) {
        blockedOutside.add(normalizePath(relPath));
        return false;
      }
      return store.has(relPath);
    },
    isMissing: (relPath: string) => {
      if (!inScope(relPath)) {
        blockedOutside.add(normalizePath(relPath));
        return true;
      }
      return store.isMissing(relPath);
    },
    request: (relPath: string) => {
      if (!inScope(relPath)) {
        blockedOutside.add(normalizePath(relPath));
        return;
      }
      pending.add(relPath);
      store.request(relPath);
    },
  });
  const pendingReads = () => Object.freeze([...pending].filter(relPath => !requestStore.has(relPath)));

  const entryInfo = requestStore.get(entryFile);
  if (entryInfo === undefined) {
    const missing = requestStore.isMissing(entryFile);
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedCallsites: Object.freeze([]),
      pendingReads: missing ? Object.freeze([]) : Object.freeze([entryFile]),
      entryResolved: false,
      entryResolution: missing ? "entry_not_found" as const : "ok" as const,
      entryNodeId: null,
      termination: missing
        ? Object.freeze({ status: "unmet" as const, resolution: "entry_not_found" as const })
        : null,
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
    });
  }

  const entry = resolveRustEntry(entryInfo, entrySymbol);
  if (entry.status !== "found") {
    const resolution = entry.status === "ambiguous" ? "ambiguous_entry_symbol" as const : "entry_not_found" as const;
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      unresolvedCallsites: Object.freeze([]),
      pendingReads: pendingReads(),
      entryResolved: false,
      entryResolution: resolution,
      entryNodeId: null,
      termination: Object.freeze({ status: "unmet" as const, resolution }),
      bodyExtractedCount: 0,
      closedCallsiteCount: 0,
    });
  }

  const entryNodeId = nodeIdOf(entry.decl, entryFile);
  const nodesById = new Map<string, Readonly<{ file: string; decl: RustDecl }>>();
  nodesById.set(entryNodeId, Object.freeze({ file: entryFile, decl: entry.decl }));
  const edgeDrafts = new Map<string, Readonly<{
    callerId: string;
    calleeId: string;
    sameFile: boolean;
    callsiteSpan: DeclSpan;
    evidenceSnippet: string;
  }>>();
  const unresolvedDrafts = new Map<string, RustUnresolvedCallsite>();
  const extracted = new Set<string>();

  const depths = (): Map<string, number> => {
    const depth = new Map<string, number>();
    depth.set(entryNodeId, 0);
    const adjacency = new Map<string, string[]>();
    for (const draft of edgeDrafts.values()) {
      const list = adjacency.get(draft.callerId) ?? [];
      list.push(draft.calleeId);
      adjacency.set(draft.callerId, list);
    }
    const queue = [entryNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = depth.get(current) ?? 0;
      for (const next of adjacency.get(current) ?? []) {
        const candidate = currentDepth + 1;
        const existing = depth.get(next);
        if (existing === undefined || candidate < existing) {
          depth.set(next, candidate);
          queue.push(next);
        }
      }
    }
    return depth;
  };

  for (;;) {
    const currentDepths = depths();
    let extractedAny = false;
    for (const [nodeId, record] of nodesById) {
      const depth = currentDepths.get(nodeId);
      if (depth === undefined || depth >= maxDepth || extracted.has(nodeId)) continue;
      extracted.add(nodeId);
      extractedAny = true;
      const callsites = extractCallsites(record.file === entryFile ? entryInfo : requestStore.get(record.file) ?? entryInfo, record.decl);
      const callerInfo = requestStore.get(record.file);
      if (callerInfo === undefined) continue;
      for (const callsite of callsites) {
        const resolution = resolveRustCallsite(requestStore, blockedOutside, callerInfo, record.decl, callsite);
        if (resolution.kind === "pending" || resolution.kind === "skip") continue;
        if (resolution.kind === "resolved") {
          const calleeId = nodeIdOf(resolution.decl, resolution.originFile);
          if (!nodesById.has(calleeId)) {
            nodesById.set(calleeId, Object.freeze({ file: resolution.originFile, decl: resolution.decl }));
          }
          const key = `${nodeId}\u0000${calleeId}\u0000${callsite.span.startLine}:${callsite.span.startColumn}`;
          if (!edgeDrafts.has(key)) {
            edgeDrafts.set(key, Object.freeze({
              callerId: nodeId,
              calleeId,
              sameFile: resolution.originFile === record.file,
              callsiteSpan: callsite.span,
              evidenceSnippet: callsite.calleeExpr,
            }));
          }
          continue;
        }
        const unresolvedKey = `${nodeId}\u0000${callsite.span.startLine}:${callsite.span.startColumn}\u0000${resolution.reasonCode}`;
        if (!unresolvedDrafts.has(unresolvedKey)) {
          unresolvedDrafts.set(unresolvedKey, Object.freeze({
            callerId: nodeId,
            calleeExpr: callsite.calleeExpr,
            callsiteSpan: callsite.span,
            kind: resolution.unresolvedKind,
            reasonCode: resolution.reasonCode,
            targetSymbolClue: resolution.targetSymbolClue,
            missingEvidence: resolution.missingEvidence,
            coverageStatus: resolution.coverageStatus,
            moduleSpecifierClue: resolution.moduleSpecifierClue,
            candidateModulePath: resolution.candidateModulePath,
            bindingDeclarationSpan: resolution.bindingDeclarationSpan,
          }));
        }
      }
    }
    const afterDepths = depths();
    const reopened = [...nodesById.keys()].some(nodeId => {
      const depth = afterDepths.get(nodeId);
      return depth !== undefined && depth < maxDepth && !extracted.has(nodeId);
    });
    if (!extractedAny && !reopened) break;
    if (!extractedAny && reopened) continue;
  }

  const finalDepths = depths();
  const adjacency = new Map<string, string[]>();
  for (const draft of edgeDrafts.values()) {
    const list = adjacency.get(draft.callerId) ?? [];
    list.push(draft.calleeId);
    adjacency.set(draft.callerId, list);
  }
  const inDegree = new Map<string, number>();
  for (const draft of edgeDrafts.values()) {
    inDegree.set(draft.calleeId, (inDegree.get(draft.calleeId) ?? 0) + 1);
  }
  const reachable = (from: string, to: string): boolean => {
    if (from === to) return true;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const next of adjacency.get(current) ?? []) {
        if (next === to) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return false;
  };

  const edges: CallGraphResolvedEdgeFact[] = [...edgeDrafts.values()]
    .filter(draft => finalDepths.has(draft.callerId) && finalDepths.has(draft.calleeId))
    .map(draft => Object.freeze({
      callerId: draft.callerId,
      calleeId: draft.calleeId,
      edgeKind: "resolved_in_repo" as const,
      resolutionKind: draft.sameFile ? "same_file" as const : "cross_file_direct" as const,
      isCycleEdge: reachable(draft.calleeId, draft.callerId),
      calleeInDegree: inDegree.get(draft.calleeId) ?? 0,
      callsiteSpan: draft.callsiteSpan,
      evidenceSnippet: draft.evidenceSnippet,
    }));

  const nodes: CallGraphNodeFact[] = [...nodesById.entries()]
    .filter(([nodeId]) => finalDepths.has(nodeId))
    .map(([nodeId, record]) => Object.freeze({
      nodeId,
      filePath: record.file,
      symbolName: record.decl.name,
      lexicalScopeChain: record.decl.chain,
      minDepth: finalDepths.get(nodeId) ?? 0,
      bodyExtracted: extracted.has(nodeId),
      declSpan: record.decl.span,
      nameSpan: record.decl.nameSpan,
      fileObjectRef: null,
    }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));

  const unresolvedCallsites = [...unresolvedDrafts.values()].filter(draft => finalDepths.has(draft.callerId));

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    unresolvedCallsites: Object.freeze(unresolvedCallsites),
    pendingReads: pendingReads(),
    entryResolved: true,
    entryResolution: "ok" as const,
    entryNodeId,
    termination: null,
    bodyExtractedCount: nodes.filter(node => node.bodyExtracted).length,
    closedCallsiteCount: edges.length + unresolvedCallsites.length,
  });
}
