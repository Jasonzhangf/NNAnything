// Batch B Rust call-depth MVP regression: deterministic edges for RS_POS_1..4
// and zero fabricated edges with structured reason codes for RS_NEG_1..6.
// This file is a black-box driver over the compiled policy and adapter; the
// textCandidates union disposition mapping is produced by the shared public
// `lib/cli-call-depth.ts` and remains outside this worker's write boundary.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dist = relative => pathToFileURL(join(repoRoot, "dist", relative)).href;
const policy = await import(dist("filters/rust-call-depth-policy.js"));
const adapterModule = await import(dist("adapters/cli/rust-call-depth-adapter.js"));

const FIXTURES = join(repoRoot, "tests", "fixtures", "rust-calls");

const POSITIVE_CASES = [
  {
    id: "RS_POS_1",
    entryFile: "src/lib.rs",
    entrySymbol: "entry_dispatch",
    maxDepth: 2,
    edges: [
      ["src/lib.rs#entry_dispatch", "src/lib.rs#validate_limit", 25, "same_file"],
      ["src/lib.rs#entry_dispatch", "src/lib.rs#Worker::new", 28, "same_file"],
      ["src/lib.rs#entry_dispatch", "src/lib.rs#Worker::execute", 29, "same_file"],
      ["src/lib.rs#Worker::execute", "src/lib.rs#Worker::compute_step", 12, "same_file"],
    ],
    unresolved: [],
  },
  {
    id: "RS_POS_2",
    entryFile: "src/lib.rs",
    entrySymbol: "run_entry",
    maxDepth: 3,
    edges: [
      ["src/lib.rs#run_entry", "src/policy.rs#evaluate_retry", 7, "cross_file_direct"],
      ["src/lib.rs#run_entry", "src/backoff.rs#wait_tick", 9, "cross_file_direct"],
      ["src/policy.rs#evaluate_retry", "src/policy.rs#evaluate_retry", 6, "same_file"],
    ],
    unresolved: [],
  },
  {
    id: "RS_POS_3",
    entryFile: "src/lib.rs",
    entrySymbol: "run_alpha_only",
    maxDepth: 2,
    edges: [
      ["src/lib.rs#run_alpha_only", "src/alpha.rs#process", 7, "cross_file_direct"],
      ["src/alpha.rs#process", "src/alpha.rs#alpha_leaf", 6, "same_file"],
    ],
    unresolved: [],
  },
  {
    id: "RS_POS_4",
    entryFile: "src/engine/runner.rs",
    entrySymbol: "start_runner",
    maxDepth: 2,
    edges: [
      ["src/engine/runner.rs#start_runner", "src/core_target.rs#resolve_target", 4, "cross_file_direct"],
      ["src/core_target.rs#resolve_target", "src/core_target.rs#verify_target_health", 6, "same_file"],
    ],
    unresolved: [],
  },
];

const NEGATIVE_CASES = [
  {
    id: "RS_NEG_1",
    entryFile: "src/lib.rs",
    entrySymbol: "select_slot",
    maxDepth: 2,
    edges: [],
    unresolved: ["RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH"],
  },
  {
    id: "RS_NEG_2",
    entryFile: "src/lib.rs",
    entrySymbol: "run_untyped_and_colliding",
    maxDepth: 2,
    edges: [["src/lib.rs#run_untyped_and_colliding", "src/lib.rs#make_node", 20, "same_file"]],
    unresolved: ["RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH"],
  },
  {
    id: "RS_NEG_3",
    entryFile: "src/lib.rs",
    entrySymbol: "handle_event",
    maxDepth: 2,
    edges: [],
    unresolved: ["RUST_MACRO_INVOCATION_UNEXPANDED", "RUST_MACRO_INVOCATION_UNEXPANDED"],
  },
  {
    id: "RS_NEG_4",
    entryFile: "src/lib.rs",
    entrySymbol: "run_compute",
    maxDepth: 2,
    edges: [],
    unresolved: ["RUST_CFG_CONDITIONAL_TARGET"],
  },
  {
    id: "RS_NEG_5",
    entryFile: "src/lib.rs",
    entrySymbol: "run_with_hook",
    maxDepth: 2,
    edges: [],
    unresolved: ["LEXICAL_PARAM_OR_CLOSURE_CALL", "LEXICAL_PARAM_OR_CLOSURE_CALL"],
  },
  {
    id: "RS_NEG_6",
    entryFile: "src/lib.rs",
    entrySymbol: "run_glob_and_ext",
    maxDepth: 2,
    edges: [],
    unresolved: ["EXTERNAL_CRATE_OR_STD_CALL", "RUST_GLOB_USE_AMBIGUOUS_TARGET"],
  },
];

