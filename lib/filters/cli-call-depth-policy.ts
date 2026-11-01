// Slice CD-1 pure TypeScript AST policy. This module performs no I/O: every
// source text is supplied by the caller through the injected ModuleStore. It
// implements the two-stage resolve-before-call rules from the r4 design (§1.3)
// and the fixed point work queue rules W1/W2/W3 as pure in-memory decisions.
import * as ts from "typescript";
import type { DeclSpan } from "../adapters/cli/call-depth-contract.js";

// The policy always parses with the TypeScript compiler API and ScriptKind.TS.
// Report this real backend instead of the requested language route.
export const CALL_DEPTH_ACTUAL_PARSER = "typescript" as const;

export type DeclKind =
  | "function"
  | "arrow"
  | "class"
  | "value"
  | "ambient"
  | "default-arrow"
  | "default-function";

export type DeclInfo = Readonly<{
  chain: string;
  name: string;
  span: DeclSpan;
  kind: DeclKind;
  file: string;
  node: ts.Node;
  body?: ts.ConciseBody;
  params?: readonly ts.ParameterDeclaration[];
}>;

export type SourceFileInfo = Readonly<{
  relPath: string;
  sourceFile: ts.SourceFile;
  text: string;
}>;

export type ModuleStore = Readonly<{
  get(relPath: string): SourceFileInfo | undefined;
  has(relPath: string): boolean;
  isMissing(relPath: string): boolean;
  request(relPath: string): void;
}>;

export const GLOBAL_WHITELIST = new Set([
  "Math", "JSON", "console", "Object", "Array", "Number", "String", "Boolean",
  "Promise", "Symbol", "RegExp", "Date", "Error", "TypeError", "Map", "Set",
  "WeakMap", "WeakSet", "Reflect", "Proxy", "Intl", "parseInt", "parseFloat",
  "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "BigInt", "Buffer",
  "process", "URL",
]);

export function parseSourceFile(relPath: string, sourceText: string): SourceFileInfo {
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return Object.freeze({ relPath, sourceFile, text: sourceText });
}

export function lineColOf(sourceFile: ts.SourceFile, offset: number): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: pos.line + 1, column: pos.character + 1 };
}

