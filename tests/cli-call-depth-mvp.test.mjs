// Slice CD-1 black-box regression: runCliCalleeCallGraphGoal over a real
// filesystem sandbox. Every assertion observes the public entry only; the AST
// policy and adapter are not imported directly. Expected node spans are taken
// from the same complete fixture source via the TypeScript AST (never typed by
// hand), matching the r4 design's 1-based end-exclusive convention.
import assert from "node:assert/strict";
import { lstat, mkdtemp, open as fsOpen, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const api = () => import("nnanything/cli-call-depth");

const SCOPE = Object.freeze(["src"]);

async function runFixture(t, entries, goal, options = {}) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cd1-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "cd1",
      entries,
      sessions: [{
        id: "s",
        cwd: ".",
        grantedEffects: options.grantedEffects ?? ["filesystem.read"],
      }],
    },
    ...(options.fileReadIo === undefined ? {} : { fileReadIo: options.fileReadIo }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const session = sandbox.bindSession("s");
  const result = await module.runCliCalleeCallGraphGoal(
    { requestId: options.requestId ?? "cd1", rootGoal: goal },
    { sandbox, session, ...(options.limits === undefined ? {} : { limits: options.limits }) },
  );
  return { result, sandbox, session, root };
}

async function resume(result, sandbox, session, goal, requestId = "cd1") {
  const module = await api();
  const continuation = result.response?.report?.continuation ?? null;
  return {
    continuation,
    result: await module.runCliCalleeCallGraphGoal(
      { requestId, rootGoal: goal },
      { sandbox, session, continuation },
    ),
  };
}

function goal(entryFile, entrySymbol, maxDepth) {
  return {
    kind: "cli.programming.callee_call_graph",
    entryFile,
    entrySymbol,
    maxDepth,
    direction: "callee",
    scopePaths: SCOPE,
    satisfactionThreshold: 1.0,
  };
}