async function collectFiles(dir, base, out = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute, base, out);
    } else if (entry.name.endsWith(".rs")) {
      const rel = absolute.slice(base.length + 1).split(/[\\/]/).join("/");
      out.set(rel, await readFile(absolute, "utf8"));
    }
  }
  return out;
}

function makeStore(files) {
  const parsed = new Map();
  for (const [rel, text] of files) parsed.set(rel, policy.parseRustSourceFile(rel, text));
  return {
    get(rel) { return parsed.get(rel); },
    has(rel) { return parsed.has(rel); },
    isMissing() { return false; },
    request() {},
  };
}

function analyze(testCase) {
  return policy.analyzeRustCalls(makeStore(testCase.files), ["src"], testCase.entryFile, testCase.entrySymbol, testCase.maxDepth);
}

function edgeShapes(edges) {
  return edges.map(edge => [edge.callerId, edge.calleeId, edge.callsiteSpan.startLine, edge.resolutionKind]);
}

function sortShapes(shapes) {
  return shapes
    .map(shape => shape.join("\u0000"))
    .sort();
}

test("RS_POS_1..4 deterministic edges with recall and precision 1.0", async () => {
  for (const fixture of POSITIVE_CASES) {
    const files = await collectFiles(join(FIXTURES, fixture.id), join(FIXTURES, fixture.id));
    const result = analyze({ ...fixture, files });
    assert.equal(result.entryResolution, "ok", `${fixture.id} entry resolution`);
    assert.deepEqual(sortShapes(edgeShapes(result.edges)), sortShapes(fixture.edges), `${fixture.id} edges`);
    assert.equal(result.unresolvedCallsites.length, 0, `${fixture.id} must have no unresolved callsites`);
  }
});

test("RS_NEG_1..6 zero fabricated edges and structured reason codes", async () => {
  for (const fixture of NEGATIVE_CASES) {
    const files = await collectFiles(join(FIXTURES, fixture.id), join(FIXTURES, fixture.id));
    const result = analyze({ ...fixture, files });
    assert.equal(result.entryResolution, "ok", `${fixture.id} entry resolution`);
    assert.deepEqual(sortShapes(edgeShapes(result.edges)), sortShapes(fixture.edges), `${fixture.id} edges`);
    assert.deepEqual(
      result.unresolvedCallsites.map(item => item.reasonCode).sort(),
      [...fixture.unresolved].sort(),
      `${fixture.id} unresolved reason codes`,
    );
  }
});

test("Rust call-depth adapter exposes the shared CallDepthAdapter 8-call shape", () => {
  assert.equal(typeof adapterModule.createRustCallDepthAdapter, "function");
  const handle = adapterModule.createRustCallDepthAdapter({
    sandbox: {
      bindFile: async () => { throw new Error("not used"); },
      execute: async () => { throw new Error("not used"); },
      getSession: () => ({}),
    },
    session: { scenarioId: "s", sessionId: "x" },
  });
  for (const name of [
    "validateRequest", "supports", "evaluate", "select", "derive",
    "executeAtomic", "validateAtomicReceipt", "measureProgress",
  ]) {
    assert.equal(typeof handle.adapter[name], "function", `adapter.${name}`);
  }
  assert.equal(typeof handle.setState, "function");
  assert.equal(typeof handle.getState, "function");
  assert.equal(typeof handle.calls, "object");
});
const SCOPE_FIXTURE = {
  id: "RS_SCOPE_1",
  entryFile: "src/inner/mod.rs",
  entrySymbol: "entry",
  maxDepth: 2,
  scopePaths: ["src/inner"],
  outsidePath: "src/outer.rs",
};

