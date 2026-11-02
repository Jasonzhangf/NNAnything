// Memory-sharing gate for the content-search state snapshot.
//
// The recursive-goal engine used to deep-clone the whole content-search state
// (adapter validate -> snapshotData -> freezeSnapshot -> callbackState) on every
// atomic step, so each step retained a brand new copy of every unchanged
// candidate. The contract parsers now validate the domain schema first and then
// reuse a pure frozen input reference, and the engine skips its clone for a
// receipt the adapter already proved pure frozen. This test proves the observable
// consequences: verified frozen input keeps identity, invalid or legacy input is
// still rejected, unchanged candidates are shared across steps, and a real update
// leaves the earlier state untouched.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFixtureAdapter,
  errorsByCode,
  evaluator,
  makeRequest,
  responseReport,
  selector,
  skill,
  successfulAtomicReceipt,
} from "./recursive-goal-fixtures.mjs";

function deepFreeze(value) {
  if (typeof value !== "object" || value === null) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function recursiveDeps(fixture) {
  return {
    adapter: fixture.adapter,
    enabledSkills: [skill("increment-counter", "atomic")],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["increment-counter"])],
    comparators: {
      sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    },
    grantedEffects: new Set(),
  };
}

function routingProfile(goal) {
  const heads = goal.CLI_COMMAND_HEADS;
  const wires = goal.CLI_COMMAND_WIRES;
  const weights = heads.map(() => wires.map(() => 0));
  const set = (head, wire, value = 1) => {
    const row = heads.indexOf(head);
    const column = wires.indexOf(wire);
    assert.ok(row >= 0 && column >= 0, `unknown text-scan route ${head} x ${wire}`);
    weights[row][column] = value;
  };
  set("ls", "goalListDirectory");
  set("ls", "property.directory.entries");
  set("ls", "predicate.observe.entries");
  set("entry.inspect", "property.type");
  set("entry.inspect", "predicate.observe.inspect");
  return goal.validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...heads],
    properties: [...goal.CLI_COMMAND_PROPERTIES],
    predicates: [...goal.CLI_COMMAND_PREDICATES],
    wires: [...wires],
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

async function runFixture(t) {
  const search = await import("nnanything/cli-content-search");
  const goal = await import("nnanything/cli-goal");
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-share-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const needle = "needle-token";
  const entries = [
    { path: "src", kind: "directory" },
    { path: "src/a.ts", kind: "file", contents: `export const a = "${needle}";\n` },
    { path: "src/b.ts", kind: "file", contents: "export const b = 2;\n" },
    { path: "src/c.ts", kind: "file", contents: "export const c = 3;\n" },
  ];
  const sandbox = await search.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "content-search-memory-share",
      entries,
      sessions: [{ id: "s", cwd: "src", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
  });
  t.after(async () => {
    await sandbox.cleanup();
  });

  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectory(session, ".");
  const result = await search.runCliContentSearchGoal({
    requestId: "content-search-memory-share",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality: "all",
        recursion: "nested",
      },
      requirement: { kind: "contains", predicate: { kind: "contains", needle, encoding: "utf8" } },
    },
    satisfactionThreshold: 100,
  }, {
    sandbox,
    session,
    profile: routingProfile(goal),
    scan: Object.freeze({
      maxBytesPerFile: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      chunkSize: 64 * 1024,
      maxDirectoryDepth: 8,
      maxStaleRetries: 1,
    }),
  });
  return { search, result, needle };
}

test("verified frozen content-search state keeps identity and fields", async t => {
  const { result } = await runFixture(t);
  const { readContentSearchState } = await import("../dist/adapters/cli/content-search-contract.js");
  const states = result.response.report.states.map(record => record.value);
  const withCandidates = states.find(state => state.candidates.length > 0);
  assert.ok(withCandidates !== undefined, "expected at least one state with candidates");

  const parsed = readContentSearchState(withCandidates);
  assert.equal(parsed, withCandidates, "a verified pure frozen state must be reused by reference");
  assert.deepEqual(parsed, withCandidates, "reuse must not change any observable field");
  assert.equal(parsed.candidates, withCandidates.candidates, "candidate array identity is preserved");
});

