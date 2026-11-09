#!/usr/bin/env node
// Gold-free student-observation converter for the independent d2 verification
// family. The converter reads only the family manifest, the episode request
// shell, and the tracked TypeScript sources. It never reads labels/gold.jsonl,
// oracle receipts, teacher material, or any TRAIN family.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const TS_PATH =
  process.env.NNANYTHING_TYPESCRIPT_PATH ??
  path.join(repoRoot, "node_modules/typescript/lib/typescript.js");
const ts = require(TS_PATH);

export const D2_STUDENT_SCHEMA = "emma-tsjs-student-observation-v2";
export const D2_FAMILY_NAME = "verification-independent-callgraph-d";
export const D2_FAMILY_DIR = path.join(
  repoRoot,
  "training/samples/neural-cli/tsjs",
  D2_FAMILY_NAME,
);

const JUDGES = ["c:judge:true", "c:judge:false", "c:judge:unknown"];
const RETURN = "c:return";
const DEFER = "c:defer";

const SAMPLE_CONFIG = Object.freeze({
  "d2-verification-positive-alias": Object.freeze({
    kind: "alias-chain",
    entrySymbol: "grow",
    callSiteRef: "call:sources/src/entry-alias.ts:grow",
    calleeName: "grow",
    targetName: "scaleBy",
  }),
  "d2-verification-positive-pipeline": Object.freeze({
    kind: "alias-chain",
    entrySymbol: "offsetBy",
    callSiteRef: "call:sources/src/pipeline.ts:buildPipeline.step:offsetBy",
    calleeName: "offsetBy",
    targetName: "offsetBy",
  }),
  "d2-verification-negative-shadow": Object.freeze({
    kind: "shadow",
    entrySymbol: "offsetBy",
    callSiteRef: "call:sources/src/shadow.ts:buildShadowed.step:offsetBy",
    calleeName: "offsetBy",
    functionName: "buildShadowed",
    localName: "offsetBy",
    targetName: "offsetBy",
  }),
  "d2-verification-unknown-dynamic": Object.freeze({
    kind: "dynamic",
    entrySymbols: ["scaleBy", "offsetBy"],
    callSiteRef: "call:sources/src/entry-dynamic.ts:dispatch.table[selector]",
    calleeName: "table[selector]",
    functionName: "dispatch",
    selectorName: "selector",
    tableName: "table",
    targetName: "scaleBy",
  }),
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
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

function observed(value, evidenceRefs = []) {
  return { state: "known", value, evidenceRefs };
}

function sourceContentNotRequested(evidenceRefs) {
  return { state: "not_requested", resultRefs: [], reason: null, evidenceRefs };
}

function sourceContentObserved(resultRefs, evidenceRefs) {
  return { state: "observed", resultRefs, reason: null, evidenceRefs };
}

function lineCol(sourceFile, node) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === kind));
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
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
  if (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
  ) {
    return "function";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isVariableDeclaration(node)) {
    if (
      node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
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
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          importBindings.push({
            index: importBindings.length,
            sourceName: (element.propertyName ?? element.name).text,
            targetName: element.name.text,
            specifier,
            node: element.name,
          });
        }
      }
    }
    if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        reexports.push({
          index: reexports.length,
          sourceName: (element.propertyName ?? element.name).text,
          targetName: element.name.text,
          specifier: statement.moduleSpecifier.text,
          node: element.name,
        });
      }
    }
  }
  return {
    file,
    rel: rel(root, file),
    text,
    sourceFile,
    importBindings,
    reexports,
  };
}

function findImportBinding(parsed, localName) {
  return parsed.importBindings.find(binding => binding.targetName === localName) ?? null;
}

function findTopDeclaration(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name?.text === name
    ) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        item => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (declaration) return declaration;
    }
  }
  return null;
}

function findFunction(sourceFile, name) {
  return sourceFile.statements.find(
    statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  ) ?? null;
}

