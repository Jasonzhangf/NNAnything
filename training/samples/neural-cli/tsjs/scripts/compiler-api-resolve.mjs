// Replayable TypeScript Compiler API evidence for computed property keys.
//
// `tsc` exit code alone does not resolve a relation. This script folds a
// string-concatenation key expression to its compile-time constant, locates
// the single object-literal property carrying that key, and resolves the
// imported binding behind it. It only reads sources through the compiler API;
// it writes nothing.
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "..");

function usage() {
  process.stderr.write(
    "usage: node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs <family-dir>\n",
  );
  process.exit(2);
}

const familyArg = process.argv[2];
if (!familyArg) usage();

const familyDir = join(corpusRoot, familyArg);
const tsconfigPath = join(familyDir, "sources", "tsconfig.json");

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
  );
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  dirname(tsconfigPath),
);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
});
const checker = program.getTypeChecker();

// TypeScript keeps `"a" + "b"` as a BinaryExpression; fold it ourselves.
function foldStringConstant(node, seen = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return foldStringConstant(node.expression, seen);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldStringConstant(node.left, seen);
    const right = foldStringConstant(node.right, seen);
    if (typeof left === "string" && typeof right === "string") {
      return left + right;
    }
    return undefined;
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    seen.add(node.text);
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return foldStringConstant(declaration.initializer, seen);
    }
  }
  return undefined;
}

function describeBinding(identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return null;
  const target =
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = target.valueDeclaration ?? target.declarations?.[0] ?? null;
  if (!declaration) return { name: target.getName(), declaration: null };
  const sourceFile = declaration.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile),
  );
  return { name: target.getName(), file: sourceFile.fileName, line: line + 1 };
}

// Follow the value type to the terminal declaration. This resolves through
// re-export chains (entry -> index -> local-shadow / factory).
function describeTypeTarget(node) {
  const type = checker.getTypeAtLocation(node);
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const declaration = symbol?.declarations?.[0] ?? null;
  if (!symbol || !declaration) return null;
  const sourceFile = declaration.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile),
  );
  return { name: symbol.getName(), file: sourceFile.fileName, line: line + 1 };
}

function findObjectLiteralProperties(identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const bindingSymbol =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration =
    bindingSymbol?.valueDeclaration ?? bindingSymbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null;
  if (!declaration.initializer) return null;
  if (!ts.isObjectLiteralExpression(declaration.initializer)) return null;
  return {
    declaredType: declaration.type
      ? declaration.type.getText(declaration.getSourceFile())
      : null,
    properties: declaration.initializer.properties.map((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return {
          kind: "shorthand",
          key: property.name.text,
          valueIdentifier: property.name.text,
          node: property,
        };
      }
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        ts.isIdentifier(property.initializer)
      ) {
        return {
          kind: "assignment",
          key: property.name.text,
          valueIdentifier: property.initializer.text,
          node: property,
        };
      }
      return null;
    }),
  };
}

const stringConstantDeclarations = [];
const tablePropertyResolutions = [];

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) continue;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const folded = foldStringConstant(node.initializer);
      if (typeof folded === "string") {
        stringConstantDeclarations.push({
          name: node.name.text,
          sourceText: node.initializer.getText(sourceFile),
          foldedValue: folded,
          file: sourceFile.fileName,
        });
      }
    }

    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const key = foldStringConstant(node.argumentExpression);
      const tableSymbol = checker.getSymbolAtLocation(node.expression);
      const tableBindingSymbol =
        tableSymbol && tableSymbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(tableSymbol)
          : tableSymbol;
      const objectLiteral = tableBindingSymbol?.valueDeclaration
        ? findObjectLiteralProperties(node.expression)
        : null;
      const matchedProperties = [];
      if (objectLiteral && typeof key === "string") {
        for (const property of objectLiteral.properties) {
          if (property && property.key === key) {
            matchedProperties.push(property);
          }
        }
      }
      const entries = matchedProperties.map((property) => {
        const valueIdentifierNode =
          ts.isShorthandPropertyAssignment(property.node)
            ? property.node.name
            : property.node.initializer;
        return {
          propertyKey: key,
          valueIdentifier: property.valueIdentifier,
          resolvesTo: describeBinding(valueIdentifierNode),
          resolvesToTypeDeclaration: describeTypeTarget(valueIdentifierNode),
        };
      });
      tablePropertyResolutions.push({
        expression: node.getText(sourceFile),
        file: sourceFile.fileName,
        foldedKey: typeof key === "string" ? key : null,
        tableDeclaredType: objectLiteral?.declaredType ?? null,
        resolutions: entries,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

process.stdout.write(
  `${JSON.stringify(
    {
      familyDir,
      tsconfigPath,
      typescriptVersion: ts.version,
      stringConstantDeclarations,
      tablePropertyResolutions,
      conclusion: {
        hasCompileTimeStringConstant: stringConstantDeclarations.length > 0,
        elementAccessKeyIsCompileTimeConstant: tablePropertyResolutions.every(
          (entry) => entry.foldedKey !== null,
        ),
        resolvedBindings: tablePropertyResolutions.flatMap((entry) =>
          entry.resolutions.map(
            (resolution) =>
              resolution.resolvesToTypeDeclaration?.name ??
              resolution.resolvesTo?.name ??
              null,
          ),
        ),
        resolvedDeclarations: tablePropertyResolutions.flatMap((entry) =>
          entry.resolutions.map((resolution) =>
            resolution.resolvesToTypeDeclaration
              ? `${resolution.resolvesToTypeDeclaration.file}:${resolution.resolvesToTypeDeclaration.line}`
              : null,
          ),
        ),
      },
    },
    null,
    2,
  )}\n`,
);