test("invalid frozen content-search state is still rejected", async t => {
  const { result } = await runFixture(t);
  const { readContentSearchState } = await import("../dist/adapters/cli/content-search-contract.js");
  const state = result.response.report.states[result.response.report.states.length - 1].value;

  const badKind = Object.freeze({ ...state, cardinality: "many" });
  assert.throws(() => readContentSearchState(badKind), TypeError, "wrong kind must be rejected even when frozen");

  const badType = Object.freeze({ ...state, bytesReadTotal: "not-a-number" });
  assert.throws(() => readContentSearchState(badType), TypeError, "wrong field type must be rejected even when frozen");

  const missing = { ...state };
  delete missing.bytesReadTotal;
  assert.throws(() => readContentSearchState(Object.freeze(missing)), TypeError, "missing field must be rejected even when frozen");
});

test("legacy bytes read shape is still rejected", async t => {
  const { result } = await runFixture(t);
  const { readContentSearchState } = await import("../dist/adapters/cli/content-search-contract.js");
  const states = result.response.report.states.map(record => record.value);
  const state = states.find(entry => entry.candidates.some(candidate => candidate.read !== null));
  assert.ok(state !== undefined, "expected a state with a retained read reference");

  const readCandidate = state.candidates.find(candidate => candidate.read !== null);
  const legacyRead = Object.freeze({ ...readCandidate.read, bytes: "" });
  const legacyCandidate = Object.freeze({ ...readCandidate, read: legacyRead });
  const legacyState = Object.freeze({
    ...state,
    candidates: Object.freeze(
      state.candidates.map(candidate => candidate === readCandidate ? legacyCandidate : candidate),
    ),
  });
  assert.throws(
    () => readContentSearchState(legacyState),
    TypeError,
    "the retired bytes-bearing read shape must be rejected",
  );
});

test("unchanged candidates are reference-shared across steps", async t => {
  const { result } = await runFixture(t);
  const states = result.response.report.states.map(record => record.value);
  assert.ok(states.length >= 5, `expected several atomic states, saw ${states.length}`);

  let reused = 0;
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1].candidates;
    for (const candidate of states[index].candidates) {
      if (previous.includes(candidate)) reused += 1;
    }
  }
  assert.ok(
    reused >= 4,
    `unchanged candidates must keep identity across steps, saw ${reused} shared references`,
  );
});

test("a real candidate update keeps the earlier state value", async t => {
  const { result } = await runFixture(t);
  const states = result.response.report.states.map(record => record.value);

  let checked = false;
  for (let index = 1; index < states.length && !checked; index += 1) {
    for (const candidate of states[index].candidates) {
      const previous = states[index - 1].candidates.find(entry => entry.path === candidate.path);
      if (previous === undefined || previous === candidate) continue;
      assert.notEqual(previous, candidate, "a real update must allocate a new candidate object");
      const reread = states[index - 1].candidates.find(entry => entry.path === candidate.path);
      assert.equal(reread, previous, "the earlier state must keep the previous candidate object");
      if (previous.inspected === null && candidate.inspected !== null) {
        assert.equal(previous.inspected, null, "the earlier state must keep its original inspected value");
        assert.notEqual(candidate.inspected, null);
      }
      if (previous.outcome !== candidate.outcome) {
        assert.equal(reread.outcome, previous.outcome, "the earlier state must keep its original outcome");
      }
      checked = true;
      break;
    }
  }
  assert.ok(checked, "expected at least one real candidate update boundary");
});

test("frozen and mutable listing errors normalize identically", async t => {
  const { result } = await runFixture(t);
  const { readContentSearchState } = await import("../dist/adapters/cli/content-search-contract.js");
  const states = result.response.report.states.map(record => record.value);
  const base = states[states.length - 1];
  const listing = {
    sourceRun: null,
    physicalDirectory: null,
    coverage: "partial",
    errors: [123],
    entries: [],
  };

  const mutable = readContentSearchState({ ...base, listing });
  const frozen = readContentSearchState(deepFreeze({ ...base, listing }));

  assert.deepEqual(mutable.listing.errors, ["123"]);
  assert.deepEqual(frozen.listing.errors, ["123"]);
  assert.deepEqual(frozen, mutable);
});

