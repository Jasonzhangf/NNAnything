import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const api = () => import("../dist/cli-goal.js");

async function fixture(t, extraEntries = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-file-property-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apiModule = await api();
  const sandbox = await apiModule.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "file-property",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/child", kind: "directory" },
        { path: "start/child/item.txt", kind: "file", contents: "opaque" },
        { path: "target", kind: "directory" },
        { path: "target/.hidden", kind: "file", contents: "opaque" },
        ...extraEntries,
      ],
      sessions: [{
        id: "s",
        cwd: "start",
        grantedEffects: ["filesystem.read", "process.exec", "session.write"],
      }],
    },
  });
  t.after(() => sandbox.cleanup());
  return { root, sandbox, session: sandbox.bindSession("s") };
}

function forceHead(profile, head) {
  const index = profile.heads.indexOf(head);
  assert.notEqual(index, -1, `missing head ${head}`);
  return {
    ...profile,
    weights: profile.weights.map((row, rowIndex) =>
      row.map((weight, columnIndex) => rowIndex === index && columnIndex === 0 ? 1 : weight)),
  };
}

function mutableProfile(profile) {
  return { ...profile, weights: profile.weights.map(row => [...row]) };
}

function setWeight(profile, head, wire, value) {
  const row = profile.heads.indexOf(head);
  const column = profile.wires.indexOf(wire);
  assert.notEqual(row, -1, `missing head ${head}`);
  assert.notEqual(column, -1, `missing wire ${wire}`);
  profile.weights[row][column] = value;
}

function witnessProfile(module, head) {
  const profile = module.zeroCliCommandProfile();
  const row = profile.heads.indexOf(head);
  if (row < 0) return profile;
  return {
    ...profile,
    weights: profile.weights.map((weights, index) =>
      index === row ? weights.map((weight, column) => column === 0 ? 10 : weight) : [...weights]),
  };
}

function pathRef(sandbox, session, path) {
  return Object.freeze({
    kind: "cli.path",
    scenarioId: sandbox.scenarioId,
    sessionId: session.sessionId,
    path,
  });
}

function emptyState(session) {
  return { session: session.sessionId, cwdObservation: null, directoryListing: null };
}

function observedPathValue(result, key) {
  const knowledge = result?.observed_state_after?.pathKnowledge ?? {};
  const aliases = { absolute: "absolutePath", relative: "relativePath" };
  const resolvedKey = aliases[key] ?? key;
  return knowledge[resolvedKey] ?? knowledge.value?.[resolvedKey]
    ?? result?.evidence?.[resolvedKey] ?? result?.evidence?.value?.[resolvedKey];
}

const TEN_HEADS = [
  "unsupported", "DEFER", "NOOP", "pwd", "cd", "ls",
  "path.resolve", "path.relative", "path.parts", "entry.inspect",
];
const THIRTY_ONE_WIRES = [
  "bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory",
  "property.path.absolute", "property.path.relative", "property.path.parent", "property.path.name",
  "property.exists", "property.type", "property.directory.entries", "property.size",
  "property.mode", "property.owner", "property.times", "property.link.target",
  "property.entry.identity", "property.relation.sessionCwd",
  "predicate.observe.absolute", "predicate.observe.relative", "predicate.observe.parts",
  "predicate.observe.inspect", "predicate.observe.sessionCwd", "predicate.equals.sessionCwd",
  "predicate.observe.entries",
  "state.hasFreshEvidence", "state.knownValue", "state.requiredConditionHolds", "state.hasDestinationRef",
  "search.nameNeedleSegment",
  "state.requiredConditionHolds*state.hasFreshEvidence",
];
const SIX_HEADS = ["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"];
const FOURTEEN_WIRES = [
  "bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory",
  "property.directory.entries", "property.relation.sessionCwd",
  "predicate.observe.sessionCwd", "predicate.equals.sessionCwd", "predicate.observe.entries",
  "state.hasFreshEvidence", "state.knownValue", "state.requiredConditionHolds",
  "state.hasDestinationRef", "state.requiredConditionHolds*state.hasFreshEvidence",
];

