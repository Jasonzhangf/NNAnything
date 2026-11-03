// Black-box regression for `nn-code value-flow`: pure flow-sensitive analysis,
// single-line H_R feature extraction, read-only sandbox grants, the public
// `runCliValueFlowGoal` recursive-goal entry, and the compiled CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dist = relative => pathToFileURL(join(repoRoot, "dist", relative)).href;
const policy = await import(dist("filters/cli-value-flow-policy.js"));
const runner = await import(dist("training/value-flow-l2-runner.js"));
const filesystem = await import(dist("adapters/cli/filesystem-sandbox.js"));
const valueFlow = await import(dist("cli-value-flow.js"));
const binPath = join(repoRoot, "dist", "cli-value-flow.js");

const CONTRACT = await import(dist("adapters/cli/value-flow-contract.js"));
const RECURSIVE = await import(dist("adapters/cli/value-flow-recursive.js"));

const DESTRUCTURE_SOURCE = `export function f(opened: any) {
  const { handle, after } = opened;
  const size = Number(after.size);
  return size;
}
`;

function readOnlyGoal(overrides = {}) {
  return {
    kind: "cli.programming.value_flow",
    anchorFile: "src/a.ts",
    anchorSymbol: "size",
    anchorLexicalPath: "f",
    anchorLine: 3,
    direction: "origin",
    maxDepth: 3,
    scopePaths: ["src"],
    resultMode: "all",
    satisfactionThreshold: 1,
    ...overrides,
  };
}

function analyze(source, anchorSymbol, options = {}) {
  return policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "a.ts",
      anchorSymbol,
      ...(options.anchorLexicalPath === undefined ? {} : { anchorLexicalPath: options.anchorLexicalPath }),
      ...(options.anchorLine === undefined ? {} : { anchorLine: options.anchorLine }),
      direction: options.direction ?? "origin",
      maxDepth: options.maxDepth ?? 3,
      scopePaths: options.scopePaths ?? ["."],
      resultMode: options.resultMode ?? "all",
      satisfactionThreshold: 1,
    },
    corpus: [{ relPath: "a.ts", sourceText: source }],
  });
}

async function makeFixture(t, source = DESTRUCTURE_SOURCE) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-vf-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), source);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function runCli(args, cwd) {
  const proc = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

// A search-failure test double. It delegates every sandbox call to the real
// read-only sandbox and only rewrites the `directory.search.content` call, so
// the public recursive-goal entry can be driven through a real throw, a real
// `failed` semantic receipt, or a legitimate zero-match result.
function wrapSearchSandbox(sandbox, session, mode) {
  const failedContentReceipt = (code, message) => {
    const snap = sandbox.getSession(session);
    return {
      call: { operation: "directory.search.content", parameters: { session } },
      status: "failed",
      session_before: snap,
      session_after: snap,
      execution: {
        status: "failed",
        runId: "content-failed",
        executorInvoked: false,
        error: { operation: "directory.search.content", stage: "execute", code, message },
      },
    };
  };
  return {
    ...sandbox,
    execute: async call => {
      const operation = call?.operation;
      if (operation === "directory.search.content") {
        if (mode === "throw") throw new Error("CONTENT_BOOM");
        if (mode === "fail") return failedContentReceipt("SEARCH_CONTENT_DENIED", "content denied");
      }
      return sandbox.execute(call);
    },
  };
}

function wrapReadSandbox(sandbox, session, options) {
  let attempts = 0;
  const { error, failAt = 1 } = options;
  return {
    sandbox: {
      ...sandbox,
      execute: async call => {
        if (call?.operation !== "file.read") return sandbox.execute(call);
        attempts += 1;
        if (attempts >= failAt && error !== undefined) {
          if (error === "throw") throw new Error("READ_BOOM");
          const snapshot = sandbox.getSession(session);
          if (error === "wrong-kind") {
            return {
              call,
              status: "succeeded",
              session_before: snapshot,
              session_after: snapshot,
              execution: {
                status: "succeeded",
                runId: "read-mis-kind",
                executorInvoked: true,
                observation: { kind: "file.read.lines", ref: null, offset: 0, length: 0, bytesRead: 0, bytes: "", size: 0 },
              },
            };
          }
          return {
            call,
            status: "failed",
            session_before: snapshot,
            session_after: snapshot,
            execution: {
              status: "failed",
              runId: "read-failed",
              executorInvoked: false,
              error: { operation: "file.read", stage: "execute", code: "READ_DENIED", message: "read denied" },
            },
          };
        }
        return sandbox.execute(call);
      },
    },
    attempts: () => attempts,
  };
}

async function makeBigFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-vf-big-")));
  await mkdir(join(root, "src"), { recursive: true });
  const pad = "// padding\n".repeat(120000);
  await writeFile(join(root, "src", "a.ts"), `${pad}export function f(opened: any) {\n  const { after } = opened;\n  const size = Number(after.size);\n  return size;\n}\n`);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function searchFailureResult(result, code) {
  return result.finalState?.searchFailures?.find(failure => failure.code === code) ?? null;
}

test("H_R feature extractor is 15-dim single-line only and matches the locked architecture", () => {
  const origin = policy.extractUnreadSearchCandidateFeatures("origin", 3, "lib/a.ts", {
    path: "lib/a.ts",
    line: 1,
    column: 0,
    preview: "fn(a, b, c, d)",
  });
  assert.equal(origin.length, 15);
  assert.equal(origin.length, runner.VALUE_FLOW_HR_ARCHITECTURE[0]);
  assert.equal(runner.VALUE_FLOW_FEATURE_NAMES.length, 15);
  assert.equal(origin[0], 1, "r00_dir_is_origin");
  assert.equal(origin[1], 0, "r01_dir_is_sink");
  assert.equal(origin[10], 1, "r10 arg count covers the fourth parameter");
  assert.equal(origin[11], 1, "m00 arg count observable");
  assert.equal(origin[13], 1, "m02 constant unknown-enclosing-context mask");
  assert.equal(origin[14], 0, "m03 same-file module binding is 0");

  const crossFile = policy.extractUnreadSearchCandidateFeatures("origin", 3, "lib/a.ts", {
    path: "lib/b.ts",
    line: 1,
    column: 0,
    preview: "fn(a, b, c, d)",
  });
  assert.equal(crossFile[14], 1, "m03 cross-file module binding is 1");

  const unclosed = policy.extractUnreadSearchCandidateFeatures("origin", 1, "lib/a.ts", {
    path: "lib/a.ts",
    line: 1,
    column: 0,
    preview: "fn(a,",
  });
  assert.equal(unclosed[11], 0, "m00 marks the multi-line unclosed call as unobservable");
  assert.equal(unclosed.length, 15);

  const sink = policy.extractUnreadSearchCandidateFeatures("sink", 0, "lib/a.ts", {
    path: "lib/a.ts",
    line: 1,
    column: 0,
    preview: "fn(a)",
  });
  assert.equal(sink[0], 0);
  assert.equal(sink[1], 1);

  const architecture = runner.VALUE_FLOW_HR_ARCHITECTURE;
  const expectedCount = architecture[1] * architecture[0]
    + architecture[1]
    + architecture[2] * architecture[1]
    + architecture[2]
    + architecture[3] * architecture[2]
    + architecture[3];
  assert.equal(runner.VALUE_FLOW_HR_PARAMETER_COUNT, expectedCount);
  assert.equal(expectedCount, 579);
});

test("runner skeleton validates samples, partitions and AST leakage without training", () => {
  const sample = {
    id: "s1",
    episodeId: "ep1",
    familyId: "fam1",
    partition: "train",
    direction: "origin",
    targetParamIndex: 1,
    exportedModulePath: "lib/a.ts",
    searchMatch: { path: "lib/a.ts", line: 1, column: 0, preview: "fn(a, b)" },
    label: "holds",
    unknownMask: false,
  };
  assert.equal(runner.sampleFeatures(sample).length, runner.VALUE_FLOW_HR_ARCHITECTURE[0]);
  const leakage = runner.verifyNoTeacherAstLeakage([sample]);
  assert.equal(leakage.sampleCount, 1);
  assert.equal(leakage.featureCount, 15);
  assert.equal(leakage.unknownMaskAllFalse, true);

  const partitions = runner.verifyDisjointFamilyPartitions([
    { partition: "train", familyIds: ["fam1"] },
    { partition: "dev", familyIds: ["fam2"] },
    { partition: "verification", familyIds: ["fam3"] },
  ]);
  assert.deepEqual([...partitions.train], ["fam1"]);
  assert.deepEqual([...partitions.dev], ["fam2"]);
  assert.deepEqual([...partitions.verification], ["fam3"]);
  assert.throws(
    () => runner.verifyDisjointFamilyPartitions([
      { partition: "train", familyIds: ["fam1"] },
      { partition: "dev", familyIds: ["fam1"] },
    ]),
    /crosses/,
  );
});

test("VF-1 origin resolves a destructure_extract .after edge", () => {
  const out = analyze(DESTRUCTURE_SOURCE, "size", { anchorLexicalPath: "f", anchorLine: 3 });
  assert.equal(out.status, "achieved");
  assert.equal(out.resolution, "complete");
  assert.equal(out.anchorResolved, true);
  assert.ok(out.edges.some(edge => edge.edgeKind === "destructure_extract" && edge.accessPath === ".after"));
});

test("VF-2 flow-sensitive kill removes the dead definition from origin", () => {
  const killed = analyze(
    `export function f(a: any, b: any) {
  let x = a;
  x = b;
  const y = x;
  return y;
}
`,
    "y",
    { anchorLexicalPath: "f" },
  );
  const killedSymbols = new Set(killed.sites.map(site => site.symbolName));
  assert.ok(killedSymbols.has("b"), "y must reach the live definition x = b");
  assert.ok(!killedSymbols.has("a"), "the killed definition let x = a must not leak into y");

  const notYetReassigned = analyze(
    `export function f(a: any, b: any) {
  let x = a;
  const y = x;
  x = b;
  return y;
}
`,
    "y",
    { anchorLexicalPath: "f" },
  );
  const earlySymbols = new Set(notYetReassigned.sites.map(site => site.symbolName));
  assert.ok(earlySymbols.has("a"), "y reads x before x = b so a stays live");
  assert.ok(!earlySymbols.has("b"), "the later reassignment to b must not leak backward");
});

test("VF-4 diamond join is a branch disjunction, not a cycle", () => {
  const out = analyze(
    `export function f(flag: any) {
  const a = seed(); const b = a; const c = a; const d = flag ? b : c; return d;
}
`,
    "d",
    { anchorLexicalPath: "f" },
  );
  assert.equal(out.status, "achieved");
  const symbols = new Set(out.sites.map(site => site.symbolName));
  assert.ok(symbols.has("b"));
  assert.ok(symbols.has("c"));
  assert.ok(!out.edges.some(edge => edge.isCycleEdge), "diamond join must not be reported as a cycle");
  assert.ok(out.edges.some(edge => edge.provenancePrecision === "may_branch_disjunction"));
});

test("VF-5 loop reassignment produces a may_loop_fixpoint cycle edge", () => {
  const out = analyze(
    `export function f(a: any) {
  let x = a;
  for (;;) {
    x = x + 1;
  }
  return x;
}
`,
    "x",
    { anchorLexicalPath: "f", anchorLine: 4 },
  );
  assert.equal(out.status, "achieved");
  assert.ok(out.edges.some(edge => edge.isCycleEdge), "a real loop back edge must be a cycle");
  assert.ok(out.edges.some(edge => edge.provenancePrecision === "may_loop_fixpoint"));
});

test("read-only sandbox grants process.exec only when allowReadOnlySearch is explicit", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-vf-grant-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const readOnly = await filesystem.createReadOnlyCliFilesystemSandbox({ root });
  t.after(async () => readOnly.cleanup());
  const readOnlySession = readOnly.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  assert.deepEqual([...readOnly.getSession(readOnlySession).grantedEffects], ["filesystem.read"]);

  const searching = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => searching.cleanup());
  const searchingSession = searching.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const effects = searching.getSession(searchingSession).grantedEffects;
  assert.ok(effects.includes("filesystem.read"));
  assert.ok(effects.includes("process.exec"));
  assert.equal(effects.includes("session.write"), false, "read-only search must never grant session.write");
});

