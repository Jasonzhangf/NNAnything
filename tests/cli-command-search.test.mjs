import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliFilesystemSandbox,
  runCliCommandSearchGoal,
} from "../dist/cli-command-search.js";
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

const READ_LINES_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  killGraceMs: 1_000,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 16 * 1024,
});

async function commandSearchFixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cli-command-search-")));
  const scenarioId = options.scenarioId ?? "sc-product-slice3";
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId,
      entries: options.entries ?? [],
      sessions: options.sessions ?? [
        {
          id: "s",
          cwd: ".",
          grantedEffects: ["filesystem.read", "process.exec"],
        },
      ],
    },
    ...(options.fileReadLinesOptions === undefined
      ? { fileReadLinesOptions: READ_LINES_LIMITS }
      : { fileReadLinesOptions: options.fileReadLinesOptions }),
    ...(options.commandSearchCapabilities === undefined
      ? {}
      : { commandSearchCapabilities: options.commandSearchCapabilities }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return {
    sandbox,
    scenarioId,
    session: sandbox.bindSession(options.sessionId ?? "s"),
  };
}

async function commandScope(fx, path) {
  return fx.sandbox.bindDirectory(fx.session, path);
}

async function commandLiteralRequest(fx, options = {}) {
  const scopeRefs = await Promise.all((options.paths ?? ["scan"]).map(path => commandScope(fx, path)));
  return {
    requestId: options.requestId ?? "sc-slice3-literal",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.command-search-scope",
        scopeRefs,
        fileFilter: options.fileFilter ?? null,
        ignorePolicy: "no_ignore",
      },
      requirement: {
        kind: "contains_literal",
        queryLiteral: options.needle ?? "needle",
        cardinality: options.cardinality ?? "all",
      },
    },
  };
}

async function commandTargetRequest(fx, options = {}) {
  const scopeRefs = await Promise.all((options.paths ?? ["scan"]).map(path => commandScope(fx, path)));
  return {
    requestId: options.requestId ?? "sc-slice3-target",
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: {
        kind: "cli.command-search-scope",
        scopeRefs,
        fileFilter: options.fileFilter ?? { suffix: ".txt" },
        ignorePolicy: "no_ignore",
      },
      requirement: {
        kind: "matches_target",
        cardinality: options.cardinality ?? "all",
        followUpRead: options.followUpRead ?? null,
      },
    },
  };
}

async function runCommandSearch(fx, request, options = {}) {
  return runCliCommandSearchGoal(request, {
    sandbox: fx.sandbox,
    session: fx.session,
    l2Model: options.model ?? model,
    ...(options.explicitLimits === undefined ? {} : { explicitLimits: options.explicitLimits }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
  });
}

function assertRdeaTraceStep(step) {
  assert.equal(step.R.s0.features.length, 14);
  assert.equal(step.E.features.length, 19);
  if (step.D !== null) assert.equal(step.D.features.length, 26);
  if (step.A !== null) assert.equal(step.A.features.length, 6);
}

test("Slice 3 T1 public entry runs real literal one/all and target one/all through the sandbox", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t1",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/deep", kind: "directory" },
      { path: "scan/amber.txt", kind: "file", contents: "alpha\nneedle here\n" },
      { path: "scan/deep/report.md", kind: "file", contents: "needle deep\n" },
    ],
  });

  const literalAll = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, { requestId: "sc-t1-literal-all", cardinality: "all" }),
  );
  assert.equal(literalAll.domain.status, "achieved");
  assert.equal(literalAll.domain.resolution, "matched");
  assert.equal(literalAll.domain.satisfaction, 100);
  assert.equal(literalAll.domain.coverage, "complete");
  assert.equal(literalAll.domain.searchCommandSpawns, 1);
  assert.equal(literalAll.domain.probeCommandSpawns, 0);
  assert.deepEqual([...literalAll.domain.matchedEntries], ["amber.txt", "deep/report.md"]);
  assert.ok(literalAll.domain.stepTrace.length > 0);
  literalAll.domain.stepTrace.forEach(assertRdeaTraceStep);

  const literalOne = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, { requestId: "sc-t1-literal-one", cardinality: "one" }),
  );
  assert.equal(literalOne.domain.status, "achieved");
  assert.equal(literalOne.domain.resolution, "matched");
  assert.equal(literalOne.domain.satisfaction, 100);
  assert.equal(literalOne.domain.searchCommandSpawns, 1);

  const targetAll = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, { requestId: "sc-t1-target-all", cardinality: "all" }),
  );
  assert.equal(targetAll.domain.status, "achieved");
  assert.equal(targetAll.domain.resolution, "matched");
  assert.equal(targetAll.domain.satisfaction, 100);
  assert.equal(targetAll.domain.searchCommandSpawns, 1);

  const targetOne = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, { requestId: "sc-t1-target-one", cardinality: "one" }),
  );
  assert.equal(targetOne.domain.status, "achieved");
  assert.equal(targetOne.domain.resolution, "matched");
  assert.equal(targetOne.domain.satisfaction, 100);
  assert.equal(targetOne.domain.searchCommandSpawns, 1);

  await assert.rejects(
    runCliCommandSearchGoal(
      await commandLiteralRequest(fx, { requestId: "sc-t1-no-model", cardinality: "one" }),
      { sandbox: fx.sandbox, session: fx.session },
    ),
    TypeError,
  );

  const forged = {
    kind: "cli.directory",
    scenarioId: fx.scenarioId,
    sessionId: "s",
    path: "not-issued-by-sandbox",
  };
  const forgedResult = await runCliCommandSearchGoal(
    {
      requestId: "sc-t1-forged",
      goal: {
        kind: "file.property",
        property: "file.property.content.bytes",
        target: {
          kind: "cli.command-search-scope",
          scopeRefs: [forged],
          fileFilter: null,
          ignorePolicy: "no_ignore",
        },
        requirement: {
          kind: "contains_literal",
          queryLiteral: "needle",
          cardinality: "one",
        },
      },
    },
    { sandbox: fx.sandbox, session: fx.session, l2Model: model },
  );
  assert.equal(forgedResult.domain.status, "rejected");
  assert.equal(forgedResult.domain.resolution, "rejected");
  assert.equal(forgedResult.domain.totalProcessSpawns, 0);
});