function cwdQuery(session) {
  return { kind: "cli.file-query", relation: "sessionCwd", session };
}

function directoryQuery(name = "child") {
  return {
    kind: "cli.file-query",
    relation: "entrySelector",
    scopes: [],
    selector: { type: "directory", name },
    cardinality: "one",
  };
}

test("R01 profile registers ten shared heads, thirty-one ordered wires and a 10x31 matrix", async () => {
  const module = await api();
  const profile = module.zeroCliCommandProfile();
  assert.deepEqual(profile.heads, TEN_HEADS);
  assert.deepEqual(profile.properties, [
    "property.path.absolute", "property.path.relative", "property.path.parent", "property.path.name",
    "property.exists", "property.type", "property.directory.entries", "property.size",
    "property.mode", "property.owner", "property.times", "property.link.target",
    "property.entry.identity", "property.relation.sessionCwd",
  ]);
  assert.deepEqual(profile.predicates, [
    "predicate.observe.absolute", "predicate.observe.relative", "predicate.observe.parts",
    "predicate.observe.inspect", "predicate.observe.sessionCwd", "predicate.equals.sessionCwd",
    "predicate.observe.entries",
  ]);
  assert.deepEqual(profile.wires, THIRTY_ONE_WIRES);
  assert.equal(profile.weights.length, 10);
  assert.equal(profile.weights.every(row => row.length === 31), true);
  assert.equal(profile.weights.flat().length, 310);
});

test("legacy four-by-four migration copies its named cross block into the current schema", async () => {
  const { migrateLegacyCliCommandProfile } = await api();
  const legacy = {
    contract: "cli.command-policy.v1",
    heads: ["unsupported", "pwd", "cd", "ls"],
    wires: ["bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory"],
    weights: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ],
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  const migrated = migrateLegacyCliCommandProfile(legacy);
  assert.deepEqual(migrated.heads, TEN_HEADS);
  assert.deepEqual(migrated.wires, THIRTY_ONE_WIRES);
  const legacyHeads = ["unsupported", "pwd", "cd", "ls"];
  const legacyWires = ["bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory"];
  for (const [legacyRow, head] of legacyHeads.entries()) {
    const row = migrated.heads.indexOf(head);
    for (const [legacyColumn, wire] of legacyWires.entries()) {
      const column = migrated.wires.indexOf(wire);
      assert.equal(migrated.weights[row][column], legacy.weights[legacyRow][legacyColumn], `${head}/${wire} changed by name`);
    }
  }
  for (const head of ["DEFER", "NOOP"]) {
    assert.deepEqual(migrated.weights[migrated.heads.indexOf(head)].slice(0, 4), [0, 0, 0, 0]);
  }
  for (const head of TEN_HEADS) {
    const row = migrated.weights[migrated.heads.indexOf(head)];
    for (const [column, wire] of THIRTY_ONE_WIRES.entries()) {
      if (!legacyHeads.includes(head) || !legacyWires.includes(wire)) assert.equal(row[column], 0, `${head}/${wire} must be zero-filled`);
    }
  }
});

test("legacy Goal kinds and old 4x4 runtime profiles are rejected before OS effects", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const profile = forceHead(zeroCliCommandProfile(), "pwd");
  await assert.rejects(
    createCliCommandPolicy({ profile, sandbox, session }).step({
      goal: { kind: "observe_cwd", session: "s" },
      satisfactionThreshold: 100,
      state: { session: "s", cwdObservation: null, directoryListing: null },
    }),
    error => error instanceof TypeError && /Legacy|file\.property|goal/i.test(error.message),
  );
  const oldProfile = {
    contract: "cli.command-policy.v1",
    heads: ["unsupported", "pwd", "cd", "ls"],
    wires: ["bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory"],
    weights: Array.from({ length: 4 }, () => Array(4).fill(0)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  assert.throws(() => createCliCommandPolicy({ profile: oldProfile, sandbox, session }), /profile/);
});

test("typed sessionCwd observation executes real pwd and binds current evidence", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session, root } = await fixture(t);
  const profile = forceHead(zeroCliCommandProfile(), "pwd");
  const policy = createCliCommandPolicy({ profile, sandbox, session });
  const before = sandbox.getSession(session);
  const result = await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: cwdQuery(session),
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.status, "achieved");
  assert.equal(result.satisfaction, 100);
  assert.deepEqual(result.invocation, ["pwd"]);
  assert.equal(result.execution_result.executorInvoked, true);
  assert.equal(result.observed_state_after.cwdObservation.physicalCwd, await realpath(join(sandbox.scenarioRoot, "start")));
  assert.equal(typeof result.observed_state_after.cwdObservation.sourceRun, "string");
  assert.deepEqual(sandbox.getSession(session), before);
});