test("runCliValueFlowGoal reaches achieved/complete through the real recursive goal", async t => {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const runLogPath = join(root, "run.json");

  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-integration", rootGoal: readOnlyGoal() },
    { sandbox, session, runLogPath },
  );

  assert.equal(result.status, "achieved");
  assert.equal(result.resolution, "complete");
  assert.equal(result.provenanceSemantics, "static_may_provenance");
  assert.equal(result.runLogPath, runLogPath);
  assert.ok(result.edges.some(edge => edge.edgeKind === "destructure_extract" && edge.accessPath === ".after"));
  assert.ok(result.counters.searchCalls >= 1);
  assert.ok(result.counters.fileReadCalls >= 1);
});

test("runCliValueFlowGoal is flow-sensitive for a killed assignment", async t => {
  const killed = `export function f(a: any, b: any) {
  let x = a;
  x = b;
  const y = x;
  return y;
}
`;
  const root = await makeFixture(t, killed);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const result = await valueFlow.runCliValueFlowGoal(
    {
      requestId: "vf-kill",
      rootGoal: readOnlyGoal({ anchorSymbol: "y", anchorLine: 4 }),
    },
    { sandbox, session, runLogPath: join(root, "run-kill.json") },
  );
  const symbols = new Set(result.sites.map(site => site.symbolName));
  assert.ok(symbols.has("b"));
  assert.ok(!symbols.has("a"));
});

test("compiled CLI returns origin/all exit 0 and structured result", async t => {
  const root = await makeFixture(t);
  const run = runCli([
    "--root", root,
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-lexical-path", "f",
    "--anchor-line", "3",
    "--direction", "origin",
    "--max-depth", "3",
    "--scope", "src",
    "--run-log-path", join(root, "cli-all-run.json"),
  ], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "achieved");
  assert.equal(payload.resolution, "complete");
  assert.equal(payload.provenanceSemantics, "static_may_provenance");
  assert.equal(payload.finalState.resultMode, "all");
  assert.ok(payload.edges.some(edge => edge.edgeKind === "destructure_extract"));
});