// ---- Fixture-derived span helpers (1-based, end-exclusive) ----
function parse(source) {
  return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function spanOf(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`;
}

function firstNode(sourceFile, predicate) {
  let found;
  (function walk(node) {
    if (found !== undefined) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, walk);
  })(sourceFile);
  return found;
}

function namedFunctionSpan(source, name) {
  const sourceFile = parse(source);
  const node = firstNode(sourceFile, value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node !== undefined, `fixture must declare function ${name}`);
  return spanOf(sourceFile, node);
}

function defaultArrowSpan(source) {
  const sourceFile = parse(source);
  const exportAssignment = firstNode(sourceFile, value => ts.isExportAssignment(value));
  assert.ok(exportAssignment !== undefined, "fixture must contain an export default");
  return spanOf(sourceFile, exportAssignment.expression);
}

function topLevelVariableStatementSpan(source, name) {
  const sourceFile = parse(source);
  const node = firstNode(
    sourceFile,
    value => ts.isVariableStatement(value)
      && value.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name),
  );
  assert.ok(node !== undefined, `fixture must contain a top-level variable statement for ${name}`);
  return spanOf(sourceFile, node);
}

function nestedVariableDeclarationSpan(source, name) {
  const sourceFile = parse(source);
  const node = firstNode(
    sourceFile,
    value => ts.isVariableDeclaration(value) && ts.isIdentifier(value.name) && value.name.text === name,
  );
  assert.ok(node !== undefined, `fixture must contain a nested variable declaration for ${name}`);
  return spanOf(sourceFile, node);
}

function anonymousDefaultFunctionSpan(source) {
  const sourceFile = parse(source);
  const node = firstNode(sourceFile, value => ts.isFunctionDeclaration(value) && value.name === undefined);
  assert.ok(node !== undefined, "fixture must contain an anonymous default function declaration");
  return spanOf(sourceFile, node);
}

function nodeId(file, chain, span) {
  return `${file}#${chain}@${span}`;
}

function nodeIds(result) {
  return result.nodes.map(node => node.nodeId).sort();
}

function nodeById(result, id) {
  return result.nodes.find(node => node.nodeId === id);
}

function edgePairs(result) {
  return result.edges.map(edge => `${edge.callerId} -> ${edge.calleeId}`);
}

function unresolvedOf(result) {
  return result.unresolvedCallsites.map(call => ({ kind: call.kind, code: call.reasonCode }));
}

function duplicateAstFileReads(result) {
  const distinct = new Set(result.finalState.files.map(file => file.relPath)).size;
  return result.counters.initialAstFileReadCalls - distinct;
}

// ---------------------------------------------------------------------------
// CD1-T6: run-5 basic-behavior regressions for the r4 NEEDS_REVISION findings.
// ---------------------------------------------------------------------------
const FUNCTION_CONTROL = "function leaf(){return 1;} export function entry(){return leaf();}";

test("CD1-T6 function-control keeps entry -> leaf", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: FUNCTION_CONTROL }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-fn-control" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(FUNCTION_CONTROL, "entry"));
  const leafId = nodeId("src/entry.ts", "leaf", namedFunctionSpan(FUNCTION_CONTROL, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, leafId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${leafId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const ARROW_ENTRY = "function leaf(){return 1;} export const entry = () => leaf();";

test("CD1-T6 arrow-entry extracts the real arrow body and expands leaf", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: ARROW_ENTRY }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-arrow-entry" });
  const entryId = nodeId("src/entry.ts", "entry", topLevelVariableStatementSpan(ARROW_ENTRY, "entry"));
  const leafId = nodeId("src/entry.ts", "leaf", namedFunctionSpan(ARROW_ENTRY, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, leafId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${leafId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const ARROW_CALLEE = "const leaf = () => 1; export function entry(){return leaf();}";

test("CD1-T6 arrow-callee resolves a top-level arrow target as callable", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: ARROW_CALLEE }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-arrow-callee" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(ARROW_CALLEE, "entry"));
  const leafId = nodeId("src/entry.ts", "leaf", topLevelVariableStatementSpan(ARROW_CALLEE, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, leafId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${leafId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const CROSS_FILE_ARROW_DEF = "export const leaf = () => 1;\n";
const CROSS_FILE_ARROW_ENTRY = 'import { leaf } from "./def.js";\nexport function entry(){return leaf();}\n';

test("CD1-T6 cross-file arrow callee resolves the imported initializer body", async t => {
  const entries = [
    { path: "src/def.ts", kind: "file", contents: CROSS_FILE_ARROW_DEF },
    { path: "src/entry.ts", kind: "file", contents: CROSS_FILE_ARROW_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-cross-arrow" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(CROSS_FILE_ARROW_ENTRY, "entry"));
  const leafId = nodeId("src/def.ts", "leaf", topLevelVariableStatementSpan(CROSS_FILE_ARROW_DEF, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, leafId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${leafId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const BLOCK_SHADOW = "function target(){return 1;} export function entry(){ {const target = () => 2; target();} return target();}";

test("CD1-T6 block-shadow binds block target and top-level target separately", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: BLOCK_SHADOW }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-block-shadow" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(BLOCK_SHADOW, "entry"));
  const blockTargetId = nodeId("src/entry.ts", "entry.target", nestedVariableDeclarationSpan(BLOCK_SHADOW, "target"));
  const topTargetId = nodeId("src/entry.ts", "target", namedFunctionSpan(BLOCK_SHADOW, "target"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, blockTargetId, topTargetId].sort());
  assert.deepEqual(
    edgePairs(result).sort(),
    [`${entryId} -> ${blockTargetId}`, `${entryId} -> ${topTargetId}`].sort(),
  );
  assert.deepEqual(unresolvedOf(result), []);
});

const CLOSURE_PARENT = "export function entry(){ function leaf(){return 1;} function inner(){return leaf();} return inner();}";

test("CD1-T6 closure-parent resolves entry.inner -> entry.leaf", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: CLOSURE_PARENT }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t6-closure-parent" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(CLOSURE_PARENT, "entry"));
  const innerId = nodeId("src/entry.ts", "entry.inner", namedFunctionSpan(CLOSURE_PARENT, "inner"));
  const leafId = nodeId("src/entry.ts", "entry.leaf", namedFunctionSpan(CLOSURE_PARENT, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, innerId, leafId].sort());
  assert.deepEqual(
    edgePairs(result).sort(),
    [`${entryId} -> ${innerId}`, `${innerId} -> ${leafId}`].sort(),
  );
  assert.deepEqual(unresolvedOf(result), []);
});

const ANONYMOUS_DEFAULT = "function leaf(){return 1;} export default function(){return leaf();}";

test("CD1-T6 anonymous-default binds the default function and expands leaf", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: ANONYMOUS_DEFAULT }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "default", 3), { requestId: "cd1-t6-anon-default" });
  const defaultId = nodeId("src/entry.ts", "default", anonymousDefaultFunctionSpan(ANONYMOUS_DEFAULT));
  const leafId = nodeId("src/entry.ts", "leaf", namedFunctionSpan(ANONYMOUS_DEFAULT, "leaf"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [defaultId, leafId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${defaultId} -> ${leafId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

// ---------------------------------------------------------------------------
// CD1-T7: F2 lexical-scope truncation and IIFE parameter shadowing (run-6).
// A nearest binding, whether callable or not, must stop the outward search.
// ---------------------------------------------------------------------------
const IIFE_PARAM_SHADOW = "export function entry(){ function target(){return 1;} ((target) => target())(null);}";

test("CD1-T7 iife-param-shadow truncates at the IIFE parameter", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: IIFE_PARAM_SHADOW }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t7-iife-param" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(IIFE_PARAM_SHADOW, "entry"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId], "IIFE parameter shadows the enclosing target, so no entry.target node");
  assert.deepEqual(edgePairs(result), [], "no entry -> entry.target edge is fabricated");
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_dynamic", code: "LEXICAL_PARAM_OR_VARIABLE_CALL" }]);
});

const CLOSURE_PARAM_SHADOW = "function target(){return 1;} export function entry(target){ function inner(){return target();} return inner();}";

test("CD1-T7 closure-param-shadow truncates at the enclosing function parameter", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: CLOSURE_PARAM_SHADOW }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t7-closure-param" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(CLOSURE_PARAM_SHADOW, "entry"));
  const innerId = nodeId("src/entry.ts", "entry.inner", namedFunctionSpan(CLOSURE_PARAM_SHADOW, "inner"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, innerId].sort(), "entry.inner retained; top-level target never bound");
  assert.ok(!result.nodes.some(node => node.lexicalScopeChain === "target"), "top-level target is not a node");
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${innerId}`], "no entry.inner -> top-level target edge");
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_dynamic", code: "LEXICAL_PARAM_OR_VARIABLE_CALL" }]);
});

const CLOSURE_LEGAL = "function topTarget(){return 1;} export function entry(){ function inner(){return topTarget();} return inner();}";

test("CD1-T7 legal closure still resolves the top-level target", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: CLOSURE_LEGAL }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t7-closure-legal" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(CLOSURE_LEGAL, "entry"));
  const innerId = nodeId("src/entry.ts", "entry.inner", namedFunctionSpan(CLOSURE_LEGAL, "inner"));
  const topId = nodeId("src/entry.ts", "topTarget", namedFunctionSpan(CLOSURE_LEGAL, "topTarget"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, innerId, topId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${innerId}`, `${innerId} -> ${topId}`].sort());
  assert.deepEqual(unresolvedOf(result), []);
});

const NEAREST_CALLABLE_SHADOW = "export function entry(target){ function middle(){ function target(){return 1;} function inner(){return target();} return inner();} return middle();}";

test("CD1-T7 nearest callable declaration wins over a farther parameter", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: NEAREST_CALLABLE_SHADOW }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t7-nearest-callable" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(NEAREST_CALLABLE_SHADOW, "entry"));
  const middleId = nodeId("src/entry.ts", "entry.middle", namedFunctionSpan(NEAREST_CALLABLE_SHADOW, "middle"));
  const innerId = nodeId("src/entry.ts", "entry.middle.inner", namedFunctionSpan(NEAREST_CALLABLE_SHADOW, "inner"));
  const targetId = nodeId("src/entry.ts", "entry.middle.target", namedFunctionSpan(NEAREST_CALLABLE_SHADOW, "target"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, middleId, innerId, targetId].sort());
  assert.deepEqual(
    edgePairs(result).sort(),
    [`${entryId} -> ${middleId}`, `${middleId} -> ${innerId}`, `${innerId} -> ${targetId}`].sort(),
  );
  assert.deepEqual(unresolvedOf(result), []);
});

const INNER_PARAM_SHADOW = "function target(){return 1;} export function entry(){ function inner(target){ return target(); } return inner(); }";

test("CD1-T7 nearest inner parameter wins over a farther top-level function", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: INNER_PARAM_SHADOW }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t7-inner-param" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(INNER_PARAM_SHADOW, "entry"));
  const innerId = nodeId("src/entry.ts", "entry.inner", namedFunctionSpan(INNER_PARAM_SHADOW, "inner"));
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.deepEqual(nodeIds(result), [entryId, innerId].sort());
  assert.deepEqual(edgePairs(result), [`${entryId} -> ${innerId}`]);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_dynamic", code: "LEXICAL_PARAM_OR_VARIABLE_CALL" }]);
});

const CHAINED_CALL = "function a(){ return { b: () => 1 }; } export function entry(){ return a().b(); }";

test("CD1-T10 chained calls extract the inner callee once", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: CHAINED_CALL }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t10-chained-call" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(CHAINED_CALL, "entry"));
  const aId = nodeId("src/entry.ts", "a", namedFunctionSpan(CHAINED_CALL, "a"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [entryId, aId].sort());
  assert.deepEqual(edgePairs(result), [`${entryId} -> ${aId}`]);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_dynamic", code: "UNRESOLVED_CALLEE_EXPRESSION" }]);
});

const DESTRUCTURED_BINDINGS = "export function entry(){ const opened = { handle: { read: () => 1 } }; const { handle: reader } = opened; const [next] = [() => 2]; reader.read(); next(); }";

test("CD1-T10 object and array destructuring bind variable leaves", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: DESTRUCTURED_BINDINGS }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t10-destructured-bindings" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(DESTRUCTURED_BINDINGS, "entry"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [entryId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [
    { kind: "unresolved_dynamic", code: "LEXICAL_PARAM_OR_VARIABLE_CALL" },
    { kind: "unresolved_dynamic", code: "LEXICAL_PARAM_OR_VARIABLE_CALL" },
  ]);
});