export function declSpanOf(sourceFile: ts.SourceFile, node: ts.Node): DeclSpan {
  const start = lineColOf(sourceFile, node.getStart(sourceFile));
  const end = lineColOf(sourceFile, node.getEnd());
  return Object.freeze({
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

export function spanKey(span: DeclSpan): string {
  return `${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`;
}

export function nodeIdFor(filePath: string, lexicalScopeChain: string, span: DeclSpan): string {
  return `${filePath}#${lexicalScopeChain}@${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`;
}

export function withinScope(relPath: string, scopePaths: readonly string[]): boolean {
  return scopePaths.some(scope => relPath === scope || relPath.startsWith(`${scope}/`));
}

function unwrapParens(node: ts.Expression): ts.Expression {
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

function forEachBindingIdentifier(
  name: ts.BindingName,
  visit: (identifier: ts.Identifier) => void,
): void {
  if (ts.isIdentifier(name)) {
    visit(name);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      forEachBindingIdentifier(element.name, visit);
    }
  }
}

function rootIdentifierOf(expression: ts.Expression): ts.Identifier | null {
  const core = unwrapParens(expression);
  if (ts.isIdentifier(core)) return core;
  if (ts.isPropertyAccessExpression(core)) return rootIdentifierOf(core.expression);
  return null;
}

function callableExpression(node: ts.Expression): boolean {
  const core = unwrapParens(node);
  return ts.isArrowFunction(core) || ts.isFunctionExpression(core);
}

function isCallableKind(kind: DeclKind): boolean {
  return kind === "function"
    || kind === "arrow"
    || kind === "default-arrow"
    || kind === "default-function";
}

function chainOf(name: string, parentChain: string): string {
  return parentChain === "" ? name : `${parentChain}.${name}`;
}

function variableSpan(sourceFile: ts.SourceFile, declaration: ts.VariableDeclaration): ts.Node {
  const list = declaration.parent;
  const statement = list === undefined ? undefined : list.parent;
  return statement !== undefined && ts.isVariableStatement(statement)
    && ts.isSourceFile(statement.parent)
    ? statement
    : declaration;
}

function bodyAndParams(node: ts.Node): { body?: ts.ConciseBody; params?: readonly ts.ParameterDeclaration[] } {
  if (ts.isArrowFunction(node)) {
    return { body: node.body, params: Object.freeze([...node.parameters]) };
  }
  if (ts.isFunctionExpression(node)) {
    return { body: node.body, params: Object.freeze([...node.parameters]) };
  }
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return { body: node.body, params: Object.freeze([...node.parameters]) };
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    const core = unwrapParens(node.initializer);
    if (ts.isArrowFunction(core)) {
      return { body: core.body, params: Object.freeze([...core.parameters]) };
    }
    if (ts.isFunctionExpression(core)) {
      return { body: core.body, params: Object.freeze([...core.parameters]) };
    }
  }
  if (ts.isExportAssignment(node)) {
    const core = unwrapParens(node.expression);
    if (ts.isArrowFunction(core)) {
      return { body: core.body, params: Object.freeze([...core.parameters]) };
    }
    if (ts.isFunctionExpression(core)) {
      return { body: core.body, params: Object.freeze([...core.parameters]) };
    }
  }
  return {};
}

function makeDecl(
  sourceFile: ts.SourceFile,
  file: string,
  name: string,
  chain: string,
  kind: DeclKind,
  node: ts.Node,
  bodyNode: ts.Node = node,
): DeclInfo {
  const shape = bodyAndParams(bodyNode);
  const base = {
    chain,
    name,
    span: declSpanOf(sourceFile, node),
    kind,
    file,
    node,
  };
  return Object.freeze(
    shape.body === undefined
      ? base
      : { ...base, body: shape.body, params: shape.params ?? Object.freeze([]) },
  );
}

function isImplementation(decl: DeclInfo): boolean {
  return decl.body !== undefined;
}

function isDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function isExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export type ValueExport = Readonly<{
  name: string;
  chain: string;
  originFile: string;
  span: DeclSpan;
  kind: DeclKind;
  node: ts.Node;
  ambient: boolean;
}>;

export type Reexport = Readonly<{ specifier: string | null; original: string; isTypeOnly: boolean }>;

export type FileDeclarations = Readonly<{
  all: readonly DeclInfo[];
  byChain: ReadonlyMap<string, DeclInfo>;
  valueExports: ReadonlyMap<string, ValueExport>;
  namedReexports: ReadonlyMap<string, Reexport>;
  starReexports: readonly string[];
  typeOnlyExports: ReadonlySet<string>;
}>;

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function moduleSpecifierText(sourceFile: ts.SourceFile, node: ts.Expression): string {
  return stripQuotes(node.getText(sourceFile));
}

export function declarationsOf(info: SourceFileInfo): FileDeclarations {
  const all: DeclInfo[] = [];
  const byChain = new Map<string, DeclInfo>();
  const valueExports = new Map<string, ValueExport>();
  const namedReexports = new Map<string, Reexport>();
  const typeOnlyExports = new Set<string>();
  const starReexports: string[] = [];

  function remember(decl: DeclInfo): void {
    all.push(decl);
    const existing = byChain.get(decl.chain);
    if (existing === undefined || (!isImplementation(existing) && isImplementation(decl))) {
      byChain.set(decl.chain, decl);
    }
  }

  function rememberExport(name: string, decl: DeclInfo): void {
    valueExports.set(name, Object.freeze({
      name,
      chain: decl.chain,
      originFile: decl.file,
      span: decl.span,
      kind: decl.kind,
      node: decl.node,
      ambient: decl.body === undefined,
    }));
  }

  function walk(node: ts.Node, prefix: string): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const chain = chainOf(node.name.text, prefix);
      const decl = makeDecl(
        info.sourceFile,
        info.relPath,
        node.name.text,
        chain,
        node.body === undefined ? "ambient" : "function",
        node,
      );
      remember(decl);
      if (node.body !== undefined) {
        for (const stmt of node.body.statements) walk(stmt, chain);
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name === undefined && node.body !== undefined && isDefaultModifier(node)) {
      const decl = makeDecl(
        info.sourceFile,
        info.relPath,
        "default",
        "default",
        "default-function",
        node,
      );
      remember(decl);
      rememberExport("default", decl);
      for (const stmt of node.body.statements) walk(stmt, "default");
      return;
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const core = unwrapParens(node.initializer);
      if (ts.isArrowFunction(core) || ts.isFunctionExpression(core)) {
        const chain = chainOf(node.name.text, prefix);
        const kind = ts.isArrowFunction(core) ? "arrow" : "function";
        remember(makeDecl(
          info.sourceFile,
          info.relPath,
          node.name.text,
          chain,
          kind,
          variableSpan(info.sourceFile, node),
          node,
        ));
      }
      return;
    }
    if (ts.isExportAssignment(node)) {
      const core = unwrapParens(node.expression);
      if (ts.isArrowFunction(core) || ts.isFunctionExpression(core)) {
        const kind = ts.isArrowFunction(core) ? "default-arrow" : "default-function";
        const decl = makeDecl(info.sourceFile, info.relPath, "default", "default", kind, core);
        remember(decl);
        rememberExport("default", decl);
      }
      return;
    }
    if (ts.isBlock(node)) return;
    ts.forEachChild(node, child => walk(child, prefix));
  }

  for (const stmt of info.sourceFile.statements) walk(stmt, "");

  // Top-level value export surface (explicit local exports shadow export *).
  for (const stmt of info.sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && isExportModifier(stmt)) {
      typeOnlyExports.add(stmt.name.text);
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt) && isExportModifier(stmt)) {
      typeOnlyExports.add(stmt.name.text);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && isExportModifier(stmt)) {
      const decl = byChain.get(stmt.name.text) ?? all.find(item => item.chain === stmt.name?.text);
      if (decl !== undefined) {
        rememberExport(isDefaultModifier(stmt) ? "default" : stmt.name.text, decl);
        if (isDefaultModifier(stmt)) rememberExport(stmt.name.text, decl);
      }
      continue;
    }
    if (ts.isVariableStatement(stmt) && isExportModifier(stmt)) {
      for (const declaration of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const local = byChain.get(declaration.name.text);
        if (local === undefined) {
          const decl = makeDecl(
            info.sourceFile,
            info.relPath,
            declaration.name.text,
            declaration.name.text,
            "value",
            variableSpan(info.sourceFile, declaration),
            declaration,
          );
          remember(decl);
          rememberExport(declaration.name.text, decl);
        } else {
          rememberExport(declaration.name.text, local);
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name !== undefined && isExportModifier(stmt)) {
      const decl = makeDecl(
        info.sourceFile,
        info.relPath,
        stmt.name.text,
        stmt.name.text,
        "class",
        stmt,
      );
      remember(decl);
      rememberExport(isDefaultModifier(stmt) ? "default" : stmt.name.text, decl);
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier === undefined) {
        if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
          for (const element of stmt.exportClause.elements) {
            if (stmt.isTypeOnly || element.isTypeOnly) {
              typeOnlyExports.add(element.name.text);
              continue;
            }
            const original = element.propertyName === undefined ? element.name.text : element.propertyName.text;
            const local = byChain.get(original);
            if (local !== undefined) rememberExport(element.name.text, local);
          }
        }
        continue;
      }
      const specifier = moduleSpecifierText(info.sourceFile, stmt.moduleSpecifier);
      if (stmt.exportClause === undefined) {
        starReexports.push(specifier);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          const exported = element.name.text;
          const original = element.propertyName === undefined ? element.name.text : element.propertyName.text;
          namedReexports.set(exported, Object.freeze({
            specifier,
            original,
            isTypeOnly: stmt.isTypeOnly || element.isTypeOnly,
          }));
        }
      }
    }
  }

  return Object.freeze({
    all: Object.freeze(all),
    byChain,
    valueExports,
    namedReexports,
    starReexports: Object.freeze(starReexports),
    typeOnlyExports,
  });
}