test("compiled CLI returns a structured one-mode result", async t => {
  const root = await makeFixture(t);
  const run = runCli([
    "--root", root,
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-lexical-path", "f",
    "--anchor-line", "3",
    "--direction", "origin",
    "--max-depth", "3",
    "--scope", "src",
    "--result-mode", "one",
    "--run-log-path", join(root, "cli-one-run.json"),
  ], tmpdir());
  assert.ok(run.status === 0 || run.status === 2, `unexpected exit ${run.status}: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.finalState.resultMode, "one");
  assert.ok(Array.isArray(payload.edges));
  assert.ok(Array.isArray(payload.sites));
});

test("--repo is accepted as the root primary argument and conflicts with --root", async t => {
  const root = await makeFixture(t);
  const ok = runCli([
    "--repo", root,
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-lexical-path", "f",
    "--anchor-line", "3",
    "--direction", "origin",
    "--max-depth", "3",
    "--scope", "src",
  ], tmpdir());
  assert.equal(ok.status, 0, ok.stderr);
  const conflict = runCli([
    "--repo", root,
    "--root", "/tmp/other",
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-line", "3",
  ], tmpdir());
  assert.equal(conflict.status, 1, conflict.stdout);
  assert.match(conflict.stderr, /--repo and --root must not disagree/);
});

test("all mode does not complete while unread in-scope candidate files remain", async t => {
  const source = `export function f(a: number) {\n  const size = a + 1;\n  return size;\n}\n`;
  const root = await makeFixture(t, source);
  await writeFile(join(root, "src", "b.ts"), source.replace("a + 1", "a + 2"));
  const run = runCli([
    "--repo", root,
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-line", "2",
    "--direction", "origin",
    "--max-depth", "1",
    "--scope", "src",
    "--result-mode", "all",
    "--max-candidate-file-reads", "1",
  ], tmpdir());
  // Without an explicit budget the default path must read every hit candidate.
  // With an explicit K=1 budget the caller is told it exhausted the budget, not
  // that it found a complete answer.
  assert.equal(run.status, 2, run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "unknown");
  assert.equal(payload.resolution, "budget_exhausted");
});

test("stack overflow is surfaced as a structured unknown with STACK_OVERFLOW_OR_PARSE_LIMIT", async () => {
  const expr = Array.from({ length: 2500 }, () => "1").join("+");
  const source = `export function f() {\n  const acc = ${expr};\n  return acc;\n}\n`;
  const result = analyze(source, "acc", { anchorLine: 2, maxDepth: 1 });
  assert.equal(result.status, "unknown");
  assert.equal(result.resolution, "insufficient_evidence");
  assert.ok(result.unresolvedSites.some(site => site.reasonCode === "STACK_OVERFLOW_OR_PARSE_LIMIT"));
});

test("deep nesting up to 1000 is still achieved", async () => {
  const expr = Array.from({ length: 1000 }, () => "1").join("+");
  const source = `export function f() {\n  const acc = ${expr};\n  return acc;\n}\n`;
  const result = analyze(source, "acc", { anchorLine: 2, maxDepth: 1 });
  assert.equal(result.status, "achieved");
});

test("any retained unresolved site forces unknown while confirmed local edges remain", () => {
  const source = `export function f(a: any) {
  const x = a;
  let unrelated = 0;
  unrelated += 1;
  const out = x;
  return out;
}
`;
  const result = analyze(source, "out", { anchorLexicalPath: "f", anchorLine: 5 });
  assert.ok(result.edges.length > 0, "the confirmed local value-flow edge must remain visible");
  assert.ok(
    result.unresolvedSites.some(site => site.reasonCode === "EMBEDDED_ASSIGNMENT_OR_UPDATE_EXPR"),
    "the unrelated unsupported mutation must remain in unresolvedSites",
  );
  assert.equal(result.status, "unknown", "any retained unresolved site prevents achieved/complete");
  assert.equal(result.resolution, "insufficient_evidence");
});

test("unverified cross-file caller coverage is emitted when in-scope files are unread", () => {
  const source = `export function parseSourceFile(relPath: string, sourceText: string) {\n  return { relPath };\n}\n`;
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "relPath",
      anchorLexicalPath: "parseSourceFile",
      anchorLine: 1,
      direction: "origin",
      maxDepth: 2,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [{ relPath: "src/a.ts", sourceText: source }],
    knownFiles: ["src/a.ts", "src/other.ts"],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.resolution, "insufficient_evidence");
  assert.ok(result.unresolvedSites.some(site => site.kind === "unverified_cross_file_caller_coverage"));
});

test("open-world caller coverage still applies when some in-scope callers were read", () => {
  // `a.ts` calls `parseSourceFile`; a caller edge is found. But `c.ts` is an
  // in-scope source file that has not been read, so the open-world caller
  // coverage cannot be closed and the target must stay unknown.
  const caller = `import { parseSourceFile } from "./a.js";\nfunction f(file: any) {\n  return parseSourceFile(file, file.text);\n}\n`;
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "relPath",
      anchorLexicalPath: "parseSourceFile",
      anchorLine: 1,
      direction: "origin",
      maxDepth: 2,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/a.ts", sourceText: `export function parseSourceFile(relPath: string, sourceText: string) {\n  return { relPath };\n}\n` },
      { relPath: "src/b.ts", sourceText: caller },
    ],
    knownFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.resolution, "insufficient_evidence");
  assert.ok(result.unresolvedSites.some(site => site.kind === "unverified_cross_file_caller_coverage"));
  assert.ok(result.edges.length > 0, "already-read caller edges are preserved");
});

test("CLI --help lists --repo and --root without requiring a repo", () => {
  const run = runCli(["--help"], tmpdir());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /--repo/);
  assert.match(run.stdout, /--root/);
});

test("same-dir same-line same-text conditions in different files keep distinct facts", () => {
  // `src/a.ts` and `src/b.ts` both have `if (flag)` starting at line 3 column 7.
  // Under the r8 pool contract the intern key includes `relPath`, so the two
  // files' `if_true(flag)` facts must not collapse to one identity. The anchor
  // is `out` at line 4 (`const out = x`), whose reaching edge carries the
  // condition facts of `x` in `src/a.ts` only.
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "out",
      anchorLexicalPath: "f",
      anchorLine: 4,
      direction: "origin",
      maxDepth: 2,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/a.ts", sourceText: `export function f(flag: boolean, seed: number) {\n  let x = 0;\n  if (flag) { x = seed; }\n  const out = x;\n  return out;\n}\n` },
      { relPath: "src/b.ts", sourceText: `export function g(flag: boolean, seed: number) {\n  let y = 0;\n  if (flag) { y = seed; }\n  const out = y;\n  return out;\n}\n` },
    ],
  });
  assert.equal(result.status, "achieved", result.resolution);
  const aFacts = result.edges
    .filter(edge => edge.edgeKind === "reaching_def")
    .map(edge => edge.branchConditionAlternatives)
    .flat()
    .flat()
    .filter(fact => fact.kind === "if_true" && fact.conditionSpan.startLine === 3 && fact.conditionSpan.startColumn === 7);
  assert.ok(aFacts.some(fact => fact.relPath === "src/a.ts"), "the a.ts if_true condition appears on the a.ts reaching edge");
  // b.ts facts are absent from a.ts edges entirely.
  const bFactOnA = result.edges.flatMap(edge => edge.branchConditionAlternatives ?? [])
    .flat()
    .some(fact => fact.relPath === "src/b.ts");
  assert.equal(bFactOnA, false);
});

test("evaluator self-check rejects argmax 0/1 ties and cross-episode pairs", () => {
  const check = runner.verifyEvaluatorContinuousRankingSelfCheck();
  assert.equal(check.passed, true, check.checks.map(item => `${item.id}:${item.passed}`).join(", "));
  assert.ok(Math.abs(runner.computeContinuousRelevanceScore([0.55, 0.05, 0.4]) - 0.575) < 1e-12);
  assert.ok(Math.abs(runner.computeContinuousRelevanceScore([0.51, 0.48, 0.01]) - 0.75) < 1e-12);
  const sameEpisode = runner.evaluateEpisodePairwiseRanking([
    { episodeId: "ep", label: "holds", clusterKey: "a", relevance: 0.9 },
    { episodeId: "ep", label: "refuted", clusterKey: "b", relevance: 0.2 },
  ]);
  assert.equal(sameEpisode.fullPairwiseCount, 1);
  assert.equal(sameEpisode.fullPairwiseCorrect, 1);
  const crossEpisode = runner.evaluateEpisodePairwiseRanking([
    { episodeId: "ep1", label: "holds", clusterKey: "a", relevance: 0.9 },
    { episodeId: "ep2", label: "refuted", clusterKey: "b", relevance: 0.2 },
  ]);
  assert.equal(crossEpisode.fullPairwiseCount, 0);
});

test("cross-cluster accuracy is descriptive and cannot independently reject a full-pairwise pass", () => {
  const trainMetrics = {
    count: 2,
    loss: 0.1,
    correct: 2,
    accuracy: 1,
    fullPairwiseCount: 1,
    fullPairwiseCorrect: 1,
    fullPairwiseAccuracy: 1,
    crossClusterPairCount: 1,
    crossClusterPairCorrect: 1,
    crossClusterAccuracy: 1,
  };
  const devMetrics = {
    count: 20,
    loss: 0.1,
    correct: 20,
    accuracy: 1,
    fullPairwiseCount: 10,
    fullPairwiseCorrect: 10,
    fullPairwiseAccuracy: 1,
    crossClusterPairCount: 10,
    crossClusterPairCorrect: 4,
    crossClusterAccuracy: 0.4,
  };
  const gates = runner.evaluateValueFlowAdmissionGates(trainMetrics, devMetrics, 1, 1);
  assert.equal(gates.fullPairwise, true);
  assert.equal(gates.passed, true, "the descriptive cross-cluster number must not block admission");
  assert.equal(Object.hasOwn(gates, "crossClusterPairwise"), false);
  assert.equal(devMetrics.crossClusterPairCount, 10);
  assert.equal(devMetrics.crossClusterPairCorrect, 4);
  assert.equal(devMetrics.crossClusterAccuracy, 0.4);
});

test("B1 17-path single-def if/else keeps every alternative and intersects to empty", () => {
  // Exact fixture from r7 §4.2.2: the same `d0` (let x = seed) reaches `out`
  // through 17 non-complementary paths. The pool has no chain-count cap, so
  // all 17 must be materialized, `if_false(sharedCond)` must appear, and the
  // set intersection of all 17 chains must be empty (because `d0` survives
  // both when `sharedCond` is true and when it is false).
  const SRC = `export function routeSingleDefIfElse(
  seed: number,
  sharedCond: boolean,
  keepOnElse: boolean,
  c1: boolean, k1: boolean,
  c2: boolean, k2: boolean,
  c3: boolean, k3: boolean,
  c4: boolean, k4: boolean,
) {
  let x = seed;
  if (sharedCond) {
    if (c1) { const a1 = 1; } else if (k1) { const b1 = 2; } else { x = 101; }
    if (c2) { const a2 = 4; } else if (k2) { const b2 = 8; } else { x = 102; }
    if (c3) { const a3 = 16; } else if (k3) { const b3 = 32; } else { x = 103; }
    if (c4) { const a4 = 64; } else if (k4) { const b4 = 128; } else { x = 104; }
  } else {
    if (keepOnElse) {
      const e1 = 256;
    } else {
      x = 999;
    }
  }
  const out = x;
  return out;
}
`;
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/branch17.ts",
      anchorSymbol: "out",
      anchorLexicalPath: "routeSingleDefIfElse",
      anchorLine: 23,
      direction: "origin",
      maxDepth: 2,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [{ relPath: "src/branch17.ts", sourceText: SRC }],
  });
  assert.equal(result.status, "achieved", result.resolution);
  const d0Edge = result.edges.find(edge =>
    edge.edgeKind === "reaching_def"
    && edge.fromSiteId.includes(":x@def_init(10:7-10:8)")
    && edge.toSiteId.includes(":x@use_read"));
  assert.ok(d0Edge, "the d0 x=seed reaching edge must be materialized");
  assert.equal(d0Edge.branchConditionAlternatives.length, 17,
    `expected 17 alternatives, got ${d0Edge.branchConditionAlternatives.length}`);
  assert.ok(
    d0Edge.branchConditionAlternatives.some(chain =>
      chain.some(fact => fact.kind === "if_false" && fact.conditionText === "sharedCond")),
    "the if_false(sharedCond) 17th path must be present",
  );
  assert.equal(d0Edge.branchConditions.length, 0,
    "the intersection of all 17 alternatives must be empty");
});

test("B2 20 unrelated ordered ifs collapse to one exact_unconditional chain", () => {
  // Companion to B1: 20 sequential `if(c_i)` that do NOT modify `x`.
  // Complementary-branch reduction collapses each if_true/if_false pair back
  // to the base, so `d0 -> out` carries exactly 1 alternative ([]) and
  // `exact_unconditional` provenance, not 2^20 alternatives.
  const branches = Array.from({ length: 20 }, (_, i) => `  if (c${i}) { const tmp_${i} = ${i}; }`).join("\n");
  const source = `export function f(c0: any) {\n  let x = 0;\n${branches}\n  const out = x;\n  return out;\n}\n`;
  const result = analyze(source, "out", { anchorLexicalPath: "f", anchorLine: 23, maxDepth: 3 });
  assert.equal(result.status, "achieved", result.resolution);
  const xDefEdge = result.edges.find(edge =>
    edge.edgeKind === "reaching_def"
    && edge.fromSiteId.includes(":x@def_init(2:7-2:8)")
    && edge.toSiteId.includes(":x@use_read(23:15-23:16)"));
  assert.ok(xDefEdge, "x -> out reaching edge must exist");
  assert.equal(xDefEdge.branchConditionAlternatives.length, 1,
    `20 unrelated ifs must reduce to one chain, got ${xDefEdge.branchConditionAlternatives.length}`);
  assert.equal(xDefEdge.provenancePrecision, "exact_unconditional");
});

test("B3a static May loop keeps cross-iteration condition facts", () => {
  const source = `export function f(loopCond: boolean, c: boolean, seed: number) {
  let x = 0;
  while (loopCond) {
    if (c) { x = seed; }
  }
  const out = x;
  return out;
}
`;
  const result = analyze(source, "out", { anchorLexicalPath: "f", anchorLine: 7, maxDepth: 2 });
  assert.equal(result.status, "achieved", result.resolution);
  const xDefEdge = result.edges.find(edge =>
    edge.edgeKind === "reaching_def"
    && edge.fromSiteId.includes(":x@def_assign(4:14-4:15)")
    && edge.toSiteId.includes(":x@use_read(6:15-6:16)"));
  assert.ok(xDefEdge, "the in-loop x=seed definition must reach out");
  const kinds = xDefEdge.branchConditionAlternatives.flat().map(fact => fact.kind);
  assert.ok(kinds.includes("loop_body"), "loop_body fact must be present");
  assert.ok(kinds.includes("if_true"), "if_true(c) must survive");
  assert.ok(kinds.includes("if_false"), "if_false(c) must survive across iterations, not be eliminated");
  assert.equal(xDefEdge.provenancePrecision, "may_loop_fixpoint");
});

test("B3b loopDynamicStep terminates and carries both if_true and if_false facts", () => {
  const source = `export function loopDynamicStep(seed: number) {
  let x = 0;
  for (let step = 0; step < 2; step = step + 1) {
    if (step === 0) {
      x = seed;
    }
  }
  const out = x;
  return out;
}
`;
  const result = analyze(source, "out", { anchorLexicalPath: "loopDynamicStep", anchorLine: 9, maxDepth: 2 });
  assert.equal(result.status, "achieved", result.resolution);
  const xDefEdge = result.edges.find(edge =>
    edge.edgeKind === "reaching_def"
    && edge.fromSiteId.includes(":x@def_assign(5:7-5:8)")
    && edge.toSiteId.includes(":x@use_read(8:15-8:16)"));
  assert.ok(xDefEdge, "the d1 x=seed definition must reach out");
  const facts = xDefEdge.branchConditionAlternatives.flat();
  const trueFacts = facts.filter(fact => fact.kind === "if_true" && fact.conditionText === "step === 0");
  const falseFacts = facts.filter(fact => fact.kind === "if_false" && fact.conditionText === "step === 0");
  assert.ok(trueFacts.length >= 1, "the first iteration must carry if_true(step === 0)");
  assert.ok(falseFacts.length >= 1, "the second iteration must carry if_false(step === 0)");
  // Static May intersection is [loop_body, if_true] because the abstract
  // analyzer cannot rule out the one-round-exit path (C1).
  const conds = xDefEdge.branchConditions;
  assert.ok(conds.some(fact => fact.kind === "loop_body"), "branchConditions keeps loop_body");
  assert.ok(conds.some(fact => fact.kind === "if_true" && fact.conditionText === "step === 0"),
    "branchConditions keeps if_true from the static May intersection");
  assert.equal(xDefEdge.provenancePrecision, "may_loop_fixpoint");
  // Two-layer oracle. The concrete trajectory must pass loop_body, if_true and
  // then if_false before the loop exits; the static May intersection is only
  // loop_body ∩ if_true because the infeasible one-round-exit chain C1 dilutes
  // if_false. The static must-set is therefore a strict subset of the concrete
  // mandatory set, and if_false must not be promoted into branchConditions.
  const concreteMandatory = new Set(["loop_body", "if_true", "if_false"]);
  const staticMust = new Set(conds.map(fact => fact.kind));
  assert.ok([...staticMust].every(kind => concreteMandatory.has(kind)),
    "static May must-set never invents facts absent from the concrete trajectory");
  assert.equal(staticMust.has("if_false"), false,
    "if_false is a real trajectory fact but must not become a static must-condition");
  assert.ok(xDefEdge.branchConditionAlternatives.length >= 2,
    "the static May set keeps both the infeasible short exit and the real two-step path");
});

test("B4 same-line same-text conditions in different files get distinct fact ids", () => {
  const source = (body) => `export function f(flag: boolean, seed: number) {\n  let x = 0;\n  if (flag) { x = seed; }\n  const out = x;\n  return out;\n}\n`;
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "out",
      anchorLexicalPath: "f",
      anchorLine: 4,
      direction: "origin",
      maxDepth: 3,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/a.ts", sourceText: source("a") },
      { relPath: "src/b.ts", sourceText: source("b") },
    ],
  });
  assert.equal(result.status, "achieved", result.resolution);
  const aFacts = result.edges.flatMap(edge => edge.branchConditionAlternatives)
    .flat()
    .filter(fact => fact.relPath === "src/a.ts");
  const bFacts = result.edges.flatMap(edge => edge.branchConditionAlternatives)
    .flat()
    .filter(fact => fact.relPath === "src/b.ts");
  assert.ok(aFacts.length > 0, "a.ts facts appear");
  assert.equal(bFacts.length, 0, "b.ts facts must never merge into a.ts edges");
});

test("P1 scope closure records an outer binding as a child free read", () => {
  const header = policy.buildFileScopeHeaderIndex("src/a.ts", `export function outer() {\n  let x = 0;\n  const inner = () => { const y = x; return y; };\n  return inner();\n}\n`);
  const outer = header.scopes.find(scope => scope.key === "src/a.ts::outer");
  const inner = header.scopes.find(scope => scope.key === "src/a.ts::outer.inner");
  assert.ok(outer && inner);
  assert.ok(outer.declaredSymbols.includes("x"), "outer declares x");
  assert.equal(inner.declaredSymbols.includes("x"), false, "inner does not redeclare x");
  assert.ok(inner.freeReadSymbols.includes("x"), "inner captures x as a free read");
  assert.equal(inner.parentKey, outer.key, "inner resolves its parent scope");
});

test("P2 a shadowing parameter is declared, never captured from the outer scope", () => {
  const header = policy.buildFileScopeHeaderIndex("src/a.ts", `export function f() {\n  let x = 1;\n  function g(x: number) { return x; }\n  return g(x);\n}\n`);
  const outer = header.scopes.find(scope => scope.key === "src/a.ts::f");
  const inner = header.scopes.find(scope => scope.key === "src/a.ts::f.g");
  assert.ok(outer.declaredSymbols.includes("x"));
  assert.ok(inner.declaredSymbols.includes("x"), "the parameter shadows x");
  assert.equal(inner.freeReadSymbols.includes("x"), false, "a shadowed x is not a free capture");
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "x",
      anchorLexicalPath: "f",
      anchorLine: 4,
      direction: "origin",
      maxDepth: 3,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [{ relPath: "src/a.ts", sourceText: `export function f() {\n  let x = 1;\n  function g(x: number) { return x; }\n  const out = g(x);\n  return out;\n}\n` }],
  });
  const edge = result.edges.find(item =>
    item.edgeKind === "reaching_def"
    && item.toSiteId.includes("x@use_read(4:17")
    && item.fromSiteId.includes("x@def_init(2:7"));
  assert.ok(edge, "the call-site x must reach the outer def, not the shadowing parameter");
});

test("P3 import alias maps local bar to imported foo and emits a cross-file edge", () => {
  const header = policy.buildFileScopeHeaderIndex("src/a.ts", `import { foo as bar } from "./mod";\nconst out = bar(1);\n`);
  assert.deepEqual(header.rawImports.map(item => [item.localName, item.importedName, item.specifier]), [["bar", "foo", "./mod"]]);
  assert.deepEqual(header.importedBindings.map(item => [item.bindingName, item.importedName, item.moduleSpecifier]), [["bar", "foo", "./mod"]]);
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "bar",
      anchorLine: 2,
      direction: "origin",
      maxDepth: 3,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/mod.ts", sourceText: `export function foo(v: number) { return v; }\n` },
      { relPath: "src/a.ts", sourceText: `import { foo as bar } from "./mod";\nconst out = bar(1);\n` },
    ],
    knownFiles: ["src/mod.ts", "src/a.ts"],
  });
  const aliasEdge = result.edges.find(item =>
    item.fromSiteId.includes("src/mod.ts#:foo@def_init")
    && item.toSiteId.includes("src/a.ts#:bar@def_import"));
  assert.ok(aliasEdge, "the alias must resolve cross-file to the imported definition");
});

test("P4 re-export resolves through the barrel to the true defining module", () => {
  const header = policy.buildFileScopeHeaderIndex("src/barrel.ts", `export { foo } from "./mod";\nexport * from "./other";\n`);
  assert.deepEqual(header.rawExports.map(item => [item.exportedName, item.specifier, item.isStar]), [
    ["foo", "./mod", false],
    ["*", "./other", true],
  ]);
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "bar",
      anchorLine: 2,
      direction: "origin",
      maxDepth: 3,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/mod.ts", sourceText: `export function foo(v: number) { return v; }\n` },
      { relPath: "src/barrel.ts", sourceText: `export { foo } from "./mod";\n` },
      { relPath: "src/a.ts", sourceText: `import { foo as bar } from "./barrel";\nconst out = bar(1);\n` },
    ],
    knownFiles: ["src/mod.ts", "src/barrel.ts", "src/a.ts"],
  });
  const edge = result.edges.find(item =>
    item.fromSiteId.includes("src/mod.ts#:foo@def_init")
    && item.toSiteId.includes("src/a.ts#:bar@def_import"));
  assert.ok(edge, "a barrel re-export must resolve to the defining module");
  assert.equal(result.sites.some(site => site.filePath === "src/barrel.ts" && site.pointRole === "def_init"), false,
    "the barrel is not the definition of foo");
});

test("param anchor on a multi-line signature resolves as def_param and keeps its cross-file edge", () => {
  const caller = `import { run } from "./mod";
export async function handler(
  rawRequest: unknown,
  resources: number,
): Promise<void> {
  await run(rawRequest);
}
`;
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "rawRequest",
      anchorLexicalPath: "handler",
      anchorLine: 3,
      direction: "sink",
      maxDepth: 3,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/mod.ts", sourceText: `export async function run(value: unknown): Promise<void> { void value; }\n` },
      { relPath: "src/a.ts", sourceText: caller },
    ],
    knownFiles: ["src/mod.ts", "src/a.ts"],
  });
  assert.ok(result.anchorSiteId, "the parameter anchor must resolve instead of ANCHOR_NOT_FOUND");
  assert.ok(result.anchorSiteId.includes("handler:rawRequest@def_param(3:"),
    "the anchor binds the parameter definition on the signature line");
  assert.equal(result.status, "achieved");
  const cross = result.edges.find(item => item.edgeKind === "arg_to_param" && item.toSiteId.includes("src/mod.ts"));
  assert.ok(cross, "the parameter flows into the imported callee parameter");
});

test("exported function return anchor pulls importer callers so the return reaches consumers", () => {
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "parseSourceFile",
      anchorLine: 2,
      direction: "sink",
      maxDepth: 2,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      { relPath: "src/a.ts", sourceText: "export function parseSourceFile(relPath: string, sourceText: string) {\n  return { relPath, sourceText };\n}\n" },
      { relPath: "src/b.ts", sourceText: "import { parseSourceFile } from \"./a\";\nconst info = parseSourceFile(\"x\", \"y\");\nvoid info;\n" },
    ],
    knownFiles: ["src/a.ts", "src/b.ts"],
  });
  assert.ok(result.anchorSiteId, "the function-name anchor must resolve instead of ANCHOR_NOT_FOUND");
  assert.ok(result.anchorSiteId.includes("parseSourceFile:return@fn_return(2:"), "the anchor binds the function return");
  assert.equal(result.status, "achieved");
  const consumer = result.edges.find(item => item.edgeKind === "return_to_call_lhs" && item.toSiteId.includes("src/b.ts"));
  assert.ok(consumer, "the exported return must reach the importer call-result site");
});

test("branch pool keeps relPath identity in a cross-file conjunction chain", () => {
  const result = policy.analyzeValueFlow({
    goal: {
      kind: "cli.programming.value_flow",
      anchorFile: "src/a.ts",
      anchorSymbol: "out",
      anchorLexicalPath: "f",
      anchorLine: 5,
      direction: "origin",
      maxDepth: 4,
      scopePaths: ["src"],
      resultMode: "all",
      satisfactionThreshold: 1,
    },
    corpus: [
      {
        relPath: "src/b.ts",
        sourceText: `export function g(v: number, d: boolean, seed: number) {\n  if (d) { return seed; }\n  return v;\n}\n`,
      },
      {
        relPath: "src/a.ts",
        sourceText: `import { g } from "./b";\nexport function f(c: boolean, d: boolean, seed: number) {\n  let x = 0;\n  if (c) { x = g(1, d, seed); }\n  const out = x;\n  return out;\n}\n`,
      },
    ],
    knownFiles: ["src/b.ts", "src/a.ts"],
  });
  assert.equal(result.status, "achieved", result.resolution);
  const edgesWithConditions = result.edges.filter(edge => (edge.branchConditionAlternatives ?? []).flat().length > 0);
  assert.ok(edgesWithConditions.length > 0, "cross-file branches must carry condition facts");
  for (const edge of edgesWithConditions) {
    const chainNames = edge.branchConditionAlternatives.map(chain =>
      Object.freeze([...new Set(chain.map(fact => fact.relPath))]));
    for (const names of chainNames) {
      assert.equal(names.length, 1, "a condition chain must never mix src/a.ts and src/b.ts facts");
    }
  }
  const bReturn = edgesWithConditions.find(edge => edge.edgeKind === "return_from_fn");
  assert.ok(bReturn, "the cross-file b.ts return edge must be present");
  assert.ok(bReturn.branchConditionAlternatives.flat().every(fact => fact.relPath === "src/b.ts"),
    "b.ts conditions must stay bound to b.ts after materialization");
});

test("pool diagnostics report nonzero allocation and poolCleared true after traverse", () => {
  const source = `export function f(c0: any) {\n  let x = 0;\n  if (c0) { const tmp_0 = 0; }\n  const out = x;\n  return out;\n}\n`;
  const result = analyze(source, "out", { anchorLexicalPath: "f", anchorLine: 4, maxDepth: 3 });
  assert.equal(result.status, "achieved", result.resolution);
  const d = result.stageDiagnostics;
  assert.ok(d.poolFactsAllocated > 0, "the branch pool must actually intern facts");
  assert.ok(d.poolChainsAllocated > 0, "chains must be allocated");
  assert.ok(d.poolChainSetsAllocated > 0, "chain sets must be allocated");
  assert.ok(d.reachableEdgesMaterialized > 0, "traverse must materialize reachable edges");
  assert.equal(d.poolCleared, true, "the pool must be cleared before run() returns");
});

test("run log is JSONL with start first, baseline_rank (no decision), finish last", async t => {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const runLogPath = join(root, "run-log.jsonl");
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-log-jsonl", rootGoal: readOnlyGoal() },
    { sandbox, session, runLogPath },
  );
  assert.equal(result.logging.enabled, true);
  assert.equal(result.logging.state, "complete");
  assert.equal(result.logging.runLogPath, runLogPath);
  assert.equal(result.runLogPath, runLogPath);
  const lines = (await readFile(runLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].kind, "start");
  assert.equal(lines[0].modelRef, null);
  assert.equal(lines.at(-1).kind, "finish");
  assert.equal(lines.at(-1).status, "achieved");
  assert.ok(lines.some(line => line.kind === "baseline_rank"), "deterministic baseline ranking must be recorded");
  assert.ok(!lines.some(line => line.kind === "decision"), "no neural decision event without a loaded model");
  assert.ok(!lines.some(line => line.kind === "baseline_rank" && "probabilities" in line),
    "baseline_rank must not carry fabricated probabilities");
  assert.ok(!JSON.stringify(lines).includes("sourceText"), "run log must not persist sourceText");
});

test("run log records real observation, expansion, relation and unknown events incrementally", async t => {
  const source = `export function f(opened: any) {
  const { handle, after } = opened;
  const size = Number(after.size += 1);
  return size;
}
`;
  const root = await makeFixture(t, source);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const runLogPath = join(root, "run-events.jsonl");
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-log-events", rootGoal: readOnlyGoal() },
    { sandbox, session, runLogPath },
  );
  assert.equal(result.status, "unknown", "the relevant unsupported mutation keeps the result honest");
  const lines = (await readFile(runLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const kinds = lines.map(line => line.kind);
  assert.equal(kinds[0], "start");
  assert.equal(kinds.at(-1), "finish");
  assert.equal(lines.at(-1).status, "unknown");
  for (const kind of ["source_observed", "node_expanded", "relation_resolved", "relation_unknown", "baseline_rank"]) {
    assert.ok(kinds.includes(kind), `run log must include ${kind}`);
  }
  assert.ok(!kinds.includes("decision"), "baseline runs never fabricate neural decisions");
  assert.ok(!JSON.stringify(lines).includes("after.size += 1"),
    "observation events carry identifiers and spans, never source text");
});

test("--no-log disables persistence and leaves no file behind", async t => {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const runLogPath = join(root, "should-not-exist.jsonl");
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-no-log", rootGoal: readOnlyGoal() },
    { sandbox, session, runLogPath, loggingEnabled: false },
  );
  assert.equal(result.logging.enabled, false);
  assert.equal(result.logging.state, "disabled");
  assert.equal(result.runLogPath, null);
  await assert.rejects(readFile(runLogPath, "utf8"), /ENOENT/);
});

test("compiled CLI --no-log with --run-log-path is a zero-write conflict", async t => {
  const root = await makeFixture(t);
  const run = runCli([
    "--repo", root,
    "--anchor-file", "src/a.ts",
    "--anchor-symbol", "size",
    "--anchor-line", "3",
    "--no-log",
    "--run-log-path", join(root, "conflict.jsonl"),
  ], tmpdir());
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /--no-log conflicts with --run-log-path/);
  await assert.rejects(readFile(join(root, "conflict.jsonl"), "utf8"), /ENOENT/);
});

test("run result never retains full source text or base64 file bytes", async t => {
  const marker = "UNIQUE_SOURCE_MARKER_0xDEC0DE";
  const source = `export function f(opened: any) {\n  const { handle, after } = opened;\n  // ${marker}\n  const size = Number(after.size);\n  return size;\n}\n`;
  const root = await makeFixture(t, source);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-no-source", rootGoal: readOnlyGoal({ anchorLine: 4 }) },
    { sandbox, session, runLogPath: join(root, "run.jsonl") },
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(marker), "the full source text must not survive in the result");
  // base64 of the full source is also absent; the reply is only reachable facts.
  const base64 = Buffer.from(source, "utf8").toString("base64");
  assert.ok(!serialized.includes(base64), "the base64 file-read mirror must not survive");
});

test("search content throw yields unknown with the typed original error and partial edges", async t => {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const wrapped = wrapSearchSandbox(sandbox, session, "throw");
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-search-throw", rootGoal: readOnlyGoal() },
    { sandbox: wrapped, session, runLogPath: join(root, "run.jsonl") },
  );
  assert.equal(result.status, "unknown", "a thrown content search must not become achieved");
  assert.equal(result.resolution, "insufficient_evidence");
  const failure = searchFailureResult(result, "SEARCH_CONTENT_FAILED");
  assert.ok(failure, "the thrown search must be recorded as a search failure");
  assert.equal(failure.operation, "directory.search.content");
  assert.equal(failure.stage, "execute");
  assert.equal(failure.message, "CONTENT_BOOM", "the original error message must survive");
  assert.deepEqual(result.finalState.pendingSearches, ["src"], "the failed current scope remains pending");
  assert.ok(failure.unfinishedScopePaths.includes("src"), "the failed current scope remains unfinished");
  assert.ok(result.edges.length > 0, "already-confirmed local relations must still be returned");
});

