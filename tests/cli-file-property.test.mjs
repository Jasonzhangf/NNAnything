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

test("current profile registers the six shared heads and fourteen ordered wires", async () => {
  const module = await api();
  const profile = module.zeroCliCommandProfile();
  assert.deepEqual(profile.heads, ["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"]);
  assert.deepEqual(profile.properties, ["property.directory.entries", "property.relation.sessionCwd"]);
  assert.deepEqual(profile.predicates, ["predicate.observe.sessionCwd", "predicate.equals.sessionCwd", "predicate.observe.entries"]);
  assert.deepEqual(profile.wires, [
    "bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory",
    "property.directory.entries", "property.relation.sessionCwd",
    "predicate.observe.sessionCwd", "predicate.equals.sessionCwd", "predicate.observe.entries",
    "state.hasFreshEvidence", "state.knownValue", "state.requiredConditionHolds",
    "state.hasDestinationRef", "state.requiredConditionHolds*state.hasFreshEvidence",
  ]);
  assert.equal(profile.weights.length, 6);
  assert.equal(profile.weights[0].length, 14);
});

test("legacy four-by-four migration copies by name and zero-fills new rows and columns", async () => {
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
  assert.deepEqual(migrated.heads, ["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"]);
  assert.deepEqual(migrated.weights[0].slice(0, 4), [1, 2, 3, 4]);
  assert.deepEqual(migrated.weights[3].slice(0, 4), [5, 6, 7, 8]);
  assert.deepEqual(migrated.weights[4].slice(0, 4), [9, 10, 11, 12]);
  assert.deepEqual(migrated.weights[5].slice(0, 4), [13, 14, 15, 16]);
  assert.deepEqual(migrated.weights[1].slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(migrated.weights[2].slice(0, 4), [0, 0, 0, 0]);
  for (const row of migrated.weights) assert.deepEqual(row.slice(4), Array(10).fill(0));
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
  noopProfile.weights[3][1] = 1;
  noopProfile.weights[2][9] = 10;
  noopProfile.weights[2][13] = 10;
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
  profile.weights[3][1] = 10;
  profile.weights[4][2] = 10;
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
  profile.weights[3][1] = 1;
  profile.weights[2][9] = 10;
  profile.weights[2][13] = 10;
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