test("Slice 3 T2 target hit binds a trusted file and performs controlled line and byte reads", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t2",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/note.txt", kind: "file", contents: "first line\nsecond line\n" },
    ],
  });

  const lines = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, {
      requestId: "sc-t2-lines",
      cardinality: "one",
      fileFilter: { exactBasename: "note.txt" },
      followUpRead: { mode: "lines", anchor: "head", count: 1 },
    }),
  );
  assert.equal(lines.domain.status, "achieved");
  assert.equal(lines.domain.resolution, "matched");
  assert.equal(lines.domain.satisfaction, 100);
  assert.equal(lines.domain.issuedRefs.length, 1);
  assert.equal(lines.domain.readReceipt?.operation, "file.read.lines");
  assert.equal(lines.domain.readReceipt?.logicalLines, 1);
  assert.equal(
    Buffer.from(lines.domain.readReceipt?.bytesBase64 ?? "", "base64").toString("utf8"),
    "first line\n",
  );
  assert.ok(lines.domain.stepTrace.some(step => step.D?.predictedLabel === "READ_TARGET_S0"));
  const lineReadStep = lines.domain.stepTrace.findLast(
    step => step.commandReceipt === null && step.E.namedFeatures["receipt.present"] === 1,
  );
  assert.ok(lineReadStep);
  assert.equal(lineReadStep.E.namedFeatures["goal.head"], 1);
  assert.equal(lineReadStep.E.namedFeatures["goal.tail"], 0);
  assert.equal(lineReadStep.E.namedFeatures["goal.N/16"], 1 / 16);
  assert.equal(lineReadStep.E.namedFeatures["actual.head"], 1);
  assert.equal(lineReadStep.E.namedFeatures["actual.tail"], 0);
  assert.equal(lineReadStep.E.namedFeatures["output.linesKnown"], 1);
  assert.equal(lineReadStep.E.namedFeatures["output.logicalLines/16"], 1 / 16);
  assert.equal(lineReadStep.E.namedFeatures["actual.N/16"], 1 / 16);
  assert.equal(lineReadStep.D?.namedFeatures["read.fromS0"], 1);
  assert.equal(lineReadStep.D?.namedFeatures["read.fromS1"], 0);

  const tail = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, {
      requestId: "sc-t2-lines-tail",
      cardinality: "one",
      fileFilter: { exactBasename: "note.txt" },
      followUpRead: { mode: "lines", anchor: "tail", count: 2 },
    }),
  );
  assert.equal(tail.domain.status, "achieved");
  const tailReadStep = tail.domain.stepTrace.findLast(
    step => step.commandReceipt === null && step.E.namedFeatures["receipt.present"] === 1,
  );
  assert.ok(tailReadStep);
  assert.equal(tailReadStep.E.namedFeatures["goal.head"], 0);
  assert.equal(tailReadStep.E.namedFeatures["goal.tail"], 1);
  assert.equal(tailReadStep.E.namedFeatures["goal.N/16"], 2 / 16);
  assert.equal(tailReadStep.E.namedFeatures["actual.head"], 0);
  assert.equal(tailReadStep.E.namedFeatures["actual.tail"], 1);
  assert.equal(tailReadStep.E.namedFeatures["output.linesKnown"], 1);
  assert.equal(tailReadStep.E.namedFeatures["output.logicalLines/16"], 2 / 16);
  assert.equal(tailReadStep.E.namedFeatures["actual.N/16"], 2 / 16);

  const bytes = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, {
      requestId: "sc-t2-bytes",
      cardinality: "one",
      fileFilter: { exactBasename: "note.txt" },
      followUpRead: { mode: "bytes", offset: 0, length: 5 },
    }),
  );
  assert.equal(bytes.domain.status, "achieved");
  assert.equal(bytes.domain.resolution, "matched");
  assert.equal(bytes.domain.readReceipt?.operation, "file.read");
  assert.equal(
    Buffer.from(bytes.domain.readReceipt?.bytesBase64 ?? "", "base64").toString("utf8"),
    "first",
  );
  const byteReadStep = bytes.domain.stepTrace.findLast(
    step => step.commandReceipt === null && step.E.namedFeatures["receipt.present"] === 1,
  );
  assert.ok(byteReadStep);
  assert.equal(byteReadStep.E.namedFeatures["goal.head"], 0);
  assert.equal(byteReadStep.E.namedFeatures["goal.tail"], 0);
  assert.equal(byteReadStep.E.namedFeatures["goal.N/16"], 0);
  assert.equal(byteReadStep.E.namedFeatures["actual.head"], 0);
  assert.equal(byteReadStep.E.namedFeatures["actual.tail"], 0);
  assert.equal(byteReadStep.E.namedFeatures["output.linesKnown"], 0);
  assert.equal(byteReadStep.E.namedFeatures["output.logicalLines/16"], 0);
  assert.equal(byteReadStep.E.namedFeatures["actual.N/16"], 0);
  assert.equal(byteReadStep.D?.namedFeatures["read.fromS0"], 1);
  assert.equal(byteReadStep.D?.namedFeatures["read.fromS1"], 0);
});

