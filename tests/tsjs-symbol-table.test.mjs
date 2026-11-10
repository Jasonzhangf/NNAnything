import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tsjs-symbols");

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

test("runtime-selector T2: static literal and direct member calls are not relabelled", async () => {
  const out = await runTsJsSymbolTable(
    request(["src/runtime-static-controls.ts", "src/runtime-actions.ts"]),
  );
  assert.equal(out.status, "ok", JSON.stringify(out));
  if (out.status !== "ok") return;

  assert.equal(out.result.runtimeSelectorObservations.length, 0);
  assert.equal(out.result.runtimeSelectorGaps.length, 0);
  assert.equal(
    out.result.runtimeSelectorObservations
      .flatMap(observation => observation.facts)
      .filter(fact => fact.role === "selector_candidate_table").length,
    0,
  );
  assert.equal(out.result.coverage.partial, false);
  assert.equal(out.result.parser.semanticBinding, false);
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