const BUILTIN_BIGINT = "export function entry(){ return BigInt(1); }";

test("CD1-T10 BigInt is an unshadowed builtin global", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: BUILTIN_BIGINT }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t10-bigint" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(BUILTIN_BIGINT, "entry"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [entryId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "out_of_scope_external", code: "UNSHADOWED_BUILTIN_GLOBAL" }]);
});

// ---------------------------------------------------------------------------
// CD1-T1: exact depth truncation d in {0,1,2,3} and .js -> .ts resolution.
// ---------------------------------------------------------------------------
const CHAIN = Object.freeze([
  { path: "src/a.ts", kind: "file", contents: 'import { b } from "./b.js";\nexport function a() { return b(); }\n' },
  { path: "src/b.ts", kind: "file", contents: 'import { c } from "./c.js";\nexport function b() { return c(); }\n' },
  { path: "src/c.ts", kind: "file", contents: 'import { d } from "./d.js";\nexport function c() { return d(); }\n' },
  { path: "src/d.ts", kind: "file", contents: 'export function d() { return 1; }\n' },
]);

for (const depth of [0, 1, 2, 3]) {
  test(`CD1-T1 depth ${depth} truncates exactly and resolves .js to .ts`, async t => {
    const { result } = await runFixture(t, CHAIN, goal("src/a.ts", "a", depth), { requestId: `cd1-t1-${depth}` });
    assert.equal(result.status, "achieved");
    assert.equal(result.resolution, "complete");
    assert.equal(result.requestedMaxDepth, depth);
    assert.equal(result.achievedDepth, depth);

    const expectedNodes = result.nodes
      .filter(node => node.minDepth <= depth)
      .map(node => node.minDepth);
    assert.equal(result.nodes.length, depth + 1, "only the entry chain up to depth d is present");
    assert.deepEqual(expectedNodes.sort(), [...Array(depth + 1).keys()]);

    for (const node of result.nodes) {
      assert.ok(node.filePath.endsWith(".ts"), "relative .js imports resolve to real .ts files");
      assert.equal(node.bodyExtracted, node.minDepth < depth, "only nodes strictly above the bound are expanded");
    }
    assert.equal(result.edges.length, depth, "one edge per traversed level");
    assert.equal(duplicateAstFileReads(result), 0, "no duplicate AST reads");
    assert.equal(result.counters.initialAstFileReadCalls, depth + 1);
    assert.equal(result.counters.closureVerifyFileReadCalls, depth + 1);
  });
}