test("equals uses applicable fresh evidence for NOOP, but stale or unequal evidence still executes cd", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const policy = createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "pwd"), sandbox, session });
  const pwdGoal = {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: cwdQuery(session),
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const state = { session: "s", cwdObservation: null, directoryListing: null };

  const firstPwd = await policy.step({ goal: pwdGoal, satisfactionThreshold: 100, state });
  const targetDirectory = await sandbox.bindDirectory(session, "../target");
  const equalsGoal = {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: cwdQuery(session),
    requirement: { kind: "equals", expected: targetDirectory },
  };

  const unequal = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "cd"), sandbox, session }).step({
    goal: equalsGoal, satisfactionThreshold: 100, state: firstPwd.observed_state_after,
  });
  assert.equal(unequal.status, "achieved");
  assert.equal(unequal.invocation[0], "cd");
  assert.equal(unequal.session_after.cwd, await realpath(join(sandbox.scenarioRoot, "target")));

  const noopProfile = mutableProfile(zeroCliCommandProfile());
  setWeight(noopProfile, "pwd", "goalObserveCwd", 1);
  setWeight(noopProfile, "NOOP", "state.hasFreshEvidence", 10);
  setWeight(noopProfile, "NOOP", "state.requiredConditionHolds*state.hasFreshEvidence", 10);
  const equalPolicy = createCliCommandPolicy({ profile: noopProfile, sandbox, session });
  const afterCd = await equalPolicy.step({ goal: pwdGoal, satisfactionThreshold: 100, state });
  const atTarget = await sandbox.bindDirectory(session, ".");
  const equalGoal = { ...equalsGoal, requirement: { kind: "equals", expected: atTarget } };
  const noop = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "NOOP"), sandbox, session }).step({
    goal: equalGoal, satisfactionThreshold: 100, state: afterCd.observed_state_after,
  });
  assert.equal(noop.status, "rejected", "a foreign policy cannot trust another policy's receipts");

  const samePolicyNoop = await equalPolicy.step({
    goal: equalGoal,
    satisfactionThreshold: 100,
    state: afterCd.observed_state_after,
  });
  assert.equal(samePolicyNoop.policy.selectedHead, "NOOP");
  assert.equal(samePolicyNoop.policy_error, null);
  assert.equal(samePolicyNoop.status, "achieved");
  assert.equal(samePolicyNoop.satisfaction, 100);
  assert.equal(samePolicyNoop.invocation, null);
  assert.equal(samePolicyNoop.execution_result.executorInvoked, false);
});

test("stale authentic equality stays known and condition-true while freshness remains false", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const profile = mutableProfile(zeroCliCommandProfile());
  setWeight(profile, "pwd", "goalObserveCwd", 10);
  setWeight(profile, "cd", "goalSetCwd", 10);
  const policy = createCliCommandPolicy({ profile, sandbox, session });
  const state = { session: "s", cwdObservation: null, directoryListing: null };
  const cwdGoal = {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: cwdQuery(session),
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const observed = await policy.step({ goal: cwdGoal, satisfactionThreshold: 100, state });
  const startPhysical = sandbox.getSession(session).cwd;
  const target = await sandbox.bindDirectory(session, "../target");
  const moved = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory: target } });
  assert.equal(moved.execution.status, "succeeded");
  const targetPhysical = sandbox.getSession(session).cwd;
  const start = await sandbox.bindDirectory(session, relative(targetPhysical, startPhysical) || ".");
  const transition = await policy.step({
    goal: { ...cwdGoal, requirement: { kind: "equals", expected: start } },
    satisfactionThreshold: 100,
    state: observed.observed_state_after,
  });
  assert.deepEqual(transition.evidence.facts, {
    hasFreshEvidence: 0,
    knownValue: 1,
    requiredConditionHolds: 1,
    hasDestinationRef: 1,
  });
  assert.equal(transition.invocation[0], "cd");
});

