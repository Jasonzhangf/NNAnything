import { writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const proofDir = dirname(fileURLToPath(import.meta.url));
const familyRoot = resolve(proofDir, "..");
const files = [
  join(familyRoot, "sources/caller.ts"),
  join(familyRoot, "sources/primary.ts"),
  join(familyRoot, "sources/secondary.ts"),
];

const program = ts.createProgram(files, {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

function sourceFile(path) {
  const found = program.getSourceFile(path);
  if (found === undefined) throw new Error(`compiler API did not load ${path}`);
  return found;
}

function location(source, node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source, false));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: relative(familyRoot, source.fileName),
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function functionDeclaration(source, name) {
  const found = source.statements.find(statement =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === name
  );
  if (found === undefined || !ts.isFunctionDeclaration(found) || found.name === undefined) {
    throw new Error(`compiler API did not find function ${name} in ${source.fileName}`);
  }
  return found;
}

function declarationIdentity(source, declaration) {
  if (declaration.name === undefined) throw new Error("declaration has no name");
  const file = relative(familyRoot, source.fileName);
  const identity = `decl:${file}#top:${declaration.name.text}`;
  return {
    declarationRef: identity,
    moduleRef: `module:${file}`,
    name: declaration.name.text,
    location: location(source, declaration.name),
  };
}

function findCall(source) {
  let found = null;
  const visit = node => {
    if (
      found === null
      && ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "normalize"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === null) throw new Error("compiler API did not find normalize call");
  return found;
}

const callerSource = sourceFile(files[0]);
const primarySource = sourceFile(files[1]);
const secondarySource = sourceFile(files[2]);
const call = findCall(callerSource);
const callSymbol = checker.getSymbolAtLocation(call.expression);
if (callSymbol === undefined) throw new Error("compiler API did not resolve the call symbol");
const resolvedSymbol = (callSymbol.flags & ts.SymbolFlags.Alias) !== 0
  ? checker.getAliasedSymbol(callSymbol)
  : callSymbol;
const resolvedDeclaration = resolvedSymbol.declarations?.find(ts.isFunctionDeclaration);
if (resolvedDeclaration === undefined) throw new Error("compiler API did not resolve a function declaration");
const resolvedSource = resolvedDeclaration.getSourceFile();

const importDeclaration = callerSource.statements.find(statement =>
  ts.isImportDeclaration(statement)
  && ts.isStringLiteral(statement.moduleSpecifier)
  && statement.moduleSpecifier.text === "./primary"
);
if (importDeclaration === undefined || !ts.isImportDeclaration(importDeclaration)) {
  throw new Error("compiler API did not find the ./primary import declaration");
}
const namedBindings = importDeclaration.importClause?.namedBindings;
if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) {
  throw new Error("compiler API did not find named import bindings");
}
const importSpecifier = namedBindings.elements.find(element => element.name.text === "normalize");
if (importSpecifier === undefined) throw new Error("compiler API did not find normalize import");

const primaryDeclaration = functionDeclaration(primarySource, "normalizeReading");
const secondaryDeclaration = functionDeclaration(secondarySource, "normalizeReading");
const primaryIdentity = declarationIdentity(primarySource, primaryDeclaration);
const secondaryIdentity = declarationIdentity(secondarySource, secondaryDeclaration);
const resolvedIdentity = declarationIdentity(resolvedSource, resolvedDeclaration);
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return { code: diagnostic.code, message };
  }
  const point = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    code: diagnostic.code,
    message,
    file: relative(familyRoot, diagnostic.file.fileName),
    line: point.line + 1,
    column: point.character + 1,
  };
});

const receipt = {
  schemaVersion: "nnanything.tsjs.compiler-api-receipt.v1",
  compilerVersion: ts.version,
  invocation: "ts.createProgram + ts.TypeChecker.getSymbolAtLocation/getAliasedSymbol",
  files: files.map(file => relative(familyRoot, file)),
  call: {
    calleeName: call.expression.text,
    location: location(callerSource, call),
  },
  import: {
    moduleSpecifierRaw: importDeclaration.moduleSpecifier.text,
    importedName: importSpecifier.propertyName?.text ?? importSpecifier.name.text,
    localAlias: importSpecifier.name.text,
  },
  resolution: {
    inputDeclaration: resolvedIdentity.declarationRef,
    inputModule: resolvedIdentity.moduleRef,
    inputName: resolvedIdentity.name,
    inputLocation: resolvedIdentity.location,
  },
  primaryDeclaration: primaryIdentity,
  secondaryDeclaration: secondaryIdentity,
  proof: {
    sameDeclarationForPrimaryRequest:
      resolvedIdentity.declarationRef === primaryIdentity.declarationRef,
    sameNameDifferentModuleForSecondaryRequest:
      resolvedIdentity.name === secondaryIdentity.name
      && resolvedIdentity.moduleRef !== secondaryIdentity.moduleRef
      && resolvedIdentity.declarationRef !== secondaryIdentity.declarationRef,
  },
  diagnostics,
};

await writeFile(
  join(proofDir, "compiler-api-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
