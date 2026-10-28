import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CLI_HYBRID_SEARCH_REF,
  buildFeatureVector,
  commandSearchStepFromEvaluation,
  computeCommandSearchSlotR,
  evaluateCommandSearchHead,
  evaluateCommandSearchRdea,
  loadCliHybridSearchModel,
  projectCommandSearchDomain,
  validateCliHybridSearchModel,
} from "../dist/filters/cli-command-search.js";
import {
  createCommandSearchDomainGuards,
  readCommandSearchEvidencePayload,
  readCommandSearchContinuation,
  readCommandSearchReadFact,
  readCommandSearchRdeaStep,
  readCommandSearchState,
  restoredCommandSearchSequence,
  validateCommandSearchBindings,
  validateCommandSearchRequest,
} from "../dist/adapters/cli/command-search-contract.js";

const MODEL_PATH =
  "/Volumes/Intel/playground/nnanything-runs/l2-layer-corpus-20261025/handwired-sandwich-mvp/cli-hybrid-package.json";
const HANDWIRED_ROOT = process.env.NN_HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";

const R_FEATURES = [
  "list.known",
  "list.execError",
  "name.matched",
  "name.absent",
  "type.known",
  "type.execError",
  "type.isRegular",
  "type.isNonRegular",
  "goal.isLiteral",
  "grep.present",
  "grep.execError",
  "grep.queryMatches",
  "grep.rawHit",
  "grep.rawCompleteNoMatch",
];
const E_FEATURES = [
  "goal.head",
  "goal.tail",
  "goal.N/16",
  "receipt.present",
  "actual.head",
  "actual.tail",
  "execution.succeeded",
  "execution.failed",
  "execution.unknown",
  "output.linesKnown",
  "output.logicalLines/16",
  "actual.N/16",
  "goal.isLiteral",
  "grep.present",
  "grep.normalCompleted",
  "grep.execFailed",
  "grep.queryMatches",
  "grep.rawHitValid",
  "grep.rawCompleteNoMatch",
];
const D_FEATURES = [
  "s0.listing.present",
  "s0.listing.complete",
  "s0.selectedFile.present",
  "read.present",
  "readE.unsatisfied",
  "readE.satisfied",
  "readE.unknown",
  "s0.r.insufficient",
  "s0.r.holds",
  "s0.r.refuted",
  "s1.slotEnabled",
  "s1.listing.present",
  "s1.listing.complete",
  "s1.selectedFile.present",
  "s1.r.insufficient",
  "s1.r.holds",
  "s1.r.refuted",
  "read.fromS0",
  "read.fromS1",
  "goal.isLiteral",
  "grep.present",
  "grepE.unsatisfied",
  "grepE.satisfied",
  "grepE.unknown",
  "grep.fromS0",
  "grep.fromS1",
];
const A_FEATURES = ["goal.head", "goal.tail", "E.unsatisfied", "E.satisfied", "E.unknown", "isLiteral"];

const SESSION = Object.freeze({ kind: "cli.session", scenarioId: "phase23-s2", sessionId: "s" });
const SESSION_SNAPSHOT = Object.freeze({
  id: "s",
  cwd: ".",
  revision: 0,
  grantedEffects: ["filesystem.read", "process.exec"],
});

const model = await loadCliHybridSearchModel({
  packagePath: MODEL_PATH,
  handwiredRoot: HANDWIRED_ROOT,
});

function directory(path) {
  return { kind: "cli.directory", scenarioId: "phase23-s2", sessionId: "s", path };
}

function literalRequest({ scopeRefs = [directory("scope-a")], cardinality = "all" } = {}) {
  return {
    requestId: "phase23-s2",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.command-search-scope",
        scopeRefs,
        fileFilter: null,
        ignorePolicy: "no_ignore",
      },
      requirement: { kind: "contains_literal", queryLiteral: "needle", cardinality },
    },
  };
}

