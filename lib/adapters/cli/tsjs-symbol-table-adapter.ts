// TypeScript / JavaScript single-file symbol-table adapter.
//
// Backend is exactly the repository-pinned `typescript` compiler AST
// (`ts.createSourceFile`), so no external binary and no extra npm dependency is
// required. File discovery and public CLI wiring are owned by the public entry;
// this module processes an explicit list of repo-relative source files.
//
// Hard constraints honoured here:
//  - zero recursive AST walk: every traversal and binding scan uses an explicit
//    heap-allocated stack, so the JS call stack depth stays O(1);
//  - `setParentNodes: false`, one file at a time, AST dropped before the next;
//  - 1-based Unicode code-point line/column spans (`Array.from`);
//  - same-name declarations are never merged; parse failures never report an
//    empty table as success.

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import {
  projectTsJsSymbolTableResult,
  symbolIdFor,
  validateTsJsSymbolRequest,
  type TsJsCoverageRecord,
  type TsJsDeclaredIn,
  type TsJsDynamicMemberBoundary,
  type TsJsModuleSystem,
  type TsJsNameSpanSource,
  type TsJsOwnerKind,
  type TsJsParseError,
  type TsJsParseErrorFile,
  type TsJsParserRecord,
  type TsJsSpan,
  type TsJsSymbolKind,
  type TsJsSymbolRecord,
  type TsJsSymbolTableOutcome,
  type TsJsVisibility,
} from "../../filters/tsjs-symbol-table-policy.js";

type SymbolDraft = Omit<TsJsSymbolRecord, "symbolId" | "parseStatus">;

type ExtractedFile = Readonly<{
  symbols: readonly SymbolDraft[];
  boundaries: readonly TsJsDynamicMemberBoundary[];
  parseErrors: readonly TsJsParseError[];
  moduleSystem: TsJsModuleSystem;
}>;

type ScopeKind = "sourceFile" | "module" | "function" | "block";

type ScopeFrame = Readonly<{
  kind: ScopeKind;
  localBindings: ReadonlySet<string>;
}>;

type Ctx = Readonly<{
  scopes: readonly ScopeFrame[];
  labels: readonly string[];
  ownerType: string | null;
  ownerKind: TsJsOwnerKind;
  container: TsJsDeclaredIn;
}>;

type Work = Readonly<{
  node: ts.Node;
  ctx: Ctx;
}>;

// ---------------------------------------------------------------------------
// Binding and scope collection (explicit heap stacks, zero recursion).
// ---------------------------------------------------------------------------

function isVarHoistBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isModuleBlock(node)
  );
}

function isScopeCreatingNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    isVarHoistBoundary(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

function collectBindingNames(rootName: ts.BindingName, out: Set<string>): void {
  const stack: ts.BindingName[] = [rootName];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (ts.isIdentifier(current)) {
      out.add(current.text);
    } else if (ts.isObjectBindingPattern(current)) {
      for (let index = current.elements.length - 1; index >= 0; index -= 1) {
        const element = current.elements[index];
        if (element !== undefined) stack.push(element.name);
      }
    } else if (ts.isArrayBindingPattern(current)) {
      for (let index = current.elements.length - 1; index >= 0; index -= 1) {
        const element = current.elements[index];
        if (element !== undefined && ts.isBindingElement(element)) stack.push(element.name);
      }
    }
  }
}

/**
 * Collect the leaf identifiers of a binding name together with the node that
 * owns each binding. A direct identifier is owned by `baseOwner` (the
 * VariableDeclaration); a destructuring leaf is owned by its BindingElement.
 */
function collectBindingLeaves(
  rootName: ts.BindingName,
  baseOwner: ts.Node,
  out: { name: ts.Identifier; owner: ts.Node }[],
): void {
  const stack: { name: ts.BindingName; owner: ts.Node }[] = [{ name: rootName, owner: baseOwner }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const { name, owner } = current;
    if (ts.isIdentifier(name)) {
      out.push({ name, owner });
    } else if (ts.isObjectBindingPattern(name)) {
      for (let index = name.elements.length - 1; index >= 0; index -= 1) {
        const element = name.elements[index];
        if (element !== undefined) stack.push({ name: element.name, owner: element });
      }
    } else if (ts.isArrayBindingPattern(name)) {
      for (let index = name.elements.length - 1; index >= 0; index -= 1) {
        const element = name.elements[index];
        if (element !== undefined && ts.isBindingElement(element)) {
          stack.push({ name: element.name, owner: element });
        }
      }
    }
  }
}

function collectHoistedVarBindings(root: ts.Node, out: Set<string>): void {
  const stack: ts.Node[] = [];
  ts.forEachChild(root, child => {
    stack.push(child);
  });
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (isVarHoistBoundary(current)) continue;
    if (
      ts.isVariableDeclarationList(current) &&
      (current.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of current.declarations) {
        collectBindingNames(declaration.name, out);
      }
    }
    ts.forEachChild(current, grandChild => {
      stack.push(grandChild);
    });
  }
}

function collectStatementListLexicalBindings(
  statements: readonly ts.Statement[],
  out: Set<string>,
): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
        for (const declaration of statement.declarationList.declarations) {
          collectBindingNames(declaration.name, out);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      out.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause;
      if (clause.name !== undefined) out.add(clause.name.text);
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          out.add(clause.namedBindings.name.text);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) out.add(element.name.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      out.add(statement.name.text);
    }
  }
}