export function resolveEntry(
  info: SourceFileInfo,
  symbol: string,
  lexicalPath: string | undefined,
): { status: "ok"; decl: DeclInfo } | { status: "not_found" } | { status: "ambiguous" } {
  const decls = declarationsOf(info);
  let matches: DeclInfo[];
  if (lexicalPath !== undefined && lexicalPath !== "") {
    matches = decls.all.filter(decl => decl.chain === lexicalPath && decl.name === symbol);
    if (matches.length === 0) {
      matches = decls.all.filter(decl => decl.chain === lexicalPath);
    }
  } else if (symbol === "default") {
    matches = decls.all.filter(decl => decl.name === "default" || decl.chain === "default");
  } else {
    matches = decls.all.filter(decl => decl.name === symbol && !decl.chain.includes("."));
    if (matches.length === 0) {
      matches = decls.all.filter(decl => decl.name === symbol);
    }
  }
  const unique = new Map<string, DeclInfo>();
  for (const decl of matches) {
    const key = `${decl.file}#${spanKey(decl.span)}`;
    const existing = unique.get(key);
    if (existing === undefined || (!isImplementation(existing) && isImplementation(decl))) {
      unique.set(key, decl);
    }
  }
  if (unique.size === 0) return { status: "not_found" };
  if (unique.size > 1) return { status: "ambiguous" };
  const only = [...unique.values()][0]!;
  if (!isCallableKind(only.kind)) return { status: "not_found" };
  return { status: "ok", decl: only };
}