test("receipt-backed authority rejects embedded evidence changes that preserve the outer summary", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const profile = mutableProfile(zeroCliCommandProfile());
  setWeight(profile, "pwd", "goalObserveCwd", 1);
  setWeight(profile, "NOOP", "state.hasFreshEvidence", 10);
  setWeight(profile, "NOOP", "state.requiredConditionHolds*state.hasFreshEvidence", 10);
  const policy = createCliCommandPolicy({ profile, sandbox, session });
  const state = { session: "s", cwdObservation: null, directoryListing: null };
  const cwdGoal = {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: cwdQuery(session),
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const observed = await policy.step({ goal: cwdGoal, satisfactionThreshold: 100, state });
  const start = await sandbox.bindDirectory(session, ".");
  const equalsGoal = { ...cwdGoal, requirement: { kind: "equals", expected: start } };
  const targetPhysical = await realpath(join(sandbox.scenarioRoot, "target"));

  const changedPhysical = structuredClone(observed.observed_state_after);
  changedPhysical.cwdObservation.evidence.physicalCwd = targetPhysical;
  changedPhysical.cwdObservation.evidence.stdout = `${targetPhysical}\n`;
  await assert.rejects(
    policy.step({ goal: equalsGoal, satisfactionThreshold: 100, state: changedPhysical }),
    error => error instanceof TypeError && /evidence|physicalCwd/i.test(error.message),
  );

  const changedConfigured = structuredClone(observed.observed_state_after);
  changedConfigured.cwdObservation.evidence.configuredCwd = targetPhysical;
  const configuredResult = await policy.step({
    goal: equalsGoal,
    satisfactionThreshold: 100,
    state: changedConfigured,
  });
  assert.notEqual(configuredResult.status, "achieved");
  assert.notEqual(configuredResult.satisfaction, 100);
  assert.equal(configuredResult.invocation, null);
  assert.equal(configuredResult.execution_result.executorInvoked, false);
  assert.equal(configuredResult.evidence.facts.knownValue, 0);
  assert.equal(configuredResult.evidence.facts.hasFreshEvidence, 0);
});

test("valid unbound DirectoryQuery returns typed DEFER with zero executor", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const before = sandbox.getSession(session);
  const result = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "DEFER"), sandbox, session }).step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: cwdQuery(session),
      requirement: { kind: "equals", expected: directoryQuery() },
    },
    satisfactionThreshold: 0,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.invocation, null);
  assert.equal(result.execution_result.executorInvoked, false);
  assert.equal(result.defer.code, "binding_unresolved");
  assert.deepEqual(sandbox.getSession(session), before);
});

test("guard rejects a wrong executable head and preserves policy_error without substitution", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const before = sandbox.getSession(session);
  const result = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "cd"), sandbox, session }).step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: cwdQuery(session),
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.policy.selectedHead, "cd");
  assert.deepEqual(result.policy_error, { expectedHead: "pwd", selectedHead: "cd" });
  assert.equal(result.execution_result.executorInvoked, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.satisfaction, 0);
  assert.deepEqual(sandbox.getSession(session), before);
});

test("structurally valid unregistered property returns unsupported and null satisfaction", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const result = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "unsupported"), sandbox, session }).step({
    goal: {
      kind: "file.property",
      property: "file.property.exists",
      target: { kind: "cli.directory", scenarioId: "file-property", sessionId: "s", path: "." },
      requirement: { kind: "equals", expected: true },
    },
    satisfactionThreshold: 100,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.execution_result.status, "unsupported");
  assert.equal(result.execution_result.executorInvoked, false);
});