function scopedReads(store) {
  const reads = new Set();
  return {
    reads,
    get(rel) { reads.add(rel); return store.get(rel); },
    has(rel) { return store.has(rel); },
    isMissing(rel) { return store.isMissing(rel); },
    request(rel) { reads.add(`request:${rel}`); store.request(rel); },
  };
}

test("P1-1: in-scope entry never reads or edges a resolvable module outside --scope", async () => {
  const files = await collectFiles(join(FIXTURES, SCOPE_FIXTURE.id), join(FIXTURES, SCOPE_FIXTURE.id));
  const parsed = new Map();
  for (const [rel, text] of files) parsed.set(rel, policy.parseRustSourceFile(rel, text));
  const spy = scopedReads({
    get(rel) { return parsed.get(rel); },
    has(rel) { return parsed.has(rel); },
    isMissing() { return false; },
    request() {},
  });
  const result = policy.analyzeRustCalls(spy, SCOPE_FIXTURE.scopePaths, SCOPE_FIXTURE.entryFile, SCOPE_FIXTURE.entrySymbol, SCOPE_FIXTURE.maxDepth);
  assert.equal(result.entryResolution, "ok", `${SCOPE_FIXTURE.id} entry resolution`);
  assert.equal(result.edges.length, 0, "no deterministic edge may cross the scope boundary");
  assert.ok(!spy.reads.has(SCOPE_FIXTURE.outsidePath), `outside module ${SCOPE_FIXTURE.outsidePath} must not be read`);
  assert.ok([...spy.reads].every(path => path === SCOPE_FIXTURE.entryFile || !path.startsWith("src/outer")), "no outside path may enter pending reads either");
  assert.equal(result.unresolvedCallsites.length, 1, "the escaped target must remain one structured unresolved callsite");
  const unknown = result.unresolvedCallsites[0];
  assert.equal(unknown.reasonCode, "TARGET_OUTSIDE_DECLARED_SCOPE");
  assert.equal(unknown.calleeExpr, "crate::outer::helper");
  assert.equal(unknown.callsiteSpan.startLine >= 1, true);
  assert.equal(unknown.kind, "out_of_scope_internal");
  assert.equal(unknown.targetSymbolClue, "helper");
  assert.equal(unknown.coverageStatus, "boundary_not_expanded");
  assert.equal(unknown.moduleSpecifierClue, "crate::outer");
  assert.equal(unknown.candidateModulePath, "src/outer.rs");
  assert.equal(unknown.bindingDeclarationSpan, null);
  assert.deepEqual(Object.freeze([...unknown.missingEvidence]), Object.freeze(["target_outside_declared_scope"]));
});