function createScopeFrame(node: ts.Node): ScopeFrame {
  const bindings = new Set<string>();
  const isHoistRoot = ts.isSourceFile(node) || ts.isModuleBlock(node) || isVarHoistBoundary(node);

  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  ) {
    bindings.add(node.name.text);
  }

  if (ts.isFunctionLike(node) && "parameters" in node) {
    for (const parameter of node.parameters) {
      collectBindingNames(parameter.name, bindings);
    }
  }

  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
    collectBindingNames(node.variableDeclaration.name, bindings);
  }

  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer) &&
    (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
  ) {
    for (const declaration of node.initializer.declarations) {
      collectBindingNames(declaration.name, bindings);
    }
  }

  if (
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isBlock(node) ||
    ts.isClassStaticBlockDeclaration(node)
  ) {
    collectStatementListLexicalBindings(
      ts.isClassStaticBlockDeclaration(node) ? node.body.statements : node.statements,
      bindings,
    );
  } else if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) {
      collectStatementListLexicalBindings(clause.statements, bindings);
    }
  }

  if (isHoistRoot) collectHoistedVarBindings(node, bindings);

  const kind: ScopeKind = ts.isSourceFile(node)
    ? "sourceFile"
    : ts.isModuleBlock(node)
      ? "module"
      : isHoistRoot
        ? "function"
        : "block";
  return Object.freeze({ kind, localBindings: bindings });
}

function isUnshadowedCjsRoot(rootName: "module" | "exports", scopes: readonly ScopeFrame[]): boolean {
  for (const frame of scopes) {
    if (frame.localBindings.has(rootName)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1-based code-point line/column spans.
// ---------------------------------------------------------------------------

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineIndexFor(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let answer = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lineStarts[mid] ?? 0;
    if (start <= position) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function makeSpanFn(sourceText: string, lineStarts: readonly number[]) {
  return (start: number, end: number): TsJsSpan => {
    const startLineIndex = lineIndexFor(lineStarts, start);
    const endLineIndex = lineIndexFor(lineStarts, end);
    const startLineStart = lineStarts[startLineIndex] ?? 0;
    const endLineStart = lineStarts[endLineIndex] ?? 0;
    const startCol = Array.from(sourceText.slice(startLineStart, start)).length + 1;
    const endCol = Array.from(sourceText.slice(endLineStart, end)).length + 1;
    return Object.freeze({
      startLine: startLineIndex + 1,
      startCol,
      endLine: endLineIndex + 1,
      endCol,
    });
  };
}

// ---------------------------------------------------------------------------
// Small AST helpers.
// ---------------------------------------------------------------------------

function scriptKindFor(relFile: string): ts.ScriptKind {
  if (relFile.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (relFile.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (relFile.endsWith(".js") || relFile.endsWith(".mjs") || relFile.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function languageVariantFor(kind: ts.ScriptKind): ts.LanguageVariant {
  return kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
}

function stripParensAndAssertions(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (let guard = 0; guard < 64; guard += 1) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

function leftmostIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (let guard = 0; guard < 4096; guard += 1) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
}

function sourceHasEsmSyntax(sf: ts.SourceFile): boolean {
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement)
    ) {
      return true;
    }
    if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement);
      if (modifiers !== undefined && modifiers.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        return true;
      }
    }
  }
  return false;
}

function sourceHasTopLevelCjs(sf: ts.SourceFile): boolean {
  for (const statement of sf.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = statement.expression.left;
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const root = leftmostIdentifier(left);
        if (root === "module" || root === "exports") return true;
      }
    }
  }
  return false;
}

function classifyModuleSystem(relFile: string, sf: ts.SourceFile): TsJsModuleSystem {
  if (sf.isDeclarationFile) return "ambient_dts";
  if (relFile.endsWith(".mjs") || relFile.endsWith(".mts")) return "esm";
  if (relFile.endsWith(".cjs") || relFile.endsWith(".cts")) return "cjs";
  if (sourceHasEsmSyntax(sf)) return "esm";
  if (sourceHasTopLevelCjs(sf)) return "cjs";
  return "script";
}

const MODIFIER_ORDER: readonly string[] = Object.freeze([
  "export",
  "default",
  "declare",
  "async",
  "abstract",
  "static",
  "readonly",
  "override",
  "const",
  "let",
  "var",
]);

function modifierSet(node: ts.Node): Set<string> {
  const present = new Set<string>();
  if (!ts.canHaveModifiers(node)) return present;
  for (const modifier of ts.getModifiers(node) ?? []) {
    switch (modifier.kind) {
      case ts.SyntaxKind.ExportKeyword:
        present.add("export");
        break;
      case ts.SyntaxKind.DefaultKeyword:
        present.add("default");
        break;
      case ts.SyntaxKind.DeclareKeyword:
        present.add("declare");
        break;
      case ts.SyntaxKind.AsyncKeyword:
        present.add("async");
        break;
      case ts.SyntaxKind.AbstractKeyword:
        present.add("abstract");
        break;
      case ts.SyntaxKind.StaticKeyword:
        present.add("static");
        break;
      case ts.SyntaxKind.ReadonlyKeyword:
        present.add("readonly");
        break;
      case ts.SyntaxKind.OverrideKeyword:
        present.add("override");
        break;
      case ts.SyntaxKind.ConstKeyword:
        present.add("const");
        break;
      default:
        break;
    }
  }
  return present;
}

function orderedModifiers(node: ts.Node, kindToken: string | null = null): readonly string[] {
  const present = modifierSet(node);
  if (kindToken !== null) present.add(kindToken);
  const out = MODIFIER_ORDER.filter(token => present.has(token));
  if (ts.isGetAccessorDeclaration(node)) out.push("get");
  if (ts.isSetAccessorDeclaration(node)) out.push("set");
  return out;
}

function accessibilityOf(node: ts.Node): TsJsVisibility {
  const flags = ts.canHaveModifiers(node) ? ts.getCombinedModifierFlags(node as ts.Declaration) : ts.ModifierFlags.None;
  if ((flags & ts.ModifierFlags.Private) !== 0) return "private";
  if ((flags & ts.ModifierFlags.Protected) !== 0) return "protected";
  if ((flags & ts.ModifierFlags.Public) !== 0) return "public";
  const name = ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || isAccessorNode(node)
    ? node.name
    : undefined;
  if (name !== undefined && ts.isPrivateIdentifier(name)) return "private";
  return "public";
}

function declarationVisibility(node: ts.Node): TsJsVisibility {
  return modifierSet(node).has("export") ? "exported" : "module_private";
}

function isAccessorNode(node: ts.Node): node is ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function staticMemberName(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (ts.isNumericLiteral(expression)) return expression.text;
  }
  return null;
}