function targetRequest({
  scopeRefs = [directory("scope-a")],
  cardinality = "all",
  followUpRead = null,
  fileFilter = { suffix: ".txt" },
} = {}) {
  return {
    requestId: "phase23-s2",
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: {
        kind: "cli.command-search-scope",
        scopeRefs,
        fileFilter,
        ignorePolicy: "no_ignore",
      },
      requirement: { kind: "matches_target", cardinality, followUpRead },
    },
  };
}

function slotFact({
  slot = "s0",
  goalKind = "g2.read",
  matchedEntries = [],
  matchedLines = [],
  normalCompleted = true,
  coverage = "complete",
  reasons = [],
  toolUsed,
} = {}) {
  const literal = goalKind === "g3.literal-search";
  return {
    slot,
    operation: literal ? "directory.search.content" : "directory.search.entries",
    directory: directory(slot === "s0" ? "scope-a" : "scope-b"),
    toolUsed: toolUsed ?? (literal ? "rg" : "rg_files"),
    exitCode: 0,
    queryMatches: 1,
    normalCompleted,
    coverage,
    reasons,
    matchedEntries,
    matchedLines,
    stdoutBytesRead: 32,
    stdoutChunkCount: 1,
    crossChunkRecordSplits: 0,
    unterminatedRemainderBytes: 0,
    unterminatedFragmentDiscarded: false,
  };
}

function makeState(overrides = {}) {
  return {
    stateId: "phase23-s2:state-0",
    session: SESSION_SNAPSHOT,
    goalKind: overrides.goalKind ?? "g2.read",
    cardinality: overrides.cardinality ?? "all",
    s1Enabled: overrides.s1Enabled ?? false,
    lastSearchedSlot: overrides.lastSearchedSlot ?? "s0",
    slotReceipts: overrides.slotReceipts ?? { s0: null, s1: null },
    readReceipt: overrides.readReceipt ?? null,
    issuedRefs: overrides.issuedRefs ?? [],
    spawnLedger: overrides.spawnLedger ?? [],
    stepTrace: overrides.stepTrace ?? [],
  };
}

function runResponse({
  states = [],
  outcome = "completed",
  stopReason = "root_evaluation",
  rootResult = "satisfied",
  continuation = null,
  errors = [],
  primaryErrorId = null,
} = {}) {
  const rootEvaluation =
    rootResult === null
      ? { state: "not_evaluated", reason: "not_reached", blockedByErrorId: null }
      : {
          state: "evaluated",
          result: rootResult,
          satisfaction: rootResult === "satisfied" ? 100 : 0,
          evaluatorId: "root",
          evidenceRefs: [],
          evaluatedAtTransition: 1,
        };
  return {
    kind: "run_result",
    report: {
      root: { requestId: "phase23-s2" },
      rootEvaluation,
      control: { outcome, stopReason, frameId: "frame" },
      states: states.map((value, index) => ({ id: `phase23-s2:state-${index}`, value })),
      evidence: [],
      frames: [],
      effects: [],
      atomicResults: [],
      errors,
      primaryErrorId,
      relatedIssues: [],
      budgetUsed: { transitionsUsed: 2, derivedGoalsUsed: 1 },
      continuation,
      cleanup: null,
      collection: null,
    },
  };
}

test("real cli.hybrid-package.v1 loads with frozen parameters and public metadata", () => {
  assert.deepEqual(model.ref, DEFAULT_CLI_HYBRID_SEARCH_REF);
  assert.equal(model.schema, "cli.hybrid-package.v1");
  assert.equal(model.calibration, "uncalibrated");
  assert.equal(model.adoption, "not_applied");
  assert.equal(model.packagePath, MODEL_PATH);
  assert.equal(validateCliHybridSearchModel(model).ref.id, "cli.hybrid-search");
  assert.ok(Object.isFrozen(model.package));
  assert.ok(Object.isFrozen(model.package.heads.R.parameters));
  assert.ok(Object.isFrozen(model.profile.heads.E.parameters));
  assert.ok(Object.isFrozen(model.profile.heads.A.spec.features));
  assert.throws(() => {
    model.package.heads.R.parameters[0] = 999;
  }, TypeError);
  for (const key of ["hash", "digest", "sha256", "checksum"]) {
    assert.equal(Object.hasOwn(model, key), false);
    assert.equal(Object.hasOwn(model.ref, key), false);
  }
});

