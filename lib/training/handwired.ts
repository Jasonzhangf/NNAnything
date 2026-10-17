import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface HandwiredModule {
  readonly Circuit: new (sourceSize: number) => HandwiredCircuit;
}

export interface HandwiredCircuit {
  readonly sourceSize: number;
  readonly operations: readonly unknown[];
  source(index: number): HandwiredWire;
  constant(value: number): HandwiredWire;
  assumeRange(wire: HandwiredWire, minimum: number, maximum: number): void;
  affine(terms: HandwiredTerms, bias?: number): HandwiredWire;
  multiply(left: HandwiredWire, right: HandwiredWire): HandwiredWire;
  reglu(leftTerms: HandwiredTerms, leftBias: number, gateTerms: HandwiredTerms, gateBias: number): HandwiredWire;
  evaluateReference(source: Float32Array): Float32Array;
  backpropagateReference(values: Float32Array, outputGradients: Float32Array): Float32Array;
}

export type HandwiredWire = number & { readonly __handwiredWire?: never };
export type HandwiredTerms = readonly (readonly [wire: HandwiredWire, coefficient: number])[];

const moduleCache = new Map<string, Promise<HandwiredModule>>();

export function loadHandwired(handwiredRoot: string): Promise<HandwiredModule> {
  if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) {
    return Promise.reject(new TypeError("handwiredRoot must be an explicit non-empty path"));
  }
  const root = resolve(handwiredRoot);
  const cached = moduleCache.get(root);
  if (cached !== undefined) return cached;
  const loading = loadHandwiredUncached(root);
  moduleCache.set(root, loading);
  loading.catch(() => moduleCache.delete(root));
  return loading;
}

async function loadHandwiredUncached(root: string): Promise<HandwiredModule> {
  const sourcePath = join(root, "src/runtime/numeric-ui-core.ts");
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new Error(`Handwired core is missing: ${sourcePath}`, { cause: error });
  }
  let typescript: typeof import("typescript");
  try {
    typescript = await import("typescript");
  } catch (error) {
    throw new Error("Handwired loading requires the installed TypeScript package", { cause: error });
  }
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ESNext,
      sourceMap: false,
      inlineSourceMap: false,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  if (transpiled.diagnostics?.some(diagnostic => diagnostic.category === typescript.DiagnosticCategory.Error)) {
    const details = typescript.formatDiagnostics(transpiled.diagnostics, {
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    });
    throw new Error(`Handwired TypeScript transpilation failed:\n${details}`);
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  const loaded = await import(dataUrl).catch(error => {
    throw new Error(`Handwired core import failed: ${sourcePath}`, { cause: error });
  }) as Partial<HandwiredModule>;
  if (typeof loaded.Circuit !== "function") throw new TypeError("Handwired core does not export Circuit");
  return loaded as HandwiredModule;
}
