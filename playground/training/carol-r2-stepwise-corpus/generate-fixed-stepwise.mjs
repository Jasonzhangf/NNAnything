#!/usr/bin/env node
// Fixed local-step corpus generator for the accepted TS/JS r2 mapping contract.
//
// Student generation reads source metadata, the explicit request shell and one
// current module at a time. Gold, A_g, teacher material and terminal oracle
// evidence are consumed only by the independent supervision path.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const TS_PATH =
  process.env.NNANYTHING_TYPESCRIPT_PATH ??
  "/Volumes/extension/code/NNAnything/node_modules/typescript/lib/typescript.js";
const ts = require(TS_PATH);

export const DEFAULT_CORPUS_ROOT =
  "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/corpus";
export const DEFAULT_OUTPUT_DIR =
  "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/carol-tsjs-r2-stepwise-corpus-20261106/output";
export const DEFAULT_TYPED_REQUEST_SOURCE =
  "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-typed-observation-corpus-r1/student-observations.jsonl";
export const DEFAULT_SUPERVISION_SOURCE =
  "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-typed-observation-corpus-r1/independent-supervision.jsonl";
export const DEFAULT_OLD_DEV_REQUEST_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tsjs-dev-closure-shadow-b.requests.json",
);
export const OLD_DEV_CONTROL_RECEIPTS_SCHEMA =
  "carol-tsjs-old-dev-stepwise-control-receipts-v1";

const STUDENT_SCHEMA = "carol-tsjs-fixed-stepwise-student-v1";
const SUPERVISION_SCHEMA = "carol-tsjs-fixed-stepwise-supervision-v1";
const FAMILY_ADMISSIONS_SCHEMA =
  "nnanything.tsjs.request-aware-admission.family-admissions.v1";
const JUDGES = ["c:judge:true", "c:judge:false", "c:judge:unknown"];
const RETURN = "c:return";
const DEFER = "c:defer";
const OBSERVE_ENTRY_FOLD = "observe:entry-fold";
const OBSERVE_REGISTRY = "observe:registry";

// Student-side episode fields. Supervision-only material (gold, A_g, S_g,
// teacher, oracle, admission, terminal answer) is never part of a student
// input object; it is loaded and joined on the supervision path only.
const STUDENT_EPISODE_KEYS = [
  "sampleId",
  "sourceGroup",
  "partition",
  "language",
  "semanticStratum",
  "entryFile",
  "entrySymbol",
  "requestId",
  "scopePaths",
  "maxDepth",
];
const SUPERVISION_ONLY_KEYS = [
  "A_g",
  "S_g",
  "gold",
  "oracle",
  "teacher",
  "terminalDeclaration",
  "terminalDeclarationRef",
  "allowedEquivalentLabels",
  "labelAuthority",
  "labelMissing",
  "unknownReason",
  "originalLabel",
  "originalUnknownReason",
  "headSupervision",
  "admission",
  "supersededBy",
  "candidateSet",
  "candidateEnumerationAdmission",
  "candidateEnumerationSupersededBy",
  "executionReceiptRef",
  "teacherProposalRef",
  "oracleRef",
  "candidateSetRef",
  "postStateRef",
  "trainingEligible",
  "notReadyReason",
  "conflicts",
];

function pickStudentEpisode(episode) {
  const studentEpisode = {};
  for (const key of STUDENT_EPISODE_KEYS) {
    if (episode[key] !== undefined) studentEpisode[key] = episode[key];
  }
  studentEpisode.goal = {
    kind: episode.goal?.kind ?? null,
    targetRef: episode.goal?.targetRef ?? null,
  };
  return studentEpisode;
}

function containsSupervisionOnlyKeys(value, seen = new Set()) {
  if (Array.isArray(value)) return value.some((item) => containsSupervisionOnlyKeys(item, seen));
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, inner] of Object.entries(value)) {
    if (SUPERVISION_ONLY_KEYS.includes(key)) return true;
    if (
      typeof inner === "string" &&
      /manual-structural-proof|oracle-receipt|tsc-receipt|dynamic-label-correction|teacher-only/i.test(inner)
    ) {
      return true;
    }
    if (containsSupervisionOnlyKeys(inner, seen)) return true;
  }
  return false;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function moduleRef(root, file) {
  return `mod:${rel(root, file)}`;
}

function evidenceRef(root, file, suffix = "read") {
  return `ev:${rel(root, file)}:${suffix}`;
}

function known(value, evidenceRefs = []) {
  return { state: "known", value, reason: null, evidenceRefs };
}

function missing(reason, evidenceRefs = []) {
  return { state: "missing", value: undefined, reason, evidenceRefs };
}

function observed(value, evidenceRefs = []) {
  return { state: "known", value, evidenceRefs };
}

function notObserved(reason, evidenceRefs = []) {
  return { state: "not_observed", value: undefined, reason, evidenceRefs };
}

function lineCol(sourceFile, node) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      if (current.name?.text) return current.name.text;
      if (ts.isFunctionExpression(current)) return "function-expression";
      if (ts.isArrowFunction(current)) return "arrow";
    }
    current = current.parent;
  }
  return null;
}

function declarationName(node) {
  if (node.name?.text) return node.name.text;
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  return null;
}

function declarationKind(node) {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isVariableDeclaration(node)) {
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return "function";
    }
    return "value";
  }
  if (ts.isParameter(node)) return "value";
  return "unknown";
}

function declarationRef(root, node, roleOverride = null) {
  const sf = node.getSourceFile();
  const scope = enclosingFunctionName(node) ?? "top";
  const name = declarationName(node) ?? "anon";
  return {
    declarationRef: `decl:${rel(root, sf.fileName)}#${scope}:${name}`,
    moduleRef: moduleRef(root, sf.fileName),
    name,
    role: roleOverride ?? (hasModifier(node, ts.SyntaxKind.ExportKeyword) ? "export" : "local"),
    kind: declarationKind(node),
    sourceLocation: { file: rel(root, sf.fileName), ...lineCol(sf, node) },
    evidenceRefs: [evidenceRef(root, sf.fileName, "read")],
  };
}

function directStatementDeclarations(statements) {
  const result = [];
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (declarationName(statement)) result.push(statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) result.push(declaration);
      }
      continue;
    }
    if (ts.isVariableDeclaration(statement) && ts.isIdentifier(statement.name)) {
      result.push(statement);
    }
  }
  return result;
}

function declarationsInScope(scope, name) {
  const candidates = [];
  if (ts.isSourceFile(scope)) {
    for (const declaration of directStatementDeclarations(scope.statements)) {
      if (declarationName(declaration) === name) candidates.push(declaration);
    }
    return candidates;
  }
  if (isFunctionLike(scope)) {
    for (const parameter of scope.parameters ?? []) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) candidates.push(parameter);
    }
    const body = scope.body;
    if (body) {
      const statements = ts.isBlock(body) ? body.statements : [];
      for (const declaration of directStatementDeclarations(statements)) {
        if (declarationName(declaration) === name) candidates.push(declaration);
      }
    }
  }
  return candidates;
}

function resolveLocalIdentifier(identifier) {
  let current = identifier.parent;
  while (current) {
    if (ts.isSourceFile(current) || isFunctionLike(current)) {
      const candidates = declarationsInScope(current, identifier.text);
      if (candidates.length > 0) return { scope: current, candidates };
    }
    current = current.parent;
  }
  return { scope: null, candidates: [] };
}

function findTopDeclaration(sourceFile, name) {
  return directStatementDeclarations(sourceFile.statements).find(
    (declaration) => declarationName(declaration) === name,
  ) ?? null;
}

function findFunction(sourceFile, name) {
  return sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  ) ?? null;
}

function collectCalls(node) {
  const calls = [];
  const visit = (current) => {
    if (ts.isCallExpression(current)) calls.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function foldStringLiteral(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringLiteral(node.left);
    const right = foldStringLiteral(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function resolveRelativeModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseModule(root, file) {
  const text = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const importBindings = [];
  const reexports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name) {
        importBindings.push({
          sourceName: "default",
          targetName: clause.name.text,
          specifier,
          node: clause.name,
        });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          importBindings.push({
            sourceName: (element.propertyName ?? element.name).text,
            targetName: element.name.text,
            specifier,
            node: element.name,
          });
        }
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        importBindings.push({
          sourceName: "*",
          targetName: clause.namedBindings.name.text,
          specifier,
          node: clause.namedBindings.name,
          unsupported: true,
        });
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        reexports.push({
          sourceName: (element.propertyName ?? element.name).text,
          targetName: element.name.text,
          specifier: statement.moduleSpecifier.text,
          node: element.name,
        });
      }
    }
  }
  const declarations = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node)
    ) {
      if (declarationName(node)) declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    file,
    rel: rel(root, file),
    text,
    sourceFile,
    importBindings,
    reexports,
    declarations,
    calls: collectCalls(sourceFile),
  };
}

function astObservation(root, parsed) {
  return {
    file: parsed.rel,
    importCount: parsed.importBindings.length,
    reexportCount: parsed.reexports.length,
    declarationCount: parsed.declarations.filter((node) => !ts.isParameter(node)).length,
    callCount: parsed.calls.length,
    evidenceRef: evidenceRef(root, parsed.file, "read"),
  };
}

function sourceEdge(root, parsed, binding, index) {
  const ev = evidenceRef(root, parsed.file, `import:${index}`);
  const target = resolveRelativeModule(parsed.file, binding.specifier);
  const targetModule = target
    ? known(moduleRef(root, target), [ev])
    : missing("observation_failed", [ev]);
  return {
    edgeRef: `edge:${parsed.rel}:import:${index}`,
    callSiteRef: null,
    fromNodeRef: `syntax:${parsed.rel}:import:${index}`,
    edgeKind: "import",
    sourceName: binding.sourceName,
    sourceModule: targetModule,
    targetName: binding.targetName,
    targetModule: known(moduleRef(root, parsed.file), [ev]),
    moduleSpecifierRaw: binding.specifier,
    sourceContent: { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: [ev] },
    visibility: target
      ? known("reachable", [ev])
      : notObserved("observation_failed", [ev]),
    hopDepth: 0,
    evidenceRefs: [ev],
  };
}

function reexportEdge(root, parsed, binding, index, hopDepth) {
  const ev = evidenceRef(root, parsed.file, `reexport:${index}`);
  const target = resolveRelativeModule(parsed.file, binding.specifier);
  const targetModule = target
    ? known(moduleRef(root, target), [ev])
    : missing("observation_failed", [ev]);
  return {
    edgeRef: `edge:${parsed.rel}:reexport:${index}`,
    callSiteRef: null,
    fromNodeRef: `syntax:${parsed.rel}:reexport:${index}`,
    edgeKind: "re_export",
    sourceName: binding.sourceName,
    sourceModule: targetModule,
    targetName: binding.targetName,
    targetModule: known(moduleRef(root, parsed.file), [ev]),
    moduleSpecifierRaw: binding.specifier,
    sourceContent: { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: [ev] },
    visibility: target
      ? known("reachable", [ev])
      : notObserved("observation_failed", [ev]),
    hopDepth,
    evidenceRefs: [ev],
  };
}

function importEdges(root, parsed) {
  return parsed.importBindings
    .filter((binding) => !binding.unsupported)
    .map((binding, index) => sourceEdge(root, parsed, binding, index));
}

function reexportEdges(root, parsed, hopDepth) {
  return parsed.reexports.map((binding, index) =>
    reexportEdge(root, parsed, binding, index, hopDepth),
  );
}

function parseEvidenceRef(root, parsed) {
  return evidenceRef(root, parsed.file, "read");
}