type LexicalBinding =
  | Readonly<{ kind: "callable"; decl: DeclInfo }>
  | Readonly<{ kind: "noncallable"; reason: string }>
  | Readonly<{ kind: "none" }>;

export type RawCallsite = Readonly<{
  rootId: string | null;
  calleeExpr: string;
  span: DeclSpan;
  lexical: LexicalBinding;
  callerChain: string;
}>;

function paramScope(params: readonly ts.ParameterDeclaration[]): Map<string, LexicalBinding> {
  const scope = new Map<string, LexicalBinding>();
  for (const param of params) {
    forEachBindingIdentifier(param.name, identifier => {
      scope.set(identifier.text, Object.freeze({ kind: "noncallable" as const, reason: "LEXICAL_PARAM_OR_VARIABLE_CALL" }));
    });
  }
  return scope;
}

function blockScope(
  info: SourceFileInfo,
  statements: readonly ts.Statement[],
  callerChain: string,
  parent: Map<string, LexicalBinding>,
): Map<string, LexicalBinding> {
  const scope = new Map(parent);
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      const chain = chainOf(stmt.name.text, callerChain);
      const decl = makeDecl(
        info.sourceFile,
        info.relPath,
        stmt.name.text,
        chain,
        stmt.body === undefined ? "ambient" : "function",
        stmt,
      );
      scope.set(stmt.name.text, Object.freeze({ kind: "callable" as const, decl }));
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const declaration of stmt.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          if (declaration.initializer !== undefined && callableExpression(declaration.initializer)) {
            const core = unwrapParens(declaration.initializer);
            const chain = chainOf(declaration.name.text, callerChain);
            const kind = ts.isArrowFunction(core) ? "arrow" : "function";
            const decl = makeDecl(
              info.sourceFile,
              info.relPath,
              declaration.name.text,
              chain,
              kind,
              variableSpan(info.sourceFile, declaration),
              declaration,
            );
            scope.set(declaration.name.text, Object.freeze({ kind: "callable" as const, decl }));
          } else {
            scope.set(declaration.name.text, Object.freeze({ kind: "noncallable" as const, reason: "LEXICAL_PARAM_OR_VARIABLE_CALL" }));
          }
        } else {
          forEachBindingIdentifier(declaration.name, identifier => {
            scope.set(identifier.text, Object.freeze({ kind: "noncallable" as const, reason: "LEXICAL_PARAM_OR_VARIABLE_CALL" }));
          });
        }
      }
      continue;
    }
  }
  return scope;
}