test("unregistered property or predicate pair bypasses softmax and returns unsupported", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "entry.inspect"),
    sandbox,
    session,
  });
  const directory = await sandbox.bindDirectory(session, ".");
  const state = emptyState(session);
  const assertUnsupported = result => {
    assert.equal(result.policy.selectedHead, "unsupported");
    assert.deepEqual(result.policy.scores, Array(module.zeroCliCommandProfile().heads.length).fill(0));
    assert.deepEqual(result.policy.probabilities, Array(module.zeroCliCommandProfile().heads.length).fill(0));
    assert.equal(result.policy.features[0], 1);
    assert.equal(result.policy.features.length, module.CLI_COMMAND_WIRES.length);
    assert.equal(result.policy_error, null);
    assert.equal(result.status, "unknown");
    assert.equal(result.satisfaction, null);
    assert.equal(result.invocation, null);
    assert.equal(result.execution_result.status, "unsupported");
    assert.equal(result.execution_result.executorInvoked, false);
  };

  assertUnsupported(await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: directory,
      requirement: { kind: "equals", expected: "opaque" },
    },
    satisfactionThreshold: 100,
    state,
  }));

  assertUnsupported(await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.relative",
      target: {
        kind: "cli.path-query",
        from: pathRef(sandbox, session, "/a"),
        to: pathRef(sandbox, session, "/b"),
      },
      requirement: { kind: "equals", expected: "../b" },
    },
    satisfactionThreshold: 100,
    state,
  }));

  const entriesEquals = module.predictCliCommand({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directory,
    requirement: { kind: "equals", expected: [] },
  }, { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
  module.zeroCliCommandProfile(), false);
  assert.equal(entriesEquals.selectedHead, "unsupported");
  assert.deepEqual(entriesEquals.scores, Array(entriesEquals.scores.length).fill(0));
  assert.deepEqual(entriesEquals.probabilities, Array(entriesEquals.probabilities.length).fill(0));
});

test("unregistered property with a legal DirectoryQuery remains unsupported rather than DEFER", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const before = sandbox.getSession(session);
  const result = await createCliCommandPolicy({ profile: forceHead(zeroCliCommandProfile(), "unsupported"), sandbox, session }).step({
    goal: {
      kind: "file.property",
      property: "file.property.exists",
      target: directoryQuery(),
      requirement: { kind: "equals", expected: true },
    },
    satisfactionThreshold: 100,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "unsupported_property");
  assert.equal(result.satisfaction, null);
  assert.equal(result.policy.selectedHead, "unsupported");
  assert.equal(result.policy_error, null);
  assert.equal(result.execution_result.status, "unsupported");
  assert.equal(result.execution_result.executorInvoked, false);
  assert.equal(result.invocation, null);
  assert.equal(result.defer, null);
  assert.deepEqual(sandbox.getSession(session), before);
});

test("schema, extra answer fields, old goals and cross-session requests reject with TypeError before execution", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  let samples = 0;
  const policy = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "pwd"),
    sandbox,
    session,
    onSample: () => { samples += 1; },
  });
  const state = { session: "s", cwdObservation: null, directoryListing: null };
  const before = sandbox.getSession(session);
  const goal = {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: cwdQuery(session),
    requirement: { kind: "observed", freshness: "this_run" },
  };
  await assert.rejects(policy.step({
    goal,
    state,
  }), TypeError);
  await assert.rejects(policy.step({
    goal: { kind: "observe_cwd", session: "s" },
    satisfactionThreshold: 100,
    state,
  }), TypeError);
  await assert.rejects(policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: { ...cwdQuery(session), path: "/answer" },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state,
  }), TypeError);
  await assert.rejects(policy.step({
    goal,
    satisfactionThreshold: 100,
    state,
    directory: {},
  }), TypeError);
  await assert.rejects(policy.step({
    goal: {
      ...goal,
      target: {
        ...cwdQuery(session),
        session: { ...session, sessionId: "other" },
      },
    },
    satisfactionThreshold: 100,
    state,
  }), TypeError);
  for (const threshold of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(policy.step({
      goal,
      satisfactionThreshold: threshold,
      state,
    }), TypeError);
  }
  assert.equal(samples, 0);
  assert.deepEqual(sandbox.getSession(session), before);
});