test("invalid frozen receipt is still rejected by the recursive-goal core", async () => {
  const api = await import("nnanything/recursive-goal");
  const receipts = [
    deepFreeze({ ...successfulAtomicReceipt({ count: 1 }), unexpectedField: true }),
    { ...successfulAtomicReceipt({ count: 1 }), unexpectedField: true },
  ];

  for (const receipt of receipts) {
    const fixture = createFixtureAdapter({ executeAtomic: () => receipt });
    const response = await api.runRecursiveGoal(makeRequest(), recursiveDeps(fixture));
    const report = responseReport(response);

    assert.notEqual(report.rootEvaluation.result, "satisfied");
    assert.ok(
      errorsByCode(report, "adapter_contract_invalid").length > 0,
      "the core must validate the atomic receipt structure after dispatch",
    );
  }
});

test("valid frozen receipt stays satisfied and shares its state value", async () => {
  const api = await import("nnanything/recursive-goal");
  const receipt = deepFreeze(successfulAtomicReceipt({ count: 1 }));
  const fixture = createFixtureAdapter({ executeAtomic: () => receipt });
  const response = await api.runRecursiveGoal(makeRequest(), recursiveDeps(fixture));
  const report = responseReport(response);

  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(errorsByCode(report, "adapter_contract_invalid").length, 0);
  assert.equal(report.states.at(-1).value.count, 1);
});

test("non-empty history keeps shared elements while a real update uses a new candidate", async t => {
  const { result } = await runFixture(t);
  const { readContentSearchState } = await import("../dist/adapters/cli/content-search-contract.js");
  const states = result.response.report.states.map(record => record.value);
  const base = states.find(state => state.candidates.length > 0);
  assert.ok(base !== undefined, "expected a state with candidates");

  const candidateIndex = Math.max(
    0,
    base.candidates.findIndex(candidate => candidate.fileRef !== null),
  );
  const candidate = base.candidates[candidateIndex];
  const fileRef = candidate.fileRef ?? {
    kind: "cli.file",
    scenarioId: "history-fixture",
    sessionId: "s",
    type: "regular",
    identity: { dev: 1, ino: 1 },
    sourceRun: "history-run",
    sessionRevision: 0,
    absolutePath: `/history/${candidate.name}`,
  };
  const historicalHit = deepFreeze({
    kind: "historical_stale_hit",
    historical: true,
    identityKey: {
      scenarioId: fileRef.scenarioId,
      sessionId: fileRef.sessionId,
      dev: fileRef.identity.dev,
      ino: fileRef.identity.ino,
      sessionRevision: fileRef.sessionRevision,
      sourceRun: fileRef.sourceRun,
    },
    fileRef,
    sourceRun: fileRef.sourceRun,
    path: candidate.path,
    needle: "needle-token",
    byteSpan: { start: 0, end: 1 },
    line: 1,
    column: 1,
    size: 1,
    bytesRead: 1,
    invalidation: {
      kind: "identity_changed",
      observedAtSourceRun: "history-retry",
      code: null,
    },
  });
  const history = Object.freeze([historicalHit]);
  const frozenInput = deepFreeze({
    ...base,
    candidates: Object.freeze(base.candidates.map((entry, index) =>
      index === candidateIndex ? { ...entry, history } : entry)),
  });

  const parsed = readContentSearchState(frozenInput);
  assert.equal(parsed, frozenInput);
  assert.equal(parsed.candidates[candidateIndex].history, history);
  assert.equal(parsed.candidates[candidateIndex].history[0], historicalHit);

  const updatedCandidate = Object.freeze({
    ...parsed.candidates[candidateIndex],
    outcome: parsed.candidates[candidateIndex].outcome === "negative" ? "matched" : "negative",
  });
  const updatedInput = deepFreeze({
    ...parsed,
    candidates: Object.freeze(parsed.candidates.map((entry, index) =>
      index === candidateIndex ? updatedCandidate : entry)),
  });
  const updated = readContentSearchState(updatedInput);

  assert.notEqual(updated.candidates[candidateIndex], parsed.candidates[candidateIndex]);
  assert.equal(
    updated.candidates[candidateIndex].history[0],
    parsed.candidates[candidateIndex].history[0],
    "an unchanged history element must stay shared after a real candidate update",
  );
  assert.equal(parsed.candidates[candidateIndex].outcome, candidate.outcome);
  assert.equal(parsed.candidates[candidateIndex].history.length, 1);
});