test("Slice 3 T3 complete negative search terminates unmet and never reports a false success", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t3",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/deep", kind: "directory" },
      { path: "scan/alpha.txt", kind: "file", contents: "alpha\nbeta\n" },
      { path: "scan/deep/gamma.txt", kind: "file", contents: "gamma\n" },
    ],
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t3-negative",
      needle: "not-present-anywhere",
      cardinality: "all",
    }),
  );
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "not_found");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.coverage, "complete");
  assert.equal(result.domain.searchCommandSpawns, 1);
  assert.deepEqual([...result.domain.matchedEntries], []);
  assert.ok(result.domain.reasons.includes("no_matching_entries"));
  assert.equal(result.response.report.rootEvaluation.result, "unsatisfied");
  // The unmet verdict is derivation-closed trusted evidence, not a masked
  // execution failure: the controller ended in "error" on a
  // precondition_unsatisfied diagnostic whose source.category is
  // "derivation_closed", and no execution/observation/effect failure code is
  // present. The projection must keep reporting unmet/not_found, not failed.
  assert.equal(result.domain.preserve.control.outcome, "error");
  const errors = result.domain.preserve.errors;
  const primary =
    errors.find(error => error.errorId === result.domain.preserve.primaryErrorId) ?? errors[0];
  assert.equal(primary.code, "precondition_unsatisfied");
  assert.equal(primary.source.category, "derivation_closed");
  const codes = errors.map(error => error.code);
  for (const forbidden of ["execution_failed", "evidence_unavailable", "effect_denied"]) {
    assert.equal(codes.includes(forbidden), false);
  }
});