test("observed entries with old complete listing must still execute ls and never NOOP", async t => {
  const { createCliCommandPolicy, collectDirectoryListing, zeroCliCommandProfile } = await api();
  const { sandbox, session, root } = await fixture(t);
  const target = await realpath(join(sandbox.scenarioRoot, "target"));
  const goal = {
    kind: "file.property",
    property: "file.property.directory.entries",
    target: await sandbox.bindDirectory(session, "../target"),
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const listingProfile = mutableProfile(zeroCliCommandProfile());
  listingProfile.weights[5][3] = 1;
  const policy = createCliCommandPolicy({ profile: listingProfile, sandbox, session });
  const first = await policy.step({
    goal, satisfactionThreshold: 100, state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(first.status, "achieved");
  const changedEntries = structuredClone(first.observed_state_after);
  changedEntries.directoryListing.entries = [];
  await assert.rejects(policy.step({
    goal,
    satisfactionThreshold: 100,
    state: changedEntries,
  }), TypeError);
  const forgedListing = structuredClone(first.observed_state_after);
  forgedListing.directoryListing.entries = [];
  forgedListing.directoryListing.evidence.entries = [];
  const refreshed = await policy.step({
    goal,
    satisfactionThreshold: 100,
    state: forgedListing,
  });
  assert.equal(refreshed.evidence.facts.knownValue, 0);
  assert.equal(refreshed.status, "achieved");
  const ls = await policy.step({
    goal, satisfactionThreshold: 100, state: first.observed_state_after,
  });
  assert.equal(ls.invocation[0], "ls");
  assert.equal(ls.execution_result.executorInvoked, true);
  assert.deepEqual(ls.observed_state_after.directoryListing.entries.map(entry => entry.name), [".hidden"]);
});

test("collection callback failure is isolated from the business result", async t => {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const result = await createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "pwd"),
    sandbox,
    session,
    onSample: async () => { throw new Error("disk full"); },
  }).step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: cwdQuery(session),
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: { session: "s", cwdObservation: null, directoryListing: null },
  });
  assert.equal(result.status, "achieved");
  assert.equal(result.satisfaction, 100);
  assert.equal(result.collection_result.status, "failed");
  assert.match(result.collection_result.error, /disk full/);
});

test("R03 path.resolve preserves [P, input], resolves lexically and writes no existence fact", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const base = pathRef(sandbox, session, "/a");
  const before = sandbox.getSession(session);
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.resolve"),
    sandbox,
    session,
  });
  const result = await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base, input: "../ghost" },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.deepEqual(result.invocation, ["path.resolve", base, "../ghost"]);
  assert.equal(result.status, "achieved");
  assert.equal(result.satisfaction, 100);
  assert.equal(result.execution_result.executorInvoked, true);
  assert.equal(observedPathValue(result, "absolute"), "/ghost");
  assert.equal(observedPathValue(result, "parent"), "/");
  assert.equal(Object.hasOwn(result.observed_state_after.pathKnowledge ?? {}, "exists"), false);
  assert.deepEqual(sandbox.getSession(session), before);
});

test("R04 absolute path input overrides base and special text stays literal", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const base = pathRef(sandbox, session, "/a");
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.resolve"),
    sandbox,
    session,
  });
  const resolve = async input => policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base, input },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });

  const absolute = await resolve("/b/../c");
  assert.deepEqual(absolute.invocation, ["path.resolve", base, "/b/../c"]);
  assert.equal(absolute.status, "achieved");
  assert.equal(observedPathValue(absolute, "absolute"), "/c");

  const literal = await resolve("~/$HOME/*");
  assert.equal(literal.status, "achieved");
  assert.equal(observedPathValue(literal, "absolute"), "/a/~/$HOME/*");
});