const NEG_FIELD_EXPECTATIONS = [
  {
    id: "RS_NEG_1",
    unresolved: [
      { reason: "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", clue: "read_slot", coverage: "locatable_candidate_unverified", missing: ["receiver_type_or_trait_impl_unverified"], module: null, candidate: null, binding: true },
      { reason: "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", clue: "read_slot", coverage: "locatable_candidate_unverified", missing: ["receiver_type_or_trait_impl_unverified"], module: null, candidate: null, binding: true },
    ],
  },
  {
    id: "RS_NEG_2",
    unresolved: [
      { reason: "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", clue: "check", coverage: "truly_dynamic_unlocatable", missing: ["receiver_type_or_trait_impl_unverified"], module: null, candidate: null, binding: false },
      { reason: "RUST_TRAIT_OR_UNRESOLVED_RECEIVER_DISPATCH", clue: "check", coverage: "locatable_candidate_unverified", missing: ["receiver_type_or_trait_impl_unverified"], module: null, candidate: "src/lib.rs", binding: true },
    ],
  },
  {
    id: "RS_NEG_3",
    unresolved: [
      { reason: "RUST_MACRO_INVOCATION_UNEXPANDED", clue: "matches", coverage: "boundary_not_expanded", missing: ["macro_expansion_not_evaluated"], module: null, candidate: null, binding: false },
      { reason: "RUST_MACRO_INVOCATION_UNEXPANDED", clue: "dispatch_call", coverage: "boundary_not_expanded", missing: ["macro_expansion_not_evaluated"], module: null, candidate: null, binding: false },
    ],
  },
  {
    id: "RS_NEG_4",
    unresolved: [
      { reason: "RUST_CFG_CONDITIONAL_TARGET", clue: "compute", coverage: "locatable_candidate_unverified", missing: ["cfg_condition_unverified"], module: null, candidate: "src/lib.rs", binding: false },
    ],
  },
  {
    id: "RS_NEG_5",
    unresolved: [
      { reason: "LEXICAL_PARAM_OR_CLOSURE_CALL", clue: null, coverage: "truly_dynamic_unlocatable", missing: ["runtime_callback_or_higher_order_value"], module: null, candidate: null, binding: true },
      { reason: "LEXICAL_PARAM_OR_CLOSURE_CALL", clue: null, coverage: "truly_dynamic_unlocatable", missing: ["runtime_callback_or_higher_order_value"], module: null, candidate: null, binding: true },
    ],
  },
  {
    id: "RS_NEG_6",
    unresolved: [
      { reason: "EXTERNAL_CRATE_OR_STD_CALL", clue: "from_str", coverage: "boundary_not_expanded", missing: ["external_crate_or_out_of_scope_target"], module: "serde_json", candidate: null, binding: false },
      { reason: "RUST_GLOB_USE_AMBIGUOUS_TARGET", clue: "parse_item", coverage: "locatable_candidate_unverified", missing: ["glob_use_resolution_unverified"], module: "crate::mod_a, crate::mod_b", candidate: null, binding: false },
    ],
  },
];

test("P1-2: Rust negative fixtures keep every structured unresolved field at the policy layer", async () => {
  for (const expected of NEG_FIELD_EXPECTATIONS) {
    const fixture = NEGATIVE_CASES.find(item => item.id === expected.id);
    assert.ok(fixture, expected.id);
    const files = await collectFiles(join(FIXTURES, expected.id), join(FIXTURES, expected.id));
    const result = analyze({ ...fixture, files });
    assert.equal(result.unresolvedCallsites.length, fixture.unresolved.length, `${expected.id} unresolved count`);
    assert.equal(result.unresolvedCallsites.length, expected.unresolved.length, `${expected.id} expected count`);
    for (const [index, item] of result.unresolvedCallsites.entries()) {
      const expect = expected.unresolved[index];
      assert.equal(item.reasonCode, expect.reason, `${expected.id}[${index}] reasonCode`);
      assert.equal(item.targetSymbolClue, expect.clue, `${expected.id}[${index}] targetSymbolClue`);
      assert.equal(item.coverageStatus, expect.coverage, `${expected.id}[${index}] coverageStatus`);
      assert.deepEqual(Object.freeze([...item.missingEvidence]), Object.freeze(expect.missing), `${expected.id}[${index}] missingEvidence`);
      assert.equal(item.moduleSpecifierClue, expect.module, `${expected.id}[${index}] moduleSpecifierClue`);
      assert.equal(item.candidateModulePath, expect.candidate, `${expected.id}[${index}] candidateModulePath`);
      assert.equal(item.bindingDeclarationSpan === null, !expect.binding, `${expected.id}[${index}] bindingDeclarationSpan`);
      assert.ok("kind" in item && "callerId" in item && "calleeExpr" in item && "callsiteSpan" in item, `${expected.id}[${index}] core fields`);
    }
  }
});