test("damaged packages and a missing handwired root fail explicitly", async t => {
  const root = await mkdtemp(join(tmpdir(), "nn-s2-model-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const badPath = join(root, "bad-package.json");
  await writeFile(badPath, JSON.stringify({ schema: "cli.hybrid-package.v1", heads: {} }), "utf8");
  await assert.rejects(
    loadCliHybridSearchModel({ packagePath: badPath, handwiredRoot: HANDWIRED_ROOT }),
    /validation failed|package|heads/,
  );
  await assert.rejects(
    loadCliHybridSearchModel({
      packagePath: MODEL_PATH,
      handwiredRoot: join(root, "missing-handwired"),
    }),
    /Handwired core is missing/,
  );
  assert.throws(() => validateCliHybridSearchModel(null), TypeError);
  assert.throws(
    () => validateCliHybridSearchModel({ ...model, package: {} }),
    TypeError,
  );
  assert.throws(
    () => validateCliHybridSearchModel({ ...model, ref: { id: "x", version: "" } }),
    TypeError,
  );
  assert.throws(
    () => validateCliHybridSearchModel({ ...model, packagePath: "" }),
    TypeError,
  );
});

test("R/E/D/A feature vectors follow the exact declared order and zero-fill missing names", () => {
  assert.deepEqual(model.profile.heads.R.spec.features, R_FEATURES);
  assert.deepEqual(model.profile.heads.E.spec.features, E_FEATURES);
  assert.deepEqual(model.profile.heads.D.spec.features, D_FEATURES);
  assert.deepEqual(model.profile.heads.A.spec.features, A_FEATURES);
  assert.deepEqual(buildFeatureVector(["a", "b", "c"], { b: 2 }), [0, 2, 0]);

  for (const [head, names, labelCount] of [
    ["R", R_FEATURES, 3],
    ["D", D_FEATURES, 8],
    ["A", A_FEATURES, 4],
  ]) {
    const named = Object.fromEntries(names.map((name, index) => [name, (index + 1) / 100]));
    const evaluation = evaluateCommandSearchHead(model, head, named);
    assert.equal(evaluation.features.length, names.length);
    assert.deepEqual([...evaluation.features], names.map((_, index) => (index + 1) / 100));
    assert.deepEqual(Object.keys(evaluation.namedFeatures), names);
    assert.equal(evaluation.logits.length, labelCount);
    assert.equal(Object.keys(evaluation.logitsByLabel).length, labelCount);
  }

  const readInitial = computeCommandSearchSlotR(model, null, "g2.read");
  assert.equal(readInitial.features.length, 14);
  assert.equal(readInitial.namedFeatures["list.known"], 0);
  const literalInitial = computeCommandSearchSlotR(model, null, "g3.literal-search");
  assert.equal(literalInitial.features.length, 14);
  assert.equal(literalInitial.namedFeatures["goal.isLiteral"], 1);
  assert.equal(literalInitial.namedFeatures["grep.present"], 0);
});

test("E head read/literal gates route no-receipt states to fixed scores", () => {
  const readInitial = evaluateCommandSearchRdea(model, {
    goalKind: "g2.read",
    cardinality: "all",
    s1Enabled: false,
    lastSearchedSlot: null,
    slotReceipts: { s0: null, s1: null },
    readReceipt: null,
    followUpRead: null,
  });
  assert.equal(readInitial.E.readGate, 1);
  assert.equal(readInitial.E.literalGate, 0);
  assert.equal(readInitial.E.predictedLabel, "unsatisfied");
  assert.deepEqual([...readInitial.E.routedLogits], [1, 0, 0]);

  const literalInitial = evaluateCommandSearchRdea(model, {
    goalKind: "g3.literal-search",
    cardinality: "all",
    s1Enabled: false,
    lastSearchedSlot: null,
    slotReceipts: { s0: null, s1: null },
    readReceipt: null,
    followUpRead: null,
  });
  assert.equal(literalInitial.E.readGate, 0);
  assert.equal(literalInitial.E.literalGate, 1);
  assert.equal(literalInitial.E.predictedLabel, "unknown");
  assert.deepEqual([...literalInitial.E.routedLogits], [0, 0, 1]);

  const readHit = slotFact({
    goalKind: "g2.read",
    matchedEntries: ["note.txt"],
  });
  const readSatisfied = evaluateCommandSearchRdea(model, {
    goalKind: "g2.read",
    cardinality: "all",
    s1Enabled: false,
    lastSearchedSlot: "s0",
    slotReceipts: { s0: readHit, s1: null },
    readReceipt: null,
    followUpRead: null,
  });
  assert.equal(readSatisfied.E.readGate, 0);
  assert.equal(readSatisfied.E.predictedLabel, "satisfied");
  assert.equal(readSatisfied.D.predictedLabel, "RETURN_RESULT");
  assert.equal(readSatisfied.A.predictedLabel, "RETURN");

  const literalHit = slotFact({
    goalKind: "g3.literal-search",
    matchedEntries: ["note.txt"],
    matchedLines: [
      {
        relPath: "note.txt",
        lineNumber: 1,
        lineByteLength: 6,
        lineText: "needle",
        matchedLineHasTrailingLF: true,
      },
    ],
  });
  const literalSatisfied = evaluateCommandSearchRdea(model, {
    goalKind: "g3.literal-search",
    cardinality: "all",
    s1Enabled: false,
    lastSearchedSlot: "s0",
    slotReceipts: { s0: literalHit, s1: null },
    readReceipt: null,
    followUpRead: null,
  });
  assert.equal(literalSatisfied.E.literalGate, 0);
  assert.equal(literalSatisfied.E.predictedLabel, "satisfied");
  assert.equal(literalSatisfied.D.predictedLabel, "RETURN_RESULT");
  assert.equal(literalSatisfied.A.predictedLabel, "RETURN");
});

test("projection maps achieved, unmet, unknown, early-stop, budget and rejected outcomes", () => {
  const achievedState = makeState({
    goalKind: "g3.literal-search",
    slotReceipts: {
      s0: slotFact({
        goalKind: "g3.literal-search",
        matchedEntries: ["note.txt"],
        matchedLines: [
          {
            relPath: "note.txt",
            lineNumber: 1,
            lineByteLength: 6,
            lineText: "needle",
            matchedLineHasTrailingLF: true,
          },
        ],
      }),
      s1: null,
    },
    spawnLedger: [
      { purpose: "search_command", toolUsed: "rg", cmd: "rg", args: ["-F", "needle"], exitCode: 0 },
    ],
  });
  const achieved = projectCommandSearchDomain({
    request: literalRequest(),
    model,
    response: runResponse({ states: [achievedState] }),
  });
  assert.equal(achieved.status, "achieved");
  assert.equal(achieved.resolution, "matched");
  assert.equal(achieved.satisfaction, 100);
  assert.equal(achieved.coverage, "complete");
  assert.deepEqual([...achieved.matchedEntries], ["note.txt"]);
  assert.equal(achieved.searchCommandSpawns, 1);
  assert.equal(achieved.probeCommandSpawns, 0);
  assert.equal(achieved.totalProcessSpawns, 1);
  assert.deepEqual(achieved.modelMetadata.ref, DEFAULT_CLI_HYBRID_SEARCH_REF);
  assert.equal(achieved.modelMetadata.schema, "cli.hybrid-package.v1");
  assert.equal(achieved.modelMetadata.calibration, "uncalibrated");
  assert.equal(achieved.modelMetadata.adoption, "not_applied");
  for (const key of ["hash", "digest", "sha256", "checksum"]) {
    assert.equal(Object.hasOwn(achieved.modelMetadata, key), false);
  }

  const unmetState = makeState({
    goalKind: "g3.literal-search",
    slotReceipts: { s0: slotFact({ goalKind: "g3.literal-search" }), s1: null },
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: [], exitCode: 1 }],
  });
  const unmet = projectCommandSearchDomain({
    request: literalRequest(),
    model,
    response: runResponse({ states: [unmetState], rootResult: "unsatisfied" }),
  });
  assert.equal(unmet.status, "unmet");
  assert.equal(unmet.resolution, "not_found");
  assert.equal(unmet.satisfaction, 0);
  assert.equal(unmet.coverage, "complete");
  assert.ok(unmet.reasons.includes("no_matching_entries"));

  const partialState = makeState({
    goalKind: "g3.literal-search",
    slotReceipts: {
      s0: slotFact({
        goalKind: "g3.literal-search",
        matchedEntries: ["note.txt"],
        coverage: "partial",
        normalCompleted: false,
        reasons: ["stdout_max_bytes_exceeded"],
      }),
      s1: null,
    },
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: [], exitCode: 0 }],
  });
  const partial = projectCommandSearchDomain({
    request: literalRequest(),
    model,
    response: runResponse({ states: [partialState], rootResult: "unknown" }),
  });
  assert.equal(partial.status, "unknown");
  assert.equal(partial.resolution, "partial");
  assert.equal(partial.satisfaction, null);
  assert.equal(partial.coverage, "partial");
  assert.ok(partial.reasons.includes("stdout_max_bytes_exceeded"));

  const emptyPartial = makeState({
    goalKind: "g3.literal-search",
    slotReceipts: {
      s0: slotFact({
        goalKind: "g3.literal-search",
        coverage: "partial",
        normalCompleted: false,
        reasons: ["stdout_max_bytes_exceeded"],
      }),
      s1: null,
    },
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: [], exitCode: 0 }],
  });
  const insufficient = projectCommandSearchDomain({
    request: literalRequest(),
    model,
    response: runResponse({ states: [emptyPartial], rootResult: "unknown" }),
  });
  assert.equal(insufficient.status, "unknown");
  assert.equal(insufficient.resolution, "insufficient_evidence");
  assert.equal(insufficient.satisfaction, null);
  assert.equal(insufficient.coverage, "partial");

  const earlyState = makeState({
    goalKind: "g3.literal-search",
    cardinality: "one",
    s1Enabled: true,
    slotReceipts: {
      s0: slotFact({
        goalKind: "g3.literal-search",
        matchedEntries: ["note.txt"],
      }),
      s1: null,
    },
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: [], exitCode: 0 }],
  });
  const early = projectCommandSearchDomain({
    request: literalRequest({
      scopeRefs: [directory("scope-a"), directory("scope-b")],
      cardinality: "one",
    }),
    model,
    response: runResponse({ states: [earlyState] }),
  });
  assert.equal(early.status, "achieved");
  assert.equal(early.resolution, "matched");
  assert.equal(early.satisfaction, 100);
  assert.equal(early.coverage, "partial");
  assert.ok(early.reasons.includes("unsearched_fallback_scope_early_stop"));
  assert.equal(early.searchCommandSpawns, 1);

  const budgetState = makeState({
    goalKind: "g3.literal-search",
    cardinality: "one",
    s1Enabled: true,
    slotReceipts: { s0: slotFact({ goalKind: "g3.literal-search" }), s1: null },
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: [], exitCode: 1 }],
  });
  const budget = projectCommandSearchDomain({
    request: literalRequest({
      scopeRefs: [directory("scope-a"), directory("scope-b")],
      cardinality: "one",
    }),
    model,
    response: runResponse({
      states: [budgetState],
      outcome: "exceeded",
      stopReason: "budget",
      rootResult: null,
      continuation: { schema: "recursive_goal_continuation.v1" },
    }),
  });
  assert.equal(budget.status, "unknown");
  assert.equal(budget.resolution, "budget_exhausted");
  assert.equal(budget.satisfaction, null);
  assert.equal(budget.coverage, "partial");
  assert.notEqual(budget.preserve.continuation, null);

  const rejected = projectCommandSearchDomain({
    request: literalRequest(),
    model,
    response: {
      kind: "request_rejected",
      error: {
        errorId: "e-1",
        code: "invalid_binding",
        stage: "binding",
        message: "forged scope",
      },
    },
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resolution, "rejected");
  assert.equal(rejected.satisfaction, null);
  assert.equal(rejected.coverage, null);
  assert.deepEqual([...rejected.issuedRefs], []);
  assert.equal(rejected.totalProcessSpawns, 0);
});