test("R05 path.relative keeps argument direction, inverse relation and empty equal result", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.relative"),
    sandbox,
    session,
  });
  const relativeStep = async (fromPath, toPath) => {
    const from = pathRef(sandbox, session, fromPath);
    const to = pathRef(sandbox, session, toPath);
    const result = await policy.step({
      goal: {
        kind: "file.property",
        property: "file.property.path.relative",
        target: { kind: "cli.path-query", from, to },
        requirement: { kind: "observed", freshness: "this_run" },
      },
      satisfactionThreshold: 100,
      state: emptyState(session),
    });
    return { from, to, result };
  };

  const forward = await relativeStep("/a/b", "/a/c");
  assert.deepEqual(forward.result.invocation, ["path.relative", forward.from, forward.to]);
  assert.equal(forward.result.status, "achieved");
  assert.equal(observedPathValue(forward.result, "relative"), "../c");

  const reverse = await relativeStep("/a/c", "/a/b");
  assert.equal(reverse.result.status, "achieved");
  assert.equal(observedPathValue(reverse.result, "relative"), "../b");

  const same = await relativeStep("/a/b", "/a/b");
  assert.equal(same.result.status, "achieved");
  assert.equal(same.result.satisfaction, 100);
  assert.equal(observedPathValue(same.result, "relative"), "");
});

test("R06 path.parts applies only slash cleanup and keeps dot segments lexical", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.parts"),
    sandbox,
    session,
  });
  const parts = async (absolutePath, property) => policy.step({
    goal: {
      kind: "file.property",
      property: `file.property.path.${property}`,
      target: pathRef(sandbox, session, absolutePath),
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  const assertParts = async (input, expected) => {
    const result = await parts(input, "name");
    assert.equal(result.status, "achieved");
    const observation = result.execution_result.receipt?.execution?.observation;
    assert.equal(observation?.absolute, expected.absolute);
    assert.equal(observation?.parent, expected.parent);
    assert.equal(observation?.name, expected.name);
    assert.equal(observation?.isRoot, expected.isRoot);
  };

  await assertParts("/a/b/..", { absolute: "/a/b/..", parent: "/a/b", name: "..", isRoot: false });
  await assertParts("/a//b", { absolute: "/a/b", parent: "/a", name: "b", isRoot: false });
  await assertParts("/a/b/", { absolute: "/a/b", parent: "/a", name: "b", isRoot: false });
  await assertParts("/", { absolute: "/", parent: "/", name: "", isRoot: true });

  const resolvePolicy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.resolve"),
    sandbox,
    session,
  });
  const resolved = await resolvePolicy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base: pathRef(sandbox, session, "/unused"), input: "/a/b/.." },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(resolved.status, "achieved");
  assert.equal(observedPathValue(resolved, "absolute"), "/a");
});

test("F1 bound path keeps dot segments and lexical parts through the public binder", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const bound = sandbox.bindPath(session, "/review/a/..");
  assert.equal(bound.path, "/review/a/..", "bindPath must preserve the typed path text");

  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.parts"),
    sandbox,
    session,
  });
  const result = await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.parent",
      target: bound,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(result.status, "achieved");
  const observation = result.execution_result.receipt?.execution?.observation;
  assert.equal(observation?.absolute, "/review/a/..");
  assert.equal(observation?.parent, "/review/a");
  assert.equal(observation?.name, "..");
});

