import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runTsJsSymbolTable,
} from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  filterTsJsSymbols,
  projectTsJsSymbolTableResult,
  symbolIdFor,
  validateTsJsSymbolRequest,
} from "../dist/filters/tsjs-symbol-table-policy.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import { admitInitialEvidence } from "../dist/adapters/tsjs-unified-recursive.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tsjs-symbols");
const CLEAN_DEV_FAMILY = fileURLToPath(new URL(
  "../training/samples/neural-cli/tsjs/dev-runtime-helper-selector-clean-r1-20261110/",
  import.meta.url,
));

async function loadBridgeRecord(record, manifestOverrides = {}) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-bridge-"));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeFile(join(familyDir, "manifest.json"), JSON.stringify({
      sourceGroup: record.sourceGroup,
      language: record.language,
      semanticStratum: record.semanticStratum,
      partition: record.partition,
      derivationFamily: { familyId: record.family },
      ...manifestOverrides,
    }));
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
}

function bridgeInput(producerRequest, observation, overrides = {}) {
  const requestRef = overrides.requestRef ?? "req:tsjs-bridge-a";
  const pendingRelationRef = overrides.pendingRelationRef ?? "pending:tsjs-bridge-a";
  return {
    sourceGroup: "tsjs-bridge-eng",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-bridge-family",
    sampleId: "bridge-a",
    entryFile: "src/runtime-two-sites.ts",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: "decl:src/runtime-actions.ts#top:chooseAction",
        moduleRef: "module:src/runtime-actions.ts",
        name: "chooseAction",
        role: "export",
        kind: "function",
        evidenceRefs: [],
        ...(overrides.requestedDeclaration ?? {}),
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "chooseAction",
        ...(overrides.relationObligation ?? {}),
      },
    },
    stepId: overrides.stepId ?? "step-0",
    fromStepId: overrides.fromStepId ?? null,
    remainingObligations: overrides.remainingObligations ?? [],
    localCandidateCursor: overrides.localCandidateCursor ?? {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest,
  };
}