test("Slice 3 T4 dual-slot one uses ordered fallback and early-stops without scanning s1", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t4",
    entries: [
      { path: "primary", kind: "directory" },
      { path: "fallback", kind: "directory" },
      { path: "primary/alpha.txt", kind: "file", contents: "ordinary\n" },
      { path: "fallback/hit.txt", kind: "file", contents: "needle fallback\n" },
    ],
  });

  const fallback = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t4-fallback",
      paths: ["primary", "fallback"],
      cardinality: "one",
    }),
  );
  assert.equal(fallback.domain.status, "achieved");
  assert.equal(fallback.domain.resolution, "matched");
  assert.equal(fallback.domain.satisfaction, 100);
  assert.equal(fallback.domain.coverage, "complete");
  assert.equal(fallback.domain.searchCommandSpawns, 2);
  const labels = fallback.domain.stepTrace.map(step => step.D?.predictedLabel);
  assert.ok(labels.includes("SEARCH_LITERAL_S0"));
  assert.ok(labels.includes("SEARCH_LITERAL_S1"));
  assert.ok(labels.includes("RETURN_RESULT"));

  const early = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t4-early-stop",
      paths: ["fallback", "primary"],
      cardinality: "one",
    }),
  );
  assert.equal(early.domain.status, "achieved");
  assert.equal(early.domain.resolution, "matched");
  assert.equal(early.domain.satisfaction, 100);
  assert.equal(early.domain.coverage, "partial");
  assert.ok(early.domain.reasons.includes("unsearched_fallback_scope_early_stop"));
  assert.equal(early.domain.searchCommandSpawns, 1);
});

test("Slice 3 T5 public domain reports frozen model metadata without digest identity fields", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t5",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/note.txt", kind: "file", contents: "needle\n" },
    ],
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, { requestId: "sc-t5-metadata", cardinality: "one" }),
  );
  assert.deepEqual(result.domain.modelMetadata.ref, DEFAULT_CLI_HYBRID_SEARCH_REF);
  assert.equal(result.domain.modelMetadata.schema, "cli.hybrid-package.v1");
  assert.equal(result.domain.modelMetadata.calibration, "uncalibrated");
  assert.equal(result.domain.modelMetadata.adoption, "not_applied");
  for (const key of ["hash", "digest", "sha256", "checksum"]) {
    assert.equal(Object.hasOwn(result.domain.modelMetadata, key), false);
    assert.equal(Object.hasOwn(result.domain.modelMetadata.ref, key), false);
  }
});

test("Slice 3 T6 budget continuation resumes at s1 and rejects a different model ref", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t6",
    entries: [
      { path: "primary", kind: "directory" },
      { path: "fallback", kind: "directory" },
      { path: "primary/alpha.txt", kind: "file", contents: "ordinary\n" },
      { path: "fallback/hit.txt", kind: "file", contents: "needle fallback\n" },
    ],
  });
  const request = await commandLiteralRequest(fx, {
    requestId: "sc-t6-continuation",
    paths: ["primary", "fallback"],
    cardinality: "one",
  });
  const first = await runCommandSearch(fx, request, {
    limits: { maxTransitions: 6, maxDepth: 8, maxDerivedGoals: 4 },
  });
  assert.equal(first.domain.status, "unknown");
  assert.equal(first.domain.resolution, "budget_exhausted");
  assert.equal(first.domain.satisfaction, null);
  assert.equal(first.domain.searchCommandSpawns, 1);
  assert.notEqual(first.domain.preserve.continuation, null);

  const second = await runCommandSearch(fx, request, {
    continuation: first.domain.preserve.continuation,
  });
  assert.equal(second.domain.status, "achieved");
  assert.equal(second.domain.resolution, "matched");
  assert.equal(second.domain.satisfaction, 100);
  assert.equal(second.domain.searchCommandSpawns, 2);
  assert.equal(second.domain.preserve.continuation, null);
  assert.ok(
    second.response.report.budgetUsed.transitionsUsed
      > first.response.report.budgetUsed.transitionsUsed,
  );
  assert.ok(second.domain.stepTrace.some(step => step.D?.predictedLabel === "SEARCH_LITERAL_S1"));

  const mismatched = await runCliCommandSearchGoal(
    { ...request, requestId: "sc-t6-continuation-other" },
    {
      sandbox: fx.sandbox,
      session: fx.session,
      l2Model: {
        ...model,
        ref: { id: "cli.hybrid-search", version: "other" },
      },
      continuation: first.domain.preserve.continuation,
    },
  );
  assert.equal(mismatched.domain.status, "rejected");
  assert.equal(mismatched.domain.resolution, "rejected");
});