test("search content failed receipt yields unknown and keeps the failed code", async t => {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const wrapped = wrapSearchSandbox(sandbox, session, "fail");
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-search-fail", rootGoal: readOnlyGoal() },
    { sandbox: wrapped, session, runLogPath: join(root, "run.jsonl") },
  );
  assert.equal(result.status, "unknown", "a failed content search must not become achieved");
  const failure = searchFailureResult(result, "SEARCH_CONTENT_DENIED");
  assert.ok(failure, "the failed semantic search must be recorded");
  assert.equal(failure.operation, "directory.search.content");
  assert.equal(failure.message, "content denied");
  assert.deepEqual(result.finalState.pendingSearches, ["src"], "the failed current scope remains pending");
  assert.ok(failure.unfinishedScopePaths.includes("src"), "the failed current scope remains unfinished");
  assert.ok(result.edges.length > 0, "confirmed local relations must survive a failed search");
});

test("a legitimate zero-match search is not a search failure", async t => {
  const root = await makeFixture(t);
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "lib", "empty.ts"), "export const unrelated = 1;\n");
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  // The anchor file is outside the searched scope, so `directory.search.content`
  // finds zero `size` matches and still succeeds. That is a complete result for
  // the scope, never a search failure.
  const result = await valueFlow.runCliValueFlowGoal(
    { requestId: "vf-search-zero", rootGoal: readOnlyGoal({ scopePaths: ["lib"] }) },
    { sandbox, session, runLogPath: join(root, "run.jsonl") },
  );
  assert.equal(result.finalState.searchFailures.length, 0, "zero matches must not register as a failure");
  assert.deepEqual(result.finalState.pendingSearches, [], "a successful zero-match search consumes the scope");
  assert.equal(result.status, "achieved", result.resolution);
});