function makeFixtures() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
  mkdirSync(join(ROOT, "src"), { recursive: true });

  writeFileSync(join(ROOT, "src", "kinds.ts"),
`export interface I { x: number; m(a: number): string; }
export type T = number;
export enum E { A, B = 2 }
export namespace N {
  export const v = 1;
  export function f() {}
}
export abstract class C {
  public readonly id: string;
  #secret: number;
  static s = 1;
  constructor(public readonly name: string) {}
  get g() { return 1; }
  set w(x: number) {}
  override m(): void {}
  [Symbol.iterator]() {}
  [dynProp] = 1;
}
export const arrowFn = () => {};
export const { a, b: [c] } = obj;
export default function namedDefault() {}
function outer() {
  const tmp = 1;
  function localHelper() {}
}
`);

  writeFileSync(join(ROOT, "src", "cjs.cjs"),
`module.exports = function main() {};
exports.helper = (x) => x;
module.exports.version = "1.0";
module.exports = { a() {}, b: () => {}, c: 1 };
`);
  writeFileSync(join(ROOT, "src", "widget.mjs"),
`export default class Widget {}
`);
  writeFileSync(join(ROOT, "src", "jsx.jsx"),
`export default function App() { return null; }
`);

  writeFileSync(join(ROOT, "src", "ambient.d.ts"),
`declare module "pkg" {
  const x: number;
}
declare interface Global { id: string; }
`);
  writeFileSync(join(ROOT, "src", "broken.ts"),
`export function good() {}
const x = ;
export class Broken {}
`);

  const deep = `const x = ${"1 + ".repeat(3000)}1;`;
  writeFileSync(join(ROOT, "src", "deep.ts"), deep);

  writeFileSync(join(ROOT, "src", "mixed.rs"), "pub fn main() {}\n");

  writeFileSync(join(ROOT, "src", "shadow.cjs"),
`function wrap(module, exports) {
  module.exports = () => {};
  exports.hidden = 1;
}
const exports = {};
exports.localOnly = 2;
`);
  writeFileSync(join(ROOT, "src", "defaults.ts"),
`export default function namedDefault() {}
export default function() {}
`);
  writeFileSync(join(ROOT, "src", "cjs-named.cjs"),
`module.exports = function internalName() {};
`);

  writeFileSync(join(ROOT, "src", "dynamic.ts"),
`class C { [Symbol.iterator]() {} [dynamicProp] = 1; }
`);
  writeFileSync(join(ROOT, "src", "dynamic-cjs.cjs"),
`exports[dynamicKey] = () => {};
`);

  writeFileSync(join(ROOT, "src", "nonbmp.ts"),
`export const emoji = "😀"; export function afterEmoji() {}
`);

  writeFileSync(join(ROOT, "src", "runtime-actions.ts"),
`export type ActionKey = "left" | "right";
const actionMap: Record<ActionKey, (value: number) => number> = {
  left: value => value + 2,
  right: value => value * 5,
};
export function chooseAction(key: ActionKey) {
  return actionMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "runtime-entry.ts"),
`import { chooseAction, type ActionKey } from "./runtime-actions.js";
export function runAction(key: ActionKey, value: number) {
  return chooseAction(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-controls.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function constantAction(value: number) {
  return chooseAction("left")(value);
}
export function directMemberAction(value: number) {
  return chooseAction.left(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-right.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticRight(value: number) {
  return chooseAction("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-missing.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticMissing(value: number) {
  return chooseAction("middle")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-nonliteral.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticNonLiteral(key: string, value: number) {
  return chooseAction(\`\${key}\`)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-const-alias.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticConstAlias(value: number) {
  const selected = "right";
  return chooseAction(selected)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-nested.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticNested(flag: boolean, value: number) {
  if (flag) {
    const selected = "right";
    return chooseAction(selected)(value);
  }
  return value;
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-caller-control.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runStaticCallerControl(value: number) {
  if (value > 0) {
    return chooseAction("right")(value);
  }
  return value;
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-helper-control.ts"),
`const controlledActionMap: Record<"left" | "right", (value: number) => number> = {
  left: value => value + 2,
  right: value => value * 5,
};
export function chooseControlledAction(key: "left" | "right") {
  if (key === "left") {
    return controlledActionMap.left;
  }
  return controlledActionMap.right;
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-helper-control-entry.ts"),
`import { chooseControlledAction } from "./runtime-static-helper-control.js";
export function runStaticHelperControl(value: number) {
  return chooseControlledAction("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-out-of-scope.ts"),
`export function runOutsideCandidate(value: number) {
  const localHelper = (key: string) => key;
  return localHelper("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-no-table.ts"),
`function outsideCandidate(value: string) {
  return value;
}
export function runOutsideCandidate(value: number) {
  return outsideCandidate("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-ambiguous.ts"),
`import { chooseAction } from "./runtime-actions.js";
import { chooseAction } from "./runtime-actions.js";
export function runStaticAmbiguous(value: number) {
  return chooseAction("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-mutated.ts"),
`import { chooseAction } from "./runtime-actions.js";
chooseAction = replacement;
declare const replacement: typeof chooseAction;
export function runStaticMutated(value: number) {
  return chooseAction("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-static-read-failure.ts"),
`import { chooseAction } from "./runtime-not-present.js";
export function runStaticReadFailure(value: number) {
  return chooseAction("right")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-one-actions.ts"),
`const oneMap = {
  left: (value: number) => value + 1,
};
export function chooseOne(key: string) {
  return oneMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "runtime-one-entry.ts"),
`import { chooseOne } from "./runtime-one-actions.js";
export function runOne(key: string, value: number) {
  return chooseOne(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-narrowing.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function narrowed(key: string, value: number) {
  key = "left";
  return chooseAction(key)(value);
}
export function reassigned(key: string, value: number) {
  let alias = key;
  alias = "right";
  return chooseAction(alias)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-shadow-entry.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function shadowed(key: string, value: number) {
  const chooseAction = () => () => value;
  return chooseAction(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-branch-actions.ts"),
`const branchMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseBranch(key: string) {
  if (key === "left") return branchMap.left;
  return branchMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "runtime-branch-entry.ts"),
`import { chooseBranch } from "./runtime-branch-actions.js";
export function runBranch(key: string, value: number) {
  return chooseBranch(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-read-failure-entry.ts"),
`import { chooseMissing } from "./runtime-not-present.js";
export function runMissing(key: string, value: number) {
  return chooseMissing(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-broken-actions.ts"),
`const brokenMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseBroken(key: string) {
  return brokenMap[key];
}
const broken = ;
`);

  writeFileSync(join(ROOT, "src", "runtime-broken-entry.ts"),
`import { chooseBroken } from "./runtime-broken-actions.js";
export function runBroken(key: string, value: number) {
  return chooseBroken(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-constant-helper.ts"),
`const constantMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
const unrelatedMap = {
  left: (value: number) => value + 3,
  right: (value: number) => value * 4,
};
export function readUnrelated(key: string) {
  return unrelatedMap[key];
}
export function chooseConstant(_key: string) {
  return constantMap.left;
}
export function chooseWithConstantArgument(key: string, value: number) {
  return chooseConstant("left")(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-two-sites.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function runFirst(key: string, value: number) {
  return chooseAction(key)(value);
}
export function runSecond(key: string, value: number) {
  return chooseAction(key)(value + 1);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-destructured-entry.ts"),
`import { chooseAction } from "./runtime-actions.js";
export function destructuredSelector(key: string, value: number) {
  [key] = ["left"];
  return chooseAction(key)(value);
}
export function unrelatedDestructuredWrite(key: string, value: number, other: string) {
  [other] = ["right"];
  return chooseAction(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-helper-replacement.ts"),
`const replacedMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseReplaced(key: string) {
  return replacedMap[key];
}
chooseReplaced = replacement;
declare const replacement: typeof chooseReplaced;
export function runReplaced(key: string, value: number) {
  return chooseReplaced(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "runtime-import-replacement.ts"),
`import { chooseAction } from "./runtime-actions.js";
chooseAction = replacement;
declare const replacement: typeof chooseAction;
export function runImportedReplacement(key: string, value: number) {
  return chooseAction(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-actions.ts"),
`const actionMap = {
  left: (value) => value + 2,
  right: function (value) { return value * 5; },
};
export function chooseAction(key) {
  return actionMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-entry.ts"),
`import { chooseAction } from "./callable-identity-actions.js";
export function runAction(key, value) {
  return chooseAction(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-wrapped.ts"),
`const wrappedMap = {
  left: (((value) => value + 1) as (value: number) => number),
  right: ((value) => value * 3)!,
};
export function chooseWrapped(key) {
  return wrappedMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-wrapped-entry.ts"),
`import { chooseWrapped } from "./callable-identity-wrapped.js";
export function runWrapped(key, value) {
  return chooseWrapped(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-samename.ts"),
`const firstMap = {
  left: (value) => value + 1,
  right: (value) => value + 2,
};
export function chooseFirst(key) {
  return firstMap[key];
}
// spacer keeps the second table at a distinct span
const secondMap = {
  left: (value) => value + 3,
  right: (value) => value + 4,
};
export function chooseSecond(key) {
  return secondMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-samename-first-entry.ts"),
`import { chooseFirst } from "./callable-identity-samename.js";
export function runFirst(key, value) {
  return chooseFirst(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-samename-second-entry.ts"),
`import { chooseSecond } from "./callable-identity-samename.js";
export function runSecond(key, value) {
  return chooseSecond(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-missing.ts"),
`const leftThunk = () => 1;
const rightThunk = () => 2;
const missingMap = {
  left: leftThunk,
  right: rightThunk,
};
export function chooseMissing(key) {
  return missingMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-missing-entry.ts"),
`import { chooseMissing } from "./callable-identity-missing.js";
export function runMissing(key, value) {
  return chooseMissing(key)(value);
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-method.ts"),
`const methodMap = {
  left(value) { return value + 1; },
  right(value) { return value * 2; },
};
export function chooseMethod(key) {
  return methodMap[key];
}
`);

  writeFileSync(join(ROOT, "src", "callable-identity-method-entry.ts"),
`import { chooseMethod } from "./callable-identity-method.js";
export function runMethod(key, value) {
  return chooseMethod(key)(value);
}
`);

  try {
    symlinkSync(join(ROOT, "src", "kinds.ts"), join(ROOT, "src", "link.ts"));
  } catch {
    // symlink creation may fail on some platforms; tests still pass
  }
}

makeFixtures();

function request(files, extra = {}) {
  return {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files,
    ...extra,
  };
}

function symbolsOf(outcome) {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  return outcome.result.symbols;
}

function byName(symbols, name) {
  return symbols.filter(s => s.name === name);
}

test("policy: validates request shape and rejects invalid inputs", () => {
  const missing = validateTsJsSymbolRequest({});
  assert.equal(missing.ok, false);

  const wrongLang = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "go",
    scope: ["src"],
    files: ["src/kinds.ts"],
  });
  assert.equal(wrongLang.ok, false);
  assert.equal(wrongLang.ok === false && wrongLang.error.reasonCode, "unsupported_language");

  const escape = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "typescript",
    scope: ["../outside"],
    files: ["src/kinds.ts"],
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.ok === false && escape.error.reasonCode, "scope_escape");

  const badFile = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/kinds.go"],
  });
  assert.equal(badFile.ok, false);

  const good = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "ts",
    scope: ["src"],
    files: ["src/kinds.ts"],
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.request.language, "typescript");
    assert.deepEqual([...good.request.scope], ["src"]);
  }
});

test("policy: exact symbol and file filtering plus projection", () => {
  const req = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/kinds.ts"],
    symbol: "draw",
    file: "src/kinds.ts",
  };
  const span = Object.freeze({ startLine: 1, startCol: 1, endLine: 1, endCol: 5 });
  const sym = Object.freeze({
    symbolId: symbolIdFor("src/kinds.ts", "draw", span),
    name: "draw",
    kind: "function",
    file: "src/kinds.ts",
    declSpan: span,
    nameSpan: span,
    nameSpanSource: "identifier",
    lexicalScope: [],
    ownerType: null,
    ownerKind: null,
    modifiers: ["export"],
    visibility: "exported",
    moduleSystem: "esm",
    declaredIn: "file",
    parseStatus: "complete",
  });
  const filtered = filterTsJsSymbols([sym], "draw", "src/kinds.ts");
  assert.deepEqual(filtered.map(s => s.name), ["draw"]);

  const projected = projectTsJsSymbolTableResult(
    req,
    { backend: "typescript_compiler_ast", compilerVersion: "5.9.3", invocation: "test", semanticBinding: false },
    [sym],
    [],
    { scopeFilesDiscovered: 1, scopeFilesParsed: 1, scopeFilesFailed: [], skipped: [], parseErrorFiles: [], partial: false, partialReasons: [], truncated: false, parserInvocations: 1, notes: [] },
  );
  assert.equal(projected.schema, "nnanything.cli-symbols.result.v1");
  assert.equal(projected.language, "typescript");
});

test("T1: TypeScript all categories with accurate positions", async () => {
  const out = await runTsJsSymbolTable(request(["src/kinds.ts"]));
  const syms = symbolsOf(out);
  const names = syms.map(s => s.name).sort();

  assert.ok(!names.includes("tmp"), "local const tmp excluded");
  assert.ok(names.includes("localHelper"), "local function present");

  const iface = byName(syms, "I")[0];
  assert.equal(iface.kind, "interface");
  assert.equal(iface.visibility, "exported");
  assert.equal(iface.moduleSystem, "esm");
  assert.deepEqual(iface.nameSpan, { startLine: 1, startCol: 18, endLine: 1, endCol: 19 });

  const cls = byName(syms, "C")[0];
  assert.equal(cls.kind, "class");
  assert.ok(cls.modifiers.includes("abstract"));

  const prop = byName(syms, "id")[0];
  assert.equal(prop.kind, "property");
  assert.equal(prop.declaredIn, "class_body");
  assert.equal(prop.ownerType, "C");
  assert.ok(prop.modifiers.includes("readonly"));

  const secret = byName(syms, "#secret")[0];
  assert.ok(secret, "private field #secret");
  assert.equal(secret.visibility, "private");

  const ctor = byName(syms, "constructor")[0];
  assert.equal(ctor.kind, "constructor");
  assert.equal(ctor.nameSpanSource, "constructor_keyword");

  const paramProp = byName(syms, "name")[0];
  assert.equal(paramProp.kind, "property");
  assert.equal(paramProp.declaredIn, "primary_constructor");

  const getG = syms.find(s => s.name === "g" && s.kind === "accessor");
  assert.ok(getG, "get accessor g");
  assert.ok(getG.modifiers.includes("get"));

  const setW = syms.find(s => s.name === "w" && s.kind === "accessor");
  assert.ok(setW, "set accessor w");
  assert.ok(setW.modifiers.includes("set"));

  const overrideM = syms.find(s => s.name === "m" && s.declaredIn === "class_body");
  assert.ok(overrideM, "override method m in class body");
  assert.ok(overrideM.modifiers.includes("override"));

  const arrow = byName(syms, "arrowFn")[0];
  assert.equal(arrow.kind, "function");
  assert.ok(arrow.modifiers.includes("const"));

  const destructureA = byName(syms, "a")[0];
  assert.equal(destructureA.kind, "variable");
  const destructureC = byName(syms, "c")[0];
  assert.equal(destructureC.kind, "variable");

  const defaultFn = byName(syms, "namedDefault")[0];
  assert.equal(defaultFn.kind, "function");
  assert.ok(defaultFn.modifiers.includes("default"));
  assert.equal(defaultFn.nameSpanSource, "identifier");

  const localHelper = byName(syms, "localHelper")[0];
  assert.equal(localHelper.declaredIn, "local_scope");
  assert.ok(localHelper.lexicalScope.includes("fn:outer"));
});

test("T2: JavaScript CommonJS and ESM coverage", async () => {
  const cjsOut = await runTsJsSymbolTable(request(["src/cjs.cjs"], { language: "javascript" }));
  const cjsSyms = symbolsOf(cjsOut);
  assert.ok(cjsSyms.some(s => s.name === "a" && s.kind === "method"), "CJS method a");
  assert.ok(cjsSyms.some(s => s.name === "b" && s.kind === "function"), "CJS function b");
  assert.ok(cjsSyms.some(s => s.name === "c" && s.kind === "variable"), "CJS variable c");
  for (const s of cjsSyms) {
    assert.equal(s.moduleSystem, "cjs");
    assert.equal(s.declaredIn, "commonjs_export");
  }

  const mjsOut = await runTsJsSymbolTable(request(["src/widget.mjs"], { language: "javascript" }));
  const mjsSyms = symbolsOf(mjsOut);
  assert.ok(mjsSyms.some(s => s.name === "Widget" && s.kind === "class"), "ESM default class Widget");

  const jsxOut = await runTsJsSymbolTable(request(["src/jsx.jsx"], { language: "javascript" }));
  const jsxSyms = symbolsOf(jsxOut);
  assert.ok(jsxSyms.some(s => s.name === "App"), "JSX default function App");
});

test("T3: .d.ts ambient and syntax error recovery", async () => {
  const ambOut = await runTsJsSymbolTable(request(["src/ambient.d.ts"]));
  const ambSyms = symbolsOf(ambOut);
  assert.ok(ambSyms.some(s => s.name === "pkg" && s.kind === "namespace"), "ambient module pkg");
  assert.ok(ambSyms.some(s => s.name === "Global" && s.kind === "interface"), "ambient interface Global");
  for (const s of ambSyms) assert.equal(s.moduleSystem, "ambient_dts");

  const brokenOut = await runTsJsSymbolTable(request(["src/broken.ts"]));
  assert.equal(brokenOut.status, "ok");
  assert.equal(brokenOut.result.coverage.partial, true);
  assert.equal(brokenOut.result.coverage.parseErrorFiles.length, 1);
  const brokenSyms = brokenOut.result.symbols;
  for (const s of brokenSyms) assert.equal(s.parseStatus, "partial_syntax_error");
  assert.ok(brokenSyms.some(s => s.name === "good"), "good function recovered");
  assert.ok(brokenSyms.some(s => s.name === "Broken"), "Broken class recovered");
});

test("T4: deep expression does not overflow the stack", async () => {
  const out = await runTsJsSymbolTable(request(["src/deep.ts"]));
  assert.equal(out.status, "ok");
  assert.equal(out.result.coverage.scopeFilesParsed, 1);
});

test("T5: language isolation via the validation gate", async () => {
  // The public entry (`lib/cli-symbols.ts`, owned by the integration writer)
  // filters discovered files by language before handing them to the adapter.
  // At the adapter boundary this worker owns the policy gate: any file whose
  // extension does not match the requested language is rejected. This mirrors
  // the Rust policy gate, which rejects non-`.rs` files at validation.
  const mixedTs = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/kinds.ts", "src/mixed.rs", "src/cjs.cjs"],
  });
  assert.equal(mixedTs.ok, false);
  assert.equal(mixedTs.ok === false && mixedTs.error.reasonCode, "invalid_file");

  const mixedJs = validateTsJsSymbolRequest({
    repo: ROOT,
    language: "javascript",
    scope: ["src"],
    files: ["src/cjs.cjs", "src/kinds.ts"],
  });
  assert.equal(mixedJs.ok, false);
  assert.equal(mixedJs.ok === false && mixedJs.error.reasonCode, "invalid_file");

  // A batch restricted to matching files passes validation and extracts only
  // those files, keeping the language projection clean.
  const tsOut = await runTsJsSymbolTable(request(["src/kinds.ts"]));
  assert.equal(tsOut.status, "ok");
  assert.ok(symbolsOf(tsOut).every(s => s.file === "src/kinds.ts"));

  const jsOut = await runTsJsSymbolTable(request(["src/cjs.cjs"], { language: "javascript" }));
  assert.equal(jsOut.status, "ok");
  assert.ok(symbolsOf(jsOut).every(s => s.file === "src/cjs.cjs"));
});

test("T6: CJS module/exports shadowing does not produce export symbols", async () => {
  const out = await runTsJsSymbolTable(request(["src/shadow.cjs"], { language: "javascript" }));
  const syms = symbolsOf(out);
  const cjsExports = syms.filter(s => s.declaredIn === "commonjs_export");
  assert.equal(cjsExports.length, 0, "shadowed CJS assignments must not produce export symbols");
});

test("T7: default and module.exports unique naming and no duplicates", async () => {
  const tsOut = await runTsJsSymbolTable(request(["src/defaults.ts"]));
  const tsSyms = symbolsOf(tsOut);
  const namedDefaults = byName(tsSyms, "namedDefault");
  assert.equal(namedDefaults.length, 1, "exactly one namedDefault");
  const anonDefaults = byName(tsSyms, "default");
  assert.equal(anonDefaults.length, 1, "exactly one anonymous default");

  const cjsOut = await runTsJsSymbolTable(request(["src/cjs-named.cjs"], { language: "javascript" }));
  const cjsSyms = symbolsOf(cjsOut);
  const moduleExports = byName(cjsSyms, "module.exports");
  assert.equal(moduleExports.length, 1, "exactly one module.exports");
  assert.equal(moduleExports[0].kind, "function");
  const internalNames = byName(cjsSyms, "internalName");
  assert.equal(internalNames.length, 0, "internalName not emitted as separate symbol");
});

test("T8: dynamic computed members preserved as unknown boundaries", async () => {
  const tsOut = await runTsJsSymbolTable(request(["src/dynamic.ts"]));
  assert.equal(tsOut.result.coverage.partial, true);
  const dynBoundaries = tsOut.result.dynamicMemberBoundaries.filter(b => b.file === "src/dynamic.ts");
  assert.equal(dynBoundaries.length, 2);
  assert.ok(dynBoundaries.every(b => b.reason === "DYNAMIC_COMPUTED_NAME"));
  assert.ok(dynBoundaries.some(b => b.expressionText === "Symbol.iterator"));
  assert.ok(dynBoundaries.some(b => b.expressionText === "dynamicProp"));

  const cjsOut = await runTsJsSymbolTable(request(["src/dynamic-cjs.cjs"], { language: "javascript" }));
  const cjsDyn = cjsOut.result.dynamicMemberBoundaries.filter(b => b.file === "src/dynamic-cjs.cjs");
  assert.equal(cjsDyn.length, 1);
  assert.equal(cjsDyn[0].boundaryKind, "commonjs_computed_export");
  assert.equal(cjsOut.result.coverage.partial, true);
});

test("T9: columns count 1-based Unicode code points (non-BMP is one column)", async () => {
  const out = await runTsJsSymbolTable(request(["src/nonbmp.ts"]));
  const syms = symbolsOf(out);
  const afterEmoji = byName(syms, "afterEmoji")[0];
  // The emoji before `afterEmoji` on the same line is a surrogate pair in
  // UTF-16 but a single code point, so it advances the column by exactly one.
  assert.deepEqual(afterEmoji.nameSpan, { startLine: 1, startCol: 43, endLine: 1, endCol: 53 });
  const emoji = byName(syms, "emoji")[0];
  assert.deepEqual(emoji.nameSpan, { startLine: 1, startCol: 14, endLine: 1, endCol: 19 });
});

test("symlink files are skipped", async () => {
  if (!existsSync(join(ROOT, "src", "link.ts"))) return;
  const out = await runTsJsSymbolTable(request(["src/link.ts"]));
  assert.equal(out.status, "ok");
  assert.equal(out.result.coverage.scopeFilesParsed, 0);
  assert.ok(out.result.coverage.skipped.some(s => s.file === "src/link.ts"));
});

test("real repo black-box: extract symbols from a real project TS file", async () => {
  const realFile = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli-symbols.js");
  if (!existsSync(realFile)) return;
  const realRepo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const relPath = "dist/cli-symbols.js";
  const out = await runTsJsSymbolTable({
    repo: realRepo,
    language: "javascript",
    scope: ["dist"],
    files: [relPath],
  });
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  assert.equal(out.result.language, "javascript");
  assert.equal(out.result.schema, "nnanything.cli-symbols.result.v1");
  const runCli = out.result.symbols.find(s => s.name === "runCliSymbols");
  assert.ok(runCli, "runCliSymbols found in real dist file");
  assert.equal(runCli.kind, "function");
  assert.equal(runCli.visibility, "exported");
});

test("runtime-selector T1: emits one source-backed dynamic observation", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-entry.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  assert.equal(out.result.runtimeSelectorGaps.length, 0);
  const observation = out.result.runtimeSelectorObservations[0];
  assert.equal(Object.hasOwn(observation, "coverage"), false);
  assert.equal(observation.callSiteRef, observation.binding.callSiteRef);
  assert.equal(observation.facts.length, 2);

  const tableFacts = observation.facts.filter(f => f.role === "selector_candidate_table");
  const dependencyFacts = observation.facts.filter(f => f.role === "runtime_selector_dependency");
  assert.equal(tableFacts.length, 1);
  assert.equal(dependencyFacts.length, 1);
  assert.equal(tableFacts[0].state, "known");
  assert.equal(dependencyFacts[0].state, "known");

  for (const fact of observation.facts) {
    assert.ok(fact.evidenceRefs.includes(observation.sourceReadRef));
  }
  assert.ok(observation.binding.evidenceRefs.includes(observation.sourceReadRef));
  assert.ok(observation.binding.resolution.evidenceRefs.includes(observation.sourceReadRef));
  assert.equal(observation.binding.bindingMode, "dynamic");
  assert.equal(observation.binding.resolution.status, "dynamic");
  assert.equal(observation.binding.resolution.reason, "dynamic_undecidable");
  assert.deepEqual(observation.binding.declarationRefs, []);
  assert.equal(observation.binding.scopeRef, null);

  const receipt = observation.sourceReadReceipt;
  assert.equal(receipt.action, "read_source");
  assert.equal(receipt.origin, "source_observation");
  assert.equal(receipt.outcome, "success");
  assert.ok(receipt.evidenceRefs.includes(observation.sourceReadRef));
  assert.deepEqual(
    receipt.modules.map(module => module.file).sort(),
    ["src/runtime-actions.ts", "src/runtime-entry.ts"],
  );
  assert.ok(receipt.result.every(ref => typeof ref === "string" && ref.length > 0));
  assert.equal(out.result.parser.semanticBinding, false);
  assert.equal(out.result.coverage.partial, false);
  assert.equal(out.result.dynamicMemberBoundaries.length, 0);
});

test("runtime-selector T1b: queried helper read does not fabricate completion", async () => {
  const out = await runTsJsSymbolTable(
    request(
      ["src/runtime-entry.ts", "src/runtime-actions.ts"],
      { file: "src/runtime-actions.ts", symbol: "chooseAction" },
    ),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  const observation = out.result.runtimeSelectorObservations[0];
  assert.ok(
    observation.sourceReadReceipt.modules.some(
      module => module.file === "src/runtime-actions.ts",
    ),
  );
  assert.equal(Object.hasOwn(observation, "targetModuleReached"), false);
  assert.equal("coverageNote" in observation, false);
});

test("runtime-selector T2: direct literal is static and member access stays outside", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-controls.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.equal(out.result.runtimeSelectorGaps.length, 0);
  assert.equal(out.result.staticSelectedSelectorObservations.length, 1);
  assert.equal(
    out.result.staticSelectedSelectorObservations
      .flatMap(observation => observation.facts)
      .filter(fact => fact.role === "selector_candidate_table").length,
    1,
  );
  assert.equal(out.result.coverage.partial, false);
  assert.equal(out.result.parser.semanticBinding, false);
});

test("static literal P1: emits one selected member observation", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-right.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 1);
  const observation = out.result.staticSelectedSelectorObservations[0];
  assert.ok(observation);
  assert.equal(observation.callSiteRef, observation.binding.callSiteRef);
  assert.equal(observation.selection.selectionKind, "static_selected");
  assert.equal(observation.selection.selectorLiteral, "right");
  assert.equal(observation.selection.selectedMemberName, "right");

  const selectedMember = observation.callableTable.members.find(
    member => member.name === observation.selection.selectedMemberName,
  );
  assert.ok(selectedMember);
  assert.ok(selectedMember.callableIdentity);
  assert.equal(observation.selection.selectedMemberRef, selectedMember.initializerRef);
  assert.equal(
    observation.selection.selectedDeclarationRef,
    selectedMember.callableIdentity.declarationRef,
  );
  assert.equal(observation.selection.selectedModuleRef, selectedMember.callableIdentity.moduleRef);

  assert.equal(observation.binding.bindingMode, "bound");
  assert.equal(observation.binding.resolution.status, "resolved");
  assert.equal(
    observation.binding.resolution.declarationRef,
    observation.selection.selectedDeclarationRef,
  );
  assert.equal(observation.binding.resolution.moduleRef, observation.selection.selectedModuleRef);
  assert.deepEqual(observation.binding.declarationRefs, [
    observation.selection.selectedDeclarationRef,
  ]);
  assert.equal(observation.binding.scopeRef, null);
  assert.ok(observation.binding.evidenceRefs.includes(observation.sourceReadRef));
  assert.ok(observation.binding.resolution.evidenceRefs.includes(observation.sourceReadRef));

  assert.deepEqual(
    observation.facts.map(fact => fact.role),
    ["selector_candidate_table", "static_selected_member"],
  );
  assert.ok(observation.facts.every(fact => fact.state === "known"));
  assert.ok(observation.facts.every(fact => fact.evidenceRefs.includes(observation.sourceReadRef)));

  const receipt = observation.sourceReadReceipt;
  assert.equal(receipt.action, "read_source");
  assert.equal(receipt.origin, "source_observation");
  assert.equal(receipt.outcome, "success");
  assert.ok(receipt.evidenceRefs.includes(observation.sourceReadRef));
  assert.ok(receipt.result.every(ref => ref.startsWith("source-read:")));
});

test("static literal P2: missing member emits an explicit gap", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-missing.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    out.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["static_selected_member_missing"],
  );
});

test("static literal P3: non-literal selector emits unsupported shape", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-nonliteral.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    out.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["unsupported_selector_shape"],
  );
});

test("static literal P4: const alias stays explicitly unsupported", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-const-alias.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    out.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["static_alias_unsupported"],
  );
});

test("static literal P5: nested constant stays explicitly unsupported", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-nested.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    out.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["static_alias_unsupported"],
  );
});

test("static literal P5A: recognized control paths emit explicit gaps", async () => {
  const callerControl = await runTsJsSymbolTable(
    request(["src/runtime-static-caller-control.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(callerControl.status, "ok", JSON.stringify(callerControl));
  if (callerControl.status !== "ok") return;

  assert.equal(callerControl.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    callerControl.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["unsupported_selector_shape"],
  );

  const helperControl = await runTsJsSymbolTable(
    request([
      "src/runtime-static-helper-control-entry.ts",
      "src/runtime-static-helper-control.ts",
    ]),
  );
  assert.equal(helperControl.status, "ok", JSON.stringify(helperControl));
  if (helperControl.status !== "ok") return;

  assert.equal(helperControl.result.staticSelectedSelectorObservations.length, 0);
  assert.deepEqual(
    helperControl.result.runtimeSelectorGaps.map(gap => gap.reason),
    ["unsupported_selector_shape"],
  );
});

test("static literal P6: dynamic observation semantics stay unchanged", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-entry.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  const observation = out.result.runtimeSelectorObservations[0];
  assert.ok(observation);
  assert.equal(observation.binding.bindingMode, "dynamic");
  assert.equal(observation.binding.resolution.status, "dynamic");
  assert.equal(observation.binding.resolution.reason, "dynamic_undecidable");
  assert.deepEqual(observation.binding.declarationRefs, []);
  assert.equal(observation.binding.scopeRef, null);
  assert.deepEqual(
    observation.facts.map(fact => fact.role),
    ["selector_candidate_table", "runtime_selector_dependency"],
  );
});

test("static literal P7: out-of-scope calls make no new claim", async () => {
  const out = await runTsJsSymbolTable(request(["src/runtime-static-out-of-scope.ts"]));
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.staticSelectedSelectorObservations.length, 0);
  assert.equal(out.result.runtimeSelectorGaps.length, 0);

  const noTable = await runTsJsSymbolTable(request(["src/runtime-static-no-table.ts"]));
  assert.equal(noTable.status, "ok", JSON.stringify(noTable));
  if (noTable.status !== "ok") return;

  assert.equal(noTable.result.staticSelectedSelectorObservations.length, 0);
  assert.equal(noTable.result.runtimeSelectorGaps.length, 0);
});

test("static literal P8: existing negative selector paths stay gaps", async () => {
  const ambiguous = await runTsJsSymbolTable(
    request(["src/runtime-static-ambiguous.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(ambiguous.status, "ok", JSON.stringify(ambiguous));
  if (ambiguous.status === "ok") {
    assert.equal(ambiguous.result.staticSelectedSelectorObservations.length, 0);
    assert.ok(
      ambiguous.result.runtimeSelectorGaps.some(
        gap => gap.reason === "ambiguous_selector_chain",
      ),
    );
  }

  const mutated = await runTsJsSymbolTable(
    request(["src/runtime-static-mutated.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(mutated.status, "ok", JSON.stringify(mutated));
  if (mutated.status === "ok") {
    assert.equal(mutated.result.staticSelectedSelectorObservations.length, 0);
    assert.ok(
      mutated.result.runtimeSelectorGaps.some(
        gap => gap.reason === "unsupported_selector_shape",
      ),
    );
  }

  const failedRead = await runTsJsSymbolTable(
    request([
      "src/runtime-static-read-failure.ts",
      "src/runtime-not-present.ts",
    ]),
  );
  assert.equal(failedRead.status, "ok", JSON.stringify(failedRead));
  if (failedRead.status === "ok") {
    assert.equal(failedRead.result.staticSelectedSelectorObservations.length, 0);
    assert.ok(
      failedRead.result.runtimeSelectorGaps.some(gap => gap.reason === "read_failed"),
    );
  }
});

test("runtime-selector T3: one-member table records unsupported selector shape", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-one-entry.ts", "src/runtime-one-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    out.result.runtimeSelectorGaps.some(
      gap => gap.reason === "unsupported_selector_shape",
    ),
  );
  assert.equal(out.result.coverage.partial, false);
});

test("runtime-selector T4: narrowing and reassignment are rejected", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-narrowing.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    out.result.runtimeSelectorGaps.some(
      gap => gap.reason === "unsupported_selector_shape",
    ),
  );
});

test("runtime-selector T5: helper shadowing and alternate return are rejected", async () => {
  const shadowOut = await runTsJsSymbolTable(
    request(["src/runtime-shadow-entry.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(shadowOut.status, "ok", JSON.stringify(shadowOut));
  if (shadowOut.status === "ok") {
    assert.equal(shadowOut.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      shadowOut.result.runtimeSelectorGaps.some(
        gap =>
          gap.reason === "unsupported_selector_shape" ||
          gap.reason === "ambiguous_selector_chain",
      ),
    );
  }

  const branchOut = await runTsJsSymbolTable(
    request(["src/runtime-branch-entry.ts", "src/runtime-branch-actions.ts"]),
  );
  assert.equal(branchOut.status, "ok", JSON.stringify(branchOut));
  if (branchOut.status !== "ok") return;
  assert.equal(branchOut.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    branchOut.result.runtimeSelectorGaps.some(
      gap =>
        gap.reason === "unsupported_selector_shape" ||
        gap.reason === "ambiguous_selector_chain",
    ),
  );
});

test("runtime-selector T6: missing, failed, and broken reads stay not_ready", async () => {
  const missingOut = await runTsJsSymbolTable(request(["src/runtime-entry.ts"]));
  assert.equal(missingOut.status, "ok", JSON.stringify(missingOut));
  if (missingOut.status === "ok") {
    assert.equal(missingOut.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      missingOut.result.runtimeSelectorGaps.some(
        gap => gap.reason === "module_not_in_read_set",
      ),
    );
  }

  const failedOut = await runTsJsSymbolTable(
    request(["src/runtime-read-failure-entry.ts", "src/runtime-not-present.ts"]),
  );
  assert.equal(failedOut.status, "ok", JSON.stringify(failedOut));
  if (failedOut.status === "ok") {
    assert.equal(failedOut.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      failedOut.result.runtimeSelectorGaps.some(gap => gap.reason === "read_failed"),
    );
  }

  const brokenOut = await runTsJsSymbolTable(
    request(["src/runtime-broken-entry.ts", "src/runtime-broken-actions.ts"]),
  );
  assert.equal(brokenOut.status, "ok", JSON.stringify(brokenOut));
  if (brokenOut.status === "ok") {
    assert.equal(brokenOut.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      brokenOut.result.runtimeSelectorGaps.some(gap => gap.reason === "parse_error"),
    );
  }
});

test("runtime-selector T7: unconnected and non-parameter dependencies emit no role", async () => {
  const out = await runTsJsSymbolTable(request(["src/runtime-constant-helper.ts"]));
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.equal(
    out.result.runtimeSelectorObservations
      .flatMap(observation => observation.facts).length,
    0,
  );
  assert.equal(out.result.parser.semanticBinding, false);
});

test("runtime-selector T8: separate call sites never join", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-two-sites.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 2);
  const [first, second] = out.result.runtimeSelectorObservations;
  assert.notEqual(first.callSiteRef, second.callSiteRef);
  for (const observation of out.result.runtimeSelectorObservations) {
    assert.equal(
      observation.facts.filter(fact => fact.role === "selector_candidate_table").length,
      1,
    );
    assert.equal(
      observation.facts.filter(fact => fact.role === "runtime_selector_dependency").length,
      1,
    );
    assert.ok(observation.facts.every(fact => fact.evidenceRefs.includes(observation.sourceReadRef)));
  }
  assert.notEqual(first.sourceReadRef, second.sourceReadRef);
});

test("runtime-selector T9: destructuring selector writes are rejected", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-destructured-entry.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  // The unrelated destructuring write keeps the unchanged direct-parameter
  // dependency, while the selector write must not emit a role fact.
  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  assert.ok(
    out.result.runtimeSelectorGaps.some(
      gap => gap.reason === "unsupported_selector_shape",
    ),
  );
});

test("runtime-selector T10: module-level helper replacement is rejected", async () => {
  const localOut = await runTsJsSymbolTable(
    request(["src/runtime-helper-replacement.ts"]),
  );
  assert.equal(localOut.status, "ok", JSON.stringify(localOut));
  if (localOut.status !== "ok") return;
  assert.equal(localOut.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    localOut.result.runtimeSelectorGaps.some(
      gap => gap.reason === "unsupported_selector_shape",
    ),
  );

  const importedOut = await runTsJsSymbolTable(
    request(["src/runtime-import-replacement.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(importedOut.status, "ok", JSON.stringify(importedOut));
  if (importedOut.status !== "ok") return;
  assert.equal(importedOut.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    importedOut.result.runtimeSelectorGaps.some(
      gap => gap.reason === "unsupported_selector_shape",
    ),
  );
});

test("request-aware bridge loads and admits the matching producer source read", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;

  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);
  const requestRef = "req:tsjs-bridge-a";
  const pendingRelationRef = "pending:tsjs-bridge-a";

  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: "tsjs-bridge-eng",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-bridge-family",
    sampleId: "bridge-a",
    entryFile: "src/runtime-two-sites.ts",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: "decl:src/runtime-actions.ts#top:chooseAction",
        moduleRef: "module:src/runtime-actions.ts",
        name: "chooseAction",
        role: "export",
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "chooseAction",
      },
    },
    stepId: "step-0",
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest,
  });

  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);

  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-bridge-"));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeFile(join(familyDir, "manifest.json"), JSON.stringify({
      sourceGroup: "tsjs-bridge-eng",
      language: "typescript",
      semanticStratum: "module_export",
      partition: "dev",
      derivationFamily: { familyId: "tsjs-bridge-family" },
    }));
    await writeFile(join(familyDir, "student-observations.jsonl"), `${JSON.stringify(bridge.record)}\n`);

    const episodes = await loadStepwiseEpisodeFamily(familyDir);
    assert.equal(episodes.length, 1);
    const episode = episodes[0];
    assert.equal(episode.requestId, requestRef);
    assert.equal(episode.callSiteRef, observation.callSiteRef);
    assert.equal(episode.stepId, "step-0");
    assert.equal(episode.coverage?.targetModuleReached, true);
    assert.equal(episode.sourceContent?.state, "observed");
    assert.equal(
      episode.receipts?.[0]?.producerSource?.rawObservation.sourceReadRef,
      observation.sourceReadRef,
    );

    const admission = admitInitialEvidence(requestRef, episodes);
    assert.deepEqual(admission.invalidReasons, []);
    assert.ok(admission.initialObservation);
    assert.equal(
      admission.initialObservation.evidence.length,
      1,
    );
    assert.equal(
      admission.initialObservation.evidence[0].id,
      observation.sourceReadRef,
    );
    assert.deepEqual(
      admission.initialObservation.evidence[0].payload.resultRefs,
      observation.sourceReadReceipt.result,
    );
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
});

test("bridge rejects missing call sites and cross-call-site provenance substitutions", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observations = producer.result.runtimeSelectorObservations;
  assert.equal(observations.length, 2);
  const [observationA, observationB] = observations;

  const missing = await observeTsJsStepwiseRequest(bridgeInput(
    producerRequest,
    observationA,
    { relationObligation: { callSiteRef: "call:missing" } },
  ));
  assert.equal(missing.record, null);
  assert.ok(missing.reasons.includes("producer observation callSiteRef not found"));

  const bridge = await observeTsJsStepwiseRequest(
    bridgeInput(producerRequest, observationA),
  );
  assert.equal(bridge.reasons.length, 0);
  assert.ok(bridge.record);

  const cases = [
    ["raw call-site", record => {
      record.steps[0].receipts[0].producerSource.rawObservation.callSiteRef = "call:other";
    }],
    ["raw observation", record => {
      record.steps[0].receipts[0].producerSource.rawObservation =
        structuredClone(observationB);
    }],
    ["role fact", record => {
      record.steps[0].localSyntax.observedLocalFacts[0] =
        structuredClone(observationB.facts[0]);
    }],
    ["binding call-site", record => {
      record.steps[0].currentRelation.binding.value.callSiteRef = "call:other";
    }],
    ["pending relation", record => {
      record.steps[0].receipts[0].producerSource.pendingRelationRef = "pending:other";
    }],
    ["step identity", record => {
      record.steps[0].receipts[0].producerSource.stepId = "step-other";
    }],
    ["predecessor identity", record => {
      record.steps[0].receipts[0].producerSource.fromStepId = "step-other";
    }],
    ["requested module", record => {
      record.steps[0].receipts[0].producerSource.requestedModuleRef =
        "module:src/runtime-constant-helper.ts";
    }],
    ["receipt action", record => {
      record.steps[0].receipts[0].actionRef = "source-read:wrong:action";
    }],
    ["receipt target", record => {
      record.steps[0].receipts[0].target = "source:src/wrong.ts";
    }],
    ["receipt outcome", record => {
      record.steps[0].receipts[0].outcome = "failed";
    }],
  ];

  for (const [label, mutate] of cases) {
    const changed = structuredClone(bridge.record);
    mutate(changed);
    await assert.rejects(
      loadBridgeRecord(changed),
      label,
    );
  }
});

test("admission revalidates producer request, provenance, and role identities", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);
  const bridge = await observeTsJsStepwiseRequest(
    bridgeInput(producerRequest, observation),
  );
  assert.ok(bridge.record);
  const episodes = await loadBridgeRecord(bridge.record);

  const wrongRequest = admitInitialEvidence("req:other", episodes);
  assert.equal(wrongRequest.initialObservation, null);
  assert.ok(wrongRequest.invalidReasons.includes("producer source episode request mismatch"));

  const mixedRequest = structuredClone(episodes);
  mixedRequest.push({
    ...structuredClone(episodes[0]),
    stepId: "step-other",
    requestId: "req:other",
  });
  const mixed = admitInitialEvidence(episodes[0].requestId, mixedRequest);
  assert.equal(mixed.initialObservation, null);
  assert.ok(mixed.invalidReasons.includes("producer source episode request mismatch"));

  const withoutProvenance = structuredClone(episodes);
  delete withoutProvenance[0].receipts[0].producerSource;
  const arbitrary = admitInitialEvidence(
    withoutProvenance[0].requestId,
    withoutProvenance,
  );
  assert.equal(
    arbitrary.initialObservation.evidence.some(
      record => record.id === observation.sourceReadRef,
    ),
    false,
  );

  const cases = [
    ["raw action", episode => {
      episode.receipts[0].producerSource.rawObservation.sourceReadReceipt.action = "wrong";
      episode.receipts[0].action = "wrong";
    }],
    ["raw target", episode => {
      episode.receipts[0].producerSource.rawObservation.sourceReadReceipt.targetRef =
        "source:src/wrong.ts";
      episode.receipts[0].target = "source:src/wrong.ts";
    }],
    ["raw outcome", episode => {
      episode.receipts[0].producerSource.rawObservation.sourceReadReceipt.outcome = "failed";
      episode.receipts[0].outcome = "failed";
    }],
    ["binding evidence", episode => {
      episode.currentRelation.binding.value.evidenceRefs = [];
    }],
    ["role value", episode => {
      episode.observedLocalFacts[0].value = "changed";
    }],
  ];
  for (const [label, mutate] of cases) {
    const changed = structuredClone(episodes);
    mutate(changed[0]);
    const admission = admitInitialEvidence(changed[0].requestId, changed);
    assert.equal(
      admission.initialObservation.evidence.some(record => record.id === observation.sourceReadRef),
      false,
      label,
    );
    assert.ok(admission.invalidReasons.length > 0, label);
  }
});

test("coverage follows all successful producer reads and preserves explicit cursor obligations", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: [
      "src/runtime-two-sites.ts",
      "src/runtime-actions.ts",
      "src/runtime-constant-helper.ts",
    ],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);

  const extraRead = await observeTsJsStepwiseRequest(bridgeInput(
    producerRequest,
    observation,
    {
      requestedDeclaration: {
        declarationRef: "decl:src/runtime-constant-helper.ts#top:chooseConstant",
        moduleRef: "module:src/runtime-constant-helper.ts",
      },
      remainingObligations: [{
        kind: "observe",
        ref: "obligation:test",
        pendingRelationRef: "pending:tsjs-bridge-a",
        informationGain: "advances_chain",
      }],
      localCandidateCursor: {
        pendingRelationRef: "pending:tsjs-bridge-a",
        state: "open",
        evidenceRefs: [],
      },
    },
  ));
  assert.deepEqual(extraRead.reasons, []);
  assert.ok(extraRead.record);
  const extraEpisodes = await loadBridgeRecord(extraRead.record);
  assert.equal(extraEpisodes[0].coverage.targetModuleReached, true);
  assert.ok(extraEpisodes[0].coverage.coveredModules.includes("src/runtime-constant-helper.ts"));
  assert.equal(extraEpisodes[0].localCandidateCursor.state, "open");
  assert.equal(extraEpisodes[0].remainingObligations[0].ref, "obligation:test");

  const missingTarget = await observeTsJsStepwiseRequest(bridgeInput(
    producerRequest,
    observation,
    {
      requestedDeclaration: {
        declarationRef: "decl:src/runtime-branch-actions.ts#top:chooseBranch",
        moduleRef: "module:src/runtime-branch-actions.ts",
      },
    },
  ));
  assert.deepEqual(missingTarget.reasons, []);
  assert.ok(missingTarget.record);
  const missingEpisodes = await loadBridgeRecord(missingTarget.record);
  assert.equal(missingEpisodes[0].coverage.targetModuleReached, false);
  assert.equal(
    missingEpisodes[0].coverage.coveredModules.includes("src/runtime-branch-actions.ts"),
    false,
  );
});

test("producer-backed serialization requires explicit work state", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);

  const bridge = await observeTsJsStepwiseRequest(bridgeInput(
    producerRequest,
    observation,
    {
      remainingObligations: [{
        kind: "observe",
        ref: "obligation:explicit-work",
        pendingRelationRef: "pending:tsjs-bridge-a",
        arguments: [{
          name: "target",
          type: "call_site",
          valueRef: observation.callSiteRef,
        }],
        informationGain: "advances_chain",
      }],
      localCandidateCursor: {
        pendingRelationRef: "pending:tsjs-bridge-a",
        state: "open",
        evidenceRefs: [],
      },
    },
  ));
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);

  const episodes = await loadBridgeRecord(bridge.record);
  const context = relationStepContext(episodes[0]);
  assert.equal(context.localCandidateCursor.state, "open");
  assert.equal(context.remainingObligations.length, 1);
  assert.equal(context.remainingObligations[0].ref, "obligation:explicit-work");

  for (const field of ["localCandidateCursor", "remainingObligations"]) {
    const omitted = structuredClone(bridge.record);
    delete omitted.steps[0][field];
    await assert.rejects(
      loadBridgeRecord(omitted),
      new RegExp(`producer-backed step requires explicit ${field}`),
      field,
    );
  }
});

test("bridge canonicalizes producer request paths for read accounting", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);

  const variants = [
    ["slash", ["src/runtime-two-sites.ts", "src/runtime-actions.ts"]],
    ["backslash", ["src\\runtime-two-sites.ts", "src\\runtime-actions.ts"]],
  ];
  const coverage = [];
  for (const [label, files] of variants) {
    const bridge = await observeTsJsStepwiseRequest(bridgeInput(
      { ...producerRequest, files },
      observation,
    ));
    assert.deepEqual(bridge.reasons, [], label);
    assert.ok(bridge.record, label);

    const episodes = await loadBridgeRecord(bridge.record);
    assert.deepEqual(
      episodes[0].coverage.coveredModules,
      ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
      label,
    );
    assert.equal(episodes[0].coverage.targetModuleReached, true, label);
    assert.deepEqual(
      episodes[0].receipts[0].producerSource.producerRequest.files,
      ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
      label,
    );
    coverage.push(episodes[0].coverage);
  }
  assert.deepEqual(coverage[0], coverage[1]);

  const failedRead = await observeTsJsStepwiseRequest(bridgeInput(
    {
      ...producerRequest,
      files: [
        "src/runtime-two-sites.ts",
        "src/runtime-actions.ts",
        "src\\runtime-missing.ts",
      ],
    },
    observation,
  ));
  assert.deepEqual(failedRead.reasons, []);
  assert.ok(failedRead.record);
  const failedEpisodes = await loadBridgeRecord(failedRead.record);
  assert.deepEqual(
    failedEpisodes[0].coverage.coveredModules,
    ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  );
  assert.equal(failedEpisodes[0].coverage.targetModuleReached, true);
  assert.equal(failedEpisodes[0].notReady, true);
  assert.ok(
    failedEpisodes[0].receipts[0].producerSource.coverage.scopeFilesFailed.some(
      entry => entry.file === "src/runtime-missing.ts",
    ),
  );
});

test("bridge accepts typed null optional filters at the raw validator boundary", async () => {
  const producerRequest = {
    repo: ROOT,
    language: "typescript",
    scope: ["src"],
    files: ["src/runtime-two-sites.ts", "src/runtime-actions.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);

  const bridge = await observeTsJsStepwiseRequest(bridgeInput(
    { ...producerRequest, symbol: null, file: null },
    observation,
  ));
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);

  const episodes = await loadBridgeRecord(bridge.record);
  const storedRequest = episodes[0].receipts[0].producerSource.producerRequest;
  assert.equal(storedRequest.symbol, null);
  assert.equal(storedRequest.file, null);
  assert.deepEqual(storedRequest.files, [
    "src/runtime-two-sites.ts",
    "src/runtime-actions.ts",
  ]);
});

test("accepted clean DEV source/proof preparation loads and admits through the bridge", async () => {
  const producerRequest = {
    repo: CLEAN_DEV_FAMILY,
    language: "typescript",
    scope: ["src"],
    files: ["src/dv-c01-direct.ts", "src/dispatch.ts"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);

  const bridge = await observeTsJsStepwiseRequest({
    ...bridgeInput(producerRequest, observation, {
      requestedDeclaration: {
        declarationRef: "decl:src/dispatch.ts#top:pickDispatch",
        moduleRef: "module:src/dispatch.ts",
        name: "pickDispatch",
      },
    }),
    sourceGroup: "tsjs-clean-dev-prep",
    semanticStratum: "runtime_helper_selector",
    partition: "DEV",
    derivationFamily: "tsjs-clean-dev-family",
    sampleId: "dv-c01-direct",
    entryFile: "src/dv-c01-direct.ts",
  });
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  const episodes = await loadBridgeRecord(bridge.record);
  assert.equal(episodes[0].partition, "DEV");
  assert.equal(episodes[0].coverage.targetModuleReached, true);
  assert.equal(episodes[0].sourceContent.state, "observed");
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  assert.deepEqual(admission.invalidReasons, []);
  assert.equal(admission.initialObservation.evidence[0].id, observation.sourceReadRef);
});

function spanText(text, span) {
  const lines = text.split("\n");
  const out = [];
  for (let line = span.startLine; line <= span.endLine; line += 1) {
    const raw = lines[line - 1] ?? "";
    const start = line === span.startLine ? span.startCol - 1 : 0;
    const end = line === span.endLine ? span.endCol - 1 : raw.length;
    out.push(raw.slice(start, end));
  }
  return out.join("\n");
}

test("callable-identity C1: serializes exact typed inline callable identities", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/callable-identity-entry.ts", "src/callable-identity-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  const observation = out.result.runtimeSelectorObservations[0];
  const table = observation.callableTable;
  assert.ok(table, "callableTable is present");
  assert.equal(typeof table.tableRef, "string");
  assert.ok(table.tableRef.startsWith("table:src/callable-identity-actions.ts@"));

  const byName = new Map(table.members.map(member => [member.name, member]));
  const left = byName.get("left");
  const right = byName.get("right");
  assert.ok(left && right, "both members are typed");

  for (const member of table.members) {
    const identity = member.callableIdentity;
    assert.ok(identity, `identity for ${member.name}`);
    assert.equal(identity.moduleRef, "src/callable-identity-actions.ts");
    assert.ok(
      identity.syntaxKind === "arrow_function" || identity.syntaxKind === "function_expression",
    );
    const span = `${identity.span.startLine}:${identity.span.startCol}-${identity.span.endLine}:${identity.span.endCol}`;
    assert.equal(
      identity.declarationRef,
      `callable.${identity.syntaxKind}:${identity.moduleRef}@${span}`,
    );
    assert.equal(member.initializerRef, `member:${identity.moduleRef}@${span}`);
  }

  const source = readFileSync(join(ROOT, "src", "callable-identity-actions.ts"), "utf8");
  assert.equal(left.callableIdentity.syntaxKind, "arrow_function");
  assert.equal(spanText(source, left.callableIdentity.span), "(value) => value + 2");
  assert.equal(right.callableIdentity.syntaxKind, "function_expression");
  assert.equal(
    spanText(source, right.callableIdentity.span),
    "function (value) { return value * 5; }",
  );

  // The callable identity is not the table, the helper function, or the
  // property-assignment/initializer role reference.
  assert.notEqual(left.callableIdentity.declarationRef, table.tableRef);
  assert.notEqual(left.callableIdentity.declarationRef, left.initializerRef);
  for (const member of table.members) {
    assert.notEqual(member.callableIdentity.declarationRef, observation.binding.symbolRef);
  }

  // Old role strings and unresolved dynamic binding are unchanged.
  const tableFact = observation.facts.find(fact => fact.role === "selector_candidate_table");
  assert.ok(tableFact);
  assert.deepEqual(
    JSON.parse(tableFact.value),
    table.members.map(member => ({ name: member.name, initializerRef: member.initializerRef })),
  );
  assert.equal(observation.binding.bindingMode, "dynamic");
  assert.equal(observation.binding.resolution.status, "dynamic");
  assert.equal(observation.binding.resolution.reason, "dynamic_undecidable");
  assert.deepEqual(observation.binding.declarationRefs, []);
});

test("callable-identity C2: unwraps parentheses and assertions before extracting identity", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/callable-identity-wrapped-entry.ts", "src/callable-identity-wrapped.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 1);
  const table = out.result.runtimeSelectorObservations[0].callableTable;
  assert.ok(table);
  const source = readFileSync(join(ROOT, "src", "callable-identity-wrapped.ts"), "utf8");
  const left = table.members.find(member => member.name === "left");
  const right = table.members.find(member => member.name === "right");
  assert.ok(left?.callableIdentity && right?.callableIdentity);
  assert.equal(spanText(source, left.callableIdentity.span), "(value) => value + 1");
  assert.equal(spanText(source, right.callableIdentity.span), "(value) => value * 3");
});

test("callable-identity C3: same name at a different span yields a distinct exact identity", async () => {
  const out = await runTsJsSymbolTable(
    request([
      "src/callable-identity-samename-first-entry.ts",
      "src/callable-identity-samename-second-entry.ts",
      "src/callable-identity-samename.ts",
    ]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 2);
  const leftMembers = out.result.runtimeSelectorObservations.map(observation => {
    const table = observation.callableTable;
    assert.ok(table);
    const member = table.members.find(entry => entry.name === "left");
    assert.ok(member?.callableIdentity);
    return member;
  }).sort(
    (a, b) => a.callableIdentity.span.startLine - b.callableIdentity.span.startLine,
  );

  assert.equal(leftMembers[0].name, leftMembers[1].name);
  assert.notEqual(
    leftMembers[0].callableIdentity.declarationRef,
    leftMembers[1].callableIdentity.declarationRef,
  );
  assert.notEqual(
    leftMembers[0].callableIdentity.span.startLine,
    leftMembers[1].callableIdentity.span.startLine,
  );

  const [first, second] = out.result.runtimeSelectorObservations;
  assert.ok(first.callableTable && second.callableTable);
  assert.equal(
    second.callableTable.members.some(
      member => member.callableIdentity?.declarationRef === leftMembers[0].callableIdentity.declarationRef,
    ),
    false,
  );
  assert.equal(
    first.callableTable.members.some(
      member => member.callableIdentity?.declarationRef === leftMembers[1].callableIdentity.declarationRef,
    ),
    false,
  );
});

test("callable-identity C4: missing inline identity stays a preserved selector gap", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/callable-identity-missing-entry.ts", "src/callable-identity-missing.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    out.result.runtimeSelectorGaps.some(gap => gap.reason === "unsupported_selector_shape"),
  );
});

test("callable-identity C5: method shorthand keeps the unsupported selector gap", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/callable-identity-method-entry.ts", "src/callable-identity-method.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.ok(
    out.result.runtimeSelectorGaps.some(gap => gap.reason === "unsupported_selector_shape"),
  );
});