// ---------------------------------------------------------------------------
// CD1-T2: A<->B mutual recursion + B->C->D escape + shallow reopen of C.
// C alone reachable through B sits at depth 2 (== maxDepth, unexpanded); the
// direct shallow edge keeps it at depth 1 so C->D is not dropped. Zero
// duplicate AST reads.
// ---------------------------------------------------------------------------
const DIAMOND = Object.freeze([
  { path: "src/a.ts", kind: "file", contents: 'import { b } from "./b.js";\nimport { c } from "./c.js";\nexport function a() { return b() + c(); }\n' },
  { path: "src/b.ts", kind: "file", contents: 'import { a } from "./a.js";\nimport { c } from "./c.js";\nexport function b() { return a() + c(); }\n' },
  { path: "src/c.ts", kind: "file", contents: 'import { d } from "./d.js";\nexport function c() { return d(); }\n' },
  { path: "src/d.ts", kind: "file", contents: 'export function d() { return 1; }\n' },
]);

test("CD1-T2 mutual recursion, escape branch and shallow reopen keep C->D", async t => {
  const { result } = await runFixture(t, DIAMOND, goal("src/a.ts", "a", 2), { requestId: "cd1-t2" });
  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");

  const aId = nodeId("src/a.ts", "a", namedFunctionSpan(DIAMOND[0].contents, "a"));
  const bId = nodeId("src/b.ts", "b", namedFunctionSpan(DIAMOND[1].contents, "b"));
  const cId = nodeId("src/c.ts", "c", namedFunctionSpan(DIAMOND[2].contents, "c"));
  const dId = nodeId("src/d.ts", "d", namedFunctionSpan(DIAMOND[3].contents, "d"));

  assert.deepEqual(nodeIds(result), [aId, bId, cId, dId].sort());
  assert.equal(nodeById(result, aId).minDepth, 0);
  assert.equal(nodeById(result, bId).minDepth, 1);
  assert.equal(nodeById(result, cId).minDepth, 1, "shallow A->C keeps C at depth 1, not the deeper B path");
  assert.equal(nodeById(result, cId).bodyExtracted, true);
  assert.equal(nodeById(result, dId).minDepth, 2);

  const pairs = edgePairs(result);
  assert.ok(pairs.includes(`${cId} -> ${dId}`), "C -> D escape edge is captured");
  assert.ok(pairs.includes(`${aId} -> ${bId}`));
  assert.ok(pairs.includes(`${bId} -> ${aId}`), "A <-> B mutual edge present");
  const cycleEdges = result.edges.filter(edge => edge.isCycleEdge).map(edge => `${edge.callerId} -> ${edge.calleeId}`);
  assert.ok(cycleEdges.includes(`${aId} -> ${bId}`) && cycleEdges.includes(`${bId} -> ${aId}`));
  assert.equal(result.edges.length, 5);
  assert.equal(duplicateAstFileReads(result), 0, "zero duplicate AST reads across the reopen");
  assert.equal(result.counters.initialAstFileReadCalls, 4);
});

// ---------------------------------------------------------------------------
// CD1-T3: eight self-contained anchor examples Ex-1..Ex-6 (with 4a/4b/4c).
// ---------------------------------------------------------------------------
const EX1 = [
  "function leafA() { return 1; }",
  "function leafB() { return 2; }",
  "export function a() {",
  "  function inner() { return leafA(); }",
  "  return inner();",
  "}",
  "export function b() {",
  "  function inner() { return leafB(); }",
  "  return inner();",
  "}",
].join("\n");

test("CD1-T3 Ex-1 distinguishes same-file local inner() and rejects ambiguous entry", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: EX1 }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "a", 2), { requestId: "cd1-t3-ex1" });
  const aId = nodeId("src/entry.ts", "a", namedFunctionSpan(EX1, "a"));
  const aInnerId = nodeId("src/entry.ts", "a.inner", namedFunctionSpan(EX1, "inner"));
  const leafAId = nodeId("src/entry.ts", "leafA", namedFunctionSpan(EX1, "leafA"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [aId, aInnerId, leafAId].sort());
  assert.equal(nodeById(result, aId).minDepth, 0);
  assert.equal(nodeById(result, aInnerId).minDepth, 1);
  assert.equal(nodeById(result, leafAId).minDepth, 2);
  assert.ok(!result.nodes.some(node => node.lexicalScopeChain === "b.inner"), "b.inner never collides");
  assert.deepEqual(edgePairs(result).sort(), [`${aId} -> ${aInnerId}`, `${aInnerId} -> ${leafAId}`].sort());
  assert.deepEqual(unresolvedOf(result), []);

  const ambiguous = await runFixture(t, entries, goal("src/entry.ts", "inner", 2), { requestId: "cd1-t3-ex1-amb" });
  assert.equal(ambiguous.result.status, "unmet");
  assert.equal(ambiguous.result.resolution, "ambiguous_entry_symbol");
  assert.equal(ambiguous.result.nodes.length, 0, "ambiguous entry is never resolved by guessing");
});