function enclosingShadowBindings(
  info: SourceFileInfo,
  bodyNode: ts.Node,
): Map<string, LexicalBinding> {
  const bindings = new Map<string, LexicalBinding>();
  const declarations = declarationsOf(info).all;
  const declarationByNode = new Map(declarations.map(decl => [decl.node, decl] as const));
  const remember = (name: string, binding: LexicalBinding): void => {
    if (!bindings.has(name)) bindings.set(name, binding);
  };
  const addParam = (param: ts.ParameterDeclaration): void => {
    forEachBindingIdentifier(param.name, identifier => {
      remember(identifier.text, Object.freeze({
        kind: "noncallable" as const,
        reason: "LEXICAL_PARAM_OR_VARIABLE_CALL",
      }));
    });
  };
  const addFunction = (stmt: ts.FunctionDeclaration): void => {
    if (stmt.name === undefined) return;
    const decl = declarationByNode.get(stmt);
    if (decl !== undefined) {
      remember(stmt.name.text, Object.freeze({ kind: "callable" as const, decl }));
    }
  };
  const addVariable = (declaration: ts.VariableDeclaration): void => {
    if (ts.isIdentifier(declaration.name)) {
      const callable = declaration.initializer !== undefined && callableExpression(declaration.initializer);
      if (callable) {
        const decl = declarationByNode.get(declaration)
          ?? declarationByNode.get(variableSpan(info.sourceFile, declaration));
        if (decl !== undefined) {
          remember(declaration.name.text, Object.freeze({ kind: "callable" as const, decl }));
          return;
        }
      }
      remember(declaration.name.text, Object.freeze({
        kind: "noncallable" as const,
        reason: "LEXICAL_PARAM_OR_VARIABLE_CALL",
      }));
      return;
    }
    forEachBindingIdentifier(declaration.name, identifier => {
      remember(identifier.text, Object.freeze({
        kind: "noncallable" as const,
        reason: "LEXICAL_PARAM_OR_VARIABLE_CALL",
      }));
    });
  };
  let node: ts.Node | undefined = bodyNode.parent;
  while (node !== undefined) {
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node)
    ) {
      for (const param of node.parameters) addParam(param);
    } else if (ts.isBlock(node) || ts.isSourceFile(node)) {
      for (const stmt of node.statements) {
        if (ts.isFunctionDeclaration(stmt)) {
          addFunction(stmt);
        } else if (ts.isVariableStatement(stmt)) {
          for (const declaration of stmt.declarationList.declarations) addVariable(declaration);
        }
      }
    }
    if (ts.isSourceFile(node)) break;
    node = node.parent;
  }
  return bindings;
}

export function extractCallsites(
  info: SourceFileInfo,
  body: ts.ConciseBody | ts.Block,
  params: readonly ts.ParameterDeclaration[],
  callerChain: string,
): RawCallsite[] {
  const rootScope = paramScope(params);
  for (const [name, binding] of enclosingShadowBindings(info, body)) {
    if (!rootScope.has(name)) rootScope.set(name, binding);
  }
  const out: RawCallsite[] = [];

  function visit(node: ts.Node, activeScope: Map<string, LexicalBinding>): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const unwrapped = unwrapParens(callee);
      const span = declSpanOf(info.sourceFile, callee);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        // IIFE inlined at the same depth: push params into the active scope.
        const local = new Map(activeScope);
        for (const param of unwrapped.parameters) {
          if (ts.isIdentifier(param.name)) {
            local.set(param.name.text, Object.freeze({ kind: "noncallable" as const, reason: "LEXICAL_PARAM_OR_VARIABLE_CALL" }));
          }
        }
        const fnBody = ts.isArrowFunction(unwrapped) ? unwrapped.body : unwrapped.body;
        visit(fnBody, local);
        return;
      }
      const root = rootIdentifierOf(callee);
      if (root === null) {
        out.push(Object.freeze({
          rootId: null,
          calleeExpr: info.text.slice(callee.getStart(info.sourceFile), callee.getEnd()),
          span,
          lexical: Object.freeze({ kind: "none" as const }),
          callerChain,
        }));
      } else {
        const binding = activeScope.get(root.text);
        out.push(Object.freeze({
          rootId: root.text,
          calleeExpr: info.text.slice(callee.getStart(info.sourceFile), callee.getEnd()),
          span,
          lexical: binding === undefined
            ? Object.freeze({ kind: "none" as const })
            : binding,
          callerChain,
        }));
      }
      visit(callee, activeScope);
      for (const argument of node.arguments) {
        const argumentCore = unwrapParens(argument);
        if (ts.isArrowFunction(argumentCore) || ts.isFunctionExpression(argumentCore)) continue;
        visit(argument, activeScope);
      }
      return;
    }
    if (ts.isBlock(node)) {
      // Each lexical block gets its own scope; block declarations never leak
      // into the enclosing function scope.
      const child = blockScope(info, node.statements, callerChain, activeScope);
      for (const stmt of node.statements) visit(stmt, child);
      return;
    }
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isMethodDeclaration(node)
      || ts.isFunctionDeclaration(node)
    ) {
      // Non-invoked nested callable bodies are isolated.
      return;
    }
    ts.forEachChild(node, child => visit(child, activeScope));
  }

  if (ts.isBlock(body)) {
    const scope = blockScope(info, body.statements, callerChain, rootScope);
    for (const stmt of body.statements) visit(stmt, scope);
  } else {
    visit(body, rootScope);
  }
  return out;
}

