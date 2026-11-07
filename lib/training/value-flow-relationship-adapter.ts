// Real value-flow relationship projection adapter (Stage B).
//
// It consumes raw TypeScript source text and derives only the accepted
// relationshipProjection facts: write/read sites, call argument and parameter
// ordinals, branch/loop structure, and binding identity. It never reads gold,
// analyzer edges, A_g or future receipts. Final relation truth stays outside
// the student input.
import * as ts from "typescript";
import type {
  BindingResolutionCode,
  Observed,
  OrderFlowAndCoverageValue,
  Ref,
  RelationKind,
  RelationshipProjection,
  RoleAndOrdinalValue,
} from "./unified-encoder.js";
import {
  UNIFIED_ENCODER_VERSION,
  UNIFIED_INPUT_SCHEMA,
  encodeUnifiedCandidateGroup,
} from "./unified-encoder.js";
import {
  DEFAULT_RELATION_STEP_ID,
  relationStepContext,
  type RelationStepEpisode,
} from "./unified-step-context-builder.js";

export const VALUE_FLOW_PROJECTION_ADAPTER_ID = "value-flow-relationship-adapter.v1" as const;
export const VALUE_FLOW_PARTIAL_ORDINAL_SLICE = 1 as const;

export interface ValueFlowSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export type ValueFlowRawSiteKind = "write" | "read" | "call_arg" | "param";

export interface ValueFlowRawSite {
  readonly siteRef: Ref;
  readonly kind: ValueFlowRawSiteKind;
  readonly writeKind: "declaration" | "assignment" | null;
  readonly symbolName: string;
  readonly declRef: Ref | null;
  readonly calleeDeclRef: Ref | null;
  readonly ownerDeclRef: Ref | null;
  readonly span: ValueFlowSpan;
  readonly scopeChain: readonly string[];
  readonly conditionalKinds: readonly string[];
  readonly insideLoop: boolean;
  readonly calleeName: string | null;
  readonly ordinalIndex: number | null;
}

export interface ValueFlowControlRecord {
  readonly kind: "if" | "loop";
  readonly conditionSpan: ValueFlowSpan;
  readonly trueBranchSpan: ValueFlowSpan | null;
  readonly falseBranchSpan: ValueFlowSpan | null;
  readonly hasElse: boolean;
}

export interface ValueFlowUnsupportedSyntaxRecord {
  readonly kind: "unary_write" | "nested_if" | "try" | "switch" | "with";
  readonly reason: "increment_out_of_slice" | "control_flow_out_of_slice";
  readonly span: ValueFlowSpan;
}

export interface ValueFlowRawObservation {
  readonly relPath: string;
  readonly parseError: string | null;
  readonly sites: readonly ValueFlowRawSite[];
  readonly controlRecords: readonly ValueFlowControlRecord[];
  readonly unsupportedSyntaxRecords: readonly ValueFlowUnsupportedSyntaxRecord[];
}

export interface ValueFlowCandidateSide {
  readonly observed: boolean;
  readonly siteRef: Ref | null;
  readonly role: "write" | "read" | "argument" | "parameter" | "unknown";
  readonly ordinalIndex: number | null;
}

export interface ValueFlowCandidateCoverage {
  readonly orderObserved: boolean;
  readonly bodyObserved: boolean;
}

export interface ValueFlowRelationshipCandidate {
  readonly candidateRef: Ref;
  readonly relationKind: RelationKind;
  readonly source: ValueFlowCandidateSide;
  readonly sink: ValueFlowCandidateSide;
  readonly coverage: ValueFlowCandidateCoverage;
}

export type ValueFlowAdmissionStatus = "eligible" | "not_ready" | "unsupported";

export interface ValueFlowAdmission {
  readonly denominatorEligible: boolean;
  readonly status: ValueFlowAdmissionStatus;
  readonly reasons: readonly string[];
}

export interface ValueFlowProjectionResult {
  readonly projection: RelationshipProjection;
  readonly admission: ValueFlowAdmission;
}

export interface ValueFlowStudentEvidence {
  readonly candidateRef: Ref;
  readonly relationKind: RelationKind;
  readonly encoderVersion: string;
  readonly inputSchema: string;
  readonly xByOption: Readonly<Record<string, readonly number[]>>;
  readonly missingMode: readonly Readonly<{
    readonly block: string;
    readonly fieldRef: string;
    readonly reason: string;
    readonly slotIndex: number;
    readonly fill: number;
  }>[];
  readonly admission: ValueFlowAdmission;
}