const EX2_DEF = ["function target() { return 42; }", "export default () => target();"].join("\n");
const EX2_ENTRY = ['import runDef from "./def.js";', "export function main() { return runDef(); }"].join("\n");

test("CD1-T3 Ex-2 resolves export-default anonymous arrow and its span", async t => {
  const entries = [
    { path: "src/def.ts", kind: "file", contents: EX2_DEF },
    { path: "src/entry.ts", kind: "file", contents: EX2_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t3-ex2" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(EX2_ENTRY, "main"));
  const defaultId = nodeId("src/def.ts", "default", defaultArrowSpan(EX2_DEF));
  const targetId = nodeId("src/def.ts", "target", namedFunctionSpan(EX2_DEF, "target"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, defaultId, targetId].sort());
  assert.equal(nodeById(result, defaultId).minDepth, 1);
  assert.deepEqual(edgePairs(result).sort(), [`${mainId} -> ${defaultId}`, `${defaultId} -> ${targetId}`].sort());
});

const EX3 = [
  "export function calc(Math: { max: (a: number, b: number) => number }, parseInt: (s: string) => number) {",
  '  return Math.max(1, parseInt("2")) + JSON.stringify(1).length;',
  "}",
].join("\n");

test("CD1-T3 Ex-3 parameter shadowing of Math/parseInt wins over builtins", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: EX3 }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "calc", 2), { requestId: "cd1-t3-ex3" });
  const calcId = nodeId("src/entry.ts", "calc", namedFunctionSpan(EX3, "calc"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [calcId]);
  assert.deepEqual(edgePairs(result), []);
  const byExpr = new Map(result.unresolvedCallsites.map(call => [call.calleeExpr, call]));
  assert.equal(byExpr.get("Math.max").kind, "unresolved_dynamic");
  assert.equal(byExpr.get("Math.max").reasonCode, "LEXICAL_PARAM_OR_VARIABLE_CALL");
  assert.equal(byExpr.get("parseInt").kind, "unresolved_dynamic");
  assert.equal(byExpr.get("parseInt").reasonCode, "LEXICAL_PARAM_OR_VARIABLE_CALL");
  assert.equal(byExpr.get("JSON.stringify").kind, "out_of_scope_external");
  assert.equal(byExpr.get("JSON.stringify").reasonCode, "UNSHADOWED_BUILTIN_GLOBAL");
});

test("CD1-T3 Ex-4a explicit non-function export shadows export *", async t => {
  const entries = [
    { path: "src/impl.ts", kind: "file", contents: "export function fn() { return 10; }\n" },
    { path: "src/index.ts", kind: "file", contents: 'export const fn = 1;\nexport * from "./impl.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: 'import { fn } from "./index.js";\nexport function main() { return (fn as unknown as () => number)(); }\n' },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t3-ex4a" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(entries[2].contents, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId], "impl.ts#fn must never be bound");
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "BOUND_EXPORT_NOT_CALLABLE_FUNCTION" }]);
});

const EX4B_ENTRY = 'import { fn } from "./index.js";\nexport function main() { return fn(); }\n';

test("CD1-T3 Ex-4b conflicting export * (const vs function) is ambiguous", async t => {
  const entries = [
    { path: "src/a.ts", kind: "file", contents: "export const fn = 1;\n" },
    { path: "src/b.ts", kind: "file", contents: "export function fn() { return 2; }\n" },
    { path: "src/index.ts", kind: "file", contents: 'export * from "./a.js";\nexport * from "./b.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: EX4B_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t3-ex4b" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(EX4B_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId], "one callable branch alone never claims a unique binding");
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "AMBIGUOUS_BARREL_WILDCARD_EXPORT" }]);
});