test("strict request/bindings/state/evidence contracts reject forged or malformed facts", () => {
  const singleAll = validateCommandSearchRequest(literalRequest());
  assert.equal(singleAll.goal.requirement.cardinality, "all");
  const dualOne = validateCommandSearchRequest(
    literalRequest({
      scopeRefs: [directory("scope-a"), directory("scope-b")],
      cardinality: "one",
    }),
  );
  assert.equal(dualOne.goal.target.scopeRefs.length, 2);
  assert.throws(
    () =>
      validateCommandSearchRequest(
        literalRequest({
          scopeRefs: [directory("scope-a"), directory("scope-b")],
          cardinality: "all",
        }),
      ),
    /multi-scope cardinality all/,
  );
  assert.throws(
    () =>
      validateCommandSearchRequest({
        ...literalRequest(),
        goal: {
          ...literalRequest().goal,
          requirement: { kind: "contains_literal", queryLiteral: "", cardinality: "all" },
        },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      validateCommandSearchRequest(
        targetRequest({ fileFilter: null }),
      ),
    /fileFilter must not be null/,
  );

  const bindings = {
    session: SESSION,
    scopeRefs: [directory("scope-a")],
    fileFilter: null,
    ignorePolicy: "no_ignore",
    goalKind: "g3.literal-search",
    cardinality: "all",
    queryLiteral: "needle",
    followUpRead: null,
    modelRef: DEFAULT_CLI_HYBRID_SEARCH_REF,
  };
  assert.deepEqual(validateCommandSearchBindings(bindings, SESSION, DEFAULT_CLI_HYBRID_SEARCH_REF).modelRef, {
    id: "cli.hybrid-search",
    version: "cli.hybrid-package.v1",
  });
  assert.throws(
    () =>
      validateCommandSearchBindings(
        { ...bindings, modelRef: { id: "cli.hybrid-search", version: "v-other" } },
        SESSION,
        DEFAULT_CLI_HYBRID_SEARCH_REF,
      ),
    /does not match the injected model/,
  );
  assert.throws(
    () =>
      validateCommandSearchBindings(
        { ...bindings, queryLiteral: "needle\n" },
        SESSION,
        DEFAULT_CLI_HYBRID_SEARCH_REF,
      ),
    /must not contain CR or LF/,
  );
  assert.throws(
    () =>
      validateCommandSearchBindings(
        {
          ...bindings,
          goalKind: "g2.read",
          cardinality: "all",
          queryLiteral: null,
          fileFilter: null,
        },
        SESSION,
        DEFAULT_CLI_HYBRID_SEARCH_REF,
      ),
    /fileFilter must not be null/,
  );
  const guards = createCommandSearchDomainGuards({
    session: SESSION,
    modelRef: DEFAULT_CLI_HYBRID_SEARCH_REF,
  });
  assert.throws(
    () => guards.bindings({ ...bindings, modelRef: { id: "forged", version: "1" } }),
    TypeError,
  );
  assert.throws(
    () => readCommandSearchContinuation({}, guards),
    TypeError,
  );

  const hit = slotFact({ goalKind: "g2.read", matchedEntries: ["note.txt"] });
  const evaluation = evaluateCommandSearchRdea(model, {
    goalKind: "g2.read",
    cardinality: "all",
    s1Enabled: false,
    lastSearchedSlot: "s0",
    slotReceipts: { s0: hit, s1: null },
    readReceipt: null,
    followUpRead: null,
  });
  const step = commandSearchStepFromEvaluation(0, evaluation, {
    slot: "s0",
    operation: "directory.search.entries",
  });
  const issuedRef = {
    kind: "cli.file",
    scenarioId: "phase23-s2",
    sessionId: "s",
    type: "regular",
    identity: { dev: 1, ino: 2 },
    sourceRun: "run-1",
    sessionRevision: 0,
    absolutePath: "/tmp/scope-a/note.txt",
  };
  const readFact = {
    slot: "s0",
    relPath: "note.txt",
    fileRef: issuedRef,
    operation: "file.read.lines",
    bytesRead: 16,
    logicalLines: 2,
    bytesBase64: "bm90ZQ==",
    identity: { dev: 1, ino: 2 },
  };
  assert.equal(readCommandSearchReadFact(readFact).fileRef.kind, "cli.file");
  assert.throws(
    () => readCommandSearchReadFact({ ...readFact, operation: "file.read.unsupported" }),
    /operation must be/,
  );
  assert.throws(
    () => readCommandSearchReadFact({ ...readFact, identity: { dev: 1, ino: 3 } }),
    /does not match/,
  );
  const state = makeState({
    goalKind: "g2.read",
    slotReceipts: { s0: hit, s1: null },
    readReceipt: readFact,
    issuedRefs: [issuedRef],
    spawnLedger: [{ purpose: "search_command", cmd: "rg", args: ["--files"], exitCode: 0 }],
    stepTrace: [step],
  });
  const validatedState = readCommandSearchState(state);
  assert.equal(validatedState.stepTrace[0].R.s0.features.length, 14);
  assert.equal(validatedState.stepTrace[0].E.features.length, 19);
  assert.equal(validatedState.stepTrace[0].D.features.length, 26);
  assert.equal(validatedState.stepTrace[0].A.features.length, 6);

  assert.throws(
    () => readCommandSearchState({ ...state, extra: true }),
    /exactly/,
  );
  assert.throws(
    () => readCommandSearchState({ ...state, issuedRefs: [issuedRef, issuedRef] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      readCommandSearchState({
        ...state,
        cardinality: "all",
        s1Enabled: true,
      }),
    /cannot enable s1 with cardinality all/,
  );
  assert.throws(
    () =>
      readCommandSearchState({
        ...state,
        s1Enabled: false,
        readReceipt: { ...readFact, slot: "s1" },
      }),
    /cannot hold s1 readReceipt/,
  );
  assert.throws(
    () =>
      readCommandSearchState({
        ...state,
        slotReceipts: { s0: { ...hit, operation: "directory.search.content" }, s1: null },
      }),
    /operation must be/,
  );
  assert.throws(
    () =>
      readCommandSearchState({
        ...state,
        slotReceipts: { s0: { ...hit, stdoutBytesRead: -1 }, s1: null },
      }),
    /non-negative/,
  );
  const duplicateStep = commandSearchStepFromEvaluation(0, evaluation, null);
  assert.throws(
    () => readCommandSearchState({ ...state, stepTrace: [duplicateStep, duplicateStep] }),
    /contiguous/,
  );
  assert.throws(
    () => readCommandSearchRdeaStep({ ...step, stepIndex: -1 }),
    /non-negative/,
  );
  assert.throws(
    () => readCommandSearchRdeaStep({ ...step, E: { ...step.E, features: step.E.features.slice(1) } }),
    /length 19/,
  );

  const receipt = {
    call: { operation: "pwd", parameters: {} },
    status: "succeeded",
    session_before: SESSION_SNAPSHOT,
    session_after: SESSION_SNAPSHOT,
    execution: {
      status: "succeeded",
      runId: "run-1",
      executorInvoked: true,
      observation: { kind: "directory.search.entries" },
    },
  };
  assert.throws(
    () =>
      readCommandSearchEvidencePayload({
        kind: "cli.command-search.observation.v1",
        transitionId: "transition-1",
        stateId: "state-1",
        receipt,
      }),
    /not a command search operation/,
  );

  assert.equal(
    restoredCommandSearchSequence({
      states: [{ id: "req:state-3" }, { id: "req:state-7" }],
    }),
    7,
  );
  assert.equal(restoredCommandSearchSequence(null), 0);
});