function readActionResult(
  sampleId,
  label,
  fromStepId,
  root,
  file,
  pendingRelationRef,
  optionSemantics = "observe",
) {
  const actionRef = `action:${sampleId}:${label}`;
  const receiptRef = `receipt:${sampleId}:${label}`;
  const targetRef = moduleRef(root, file);
  const evidence = evidenceRef(root, file, "read");
  try {
    const parsed = parseModule(root, file);
    const receipt = {
      receiptRef,
      actionRef,
      action: "read_source",
      origin: "source_observation",
      targetRef,
      fromStepId,
      pendingRelationRef,
      resultRefs: [evidence],
      outcome: "success",
      textLength: parsed.text.length,
      lineCount: parsed.text.split("\n").length,
      evidenceRefs: [evidence],
    };
    return {
      parsed,
      actionRef,
      receiptRef,
      receipt,
      previousExecution: observed(
        {
          actionRef,
          receiptRef,
          origin: "source_observation",
          fromStepId,
          pendingRelationRef,
          optionSemantics,
          targetRef,
          outcome: "success",
        },
        [evidence],
      ),
      actualRead: {
        sampleId,
        actionRef,
        receiptRef,
        fromStepId,
        file: rel(root, file),
        outcome: "success",
        textLength: parsed.text.length,
        lineCount: parsed.text.split("\n").length,
      },
    };
  } catch (error) {
    const receipt = {
      receiptRef,
      actionRef,
      action: "read_source",
      origin: "source_observation",
      targetRef,
      fromStepId,
      pendingRelationRef,
      resultRefs: [],
      outcome: "failed",
      errorCode: error?.code ?? "READ_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      evidenceRefs: [evidence],
    };
    return {
      parsed: null,
      actionRef,
      receiptRef,
      receipt,
      previousExecution: observed(
        {
          actionRef,
          receiptRef,
          origin: "source_observation",
          fromStepId,
          pendingRelationRef,
          optionSemantics,
          targetRef,
          outcome: "failed",
        },
        [evidence],
      ),
      actualRead: {
        sampleId,
        actionRef,
        receiptRef,
        fromStepId,
        file: rel(root, file),
        outcome: "failed",
        errorCode: error?.code ?? "READ_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function advanceActionResult(sampleId, label, fromStepId, fromEdgeRef, root, parsed) {
  const actionRef = `action:${sampleId}:${label}`;
  const receiptRef = `receipt:${sampleId}:${label}`;
  const evidence = parseEvidenceRef(root, parsed);
  return {
    actionRef,
    receiptRef,
    receipt: {
      receiptRef,
      actionRef,
      action: "advance",
      origin: "source_observation",
      targetRef: fromEdgeRef,
      fromStepId,
      resultRefs: [],
      outcome: "success",
      evidenceRefs: [evidence],
    },
    previousExecution: observed(
      {
        actionRef,
        receiptRef,
        origin: "source_observation",
        fromStepId,
        pendingRelationRef: null,
        optionSemantics: "advance",
        targetRef: fromEdgeRef,
        outcome: "success",
      },
      [evidence],
    ),
  };
}

function observeActionResult(sampleId, label, fromStepId, targetRef, resultRefs, pendingRelationRef) {
  const actionRef = `action:${sampleId}:${label}`;
  const receiptRef = `receipt:${sampleId}:${label}`;
  const evidence = `ev:${targetRef}:observe`;
  return {
    actionRef,
    receiptRef,
    receipt: {
      receiptRef,
      actionRef,
      action: "observe_local",
      origin: "source_observation",
      targetRef,
      fromStepId,
      pendingRelationRef,
      resultRefs,
      outcome: "success",
      evidenceRefs: [evidence],
    },
    previousExecution: observed(
      {
        actionRef,
        receiptRef,
        origin: "source_observation",
        fromStepId,
        pendingRelationRef,
        optionSemantics: "observe",
        targetRef,
        outcome: "success",
      },
      [evidence],
    ),
  };
}

function bindingImport(callSiteRef, edge, reason = "not_requested", activeReadEvidence = []) {
  const evidence = [...new Set([...activeReadEvidence, ...edge.evidenceRefs])];
  return observed(
    {
      symbolRef: `symbol:${edge.edgeRef}`,
      callSiteRef,
      role: "import",
      bindingMode: reason === "dynamic_undecidable" ? "dynamic" : "unbound",
      resolution:
        reason === "dynamic_undecidable"
          ? { status: "dynamic", reason, evidenceRefs: evidence }
          : { status: "unresolved", reason, evidenceRefs: evidence },
      declarationRefs: [],
      scopeRef: null,
      evidenceRefs: evidence,
    },
    evidence,
  );
}

function bindingResolved(callSiteRef, declaration, role = null) {
  const evidence = declaration.evidenceRefs;
  return observed(
    {
      symbolRef: `symbol:${declaration.declarationRef}`,
      callSiteRef,
      role: role ?? declaration.role,
      bindingMode: "bound",
      resolution: {
        status: "resolved",
        declarationRef: declaration.declarationRef,
        moduleRef: declaration.moduleRef,
        evidenceRefs: evidence,
      },
      declarationRefs: [declaration],
      scopeRef: null,
      evidenceRefs: evidence,
    },
    evidence,
  );
}

function bindingUnresolved(callSiteRef, reason = "observation_failed") {
  return observed(
    {
      symbolRef: null,
      callSiteRef,
      role: "unspecified",
      bindingMode: "unbound",
      resolution: { status: "unresolved", reason, evidenceRefs: [] },
      declarationRefs: [],
      scopeRef: null,
      evidenceRefs: [],
    },
    [],
  );
}

function currentRelation(pendingRelationRef, callSiteRef, binding) {
  return { pendingRelationRef, callSiteRef, binding };
}

function typedGain(value, evidenceRefs = [], explanation = null) {
  return {
    state: "known",
    value,
    reason: null,
    evidenceRefs,
    ...(explanation ? { explanation } : {}),
  };
}

function advanceObligation(pendingRelationRef, edge) {
  return {
    kind: "advance",
    ref: edge.edgeRef,
    pendingRelationRef,
    skillRef: "skill:relation.read",
    arguments: [{ name: "target", type: "binding_edge", valueRef: edge.edgeRef }],
    informationGain: typedGain(
      "advances_chain",
      edge.evidenceRefs,
      "The local import/re-export edge is observed and its source module is not requested.",
    ),
    informationGainExplanation:
      "Observed edge plus unread source module supports a chain advance.",
    evidenceRefs: edge.evidenceRefs,
  };
}

function observeObligation(pendingRelationRef, ref, targetRef, evidenceRefs, explanation) {
  return {
    kind: "observe",
    ref,
    pendingRelationRef,
    skillRef: "skill:relation.observe",
    arguments: [{ name: "target", type: "source_module", valueRef: targetRef }],
    informationGain: typedGain("advances_chain", evidenceRefs, explanation),
    informationGainExplanation: explanation,
    evidenceRefs,
  };
}

function localSyntax(observedBindings, observedDeclarations, sourceContent, extra = {}) {
  return {
    observedBindings: [...observedBindings],
    observedDeclarations: [...observedDeclarations],
    observedLocalFacts: extra.observedLocalFacts ?? [],
    moduleSpecifierRaw: extra.moduleSpecifierRaw ?? null,
    sourceContent,
    shadowFacts: extra.shadowFacts ?? [],
  };
}

function legalCandidatesFor(obligations) {
  const observations = obligations
    .filter(
      (obligation) =>
        obligation.kind === "observe" &&
        obligation.informationGain.state === "known" &&
        obligation.informationGain.value !== "none",
    )
    .map((obligation) => `c:${obligation.ref}`);
  const advances = obligations
    .filter(
      (obligation) =>
        obligation.kind === "advance" &&
        obligation.informationGain.state === "known" &&
        obligation.informationGain.value !== "none",
    )
    .map((obligation) => `c:advance:${obligation.ref}`);
  return [
    ...JUDGES,
    ...advances,
    ...observations,
    observations.length > 0 || advances.length > 0 ? DEFER : RETURN,
  ];
}

function sourceContentNotRequested(evidence) {
  return { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: evidence };
}

function sourceContentObserved(resultRefs, evidence) {
  return { state: "observed", resultRefs, reason: null, evidenceRefs: evidence };
}

function sourceContentFailed(reason, evidence) {
  return { state: "failed", resultRefs: [], reason, evidenceRefs: evidence };
}

function requestField(value) {
  if (value === undefined || value === null || value === "") return missing("not_requested");
  return known(value);
}

function typedRequestFor(episode, typedRequest) {
  const request = typedRequest?.request ?? typedRequest ?? {};
  const requested = request.requestedDeclaration ?? {};
  return {
    requestRef: request.requestRef ?? typedRequest?.requestRef ?? episode.requestId,
    requestedDeclaration: {
      declarationRef: requestField(requested.declarationRef),
      moduleRef: requestField(requested.moduleRef),
      name: requestField(requested.name),
      kind: requestField(requested.kind),
      sourceTargetRef: requested.sourceTargetRef ?? null,
    },
    relationObligation: {
      pendingRelationRef: request.relationObligation?.pendingRelationRef ?? null,
      callSiteRef: request.relationObligation?.callSiteRef ?? null,
      calleeName: request.relationObligation?.calleeName ?? null,
    },
  };
}

function typedRequestJoinKey(row) {
  return `${row.family ?? row.sourceGroup ?? ""}|${row.sampleId}`;
}

function cloneRequest(request) {
  return structuredClone(request);
}

function requestRelationFor(sample, fallbackPendingRelationRef) {
  const request = cloneRequest(sample.request);
  const pendingRelationRef =
    request.relationObligation.pendingRelationRef ?? fallbackPendingRelationRef;
  request.relationObligation.pendingRelationRef = pendingRelationRef;
  return { request, pendingRelationRef };
}

function makeStep({
  stepId,
  localSyntax: syntax,
  remainingObligations,
  legalCandidates,
  previousExecution,
  receipts,
  currentRelation: relation,
  cursorState,
  cursorEvidence,
  notReady = false,
  coverage = null,
}) {
  return {
    stepId,
    observedAt: "current-step",
    localSyntax: syntax,
    currentRelation: relation,
    remainingObligations,
    legalCandidates,
    previousExecution,
    receipts,
    localCandidateCursor: {
      state: cursorState,
      evidenceRefs: cursorEvidence,
    },
    coverage,
    notReady,
  };
}

function findImportBinding(parsed, localName) {
  return parsed.importBindings.find((binding) => binding.targetName === localName) ?? null;
}

function findCallByIdentifier(parsed, name) {
  return parsed.calls.find(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
  ) ?? null;
}

function declarationForLocalCall(root, parsed, call) {
  const identifier = call.expression;
  const resolved = resolveLocalIdentifier(identifier);
  if (resolved.candidates.length === 0) return { kind: "missing" };
  if (resolved.candidates.length > 1) return { kind: "ambiguous", declarations: resolved.candidates };
  const declaration = resolved.candidates[0];
  const exported = hasModifier(declaration, ts.SyntaxKind.ExportKeyword);
  const identity = declarationRef(root, declaration, exported ? "export" : undefined);
  if (enclosingFunctionName(declaration)) identity.role = "shadow";
  return { kind: "resolved", declaration: identity, scope: resolved.scope };
}

function missingReadResult(sample, read, reason) {
  const sampleId = sample.episode.sampleId;
  const { pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const evidence = read.receipt.evidenceRefs[0];
  const failedEdge = {
    edgeRef: `edge:${sample.episode.entryFile}:import:0`,
    callSiteRef: null,
    fromNodeRef: `syntax:${sample.episode.entryFile}:import:0`,
    edgeKind: "import",
    sourceName: sample.episode.entrySymbol ?? "helper",
    sourceModule: missing("observation_failed", [evidence]),
    targetName: sample.episode.entrySymbol ?? "helper",
    targetModule: missing("observation_failed", [evidence]),
    moduleSpecifierRaw: null,
    sourceContent: sourceContentFailed("observation_failed", [evidence]),
    visibility: notObserved("observation_failed", [evidence]),
    hopDepth: 0,
    evidenceRefs: [evidence],
  };
  const step = makeStep({
    stepId: "step-0",
    localSyntax: localSyntax(
      [failedEdge],
      [],
      sourceContentFailed("observation_failed", [evidence]),
    ),
    remainingObligations: [],
    legalCandidates: [],
    previousExecution: read.previousExecution,
    receipts: [read.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      null,
      bindingUnresolved(null, "observation_failed"),
    ),
    cursorState: "failed",
    cursorEvidence: [evidence],
    notReady: true,
  });
  return {
    ...sample,
    request: cloneRequest(sample.request),
    steps: [step],
    reads: [read.actualRead],
    ast: [],
    stepFirsts: [
      {
        sampleId,
        stepId: "step-0",
        edgeRefs: [failedEdge.edgeRef],
        declarationRefs: [],
        obligationRefs: [],
        actionRefs: [read.actionRef],
      },
    ],
    gainBranches: [
      {
        sampleId,
        stepId: "step-0",
        kind: "observe",
        ref: failedEdge.edgeRef,
        branch: "missing/observation_failed",
        candidateEmitted: false,
      },
    ],
    predecessorAndConsumption: [
      {
        sampleId,
        stepId: "step-0",
        previousActionRef: read.actionRef,
        previousReceiptRef: read.receiptRef,
        fromStepId: read.actualRead.fromStepId,
        consumedEdgeRef: null,
      },
    ],
    terminalDeclarationRef: null,
    trainingEligible: false,
    notReadyReason: reason,
  };
}

function aliasSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const entryFile = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(sampleId, "step0-source-read", null, root, entryFile, pendingRelationRef);
  if (entryRead.parsed === null) {
    return missingReadResult(sample, entryRead, "entry source read failed");
  }
  const entryParsed = entryRead.parsed;
  let activeReadEvidence = [parseEvidenceRef(root, entryParsed)];
  const importBinding = findImportBinding(entryParsed, episode.entrySymbol);
  const firstEdge = importBinding
    ? importEdges(root, entryParsed).find((edge) => edge.targetName === importBinding.targetName)
    : null;
  if (!firstEdge) {
    return missingReadResult(sample, entryRead, `entry symbol ${episode.entrySymbol} not observed`);
  }
  const derivedCallSiteRef = `call:${entryParsed.rel}:${episode.entrySymbol}`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;
  const steps = [];
  const reads = [entryRead.actualRead];
  const ast = [astObservation(root, entryParsed)];
  const stepFirsts = [];
  const gainBranches = [];
  const predecessorAndConsumption = [];
  const observedBindings = [];
  const observedDeclarations = [];
  let activeEdge = firstEdge;
  let hop = 0;
  let previousExecution = entryRead.previousExecution;
  let previousReceipt = entryRead.receipt;

  while (activeEdge) {
    const currentBindings = [...observedBindings];
    if (!currentBindings.some((edge) => edge.edgeRef === activeEdge.edgeRef)) {
      currentBindings.push(activeEdge);
    }
    const obligations = [advanceObligation(pendingRelationRef, activeEdge)];
    const legalCandidates = legalCandidatesFor(obligations);
    const stepId = `step-${steps.length}`;
    const relation = currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingImport(callSiteRef, activeEdge, "not_requested", activeReadEvidence),
    );
    steps.push(
      makeStep({
        stepId,
        localSyntax: localSyntax(
          currentBindings,
          observedDeclarations,
          sourceContentNotRequested(activeEdge.evidenceRefs),
          { moduleSpecifierRaw: activeEdge.moduleSpecifierRaw },
        ),
        remainingObligations: obligations,
        legalCandidates,
        previousExecution,
        receipts: [previousReceipt],
        currentRelation: relation,
        cursorState: "closed",
        cursorEvidence: activeEdge.evidenceRefs,
      }),
    );
    stepFirsts.push({
      sampleId,
      stepId,
      edgeRefs: currentBindings.map((edge) => edge.edgeRef),
      declarationRefs: observedDeclarations.map((declaration) => declaration.declarationRef),
      obligationRefs: obligations.map((obligation) => obligation.ref),
      actionRefs: [previousExecution.value.actionRef],
    });
    gainBranches.push({
      sampleId,
      stepId,
      kind: "advance",
      ref: activeEdge.edgeRef,
      branch: "known/advances_chain",
      candidateEmitted: legalCandidates.includes(`c:advance:${activeEdge.edgeRef}`),
    });
    predecessorAndConsumption.push({
      sampleId,
      stepId,
      previousActionRef: previousExecution.value.actionRef,
      previousReceiptRef: previousExecution.value.receiptRef,
      fromStepId: previousExecution.value.fromStepId,
      consumedEdgeRef: null,
    });

    if (activeEdge.sourceModule.state !== "known" || !activeEdge.sourceModule.value) {
      return {
        ...sample,
        request,
        steps,
        reads,
        ast,
        stepFirsts,
        gainBranches,
        predecessorAndConsumption,
        terminalDeclarationRef: null,
        trainingEligible: false,
        notReadyReason: `source module missing for ${activeEdge.edgeRef}`,
      };
    }
    const sourcePath = path.join(familyRoot, activeEdge.sourceModule.value.replace("mod:", ""));
    const sourceRead = readActionResult(
      sampleId,
      `${stepId}-advance`,
      stepId,
      root,
      sourcePath,
      pendingRelationRef,
      "advance",
    );
    if (sourceRead.parsed === null) {
      return {
        ...sample,
        request,
        steps,
        reads: [...reads, sourceRead.actualRead],
        ast,
        stepFirsts,
        gainBranches,
        predecessorAndConsumption,
        terminalDeclarationRef: null,
        trainingEligible: false,
        notReadyReason: `source read failed for ${activeEdge.edgeRef}`,
      };
    }
    reads.push(sourceRead.actualRead);
    ast.push(astObservation(root, sourceRead.parsed));
    const nextBinding = sourceRead.parsed.reexports.find(
      (binding) => binding.targetName === activeEdge.sourceName,
    );
    const nextEdge = nextBinding
      ? reexportEdges(root, sourceRead.parsed, hop + 1).find(
          (edge) => edge.targetName === nextBinding.targetName,
        )
      : null;
    const terminal = nextBinding
      ? null
      : findTopDeclaration(sourceRead.parsed.sourceFile, activeEdge.sourceName);
    const consumedEvidence = [parseEvidenceRef(root, sourceRead.parsed)];
    activeReadEvidence = consumedEvidence;
    const consumedEdge = {
      ...activeEdge,
      sourceContent: sourceContentObserved(
        [nextEdge?.edgeRef ?? declarationRef(root, terminal, "export").declarationRef],
        consumedEvidence,
      ),
      evidenceRefs: [...activeEdge.evidenceRefs, ...consumedEvidence],
    };
    observedBindings.length = 0;
    for (const edge of currentBindings) {
      observedBindings.push(edge.edgeRef === activeEdge.edgeRef ? consumedEdge : edge);
    }
    previousExecution = sourceRead.previousExecution;
    previousReceipt = sourceRead.receipt;

    if (nextEdge) {
      observedBindings.push(nextEdge);
      const nextStepId = `step-${steps.length}`;
      stepFirsts.push({
        sampleId,
        stepId: nextStepId,
        edgeRefs: observedBindings.map((edge) => edge.edgeRef),
        declarationRefs: [],
        obligationRefs: [nextEdge.edgeRef],
        actionRefs: [sourceRead.actionRef],
      });
      gainBranches.push({
        sampleId,
        stepId: nextStepId,
        kind: "advance",
        ref: nextEdge.edgeRef,
        branch: "known/advances_chain",
        candidateEmitted: true,
      });
      predecessorAndConsumption.push({
        sampleId,
        stepId: nextStepId,
        previousActionRef: sourceRead.actionRef,
        previousReceiptRef: sourceRead.receiptRef,
        fromStepId: sourceRead.previousExecution.value.fromStepId,
        consumedEdgeRef: activeEdge.edgeRef,
      });
      activeEdge = nextEdge;
      hop += 1;
      continue;
    }

    if (!terminal) {
      return {
        ...sample,
        request,
        steps,
        reads,
        ast,
        stepFirsts,
        gainBranches,
        predecessorAndConsumption,
        terminalDeclarationRef: null,
        trainingEligible: false,
        notReadyReason: `unsupported local declaration shape in ${sourceRead.parsed.rel}`,
      };
    }

    const terminalIdentity = declarationRef(root, terminal, "export");
    observedDeclarations.push(terminalIdentity);
    const nextStepId = `step-${steps.length}`;
    steps.push(
      makeStep({
        stepId: nextStepId,
        localSyntax: localSyntax(
          observedBindings,
          observedDeclarations,
          sourceContentObserved([terminalIdentity.declarationRef], consumedEvidence),
          { moduleSpecifierRaw: activeEdge.moduleSpecifierRaw },
        ),
        remainingObligations: [],
        legalCandidates: legalCandidatesFor([]),
        previousExecution,
        receipts: [previousReceipt],
        currentRelation: currentRelation(
          pendingRelationRef,
          callSiteRef,
          bindingResolved(callSiteRef, terminalIdentity, "export"),
        ),
        cursorState: "closed",
        cursorEvidence: [...consumedEvidence, ...terminalIdentity.evidenceRefs],
      }),
    );
    stepFirsts.push({
      sampleId,
      stepId: nextStepId,
      edgeRefs: observedBindings.map((edge) => edge.edgeRef),
      declarationRefs: [terminalIdentity.declarationRef],
      obligationRefs: [],
      actionRefs: [previousExecution.value.actionRef],
    });
    predecessorAndConsumption.push({
      sampleId,
      stepId: nextStepId,
      previousActionRef: previousExecution.value.actionRef,
      previousReceiptRef: previousExecution.value.receiptRef,
      fromStepId: previousExecution.value.fromStepId,
      consumedEdgeRef: activeEdge.edgeRef,
    });
    return {
      ...sample,
      request,
      steps,
      reads,
      ast,
      stepFirsts,
      gainBranches,
      predecessorAndConsumption,
      terminalDeclarationRef: terminalIdentity.declarationRef,
      trainingEligible: true,
      notReadyReason: null,
    };
  }
  return {
    ...sample,
    request,
    steps,
    reads,
    ast,
    stepFirsts,
    gainBranches,
    predecessorAndConsumption,
    terminalDeclarationRef: null,
    trainingEligible: false,
    notReadyReason: "no local alias edge was observed",
  };
}

function mismatchReadReceipt(read, fromStepId, pendingRelationRef) {
  return {
    receiptId: read.receipt.receiptRef,
    actionRef: read.receipt.actionRef,
    action: "read_source",
    origin: "source_observation",
    outcome: read.receipt.outcome,
    targetRef: read.receipt.targetRef,
    fromStepId,
    pendingRelationRef,
    result: read.receipt.resultRefs,
    evidenceRefs: read.receipt.evidenceRefs,
    modules: [{
      file: read.actualRead.file,
      textLength: read.actualRead.textLength,
      lineCount: read.actualRead.lineCount,
    }],
  };
}

function targetMismatchSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const entryFile = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(
    sampleId,
    "step0-source-read",
    null,
    root,
    entryFile,
    pendingRelationRef,
  );
  if (entryRead.parsed === null) {
    return missingReadResult(sample, entryRead, "entry source read failed");
  }
  const entryParsed = entryRead.parsed;
  const importBinding = findImportBinding(entryParsed, episode.entrySymbol);
  const firstEdge = importBinding
    ? importEdges(root, entryParsed).find((edge) => edge.targetName === importBinding.targetName)
    : null;
  if (!firstEdge || firstEdge.sourceModule.state !== "known") {
    return missingReadResult(
      sample,
      entryRead,
      `entry symbol ${episode.entrySymbol} not observed with a known source module`,
    );
  }
  const derivedCallSiteRef = `call:${entryParsed.rel}:${episode.entrySymbol}`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;

  const requestedModuleRef = request.requestedDeclaration.moduleRef?.state === "known"
    ? request.requestedDeclaration.moduleRef.value
    : null;
  const requestedModuleFile = typeof requestedModuleRef === "string"
    && requestedModuleRef.startsWith("mod:")
    ? requestedModuleRef.slice("mod:".length)
    : null;
  const requestedName = request.requestedDeclaration.name?.state === "known"
    ? request.requestedDeclaration.name.value
    : null;
  if (requestedModuleFile === null || requestedName === null) {
    return missingReadResult(sample, entryRead, "requested target module/name is not known");
  }

  const boundPath = path.join(familyRoot, firstEdge.sourceModule.value.replace("mod:", ""));
  const boundRead = readActionResult(
    sampleId,
    "step1-bound-read",
    "step-0",
    root,
    boundPath,
    pendingRelationRef,
    "advance",
  );
  if (boundRead.parsed === null) {
    return missingReadResult(sample, boundRead, "bound source read failed");
  }
  const boundTerminal = findTopDeclaration(boundRead.parsed.sourceFile, firstEdge.sourceName);
  if (boundTerminal === null) {
    return missingReadResult(sample, boundRead, `bound declaration ${firstEdge.sourceName} not found`);
  }
  const boundDeclaration = declarationRef(root, boundTerminal, "export");

  const targetPath = path.join(familyRoot, requestedModuleFile);
  const targetRead = readActionResult(
    sampleId,
    "step2-target-read",
    "step-1",
    root,
    targetPath,
    pendingRelationRef,
    "advance",
  );
  if (targetRead.parsed === null) {
    return missingReadResult(sample, targetRead, "requested target source read failed");
  }
  const targetTerminal = findTopDeclaration(targetRead.parsed.sourceFile, requestedName);
  if (targetTerminal === null) {
    return missingReadResult(sample, targetRead, `requested target ${requestedName} not found`);
  }
  const requestedDeclaration = declarationRef(root, targetTerminal, "export");

  const entryReceipt = mismatchReadReceipt(entryRead, null, pendingRelationRef);
  const boundReceipt = mismatchReadReceipt(boundRead, "step-0", pendingRelationRef);
  const targetReceipt = mismatchReadReceipt(targetRead, "step-1", pendingRelationRef);
  const bindingS = bindingResolved(callSiteRef, boundDeclaration, "export");

  const rawObservation = {
    kind: "resolved_target_mismatch",
    observationRef: `obs:${sampleId}:target-mismatch`,
    requestRef: request.requestRef,
    sampleId,
    stepId: "step-2",
    fromStepId: "step-1",
    callSiteRef,
    pendingRelationRef,
    requestedDeclaration: {
      declarationRef: requestedDeclaration.declarationRef,
      moduleRef: requestedDeclaration.moduleRef,
      name: requestedDeclaration.name,
      kind: requestedDeclaration.kind,
      readRef: targetReceipt.receiptId,
      evidenceRefs: targetReceipt.evidenceRefs,
    },
    boundDeclaration: {
      declarationRef: boundDeclaration.declarationRef,
      moduleRef: boundDeclaration.moduleRef,
      name: boundDeclaration.name,
      kind: boundDeclaration.kind,
      readRef: boundReceipt.receiptId,
      evidenceRefs: boundReceipt.evidenceRefs,
    },
    callSiteBinding: {
      symbolRef: bindingS.value.symbolRef,
      callSiteRef,
      role: bindingS.value.role,
      bindingMode: "bound",
      resolution: {
        status: "resolved",
        declarationRef: boundDeclaration.declarationRef,
        moduleRef: boundDeclaration.moduleRef,
        evidenceRefs: bindingS.value.resolution.evidenceRefs,
      },
    },
    importEdge: {
      edgeRef: firstEdge.edgeRef,
      edgeKind: "import",
      sourceName: firstEdge.sourceName,
      targetName: firstEdge.targetName,
      sourceModuleRef: firstEdge.sourceModule.value,
      targetModuleRef: firstEdge.targetModule.value,
      moduleSpecifierRaw: firstEdge.moduleSpecifierRaw,
      evidenceRefs: firstEdge.evidenceRefs,
    },
    sourceReadReceipts: [entryReceipt, boundReceipt, targetReceipt],
  };

  const completionWork = {
    contract: "tsjs.observed-target-mismatch-read.v1",
    scope: "source_local",
    items: [
      {
        kind: "source_read",
        subjectRef: entryReceipt.modules[0].file,
        disposition: {
          state: "satisfied",
          evidenceRefs: [entryReceipt.receiptId, ...entryReceipt.result],
        },
      },
      {
        kind: "source_read",
        subjectRef: boundReceipt.modules[0].file,
        disposition: {
          state: "satisfied",
          evidenceRefs: [boundReceipt.receiptId, ...boundReceipt.result],
        },
      },
      {
        kind: "source_read",
        subjectRef: targetReceipt.modules[0].file,
        disposition: {
          state: "satisfied",
          evidenceRefs: [targetReceipt.receiptId, ...targetReceipt.result],
        },
      },
      {
        kind: "callable_identity",
        subjectRef: boundDeclaration.declarationRef,
        disposition: {
          state: "satisfied",
          evidenceRefs: [boundReceipt.receiptId, ...boundDeclaration.evidenceRefs],
        },
      },
      {
        kind: "requested_target_mapping",
        subjectRef: requestedDeclaration.declarationRef,
        disposition: {
          state: "satisfied",
          evidenceRefs: [targetReceipt.receiptId, ...requestedDeclaration.evidenceRefs],
        },
      },
    ],
  };

  const producerSource = {
    kind: "nnanything.tsjs.target-mismatch-source.v1",
    rawObservation,
    sampleId,
    requestRef: request.requestRef,
    stepId: "step-2",
    fromStepId: "step-1",
    callSiteRef,
    pendingRelationRef,
    requestedDeclarationRef: requestedDeclaration.declarationRef,
    requestedModuleRef: requestedModuleRef,
    completionWork,
  };

  const previousExecution = observed(
    {
      actionRef: targetReceipt.actionRef,
      receiptRef: targetReceipt.receiptId,
      origin: "source_observation",
      fromStepId: "step-1",
      pendingRelationRef,
      optionSemantics: "advance",
      targetRef: targetReceipt.targetRef,
      outcome: "success",
    },
    targetReceipt.evidenceRefs,
  );
  const stepReceipt = {
    receiptId: targetReceipt.receiptId,
    actionRef: targetReceipt.actionRef,
    action: "read_source",
    target: targetReceipt.targetRef,
    origin: "source_observation",
    fromStepId: "step-1",
    pendingRelationRef,
    optionSemantics: "advance",
    outcome: "success",
    result: targetReceipt.result,
    evidenceRefs: targetReceipt.evidenceRefs,
    producerSource,
  };
  const coveredModules = [
    entryReceipt.modules[0].file,
    boundReceipt.modules[0].file,
    targetReceipt.modules[0].file,
  ];
  const step = makeStep({
    stepId: "step-2",
    localSyntax: localSyntax(
      [firstEdge],
      [boundDeclaration, requestedDeclaration],
      sourceContentObserved(targetReceipt.result, [targetReceipt.receiptId]),
    ),
    remainingObligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution,
    receipts: [stepReceipt],
    currentRelation: currentRelation(pendingRelationRef, callSiteRef, bindingS),
    cursorState: "closed",
    cursorEvidence: [...targetReceipt.evidenceRefs, ...boundDeclaration.evidenceRefs],
    coverage: {
      coveredModules,
      targetModuleReached: true,
      note: "target_mismatch_source_observed",
    },
  });
  return {
    ...sample,
    request,
    steps: [step],
    reads: [entryRead.actualRead, boundRead.actualRead, targetRead.actualRead],
    ast: [
      astObservation(root, entryParsed),
      astObservation(root, boundRead.parsed),
      astObservation(root, targetRead.parsed),
    ],
    stepFirsts: [{
      sampleId,
      stepId: "step-2",
      edgeRefs: [firstEdge.edgeRef],
      declarationRefs: [
        boundDeclaration.declarationRef,
        requestedDeclaration.declarationRef,
      ],
      obligationRefs: [],
      actionRefs: [targetReceipt.actionRef],
    }],
    gainBranches: [{
      sampleId,
      stepId: "step-2",
      kind: "observe",
      ref: requestedDeclaration.declarationRef,
      branch: "known/target_mismatch",
      candidateEmitted: true,
    }],
    predecessorAndConsumption: [{
      sampleId,
      stepId: "step-2",
      previousActionRef: targetReceipt.actionRef,
      previousReceiptRef: targetReceipt.receiptId,
      fromStepId: "step-1",
      consumedEdgeRef: firstEdge.edgeRef,
    }],
    terminalDeclarationRef: boundDeclaration.declarationRef,
    trainingEligible: true,
    notReadyReason: null,
  };
}

function closureSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const entryFile = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(sampleId, "step0-source-read", null, root, entryFile, pendingRelationRef);
  if (entryRead.parsed === null) return missingReadResult(sample, entryRead, "entry source read failed");
  const reads = [entryRead.actualRead];
  const ast = [astObservation(root, entryRead.parsed)];
  const receipts = [entryRead.receipt];
  let observedBindings = [];
  if (sampleId === "b-closure-negative-other-module") {
    observedBindings = importEdges(root, entryRead.parsed);
  }
  let closureRead = entryRead;
  let closureParsed = entryRead.parsed;
  if (path.basename(entryFile) === "entry.ts") {
    closureRead = readActionResult(
      sampleId,
      "step0-closure-read",
      null,
      root,
      path.join(familyRoot, "sources/src/closure.ts"),
      pendingRelationRef,
    );
    if (closureRead.parsed === null) {
      return missingReadResult(sample, closureRead, "closure source read failed");
    }
    closureParsed = closureRead.parsed;
    reads.push(closureRead.actualRead);
    ast.push(astObservation(root, closureParsed));
    receipts.push(closureRead.receipt);
  }
  const functionName = sampleId === "b-closure-negative-shadow" ? "makeShadow" : "makeAdder";
  const functionNode = findFunction(closureParsed.sourceFile, functionName);
  if (!functionNode) {
    return missingReadResult(sample, closureRead, `function ${functionName} not found`);
  }
  const call = findCallByIdentifier(
    { calls: collectCalls(functionNode), sourceFile: closureParsed.sourceFile },
    "base",
  );
  if (!call) return missingReadResult(sample, closureRead, "base call not found");
  const resolved = declarationForLocalCall(root, closureParsed, call);
  if (resolved.kind !== "resolved") {
    return missingReadResult(sample, closureRead, "base call binding is not resolved");
  }
  const declaration = resolved.declaration;
  const derivedCallSiteRef = `call:${closureParsed.rel}:${functionName}.addOffset:base`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;
  const sourceContent = sourceContentObserved([declaration.declarationRef], [parseEvidenceRef(root, closureParsed)]);
  const shadowFacts =
    sampleId === "b-closure-negative-shadow"
      ? [{ name: "base", declarationRef: declaration.declarationRef, shadowScope: "makeShadow" }]
      : [];
  const step = makeStep({
    stepId: "step-0",
    localSyntax: localSyntax(observedBindings, [declaration], sourceContent, { shadowFacts }),
    remainingObligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution: closureRead.previousExecution,
    receipts,
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingResolved(callSiteRef, declaration, declaration.role),
    ),
    cursorState: "closed",
    cursorEvidence: [parseEvidenceRef(root, closureParsed), ...declaration.evidenceRefs],
  });
  return {
    ...sample,
    request,
    steps: [step],
    reads,
    ast,
    stepFirsts: [
      {
        sampleId,
        stepId: "step-0",
        edgeRefs: observedBindings.map((edge) => edge.edgeRef),
        declarationRefs: [declaration.declarationRef],
        obligationRefs: [],
        actionRefs: [closureRead.actionRef],
      },
    ],
    gainBranches: observedBindings.map((edge) => ({
      sampleId,
      stepId: "step-0",
      kind: "observe",
      ref: edge.edgeRef,
      branch: "known/none",
      candidateEmitted: false,
    })),
    predecessorAndConsumption: [
      {
        sampleId,
        stepId: "step-0",
        previousActionRef: closureRead.actionRef,
        previousReceiptRef: closureRead.receiptRef,
        fromStepId: null,
        consumedEdgeRef: null,
      },
    ],
    terminalDeclarationRef: declaration.declarationRef,
    trainingEligible: true,
    notReadyReason: null,
  };
}

function dynamicSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const entryPath = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(sampleId, "step0-source-read", null, root, entryPath, pendingRelationRef);
  if (entryRead.parsed === null) return missingReadResult(sample, entryRead, "entry source read failed");
  const entryParsed = entryRead.parsed;
  const registryEdge = importEdges(root, entryParsed).find(
    (edge) => edge.targetName === "registry",
  ) ?? null;
  const computedDeclaration = findTopDeclaration(entryParsed.sourceFile, "computedName");
  if (!registryEdge || !computedDeclaration) {
    return missingReadResult(sample, entryRead, "entry dynamic binding facts not found");
  }
  const derivedCallSiteRef = `call:${entryParsed.rel}:registry[computedName]`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;
  const entryEvidence = [parseEvidenceRef(root, entryParsed)];
  const obligations0 = [
    observeObligation(
      pendingRelationRef,
      OBSERVE_ENTRY_FOLD,
      callSiteRef,
      entryEvidence,
      "The current entry module contains the computed property expression.",
    ),
    observeObligation(
      pendingRelationRef,
      OBSERVE_REGISTRY,
      registryEdge.sourceModule.state === "known" ? registryEdge.sourceModule.value : registryEdge.edgeRef,
      entryEvidence,
      "The observed registry import identifies the next source module.",
    ),
  ];
  const step0 = makeStep({
    stepId: "step-0",
    localSyntax: localSyntax(
      [registryEdge],
      [],
      sourceContentNotRequested(registryEdge.evidenceRefs),
      { moduleSpecifierRaw: registryEdge.moduleSpecifierRaw },
    ),
    remainingObligations: obligations0,
    legalCandidates: legalCandidatesFor(obligations0),
    previousExecution: entryRead.previousExecution,
    receipts: [entryRead.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingImport(callSiteRef, registryEdge, "dynamic_undecidable"),
    ),
    cursorState: "closed",
    cursorEvidence: entryEvidence,
  });

  const folded = foldStringLiteral(computedDeclaration.initializer);
  if (folded === null) {
    return missingReadResult(sample, entryRead, "computedName could not be folded");
  }
  const foldExecution = observeActionResult(
    sampleId,
    "step1-entry-fold",
    "step-0",
    OBSERVE_ENTRY_FOLD,
    [`fact:${sampleId}:entry-fold`],
    pendingRelationRef,
  );
  const computedIdentity = declarationRef(root, computedDeclaration, "local");
  const obligations1 = [
    observeObligation(
      pendingRelationRef,
      OBSERVE_REGISTRY,
      registryEdge.sourceModule.state === "known" ? registryEdge.sourceModule.value : registryEdge.edgeRef,
      entryEvidence,
      "The observed registry import remains the next source module after local folding.",
    ),
  ];
  const step1 = makeStep({
    stepId: "step-1",
    localSyntax: localSyntax(
      [registryEdge],
      [computedIdentity],
      sourceContentObserved([computedIdentity.declarationRef], entryEvidence),
      {
        moduleSpecifierRaw: registryEdge.moduleSpecifierRaw,
        observedLocalFacts: [
          { factRef: `fact:${sampleId}:entry-fold`, state: "known", value: folded, evidenceRefs: entryEvidence },
        ],
      },
    ),
    remainingObligations: obligations1,
    legalCandidates: legalCandidatesFor(obligations1),
    previousExecution: foldExecution.previousExecution,
    receipts: [foldExecution.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingImport(callSiteRef, registryEdge, "dynamic_undecidable"),
    ),
    cursorState: "closed",
    cursorEvidence: entryEvidence,
  });

  const closurePath = path.join(familyRoot, "sources/src/closure.ts");
  const closureRead = readActionResult(
    sampleId,
    "step2-registry-read",
    "step-1",
    root,
    closurePath,
    pendingRelationRef,
  );
  if (closureRead.parsed === null) {
    return missingReadResult(sample, closureRead, "registry source read failed");
  }
  const closureParsed = closureRead.parsed;
  const registryDeclaration = findTopDeclaration(closureParsed.sourceFile, "registry");
  const baseDeclaration = findTopDeclaration(closureParsed.sourceFile, folded);
  const objectLiteral = registryDeclaration?.initializer;
  const shorthand = objectLiteral && ts.isObjectLiteralExpression(objectLiteral)
    ? objectLiteral.properties.find(
        (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === folded,
      )
    : null;
  if (!registryDeclaration || !baseDeclaration || !shorthand) {
    return missingReadResult(sample, closureRead, "registry member binding not observed");
  }
  const registryIdentity = declarationRef(root, registryDeclaration, "export");
  const baseIdentity = declarationRef(root, baseDeclaration, "export");
  const closureEvidence = [parseEvidenceRef(root, closureParsed)];
  const registryObserved = {
    ...registryEdge,
    sourceContent: sourceContentObserved([baseIdentity.declarationRef], closureEvidence),
    evidenceRefs: [...registryEdge.evidenceRefs, ...closureEvidence],
  };
  const step2 = makeStep({
    stepId: "step-2",
    localSyntax: localSyntax(
      [registryObserved],
      [computedIdentity, registryIdentity, baseIdentity],
      sourceContentObserved([baseIdentity.declarationRef], closureEvidence),
      {
        moduleSpecifierRaw: registryEdge.moduleSpecifierRaw,
        observedLocalFacts: [
          { factRef: `fact:${sampleId}:registry-member`, state: "known", value: folded, evidenceRefs: closureEvidence },
        ],
      },
    ),
    remainingObligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution: closureRead.previousExecution,
    receipts: [closureRead.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingResolved(callSiteRef, baseIdentity, "export"),
    ),
    cursorState: "closed",
    cursorEvidence: [...closureEvidence, ...baseIdentity.evidenceRefs],
  });
  return {
    ...sample,
    request,
    steps: [step0, step1, step2],
    reads: [entryRead.actualRead, closureRead.actualRead],
    ast: [astObservation(root, entryParsed), astObservation(root, closureParsed)],
    stepFirsts: [
      {
        sampleId,
        stepId: "step-0",
        edgeRefs: [registryEdge.edgeRef],
        declarationRefs: [],
        obligationRefs: obligations0.map((obligation) => obligation.ref),
        actionRefs: [entryRead.actionRef],
      },
      {
        sampleId,
        stepId: "step-1",
        edgeRefs: [registryEdge.edgeRef],
        declarationRefs: [computedIdentity.declarationRef],
        obligationRefs: obligations1.map((obligation) => obligation.ref),
        actionRefs: [foldExecution.actionRef],
      },
      {
        sampleId,
        stepId: "step-2",
        edgeRefs: [registryEdge.edgeRef],
        declarationRefs: [registryIdentity.declarationRef, baseIdentity.declarationRef],
        obligationRefs: [],
        actionRefs: [closureRead.actionRef],
      },
    ],
    gainBranches: [
      {
        sampleId,
        stepId: "step-0",
        kind: "observe",
        ref: OBSERVE_ENTRY_FOLD,
        branch: "known/advances_chain",
        candidateEmitted: true,
      },
      {
        sampleId,
        stepId: "step-0",
        kind: "observe",
        ref: OBSERVE_REGISTRY,
        branch: "known/advances_chain",
        candidateEmitted: true,
      },
      {
        sampleId,
        stepId: "step-1",
        kind: "observe",
        ref: OBSERVE_REGISTRY,
        branch: "known/advances_chain",
        candidateEmitted: true,
      },
    ],
    predecessorAndConsumption: [
      {
        sampleId,
        stepId: "step-0",
        previousActionRef: entryRead.actionRef,
        previousReceiptRef: entryRead.receiptRef,
        fromStepId: null,
        consumedEdgeRef: null,
      },
      {
        sampleId,
        stepId: "step-1",
        previousActionRef: foldExecution.actionRef,
        previousReceiptRef: foldExecution.receiptRef,
        fromStepId: "step-0",
        consumedEdgeRef: null,
      },
      {
        sampleId,
        stepId: "step-2",
        previousActionRef: closureRead.actionRef,
        previousReceiptRef: closureRead.receiptRef,
        fromStepId: "step-1",
        consumedEdgeRef: registryEdge.edgeRef,
      },
    ],
    terminalDeclarationRef: baseIdentity.declarationRef,
  };
}

function missingModuleSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const entryPath = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(sampleId, "step0-source-read", null, root, entryPath, pendingRelationRef);
  if (entryRead.parsed === null) return missingReadResult(sample, entryRead, "entry source read failed");
  const importBinding = findImportBinding(entryRead.parsed, episode.entrySymbol);
  if (!importBinding) {
    return missingReadResult(sample, entryRead, "entry import not observed");
  }
  const edge = sourceEdge(root, entryRead.parsed, importBinding, 0);
  const failedEdge = {
    ...edge,
    sourceModule: missing("observation_failed", edge.evidenceRefs),
    sourceContent: sourceContentFailed("observation_failed", edge.evidenceRefs),
    visibility: notObserved("observation_failed", edge.evidenceRefs),
  };
  const failedRead = {
    ...entryRead,
    receipt: {
      ...entryRead.receipt,
      outcome: "failed",
      resultRefs: [],
      errorCode: "MODULE_NOT_FOUND",
      errorMessage: `module ${importBinding.specifier} not resolved`,
    },
    previousExecution: observed(
      {
        actionRef: entryRead.actionRef,
        receiptRef: entryRead.receiptRef,
        origin: "source_observation",
        fromStepId: null,
        pendingRelationRef,
        optionSemantics: "observe",
        targetRef: failedEdge.edgeRef,
        outcome: "failed",
      },
      entryRead.receipt.evidenceRefs,
    ),
    actualRead: {
      ...entryRead.actualRead,
      outcome: "failed",
      errorCode: "MODULE_NOT_FOUND",
      errorMessage: `module ${importBinding.specifier} not resolved`,
    },
  };
  const derivedCallSiteRef = `call:${entryRead.parsed.rel}:${episode.entrySymbol}`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;
  const step = makeStep({
    stepId: "step-0",
    localSyntax: localSyntax(
      [failedEdge],
      [],
      sourceContentFailed("observation_failed", failedEdge.evidenceRefs),
      { moduleSpecifierRaw: importBinding.specifier },
    ),
    remainingObligations: [],
    legalCandidates: [],
    previousExecution: failedRead.previousExecution,
    receipts: [failedRead.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingUnresolved(callSiteRef, "observation_failed"),
    ),
    cursorState: "failed",
    cursorEvidence: failedEdge.evidenceRefs,
    notReady: true,
    coverage: {
      coveredModules: [entryRead.parsed.rel],
      targetModuleReached: false,
      note: `module ${importBinding.specifier} not resolved; original expected unknown retained`,
    },
  });
  return {
    ...sample,
    request,
    steps: [step],
    reads: [failedRead.actualRead],
    ast: [astObservation(root, entryRead.parsed)],
    stepFirsts: [
      {
        sampleId,
        stepId: "step-0",
        edgeRefs: [failedEdge.edgeRef],
        declarationRefs: [],
        obligationRefs: [],
        actionRefs: [failedRead.actionRef],
      },
    ],
    gainBranches: [
      {
        sampleId,
        stepId: "step-0",
        kind: "observe",
        ref: failedEdge.edgeRef,
        branch: "missing/observation_failed",
        candidateEmitted: false,
      },
    ],
    predecessorAndConsumption: [
      {
        sampleId,
        stepId: "step-0",
        previousActionRef: failedRead.actionRef,
        previousReceiptRef: failedRead.receiptRef,
        fromStepId: null,
        consumedEdgeRef: null,
      },
    ],
    terminalDeclarationRef: null,
    trainingEligible: false,
    notReadyReason:
      "execution/coverage: module ./missing not resolved (TS2307); original expected unknown preserved; no new semantic A_g",
  };
}