type ImportedBinding = Readonly<{
  local: string;
  moduleSpecifier: string;
  exportName: string;
  typeOnly?: boolean;
}>;

function collectImports(info: SourceFileInfo): ImportedBinding[] {
  const out: ImportedBinding[] = [];
  for (const stmt of info.sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined || stmt.moduleSpecifier === undefined) continue;
    const spec = moduleSpecifierText(info.sourceFile, stmt.moduleSpecifier);
    const clause = stmt.importClause;
    if (clause.name !== undefined && ts.isIdentifier(clause.name)) {
      out.push(Object.freeze({
        local: clause.name.text,
        moduleSpecifier: spec,
        exportName: "default",
        typeOnly: clause.isTypeOnly,
      }));
    }
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName === undefined ? element.name.text : element.propertyName.text;
        const local = element.name.text;
        const typeOnly = element.isTypeOnly || clause.isTypeOnly;
        if (!typeOnly) {
          out.push(Object.freeze({ local, moduleSpecifier: spec, exportName: imported }));
        }
      }
    }
    if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      if (clause.isTypeOnly) continue;
      out.push(Object.freeze({
        local: clause.namedBindings.name.text,
        moduleSpecifier: spec,
        exportName: "*",
      }));
    }
  }
  return out;
}

export type ModuleFileResolution =
  | { kind: "loaded"; path: string }
  | { kind: "missing" }
  | { kind: "pending"; path: string }
  | { kind: "out_of_scope" };