test("CD1-T3 Ex-4c diamond export * of one origin declaration de-duplicates", async t => {
  const entries = [
    { path: "src/shared.ts", kind: "file", contents: "export function fn() { return 9; }\n" },
    { path: "src/left.ts", kind: "file", contents: 'export * from "./shared.js";\n' },
    { path: "src/right.ts", kind: "file", contents: 'export { fn } from "./shared.js";\n' },
    { path: "src/index.ts", kind: "file", contents: 'export * from "./left.js";\nexport * from "./right.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: EX4B_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t3-ex4c" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(EX4B_ENTRY, "main"));
  const fnId = nodeId("src/shared.ts", "fn", namedFunctionSpan(entries[0].contents, "fn"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, fnId].sort());
  assert.deepEqual(edgePairs(result), [`${mainId} -> ${fnId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

test("CD1-T3 Ex-5 export type does not disturb the single runtime function", async t => {
  const entries = [
    { path: "src/types.ts", kind: "file", contents: "export type fn = () => number;\n" },
    { path: "src/runtime.ts", kind: "file", contents: "export function fn() { return 7; }\n" },
    { path: "src/index.ts", kind: "file", contents: 'export * from "./types.js";\nexport * from "./runtime.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: EX4B_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t3-ex5" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(EX4B_ENTRY, "main"));
  const fnId = nodeId("src/runtime.ts", "fn", namedFunctionSpan(entries[1].contents, "fn"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, fnId].sort());
  assert.deepEqual(edgePairs(result), [`${mainId} -> ${fnId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const EX6 = [
  'function iifeTarget() { return "ok"; }',
  "function tmplTarget(x: string) { return x; }",
  "function cbTarget(x: number) { return x; }",
  "export function entry() {",
  "  const s = (() => iifeTarget())();",
  "  const arr = [1].map(x => cbTarget(x));",
  "  return `${tmplTarget(s)}-${arr.length}`;",
  "}",
].join("\n");

test("CD1-T3 Ex-6 IIFE inlines, template interpolation kept, uncalled callback isolated", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: EX6 }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 2), { requestId: "cd1-t3-ex6" });
  const entryId = nodeId("src/entry.ts", "entry", namedFunctionSpan(EX6, "entry"));
  const iifeId = nodeId("src/entry.ts", "iifeTarget", namedFunctionSpan(EX6, "iifeTarget"));
  const tmplId = nodeId("src/entry.ts", "tmplTarget", namedFunctionSpan(EX6, "tmplTarget"));
  const cbId = nodeId("src/entry.ts", "cbTarget", namedFunctionSpan(EX6, "cbTarget"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [entryId, iifeId, tmplId].sort());
  assert.ok(!result.nodes.some(node => node.nodeId === cbId), "uncalled callback cbTarget stays isolated");
  assert.deepEqual(edgePairs(result).sort(), [`${entryId} -> ${iifeId}`, `${entryId} -> ${tmplId}`].sort());
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_dynamic", code: "UNRESOLVED_CALLEE_EXPRESSION" }]);
});

// ---------------------------------------------------------------------------
// CD1-T4: source-content consistency (C2). Single file with three mutually
// calling functions proves zero duplicate AST reads; an in-place same-inode
// rewrite between the initial read and the per-file closure verification must
// surface as unknown/insufficient_evidence while keeping the partial graph; a
// file above the explicit 1 MiB bound is unknown with no AST parsed.
// ---------------------------------------------------------------------------
const THREE_FN = [
  "function helper() { return 1; }",
  "function mid() { return helper(); }",
  "export function entry() { return mid(); }",
].join("\n");

test("CD1-T4 unchanged source reuses one AST read across three functions", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: THREE_FN }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), { requestId: "cd1-t4-reuse" });
  assert.equal(result.status, "achieved");
  assert.equal(result.nodes.length, 3, "entry, mid and helper all expand from one file");
  assert.equal(result.counters.initialAstFileReadCalls, 1, "single initial AST read for the whole file");
  assert.equal(result.counters.closureVerifyFileReadCalls, 1, "one per-file closure verification read");
  assert.equal(duplicateAstFileReads(result), 0, "no duplicate AST reads across middle steps");
  assert.equal(result.finalState.files[0].verifiedUnchangedAtClosure, true);
});

test("CD1-T4 same-inode in-place rewrite between reads is unknown with partial graph", async t => {
  const rewritten = THREE_FN.replace("return 1", "return 999");
  assert.notEqual(rewritten, THREE_FN, "the rewrite must actually change bytes");
  let opens = 0;
  let rewrittenPath = null;
  let initialIdentity = null;
  const fileReadIo = {
    lstat: (path, options) => lstat(path, options),
    async open(path, flags) {
      if (path.endsWith("src/entry.ts")) {
        opens += 1;
        if (opens === 1) {
          const stat = await lstat(path);
          initialIdentity = { dev: stat.dev, ino: stat.ino };
        } else if (opens === 2) {
          // Same dev/ino right before the in-place write.
          const stat = await lstat(path);
          assert.equal(stat.dev, initialIdentity.dev, "dev unchanged before rewrite");
          assert.equal(stat.ino, initialIdentity.ino, "ino unchanged before rewrite");
          rewrittenPath = path;
          // First open was the initial AST read; rewrite before the closure verify open.
          await writeFile(path, rewritten);
        }
      }
      return fsOpen(path, flags);
    },
  };
  const entries = [{ path: "src/entry.ts", kind: "file", contents: THREE_FN }];
  const { result, root } = await runFixture(t, entries, goal("src/entry.ts", "entry", 3), {
    requestId: "cd1-t4-inode",
    fileReadIo,
  });
  assert.equal(opens, 2, "exactly the initial read and the closure verification read");
  assert.notEqual(initialIdentity, null, "initial read was observed before the rewrite");
  assert.equal(rewrittenPath, join(root, "cd1", "src", "entry.ts"), "sandbox reads the physical scenario file");

  // The rewrite happened in place: no cd, same dev, same inode, changed bytes.
  const after = await lstat(rewrittenPath);
  assert.equal(after.dev, initialIdentity.dev, "rewrite kept the same device");
  assert.equal(after.ino, initialIdentity.ino, "rewrite kept the same inode");
  assert.equal(await readFile(rewrittenPath, "utf8"), rewritten, "file bytes really changed");

  assert.equal(result.status, "unknown");
  assert.equal(result.resolution, "insufficient_evidence");
  assert.equal(result.finalState.sourceConsistencyFailed, true);
  assert.equal(result.counters.closureVerifiedFilesCount, 0);
  assert.equal(result.nodes.length, 3, "partial nodes stay visible");
  assert.equal(result.edges.length, 2, "partial edges stay visible");
});

test("CD1-T4 file above the explicit 1 MiB bound is unknown and unparsed", async t => {
  const entries = [{ path: "src/big.ts", kind: "file", contents: "x".repeat(1_048_577) }];
  const { result } = await runFixture(t, entries, goal("src/big.ts", "big", 2), { requestId: "cd1-t4-truncated" });
  assert.equal(result.status, "unknown");
  assert.equal(result.resolution, "insufficient_evidence");
  assert.equal(result.finalState.truncated, true);
  assert.equal(result.counters.closureVerifyFileReadCalls, 0, "truncation stops before closure verification");
  assert.equal(result.nodes.length, 0, "no AST is parsed from a truncated file");
});

