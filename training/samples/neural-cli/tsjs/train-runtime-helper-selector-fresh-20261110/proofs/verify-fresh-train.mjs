// Independent proof + raw public-producer observation for the fresh TRAIN
// helper-selector family.
//
// The driver:
//   1. calls the public `runTsJsSymbolTable` producer on each case and writes
//      the raw output (`receipts/public-producer-output.json`);
//   2. runs a TypeScript compiler structural query and a controlled runtime
//      contrast for each case and writes `receipts/raw-checks.json`.
//
// Proof-side results (selector values, reached callables, oracle results) are
// written only to these receipts. They are never placed in a student
// observation. The driver does not fit, score, convert, admit, or read any DEV
// or verification family.
//
// Replay: `node proofs/verify-fresh-train.mjs` from this family directory.

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const proofsDir = dirname(fileURLToPath(import.meta.url));
const familyRoot = resolve(proofsDir, "..");
const receiptsDir = join(familyRoot, "receipts");
const require = createRequire(import.meta.url);

async function findWorktree(start) {
  let current = start;
  for (let guard = 0; guard < 40; guard += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      const hasTsconfig = await readFile(join(current, "tsconfig.json"), "utf8")
        .then(() => true)
        .catch(() => false);
      if (pkg.name === "nnanything" && hasTsconfig) return current;
    } catch {
      // keep walking up
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new Error("worktree root not found");
}

const worktree = await findWorktree(familyRoot);
const ts = require(join(worktree, "node_modules/typescript"));
const adapter = await import(
  pathToFileURL(join(worktree, "dist/adapters/cli/tsjs-symbol-table-adapter.js")).href
);

const targets = [
  {
    id: "tr-f01-direct-import-block",
    files: [
      "sources/tr-f01-direct-import-block/routes.ts",
      "sources/tr-f01-direct-import-block/strategies.ts",
    ],
    entryFile: "sources/tr-f01-direct-import-block/routes.ts",
    helperFile: "sources/tr-f01-direct-import-block/strategies.ts",
    callText: "parserFor(strategy)(raw)",
    helperDeclaration: "parserFor",
    tableName: "parsers",
    selectorConstruction: "direct caller parameter",
    callSiteLayout: "result captured in a const and returned",
    probe: {
      exportName: "parsePayload",
      argumentSets: [
        ["strict", "  hi  "],
        ["loose", "  hi  "],
      ],
      expected: ["hi", "  hi  "],
    },
  },
  {
    id: "tr-f02-alias-single-module",
    files: ["sources/tr-f02-alias-single-module/formatter.ts"],
    entryFile: "sources/tr-f02-alias-single-module/formatter.ts",
    helperFile: "sources/tr-f02-alias-single-module/formatter.ts",
    callText: "styleFor(chosen)(amount)",
    helperDeclaration: "styleFor",
    tableName: "styles",
    selectorConstruction: "one immutable local alias",
    callSiteLayout: "single straight-line return",
    probe: {
      exportName: "renderAmount",
      argumentSets: [
        ["currency", 12.5],
        ["percent", 12.5],
      ],
      expected: ["$12.50", "1250.0%"],
    },
  },
  {
    id: "tr-f03-direct-nested-block",
    files: [
      "sources/tr-f03-direct-nested-block/index.ts",
      "sources/tr-f03-direct-nested-block/operations.ts",
    ],
    entryFile: "sources/tr-f03-direct-nested-block/index.ts",
    helperFile: "sources/tr-f03-direct-nested-block/operations.ts",
    callText: "stepperFor(step)(base)",
    helperDeclaration: "stepperFor",
    tableName: "steppers",
    selectorConstruction: "direct caller parameter",
    callSiteLayout: "return inside one nested block statement",
    probe: {
      exportName: "advanceStep",
      argumentSets: [
        ["add", 41],
        ["multiply", 41],
      ],
      expected: [42, 82],
    },
  },
];

const controls = [
  {
    id: "control-static-selector",
    files: ["controls/static-selector.ts"],
    reason: "constant selector literal; produces no runtime-selector role",
  },
  {
    id: "control-direct-index",
    files: ["controls/direct-index.ts"],
    reason: "direct table-index call site; outside the reviewed helper slice",
  },
];

function requireNode(condition, message) {
  if (!condition) throw new Error(message);
}

function unwrapExpression(node) {
  let current = node;
  while (current !== undefined) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return node;
}

function lineOf(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function formatDiagnostic(diagnostic) {
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
}

function findCall(sourceFile, callText) {
  let match = null;
  const visit = node => {
    if (match === null && ts.isCallExpression(node) && node.getText(sourceFile) === callText) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return match;
}

function findFunctionDeclaration(sourceFile, name) {
  let match = null;
  const visit = node => {
    if (
      match === null &&
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.getText(sourceFile) === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return match;
}

const compilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  skipLibCheck: true,
};

function structuralCheck(caseRecord) {
  const rootNames = caseRecord.files.map(file => join(familyRoot, file));
  const program = ts.createProgram(rootNames, { ...compilerOptions, noEmit: true });
  const checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program).map(formatDiagnostic);
  requireNode(diagnostics.length === 0, `${caseRecord.id}: compiler diagnostics: ${diagnostics.join("; ")}`);

  const entryFile = program.getSourceFile(join(familyRoot, caseRecord.entryFile));
  const helperFile = program.getSourceFile(join(familyRoot, caseRecord.helperFile));
  requireNode(entryFile !== undefined, `${caseRecord.id}: missing entry source`);
  requireNode(helperFile !== undefined, `${caseRecord.id}: missing helper source`);

  const helperDeclaration = findFunctionDeclaration(helperFile, caseRecord.helperDeclaration);
  requireNode(helperDeclaration !== null, `${caseRecord.id}: helper declaration not found`);
  const helperSymbol = checker.getSymbolAtLocation(helperDeclaration.name);
  const helperDeclarations = helperSymbol?.getDeclarations?.() ?? [];
  requireNode(helperSymbol !== undefined, `${caseRecord.id}: helper symbol unresolved`);

  const parameters = helperDeclaration.parameters.map(parameter => parameter.name.getText(helperFile));
  requireNode(parameters.length === 1, `${caseRecord.id}: helper must take exactly one parameter`);
  const body = helperDeclaration.body;
  requireNode(body !== undefined && ts.isBlock(body), `${caseRecord.id}: helper body is not a block`);
  requireNode(
    body.statements.length === 1 && ts.isReturnStatement(body.statements[0]),
    `${caseRecord.id}: helper is not a single straight-line return`,
  );
  const returnExpression = body.statements[0].expression;
  requireNode(
    returnExpression !== undefined && ts.isElementAccessExpression(returnExpression),
    `${caseRecord.id}: helper return is not an element access`,
  );
  const tableIdentifier = returnExpression.expression;
  const selectorArgument = returnExpression.argumentExpression;
  requireNode(ts.isIdentifier(tableIdentifier), `${caseRecord.id}: table reference is not an identifier`);
  requireNode(ts.isIdentifier(selectorArgument), `${caseRecord.id}: selector argument is not an identifier`);
  const tableName = tableIdentifier.getText(helperFile);
  requireNode(tableName === caseRecord.tableName, `${caseRecord.id}: unexpected table name ${tableName}`);
  requireNode(
    parameters.includes(selectorArgument.getText(helperFile)),
    `${caseRecord.id}: helper return does not index the table by its parameter`,
  );

  const tableSymbol = checker.getSymbolAtLocation(tableIdentifier);
  requireNode(tableSymbol !== undefined, `${caseRecord.id}: table symbol unresolved`);
  const tableDeclarations = tableSymbol.getDeclarations?.() ?? [];
  const tableVariable = tableDeclarations.find(ts.isVariableDeclaration);
  requireNode(tableVariable !== undefined, `${caseRecord.id}: table symbol is not a variable declaration`);
  const tableInitializer = tableVariable.initializer === undefined
    ? undefined
    : unwrapExpression(tableVariable.initializer);
  requireNode(
    tableInitializer !== undefined && ts.isObjectLiteralExpression(tableInitializer),
    `${caseRecord.id}: table declaration is not an object literal`,
  );
  const propertyAssignments = tableInitializer.properties.filter(ts.isPropertyAssignment);
  requireNode(propertyAssignments.length >= 2, `${caseRecord.id}: table has fewer than two members`);
  const tableMembers = propertyAssignments.map(property => {
    const position = lineOf(helperFile, property);
    return {
      key: property.name.getText(helperFile),
      file: caseRecord.helperFile,
      line: position.line,
      column: position.column,
      initializerKind: ts.SyntaxKind[property.initializer.kind],
      initializerText: property.initializer.getText(helperFile),
      callable: ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer),
    };
  });
  const memberKeys = tableMembers.map(member => member.key);
  requireNode(new Set(memberKeys).size === memberKeys.length, `${caseRecord.id}: table member keys not unique`);
  requireNode(tableMembers.every(member => member.callable), `${caseRecord.id}: a table member is not callable`);

  const call = findCall(entryFile, caseRecord.callText);
  requireNode(call !== null, `${caseRecord.id}: outer call site ${caseRecord.callText} not found`);
  const innerCall = call.expression;
  requireNode(ts.isCallExpression(innerCall), `${caseRecord.id}: outer callee is not a helper call`);
  const innerCallee = innerCall.expression;
  requireNode(
    ts.isIdentifier(innerCallee) && innerCallee.getText(entryFile) === caseRecord.helperDeclaration,
    `${caseRecord.id}: outer call does not invoke the requested helper`,
  );
  requireNode(innerCall.arguments.length === 1, `${caseRecord.id}: helper call must pass one selector`);
  const selectorExpressionText = innerCall.arguments[0].getText(entryFile);
  const payloadTexts = call.arguments.map(argument => argument.getText(entryFile));
  const callPosition = lineOf(entryFile, call);

  const helperParameterName = parameters[0];
  let selectorPath;
  if (selectorExpressionText === helperParameterName) {
    selectorPath = { kind: "direct caller parameter", expressionText: selectorExpressionText };
  } else {
    let aliasDeclaration = null;
    const collectAlias = node => {
      if (
        aliasDeclaration === null &&
        ts.isVariableDeclaration(node) &&
        node.name.getText(entryFile) === selectorExpressionText
      ) {
        aliasDeclaration = node;
        return;
      }
      ts.forEachChild(node, collectAlias);
    };
    collectAlias(entryFile);
    requireNode(aliasDeclaration !== null, `${caseRecord.id}: selector is neither parameter nor alias`);
    const declarationList = aliasDeclaration.parent;
    requireNode(
      ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0,
      `${caseRecord.id}: selector alias is not const`,
    );
    requireNode(
      aliasDeclaration.initializer !== undefined &&
        aliasDeclaration.initializer.getText(entryFile) === helperParameterName,
      `${caseRecord.id}: selector alias does not forward the parameter unchanged`,
    );
    selectorPath = {
      kind: "one immutable local alias",
      expressionText: selectorExpressionText,
      aliasDeclarationText: aliasDeclaration.parent.parent.getText(entryFile).trim(),
    };
  }

  return {
    id: caseRecord.id,
    files: caseRecord.files,
    selectorConstruction: caseRecord.selectorConstruction,
    callSiteLayout: caseRecord.callSiteLayout,
    diagnostics,
    compilerQuery: {
      api: "ts.createProgram + program.getTypeChecker().getSymbolAtLocation",
      queriedNodes: [
        {
          query: "getSymbolAtLocation(helper name identifier)",
          file: caseRecord.helperFile,
          text: caseRecord.helperDeclaration,
          result: "resolved symbol",
          declarations: helperDeclarations.length,
        },
        {
          query: "getSymbolAtLocation(table reference identifier)",
          file: caseRecord.helperFile,
          text: tableName,
          result: "resolved symbol",
          declarations: tableDeclarations.length,
        },
      ],
      scope: "the exact case file set passed as rootNames to the TypeScript program",
      notUsed: "no symbol query on the outer CallExpression callee is used as evidence",
    },
    resolvedHelper: {
      name: caseRecord.helperDeclaration,
      parameterNames: parameters,
      statements: body.statements.length,
      returnExpression: returnExpression.getText(helperFile),
    },
    resolvedTable: { name: tableName, members: tableMembers },
    outerCall: {
      callText: caseRecord.callText,
      file: caseRecord.entryFile,
      line: callPosition.line,
      column: callPosition.column,
      payloadTexts,
    },
    selectorPath,
    selectorDomain: memberKeys.slice().sort(),
  };
}

async function runtimeContrast(caseRecord) {
  // Disposable compiled modules live outside the repository; only the JSON
  // receipts are committed.
  const buildRoot = await mkdtemp(join(tmpdir(), "tsjs-fresh-train-"));
  const outDir = join(buildRoot, caseRecord.id);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");

  const rootNames = caseRecord.files.map(file => join(familyRoot, file));
  const program = ts.createProgram(rootNames, { ...compilerOptions, rootDir: familyRoot, outDir });
  const emitResult = program.emit();
  requireNode(!emitResult.emitSkipped, `${caseRecord.id}: emit skipped`);

  const helperJs = join(outDir, caseRecord.helperFile.replace(/\.ts$/, ".js"));
  await appendFile(
    helperJs,
    `\nexports.__proofTable = ${caseRecord.tableName};\nexports.__proofHelper = ${caseRecord.helperDeclaration};\n`,
    "utf8",
  );

  const helperModule = require(helperJs);
  const entryModule = require(join(outDir, caseRecord.entryFile.replace(/\.ts$/, ".js")));
  const proofHelper = helperModule.__proofHelper;
  const proofTable = helperModule.__proofTable;
  requireNode(typeof proofHelper === "function", `${caseRecord.id}: proof helper missing`);
  requireNode(proofTable !== undefined, `${caseRecord.id}: proof table missing`);
  const exportValue = entryModule[caseRecord.probe.exportName];
  requireNode(typeof exportValue === "function", `${caseRecord.id}: caller export missing`);

  const perSelector = [];
  for (let index = 0; index < caseRecord.probe.argumentSets.length; index += 1) {
    const [selector, payload] = caseRecord.probe.argumentSets[index];
    const reached = proofHelper(selector);
    const tableMember = proofTable[selector];
    const outerResult = exportValue(selector, payload);
    const memberResult = tableMember(payload);
    perSelector.push({
      selector,
      payload,
      referenceEqual: reached === tableMember,
      reachedCallableName: typeof reached?.name === "string" ? reached.name : null,
      reachedCallableKind: typeof reached,
      outerCallResult: outerResult,
      reachedMemberResult: memberResult,
      outerCallMatchesMember: JSON.stringify(outerResult) === JSON.stringify(memberResult),
      expected: caseRecord.probe.expected[index],
      matchesExpected: JSON.stringify(outerResult) === JSON.stringify(caseRecord.probe.expected[index]),
    });
  }
  const distinctCallables =
    proofTable[caseRecord.probe.argumentSets[0][0]] !==
    proofTable[caseRecord.probe.argumentSets[1][0]];

  const allEqual = perSelector.every(
    entry => entry.referenceEqual && entry.outerCallMatchesMember && entry.matchesExpected,
  );
  const result = {
    id: caseRecord.id,
    method:
      "compile the case to CommonJS in a disposable dir, append proof-only exports for the helper module, require it, and compare the reached callable with the outer call result",
    perSelector,
    distinctCallables,
    status: allEqual && distinctCallables ? "ok" : "failed",
  };
  await rm(buildRoot, { recursive: true, force: true });
  return result;
}

async function observe(entry) {
  const request = {
    repo: familyRoot,
    language: "typescript",
    scope: ["."],
    files: entry.files,
  };
  const outcome = await adapter.runTsJsSymbolTable(request);
  if (outcome.status !== "ok") return { id: entry.id, request, status: outcome.status, outcome };
  const result = outcome.result;
  return {
    id: entry.id,
    request,
    status: "ok",
    coverage: {
      partial: result.coverage.partial,
      scopeFilesDiscovered: result.coverage.scopeFilesDiscovered,
      scopeFilesParsed: result.coverage.scopeFilesParsed,
      scopeFilesFailed: result.coverage.scopeFilesFailed,
      skipped: result.coverage.skipped,
      parseErrorFiles: result.coverage.parseErrorFiles,
      partialReasons: result.coverage.partialReasons,
    },
    parser: result.parser,
    runtimeSelectorObservations: result.runtimeSelectorObservations,
    runtimeSelectorGaps: result.runtimeSelectorGaps,
    observationCount: result.runtimeSelectorObservations.length,
    gapCount: result.runtimeSelectorGaps.length,
  };
}

await mkdir(receiptsDir, { recursive: true });

const producerReport = {
  schema: "nnanything.tsjs.helper-source-public-producer.v1",
  producer: "runTsJsSymbolTable@dist/adapters/cli/tsjs-symbol-table-adapter.js",
  family: "train-runtime-helper-selector-fresh-20261110",
  partition: "TRAIN",
  familyRoot,
  targets: [],
  controls: [],
};
for (const target of targets) producerReport.targets.push(await observe(target));
for (const control of controls) {
  const observed = await observe(control);
  observed.controlReason = control.reason;
  producerReport.controls.push(observed);
}
await writeFile(
  join(receiptsDir, "public-producer-output.json"),
  `${JSON.stringify(producerReport, null, 2)}\n`,
  "utf8",
);

const checksReport = {
  schema: "nnanything.tsjs.helper-source-checks.fresh-train.v1",
  family: "train-runtime-helper-selector-fresh-20261110",
  partition: "TRAIN",
  compilerVersion: ts.version,
  structural: [],
  runtimeContrast: [],
  status: "CHECKS_INCOMPLETE",
};
try {
  for (const caseRecord of targets) {
    checksReport.structural.push(structuralCheck(caseRecord));
    checksReport.runtimeContrast.push(await runtimeContrast(caseRecord));
  }
  const structuralOk = checksReport.structural.length === targets.length;
  const runtimeOk = checksReport.runtimeContrast.every(entry => entry.status === "ok");
  checksReport.status = structuralOk && runtimeOk ? "CHECKS_COMPLETE" : "CHECKS_INCOMPLETE";
} catch (error) {
  checksReport.error = String(error && error.stack ? error.stack : error);
}
await writeFile(join(receiptsDir, "raw-checks.json"), `${JSON.stringify(checksReport, null, 2)}\n`, "utf8");

console.log(`producer: ${producerReport.targets.map(t => `${t.id}=${t.observationCount}`).join(" ")}`);
console.log(`controls: ${producerReport.controls.map(c => `${c.id}=${c.observationCount}`).join(" ")}`);
console.log(`checks: ${checksReport.status}`);
for (const entry of checksReport.runtimeContrast) {
  console.log(
    `${entry.id}: ${entry.status} distinct=${entry.distinctCallables} ` +
      entry.perSelector.map(item => `${item.selector}->${item.reachedCallableName}`).join(", "),
  );
}
if (checksReport.error) {
  console.error(checksReport.error);
  process.exitCode = 1;
}