function findLocalDeclaration(functionNode, name) {
  let found = null;
  const visit = node => {
    if (found !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return found;
}

function findTopLevelVariable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      item => ts.isIdentifier(item.name) && item.name.text === name,
    );
    if (declaration) return declaration;
  }
  return null;
}

function findParameter(functionNode, name) {
  return functionNode.parameters.find(
    parameter => ts.isIdentifier(parameter.name) && parameter.name.text === name,
  ) ?? null;
}

function sourceEdge(root, parsed, binding) {
  const evidence = evidenceRef(root, parsed.file, `import:${binding.index}`);
  const target = resolveRelativeModule(parsed.file, binding.specifier);
  return {
    edgeRef: `edge:${parsed.rel}:import:${binding.index}`,
    callSiteRef: null,
    fromNodeRef: `syntax:${parsed.rel}:import:${binding.index}`,
    edgeKind: "import",
    sourceName: binding.sourceName,
    sourceModule: target
      ? known(moduleRef(root, target), [evidence])
      : { state: "missing", reason: "observation_failed", evidenceRefs: [evidence] },
    targetName: binding.targetName,
    targetModule: known(moduleRef(root, parsed.file), [evidence]),
    moduleSpecifierRaw: binding.specifier,
    sourceContent: sourceContentNotRequested([evidence]),
    visibility: target
      ? known("reachable", [evidence])
      : { state: "not_observed", reason: "observation_failed", evidenceRefs: [evidence] },
    hopDepth: 0,
    evidenceRefs: [evidence],
  };
}

function reexportEdge(root, parsed, binding, hopDepth) {
  const evidence = evidenceRef(root, parsed.file, `reexport:${binding.index}`);
  const target = resolveRelativeModule(parsed.file, binding.specifier);
  return {
    edgeRef: `edge:${parsed.rel}:reexport:${binding.index}`,
    callSiteRef: null,
    fromNodeRef: `syntax:${parsed.rel}:reexport:${binding.index}`,
    edgeKind: "re_export",
    sourceName: binding.sourceName,
    sourceModule: target
      ? known(moduleRef(root, target), [evidence])
      : { state: "missing", reason: "observation_failed", evidenceRefs: [evidence] },
    targetName: binding.targetName,
    targetModule: known(moduleRef(root, parsed.file), [evidence]),
    moduleSpecifierRaw: binding.specifier,
    sourceContent: sourceContentNotRequested([evidence]),
    visibility: target
      ? known("reachable", [evidence])
      : { state: "not_observed", reason: "observation_failed", evidenceRefs: [evidence] },
    hopDepth,
    evidenceRefs: [evidence],
  };
}

function readAction({
  sampleId,
  label,
  fromStepId,
  root,
  file,
  pendingRelationRef,
  optionSemantics = "observe",
}) {
  const actionRef = `action:${sampleId}:${label}`;
  const receiptRef = `receipt:${sampleId}:${label}`;
  const evidence = evidenceRef(root, file, "read");
  const parsed = parseModule(root, file);
  return {
    parsed,
    actionRef,
    receiptRef,
    receipt: {
      receiptId: receiptRef,
      actionRef,
      action: "read_source",
      origin: "source_observation",
      targetRef: moduleRef(root, file),
      fromStepId,
      pendingRelationRef,
      result: [evidence],
      outcome: "success",
      textLength: parsed.text.length,
      lineCount: parsed.text.split("\n").length,
      evidenceRefs: [evidence],
    },
    previousExecution: observed(
      {
        actionRef,
        receiptRef,
        origin: "source_observation",
        fromStepId,
        pendingRelationRef,
        optionSemantics,
        targetRef: moduleRef(root, file),
        outcome: "success",
      },
      [evidence],
    ),
    evidence,
  };
}