// ---------------------------------------------------------------------------
// CD1-T5: out-of-scope escape and missing permission block with zero execution;
// separate engineering case: budget exhaustion plus continuation resume.
// ---------------------------------------------------------------------------
test("CD1-T5 out-of-scope entry is rejected with zero execution", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: "export function entry() { return 1; }\n" }];
  const escape = await runFixture(t, entries, goal("../evil.ts", "entry", 2), { requestId: "cd1-t5-escape" });
  assert.equal(escape.result.status, "rejected");
  assert.equal(escape.result.resolution, "rejected");
  assert.equal(escape.result.counters.sandboxApiCalls, 0, "no sandbox call before rejection");

  const absolute = await runFixture(t, entries, goal("/etc/passwd", "entry", 2), { requestId: "cd1-t5-abs" });
  assert.equal(absolute.result.status, "rejected");
  assert.equal(absolute.result.counters.sandboxApiCalls, 0);
});

test("CD1-T5 missing filesystem.read permission is rejected with zero execution", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: "export function entry() { return 1; }\n" }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "entry", 2), {
    requestId: "cd1-t5-denied",
    grantedEffects: ["process.exec"],
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.resolution, "rejected");
  assert.equal(result.counters.sandboxApiCalls, 0, "effect denial blocks before any sandbox call");
});

test("CD1-T5 budget stop yields continuation that resumes to completion", async t => {
  const { result: first, sandbox, session } = await runFixture(t, CHAIN, goal("src/a.ts", "a", 3), {
    requestId: "cd1-t5-budget",
    limits: { maxTransitions: 4, maxDepth: 8, maxDerivedGoals: 20 },
  });
  assert.equal(first.status, "unknown");
  assert.equal(first.resolution, "budget_exhausted");
  assert.notEqual(first.response?.report?.continuation ?? null, null, "budget stop returns a continuation");
  assert.equal(first.response.report.control.stopReason, "budget");

  const resumed = await resume(first, sandbox, session, goal("src/a.ts", "a", 3), "cd1-t5-budget");
  const second = resumed.result;
  assert.equal(second.status, "achieved");
  assert.equal(second.resolution, "complete");
  assert.equal(second.nodes.length, 4, "resume captures the whole chain");
  assert.equal(second.edges.length, 3);
  assert.equal(second.response?.report?.continuation ?? null, null, "no continuation after completion");
  assert.ok(
    second.response.report.budgetUsed.transitionsUsed > first.response.report.budgetUsed.transitionsUsed,
    "resumed run records more transitions than the truncated first run",
  );
});

// ---------------------------------------------------------------------------
// CD1-T8: P1 module-resolution contract gaps found by the independent CD-1
// review. .mjs/.js extension candidates, type-only default import, and the
// export * barrel depth bound (at most two star hops).
// ---------------------------------------------------------------------------
const T8_MJS_ENTRY = 'import { fn } from "./impl.mjs";\nexport function main(){ return fn(); }\n';
const T8_MJS_IMPL = "export function fn(){ return 1; }\n";