test("Slice 3 T7 rejects multi-scope cardinality all at the public boundary", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t7",
    entries: [
      { path: "primary", kind: "directory" },
      { path: "fallback", kind: "directory" },
    ],
  });
  await assert.rejects(
    runCommandSearch(
      fx,
      await commandLiteralRequest(fx, {
        requestId: "sc-t7-no-multi-all",
        paths: ["primary", "fallback"],
        cardinality: "all",
      }),
    ),
    /multi-scope cardinality all/,
  );
});

test("Slice 3 T7a truncated zero-hit literal search projects unknown insufficient_evidence", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t7a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/big.txt", kind: "file", contents: `${"x".repeat(5000)}\n` },
    ],
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t7a-truncated-empty",
      needle: "needle",
      cardinality: "all",
    }),
    { explicitLimits: { maxStdoutBytes: 64 } },
  );
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "insufficient_evidence");
  assert.equal(d.satisfaction, null);
  assert.equal(d.coverage, "partial");
  assert.ok(d.reasons.includes("stdout_max_bytes_exceeded"));
  assert.deepEqual([...d.matchedEntries], []);
  assert.equal(d.totalProcessSpawns, 1);
});

test("Slice 3 T7b truncated literal search with an existing hit projects unknown partial", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t7b",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/hits.txt", kind: "file", contents: `${Array.from({ length: 100 }, () => "needle").join("\n")}\n` },
    ],
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t7b-truncated-hit",
      needle: "needle",
      cardinality: "all",
    }),
    { explicitLimits: { maxStdoutBytes: 256 } },
  );
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "partial");
  assert.equal(d.satisfaction, null);
  assert.equal(d.coverage, "partial");
  assert.ok(d.reasons.includes("stdout_max_bytes_exceeded"));
  assert.ok(d.matchedEntries.length > 0);
  assert.equal(d.totalProcessSpawns, 1);
});

test("Slice 3 T2a a session without process.exec is rejected before any spawn", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t2a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/a.txt", kind: "file", contents: "needle\n" },
    ],
    sessions: [{ id: "s", cwd: ".", grantedEffects: ["filesystem.read"] }],
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-t2a-no-exec",
      needle: "needle",
      cardinality: "one",
    }),
  );
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.resolution, "rejected");
  assert.equal(result.domain.totalProcessSpawns, 0);
});

test("Slice 3 T2b a final directory symlink is rejected with native FINAL_SYMLINK and no spawn", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t2b",
    entries: [
      { path: "real", kind: "directory" },
      { path: "real/a.txt", kind: "file", contents: "needle\n" },
    ],
  });
  await symlink(join(fx.sandbox.scenarioRoot, "real"), join(fx.sandbox.scenarioRoot, "scan-link"));
  const scope = await fx.sandbox.bindDirectory(fx.session, "scan-link");
  const request = {
    requestId: "sc-t2b-final-symlink",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.command-search-scope",
        scopeRefs: [scope],
        fileFilter: null,
        ignorePolicy: "no_ignore",
      },
      requirement: { kind: "contains_literal", queryLiteral: "needle", cardinality: "one" },
    },
  };
  const result = await runCommandSearch(fx, request);
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.resolution, "rejected");
  assert.equal(result.domain.totalProcessSpawns, 0);
  const nativeCodes = result.domain.preserve.errors.map(error => error.source?.nativeCode).filter(Boolean);
  assert.ok(nativeCodes.includes("FINAL_SYMLINK"), `expected FINAL_SYMLINK, got ${JSON.stringify(nativeCodes)}`);
});

test("Slice 3 T5b a fallback slot hit binds and reads through READ_TARGET_S1", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-slice3-t5b",
    entries: [
      { path: "primary", kind: "directory" },
      { path: "fallback", kind: "directory" },
      { path: "primary/alpha.md", kind: "file", contents: "ordinary\n" },
      { path: "fallback/hit.txt", kind: "file", contents: "target line one\ntarget line two\n" },
    ],
  });
  const result = await runCommandSearch(
    fx,
    await commandTargetRequest(fx, {
      requestId: "sc-t5b-read-s1",
      paths: ["primary", "fallback"],
      cardinality: "one",
      fileFilter: { suffix: ".txt" },
      followUpRead: { mode: "lines", anchor: "head", count: 1 },
    }),
  );
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.satisfaction, 100);
  assert.ok(d.stepTrace.some(step => step.D?.predictedLabel === "READ_TARGET_S1"));
  assert.equal(d.readReceipt?.slot, "s1");
  assert.equal(d.readReceipt?.operation, "file.read.lines");
  assert.equal(d.issuedRefs.length, 1);
  assert.equal(d.searchCommandSpawns, 2);
  assert.equal(
    Buffer.from(d.readReceipt?.bytesBase64 ?? "", "base64").toString("utf8"),
    "target line one\n",
  );
  const readStep = d.stepTrace.findLast(
    step => step.commandReceipt === null && step.E.namedFeatures["receipt.present"] === 1,
  );
  assert.ok(readStep);
  assert.equal(readStep.D?.namedFeatures["read.fromS0"], 0);
  assert.equal(readStep.D?.namedFeatures["read.fromS1"], 1);
});