function joinRelative(dir: string, spec: string): string {
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of spec.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function extensionCandidates(relPath: string): string[] {
  if (relPath.endsWith(".mjs")) {
    const base = relPath.slice(0, -4);
    return [base + ".mts", relPath];
  }
  if (relPath.endsWith(".js")) {
    const base = relPath.slice(0, -3);
    return [base + ".ts", relPath];
  }
  if (relPath.endsWith(".cjs")) return [relPath];
  return [relPath + ".ts", relPath + ".js", relPath + "/index.ts", relPath + "/index.js"];
}

export function resolveModuleFile(
  fromRelPath: string,
  specifier: string,
  store: ModuleStore,
  scopePaths: readonly string[],
): ModuleFileResolution {
  const normalized = specifier.replace(/\\/g, "/");
  if (!normalized.startsWith(".")) return { kind: "out_of_scope" };
  const directory = fromRelPath.includes("/") ? fromRelPath.slice(0, fromRelPath.lastIndexOf("/")) : "";
  const joint = joinRelative(directory, normalized);
  if (!withinScope(joint, scopePaths)) return { kind: "out_of_scope" };
  for (const candidate of extensionCandidates(joint)) {
    if (store.has(candidate)) return { kind: "loaded", path: candidate };
  }
  for (const candidate of extensionCandidates(joint)) {
    if (store.isMissing(candidate)) continue;
    store.request(candidate);
    return { kind: "pending", path: candidate };
  }
  return { kind: "missing" };
}

export type ModuleResolveResult =
  | { kind: "bound"; decl: DeclInfo; originFile: string }
  | { kind: "notfound"; reason: string }
  | { kind: "type_only"; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "pending"; path: string };

function valueExportToDecl(exportValue: ValueExport): DeclInfo {
  const base = {
    chain: exportValue.chain,
    name: exportValue.name,
    span: exportValue.span,
    kind: exportValue.kind,
    file: exportValue.originFile,
    node: exportValue.node,
  };
  const shape = bodyAndParams(exportValue.node);
  return Object.freeze(
    shape.body === undefined
      ? base
      : { ...base, body: shape.body, params: shape.params ?? Object.freeze([]) },
  );
}

export function resolveModuleExport(
  store: ModuleStore,
  moduleRelPath: string,
  exportName: string,
  scopePaths: readonly string[],
  pathStack: readonly string[],
  barrelDepth = 0,
): ModuleResolveResult {
  const info = store.get(moduleRelPath);
  if (info === undefined) {
    return { kind: "notfound", reason: "MODULE_FILE_NOT_FOUND" };
  }
  const key = `${moduleRelPath}#${exportName}`;
  if (pathStack.includes(key)) return { kind: "unresolved", reason: "BARREL_CYCLE" };
  const stack = Object.freeze([...pathStack, key]);
  const decls = declarationsOf(info);
  const explicit = decls.valueExports.get(exportName);
  if (explicit !== undefined) {
    // `valueExports` records the declaration span; the byChain entry carries the
    // real initializer body/params for arrow and function-expression exports.
    const full = decls.byChain.get(explicit.chain);
    return { kind: "bound", decl: full ?? valueExportToDecl(explicit), originFile: explicit.originFile };
  }
  if (exportName === "default") {
    return { kind: "notfound", reason: "EXPORT_DEFAULT_NOT_FOUND" };
  }
  const namedReexport = decls.namedReexports.get(exportName);
  if (namedReexport !== undefined) {
    if (namedReexport.isTypeOnly) {
      return { kind: "type_only", reason: "TYPE_ONLY_IMPORT_OR_DECLARATION" };
    }
    if (namedReexport.specifier === null) {
      const local = decls.byChain.get(namedReexport.original);
      if (local === undefined) return { kind: "notfound", reason: "EXPORT_NAME_NOT_FOUND" };
      return { kind: "bound", decl: local, originFile: local.file };
    }
    const resolved = resolveModuleFile(moduleRelPath, namedReexport.specifier, store, scopePaths);
    if (resolved.kind === "out_of_scope") {
      return { kind: "unresolved", reason: "EXTERNAL_MODULE_SPECIFIER" };
    }
    if (resolved.kind === "missing") {
      return { kind: "unresolved", reason: "MODULE_FILE_NOT_FOUND" };
    }
    if (resolved.kind === "pending") {
      return { kind: "pending", path: resolved.path };
    }
    return resolveModuleExport(store, resolved.path, namedReexport.original, scopePaths, stack, barrelDepth);
  }
  if (decls.typeOnlyExports.has(exportName)) {
    return { kind: "type_only", reason: "TYPE_ONLY_IMPORT_OR_DECLARATION" };
  }
  const branches: ValueExport[] = [];
  let unresolvedBranch = false;
  let typeOnlyBranch = false;
  for (const specifier of decls.starReexports) {
    const resolved = resolveModuleFile(moduleRelPath, specifier, store, scopePaths);
    if (resolved.kind === "out_of_scope") {
      unresolvedBranch = true;
      continue;
    }
    if (resolved.kind === "missing") {
      unresolvedBranch = true;
      continue;
    }
    if (resolved.kind === "pending") {
      return { kind: "pending", path: resolved.path };
    }
    if (barrelDepth >= 2) {
      return { kind: "unresolved", reason: "BARREL_DEPTH_EXCEEDED" };
    }
    const branch = resolveModuleExport(store, resolved.path, exportName, scopePaths, stack, barrelDepth + 1);
    if (branch.kind === "bound") {
      branches.push(Object.freeze({
        name: branch.decl.name,
        chain: branch.decl.chain,
        originFile: branch.originFile,
        span: branch.decl.span,
        kind: branch.decl.kind,
        node: branch.decl.node,
        ambient: branch.decl.body === undefined,
      }));
    } else if (branch.kind === "type_only") {
      typeOnlyBranch = true;
    } else if (branch.kind === "notfound") {
      continue;
    } else if (branch.kind === "unresolved" && branch.reason === "BARREL_DEPTH_EXCEEDED") {
      return { kind: "unresolved", reason: "BARREL_DEPTH_EXCEEDED" };
    } else {
      unresolvedBranch = true;
    }
  }
  if (unresolvedBranch) {
    return { kind: "unresolved", reason: "UNRESOLVED_BARREL_BRANCH" };
  }
  if (branches.length === 0) {
    return typeOnlyBranch
      ? { kind: "type_only", reason: "TYPE_ONLY_IMPORT_OR_DECLARATION" }
      : { kind: "notfound", reason: "EXPORT_STAR_NO_BINDING" };
  }
  const unique = new Map<string, ValueExport>();
  for (const branch of branches) {
    unique.set(`${branch.originFile}#${spanKey(branch.span)}`, branch);
  }
  if (unique.size === 1) {
    const only = [...unique.values()][0]!;
    return { kind: "bound", decl: valueExportToDecl(only), originFile: only.originFile };
  }
  return { kind: "ambiguous", reason: "AMBIGUOUS_BARREL_WILDCARD_EXPORT" };
}

export type CallsiteResolution =
  | { kind: "resolved"; decl: DeclInfo; originFile: string }
  | { kind: "dynamic"; reason: string }
  | { kind: "external"; reason: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "pending"; path: string };

function verifyCallableImplementation(
  decl: DeclInfo,
  originFile: string,
  lexicalDynamic: boolean,
): CallsiteResolution {
  if (isCallableKind(decl.kind) && decl.body !== undefined) {
    return { kind: "resolved", decl, originFile };
  }
  if (decl.kind === "ambient") {
    return { kind: "unresolved", reason: "AMBIENT_OR_TYPE_ONLY_DECLARATION" };
  }
  if (lexicalDynamic) {
    return { kind: "dynamic", reason: "LEXICAL_PARAM_OR_VARIABLE_CALL" };
  }
  return { kind: "unresolved", reason: "BOUND_EXPORT_NOT_CALLABLE_FUNCTION" };
}

function resolveSameFileDeclaration(
  caller: SourceFileInfo,
  rootId: string,
  callerChain: string,
): DeclInfo | undefined {
  const decls = declarationsOf(caller);
  let prefix = callerChain;
  for (;;) {
    const key = prefix === "" ? rootId : `${prefix}.${rootId}`;
    const decl = decls.byChain.get(key);
    if (decl !== undefined) return decl;
    if (prefix === "") return undefined;
    const dot = prefix.lastIndexOf(".");
    prefix = dot === -1 ? "" : prefix.slice(0, dot);
  }
}

export function resolveCallsite(
  store: ModuleStore,
  scopePaths: readonly string[],
  callerFile: string,
  callsite: RawCallsite,
): CallsiteResolution {
  if (callsite.lexical.kind === "callable") {
    return verifyCallableImplementation(callsite.lexical.decl, callsite.lexical.decl.file, false);
  }
  if (callsite.lexical.kind === "noncallable") {
    return { kind: "dynamic", reason: callsite.lexical.reason };
  }
  if (callsite.rootId === null) {
    return { kind: "dynamic", reason: "UNRESOLVED_CALLEE_EXPRESSION" };
  }
  const caller = store.get(callerFile);
  if (caller === undefined) return { kind: "pending", path: callerFile };
  const imports = collectImports(caller);
  const imported = imports.find(item => item.local === callsite.rootId);
  if (imported !== undefined) {
    if (imported.typeOnly === true) {
      return { kind: "unresolved", reason: "TYPE_ONLY_IMPORT_OR_DECLARATION" };
    }
    if (imported.exportName === "*") {
      return { kind: "dynamic", reason: "NAMESPACE_MEMBER_ACCESS" };
    }
    const resolvedFile = resolveModuleFile(callerFile, imported.moduleSpecifier, store, scopePaths);
    if (resolvedFile.kind === "out_of_scope") {
      return { kind: "external", reason: "EXTERNAL_MODULE_SPECIFIER" };
    }
    if (resolvedFile.kind === "missing") {
      return { kind: "unresolved", reason: "MODULE_FILE_NOT_FOUND" };
    }
    if (resolvedFile.kind === "pending") {
      return { kind: "pending", path: resolvedFile.path };
    }
    const moduleResult = resolveModuleExport(store, resolvedFile.path, imported.exportName, scopePaths, Object.freeze([]));
    if (moduleResult.kind === "pending") return moduleResult;
    if (moduleResult.kind === "ambiguous") return { kind: "unresolved", reason: "AMBIGUOUS_BARREL_WILDCARD_EXPORT" };
    if (moduleResult.kind === "type_only") return { kind: "unresolved", reason: "TYPE_ONLY_IMPORT_OR_DECLARATION" };
    if (moduleResult.kind === "notfound") return { kind: "unresolved", reason: "EXPORT_NAME_NOT_FOUND" };
    if (moduleResult.kind === "unresolved") return { kind: "unresolved", reason: moduleResult.reason };
    return verifyCallableImplementation(moduleResult.decl, moduleResult.originFile, false);
  }
  const sameFile = resolveSameFileDeclaration(caller, callsite.rootId, callsite.callerChain);
  if (sameFile !== undefined) {
    return verifyCallableImplementation(sameFile, sameFile.file, false);
  }
  if (GLOBAL_WHITELIST.has(callsite.rootId)) {
    return { kind: "external", reason: "UNSHADOWED_BUILTIN_GLOBAL" };
  }
  return { kind: "unresolved", reason: "UNBOUND_FREE_IDENTIFIER" };
}

export function originIdentity(file: string, span: DeclSpan): string {
  return `${file}#${spanKey(span)}`;
}