function uniqueImportBinding(parsed, name) {
  const matches = parsed.importBindings.filter((binding) => binding.targetName === name);
  if (matches.length === 1) return { kind: "resolved", binding: matches[0] };
  if (matches.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", count: matches.length };
}

function uniqueTopDeclaration(sourceFile, name) {
  const matches = directStatementDeclarations(sourceFile.statements).filter(
    (declaration) => declarationName(declaration) === name,
  );
  if (matches.length === 1) return { kind: "resolved", declaration: matches[0] };
  if (matches.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", count: matches.length };
}

function findLocalTableDynamicShape(parsed, calleeName) {
  const candidates = [];
  for (const call of parsed.calls) {
    if (!ts.isElementAccessExpression(call.expression)) continue;
    const access = call.expression;
    if (!ts.isIdentifier(access.expression) || !ts.isIdentifier(access.argumentExpression)) {
      continue;
    }
    const table = uniqueTopDeclaration(parsed.sourceFile, access.expression.text);
    if (table.kind !== "resolved" || !ts.isObjectLiteralExpression(table.declaration.initializer)) {
      continue;
    }
    const members = table.declaration.initializer.properties.filter(
      (property) =>
        ts.isShorthandPropertyAssignment(property) && property.name.text === calleeName,
    );
    if (members.length !== 1) continue;
    const key = uniqueTopDeclaration(parsed.sourceFile, access.argumentExpression.text);
    if (key.kind !== "resolved") continue;
    const folded = foldStringLiteral(key.declaration.initializer);
    if (folded !== calleeName) continue;
    const resolvedTable = resolveLocalIdentifier(access.expression);
    const resolvedKey = resolveLocalIdentifier(access.argumentExpression);
    if (
      resolvedTable.candidates.length !== 1 ||
      resolvedTable.candidates[0] !== table.declaration ||
      resolvedKey.candidates.length !== 1 ||
      resolvedKey.candidates[0] !== key.declaration
    ) {
      continue;
    }
    candidates.push({
      call,
      tableDeclaration: table.declaration,
      keyDeclaration: key.declaration,
      tableName: access.expression.text,
      keyName: access.argumentExpression.text,
      folded,
    });
  }
  if (candidates.length === 1) return { kind: "resolved", ...candidates[0] };
  if (candidates.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", count: candidates.length };
}

function localTableDynamicSteps(sample, root) {
  const { episode, familyRoot } = sample;
  const sampleId = episode.sampleId;
  const { request, pendingRelationRef } = requestRelationFor(sample, `pending:${sampleId}`);
  const calleeName = request.relationObligation.calleeName;
  const entryPath = path.join(familyRoot, episode.entryFile);
  const entryRead = readActionResult(
    sampleId,
    "step0-source-read",
    null,
    root,
    entryPath,
    pendingRelationRef,
  );
  if (entryRead.parsed === null) {
    return missingReadResult(sample, entryRead, "entry source read failed");
  }
  const entryParsed = entryRead.parsed;
  const importBinding = uniqueImportBinding(entryParsed, calleeName);
  if (importBinding.kind === "ambiguous") {
    return missingReadResult(
      sample,
      entryRead,
      `ambiguous import binding for ${calleeName}`,
    );
  }
  if (importBinding.kind !== "resolved") {
    return missingReadResult(
      sample,
      entryRead,
      `entry import not observed for ${calleeName}`,
    );
  }
  const edge = importEdges(root, entryParsed).find(
    (candidate) => candidate.targetName === calleeName,
  );
  if (!edge || edge.sourceModule.state !== "known" || !edge.sourceModule.value) {
    return missingReadResult(
      sample,
      entryRead,
      `entry import not observed for ${calleeName}`,
    );
  }
  const shape = findLocalTableDynamicShape(entryParsed, calleeName);
  if (shape.kind === "ambiguous") {
    return missingReadResult(
      sample,
      entryRead,
      `ambiguous local table/member/folded-key binding for ${calleeName}`,
    );
  }
  if (shape.kind !== "resolved") {
    return missingReadResult(
      sample,
      entryRead,
      `local table/member/folded-key binding not observed for ${calleeName}`,
    );
  }
  const derivedCallSiteRef =
    `call:${entryParsed.rel}:${shape.tableName}[${shape.keyName}]`;
  const callSiteRef = request.relationObligation.callSiteRef ?? derivedCallSiteRef;
  request.relationObligation.callSiteRef = callSiteRef;
  const entryEvidence = [parseEvidenceRef(root, entryParsed)];
  const obligations0 = [
    observeObligation(
      pendingRelationRef,
      OBSERVE_ENTRY_FOLD,
      callSiteRef,
      entryEvidence,
      "The current entry module contains the local table and computed key.",
    ),
  ];
  const step0 = makeStep({
    stepId: "step-0",
    localSyntax: localSyntax(
      [edge],
      [],
      sourceContentNotRequested(edge.evidenceRefs),
      { moduleSpecifierRaw: edge.moduleSpecifierRaw },
    ),
    remainingObligations: obligations0,
    legalCandidates: legalCandidatesFor(obligations0),
    previousExecution: entryRead.previousExecution,
    receipts: [entryRead.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingImport(callSiteRef, edge, "dynamic_undecidable", entryEvidence),
    ),
    cursorState: "closed",
    cursorEvidence: entryEvidence,
  });

  const foldExecution = observeActionResult(
    sampleId,
    "step1-entry-fold",
    "step-0",
    OBSERVE_ENTRY_FOLD,
    [`fact:${sampleId}:entry-fold`],
    pendingRelationRef,
  );
  const keyIdentity = declarationRef(root, shape.keyDeclaration, "local");
  const tableIdentity = declarationRef(root, shape.tableDeclaration, "local");
  const obligations1 = [advanceObligation(pendingRelationRef, edge)];
  const step1 = makeStep({
    stepId: "step-1",
    localSyntax: localSyntax(
      [edge],
      [tableIdentity, keyIdentity],
      sourceContentObserved([tableIdentity.declarationRef, keyIdentity.declarationRef], entryEvidence),
      {
        moduleSpecifierRaw: edge.moduleSpecifierRaw,
        observedLocalFacts: [
          {
            factRef: `fact:${sampleId}:entry-fold`,
            state: "known",
            value: shape.folded,
            evidenceRefs: entryEvidence,
          },
        ],
      },
    ),
    remainingObligations: obligations1,
    legalCandidates: legalCandidatesFor(obligations1),
    previousExecution: foldExecution.previousExecution,
    receipts: [foldExecution.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingImport(callSiteRef, edge, "dynamic_undecidable", entryEvidence),
    ),
    cursorState: "closed",
    cursorEvidence: [parseEvidenceRef(root, entryParsed)],
  });

  const factoryPath = path.join(familyRoot, edge.sourceModule.value.replace("mod:", ""));
  const factoryRead = readActionResult(
    sampleId,
    "step2-factory-read",
    "step-1",
    root,
    factoryPath,
    pendingRelationRef,
    "advance",
  );
  if (factoryRead.parsed === null) {
    return missingReadResult(sample, factoryRead, "imported factory source read failed");
  }
  const terminal = uniqueTopDeclaration(factoryRead.parsed.sourceFile, calleeName);
  if (terminal.kind === "ambiguous") {
    return missingReadResult(
      sample,
      factoryRead,
      `ambiguous terminal declaration for ${calleeName}`,
    );
  }
  if (terminal.kind !== "resolved") {
    return missingReadResult(
      sample,
      factoryRead,
      `terminal declaration ${calleeName} not observed`,
    );
  }
  const terminalIdentity = declarationRef(root, terminal.declaration, "export");
  const factoryEvidence = [parseEvidenceRef(root, factoryRead.parsed)];
  const consumedEdge = {
    ...edge,
    sourceContent: sourceContentObserved([terminalIdentity.declarationRef], factoryEvidence),
    evidenceRefs: [...edge.evidenceRefs, ...factoryEvidence],
  };
  const step2 = makeStep({
    stepId: "step-2",
    localSyntax: localSyntax(
      [consumedEdge],
      [terminalIdentity],
      sourceContentObserved([terminalIdentity.declarationRef], factoryEvidence),
      { moduleSpecifierRaw: edge.moduleSpecifierRaw },
    ),
    remainingObligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution: factoryRead.previousExecution,
    receipts: [factoryRead.receipt],
    currentRelation: currentRelation(
      pendingRelationRef,
      callSiteRef,
      bindingResolved(callSiteRef, terminalIdentity, "export"),
    ),
    cursorState: "closed",
    cursorEvidence: [...factoryEvidence, ...terminalIdentity.evidenceRefs],
  });
  return {
    ...sample,
    request,
    steps: [step0, step1, step2],
    reads: [entryRead.actualRead, factoryRead.actualRead],
    ast: [astObservation(root, entryParsed), astObservation(root, factoryRead.parsed)],
    stepFirsts: [
      {
        sampleId,
        stepId: "step-0",
        edgeRefs: [edge.edgeRef],
        declarationRefs: [],
        obligationRefs: obligations0.map((obligation) => obligation.ref),
        actionRefs: [entryRead.actionRef],
      },
      {
        sampleId,
        stepId: "step-1",
        edgeRefs: [edge.edgeRef],
        declarationRefs: [tableIdentity.declarationRef, keyIdentity.declarationRef],
        obligationRefs: obligations1.map((obligation) => obligation.ref),
        actionRefs: [foldExecution.actionRef],
      },
      {
        sampleId,
        stepId: "step-2",
        edgeRefs: [consumedEdge.edgeRef],
        declarationRefs: [terminalIdentity.declarationRef],
        obligationRefs: [],
        actionRefs: [factoryRead.actionRef],
      },
    ],
    gainBranches: [
      {
        sampleId,
        stepId: "step-0",
        kind: "observe",
        ref: OBSERVE_ENTRY_FOLD,
        branch: "known/advances_chain",
        candidateEmitted: step0.legalCandidates.includes(`c:${OBSERVE_ENTRY_FOLD}`),
      },
      {
        sampleId,
        stepId: "step-1",
        kind: "advance",
        ref: edge.edgeRef,
        branch: "known/advances_chain",
        candidateEmitted: step1.legalCandidates.includes(`c:advance:${edge.edgeRef}`),
      },
    ],
    predecessorAndConsumption: [
      {
        sampleId,
        stepId: "step-0",
        previousActionRef: entryRead.actionRef,
        previousReceiptRef: entryRead.receiptRef,
        fromStepId: null,
        consumedEdgeRef: null,
      },
      {
        sampleId,
        stepId: "step-1",
        previousActionRef: foldExecution.actionRef,
        previousReceiptRef: foldExecution.receiptRef,
        fromStepId: "step-0",
        consumedEdgeRef: null,
      },
      {
        sampleId,
        stepId: "step-2",
        previousActionRef: factoryRead.actionRef,
        previousReceiptRef: factoryRead.receiptRef,
        fromStepId: "step-1",
        consumedEdgeRef: edge.edgeRef,
      },
    ],
    terminalDeclarationRef: terminalIdentity.declarationRef,
    trainingEligible: true,
    notReadyReason: null,
    devShape: "local-table-computed",
  };
}

function buildOldDevStudent(sample, root, useTargetMismatchPath = false) {
  const calleeName = sample.request.relationObligation.calleeName;
  const entryFile = path.join(sample.familyRoot, sample.episode.entryFile);
  const entryParsed = parseModule(root, entryFile);
  const directCalls = entryParsed.calls.filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === calleeName,
  );
  if (directCalls.length > 1) {
    throw new Error(`ambiguous direct call for ${sample.episode.sampleId}: ${calleeName}`);
  }
  if (directCalls.length === 1) {
    if (sample.episode.entrySymbol !== calleeName) {
      throw new Error(
        `request callee ${calleeName} does not match entry symbol ${sample.episode.entrySymbol}`,
      );
    }
    const binding = uniqueImportBinding(entryParsed, calleeName);
    if (binding.kind === "ambiguous") {
      throw new Error(`ambiguous import binding for ${calleeName}`);
    }
    if (binding.kind !== "resolved") {
      throw new Error(`entry import not observed for ${calleeName}`);
    }
    const built = useTargetMismatchPath ? targetMismatchSteps(sample, root) : aliasSteps(sample, root);
    if (!built.trainingEligible) {
      throw new Error(built.notReadyReason ?? `direct import path failed for ${calleeName}`);
    }
    return {
      ...built,
      devShape: useTargetMismatchPath ? "direct-import-target-read" : "direct-import",
    };
  }
  const dynamicShape = findLocalTableDynamicShape(entryParsed, calleeName);
  if (dynamicShape.kind === "ambiguous") {
    throw new Error(`ambiguous local table binding for ${calleeName}`);
  }
  if (dynamicShape.kind === "resolved") {
    const built = localTableDynamicSteps(sample, root);
    if (!built.trainingEligible) {
      throw new Error(built.notReadyReason ?? `local table path failed for ${calleeName}`);
    }
    return built;
  }
  throw new Error(`no supported AST-derived binding path for ${sample.episode.sampleId}`);
}

function oldDevControlReceipt(built) {
  const requestedDecl = built.request.requestedDeclaration.declarationRef;
  const requestedDeclarationRef =
    requestedDecl && requestedDecl.state === "known" ? requestedDecl.value : null;
  const requestedModuleRef =
    built.request.requestedDeclaration.moduleRef?.state === "known"
      ? built.request.requestedDeclaration.moduleRef.value
      : null;
  const requestedReadFile =
    typeof requestedModuleRef === "string" && requestedModuleRef.startsWith("mod:")
      ? requestedModuleRef.slice("mod:".length)
      : null;
  const readFiles = built.reads.map((read) => read.file);
  return {
    sampleId: built.student.sampleId,
    shape: built.devShape,
    requestedDeclarationRef,
    observedTerminalDeclarationRef: built.terminalDeclarationRef,
    readFiles,
    requestTargetRead: requestedReadFile === null ? false : readFiles.includes(requestedReadFile),
    requestShellPreserved:
      built.student.request.requestRef === built.request.requestRef &&
      requestedDeclarationRef ===
        (built.student.request.requestedDeclaration.declarationRef?.value ?? null),
  };
}

export async function generateOldDevStepwise({
  familyRoot,
  requestSource = DEFAULT_OLD_DEV_REQUEST_SOURCE,
  outDir = familyRoot,
  receiptPath,
  derivedSourceGroup = null,
  targetMismatchSourceGroup = null,
} = {}) {
  if (!familyRoot) {
    throw new TypeError("familyRoot is required for old DEV stepwise generation");
  }
  if (derivedSourceGroup !== null) {
    if (typeof derivedSourceGroup !== "string" || derivedSourceGroup.length === 0) {
      throw new TypeError("derivedSourceGroup must be a non-empty string when provided");
    }
    if (path.resolve(outDir) === path.resolve(familyRoot)) {
      throw new TypeError("derivedSourceGroup requires a separate derived output directory");
    }
  }
  if (targetMismatchSourceGroup !== null) {
    if (typeof targetMismatchSourceGroup !== "string" || targetMismatchSourceGroup.length === 0) {
      throw new TypeError("targetMismatchSourceGroup must be a non-empty string when provided");
    }
    if (path.resolve(outDir) === path.resolve(familyRoot)) {
      throw new TypeError("targetMismatchSourceGroup requires a separate derived output directory");
    }
  }
  if (derivedSourceGroup !== null && targetMismatchSourceGroup !== null) {
    throw new TypeError(
      "derivedSourceGroup and targetMismatchSourceGroup are mutually exclusive",
    );
  }
  if (!receiptPath) {
    receiptPath = path.join(outDir, "control-receipts.json");
  }
  await fsp.mkdir(outDir, { recursive: true });
  const manifest = readJson(path.join(familyRoot, "manifest.json"));
  const requestRows = readJson(requestSource);
  if (!Array.isArray(requestRows)) {
    throw new TypeError("old DEV request source must be a JSON array");
  }
  const requestsBySample = new Map();
  for (const row of requestRows) {
    if (!row || typeof row !== "object" || typeof row.sampleId !== "string") {
      throw new TypeError("old DEV request row must contain sampleId");
    }
    if (requestsBySample.has(row.sampleId)) {
      throw new TypeError(`duplicate old DEV request ${row.sampleId}`);
    }
    requestsBySample.set(row.sampleId, cloneRequest(row.request));
  }
  const episodeFiles = fs
    .readdirSync(familyRoot)
    .filter((name) => name.startsWith("episode-") && name.endsWith(".jsonl"))
    .sort();
  const samples = episodeFiles.map((file) => {
    const episode = pickStudentEpisode(readJsonl(path.join(familyRoot, file))[0]);
    if (episode.partition !== "dev") {
      throw new TypeError(`old DEV episode ${episode.sampleId} is not partition dev`);
    }
    const request = requestsBySample.get(episode.sampleId);
    if (!request) {
      throw new TypeError(`old DEV request missing for ${episode.sampleId}`);
    }
    return {
      family: manifest.sourceGroup,
      familyRoot,
      episode,
      request,
    };
  });
  if (samples.length !== 3 || requestsBySample.size !== 3) {
    throw new TypeError(
      `old DEV family ${manifest.sourceGroup} must contain exactly 3 episodes and requests`,
    );
  }
  const builtSamples = samples.map((sample) => buildOldDevStudent(
    sample,
    familyRoot,
    targetMismatchSourceGroup !== null
      && sample.episode.sampleId === "c-dev-negative-same-name-other",
  ));
  const studentRows = builtSamples.map((built) => ({
    schemaVersion: STUDENT_SCHEMA,
    sampleId: built.episode.sampleId,
    family: built.family,
    sourceGroup: derivedSourceGroup ?? targetMismatchSourceGroup ?? built.episode.sourceGroup,
    partition: built.episode.partition,
    language: built.episode.language,
    semanticStratum: built.episode.semanticStratum,
    entryFile: built.episode.entryFile,
    request: built.request,
    steps: built.steps,
  }));
  if (studentRows.length !== 3) {
    throw new Error("old DEV producer must emit exactly 3 student rows");
  }
  if (studentHasForbiddenKeys(studentRows)) {
    throw new Error("old DEV student observations contain supervision-only fields");
  }
  for (const [index, built] of builtSamples.entries()) {
    built.student = studentRows[index];
  }
  const controlReceipts = {
    schemaVersion: OLD_DEV_CONTROL_RECEIPTS_SCHEMA,
    familyRoot,
    requestSource,
    outputPath: path.join(outDir, "student-observations.jsonl"),
    controls: builtSamples.map(oldDevControlReceipt),
  };
  const studentObservationsPath = path.join(outDir, "student-observations.jsonl");
  let derivedOutput = null;
  const derivedGroup = derivedSourceGroup ?? targetMismatchSourceGroup;
  if (derivedGroup !== null) {
    const manifestPath = path.join(outDir, "manifest.json");
    const derivedManifest = {
      ...manifest,
      sourceGroup: derivedGroup,
      derivation: {
        kind: targetMismatchSourceGroup !== null
          ? "derived-diagnostic-target-mismatch"
          : "derived-diagnostic-dev",
        derivedFrom: manifest.sourceGroup,
        regeneratedBinding: targetMismatchSourceGroup !== null
          ? "bound-import-and-distinct-target-read"
          : "current-active-containing-read",
        independentHoldout: false,
        trainingEligible: false,
        rows: builtSamples.map((built) => ({
          sampleId: built.episode.sampleId,
          originalSourceGroup: built.episode.sourceGroup,
        })),
      },
    };
    writeJson(manifestPath, derivedManifest);
    const admissionsPath = path.join(outDir, "familyAdmissions.json");
    writeJson(admissionsPath, {
      schema: FAMILY_ADMISSIONS_SCHEMA,
      familyAdmissions: [
        {
          sourceGroup: derivedGroup,
          partition: "DEV",
          usableForTrainingSupervision: false,
          usableForIndependentVerification: false,
          evidence:
            "derived diagnostic DEV from the original family; same source lineage, not an independent holdout",
        },
      ],
    });
    derivedOutput = {
      dir: outDir,
      manifestPath,
      studentObservationsPath,
      admissionsPath,
      sourceGroup: derivedGroup,
      recordCount: studentRows.length,
      sampleIds: builtSamples.map((built) => built.episode.sampleId),
    };
  }
  writeJsonl(path.join(outDir, "student-observations.jsonl"), studentRows);
  writeJson(receiptPath, controlReceipts);
  return { studentRows, controlReceipts, derivedOutput };
}

function buildStudent(sample, root) {
  let built;
  if (sample.episode.sampleId === "b-closure-unknown-dynamic-property") {
    built = dynamicSteps(sample, root);
  } else if (sample.episode.sampleId.startsWith("b-closure-")) {
    built = closureSteps(sample, root);
  } else if (sample.episode.sampleId === "a-module-unknown-missing-module") {
    built = missingModuleSteps(sample, root);
  } else {
    built = aliasSteps(sample, root);
  }
  return {
    ...built,
    requestJoin: sample.requestJoin,
    studentInputs: {
      episode: sample.episode,
      request: cloneRequest(sample.request),
    },
    student: {
      schemaVersion: STUDENT_SCHEMA,
      sampleId: sample.episode.sampleId,
      family: sample.family,
      sourceGroup: sample.episode.sourceGroup,
      partition: sample.episode.partition,
      language: sample.episode.language,
      semanticStratum: sample.episode.semanticStratum,
      entryFile: sample.episode.entryFile,
      request: built.request,
      steps: built.steps,
    },
  };
}

function actionForGold(action, label) {
  if (action) return action;
  if (label === "true" || label === "false" || label === "unknown") return `c:judge:${label}`;
  return null;
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function supervisionJoinKey(row) {
  return `${row.family ?? row.sourceGroup ?? ""}|${row.sampleId}`;
}

function originalExpectedFor(sourceRow) {
  if (sourceRow?.originalExpected) return structuredClone(sourceRow.originalExpected);
  const gold = sourceRow?.gold ?? {};
  return {
    label: gold.originalLabel ?? gold.label ?? null,
    originalLabel: gold.originalLabel ?? null,
    originalUnknownReason: gold.originalUnknownReason ?? null,
    labelMissing: Boolean(gold.labelMissing),
    executionReceiptRef: gold.executionReceiptRef ?? null,
  };
}

// Supervision is read from the existing independent supervision source and
// joined by its source group (family here), sampleId, and stepId. The source
// S_g/A_g are preserved verbatim and are never rebuilt from the student
// trajectory; a mismatch is reported, not silently rewritten.
function supervisionFor(built, sourceRow, override = null) {
  const sampleId = built.student.sampleId;
  const failures = [];
  if (!sourceRow) {
    return notReadySupervision(
      built,
      null,
      override,
      `independent supervision missing for ${sampleId}`,
    );
  }
  if (sourceRow.sourceGroup && sourceRow.sourceGroup !== built.student.sourceGroup) {
    failures.push({
      sampleId,
      stepId: null,
      reason: "independent supervision sourceGroup does not match student sourceGroup",
    });
  }
  if (sourceRow.family && sourceRow.family !== built.family) {
    failures.push({
      sampleId,
      stepId: null,
      reason: "independent supervision family does not match student family",
    });
  }
  if (sourceRow.requestRef !== built.student.request.requestRef) {
    failures.push({
      sampleId,
      stepId: null,
      reason: "student request does not match independent supervision requestRef",
    });
  }
  const sourceSteps = new Map();
  for (const step of sourceRow.steps ?? []) {
    if (sourceSteps.has(step.stepId)) {
      failures.push({
        sampleId,
        stepId: step.stepId,
        reason: "duplicate independent supervision step join",
      });
    }
    sourceSteps.set(step.stepId, step);
  }
  const steps = [];
  for (const step of built.steps) {
    const sourceStep = sourceSteps.get(step.stepId);
    if (!sourceStep) {
      failures.push({
        sampleId,
        stepId: step.stepId,
        reason: "independent supervision step missing for student trajectory",
      });
      continue;
    }
    if (!sameStringSet(step.legalCandidates, sourceStep.S_g ?? [])) {
      failures.push({
        sampleId,
        stepId: step.stepId,
        reason: "student candidate set differs from independent supervision S_g",
        studentCandidates: [...step.legalCandidates],
        supervisionCandidates: [...(sourceStep.S_g ?? [])],
      });
    }
    steps.push({
      stepId: sourceStep.stepId,
      S_g: [...(sourceStep.S_g ?? [])],
      A_g: [...(sourceStep.A_g ?? [])],
      agSubsetOfSg: Boolean(sourceStep.agSubsetOfSg),
      labelAuthority: sourceStep.labelAuthority ?? null,
      oracleKind: sourceStep.oracleKind ?? null,
      unknownReason: sourceStep.unknownReason ?? null,
    });
  }
  for (const [stepId] of sourceSteps) {
    if (!built.steps.some((step) => step.stepId === stepId)) {
      failures.push({
        sampleId,
        stepId,
        reason: "independent supervision step has no student trajectory",
      });
    }
  }
  const sourceGold = sourceRow.gold ?? {};
  const gold = {
    label: override?.goldLabel ?? sourceGold.label ?? "unknown",
    allowedEquivalentLabels: sourceGold.allowedEquivalentLabels ?? [],
    labelAuthority: sourceGold.labelAuthority ?? null,
    oracleKind: sourceGold.oracleKind ?? null,
    unknownReason: sourceGold.unknownReason ?? null,
    originalLabel: sourceGold.originalLabel ?? null,
    originalUnknownReason: sourceGold.originalUnknownReason ?? null,
    goldAction: actionForGold(override?.goldAction ?? sourceGold.goldAction, override?.goldLabel ?? sourceGold.label),
    candidateSet: sourceGold.candidateSet ?? [],
    admission: sourceGold.admission ?? null,
    supersededBy: sourceGold.supersededBy ?? null,
    teacherEvidence: override?.teacherEvidence ?? null,
  };
  const joinReady = failures.length === 0;
  const notReadyReason = !joinReady
    ? failures[0].reason
    : (override?.notReadyReason ?? sourceRow.notReadyReason ?? null);
  return {
    schemaVersion: SUPERVISION_SCHEMA,
    sampleId,
    family: sourceRow.family ?? built.family,
    requestRef: sourceRow.requestRef ?? null,
    gold,
    steps,
    trainingEligible: Boolean(sourceRow.trainingEligible) && joinReady && !override?.notReadyReason,
    notReadyReason,
    originalExpected: originalExpectedFor(sourceRow),
    terminalDeclarationRef: sourceRow.terminalDeclarationRef ?? null,
    conflicts: sourceRow.conflicts ?? [],
    joinFailures: failures,
  };
}

function notReadySupervision(built, sourceRow, override, reason) {
  const originalExpected = originalExpectedFor(sourceRow);
  return {
    schemaVersion: SUPERVISION_SCHEMA,
    sampleId: built.student.sampleId,
    family: built.family,
    requestRef: sourceRow?.requestRef ?? null,
    gold: {
      label: override?.goldLabel ?? "unknown",
      allowedEquivalentLabels: [],
      labelAuthority: null,
      oracleKind: null,
      unknownReason: null,
      originalLabel: originalExpected.originalLabel,
      originalUnknownReason: originalExpected.originalUnknownReason,
      goldAction: null,
      candidateSet: [],
      admission: null,
      supersededBy: null,
      teacherEvidence: override?.teacherEvidence ?? null,
    },
    originalExpected,
    steps: [],
    trainingEligible: false,
    notReadyReason: override?.notReadyReason ?? reason,
    terminalDeclarationRef: null,
    conflicts: [],
    joinFailures: [{ sampleId: built.student.sampleId, stepId: null, reason }],
  };
}

function studentHasForbiddenKeys(value) {
  return containsSupervisionOnlyKeys(value);
}

function buildAdmissions(builtSamples, supervisionRows) {
  return builtSamples.map((built) => {
    const supervision = supervisionRows.find(
      (row) => row.sampleId === built.student.sampleId,
    );
    return {
      sampleId: built.student.sampleId,
      family: built.family,
      stepCount: built.steps.length,
      trainingEligible: supervision?.trainingEligible ?? false,
      notReadyReason: supervision?.notReadyReason ?? null,
      steps: built.steps.map((step) => ({
        stepId: step.stepId,
        cursorState: step.localCandidateCursor.state,
        legalCandidateCount: step.legalCandidates.length,
        notReady: step.notReady,
      })),
    };
  });
}

function assertSubsetForSupervision(supervisionRows) {
  const failures = [];
  for (const row of supervisionRows) {
    for (const step of row.steps) {
      for (const action of step.A_g) {
        if (!step.S_g.includes(action)) {
          failures.push({
            sampleId: row.sampleId,
            stepId: step.stepId,
            action,
            reason: "A_g is not a subset of S_g",
          });
        }
      }
    }
  }
  return failures;
}

function writeFieldMapping(outDir) {
  const text = `# Fixed Stepwise Field Mapping

| Contract field | Corpus field | Producer | Student-visible | Supervision-visible |
| --- | --- | --- | --- | --- |
| request identity | \`request.requestedDeclaration\` | explicit request shell; opaque target retained, absent fields kept missing | yes | join only |
| current local observation | \`steps[].localSyntax\` | one current module AST read at a time | yes | no |
| current relation | \`steps[].currentRelation\` | local scope/import/reexport observation | yes | no |
| obligations and typed gain | \`steps[].remainingObligations\` | current local unresolved edge or defined observe contract | yes | no |
| legal candidates | \`steps[].legalCandidates\` | deterministic candidate filter; gold never consulted | yes | compared against source \`S_g\`; source \`S_g\` preserved |
| previous execution | \`steps[].previousExecution\` | real source observation/advance receipt | yes | no |
| local cursor | \`steps[].localCandidateCursor\` | local enumeration only, never root completion | yes | admission input |
| independent action | \`independent-supervision.steps[].A_g\` | separate gold/A_g path | no | yes |
| training admission | \`independent-supervision.trainingEligible\` | supervision/admission path | no | yes |

The student output contains no \`A_g\`, gold, teacher, oracle, \`S_g\`, or terminal-answer fields.
`;
  fs.writeFileSync(path.join(outDir, "field-mapping.md"), text);
}

export async function generateFixedStepwise({
  corpusRoot = DEFAULT_CORPUS_ROOT,
  outDir = DEFAULT_OUTPUT_DIR,
  typedRequestSource = DEFAULT_TYPED_REQUEST_SOURCE,
  supervisionSource = DEFAULT_SUPERVISION_SOURCE,
  supervisionOverride = null,
  typedRequestsOverride = null,
  supervisionRowsOverride = null,
  studentCandidateOverrides = null,
} = {}) {
  await fsp.mkdir(outDir, { recursive: true });
  const families = fs
    .readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("train-"))
    .map((entry) => entry.name)
    .sort();

  const samples = [];
  for (const family of families) {
    const familyRoot = path.join(corpusRoot, family);
    const manifest = readJson(path.join(familyRoot, "manifest.json"));
    const episodeFiles = fs
      .readdirSync(familyRoot)
      .filter((name) => name.startsWith("episode-") && name.endsWith(".jsonl"))
      .sort();
    for (const file of episodeFiles) {
      const episode = readJsonl(path.join(familyRoot, file))[0];
      samples.push({
        family,
        familyRoot,
        episode: pickStudentEpisode(episode),
      });
    }
  }

  const typedRows = readJsonl(typedRequestSource);
  const typedBySample = new Map();
  const duplicateTypedKeys = new Set();
  for (const row of typedRows) {
    const key = typedRequestJoinKey(row);
    if (typedBySample.has(key)) duplicateTypedKeys.add(key);
    else typedBySample.set(key, row);
  }
  for (const sample of samples) {
    const key = typedRequestJoinKey({
      family: sample.family,
      sampleId: sample.episode.sampleId,
    });
    let requestJoin;
    if (typedRequestsOverride?.[sample.episode.sampleId]) {
      requestJoin = { state: "joined", reason: null };
    } else if (duplicateTypedKeys.has(key)) {
      requestJoin = { state: "duplicate", reason: "duplicate typed request join" };
    } else {
      const row = typedBySample.get(key);
      if (!row) {
        requestJoin = { state: "missing", reason: "typed request row missing" };
      } else if (row.sourceGroup && row.sourceGroup !== sample.episode.sourceGroup) {
        requestJoin = {
          state: "source-mismatch",
          reason: "typed request sourceGroup does not match student sourceGroup",
        };
      } else {
        requestJoin = { state: "joined", reason: null };
      }
    }
    sample.requestJoin = requestJoin;
    sample.request =
      typedRequestsOverride?.[sample.episode.sampleId] ??
      typedRequestFor(sample.episode, typedBySample.get(key));
  }

  const supervisionRowsSource =
    supervisionRowsOverride ?? readJsonl(supervisionSource);
  const supervisionBySample = new Map();
  const duplicateSupervisionKeys = new Set();
  for (const row of supervisionRowsSource) {
    const key = supervisionJoinKey(row);
    if (supervisionBySample.has(key)) duplicateSupervisionKeys.add(key);
    else supervisionBySample.set(key, row);
  }

  const builtSamples = samples.map((sample) => buildStudent(sample, sample.familyRoot));
  if (studentCandidateOverrides) {
    for (const built of builtSamples) {
      const sampleOverrides = studentCandidateOverrides[built.student.sampleId];
      if (!sampleOverrides) continue;
      for (const step of built.steps) {
        if (sampleOverrides[step.stepId]) {
          step.legalCandidates = [...sampleOverrides[step.stepId]];
          step.forcedCandidateOverride = true;
        }
      }
    }
  }
  const studentRows = builtSamples.map((built) => built.student);
  const supervisionRows = builtSamples.map((built) => {
    if (built.requestJoin?.state !== "joined") {
      const reason =
        built.requestJoin?.reason ??
        `typed request join not ready for ${built.student.sampleId}`;
      return notReadySupervision(
        built,
        supervisionBySample.get(
          supervisionJoinKey({
            sampleId: built.student.sampleId,
            sourceGroup: built.student.sourceGroup,
            family: built.family,
          }),
        ) ?? null,
        supervisionOverride?.[built.student.sampleId] ?? null,
        reason,
      );
    }
    const sourceKey = supervisionJoinKey({
      sampleId: built.student.sampleId,
      sourceGroup: built.student.sourceGroup,
      family: built.family,
    });
    if (duplicateSupervisionKeys.has(sourceKey)) {
      return notReadySupervision(
        built,
        supervisionBySample.get(sourceKey) ?? null,
        supervisionOverride?.[built.student.sampleId] ?? null,
        `duplicate independent supervision join for ${built.student.sampleId}`,
      );
    }
    const sourceRow = supervisionBySample.get(sourceKey);
    if (!sourceRow) {
      return notReadySupervision(
        built,
        null,
        supervisionOverride?.[built.student.sampleId] ?? null,
        `independent supervision row missing for ${built.student.sampleId}`,
      );
    }
    return supervisionFor(
      built,
      sourceRow,
      supervisionOverride?.[built.student.sampleId] ?? null,
    );
  });
  const assertionsFailed = assertSubsetForSupervision(supervisionRows);
  for (const row of supervisionRows) {
    for (const failure of row.joinFailures ?? []) {
      assertionsFailed.push({
        sampleId: row.sampleId,
        stepId: failure.stepId,
        reason: failure.reason,
      });
    }
  }
  for (const built of builtSamples) {
    for (const step of built.steps) {
      if (
        step.remainingObligations.some(
          (obligation) =>
            obligation.informationGain.value === "none" &&
            step.legalCandidates.includes(`c:advance:${obligation.ref}`),
        )
      ) {
        assertionsFailed.push({
          sampleId: built.student.sampleId,
          stepId: step.stepId,
          reason: "none obligation produced an advance candidate",
        });
      }
    }
  }

  const studentText = studentRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const studentInputRows = builtSamples.map((built) => built.studentInputs);
  const studentBuildInputsContainForbiddenFields = studentInputRows.some(
    (input) => containsSupervisionOnlyKeys(input),
  );
  const studentForbiddenFields = studentHasForbiddenKeys(studentRows);
  const studentRowsContainGoldBytes =
    /"gold"\s*:|teacher-only-evaluation-that-must-not-affect-students/i.test(
      studentText,
    );
  const supervisionText = supervisionRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const supervisionRowsContainStudentPath = supervisionText.includes(
    path.resolve(outDir, "student-observations.jsonl"),
  );
  const selfCheck = {
    schemaVersion: "carol-tsjs-fixed-stepwise-self-check-v1",
    contract: "alice-converter-mapping-design-r2-20261106.md §12-§14",
    corpusRoot,
    generatedAt: new Date().toISOString(),
    summary: {
      sampleCount: studentRows.length,
      stepCount: builtSamples.reduce((total, built) => total + built.steps.length, 0),
      trainingEligibleCount: supervisionRows.filter((row) => row.trainingEligible).length,
      notReadyCount: supervisionRows.filter((row) => !row.trainingEligible).length,
      pendingConflictCount: supervisionRows.filter((row) => row.conflicts.length > 0).length,
    },
    actualReads: builtSamples.flatMap((built) => built.reads),
    localAstObservations: builtSamples.flatMap((built) => built.ast),
    stepFirsts: builtSamples.flatMap((built) => built.stepFirsts),
    bindingSources: builtSamples.flatMap((built) =>
      built.steps.map((step) => ({
        sampleId: built.student.sampleId,
        stepId: step.stepId,
        status: step.currentRelation.binding.value.resolution.status,
        declarationRefs: step.currentRelation.binding.value.declarationRefs.map(
          (declaration) => declaration.declarationRef,
        ),
        callSiteRef: step.currentRelation.callSiteRef,
      })),
    ),
    gainBranches: builtSamples.flatMap((built) => built.gainBranches),
    predecessorAndConsumption: builtSamples.flatMap(
      (built) => built.predecessorAndConsumption,
    ),
    admissions: buildAdmissions(builtSamples, supervisionRows),
    isolation: {
      studentPath: path.join(outDir, "student-observations.jsonl"),
      supervisionPath: path.join(outDir, "independent-supervision.jsonl"),
      studentForbiddenFields,
      studentRowsContainGoldBytes,
      studentBuildInputsContainForbiddenFields,
      checkedStudentInputCount: studentInputRows.length,
      studentGenerationConsumesSupervision:
        studentBuildInputsContainForbiddenFields ||
        studentForbiddenFields ||
        studentRowsContainGoldBytes,
      supervisionIsolationTestRef:
        "tests/carol-tsjs-r2-stepwise-corpus.test.mjs :: keeps supervision S_g/A_g unchanged when a student candidate is wrong",
      supervisionRowsContainStudentPath,
    },
    assertions: {
      passed: assertionsFailed.length === 0,
      failed: assertionsFailed.length,
      failures: assertionsFailed,
    },
    outputPaths: {
      studentObservations: path.resolve(outDir, "student-observations.jsonl"),
      independentSupervision: path.resolve(outDir, "independent-supervision.jsonl"),
      selfCheck: path.resolve(outDir, "self-check.json"),
      fieldMapping: path.resolve(outDir, "field-mapping.md"),
      generatorScript: path.resolve(outDir, "generate-fixed-stepwise.mjs"),
    },
  };

  if (studentHasForbiddenKeys(studentRows)) {
    throw new Error("student observations contain supervision-only fields");
  }
  if (studentText.includes("teacher-only-evaluation-that-must-not-affect-students")) {
    throw new Error("student observations contain supervision override content");
  }
  if (builtSamples.some((built) => built.student.steps.length === 0)) {
    throw new Error("a sample produced no student steps");
  }

  writeJsonl(path.join(outDir, "student-observations.jsonl"), studentRows);
  writeJsonl(path.join(outDir, "independent-supervision.jsonl"), supervisionRows);
  writeFieldMapping(outDir);
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(outDir, "generate-fixed-stepwise.mjs"));
  writeJson(path.join(outDir, "self-check.json"), selfCheck);
  return { studentRows, supervisionRows, selfCheck };
}

async function main() {
  const args = process.argv.slice(2);
  let corpusRoot = DEFAULT_CORPUS_ROOT;
  let outDir = DEFAULT_OUTPUT_DIR;
  let devFamilyRoot = null;
  let requestSource = DEFAULT_OLD_DEV_REQUEST_SOURCE;
  let devOutDir = null;
  let receiptPath = null;
  let derivedSourceGroup = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--corpus-root") corpusRoot = path.resolve(args[++index]);
    else if (args[index] === "--out") outDir = path.resolve(args[++index]);
    else if (args[index] === "--dev-family-root") devFamilyRoot = path.resolve(args[++index]);
    else if (args[index] === "--request-source") requestSource = path.resolve(args[++index]);
    else if (args[index] === "--out-dir") devOutDir = path.resolve(args[++index]);
    else if (args[index] === "--receipts") receiptPath = path.resolve(args[++index]);
    else if (args[index] === "--derived-source-group") derivedSourceGroup = args[++index];
    else if (args[index] === "--help" || args[index] === "-h") {
      process.stdout.write(
        "Usage: node generate-fixed-stepwise.mjs [--corpus-root <absolute>] [--out <absolute>] [--dev-family-root <absolute>] [--request-source <absolute>] [--out-dir <absolute>] [--receipts <absolute>] [--derived-source-group <name>]\n",
      );
      return;
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  const result = devFamilyRoot
    ? await generateOldDevStepwise({
      familyRoot: devFamilyRoot,
      requestSource,
      outDir: devOutDir ?? devFamilyRoot,
      receiptPath: receiptPath ?? path.join(devOutDir ?? devFamilyRoot, "control-receipts.json"),
      derivedSourceGroup,
    })
    : await generateFixedStepwise({ corpusRoot, outDir });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      outDir: path.resolve(devFamilyRoot ? (devOutDir ?? devFamilyRoot) : outDir),
      sampleCount: result.studentRows.length,
      stepCount: result.controlReceipts
        ? result.studentRows.reduce((total, row) => total + row.steps.length, 0)
        : result.selfCheck.summary.stepCount,
      trainingEligibleCount: result.controlReceipts ? null : result.selfCheck.summary.trainingEligibleCount,
      notReadyCount: result.controlReceipts ? null : result.selfCheck.summary.notReadyCount,
      assertionsFailed: result.controlReceipts ? 0 : result.selfCheck.assertions.failed,
      outputPaths: result.controlReceipts
        ? {
          studentObservations: result.controlReceipts.outputPath,
          controlReceipts: receiptPath ?? path.join(devOutDir ?? devFamilyRoot, "control-receipts.json"),
        }
        : result.selfCheck.outputPaths,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
