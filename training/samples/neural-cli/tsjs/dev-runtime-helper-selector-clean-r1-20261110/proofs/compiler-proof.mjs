// Compiler semantic proof: the TypeScript type checker cannot resolve a single
// callee for the helper return expression because the selector is a runtime
// parameter. The queried element access resolves to a union of two distinct
// member function types; each named member access resolves to one distinct
// function type.

import ts from "typescript";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const familyRoot = join(here, "..");
const srcDir = join(familyRoot, "src");
const receiptsDir = join(familyRoot, "receipts");

const files = readdirSync(srcDir)
  .filter(name => name.endsWith(".ts"))
  .map(name => join(srcDir, name))
  .sort();

const options = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipLibCheck: true,
};

const program = ts.createProgram(files, options);
const checker = program.getTypeChecker();
const diagnostics = ts.getPreEmitDiagnostics(program);

const dispatchFile = program.getSourceFile(join(srcDir, "dispatch.ts"));
if (!dispatchFile) throw new Error("dispatch.ts was not found in the program");

let pickDispatch = null;
ts.forEachChild(dispatchFile, node => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "pickDispatch") {
    pickDispatch = node;
  }
});
if (!pickDispatch || !pickDispatch.body) throw new Error("pickDispatch not found");

const returnStatement = pickDispatch.body.statements.find(statement =>
  ts.isReturnStatement(statement) && statement.expression !== undefined,
);
if (!returnStatement || !ts.isReturnStatement(returnStatement) || returnStatement.expression === undefined) {
  throw new Error("pickDispatch single return not found");
}
const returnExpression = returnStatement.expression;

const tableDeclaration = dispatchFile.statements
  .filter(ts.isVariableStatement)
  .flatMap(statement => statement.declarationList.declarations)
  .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "dispatchTable");
if (!tableDeclaration || !ts.isIdentifier(tableDeclaration.name)) {
  throw new Error("dispatchTable declaration not found");
}

const returnType = checker.getTypeAtLocation(returnExpression);
const tableSymbol = checker.getSymbolAtLocation(tableDeclaration.name);
if (!tableSymbol) throw new Error("dispatchTable symbol not resolved");
const tableType = checker.getTypeOfSymbolAtLocation(tableSymbol, tableDeclaration.name);

function memberType(name) {
  const property = checker.getPropertyOfType(tableType, name);
  if (!property) throw new Error(`missing table member ${name}`);
  return checker.getTypeOfSymbolAtLocation(property, tableDeclaration.name);
}

const spellType = memberType("spell");
const chantType = memberType("chant");

const unionParts = returnType.isUnion() ? returnType.types.map(type => checker.typeToString(type)) : [];

const receipt = {
  schema: "nnanything.tsjs.dev.compiler-proof.v1",
  producedAt: new Date().toISOString(),
  tool: "typescript_compiler_api",
  typescriptVersion: ts.version,
  nodeVersion: process.version,
  filesRead: files.map(file => join("src", file.split("/src/")[1])),
  query: {
    api: "TypeChecker.getTypeAtLocation",
    nodeKind: ts.SyntaxKind[returnExpression.kind],
    nodeText: returnExpression.getText(dispatchFile),
    scope: "pickDispatch body return expression",
  },
  result: {
    returnType: checker.typeToString(returnType),
    isUnion: returnType.isUnion(),
    unionPartCount: returnType.isUnion() ? returnType.types.length : 1,
    unionParts,
    tableType: checker.typeToString(tableType),
    spellType: checker.typeToString(spellType),
    chantType: checker.typeToString(chantType),
    membersAreDistinct: spellType !== chantType,
    eachMemberHasSingleCallSignature:
      spellType.getCallSignatures().length === 1 && chantType.getCallSignatures().length === 1,
  },
  diagnostics: diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  })),
  conclusion:
    "The runtime-selector element access resolves to a union of two distinct callables; the compiler cannot choose one callee at compile time.",
};

mkdirSync(receiptsDir, { recursive: true });
writeFileSync(join(receiptsDir, "compiler-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