test("CD1-T8 .mjs import resolves to the sibling .mts candidate", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T8_MJS_ENTRY },
    { path: "src/impl.mts", kind: "file", contents: T8_MJS_IMPL },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-mjs-pos" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_MJS_ENTRY, "main"));
  const fnId = nodeId("src/impl.mts", "fn", namedFunctionSpan(T8_MJS_IMPL, "fn"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, fnId].sort());
  assert.deepEqual(edgePairs(result).sort(), [`${mainId} -> ${fnId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

test("CD1-T8 .mjs import with no .mts/.mjs on disk stays unresolved", async t => {
  const entries = [{ path: "src/entry.ts", kind: "file", contents: T8_MJS_ENTRY }];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-mjs-neg" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_MJS_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "MODULE_FILE_NOT_FOUND" }]);
});

const T8_TYPEONLY_DEF = "export default function(){ return 1; }\n";
const T8_TYPEONLY_NEG_ENTRY = 'import type runDef from "./def.js";\nexport function main(){ return runDef(); }\n';
const T8_TYPEONLY_POS_ENTRY = 'import runDef from "./def.js";\nexport function main(){ return runDef(); }\n';

test("CD1-T8 type-only default import never produces a runtime call edge", async t => {
  const entries = [
    { path: "src/def.ts", kind: "file", contents: T8_TYPEONLY_DEF },
    { path: "src/entry.ts", kind: "file", contents: T8_TYPEONLY_NEG_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-typeonly-neg" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_TYPEONLY_NEG_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "TYPE_ONLY_IMPORT_OR_DECLARATION" }]);
});

test("CD1-T8 normal default import still resolves the default export", async t => {
  const entries = [
    { path: "src/def.ts", kind: "file", contents: T8_TYPEONLY_DEF },
    { path: "src/entry.ts", kind: "file", contents: T8_TYPEONLY_POS_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-typeonly-pos" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_TYPEONLY_POS_ENTRY, "main"));
  const defaultId = nodeId("src/def.ts", "default", anonymousDefaultFunctionSpan(T8_TYPEONLY_DEF));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, defaultId].sort());
  assert.deepEqual(edgePairs(result), [`${mainId} -> ${defaultId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

const T8_BARREL_ENTRY = 'import { fn } from "./index.js";\nexport function main(){ return fn(); }\n';
const T8_BARREL_IMPL = "export function fn(){ return 1; }\n";

test("CD1-T8 two-hop export * barrel resolves the final explicit export", async t => {
  const entries = [
    { path: "src/impl.ts", kind: "file", contents: T8_BARREL_IMPL },
    { path: "src/layer1.ts", kind: "file", contents: 'export * from "./impl.js";\n' },
    { path: "src/index.ts", kind: "file", contents: 'export * from "./layer1.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: T8_BARREL_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-barrel-boundary" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_BARREL_ENTRY, "main"));
  const fnId = nodeId("src/impl.ts", "fn", namedFunctionSpan(T8_BARREL_IMPL, "fn"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId, fnId].sort());
  assert.deepEqual(edgePairs(result), [`${mainId} -> ${fnId}`]);
  assert.deepEqual(unresolvedOf(result), []);
});

test("CD1-T8 three-hop export * barrel stays unresolved with BARREL_DEPTH_EXCEEDED", async t => {
  const entries = [
    { path: "src/impl.ts", kind: "file", contents: T8_BARREL_IMPL },
    { path: "src/layer2.ts", kind: "file", contents: 'export * from "./impl.js";\n' },
    { path: "src/layer1.ts", kind: "file", contents: 'export * from "./layer2.js";\n' },
    { path: "src/index.ts", kind: "file", contents: 'export * from "./layer1.js";\n' },
    { path: "src/entry.ts", kind: "file", contents: T8_BARREL_ENTRY },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t8-barrel-exceeded" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T8_BARREL_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "BARREL_DEPTH_EXCEEDED" }]);
});

// ---------------------------------------------------------------------------
// CD1-T9: P1 type-space classification gap found by the second-round review.
// A resolution chain that reaches only TypeScript type-space exports must stay
// unresolved with TYPE_ONLY_IMPORT_OR_DECLARATION instead of the ordinary
// missing-runtime-export code. A genuinely absent export must keep
// EXPORT_NAME_NOT_FOUND.
// ---------------------------------------------------------------------------
const T9_TYPE_ALIAS_ENTRY = 'import { fn } from "./types.js";\nexport function main(){ return fn(); }\n';
const T9_TYPE_ALIAS_DEF = "export type fn = () => number;\n";

test("CD1-T9 direct type alias import stays unresolved as type-only", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T9_TYPE_ALIAS_ENTRY },
    { path: "src/types.ts", kind: "file", contents: T9_TYPE_ALIAS_DEF },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t9-type-alias" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T9_TYPE_ALIAS_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "TYPE_ONLY_IMPORT_OR_DECLARATION" }]);
});

const T9_IFACE_ENTRY = 'import { fn } from "./iface.js";\nexport function main(){ return fn(); }\n';
const T9_IFACE_DEF = "export interface fn { (): number; }\n";

test("CD1-T9 direct interface import stays unresolved as type-only", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T9_IFACE_ENTRY },
    { path: "src/iface.ts", kind: "file", contents: T9_IFACE_DEF },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t9-interface" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T9_IFACE_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "TYPE_ONLY_IMPORT_OR_DECLARATION" }]);
});

const T9_LOCAL_ENTRY = 'import { fn } from "./local.js";\nexport function main(){ return fn(); }\n';
const T9_LOCAL_DEF = "interface fn { (): number; }\nexport type { fn };\n";

test("CD1-T9 local type-only named reexport stays unresolved as type-only", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T9_LOCAL_ENTRY },
    { path: "src/local.ts", kind: "file", contents: T9_LOCAL_DEF },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t9-local" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T9_LOCAL_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "TYPE_ONLY_IMPORT_OR_DECLARATION" }]);
});

const T9_BARREL_ENTRY = 'import { fn } from "./index.js";\nexport function main(){ return fn(); }\n';
const T9_BARREL_INDEX = 'export * from "./types.js";\n';
const T9_BARREL_TYPES = "export type fn = () => number;\n";

test("CD1-T9 export * type-only barrel stays unresolved as type-only", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T9_BARREL_ENTRY },
    { path: "src/index.ts", kind: "file", contents: T9_BARREL_INDEX },
    { path: "src/types.ts", kind: "file", contents: T9_BARREL_TYPES },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t9-barrel" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T9_BARREL_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "TYPE_ONLY_IMPORT_OR_DECLARATION" }]);
});

const T9_MISSING_ENTRY = 'import { missing } from "./mod.js";\nexport function main(){ return missing(); }\n';
const T9_MISSING_MOD = "export const other = 1;\n";

test("CD1-T9 genuinely absent export keeps EXPORT_NAME_NOT_FOUND", async t => {
  const entries = [
    { path: "src/entry.ts", kind: "file", contents: T9_MISSING_ENTRY },
    { path: "src/mod.ts", kind: "file", contents: T9_MISSING_MOD },
  ];
  const { result } = await runFixture(t, entries, goal("src/entry.ts", "main", 2), { requestId: "cd1-t9-missing" });
  const mainId = nodeId("src/entry.ts", "main", namedFunctionSpan(T9_MISSING_ENTRY, "main"));
  assert.equal(result.status, "achieved");
  assert.deepEqual(nodeIds(result), [mainId]);
  assert.deepEqual(edgePairs(result), []);
  assert.deepEqual(unresolvedOf(result), [{ kind: "unresolved_missing_or_ambiguous_target", code: "EXPORT_NAME_NOT_FOUND" }]);
});