for (const scenario of [
  { name: "first failed receipt", failAt: 1, error: "failed" },
  { name: "first throw", failAt: 1, error: "throw" },
  { name: "second failed receipt after a successful chunk", failAt: 2, error: "failed", big: true },
  { name: "second throw after a successful chunk", failAt: 2, error: "throw", big: true },
  { name: "wrong observation kind", failAt: 1, error: "wrong-kind" },
]) {
  test(`file.read ${scenario.name} counts each actual sandbox attempt once`, async t => {
    const root = scenario.big === true ? await makeBigFixture(t) : await makeFixture(t);
    const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
    t.after(async () => sandbox.cleanup());
    const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
    const wrapped = wrapReadSandbox(sandbox, session, scenario);
    const result = await valueFlow.runCliValueFlowGoal(
      { requestId: `vf-read-${scenario.name.replaceAll(" ", "-")}`, rootGoal: readOnlyGoal() },
      { sandbox: wrapped.sandbox, session, runLogPath: join(root, `read-${scenario.name.replaceAll(" ", "-")}.jsonl`) },
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.resolution, "insufficient_evidence");
    const attempts = wrapped.attempts();
    assert.ok(attempts >= 1);
    assert.equal(result.counters.sandboxApiCalls, attempts, `sandboxApiCalls must equal ${attempts} actual sandbox attempts`);
    assert.equal(result.counters.fileReadCalls, attempts, `fileReadCalls must equal ${attempts} actual sandbox attempts`);
  });
}