test("R07 invalid path arguments reject as TypeError with zero samples and zero session effects", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  let samples = 0;
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.resolve"),
    sandbox,
    session,
    onSample: () => { samples += 1; },
  });
  const before = sandbox.getSession(session);
  const reject = request => assert.rejects(policy.step(request), TypeError);

  await reject({
    goal: {
      kind: "file.property",
      property: "file.property.path.relative",
      target: {
        kind: "cli.path-query",
        from: { kind: "cli.path", scenarioId: sandbox.scenarioId, sessionId: session.sessionId, path: "a" },
        to: pathRef(sandbox, session, "/a/b"),
      },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  await reject({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base: pathRef(sandbox, session, "/a"), input: "bad\0input" },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  await reject({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base: pathRef(sandbox, session, "/a") },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  await reject({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base: pathRef(sandbox, session, "/a"), input: "x", argv: ["/bin/rm"] },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(samples, 0);
  assert.deepEqual(sandbox.getSession(session), before);
});

test("R21 new observed path requests re-execute despite old or forged knowledge and thresholds cannot make unknown achieved", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const base = pathRef(sandbox, session, "/a");
  const goal = {
    kind: "file.property",
    property: "file.property.path.absolute",
    target: { kind: "cli.path-query", base, input: "../truth" },
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "path.resolve"),
    sandbox,
    session,
  });
  const first = await policy.step({ goal, satisfactionThreshold: 100, state: emptyState(session) });
  assert.equal(first.status, "achieved");
  assert.equal(observedPathValue(first, "absolute"), "/truth");

  const repeated = await policy.step({ goal, satisfactionThreshold: 100, state: first.observed_state_after });
  assert.deepEqual(repeated.invocation, ["path.resolve", base, "../truth"]);
  assert.equal(repeated.execution_result.executorInvoked, true);

  const forged = structuredClone(first.observed_state_after);
  if (forged.pathKnowledge) forged.pathKnowledge.absolutePath = "/forged";
  if (forged.pathKnowledge) forged.pathKnowledge.sourceRun = "forged-run";
  const refreshed = await policy.step({ goal, satisfactionThreshold: 100, state: forged });
  assert.deepEqual(refreshed.invocation, ["path.resolve", base, "../truth"]);
  assert.equal(observedPathValue(refreshed, "absolute"), "/truth");

  const unknown = await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.path.physical",
      target: pathRef(sandbox, session, "/a"),
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 0,
    state: emptyState(session),
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.satisfaction, null);
  assert.equal(unknown.invocation, null);
  assert.equal(unknown.execution_result.executorInvoked, false);
});

test("R22 unregistered inspect equals or predicates stay unsupported and a wrong executable head is rejected", async t => {
  const module = await api();
  const { sandbox, session } = await fixture(t);
  const ref = pathRef(sandbox, session, "/a");
  const before = sandbox.getSession(session);

  const unsupported = await module.createCliCommandPolicy({
    profile: witnessProfile(module, "unsupported"),
    sandbox,
    session,
  }).step({
    goal: {
      kind: "file.property",
      property: "file.property.exists",
      target: { kind: "cli.entry-query", ref, followSymlinks: false },
      requirement: { kind: "equals", expected: false },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(unsupported.status, "unknown");
  assert.equal(unsupported.satisfaction, null);
  assert.equal(unsupported.invocation, null);
  assert.equal(unsupported.execution_result.executorInvoked, false);

  const physical = await module.createCliCommandPolicy({
    profile: witnessProfile(module, "unsupported"),
    sandbox,
    session,
  }).step({
    goal: {
      kind: "file.property",
      property: "file.property.path.physical",
      target: ref,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 0,
    state: emptyState(session),
  });
  assert.equal(physical.status, "unknown");
  assert.equal(physical.satisfaction, null);
  assert.equal(physical.invocation, null);

  const wrongPair = await module.createCliCommandPolicy({
    profile: witnessProfile(module, "unsupported"),
    sandbox,
    session,
  }).step({
    goal: {
      kind: "file.property",
      property: "file.property.path.relative",
      target: {
        kind: "cli.path-query",
        from: pathRef(sandbox, session, "/a"),
        to: pathRef(sandbox, session, "/b"),
      },
      requirement: { kind: "equals", expected: "../b" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(wrongPair.status, "unknown");
  assert.equal(wrongPair.satisfaction, null);
  assert.equal(wrongPair.invocation, null);

  const wrongHead = await module.createCliCommandPolicy({
    profile: witnessProfile(module, "cd"),
    sandbox,
    session,
  }).step({
    goal: {
      kind: "file.property",
      property: "file.property.path.absolute",
      target: { kind: "cli.path-query", base: ref, input: "../x" },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(wrongHead.policy.selectedHead, "cd");
  assert.ok(wrongHead.policy_error);
  assert.equal(wrongHead.status, "rejected");
  assert.equal(wrongHead.invocation, null);
  assert.equal(wrongHead.execution_result.executorInvoked, false);
  assert.deepEqual(sandbox.getSession(session), before);
});