test("RED F3 public grep maxDepth refuses a deep-only hit before spawning", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-red-f3-public",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/deep", kind: "directory" },
      { path: "scan/deep/hit.txt", kind: "file", contents: "needle deep\n" },
    ],
    commandSearchCapabilities: {
      rg: null,
      grep: "/usr/bin/grep",
      grepFlavor: "bsd",
      find: null,
    },
  });
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-red-f3-public",
      needle: "needle",
      cardinality: "all",
    }),
    { explicitLimits: { maxDepth: 0 } },
  );
  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.resolution, "failed");
  assert.equal(result.domain.totalProcessSpawns, 0);
  assert.deepEqual([...result.domain.matchedEntries], []);
  const nativeCodes = result.domain.preserve.errors
    .map(error => error.source?.nativeCode)
    .filter(Boolean);
  assert.ok(nativeCodes.includes("UNSUPPORTED_GREP_MAX_DEPTH"));
});

test("RED F5 real rg invalid line bytes never fabricate an empty match line", async t => {
  const fx = await commandSearchFixture(t, {
    scenarioId: "sc-red-f5-line",
    entries: [{ path: "scan", kind: "directory" }],
  });
  await writeFile(
    join(fx.sandbox.scenarioRoot, "scan", "invalid.txt"),
    Buffer.concat([Buffer.from("needle ", "utf8"), Buffer.from([0xff]), Buffer.from("\n", "utf8")]),
  );
  const result = await runCommandSearch(
    fx,
    await commandLiteralRequest(fx, {
      requestId: "sc-red-f5-line",
      needle: "needle",
      cardinality: "all",
    }),
  );
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "partial");
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.searchCommandSpawns, 1);
  assert.deepEqual([...result.domain.matchedEntries], ["invalid.txt"]);
  assert.deepEqual([...result.domain.matchedLines], []);
  assert.ok(result.domain.reasons.includes("unrepresentable_byte_record"));
});

for (const maxTransitions of [3, 4, 5]) {
  test(`RED F1 continuation resumes a pre-dispatch pause at ${maxTransitions} transitions`, async t => {
    const fx = await commandSearchFixture(t, {
      scenarioId: `sc-red-f1-${maxTransitions}`,
      entries: [
        { path: "primary", kind: "directory" },
        { path: "fallback", kind: "directory" },
        { path: "primary/alpha.txt", kind: "file", contents: "ordinary\n" },
        { path: "fallback/hit.txt", kind: "file", contents: "needle fallback\n" },
      ],
    });
    const request = await commandLiteralRequest(fx, {
      requestId: `sc-red-f1-${maxTransitions}`,
      paths: ["primary", "fallback"],
      cardinality: "one",
    });
    // A tight transition budget stops after deriving the s0 child, before dispatch.
    const first = await runCommandSearch(fx, request, {
      limits: { maxTransitions, maxDepth: 8, maxDerivedGoals: 4 },
    });
    assert.equal(first.domain.status, "unknown");
    assert.equal(first.domain.resolution, "budget_exhausted");
    assert.equal(first.domain.searchCommandSpawns, 0);
    assert.notEqual(first.domain.preserve.continuation, null);
    const second = await runCommandSearch(fx, request, {
      continuation: first.domain.preserve.continuation,
    });
    assert.equal(second.domain.status, "achieved");
    assert.equal(second.domain.resolution, "matched");
    assert.equal(second.domain.satisfaction, 100);
    // Resume must run s0 then s1 exactly once each, not repeat a dispatched search.
    assert.equal(second.domain.searchCommandSpawns, 2);
    assert.equal(second.domain.preserve.continuation, null);
  });
}