function spanOf(sf: ts.SourceFile, node: ts.Node): ValueFlowSpan {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return Object.freeze({
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  });
}

function spanKey(span: ValueFlowSpan): string {
  return `${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`;
}

function siteRefFor(
  relPath: string,
  scopeChain: readonly string[],
  symbolName: string,
  kind: ValueFlowRawSiteKind,
  span: ValueFlowSpan,
  declRef: Ref | null,
): Ref {
  return `${relPath}#${scopeChain.join(".")}:${symbolName}@${kind}(${spanKey(span)})[decl:${declRef ?? "null"}]`;
}

function after(left: ValueFlowSpan, right: ValueFlowSpan): boolean {
  if (left.startLine !== right.startLine) return left.startLine > right.startLine;
  if (left.startColumn !== right.startColumn) return left.startColumn > right.startColumn;
  return false;
}

function before(left: ValueFlowSpan, right: ValueFlowSpan): boolean {
  if (left.startLine !== right.startLine) return left.startLine < right.startLine;
  if (left.startColumn !== right.startColumn) return left.startColumn < right.startColumn;
  return false;
}

function spanEndsAfter(left: ValueFlowSpan, right: ValueFlowSpan): boolean {
  if (left.endLine !== right.startLine) return left.endLine > right.startLine;
  if (left.endColumn !== right.startColumn) return left.endColumn > right.startColumn;
  return false;
}

function contains(outer: ValueFlowSpan | null, inner: ValueFlowSpan): boolean {
  if (outer === null) return false;
  if (outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn)) {
    if (outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn)) return true;
  }
  return false;
}

function bindingIdentifier(name: ts.BindingName): ts.Identifier | null {
  return ts.isIdentifier(name) ? name : null;
}

function parseErrorOf(sf: ts.SourceFile): string | null {
  const diagnostics = (sf as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (diagnostics.length === 0) return null;
  return diagnostics.map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return `TS${diagnostic.code}: ${message}`;
  }).join("; ");
}

function isPropertyAccessName(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined
    && (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent))
    && parent.name === node;
}

function isImportSpecifierName(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  return false;
}

function isExportSpecifierName(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined && ts.isExportSpecifier(parent) && parent.name === node;
}

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = parenthesizedParent(node.parent);
  if (parent === undefined) return false;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operand === node
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
  }
  return false;
}

function parenthesizedParent(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current !== undefined && ts.isParenthesizedExpression(current)) {
    current = current.parent;
  }
  return current;
}

function isVariableDeclarationName(node: ts.Node): boolean {
  return node.parent !== undefined
    && ts.isVariableDeclaration(node.parent)
    && bindingIdentifier(node.parent.name) === node;
}

function isParameterName(node: ts.Node): boolean {
  return node.parent !== undefined
    && ts.isParameter(node.parent)
    && bindingIdentifier(node.parent.name) === node;
}

function isFunctionName(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined
    && (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent))
    && (parent as ts.FunctionLikeDeclaration).name === node;
}