// C1-C4 drive the adapter's continuation rebuild directly: a continuation that
// arrives in a new process has no request WorkingSet, so the adapter must drop
// every WorkingSet-backed fact while keeping the monotonic counters and the
// historical controller prefix (the input state) intact. The shared
// `recursive-goal/module.ts` controller is outside this worker's writable set;
// its budget-stop `remainingRequirements` only names the in-flight condition,
// so a full public-entry re-drive across a mid-step budget stop is reported as
// a residual limitation rather than asserted here.
async function rebuildOnContinuation(t, counterOverrides = {}) {
  const root = await makeFixture(t);
  const sandbox = await filesystem.createReadOnlyCliFilesystemSandbox({ root, allowReadOnlySearch: true });
  t.after(async () => sandbox.cleanup());
  const session = sandbox.bindSession(filesystem.DEFAULT_READ_ONLY_SESSION_ID);
  const snapshot = sandbox.getSession(session);
  const goal = readOnlyGoal({ maxCandidateFileReads: 3 });
  const base = RECURSIVE.buildInitialState(goal, snapshot, "req");
  const fakeRef = {
    kind: "cli.file",
    scenarioId: snapshot.id,
    sessionId: session.sessionId,
    type: "regular",
    identity: { dev: 1, ino: 2 },
    sourceRun: "prior",
    sessionRevision: snapshot.revision,
    absolutePath: join(root, "src", "a.ts"),
  };
  const counters = { ...base.counters, sandboxApiCalls: 9, searchCalls: 4, fileReadCalls: 5, candidateFilesRead: 2, searchMatchesSeen: 7, totalRelaxations: 3, ...counterOverrides };
  const priorState = Object.freeze({
    ...base,
    files: Object.freeze([Object.freeze({ relPath: "src/a.ts", fileObjectRef: fakeRef, size: 121 })]),
    searchMatches: Object.freeze([Object.freeze({
      relPath: "src/a.ts",
      line: 3,
      column: 9,
      preview: "const size = Number(after.size);",
      score: 1,
      priorityTier: 1,
      scorerSource: "deterministic_baseline:VF-Baseline-0",
      modelRef: null,
    })]),
    searchFailures: Object.freeze([Object.freeze({
      scopePath: "src",
      operation: "directory.search.content",
      stage: "execute",
      code: "SEARCH_CONTENT_FAILED",
      message: "prior",
      runId: null,
      executorInvoked: false,
      unfinishedScopePaths: Object.freeze([]),
      unfinishedCandidates: Object.freeze([]),
    })]),
    sites: Object.freeze([Object.freeze({ siteId: "stale-site" })]),
    edges: Object.freeze([Object.freeze({ fromSiteId: "stale", toSiteId: "stale" })]),
    anchorSiteId: "stale-anchor",
    termination: Object.freeze({ status: "achieved", resolution: "complete" }),
    counters: Object.freeze(counters),
  });
  const handle = RECURSIVE.createValueFlowAdapter({ sandbox, session });
  t.after(() => handle.disposeWorkingSet());
  const validated = await handle.adapter.validateRequest({
    schema: CONTRACT.VALUE_FLOW_REQUEST_SCHEMA,
    requestId: "req",
    rootGoal: goal,
    satisfactionThreshold: 100,
    rootBindings: {
      session: { kind: "cli.session", scenarioId: snapshot.id, sessionId: session.sessionId },
      scopePaths: goal.scopePaths,
    },
    state: priorState,
    rootEvaluatorId: CONTRACT.VALUE_FLOW_ROOT_EVALUATOR,
    rootSelectorId: CONTRACT.VALUE_FLOW_ROOT_SELECTOR,
    continuation: { schema: "nnanything.recursive-goal.continuation.v1" },
  });
  return { rebuilt: validated.state, priorState, counters };
}

