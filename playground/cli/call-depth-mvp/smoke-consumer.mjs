// Public CD-1 consumer: runs `runCliCalleeCallGraphGoal` through the package
// subpath against a real temporary filesystem sandbox and asserts the
// node/edge facts, depth truncation and the measured read/counter costs. The
// consumer only imports the built public entry; it never imports the AST
// policy or adapter directly. It reads nothing outside its own temp scene.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliFilesystemSandbox, runCliCalleeCallGraphGoal } from "nnanything/cli-call-depth";

const SCOPE = Object.freeze(["src"]);

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

const CHAIN = Object.freeze([
  { path: "src/a.ts", kind: "file", contents: 'import { b } from "./b.js";\nexport function a() { return b() + Math.max(1, 2); }\n' },
  { path: "src/b.ts", kind: "file", contents: 'import { c } from "./c.js";\nexport function b() { return c(); }\n' },
  { path: "src/c.ts", kind: "file", contents: 'export function c() { return 3; }\n' },
]);

async function fixture(entries, requestId, maxDepth = 2) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cd1-consumer-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "cd1",
      entries,
      sessions: [{ id: "s", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  const session = sandbox.bindSession("s");
  const result = await runCliCalleeCallGraphGoal({ requestId, rootGoal: goal(entries[0].path, "a", maxDepth) }, { sandbox, session });
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
  return result;
}

const deep = await fixture(CHAIN, "smoke-deep");
assert.equal(deep.status, "achieved");
assert.equal(deep.resolution, "complete");
assert.equal(deep.requestedMaxDepth, 2);
assert.equal(deep.achievedDepth, 2);
assert.equal(deep.nodes.length, 3, "a, b and c at depths 0..2");
assert.deepEqual(deep.nodes.map(node => node.symbolName).sort(), ["a", "b", "c"]);
assert.deepEqual(deep.nodes.map(node => node.filePath).sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
assert.equal(deep.edges.length, 2, "a->b and b->c, all resolved in repo");
assert.ok(deep.edges.every(edge => edge.edgeKind === "resolved_in_repo"));
assert.ok(deep.nodes.every(node => node.filePath.endsWith(".ts")), ".js relative imports resolve to .ts");
const byDepth = deep.nodes.slice().sort((left, right) => left.minDepth - right.minDepth);
assert.equal(byDepth[0].bodyExtracted, true, "entry below the bound is expanded");
assert.equal(byDepth[1].bodyExtracted, true, "middle node below the bound is expanded");
assert.equal(byDepth[2].bodyExtracted, false, "node at the bound stays unexpanded");
assert.deepEqual(deep.unresolvedCallsites.map(call => [call.calleeExpr, call.kind, call.reasonCode]),
  [["Math.max", "out_of_scope_external", "UNSHADOWED_BUILTIN_GLOBAL"]]);
assert.equal(deep.counters.initialAstFileReadCalls, 3, "one initial read per distinct file");
assert.equal(deep.counters.closureVerifyFileReadCalls, 3, "one closure verify read per distinct file");
assert.equal(deep.counters.closureVerifiedFilesCount, 3, "all files verified at closure");
assert.equal(deep.counters.sandboxApiCalls, 6, "three initial reads + three closure verifies");
assert.equal(deep.finalState.sourceConsistencyFailed, false);
assert.equal(deep.finalState.truncated, false);

const truncated = await fixture([CHAIN[0]], "smoke-truncate", 0);
assert.equal(truncated.status, "achieved");
assert.equal(truncated.requestedMaxDepth, 0);
assert.equal(truncated.achievedDepth, 0);
assert.equal(truncated.nodes.length, 1, "depth 0 keeps only the entry");
assert.equal(truncated.edges.length, 0);
assert.equal(truncated.counters.initialAstFileReadCalls, 1);
assert.equal(truncated.counters.closureVerifyFileReadCalls, 1);

console.log(JSON.stringify({
  status: "passed",
  packageEntry: "nnanything/cli-call-depth",
  deep: {
    status: deep.status,
    resolution: deep.resolution,
    nodes: deep.nodes.map(node => ({ symbolName: node.symbolName, filePath: node.filePath, minDepth: node.minDepth, bodyExtracted: node.bodyExtracted })),
    edges: deep.edges.map(edge => ({ edgeKind: edge.edgeKind })),
    unresolved: deep.unresolvedCallsites.map(call => ({ calleeExpr: call.calleeExpr, kind: call.kind, reasonCode: call.reasonCode })),
    counters: deep.counters,
  },
  truncated: {
    status: truncated.status,
    requestedMaxDepth: truncated.requestedMaxDepth,
    achievedDepth: truncated.achievedDepth,
    nodes: truncated.nodes.length,
    edges: truncated.edges.length,
    counters: truncated.counters,
  },
}, null, 2));