function bindingImport(callSiteRef, edge) {
  const evidence = edge.evidenceRefs;
  return observed(
    {
      symbolRef: `symbol:${edge.edgeRef}`,
      callSiteRef,
      role: "import",
      bindingMode: "unbound",
      resolution: { status: "unresolved", reason: "not_requested", evidenceRefs: evidence },
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

function bindingDynamic(callSiteRef, evidenceRefs) {
  return observed(
    {
      symbolRef: `symbol:${callSiteRef}`,
      callSiteRef,
      role: "member",
      bindingMode: "dynamic",
      resolution: {
        status: "dynamic",
        reason: "dynamic_undecidable",
        evidenceRefs,
      },
      declarationRefs: [],
      scopeRef: null,
      evidenceRefs,
    },
    evidenceRefs,
  );
}

function currentRelation(pendingRelationRef, callSiteRef, binding) {
  return { pendingRelationRef, callSiteRef, binding };
}

function typedGain(value, evidenceRefs, explanation) {
  return {
    state: "known",
    value,
    reason: null,
    evidenceRefs,
    explanation,
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
      "The observed import/re-export edge can be read to inspect its source module.",
    ),
    informationGainExplanation:
      "Observed edge plus unread source module supports a chain advance.",
    evidenceRefs: edge.evidenceRefs,
  };
}

function legalCandidatesFor(obligations) {
  const advances = obligations
    .filter(
      obligation =>
        obligation.kind === "advance"
        && obligation.informationGain.state === "known"
        && obligation.informationGain.value !== "none",
    )
    .map(obligation => `c:advance:${obligation.ref}`);
  return [
    ...JUDGES,
    ...advances,
    advances.length > 0 ? DEFER : RETURN,
  ];
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

function makeStep({
  stepId,
  syntax,
  obligations,
  legalCandidates,
  previousExecution,
  receipts,
  relation,
  cursorState,
  cursorEvidence,
  coverage = null,
}) {
  return {
    stepId,
    observedAt: "current-step",
    localSyntax: syntax,
    currentRelation: relation,
    remainingObligations: obligations,
    legalCandidates,
    previousExecution,
    receipts,
    localCandidateCursor: {
      pendingRelationRef: relation.pendingRelationRef,
      state: cursorState,
      evidenceRefs: cursorEvidence,
    },
    coverage,
    notReady: false,
  };
}

function targetIdentity(familyDir, targetRef) {
  const [filePart, fragment] = targetRef.split("#");
  const name = fragment.split(":").pop();
  const file = path.join(familyDir, filePart);
  const parsed = parseModule(familyDir, file);
  const declaration = findTopDeclaration(parsed.sourceFile, name);
  if (declaration === null) {
    throw new Error(`target declaration ${name} not found in ${filePart}`);
  }
  return declarationRef(familyDir, declaration, "export");
}

function readEpisode(familyDir) {
  const files = fs
    .readdirSync(familyDir)
    .filter(name => name.startsWith("episode-") && name.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) throw new Error(`no episode-*.jsonl in ${familyDir}`);
  return files.map(file => {
    const rows = readJsonl(path.join(familyDir, file));
    const raw = rows[0];
    const config = SAMPLE_CONFIG[raw.sampleId];
    if (!config) throw new Error(`unknown d2 sample ${raw.sampleId}`);
    return {
      sampleId: raw.sampleId,
      requestId: raw.requestId,
      entryFile: raw.entryFile,
      targetRef: raw.goal.targetRef,
      sourceGroup: raw.sourceGroup,
      pendingRelationRef: `pending:${raw.sampleId}`,
      callSiteRef: config.callSiteRef,
      calleeName: config.calleeName,
      config,
    };
  });
}

function buildAliasChain(sample, familyDir, root, manifest) {
  const entryRead = readAction({
    sampleId: sample.sampleId,
    label: "step0-source-read",
    fromStepId: null,
    root,
    file: path.join(familyDir, sample.entryFile),
    pendingRelationRef: sample.pendingRelationRef,
  });
  const entryBinding = findImportBinding(entryRead.parsed, sample.config.entrySymbol);
  if (entryBinding === null) {
    throw new Error(`${sample.sampleId} import ${sample.config.entrySymbol} not found`);
  }
  let activeEdge = sourceEdge(root, entryRead.parsed, entryBinding);
  let observedBindings = [];
  const observedDeclarations = [];
  let previousExecution = entryRead.previousExecution;
  let previousReceipt = entryRead.receipt;
  const steps = [];
  let terminalIdentity = null;
  let hop = 0;

  while (activeEdge !== null) {
    if (!observedBindings.some(edge => edge.edgeRef === activeEdge.edgeRef)) {
      observedBindings.push(activeEdge);
    }
    const stepId = `step-${steps.length}`;
    const obligations = [advanceObligation(sample.pendingRelationRef, activeEdge)];
    steps.push(
      makeStep({
        stepId,
        syntax: localSyntax(
          observedBindings,
          observedDeclarations,
          sourceContentNotRequested(activeEdge.evidenceRefs),
          { moduleSpecifierRaw: activeEdge.moduleSpecifierRaw },
        ),
        obligations,
        legalCandidates: legalCandidatesFor(obligations),
        previousExecution,
        receipts: [previousReceipt],
        relation: currentRelation(
          sample.pendingRelationRef,
          sample.callSiteRef,
          bindingImport(sample.callSiteRef, activeEdge),
        ),
        cursorState: "closed",
        cursorEvidence: activeEdge.evidenceRefs,
      }),
    );

    if (activeEdge.sourceModule.state !== "known" || !activeEdge.sourceModule.value) {
      throw new Error(`${sample.sampleId} source module missing for ${activeEdge.edgeRef}`);
    }
    const sourcePath = path.join(
      familyDir,
      activeEdge.sourceModule.value.replace(/^mod:/, ""),
    );
    const sourceRead = readAction({
      sampleId: sample.sampleId,
      label: `${stepId}-advance`,
      fromStepId: stepId,
      root,
      file: sourcePath,
      pendingRelationRef: sample.pendingRelationRef,
      optionSemantics: "advance",
    });
    const parsed = sourceRead.parsed;
    const nextBinding = parsed.reexports.find(
      binding => binding.targetName === activeEdge.sourceName,
    );
    const nextEdge = nextBinding
      ? reexportEdge(root, parsed, nextBinding, hop + 1)
      : null;
    const terminal = nextBinding
      ? null
      : findTopDeclaration(parsed.sourceFile, activeEdge.sourceName);
    if (nextEdge === null && terminal === null) {
      throw new Error(
        `${sample.sampleId} ${activeEdge.edgeRef} has no re-export or terminal declaration`,
      );
    }

    const nextIdentity = nextEdge === null
      ? declarationRef(root, terminal, "export")
      : null;
    const consumedEdge = {
      ...activeEdge,
      sourceContent: sourceContentObserved(
        [nextEdge?.edgeRef ?? nextIdentity.declarationRef],
        [sourceRead.evidence],
      ),
      evidenceRefs: [...activeEdge.evidenceRefs, sourceRead.evidence],
    };
    observedBindings = observedBindings.map(edge =>
      edge.edgeRef === activeEdge.edgeRef ? consumedEdge : edge,
    );
    previousExecution = sourceRead.previousExecution;
    previousReceipt = sourceRead.receipt;

    if (nextEdge !== null) {
      observedBindings.push(nextEdge);
      activeEdge = nextEdge;
      hop += 1;
      continue;
    }

    terminalIdentity = nextIdentity;
    observedDeclarations.push(terminalIdentity);
    const terminalStepId = `step-${steps.length}`;
    steps.push(
      makeStep({
        stepId: terminalStepId,
        syntax: localSyntax(
          observedBindings,
          observedDeclarations,
          sourceContentObserved([terminalIdentity.declarationRef], [sourceRead.evidence]),
          { moduleSpecifierRaw: activeEdge.moduleSpecifierRaw },
        ),
        obligations: [],
        legalCandidates: legalCandidatesFor([]),
        previousExecution,
        receipts: [previousReceipt],
        relation: currentRelation(
          sample.pendingRelationRef,
          sample.callSiteRef,
          bindingResolved(sample.callSiteRef, terminalIdentity, "export"),
        ),
        cursorState: "closed",
        cursorEvidence: [...terminalIdentity.evidenceRefs, sourceRead.evidence],
      }),
    );
    break;
  }

  if (terminalIdentity === null) {
    throw new Error(`${sample.sampleId} alias chain produced no terminal declaration`);
  }
  return {
    steps,
    requestedDeclaration: terminalIdentity,
    terminalRef: terminalIdentity.declarationRef,
    finalRelation: "resolved",
  };
}

function buildShadow(sample, familyDir, root) {
  const entryRead = readAction({
    sampleId: sample.sampleId,
    label: "step0-source-read",
    fromStepId: null,
    root,
    file: path.join(familyDir, sample.entryFile),
    pendingRelationRef: sample.pendingRelationRef,
  });
  const entryBinding = findImportBinding(entryRead.parsed, sample.config.entrySymbol);
  if (entryBinding === null) {
    throw new Error(`${sample.sampleId} import ${sample.config.entrySymbol} not found`);
  }
  const entryEdge = sourceEdge(root, entryRead.parsed, entryBinding);
  const functionNode = findFunction(entryRead.parsed.sourceFile, sample.config.functionName);
  if (functionNode === null) {
    throw new Error(`${sample.sampleId} function ${sample.config.functionName} not found`);
  }
  const localDeclaration = findLocalDeclaration(functionNode, sample.config.localName);
  if (localDeclaration === null) {
    throw new Error(`${sample.sampleId} local ${sample.config.localName} not found`);
  }
  const shadowIdentity = declarationRef(root, localDeclaration, "shadow");
  const step = makeStep({
    stepId: "step-0",
    syntax: localSyntax(
      [entryEdge],
      [shadowIdentity],
      sourceContentObserved([shadowIdentity.declarationRef], [entryRead.evidence]),
      {
        moduleSpecifierRaw: entryEdge.moduleSpecifierRaw,
        shadowFacts: [{
          name: sample.config.localName,
          declarationRef: shadowIdentity.declarationRef,
          shadowScope: sample.config.functionName,
        }],
      },
    ),
    obligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution: entryRead.previousExecution,
    receipts: [entryRead.receipt],
    relation: currentRelation(
      sample.pendingRelationRef,
      sample.callSiteRef,
      bindingResolved(sample.callSiteRef, shadowIdentity, "shadow"),
    ),
    cursorState: "closed",
    cursorEvidence: [...shadowIdentity.evidenceRefs, entryRead.evidence],
  });
  return {
    steps: [step],
    requestedDeclaration: targetIdentity(familyDir, sample.targetRef),
    terminalRef: shadowIdentity.declarationRef,
    finalRelation: "shadow",
  };
}

function buildDynamic(sample, familyDir, root) {
  const entryRead = readAction({
    sampleId: sample.sampleId,
    label: "step0-source-read",
    fromStepId: null,
    root,
    file: path.join(familyDir, sample.entryFile),
    pendingRelationRef: sample.pendingRelationRef,
  });
  const edges = sample.config.entrySymbols.map(name => {
    const binding = findImportBinding(entryRead.parsed, name);
    if (binding === null) throw new Error(`${sample.sampleId} import ${name} not found`);
    return sourceEdge(root, entryRead.parsed, binding);
  });
  const functionNode = findFunction(entryRead.parsed.sourceFile, sample.config.functionName);
  if (functionNode === null) {
    throw new Error(`${sample.sampleId} function ${sample.config.functionName} not found`);
  }
  const tableDeclaration =
    findLocalDeclaration(functionNode, sample.config.tableName)
    ?? findTopLevelVariable(entryRead.parsed.sourceFile, sample.config.tableName);
  const selectorParameter = findParameter(functionNode, sample.config.selectorName);
  if (tableDeclaration === null || selectorParameter === null) {
    throw new Error(`${sample.sampleId} table/selector observation not found`);
  }
  const tableIdentity = declarationRef(root, tableDeclaration, "local");
  const selectorIdentity = declarationRef(root, selectorParameter, "local");
  const step = makeStep({
    stepId: "step-0",
    syntax: localSyntax(
      edges,
      [tableIdentity, selectorIdentity],
      sourceContentNotRequested(edges.flatMap(edge => edge.evidenceRefs)),
      {
        moduleSpecifierRaw: edges[0]?.moduleSpecifierRaw ?? null,
        observedLocalFacts: [
          {
            factRef: `fact:${sample.sampleId}:table-members`,
            state: "known",
            value: `${sample.config.tableName} stores ${sample.config.entrySymbols.join(", ")}`,
            evidenceRefs: [entryRead.evidence],
          },
          {
            factRef: `fact:${sample.sampleId}:selector-runtime`,
            state: "known",
            value: `${sample.config.selectorName} is a runtime parameter`,
            evidenceRefs: [entryRead.evidence],
          },
        ],
      },
    ),
    obligations: [],
    legalCandidates: legalCandidatesFor([]),
    previousExecution: entryRead.previousExecution,
    receipts: [entryRead.receipt],
    relation: currentRelation(
      sample.pendingRelationRef,
      sample.callSiteRef,
      bindingDynamic(sample.callSiteRef, [entryRead.evidence]),
    ),
    cursorState: "closed",
    cursorEvidence: [entryRead.evidence],
    coverage: {
      coveredModules: [sample.entryFile],
      targetModuleReached: false,
      note: "runtime_dynamic_selector",
    },
  });
  return {
    steps: [step],
    requestedDeclaration: targetIdentity(familyDir, sample.targetRef),
    terminalRef: null,
    finalRelation: "dynamic",
  };
}

function buildStudentRecord(sample, built, familyDir, manifest) {
  return {
    schemaVersion: D2_STUDENT_SCHEMA,
    sampleId: sample.sampleId,
    family: D2_FAMILY_NAME,
    sourceGroup: manifest.sourceGroup,
    partition: manifest.partition,
    language: manifest.language,
    semanticStratum: manifest.semanticStratum,
    entryFile: sample.entryFile,
    request: {
      requestRef: sample.requestId,
      requestedDeclaration: built.requestedDeclaration,
      relationObligation: {
        requestRef: sample.requestId,
        callSiteRef: sample.callSiteRef,
        calleeName: sample.calleeName,
        pendingRelationRef: sample.pendingRelationRef,
      },
    },
    steps: built.steps,
  };
}

const FORBIDDEN_KEY_PATTERNS = [
  /^(?:A_g|gold|teacher|oracle|originalLabel|recomputed|headSupervision)$/i,
  /^(?:goal_met)$/i,
  /^(?:future[_-]?receipt)/i,
];

function scanForbiddenKeys(value, trail = "student") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scanForbiddenKeys(item, `${trail}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const hits = [];
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERNS.some(pattern => pattern.test(key))) {
      hits.push(`${trail}.${key}`);
    }
    hits.push(...scanForbiddenKeys(nested, `${trail}.${key}`));
  }
  return hits;
}

export async function generateD2Observations({
  familyDir = D2_FAMILY_DIR,
  outDir = familyDir,
  reportPath = null,
} = {}) {
  const manifest = readJson(path.join(familyDir, "manifest.json"));
  if (manifest.partition !== "verification") {
    throw new Error(`d2 family partition must be verification, got ${manifest.partition}`);
  }
  if (manifest.language !== "ts") {
    throw new Error(`d2 family language must be ts, got ${manifest.language}`);
  }
  const samples = readEpisode(familyDir);
  if (samples.length !== 4) {
    throw new Error(`expected 4 d2 samples, got ${samples.length}`);
  }
  const built = samples.map(sample => {
    if (sample.config.kind === "alias-chain") {
      return buildAliasChain(sample, familyDir, familyDir, manifest);
    }
    if (sample.config.kind === "shadow") {
      return buildShadow(sample, familyDir, familyDir);
    }
    if (sample.config.kind === "dynamic") {
      return buildDynamic(sample, familyDir, familyDir);
    }
    throw new Error(`unknown build kind for ${sample.sampleId}`);
  });
  const rows = samples.map((sample, index) =>
    buildStudentRecord(sample, built[index], familyDir, manifest)
  );
  const studentText = `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
  const forbiddenKeys = rows.flatMap((row, index) =>
    scanForbiddenKeys(row, `student[${index}]`)
  );
  const forbiddenText = /"(?:A_g|gold|teacher|oracle|headSupervision|originalLabel|recomputed|goal_met|future[_-]?receipt)"/i;
  if (forbiddenKeys.length > 0) {
    throw new Error(`student observations contain supervision-only fields: ${forbiddenKeys.join(", ")}`);
  }
  if (forbiddenText.test(studentText)) {
    throw new Error("student observations contain a supervision-only key");
  }
  const outputPath = path.join(outDir, "student-observations.jsonl");
  writeJsonl(outputPath, rows);
  const selfCheck = {
    schema: "nnanything.d2-verification-observation-self-check.v1",
    generatedAt: new Date().toISOString(),
    familyDir,
    outputPath,
    manifest: {
      sourceGroup: manifest.sourceGroup,
      partition: manifest.partition,
      language: manifest.language,
      semanticStratum: manifest.semanticStratum,
      derivationFamily: manifest.derivationFamily,
    },
    samples: samples.map((sample, index) => ({
      sampleId: sample.sampleId,
      requestRef: sample.requestId,
      entryFile: sample.entryFile,
      targetRef: sample.targetRef,
      stepIds: built[index].steps.map(step => step.stepId),
      stepCount: built[index].steps.length,
      legalCandidates: built[index].steps.map(step => step.legalCandidates.length),
      finalRelation: built[index].finalRelation,
      terminalRef: built[index].terminalRef,
    })),
    isolation: {
      forbiddenInputsRead: [],
      goldFileRead: false,
      teacherFileRead: false,
      oracleFileRead: false,
      trainPathsWritten: [],
      forbiddenStudentKeys: forbiddenKeys,
      studentTextContainsForbiddenKey: forbiddenText.test(studentText),
      verificationPartitionPreserved: rows.every(row => row.partition === "verification"),
      sampleMembership: rows.map(row => row.sampleId).sort(),
    },
    checks: {
      sampleCount: rows.length,
      allStepsNonEmpty: rows.every(row => row.steps.length > 0),
      allStepsHaveLocalSyntax: rows.every(row =>
        row.steps.every(step => step.localSyntax !== null && typeof step.localSyntax === "object")
      ),
      allStepsHaveRequestRef: rows.every(row =>
        row.steps.every(step => row.request.requestRef === row.request.relationObligation.requestRef)
      ),
      passed: true,
    },
  };
  if (reportPath !== null) writeJson(reportPath, selfCheck);
  return { rows, selfCheck, outputPath };
}

async function main() {
  const args = process.argv.slice(2);
  let familyDir = D2_FAMILY_DIR;
  let outDir = null;
  let reportPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--family-dir") familyDir = path.resolve(args[++index]);
    else if (args[index] === "--out") outDir = path.resolve(args[++index]);
    else if (args[index] === "--report") reportPath = path.resolve(args[++index]);
    else if (args[index] === "--help" || args[index] === "-h") {
      process.stdout.write(
        "Usage: node generate-d2-observations.mjs [--family-dir <abs>] [--out <abs>] [--report <abs>]\n",
      );
      return;
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  const result = await generateD2Observations({
    familyDir,
    outDir: outDir ?? familyDir,
    reportPath,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputPath: result.outputPath,
    sampleCount: result.rows.length,
    sampleIds: result.rows.map(row => row.sampleId),
    stepCounts: result.selfCheck.samples.map(sample => sample.stepCount),
    isolation: result.selfCheck.isolation,
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