function textOf(sf: ts.SourceFile, node: ts.Node, limit = 80): string {
  const text = sf.text.slice(node.getStart(sf), node.getEnd());
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function walkSource(sourceText: string, relPath: string): ValueFlowRawObservation {
  const sf = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: ValueFlowRawSite[] = [];
  const controlRecords: ValueFlowControlRecord[] = [];
  const unsupportedSyntaxRecords: ValueFlowUnsupportedSyntaxRecord[] = [];
  const scopeStack: string[] = [];
  type LexicalScope = Readonly<{
    kind: "function" | "block";
    declarations: Map<string, Ref>;
  }>;
  const lexicalScopes: LexicalScope[] = [Object.freeze({
    kind: "block",
    declarations: new Map<string, Ref>(),
  })];
  type Frame = Readonly<{
    kinds: readonly string[];
    insideLoop: boolean;
  }>;
  const frameStack: Frame[] = [Object.freeze({ kinds: Object.freeze([]), insideLoop: false })];

  function currentLexicalScope(): LexicalScope {
    return lexicalScopes[lexicalScopes.length - 1] as LexicalScope;
  }

  function nearestFunctionScope(): LexicalScope {
    for (let index = lexicalScopes.length - 1; index >= 0; index -= 1) {
      const scope = lexicalScopes[index];
      if (scope?.kind === "function") return scope;
    }
    return lexicalScopes[0] as LexicalScope;
  }

  function declareIn(scope: LexicalScope, name: string, declRef: Ref): void {
    scope.declarations.set(name, declRef);
  }

  function resolveDecl(name: string): Ref | null {
    for (let index = lexicalScopes.length - 1; index >= 0; index -= 1) {
      const declaration = lexicalScopes[index]?.declarations.get(name);
      if (declaration !== undefined) return declaration;
    }
    return null;
  }

  function pushBlockScope(): void {
    lexicalScopes.push(Object.freeze({
      kind: "block",
      declarations: new Map<string, Ref>(),
    }));
  }

  function popBlockScope(): void {
    lexicalScopes.pop();
  }

  function conditionalKinds(): readonly string[] {
    return frameStack.flatMap(frame => frame.kinds);
  }

  function insideLoop(): boolean {
    return frameStack.some(frame => frame.insideLoop);
  }

  function addSite(input: {
    readonly kind: ValueFlowRawSiteKind;
    readonly writeKind?: "declaration" | "assignment";
    readonly symbolName: string;
    readonly declRef: Ref | null;
    readonly calleeDeclRef?: Ref | null;
    readonly ownerDeclRef?: Ref | null;
    readonly span: ValueFlowSpan;
    readonly calleeName?: string | null;
    readonly ordinalIndex?: number | null;
  }): void {
    const siteRef = siteRefFor(
      relPath,
      Object.freeze([...scopeStack]),
      input.symbolName,
      input.kind,
      input.span,
      input.declRef,
    );
    sites.push(Object.freeze({
      siteRef,
      kind: input.kind,
      writeKind: input.writeKind ?? null,
      symbolName: input.symbolName,
      declRef: input.declRef,
      calleeDeclRef: input.calleeDeclRef ?? null,
      ownerDeclRef: input.ownerDeclRef ?? null,
      span: input.span,
      scopeChain: Object.freeze([...scopeStack]),
      conditionalKinds: Object.freeze(conditionalKinds()),
      insideLoop: insideLoop(),
      calleeName: input.calleeName ?? null,
      ordinalIndex: input.ordinalIndex ?? null,
    }));
  }

  function declarationRefFor(name: string, span: ValueFlowSpan): Ref {
    return `${relPath}#${name}@decl(${spanKey(span)})`;
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isConstructorDeclaration(node)) {
      const nameNode = (node as ts.FunctionLikeDeclaration).name;
      let ownerDeclRef: Ref | null = null;
      if (nameNode !== undefined && ts.isIdentifier(nameNode)) {
        const nameSpan = spanOf(sf, nameNode);
        ownerDeclRef = declarationRefFor(nameNode.text, nameSpan);
        if (ts.isFunctionDeclaration(node)) {
          declareIn(currentLexicalScope(), nameNode.text, ownerDeclRef);
        }
      }
      if (nameNode !== undefined && ts.isIdentifier(nameNode)) {
        scopeStack.push(nameNode.text);
      } else {
        scopeStack.push(`<anon:${spanKey(spanOf(sf, node))}>`);
      }
      const functionScope: LexicalScope = Object.freeze({
        kind: "function",
        declarations: new Map<string, Ref>(),
      });
      lexicalScopes.push(functionScope);
      if (ownerDeclRef !== null && nameNode !== undefined && ts.isIdentifier(nameNode)
        && !ts.isFunctionDeclaration(node)) {
        declareIn(functionScope, nameNode.text, ownerDeclRef);
      }
      const parameters = (node as ts.FunctionLikeDeclaration).parameters;
      parameters.forEach((param, ordinalIndex) => {
        const identifier = bindingIdentifier(param.name);
        if (identifier === null) return;
        const span = spanOf(sf, identifier);
        const declRef = declarationRefFor(identifier.text, span);
        declareIn(functionScope, identifier.text, declRef);
        addSite({
          kind: "param",
          symbolName: identifier.text,
          declRef,
          ownerDeclRef,
          span,
          ordinalIndex,
        });
      });
      ts.forEachChild(node, visit);
      lexicalScopes.pop();
      scopeStack.pop();
      return;
    }

    if (ts.isBlock(node)) {
      pushBlockScope();
      ts.forEachChild(node, visit);
      popBlockScope();
      return;
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        unsupportedSyntaxRecords.push(Object.freeze({
          kind: "unary_write",
          reason: "increment_out_of_slice",
          span: spanOf(sf, node),
        }));
      }
    }

    if (ts.isTryStatement(node)) {
      unsupportedSyntaxRecords.push(Object.freeze({
        kind: "try",
        reason: "control_flow_out_of_slice",
        span: spanOf(sf, node),
      }));
    } else if (ts.isSwitchStatement(node)) {
      unsupportedSyntaxRecords.push(Object.freeze({
        kind: "switch",
        reason: "control_flow_out_of_slice",
        span: spanOf(sf, node),
      }));
    } else if (ts.isWithStatement(node)) {
      unsupportedSyntaxRecords.push(Object.freeze({
        kind: "with",
        reason: "control_flow_out_of_slice",
        span: spanOf(sf, node),
      }));
    }

    if (ts.isVariableDeclaration(node)) {
      const identifier = bindingIdentifier(node.name);
      if (identifier !== null) {
        const declSpan = spanOf(sf, identifier);
        const declRef = declarationRefFor(identifier.text, declSpan);
        const declarationList = node.parent;
        const blockScoped = ts.isVariableDeclarationList(declarationList)
          && (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
        declareIn(blockScoped ? currentLexicalScope() : nearestFunctionScope(), identifier.text, declRef);
        addSite({
          kind: "write",
          writeKind: "declaration",
          symbolName: identifier.text,
          declRef,
          span: declSpan,
        });
      }
    } else if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken)
      && ts.isIdentifier(node.left)) {
      const declRef = resolveDecl(node.left.text);
      if (declRef !== null) {
        addSite({
          kind: "write",
          writeKind: "assignment",
          symbolName: node.left.text,
          declRef,
          span: spanOf(sf, node.left),
        });
      }
    } else if (ts.isCallExpression(node)) {
      const calleeExpression = node.expression;
      if (!ts.isIdentifier(calleeExpression)) {
        ts.forEachChild(node, visit);
        return;
      }
      const calleeDeclRef = resolveDecl(calleeExpression.text);
      node.arguments.forEach((argument, ordinalIndex) => {
        addSite({
          kind: "call_arg",
          symbolName: sf.text.slice(argument.getStart(sf), argument.getEnd()).slice(0, 80),
          declRef: null,
          calleeDeclRef,
          span: spanOf(sf, argument),
          calleeName: calleeExpression.text,
          ordinalIndex,
        });
      });
    }

    if (ts.isIfStatement(node)) {
      if (frameStack.some(frame => frame.kinds.some(kind => kind === "if_true" || kind === "if_false"))) {
        unsupportedSyntaxRecords.push(Object.freeze({
          kind: "nested_if",
          reason: "control_flow_out_of_slice",
          span: spanOf(sf, node),
        }));
      }
      const conditionSpan = spanOf(sf, node.expression);
      const trueBranchSpan = spanOf(sf, node.thenStatement);
      const falseBranchSpan = node.elseStatement === undefined ? null : spanOf(sf, node.elseStatement);
      controlRecords.push(Object.freeze({
        kind: "if",
        conditionSpan,
        trueBranchSpan,
        falseBranchSpan,
        hasElse: node.elseStatement !== undefined,
      }));
      frameStack.push(Object.freeze({ kinds: Object.freeze(["if_true"]), insideLoop: insideLoop() }));
      visit(node.thenStatement);
      frameStack.pop();
      if (node.elseStatement !== undefined) {
        frameStack.push(Object.freeze({ kinds: Object.freeze(["if_false"]), insideLoop: insideLoop() }));
        visit(node.elseStatement);
        frameStack.pop();
      }
      return;
    }

    if (ts.isWhileStatement(node) || ts.isDoStatement(node)
      || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const body = node.statement;
      const bodySpan = spanOf(sf, body);
      controlRecords.push(Object.freeze({
        kind: "loop",
        conditionSpan: spanOf(sf, node),
        trueBranchSpan: bodySpan,
        falseBranchSpan: null,
        hasElse: false,
      }));
      frameStack.push(Object.freeze({ kinds: Object.freeze(["loop_body"]), insideLoop: true }));
      visit(body);
      frameStack.pop();
      return;
    }

    if (ts.isIdentifier(node)) {
      const declRef = resolveDecl(node.text);
      const isRead =
        declRef !== null
        && !isPropertyAccessName(node)
        && !isImportSpecifierName(node)
        && !isExportSpecifierName(node)
        && !isAssignmentTarget(node)
        && !isVariableDeclarationName(node)
        && !isParameterName(node)
        && !isFunctionName(node);
      if (isRead) {
        addSite({
          kind: "read",
          symbolName: node.text,
          declRef,
          span: spanOf(sf, node),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  const unique = [...new Map(sites.map(site => [site.siteRef, site] as const)).values()];
  return Object.freeze({
    relPath,
    parseError: parseErrorOf(sf),
    sites: Object.freeze(unique),
    controlRecords: Object.freeze(controlRecords),
    unsupportedSyntaxRecords: Object.freeze(unsupportedSyntaxRecords),
  });
}

export function observeValueFlowSource(input: Readonly<{
  relPath: string;
  sourceText: string;
}>): ValueFlowRawObservation {
  return walkSource(input.sourceText, input.relPath);
}

function siteByRef(observation: ValueFlowRawObservation, siteRef: Ref | null): ValueFlowRawSite | null {
  if (siteRef === null) return null;
  return observation.sites.find(site => site.siteRef === siteRef) ?? null;
}

function observedSide(side: ValueFlowCandidateSide): boolean {
  return side.observed && side.siteRef !== null;
}

export function enumerateValueFlowCandidates(
  observation: ValueFlowRawObservation,
): readonly ValueFlowRelationshipCandidate[] {
  const writes = observation.sites.filter(site => site.kind === "write");
  const reads = observation.sites.filter(site => site.kind === "read");
  const calls = observation.sites.filter(site => site.kind === "call_arg");
  const params = observation.sites.filter(site => site.kind === "param");
  const candidates: ValueFlowRelationshipCandidate[] = [];
  for (const write of writes) {
    for (const read of reads) {
      if (write.declRef === null || write.declRef !== read.declRef) continue;
      if (!after(read.span, write.span)) continue;
      candidates.push(Object.freeze({
        candidateRef: `cand:${write.siteRef}->${read.siteRef}`,
        relationKind: "reaching_def",
        source: Object.freeze({ observed: true, siteRef: write.siteRef, role: "write", ordinalIndex: null }),
        sink: Object.freeze({ observed: true, siteRef: read.siteRef, role: "read", ordinalIndex: null }),
        coverage: Object.freeze({ orderObserved: true, bodyObserved: true }),
      }));
    }
  }
  for (const call of calls) {
    if (call.ordinalIndex === null) continue;
    for (const param of params) {
      if (param.ordinalIndex === null) continue;
      candidates.push(Object.freeze({
        candidateRef: `cand:${call.siteRef}->${param.siteRef}`,
        relationKind: "arg_to_param",
        source: Object.freeze({
          observed: true,
          siteRef: call.siteRef,
          role: "argument",
          ordinalIndex: call.ordinalIndex,
        }),
        sink: Object.freeze({
          observed: true,
          siteRef: param.siteRef,
          role: "parameter",
          ordinalIndex: param.ordinalIndex,
        }),
        coverage: Object.freeze({ orderObserved: true, bodyObserved: true }),
      }));
    }
  }
  return Object.freeze(candidates);
}

function known<T>(value: T, evidenceRefs: readonly string[]): Observed<T> {
  return Object.freeze({ state: "known", value, evidenceRefs });
}

function missing(evidenceRefs: readonly string[], reason = "not_requested"): Observed<never> {
  return Object.freeze({ state: "not_observed", reason, evidenceRefs }) as Observed<never>;
}

function observationFailed(evidenceRefs: readonly string[]): Observed<never> {
  return Object.freeze({
    state: "missing",
    reason: "observation_failed",
    evidenceRefs,
  }) as Observed<never>;
}

function unsupportedNoValue(evidenceRefs: readonly string[]): Observed<never> {
  return Object.freeze({
    state: "unsupported",
    reason: "unsupported_pattern",
    evidenceRefs,
  }) as Observed<never>;
}

function unsupportedWithValue<T>(value: T, evidenceRefs: readonly string[]): Observed<T> {
  return Object.freeze({
    state: "unsupported",
    reason: "unsupported_pattern",
    value,
    evidenceRefs,
  });
}

function roleValue(role: ValueFlowCandidateSide["role"], ordinalIndex: number | null): RoleAndOrdinalValue {
  const roleIndex = role === "write" || role === "read"
    ? 1
    : role === "argument" || role === "parameter"
      ? 2
      : 0;
  return Object.freeze({ roleIndex, ordinalIndex: ordinalIndex ?? 0 });
}

function ordinalOutOfSlice(side: ValueFlowCandidateSide): boolean {
  return side.ordinalIndex !== null && side.ordinalIndex > VALUE_FLOW_PARTIAL_ORDINAL_SLICE;
}

interface InterveningWrite {
  readonly siteRef: Ref;
  readonly symbolName: string;
  readonly span: ValueFlowSpan;
  readonly conditionalKinds: readonly string[];
}

function interveningWrites(
  observation: ValueFlowRawObservation,
  sourceDeclRef: Ref,
  sourceSpan: ValueFlowSpan,
  sinkSpan: ValueFlowSpan,
  predicate: (declRef: Ref) => boolean,
): readonly InterveningWrite[] {
  return Object.freeze(observation.sites
    .filter(site => site.kind === "write")
    .filter(site => site.writeKind === "assignment")
    .filter((site): site is ValueFlowRawSite & { readonly declRef: Ref } => site.declRef !== null)
    .filter(site => after(site.span, sourceSpan) && before(site.span, sinkSpan))
    .filter(site => predicate(site.declRef))
    .sort((left, right) => {
      if (left.span.startLine !== right.span.startLine) return left.span.startLine - right.span.startLine;
      return left.span.startColumn - right.span.startColumn;
    })
    .map(site => Object.freeze({
      siteRef: site.siteRef,
      symbolName: site.symbolName,
      span: site.span,
      conditionalKinds: site.conditionalKinds,
    })));
}

interface BranchCount {
  readonly writeBranches: number;
  readonly feasibleBranches: number;
  readonly decided: boolean;
}

function branchCoverage(
  observation: ValueFlowRawObservation,
  writes: readonly InterveningWrite[],
): BranchCount {
  const ifs = observation.controlRecords.filter(record => record.kind === "if");
  const relevant = ifs.filter(record =>
    writes.some(write => contains(record.trueBranchSpan, write.span)
      || contains(record.falseBranchSpan, write.span)));
  if (relevant.length !== 1) {
    return Object.freeze({ writeBranches: 0, feasibleBranches: 0, decided: false });
  }
  const record = relevant[0] as ValueFlowControlRecord;
  const trueHas = writes.some(write => contains(record.trueBranchSpan, write.span));
  const falseHas = record.hasElse
    ? writes.some(write => contains(record.falseBranchSpan, write.span))
    : false;
  const writeBranches = (trueHas ? 1 : 0) + (falseHas ? 1 : 0);
  const feasibleBranches = 2;
  return Object.freeze({ writeBranches, feasibleBranches, decided: true });
}

function loopFlowUnsupported(
  observation: ValueFlowRawObservation,
  sourceSpan: ValueFlowSpan,
  sinkSpan: ValueFlowSpan,
  sourceDeclRef: Ref,
): boolean {
  return observation.controlRecords.some(record => {
    if (record.kind !== "loop") return false;
    if (!after(record.conditionSpan, sourceSpan) || !before(record.conditionSpan, sinkSpan)) return false;
    return observation.sites.some(site =>
      site.kind === "write"
      && site.declRef === sourceDeclRef
      && contains(record.trueBranchSpan, site.span));
  });
}

function orderFlowForReachingDef(
  observation: ValueFlowRawObservation,
  candidate: ValueFlowRelationshipCandidate,
  source: ValueFlowRawSite,
  sink: ValueFlowRawSite,
): Readonly<{
  readonly value: OrderFlowAndCoverageValue;
  readonly unsupported: boolean;
  readonly reasons: readonly string[];
}> {
  const flowReason = unsupportedFlowReason(observation, source, sink);
  if (flowReason !== null) {
    return Object.freeze({
      value: Object.freeze({ orderFlowIndex: 0, coverageIndex: 2 }),
      unsupported: true,
      reasons: Object.freeze([flowReason]),
    });
  }
  const sourceDeclRef = source.declRef as Ref;
  const same = interveningWrites(
    observation,
    sourceDeclRef,
    source.span,
    sink.span,
    declRef => declRef === sourceDeclRef,
  );
  const other = interveningWrites(
    observation,
    sourceDeclRef,
    source.span,
    sink.span,
    declRef => declRef !== sourceDeclRef,
  );
  let orderFlowIndex = 0;
  if (!candidate.coverage.orderObserved) {
    orderFlowIndex = 0;
  } else if (same.length === 0) {
    if (other.length === 0) {
      orderFlowIndex = 1;
    } else if (other.every(write => write.conditionalKinds.length === 0)) {
      orderFlowIndex = 4;
    } else if (other.every(write => write.conditionalKinds.length > 0)) {
      orderFlowIndex = 5;
    } else {
      orderFlowIndex = 0;
    }
  } else {
    const unconditional = same.filter(write => write.conditionalKinds.length === 0);
    const conditional = same.filter(write => write.conditionalKinds.length > 0);
    if (unconditional.length > 0 && conditional.length === 0) {
      orderFlowIndex = 2;
    } else if (unconditional.length === 0 && conditional.length === 1) {
      orderFlowIndex = 3;
    } else if (unconditional.length > 0 && conditional.length > 0) {
      const firstConditional = same.findIndex(write => write.conditionalKinds.length > 0);
      const uncondBefore = same.slice(0, firstConditional).every(write => write.conditionalKinds.length === 0);
      const condAfter = same.slice(firstConditional).every(write => write.conditionalKinds.length > 0);
      orderFlowIndex = uncondBefore && condAfter ? 6 : 0;
    } else if (conditional.length >= 2) {
      const branch = branchCoverage(observation, conditional);
      if (branch.decided && branch.writeBranches === branch.feasibleBranches) {
        orderFlowIndex = 8;
      } else if (branch.decided && branch.writeBranches === 1) {
        orderFlowIndex = 9;
      } else {
        orderFlowIndex = 0;
      }
    }
  }
  const coverageIndex = candidate.coverage.orderObserved && candidate.coverage.bodyObserved ? 2 : 0;
  return Object.freeze({
    value: Object.freeze({ orderFlowIndex, coverageIndex }),
    unsupported: false,
    reasons: Object.freeze([]),
  });
}

function unsupportedFlowReason(
  observation: ValueFlowRawObservation,
  source: ValueFlowRawSite | null,
  sink: ValueFlowRawSite | null,
): string | null {
  if (source === null || sink === null) return null;
  const syntaxRecord = observation.unsupportedSyntaxRecords.find(record =>
    before(record.span, sink.span) && spanEndsAfter(record.span, source.span));
  if (syntaxRecord !== undefined) return syntaxRecord.reason;
  if (source.declRef !== null && loopFlowUnsupported(observation, source.span, sink.span, source.declRef)) {
    return "control_flow_out_of_slice";
  }
  return null;
}

function bindingForArgToParam(
  observation: ValueFlowRawObservation,
  candidate: ValueFlowRelationshipCandidate,
  source: ValueFlowRawSite | null,
  sink: ValueFlowRawSite | null,
): BindingResolutionCode {
  if (!observedSide(candidate.source) || !observedSide(candidate.sink)) return "unresolved";
  const calleeDeclRef = source?.calleeDeclRef ?? null;
  const paramOwnerDeclRef = sink?.ownerDeclRef ?? null;
  if (calleeDeclRef === null || paramOwnerDeclRef === null) return "unresolved";
  return calleeDeclRef === paramOwnerDeclRef ? "same_callee" : "different_callee";
}

export function projectValueFlowRelationship(
  candidate: ValueFlowRelationshipCandidate,
  observation: ValueFlowRawObservation,
): ValueFlowProjectionResult {
  const evidenceRefs = Object.freeze([`ev:${candidate.candidateRef}`]);
  const source = siteByRef(observation, candidate.source.siteRef);
  const sink = siteByRef(observation, candidate.sink.siteRef);
  const reasons: string[] = [];
  let status: ValueFlowAdmissionStatus = "eligible";
  let denominatorEligible = true;

  if (observation.parseError !== null) {
    reasons.push("observation_failed");
    status = "not_ready";
  } else if (ordinalOutOfSlice(candidate.source) || ordinalOutOfSlice(candidate.sink)) {
    reasons.push("ordinal_out_of_slice");
    denominatorEligible = false;
    status = "unsupported";
  }
  if (source !== null && sink !== null
    && !observation.parseError) {
    const flowReason = unsupportedFlowReason(observation, source, sink);
    if (flowReason !== null) {
      reasons.push(flowReason);
      denominatorEligible = false;
      status = "unsupported";
    }
  }
  if (observation.parseError === null
    && (!candidate.coverage.orderObserved || !candidate.coverage.bodyObserved)) {
    if (status === "eligible") status = "not_ready";
    if (!candidate.coverage.orderObserved) reasons.push("order_flow_not_observed");
    if (!candidate.coverage.bodyObserved) reasons.push("branch_body_not_observed");
  }

  const relationKind = candidate.relationKind;
  const bindingResolution = relationKind === "arg_to_param"
    ? bindingForArgToParam(observation, candidate, source, sink)
    : "not_applicable";

  let orderFlow: Observed<OrderFlowAndCoverageValue>;
  if (observation.parseError !== null) {
    orderFlow = observationFailed(evidenceRefs);
  } else if (relationKind === "arg_to_param") {
    const coverageIndex = candidate.coverage.orderObserved && candidate.coverage.bodyObserved ? 2 : 0;
    orderFlow = known(Object.freeze({ orderFlowIndex: 7, coverageIndex }), evidenceRefs);
  } else if (source !== null && sink !== null) {
    const order = orderFlowForReachingDef(observation, candidate, source, sink);
    orderFlow = order.unsupported
      ? unsupportedWithValue(order.value, evidenceRefs)
      : known(order.value, evidenceRefs);
  } else {
    orderFlow = missing(evidenceRefs);
  }

  const sourceRole = ordinalOutOfSlice(candidate.source)
    ? unsupportedNoValue(evidenceRefs)
    : observedSide(candidate.source)
      ? known(roleValue(candidate.source.role, candidate.source.ordinalIndex), evidenceRefs)
      : known(roleValue("unknown", null), evidenceRefs);
  const sinkRole = ordinalOutOfSlice(candidate.sink)
    ? unsupportedNoValue(evidenceRefs)
    : observedSide(candidate.sink)
      ? known(roleValue(candidate.sink.role, candidate.sink.ordinalIndex), evidenceRefs)
      : known(roleValue("unknown", null), evidenceRefs);

  const projection: RelationshipProjection = Object.freeze({
    relationKind: known(relationKind, evidenceRefs),
    sourceSiteRef: observedSide(candidate.source) ? known(candidate.source.siteRef as Ref, evidenceRefs) : missing(evidenceRefs),
    sinkSiteRef: observedSide(candidate.sink) ? known(candidate.sink.siteRef as Ref, evidenceRefs) : missing(evidenceRefs),
    sourceRoleAndOrdinal: sourceRole,
    sinkRoleAndOrdinal: sinkRole,
    orderFlowAndCoverage: orderFlow,
    bindingResolution: known(bindingResolution, evidenceRefs),
    evidenceRefs,
  });

  return Object.freeze({
    projection,
    admission: Object.freeze({
      denominatorEligible,
      status,
      reasons: Object.freeze(reasons),
    }),
  });
}

export function encodeValueFlowRelationshipStudent(
  candidate: ValueFlowRelationshipCandidate,
  observation: ValueFlowRawObservation,
): ValueFlowStudentEvidence {
  const result = projectValueFlowRelationship(candidate, observation);
  const evidenceRefs = result.projection.evidenceRefs;
  const failureMode = result.admission.status === "eligible"
    ? null
    : result.admission.reasons.join(",");
  const episode: RelationStepEpisode = Object.freeze({
    sampleId: candidate.candidateRef,
    stepId: DEFAULT_RELATION_STEP_ID,
    requestId: "req:value-flow-relationship-adapter",
    sourceGroup: "value-flow-relationship-adapter",
    language: "ts",
    semanticStratum: "value_flow",
    partition: "dev",
    entryFile: observation.relPath,
    targetRef: candidate.candidateRef,
    observedFacts: Object.freeze([
      `relation:${candidate.relationKind}`,
      `source:${candidate.source.siteRef ?? "unresolved"}`,
      `sink:${candidate.sink.siteRef ?? "unresolved"}`,
    ]),
    pendingRelationRef: candidate.candidateRef,
    relationshipProjection: result.projection,
    evidenceRefs,
    failureMode,
    derivationFamily: "value-flow-relationship-adapter",
    adapterRef: VALUE_FLOW_PROJECTION_ADAPTER_ID,
  });
  const context = relationStepContext(episode);
  const encoded = encodeUnifiedCandidateGroup(context);
  const xByOption: Record<string, readonly number[]> = {};
  const missingMode: (ValueFlowStudentEvidence["missingMode"][number])[] = [];
  context.candidateGroup.candidates.forEach((candidateItem, index) => {
    const item = encoded[index];
    if (item === undefined) throw new TypeError(`encoder missing candidate ${candidateItem.candidateRef}`);
    xByOption[candidateItem.optionSemantics] = item.vector;
    if (candidateItem.optionSemantics === "judge=unknown") {
      missingMode.push(...item.missingMode.map(entry => Object.freeze({ ...entry })));
    }
  });
  return Object.freeze({
    candidateRef: candidate.candidateRef,
    relationKind: candidate.relationKind,
    encoderVersion: UNIFIED_ENCODER_VERSION,
    inputSchema: UNIFIED_INPUT_SCHEMA,
    xByOption: Object.freeze(xByOption),
    missingMode: Object.freeze(missingMode),
    admission: result.admission,
  });
}