test("C1 continuation without a WorkingSet invalidates files, sites, edges and search state", async t => {
  const { rebuilt } = await rebuildOnContinuation(t);
  assert.equal(rebuilt.files.length, 0, "unbacked files are dropped");
  assert.equal(rebuilt.sites.length, 0, "unbacked sites are dropped");
  assert.equal(rebuilt.edges.length, 0, "unbacked edges are dropped");
  assert.equal(rebuilt.searchMatches.length, 0, "unbacked search matches are dropped");
  assert.equal(rebuilt.anchorSiteId, null);
  assert.equal(rebuilt.termination, null, "the stale completion is cleared");
});

test("C2a continuation rebuild keeps counters monotonic, never reset to files.length", async t => {
  const { rebuilt, counters } = await rebuildOnContinuation(t);
  assert.deepEqual(rebuilt.counters, counters, "counters must survive the rebuild unchanged");
  assert.notEqual(rebuilt.counters.candidateFilesRead, rebuilt.files.length, "candidateFilesRead is not reset to the empty file count");
});

test("C2b reset rebuild schedules the full re-read and re-search over every scope", async t => {
  const { rebuilt, priorState } = await rebuildOnContinuation(t);
  assert.deepEqual(rebuilt.pendingReads, ["src/a.ts"], "the anchor file is re-queued for a real re-read");
  assert.deepEqual(rebuilt.pendingSearches, ["src"], "every scope is re-queued for a real re-search");
  // C3: the historical controller prefix (the recorded prior state) is not mutated.
  assert.equal(priorState.files.length, 1, "the historical state prefix keeps its files");
  assert.equal(priorState.edges.length, 1, "the historical state prefix keeps its edges");
  assert.notEqual(rebuilt, priorState, "the rebuild returns a new state object");
});

test("C4 continuation keeps cumulative candidateFilesRead and the read budget", async t => {
  const { rebuilt } = await rebuildOnContinuation(t, { candidateFilesRead: 2, fileReadCalls: 2 });
  assert.equal(rebuilt.counters.candidateFilesRead, 2, "candidateFilesRead is cumulative across the rebuild");
  assert.equal(rebuilt.maxCandidateFileReads, 3, "the explicit read budget is not reset");
  assert.equal(rebuilt.maxCandidateFileReads - rebuilt.counters.candidateFilesRead, 1,
    "only the unused budget remains after the rebuild");
});