function displayName(name: ts.Node): string {
  if (ts.isPrivateIdentifier(name)) return name.text;
  return staticMemberName(name) ?? "<computed>";
}

function hasDefaultModifier(node: ts.Node): boolean {
  return modifierSet(node).has("default");
}

// ---------------------------------------------------------------------------
// The extractor.
// ---------------------------------------------------------------------------

type EmitFn = (record: SymbolDraft) => void;
type BoundaryFn = (boundary: TsJsDynamicMemberBoundary) => void;

type CjsTarget = Readonly<{
  root: "module" | "exports";
  target: string | null;
  nameNode: ts.Node | null;
  wholeNode: ts.Node;
  dynamicExpression: ts.Expression | null;
}>;

function extractSourceFileSymbols(
  sf: ts.SourceFile,
  relFile: string,
  sourceText: string,
  lineStarts: readonly number[],
  scriptKind: ts.ScriptKind,
): ExtractedFile {
  const spanOf = makeSpanFn(sourceText, lineStarts);
  const moduleSystem = classifyModuleSystem(relFile, sf);
  const symbols: SymbolDraft[] = [];
  const boundaries: TsJsDynamicMemberBoundary[] = [];
  const consumed = new Set<ts.Node>();
  const emit: EmitFn = record => {
    symbols.push(record);
  };
  const addBoundary: BoundaryFn = boundary => {
    boundaries.push(boundary);
  };

  const stack: Work[] = [];
  const pushAll = (node: ts.Node, ctx: Ctx): void => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child, ctx });
    }
  };

  interface DraftInput {
    ctx: Ctx;
    name: string;
    kind: TsJsSymbolKind;
    declSpan: TsJsSpan;
    nameSpan: TsJsSpan | null;
    nameSpanSource: TsJsNameSpanSource;
    modifiers: readonly string[];
    visibility: TsJsVisibility;
    declaredIn: TsJsDeclaredIn;
    ownerType: string | null;
    ownerKind: TsJsOwnerKind;
    labels: readonly string[];
  }

  const draft = (input: DraftInput): SymbolDraft =>
    Object.freeze({
      name: input.name,
      kind: input.kind,
      file: relFile,
      declSpan: input.declSpan,
      nameSpan: input.nameSpan,
      nameSpanSource: input.nameSpanSource,
      lexicalScope: Object.freeze(input.labels.slice()),
      ownerType: input.ownerType,
      ownerKind: input.ownerKind,
      modifiers: Object.freeze(input.modifiers.slice()),
      visibility: input.visibility,
      moduleSystem,
      declaredIn: input.declaredIn,
    });

  const spanOfNode = (node: ts.Node): TsJsSpan => spanOf(node.getStart(sf, false), node.getEnd());

  // --- scope entry helpers -------------------------------------------------

  const functionLabel = (node: ts.Node): string => {
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      return `fn:${staticMemberName(node.name) ?? "computed"}`;
    }
    if (ts.isConstructorDeclaration(node)) return "fn:constructor";
    if (isAccessorNode(node)) return `fn:${staticMemberName(node.name) ?? "accessor"}`;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name !== undefined) {
      return `fn:${node.name.text}`;
    }
    return "fn:anonymous";
  };

  const functionCtx = (node: ts.Node, ctx: Ctx): Ctx => ({
    scopes: [...ctx.scopes, createScopeFrame(node)],
    labels: [...ctx.labels, functionLabel(node)],
    ownerType: ctx.ownerType,
    ownerKind: ctx.ownerKind,
    container: "local_scope",
  });

  const classCtx = (node: ts.ClassDeclaration | ts.ClassExpression, ctx: Ctx): Ctx => {
    const name = node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : null;
    return {
      scopes: [...ctx.scopes, createScopeFrame(node)],
      labels: [...ctx.labels, `class:${name ?? "anonymous"}`],
      ownerType: name ?? ctx.ownerType,
      ownerKind: "class",
      container: "class_body",
    };
  };

  const memberCtx = (ctx: Ctx, ownerType: string, ownerKind: TsJsOwnerKind, label: string, container: TsJsDeclaredIn): Ctx => ({
    scopes: ctx.scopes,
    labels: [...ctx.labels, label],
    ownerType,
    ownerKind,
    container,
  });

  // --- CJS target resolution ----------------------------------------------

  const resolveCjsTarget = (left: ts.Expression): CjsTarget | null => {
    let base: ts.Expression;
    let name: string | null = null;
    let nameNode: ts.Node | null = null;
    let dynamicExpression: ts.Expression | null = null;

    if (ts.isPropertyAccessExpression(left)) {
      base = left.expression;
      name = left.name.text;
      nameNode = left.name;
    } else if (ts.isElementAccessExpression(left)) {
      base = left.expression;
      const argument = left.argumentExpression;
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        name = argument.text;
        nameNode = argument;
      } else if (ts.isNumericLiteral(argument)) {
        name = argument.text;
        nameNode = argument;
      } else {
        dynamicExpression = argument;
      }
    } else {
      return null;
    }

    let root: "module" | "exports" | null = null;
    let baseTarget: string | null = null;
    if (ts.isIdentifier(base)) {
      if (base.text === "module" || base.text === "exports") root = base.text;
    } else if (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      base.expression.text === "module" &&
      base.name.text === "exports"
    ) {
      root = "module";
      baseTarget = "exports";
    }
    if (root === null) return null;

    if (baseTarget === null) {
      if (root === "module") {
        if (dynamicExpression !== null) {
          return { root, target: null, nameNode: null, wholeNode: left, dynamicExpression };
        }
        if (name === "exports") {
          return { root, target: null, nameNode: null, wholeNode: left, dynamicExpression: null };
        }
        return null;
      }
      return { root: "exports", target: name, nameNode, wholeNode: left, dynamicExpression };
    }
    return { root: "module", target: name, nameNode, wholeNode: left, dynamicExpression };
  };

  const boundaryFor = (
    boundaryKind: TsJsDynamicMemberBoundary["boundaryKind"],
    memberKind: TsJsDynamicMemberBoundary["memberKind"],
    expr: ts.Expression,
    declSpan: TsJsSpan,
    ctx: Ctx,
    ownerType: string | null,
  ): TsJsDynamicMemberBoundary =>
    Object.freeze({
      boundaryKind,
      memberKind,
      expressionText: sourceText.slice(expr.getStart(sf, false), expr.getEnd()),
      file: relFile,
      declSpan,
      expressionSpan: spanOfNode(expr),
      lexicalScope: Object.freeze(ctx.labels.slice()),
      ownerType,
      reason: "DYNAMIC_COMPUTED_NAME",
    });

  const memberBoundaryKind = (ctx: Ctx): TsJsDynamicMemberBoundary["boundaryKind"] => {
    if (ctx.container === "interface_body") return "interface_computed_member";
    return "class_computed_member";
  };

  // --- emitters ------------------------------------------------------------

  const emitFunctionDeclaration = (node: ts.FunctionDeclaration, ctx: Ctx): void => {
    const named = node.name !== undefined && ts.isIdentifier(node.name);
    const isDefault = hasDefaultModifier(node);
    if (!named && !isDefault) return;
    const name = named && node.name !== undefined ? node.name.text : "default";
    const nameSpan = named && node.name !== undefined
      ? spanOfNode(node.name)
      : scanDefaultKeywordSpan(node);
    emit(
      draft({
        ctx,
        name,
        kind: "function",
        declSpan: spanOfNode(node),
        nameSpan,
        nameSpanSource: named ? "identifier" : "default_keyword",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitClassLike = (node: ts.ClassDeclaration | ts.ClassExpression, ctx: Ctx): void => {
    const named = node.name !== undefined && ts.isIdentifier(node.name);
    const isDefault = hasDefaultModifier(node);
    if (!named && !isDefault) return;
    const name = named && node.name !== undefined ? node.name.text : "default";
    const nameSpan = named && node.name !== undefined
      ? spanOfNode(node.name)
      : scanDefaultKeywordSpan(node);
    emit(
      draft({
        ctx,
        name,
        kind: "class",
        declSpan: spanOfNode(node),
        nameSpan,
        nameSpanSource: named ? "identifier" : "default_keyword",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitInterface = (node: ts.InterfaceDeclaration, ctx: Ctx): void => {
    emit(
      draft({
        ctx,
        name: node.name.text,
        kind: "interface",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "identifier",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitTypeAlias = (node: ts.TypeAliasDeclaration, ctx: Ctx): void => {
    emit(
      draft({
        ctx,
        name: node.name.text,
        kind: "type_alias",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "identifier",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitEnum = (node: ts.EnumDeclaration, ctx: Ctx): void => {
    emit(
      draft({
        ctx,
        name: node.name.text,
        kind: "enum",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "identifier",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitEnumMember = (node: ts.EnumMember, ctx: Ctx): void => {
    const name = staticMemberName(node.name);
    if (name === null) return;
    emit(
      draft({
        ctx,
        name,
        kind: "enum_member",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "identifier",
        modifiers: [],
        visibility: "public",
        declaredIn: "enum_body",
        ownerType: ctx.ownerType,
        ownerKind: "enum",
        labels: ctx.labels,
      }),
    );
  };

  const emitNamespace = (node: ts.ModuleDeclaration, ctx: Ctx): void => {
    const isLiteral = ts.isStringLiteral(node.name);
    const name = isLiteral ? node.name.text : node.name.text;
    emit(
      draft({
        ctx,
        name,
        kind: "namespace",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: isLiteral ? "module_literal" : "identifier",
        modifiers: orderedModifiers(node),
        visibility: declarationVisibility(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitConstructor = (node: ts.ConstructorDeclaration, ctx: Ctx): void => {
    const start = node.getStart(sf, false);
    emit(
      draft({
        ctx,
        name: "constructor",
        kind: "constructor",
        declSpan: spanOfNode(node),
        nameSpan: spanOf(start, start + "constructor".length),
        nameSpanSource: "constructor_keyword",
        modifiers: orderedModifiers(node),
        visibility: accessibilityOf(node),
        declaredIn: "class_body",
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
    for (const parameter of node.parameters) {
      const flags = ts.getCombinedModifierFlags(parameter);
      const parameterProperty =
        (flags & (ts.ModifierFlags.Public | ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Readonly)) !== 0;
      if (!parameterProperty || !ts.isIdentifier(parameter.name)) continue;
      emit(
        draft({
          ctx,
          name: parameter.name.text,
          kind: "property",
          declSpan: spanOfNode(parameter),
          nameSpan: spanOfNode(parameter.name),
          nameSpanSource: "identifier",
          modifiers: orderedModifiers(parameter),
          visibility: accessibilityOf(parameter),
          declaredIn: "primary_constructor",
          ownerType: ctx.ownerType,
          ownerKind: ctx.ownerKind,
          labels: ctx.labels,
        }),
      );
    }
  };

  const emitMethodLike = (
    node: ts.MethodDeclaration | ts.MethodSignature,
    ctx: Ctx,
  ): void => {
    if (ctx.container !== "class_body" && ctx.container !== "interface_body" && ctx.container !== "commonjs_export") {
      return;
    }
    if (ts.isComputedPropertyName(node.name) && staticMemberName(node.name) === null) {
      addBoundary(boundaryFor(memberBoundaryKind(ctx), "method", node.name.expression, spanOfNode(node), ctx, ctx.ownerType));
      return;
    }
    const name = displayName(node.name);
    const computed = ts.isComputedPropertyName(node.name);
    emit(
      draft({
        ctx,
        name,
        kind: "method",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: ctx.container === "commonjs_export" ? "cjs_export_target" : computed ? "computed_literal" : "identifier",
        modifiers: orderedModifiers(node),
        visibility: ctx.container === "commonjs_export" ? "exported" : accessibilityOf(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitAccessor = (
    node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
    ctx: Ctx,
  ): void => {
    if (ctx.container !== "class_body" && ctx.container !== "commonjs_export") return;
    if (ts.isComputedPropertyName(node.name) && staticMemberName(node.name) === null) {
      addBoundary(boundaryFor(memberBoundaryKind(ctx), "accessor", node.name.expression, spanOfNode(node), ctx, ctx.ownerType));
      return;
    }
    emit(
      draft({
        ctx,
        name: displayName(node.name),
        kind: "accessor",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: ctx.container === "commonjs_export" ? "cjs_export_target" : "identifier",
        modifiers: orderedModifiers(node),
        visibility: ctx.container === "commonjs_export" ? "exported" : accessibilityOf(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitProperty = (
    node: ts.PropertyDeclaration | ts.PropertySignature,
    ctx: Ctx,
  ): void => {
    if (ctx.container !== "class_body" && ctx.container !== "interface_body" && ctx.container !== "commonjs_export") {
      return;
    }
    if (ts.isComputedPropertyName(node.name) && staticMemberName(node.name) === null) {
      addBoundary(boundaryFor(memberBoundaryKind(ctx), "property", node.name.expression, spanOfNode(node), ctx, ctx.ownerType));
      return;
    }
    emit(
      draft({
        ctx,
        name: displayName(node.name),
        kind: "property",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: ctx.container === "commonjs_export" ? "cjs_export_target" : "identifier",
        modifiers: orderedModifiers(node),
        visibility: ctx.container === "commonjs_export" ? "exported" : accessibilityOf(node),
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const emitPropertyAssignment = (node: ts.PropertyAssignment, ctx: Ctx): void => {
    if (ctx.container !== "commonjs_export") return;
    if (ts.isComputedPropertyName(node.name) && staticMemberName(node.name) === null) {
      addBoundary(boundaryFor("commonjs_computed_export", "property", node.name.expression, spanOfNode(node), ctx, ctx.ownerType));
      return;
    }
    const value = stripParensAndAssertions(node.initializer);
    let kind: TsJsSymbolKind = "variable";
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      kind = "function";
      consumed.add(value);
    } else if (ts.isClassExpression(value)) {
      kind = "class";
      consumed.add(value);
    }
    emit(
      draft({
        ctx,
        name: displayName(node.name),
        kind,
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "cjs_export_target",
        modifiers: [],
        visibility: "exported",
        declaredIn: "commonjs_export",
        ownerType: ctx.ownerType,
        ownerKind: "commonjs_exports",
        labels: ctx.labels,
      }),
    );
  };

  const emitShorthandAssignment = (node: ts.ShorthandPropertyAssignment, ctx: Ctx): void => {
    if (ctx.container !== "commonjs_export") return;
    emit(
      draft({
        ctx,
        name: node.name.text,
        kind: "variable",
        declSpan: spanOfNode(node),
        nameSpan: spanOfNode(node.name),
        nameSpanSource: "cjs_export_target",
        modifiers: [],
        visibility: "exported",
        declaredIn: "commonjs_export",
        ownerType: ctx.ownerType,
        ownerKind: "commonjs_exports",
        labels: ctx.labels,
      }),
    );
  };

  const emitVariableStatement = (node: ts.VariableStatement, ctx: Ctx): void => {
    if (ctx.container !== "file" && ctx.container !== "namespace_body") return;
    const list = node.declarationList;
    const kindToken = (list.flags & ts.NodeFlags.Const) !== 0
      ? "const"
      : (list.flags & ts.NodeFlags.Let) !== 0
        ? "let"
        : "var";
    const modifiers = orderedModifiers(node, kindToken);
    const visibility = declarationVisibility(node);
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const initializer = declaration.initializer !== undefined
          ? stripParensAndAssertions(declaration.initializer)
          : null;
        let kind: TsJsSymbolKind = "variable";
        if (initializer !== null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          kind = "function";
          consumed.add(initializer);
        } else if (initializer !== null && ts.isClassExpression(initializer)) {
          kind = "class";
          consumed.add(initializer);
        }
        emit(
          draft({
            ctx,
            name: declaration.name.text,
            kind,
            declSpan: spanOfNode(declaration),
            nameSpan: spanOfNode(declaration.name),
            nameSpanSource: "identifier",
            modifiers,
            visibility,
            declaredIn: ctx.container,
            ownerType: ctx.ownerType,
            ownerKind: ctx.ownerKind,
            labels: ctx.labels,
          }),
        );
      } else {
        const leaves: { name: ts.Identifier; owner: ts.Node }[] = [];
        collectBindingLeaves(declaration.name, declaration, leaves);
        for (const leaf of leaves) {
          emit(
            draft({
              ctx,
              name: leaf.name.text,
              kind: "variable",
              declSpan: spanOfNode(leaf.owner),
              nameSpan: spanOfNode(leaf.name),
              nameSpanSource: "identifier",
              modifiers,
              visibility,
              declaredIn: ctx.container,
              ownerType: ctx.ownerType,
              ownerKind: ctx.ownerKind,
              labels: ctx.labels,
            }),
          );
        }
      }
    }
  };

  const scanDefaultKeywordSpan = (node: ts.Node): TsJsSpan | null => {
    const start = node.getStart(sf, false);
    const end = node.getEnd();
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, languageVariantFor(scriptKind), sourceText);
    scanner.setTextPos(start);
    for (let guard = 0; guard < 16; guard += 1) {
      const token = scanner.scan();
      if (token === ts.SyntaxKind.EndOfFileToken) return null;
      const tokenStart = scanner.getTokenStart();
      if (tokenStart >= end) return null;
      if (token === ts.SyntaxKind.DefaultKeyword) return spanOf(tokenStart, scanner.getTokenEnd());
    }
    return null;
  };

  const emitExportAssignment = (node: ts.ExportAssignment, ctx: Ctx): void => {
    const value = stripParensAndAssertions(node.expression);
    let kind: TsJsSymbolKind = "variable";
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      kind = "function";
      consumed.add(value);
    } else if (ts.isClassExpression(value)) {
      kind = "class";
      consumed.add(value);
    }
    emit(
      draft({
        ctx,
        name: "default",
        kind,
        declSpan: spanOfNode(node),
        nameSpan: scanDefaultKeywordSpan(node),
        nameSpanSource: "default_keyword",
        modifiers: ["export", "default"],
        visibility: "exported",
        declaredIn: ctx.container,
        ownerType: ctx.ownerType,
        ownerKind: ctx.ownerKind,
        labels: ctx.labels,
      }),
    );
  };

  const handleCjsAssignment = (node: ts.BinaryExpression, ctx: Ctx): boolean => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const target = resolveCjsTarget(node.left);
    if (target === null) return false;
    if (!isUnshadowedCjsRoot(target.root, ctx.scopes)) return false;

    const ownerType = target.root === "module" ? "module.exports" : "exports";
    const declSpan = spanOfNode(node);
    const cjsCtx: Ctx = {
      scopes: ctx.scopes,
      labels: ctx.labels,
      ownerType,
      ownerKind: "commonjs_exports",
      container: "commonjs_export",
    };

    if (target.dynamicExpression !== null) {
      addBoundary(
        boundaryFor("commonjs_computed_export", "export_assignment", target.dynamicExpression, declSpan, ctx, ownerType),
      );
      pushAll(node.left, ctx);
      pushAll(node.right, ctx);
      return true;
    }

    const rhs = stripParensAndAssertions(node.right);
    if (target.target === null && ts.isObjectLiteralExpression(rhs)) {
      pushAll(node.left, ctx);
      pushAll(rhs, cjsCtx);
      return true;
    }

    let kind: TsJsSymbolKind = "variable";
    if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
      kind = "function";
      consumed.add(rhs);
    } else if (ts.isClassExpression(rhs)) {
      kind = "class";
      consumed.add(rhs);
    }
    const name = target.target ?? "module.exports";
    const nameSpan = target.target === null
      ? spanOfNode(target.wholeNode)
      : target.nameNode !== null
        ? spanOfNode(target.nameNode)
        : spanOfNode(target.wholeNode);
    emit(
      draft({
        ctx,
        name,
        kind,
        declSpan,
        nameSpan,
        nameSpanSource: "cjs_export_target",
        modifiers: [],
        visibility: "exported",
        declaredIn: "commonjs_export",
        ownerType,
        ownerKind: "commonjs_exports",
        labels: ctx.labels,
      }),
    );
    pushAll(node.left, ctx);
    pushAll(node.right, ctx);
    return true;
  };

  // --- traversal -----------------------------------------------------------

  const rootCtx: Ctx = {
    scopes: [createScopeFrame(sf)],
    labels: [],
    ownerType: null,
    ownerKind: null,
    container: "file",
  };
  pushAll(sf, rootCtx);

  while (stack.length > 0) {
    const work = stack.pop();
    if (work === undefined) continue;
    const node = work.node;
    const ctx = work.ctx;
    const suppress = consumed.has(node);

    if (ts.isSourceFile(node)) {
      pushAll(node, { ...ctx, container: "file" });
      continue;
    }

    if (ts.isFunctionDeclaration(node)) {
      if (!suppress) emitFunctionDeclaration(node, ctx);
      pushAll(node, functionCtx(node, ctx));
      continue;
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      pushAll(node, functionCtx(node, ctx));
      continue;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (!suppress) emitClassLike(node, ctx);
      pushAll(node, classCtx(node, ctx));
      continue;
    }
    if (ts.isInterfaceDeclaration(node)) {
      if (!suppress) emitInterface(node, ctx);
      const child = memberCtx(ctx, node.name.text, "interface", `interface:${node.name.text}`, "interface_body");
      pushAll(node, child);
      continue;
    }
    if (ts.isEnumDeclaration(node)) {
      if (!suppress) emitEnum(node, ctx);
      const child = memberCtx(ctx, node.name.text, "enum", `enum:${node.name.text}`, "enum_body");
      pushAll(node, child);
      continue;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      if (!suppress) emitTypeAlias(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isModuleDeclaration(node)) {
      if (!suppress) emitNamespace(node, ctx);
      const namespaceName = node.name.text;
      const child = memberCtx(ctx, namespaceName, "namespace", `namespace:${namespaceName}`, "namespace_body");
      pushAll(node, child);
      continue;
    }
    if (ts.isEnumMember(node)) {
      emitEnumMember(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isConstructorDeclaration(node)) {
      if (!suppress) emitConstructor(node, ctx);
      pushAll(node, functionCtx(node, ctx));
      continue;
    }
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      if (!suppress) emitMethodLike(node, ctx);
      pushAll(node, functionCtx(node, ctx));
      continue;
    }
    if (isAccessorNode(node)) {
      if (!suppress) emitAccessor(node, ctx);
      pushAll(node, functionCtx(node, ctx));
      continue;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (!suppress) emitProperty(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isPropertyAssignment(node)) {
      if (!suppress) emitPropertyAssignment(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      if (!suppress) emitShorthandAssignment(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isVariableStatement(node)) {
      emitVariableStatement(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isExportAssignment(node)) {
      if (!suppress) emitExportAssignment(node, ctx);
      pushAll(node, ctx);
      continue;
    }
    if (ts.isBinaryExpression(node)) {
      if (!handleCjsAssignment(node, ctx)) pushAll(node, ctx);
      continue;
    }
    if (ts.isModuleBlock(node)) {
      pushAll(node, { ...ctx, scopes: [...ctx.scopes, createScopeFrame(node)], container: "namespace_body" });
      continue;
    }
    if (ts.isClassStaticBlockDeclaration(node)) {
      pushAll(node, { ...ctx, scopes: [...ctx.scopes, createScopeFrame(node)], container: "local_scope" });
      continue;
    }
    if (isScopeCreatingNode(node)) {
      pushAll(node, { ...ctx, scopes: [...ctx.scopes, createScopeFrame(node)], container: "local_scope" });
      continue;
    }

    pushAll(node, ctx);
  }

  const parseErrors: TsJsParseError[] = [];
  // `parseDiagnostics` is populated by the parser but is not part of the public
  // SourceFile typings; use the runtime field through a minimal cast.
  const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diagnostic of parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (diagnostic.start === undefined) {
      parseErrors.push(Object.freeze({ line: 1, column: 1, message }));
      continue;
    }
    const span = spanOf(diagnostic.start, diagnostic.start);
    parseErrors.push(Object.freeze({ line: span.startLine, column: span.startCol, message }));
  }

  return Object.freeze({
    symbols: Object.freeze(symbols),
    boundaries: Object.freeze(boundaries),
    parseErrors: Object.freeze(parseErrors),
    moduleSystem,
  });
}

export type TsJsSymbolTableAdapterOptions = Readonly<{
  /** Optional override of the recorded compiler version label (tests). */
  compilerVersionLabel?: string;
}>;

type FileOutcome =
  | Readonly<{ kind: "parsed"; extracted: ExtractedFile; invocations: number }>
  | Readonly<{ kind: "skipped"; reason: string }>
  | Readonly<{ kind: "failed"; reason: string }>;

function resolveInRepo(repoAbs: string, relFile: string): string {
  return path.resolve(repoAbs, relFile);
}

function isContained(baseAbs: string, targetAbs: string): boolean {
  const relative = path.relative(baseAbs, targetAbs);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  return true;
}

async function checkPathBoundary(
  repoAbs: string,
  repoReal: string,
  relFile: string,
): Promise<Readonly<{ ok: true }> | Readonly<{ kind: "skipped" | "failed"; reason: string }>> {
  const parts = relFile.split("/");
  let current = repoAbs;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] ?? "");
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      return { kind: "failed", reason: `stat_failed: ${(error as Error).message}` };
    }
    if (stats.isSymbolicLink()) return { kind: "skipped", reason: "SYMLINK_PATH_COMPONENT" };
    if (index < parts.length - 1) {
      if (!stats.isDirectory()) return { kind: "failed", reason: "not_a_directory" };
      continue;
    }
    if (!stats.isFile()) return { kind: "failed", reason: "not_a_regular_file" };
  }
  let resolvedFile: string;
  try {
    resolvedFile = await realpath(current);
  } catch (error) {
    return { kind: "failed", reason: `realpath_failed: ${(error as Error).message}` };
  }
  if (!isContained(repoReal, resolvedFile)) return { kind: "skipped", reason: "PATH_ESCAPES_REPO_ROOT" };
  return { ok: true };
}

async function processOneFile(repoAbs: string, relFile: string): Promise<FileOutcome> {
  const absFile = resolveInRepo(repoAbs, relFile);
  if (!isContained(repoAbs, absFile)) return { kind: "failed", reason: "path_escape" };
  let repoReal: string;
  try {
    repoReal = await realpath(repoAbs);
  } catch (error) {
    return { kind: "failed", reason: `repo_realpath_failed: ${(error as Error).message}` };
  }
  const boundary = await checkPathBoundary(repoAbs, repoReal, relFile);
  if (!("ok" in boundary)) {
    return boundary.kind === "skipped"
      ? { kind: "skipped", reason: boundary.reason }
      : { kind: "failed", reason: boundary.reason };
  }

  let sourceText: string;
  try {
    sourceText = await readFile(absFile, "utf8");
  } catch (error) {
    return { kind: "failed", reason: `read_failed: ${(error as Error).message}` };
  }

  const scriptKind = scriptKindFor(relFile);
  const lineStarts = computeLineStarts(sourceText);
  const sourceFile = ts.createSourceFile(relFile, sourceText, ts.ScriptTarget.Latest, false, scriptKind);
  const extracted = extractSourceFileSymbols(sourceFile, relFile, sourceText, lineStarts, scriptKind);
  return { kind: "parsed", extracted, invocations: 1 };
}

export async function runTsJsSymbolTable(
  rawRequest: unknown,
  options: TsJsSymbolTableAdapterOptions = {},
): Promise<TsJsSymbolTableOutcome> {
  const validation = validateTsJsSymbolRequest(rawRequest);
  if (!validation.ok) return validation.error;
  const request = validation.request;

  const repoAbs = path.resolve(request.repo);

  const uniqueFiles: string[] = [];
  const seenFiles = new Set<string>();
  for (const file of request.files) {
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      uniqueFiles.push(file);
    }
  }

  const symbolRecords: TsJsSymbolRecord[] = [];
  const boundaryRecords: TsJsDynamicMemberBoundary[] = [];
  const failed: { file: string; reason: string }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const parseErrorFiles: TsJsParseErrorFile[] = [];
  const partialReasons: string[] = [];
  let parsedCount = 0;
  let invocations = 0;

  for (const relFile of uniqueFiles) {
    const outcome = await processOneFile(repoAbs, relFile);
    if (outcome.kind === "failed") {
      failed.push({ file: relFile, reason: outcome.reason });
      partialReasons.push(`${relFile}: ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "skipped") {
      skipped.push({ file: relFile, reason: outcome.reason });
      partialReasons.push(`${relFile}: ${outcome.reason}`);
      continue;
    }
    invocations += outcome.invocations;
    parsedCount += 1;
    const { extracted } = outcome;
    const parseStatus = extracted.parseErrors.length > 0 ? "partial_syntax_error" : "complete";
    for (const record of extracted.symbols) {
      symbolRecords.push(
        Object.freeze({
          ...record,
          symbolId: symbolIdFor(record.file, record.name, record.declSpan),
          parseStatus,
        }),
      );
    }
    for (const boundary of extracted.boundaries) {
      boundaryRecords.push(boundary);
      partialReasons.push(`${relFile}: dynamic_computed_member`);
    }
    if (extracted.parseErrors.length > 0) {
      parseErrorFiles.push(Object.freeze({ file: relFile, errors: extracted.parseErrors }));
      partialReasons.push(`${relFile}: partial_syntax_error`);
    }
  }

  const partial =
    failed.length > 0 || skipped.length > 0 || parseErrorFiles.length > 0 || boundaryRecords.length > 0;

  const notes = [
    "semanticBinding=false; single-file AST only; tsconfig.json and node_modules are not read",
    "spans are 1-based with Unicode code-point columns; nameSpan is null when no reliable identifier span exists",
    "symlinks are never followed in any path component; duplicate file entries are deduplicated by repo-relative path",
  ];

  const coverage: TsJsCoverageRecord = Object.freeze({
    scopeFilesDiscovered: uniqueFiles.length,
    scopeFilesParsed: parsedCount,
    scopeFilesFailed: Object.freeze(failed),
    skipped: Object.freeze(skipped),
    parseErrorFiles: Object.freeze(parseErrorFiles),
    partial,
    partialReasons: Object.freeze([...new Set(partialReasons)]),
    truncated: false,
    parserInvocations: invocations,
    notes: Object.freeze(notes),
  });

  const parser: TsJsParserRecord = Object.freeze({
    backend: "typescript_compiler_ast",
    compilerVersion: options.compilerVersionLabel ?? ts.version,
    invocation:
      "ts.createSourceFile(relPath, sourceText, ScriptTarget.Latest, setParentNodes=false, scriptKind)",
    semanticBinding: false,
  });

  return Object.freeze({
    status: "ok",
    result: projectTsJsSymbolTableResult(
      request,
      parser,
      Object.freeze(symbolRecords),
      Object.freeze(boundaryRecords),
      coverage,
    ),
  });
}

export function createTsJsSymbolTableAdapter(
  options: TsJsSymbolTableAdapterOptions = {},
): Readonly<{
  symbols: (request: unknown) => Promise<TsJsSymbolTableOutcome>;
}> {
  return Object.freeze({
    symbols: (request: unknown) => runTsJsSymbolTable(request, options),
  });
}
