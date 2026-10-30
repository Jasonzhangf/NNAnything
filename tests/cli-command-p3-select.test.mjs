import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = () => import("../dist/cli-goal.js");
const relation = () => import("../dist/filters/cli-entry-select-relation.js");
const state = () => import("../dist/filters/cli-state.js");

// Track B accepted candidate parameters (39427f5c), read-only fixture values.
// They are never written back to a candidate file and stay uncalibrated/not_applied.
const RELATION_WEIGHTS = Object.freeze([-2.217413902282715, 0.7973229289054871, 0.7973229289054871, 0.7973229289054871]);

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-select-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createCliFilesystemSandbox } = await api();
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
    recipe: {
      scenarioId: "p3-select",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/work", kind: "directory" },
        { path: "start/work/alpha", kind: "directory" },
        { path: "start/work/humanagent", kind: "directory" },
        { path: "start/work/notes.txt", kind: "file", contents: "opaque" },
        { path: "start/other", kind: "directory" },
        { path: "start/other/humanagent", kind: "directory" },
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

async function relationProfile(targetType) {
  const { zeroEntrySelectProfile, validateEntrySelectProfile } = await relation();
  return validateEntrySelectProfile({
    ...zeroEntrySelectProfile(targetType),
    weights: RELATION_WEIGHTS,
  });
}

async function profiles() {
  return Object.freeze({
    directory: await relationProfile("directory"),
    regular: await relationProfile("regular"),
  });
}

function entrySelectGoal({ target, name, type, parent, cardinality = "one" }) {
  return {
    kind: "file.property",
    property: "file.property.directory.entries",
    target,
    requirement: {
      kind: "matches",
      predicate: {
        kind: "entrySelector",
        selector: { name, parent, ...(type === undefined ? {} : { type }) },
        cardinality,
      },
    },
  };
}

function emptyState() {
  return { session: "s", cwdObservation: null, directoryListing: null };
}

async function makePolicy({ sandbox, session, head, entrySelectProfiles, profile, authority, zeroCliCommandProfile }) {
  const { createCliCommandPolicy } = await api();
  const binding = {
    profile: profile ?? forceHead(zeroCliCommandProfile(), head),
    sandbox,
    session,
    ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
  };
  return createCliCommandPolicy(binding, authority);
}

async function observeListing({ sandbox, session, authority, target }) {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const profile = forceHead(zeroCliCommandProfile(), "ls");
  const policy = createCliCommandPolicy({ profile, sandbox, session }, authority);
  const result = await policy.step({
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(),
  });
  assert.equal(result.status, "achieved", "listing observation must achieve observed entries");
  return result.observed_state_after;
}

async function scenario(t) {
  const { createEvidenceAuthority, zeroCliCommandProfile } = await api();
  const { sandbox, session } = await fixture(t);
  const authority = createEvidenceAuthority();
  const workRef = await sandbox.bindDirectory(session, "work");
  const otherRef = await sandbox.bindDirectory(session, "other");
  const startRef = await sandbox.bindDirectory(session, ".");
  const workPhysical = (await sandbox.resolveDirectory(workRef)).physicalPath;
  const otherPhysical = (await sandbox.resolveDirectory(otherRef)).physicalPath;
  const startPhysical = (await sandbox.resolveDirectory(startRef)).physicalPath;
  const listingState = await observeListing({ sandbox, session, authority, target: workRef });
  return {
    sandbox, session, authority, zeroCliCommandProfile,
    workRef, otherRef, startRef, workPhysical, otherPhysical, startPhysical, listingState,
  };
}

test("select.entry pre-execution guards reject with rejected/0 and zero executor calls", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const before = context.sandbox.getSession(context.session);
  const cases = [
    { name: "", parent: context.workPhysical, reason: "invalid_entry_selector" },
    { name: ".", parent: context.workPhysical, reason: "invalid_entry_selector" },
    { name: "..", parent: context.workPhysical, reason: "invalid_entry_selector" },
    { name: "alpha/humanagent", parent: context.workPhysical, reason: "invalid_entry_selector" },
    { name: "human\u0000agent", parent: context.workPhysical, reason: "invalid_entry_selector" },
    { name: "humanagent", parent: "start/work", reason: "invalid_entry_selector" },
    { name: "humanagent", parent: context.workPhysical, cardinality: "all", reason: "invalid_selector_cardinality" },
    { name: "humanagent", parent: context.startPhysical, reason: "selector_parent_mismatch" },
  ];
  for (const item of cases) {
    const policy = await makePolicy({
      ...context, head: "directory.select", entrySelectProfiles,
    });
    const result = await policy.step({
      goal: entrySelectGoal({ target: context.workRef, ...item, type: "directory" }),
      satisfactionThreshold: 100,
      state: context.listingState,
    });
    assert.equal(result.status, "rejected", `${item.reason} must be rejected`);
    assert.equal(result.satisfaction, 0, `${item.reason} must score zero`);
    assert.equal(result.reason, item.reason);
    assert.equal(result.invocation, null);
    assert.equal(result.execution_result.executorInvoked, false);
    assert.equal(result.execution_result.status, "rejected");
  }
  assert.deepEqual(context.sandbox.getSession(context.session), before);
});

test("unsupported selector target types stay on the unsupported control head", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  for (const [type, detail] of [[undefined, "selector_target_type_unspecified"], ["symlink", "unsupported_selector_target_type"]]) {
    const policy = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
    const result = await policy.step({
      goal: entrySelectGoal({ target: context.workRef, name: "humanagent", parent: context.workPhysical, type }),
      satisfactionThreshold: 100,
      state: context.listingState,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.satisfaction, null);
    assert.equal(result.reason, "unsupported_property");
    assert.equal(result.policy.selectedHead, "unsupported");
    assert.equal(result.evidence.requiredHead, "unsupported");
    assert.equal(result.policy_error, null);
    assert.equal(result.invocation, null);
    assert.equal(result.execution_result.executorInvoked, false);
    assert.equal(result.evidence.selectorTargetType, detail);
  }
});

test("select.entry defers without fresh listing evidence and never executes", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const goal = entrySelectGoal({
    target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
  });

  const unobserved = await makePolicy({ ...context, head: "DEFER", entrySelectProfiles });
  const first = await unobserved.step({ goal, satisfactionThreshold: 100, state: emptyState() });
  assert.equal(first.status, "unknown");
  assert.equal(first.satisfaction, null);
  assert.equal(first.reason, "listing_unobserved");
  assert.equal(first.policy.selectedHead, "DEFER");
  assert.equal(first.invocation, null);
  assert.equal(first.execution_result.status, "deferred");
  assert.equal(first.execution_result.executorInvoked, false);
  assert.equal(first.defer?.code, "binding_unresolved");

  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const cdPolicy = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "cd"),
    sandbox: context.sandbox,
    session: context.session,
  }, context.authority);
  const moved = await cdPolicy.step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: { kind: "cli.file-query", relation: "sessionCwd", session: context.session },
      requirement: { kind: "equals", expected: context.startRef },
    },
    satisfactionThreshold: 100,
    state: emptyState(),
  });
  assert.equal(moved.status, "achieved");
  assert.equal(moved.changed, true);
  assert.equal(context.sandbox.getSession(context.session).revision, moved.session_after.revision);

  const stale = await makePolicy({ ...context, head: "DEFER", entrySelectProfiles });
  const staleResult = await stale.step({ goal, satisfactionThreshold: 100, state: context.listingState });
  assert.equal(staleResult.status, "unknown");
  assert.equal(staleResult.reason, "listing_unobserved");
  assert.equal(staleResult.execution_result.executorInvoked, false);
  assert.equal(staleResult.evidence.facts.hasFreshEvidence, 0);
});

test("select.entry authenticates the listing revision before using a stale listing", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const goal = entrySelectGoal({
    target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
  });
  const moved = await cdTo(context.startRef, context);
  assert.ok(moved.session_after.revision > context.listingState.directoryListing.revision);

  const defer = await makePolicy({ ...context, head: "DEFER", entrySelectProfiles });
  const genuineStale = await defer.step({ goal, satisfactionThreshold: 100, state: context.listingState });
  assert.deepEqual(factsTuple(genuineStale), [0, 1, 0, 1]);
  assert.equal(genuineStale.status, "unknown");
  assert.equal(genuineStale.satisfaction, null);
  assert.equal(genuineStale.reason, "listing_unobserved");
  assert.equal(genuineStale.execution_result.executorInvoked, false);

  const forged = structuredClone(context.listingState);
  forged.directoryListing.revision = moved.session_after.revision;
  const forgedResult = await defer.step({ goal, satisfactionThreshold: 100, state: forged });
  assert.deepEqual(factsTuple(forgedResult), [0, 0, 0, 1]);
  assert.equal(forgedResult.status, "unknown");
  assert.equal(forgedResult.satisfaction, null);
  assert.equal(forgedResult.reason, "listing_unobserved");
  assert.equal(forgedResult.execution_result.executorInvoked, false);
});

test("select.entry defers when the listing belongs to another directory", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const otherListingState = await observeListing({
    sandbox: context.sandbox, session: context.session, authority: context.authority, target: context.otherRef,
  });
  const policy = await makePolicy({ ...context, head: "DEFER", entrySelectProfiles });
  const result = await policy.step({
    goal: entrySelectGoal({
      target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: otherListingState,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.reason, "listing_unobserved");
  assert.equal(result.execution_result.executorInvoked, false);
});

test("directory.select and file.select achieve 100 with one unique relation match", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const before = context.sandbox.getSession(context.session);
  const cases = [
    { head: "directory.select", name: "humanagent", type: "directory" },
    { head: "file.select", name: "notes.txt", type: "regular" },
  ];
  for (const item of cases) {
    const policy = await makePolicy({ ...context, head: item.head, entrySelectProfiles });
    const result = await policy.step({
      goal: entrySelectGoal({
        target: context.workRef, name: item.name, parent: context.workPhysical, type: item.type,
      }),
      satisfactionThreshold: 100,
      state: context.listingState,
    });
    assert.equal(result.status, "achieved", `${item.head} must select ${item.name}`);
    assert.equal(result.satisfaction, 100);
    assert.equal(result.reason, "entry_selected");
    assert.equal(result.policy.selectedHead, item.head);
    assert.equal(result.policy_error, null);
    assert.equal(result.execution_result.status, "succeeded");
    assert.equal(result.execution_result.executorInvoked, true);
    assert.equal(result.invocation[0], item.head);
    assert.deepEqual(result.invocation[1], { name: item.name, type: item.type, parent: context.workPhysical });
    assert.equal(result.invocation[2].length, 3);
    assert.equal(result.invocation[3], "complete");
    const selection = result.observed_state_after.entrySelection;
    assert.equal(selection.name, item.name);
    assert.equal(selection.targetType, item.type);
    assert.equal(selection.outcome, "selected");
    assert.equal(selection.reason, "unique_match");
    assert.equal(selection.parentPath, context.workPhysical);
    assert.equal(typeof selection.ref, "string");
    assert.equal(selection.sessionRevision, before.revision);
    assert.equal(result.changed, false);
    assert.deepEqual(context.sandbox.getSession(context.session), before);
  }
});

test("select.entry reports unmet 0 when no candidate matches the selector", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const cases = [
    { head: "directory.select", name: "absent", type: "directory" },
    { head: "file.select", name: "humanagent", type: "regular" },
  ];
  for (const item of cases) {
    const policy = await makePolicy({ ...context, head: item.head, entrySelectProfiles });
    const result = await policy.step({
      goal: entrySelectGoal({
        target: context.workRef, name: item.name, parent: context.workPhysical, type: item.type,
      }),
      satisfactionThreshold: 100,
      state: context.listingState,
    });
    assert.equal(result.status, "unmet", `${item.head} must not match ${item.name}`);
    assert.equal(result.satisfaction, 0);
    assert.equal(result.reason, "entry_not_found");
    assert.equal(result.policy_error, null);
    assert.equal(result.execution_result.executorInvoked, true);
    const selection = result.observed_state_after.entrySelection;
    assert.equal(selection.outcome, "not_found");
    assert.equal(selection.ref, null);
    assert.equal(selection.reason, "not_found");
    assert.equal(selection.name, item.name);
    assert.equal(selection.targetType, item.type);
    assert.equal(selection.parentPath, context.workPhysical);
    assert.equal(selection.sessionRevision, context.sandbox.getSession(context.session).revision);
  }
});

test("select.entry reports unknown null when the relation model returns multiple matches", async t => {
  const context = await scenario(t);
  const { zeroEntrySelectProfile } = await relation();
  const entrySelectProfiles = Object.freeze({
    directory: zeroEntrySelectProfile("directory"),
    regular: zeroEntrySelectProfile("regular"),
  });
  const policy = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const result = await policy.step({
    goal: entrySelectGoal({
      target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: context.listingState,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.reason, "multiple_matches_in_single_parent");
  assert.equal(result.evidence.selection, "conflict");
  assert.equal(result.execution_result.executorInvoked, true);
  const selection = result.observed_state_after.entrySelection;
  assert.equal(selection.outcome, "conflict");
  assert.equal(selection.ref, null);
  assert.equal(selection.reason, "multiple_matches_in_single_parent");
  assert.equal(selection.sessionRevision, context.sandbox.getSession(context.session).revision);
});

test("achieved selection evidence turns the next identical request into NOOP", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const goal = entrySelectGoal({
    target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
  });
  const select = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const achieved = await select.step({ goal, satisfactionThreshold: 100, state: context.listingState });
  assert.equal(achieved.status, "achieved");

  const noop = await makePolicy({ ...context, head: "NOOP", entrySelectProfiles });
  const before = context.sandbox.getSession(context.session);
  const result = await noop.step({
    goal, satisfactionThreshold: 100, state: achieved.observed_state_after,
  });
  assert.equal(result.status, "achieved");
  assert.equal(result.satisfaction, 100);
  assert.equal(result.reason, "already_satisfied");
  assert.equal(result.policy.selectedHead, "NOOP");
  assert.equal(result.evidence.requiredHead, "NOOP");
  assert.equal(result.policy_error, null);
  assert.equal(result.invocation, null);
  assert.equal(result.execution_result.executorInvoked, false);
  assert.deepEqual(context.sandbox.getSession(context.session), before);

  const forged = structuredClone(achieved.observed_state_after);
  forged.entrySelection.sourceRun = "forged-0000-0000-0000-000000000000";
  const forgedResult = await noop.step({ goal, satisfactionThreshold: 100, state: forged });
  assert.equal(forgedResult.status, "rejected");
  assert.equal(forgedResult.satisfaction, 0);
  assert.equal(forgedResult.reason, "unexpected_head");
  assert.equal(forgedResult.evidence.requiredHead, "directory.select");
  assert.equal(forgedResult.execution_result.executorInvoked, false);
});

test("an old selection relabelled to the current revision cannot pass as fresh evidence", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const goal = entrySelectGoal({
    target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
  });
  const select = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const selected = await select.step({ goal, satisfactionThreshold: 100, state: context.listingState });
  assert.equal(selected.status, "achieved");

  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const cdPolicy = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "cd"),
    sandbox: context.sandbox,
    session: context.session,
  }, context.authority);
  const moved = await cdPolicy.step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: { kind: "cli.file-query", relation: "sessionCwd", session: context.session },
      requirement: { kind: "equals", expected: context.workRef },
    },
    satisfactionThreshold: 100,
    state: emptyState(),
  });
  assert.equal(moved.status, "achieved");
  const currentTarget = await context.sandbox.bindDirectory(context.session, ".");
  const relisted = await observeListing({
    sandbox: context.sandbox,
    session: context.session,
    authority: context.authority,
    target: currentTarget,
  });
  const forged = {
    ...relisted,
    entrySelection: {
      ...selected.observed_state_after.entrySelection,
      sessionRevision: moved.session_after.revision,
    },
  };
  const noop = await makePolicy({ ...context, head: "NOOP", entrySelectProfiles });
  const result = await noop.step({
    goal: entrySelectGoal({
      target: currentTarget, name: "humanagent", parent: context.workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: forged,
  });
  assert.notEqual(result.status, "achieved");
  assert.equal(result.evidence.requiredHead, "directory.select");
  assert.equal(result.execution_result.executorInvoked, false);
});

test("entry.select stores rejected state for an invalid duplicate candidate set", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-select-invalid-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createCliFilesystemSandbox, createEvidenceAuthority, createCliCommandPolicy, zeroCliCommandProfile, runDirectoryListHelper } = await api();
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    listingObserver: async input => {
      const result = await runDirectoryListHelper(input);
      if (!result.ok) return result;
      const first = result.observation.entries[0];
      return { ok: true, observation: { ...result.observation, entries: [first, ...result.observation.entries] } };
    },
    recipe: {
      scenarioId: "p3-select-invalid",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/work", kind: "directory" },
        { path: "start/work/humanagent", kind: "directory" },
      ],
      sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] }],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const authority = createEvidenceAuthority();
  const workRef = await sandbox.bindDirectory(session, "work");
  const workPhysical = (await sandbox.resolveDirectory(workRef)).physicalPath;
  const listing = await createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "ls"),
    sandbox,
    session,
  }, authority).step({
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: workRef,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    satisfactionThreshold: 100,
    state: emptyState(),
  });
  const entrySelectProfiles = await profiles();
  const policy = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "directory.select"),
    sandbox,
    session,
    entrySelectProfiles,
  }, authority);
  const result = await policy.step({
    goal: entrySelectGoal({
      target: workRef, name: "humanagent", parent: workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: listing.observed_state_after,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "invalid_candidate_set");
  assert.equal(result.observed_state_after.entrySelection.outcome, "rejected");
  assert.equal(result.observed_state_after.entrySelection.ref, null);
  assert.equal(result.observed_state_after.entrySelection.reason, "duplicate_ref");
});

test("partial and unknown entry-select resolutions project to null-ref state observations", async t => {
  const { resolveEntrySelectSet, zeroEntrySelectProfile } = await relation();
  const { validateEntrySelectionKnowledge } = await state();
  const selector = { name: "item", type: "directory", parent: "/tmp/parent" };
  const candidates = [{ ref: "r1", path: "/tmp/parent/item", name: "item", type: "directory", parent: "/tmp/parent" }];
  const resolution = resolveEntrySelectSet(
    selector,
    candidates,
    "partial",
    zeroEntrySelectProfile("directory"),
  );
  assert.equal(resolution.outcome, "insufficient_evidence");
  assert.equal(resolution.ref, null);
  const observation = validateEntrySelectionKnowledge({
    parentPath: "/tmp/parent",
    name: "item",
    targetType: "directory",
    outcome: "insufficient_evidence",
    ref: null,
    reason: "coverage_partial",
    sessionRevision: 0,
    sourceRun: "run",
  });
  assert.equal(observation.ref, null);
  const knowledge = validateEntrySelectionKnowledge({
    parentPath: "/tmp/parent",
    name: "item",
    targetType: "directory",
    outcome: "insufficient_evidence",
    ref: null,
    reason: "coverage_partial",
    sessionRevision: 0,
    sourceRun: "run",
  });
  assert.equal(knowledge.ref, null);
  assert.throws(() => validateEntrySelectionKnowledge({
    parentPath: "/tmp/parent",
    name: "item",
    targetType: "directory",
    outcome: "not_found",
    ref: "forged",
    reason: "not_found",
    sessionRevision: 0,
    sourceRun: "run",
  }), /null/);
});

test("a policy error blocks entry selection before any executor call", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const policy = await makePolicy({ ...context, head: "ls", entrySelectProfiles });
  const result = await policy.step({
    goal: entrySelectGoal({
      target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: context.listingState,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.satisfaction, 0);
  assert.equal(result.reason, "unexpected_head");
  assert.equal(result.evidence.requiredHead, "directory.select");
  assert.equal(result.policy.selectedHead, "ls");
  assert.equal(result.invocation, null);
  assert.equal(result.execution_result.executorInvoked, false);
});

test("missing EntrySelectProfile options fail loudly with TypeError", async t => {
  const context = await scenario(t);
  const policy = await makePolicy({ ...context, head: "directory.select" });
  await assert.rejects(policy.step({
    goal: entrySelectGoal({
      target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
    }),
    satisfactionThreshold: 100,
    state: context.listingState,
  }), TypeError);
});

function factsTuple(result) {
  const facts = result.evidence.facts;
  return [facts.hasFreshEvidence, facts.knownValue, facts.requiredConditionHolds, facts.hasDestinationRef];
}

function workEntriesGoal(target) {
  return {
    kind: "file.property",
    property: "file.property.directory.entries",
    target,
    requirement: { kind: "observed", freshness: "this_run" },
  };
}

async function cdTo(ref, context) {
  const { createCliCommandPolicy, zeroCliCommandProfile } = await api();
  const cdPolicy = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "cd"),
    sandbox: context.sandbox,
    session: context.session,
  }, context.authority);
  const moved = await cdPolicy.step({
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: { kind: "cli.file-query", relation: "sessionCwd", session: context.session },
      requirement: { kind: "equals", expected: ref },
    },
    satisfactionThreshold: 100,
    state: emptyState(),
  });
  assert.equal(moved.status, "achieved", "cd must succeed to advance the session revision");
  return moved;
}

test("select.entry separates listing freshness from selection satisfaction across m1079 fact vectors", async t => {
  const context = await scenario(t);
  const entrySelectProfiles = await profiles();
  const goal = entrySelectGoal({
    target: context.workRef, name: "humanagent", parent: context.workPhysical, type: "directory",
  });

  const select = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const selected = await select.step({ goal, satisfactionThreshold: 100, state: context.listingState });
  assert.equal(selected.status, "achieved");
  assert.equal(selected.observed_state_after.entrySelection.outcome, "selected");

  // Fresh complete listing + fresh successful selection keeps NOOP (no regression).
  const noop = await makePolicy({ ...context, head: "NOOP", entrySelectProfiles });
  const noopResult = await noop.step({ goal, satisfactionThreshold: 100, state: selected.observed_state_after });
  assert.deepEqual(factsTuple(noopResult), [1, 1, 1, 1]);
  assert.equal(noopResult.evidence.requiredHead, "NOOP");
  assert.equal(noopResult.status, "achieved");
  assert.equal(noopResult.reason, "already_satisfied");
  assert.equal(noopResult.execution_result.executorInvoked, false);

  // Advance the session revision without re-listing so listing and selection are both stale.
  const moved = await cdTo(context.startRef, context);
  assert.ok(moved.session_after.revision > selected.session_before.revision);

  // Combination A: old listing + old successful selection at the same old revision -> DEFER.
  const defer = await makePolicy({ ...context, head: "DEFER", entrySelectProfiles });
  const combA = await defer.step({ goal, satisfactionThreshold: 100, state: selected.observed_state_after });
  assert.deepEqual(factsTuple(combA), [0, 1, 1, 1]);
  assert.equal(combA.evidence.requiredHead, "DEFER");
  assert.equal(combA.status, "unknown");
  assert.equal(combA.satisfaction, null);
  assert.equal(combA.reason, "listing_unobserved");
  assert.equal(combA.execution_result.executorInvoked, false);

  // A complete re-listing at the new revision drops the stale selection rather than keeping it.
  const list = await makePolicy({ ...context, head: "ls" });
  const relisted = await list.step({
    goal: workEntriesGoal(context.workRef),
    satisfactionThreshold: 100,
    state: selected.observed_state_after,
  });
  assert.equal(relisted.status, "achieved");
  assert.equal(relisted.observed_state_after.directoryListing.revision, moved.session_after.revision);
  assert.equal(relisted.observed_state_after.entrySelection, null);

  // Combination B (normal ls after): new listing + no selection -> typed select, not NOOP.
  const reselect = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const combB = await reselect.step({ goal, satisfactionThreshold: 100, state: relisted.observed_state_after });
  assert.deepEqual(factsTuple(combB), [1, 1, 0, 1]);
  assert.equal(combB.evidence.requiredHead, "directory.select");
  assert.equal(combB.status, "achieved");

  // Combination B (external tampering): relabel the stale selection to the current revision.
  const tampered = {
    ...relisted.observed_state_after,
    entrySelection: {
      ...selected.observed_state_after.entrySelection,
      sessionRevision: relisted.observed_state_after.directoryListing.revision,
    },
  };
  const tamperPolicy = await makePolicy({ ...context, head: "directory.select", entrySelectProfiles });
  const combBTampered = await tamperPolicy.step({ goal, satisfactionThreshold: 100, state: tampered });
  assert.deepEqual(factsTuple(combBTampered), [1, 1, 0, 1]);
  assert.equal(combBTampered.evidence.requiredHead, "directory.select");
});

test("P28 a partial ls after a complete selection invalidates listing and selection", async t => {
  const { createEvidenceAuthority, createCliCommandPolicy, zeroCliCommandProfile, runDirectoryListHelper } = await api();
  const entrySelectProfiles = await profiles();
  let partial = false;
  const context = await fixture(t, {
    listingObserver: async input => {
      const result = await runDirectoryListHelper(input);
      if (!result.ok || !partial) return result;
      const physicalDirectory = result.observation.physicalDirectory;
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: "partial",
          entries: [...result.observation.entries, { name: "flaky", path: join(physicalDirectory, "flaky"), type: "unknown" }],
          errors: [{ name: "flaky", code: "EIO", message: "stat failed" }],
        },
      };
    },
  });
  const authority = createEvidenceAuthority();
  const workRef = await context.sandbox.bindDirectory(context.session, "work");
  const workPhysical = (await context.sandbox.resolveDirectory(workRef)).physicalPath;
  const listingGoal = workEntriesGoal(workRef);
  const selectGoal = entrySelectGoal({
    target: workRef, name: "humanagent", parent: workPhysical, type: "directory",
  });

  const list = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "ls"),
    sandbox: context.sandbox,
    session: context.session,
  }, authority);
  const complete = await list.step({ goal: listingGoal, satisfactionThreshold: 100, state: emptyState() });
  assert.equal(complete.status, "achieved");

  const select = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "directory.select"),
    sandbox: context.sandbox,
    session: context.session,
    entrySelectProfiles,
  }, authority);
  const selected = await select.step({
    goal: selectGoal, satisfactionThreshold: 100, state: complete.observed_state_after,
  });
  assert.equal(selected.status, "achieved");
  assert.notEqual(selected.observed_state_after.directoryListing, null);
  assert.equal(selected.observed_state_after.entrySelection.outcome, "selected");

  partial = true;
  const partialListing = await list.step({
    goal: listingGoal, satisfactionThreshold: 100, state: selected.observed_state_after,
  });
  assert.equal(partialListing.status, "unknown");
  assert.equal(partialListing.satisfaction, null);
  assert.equal(partialListing.reason, "partial_coverage");
  assert.equal(partialListing.observed_state_after.directoryListing, null);
  assert.equal(partialListing.observed_state_after.entrySelection, null);
  assert.equal(partialListing.execution_result.status, "succeeded");
  assert.equal(partialListing.execution_result.executorInvoked, true);
  assert.equal(partialListing.execution_result.receipt.execution.observation.coverage, "partial");

  const defer = createCliCommandPolicy({
    profile: forceHead(zeroCliCommandProfile(), "DEFER"),
    sandbox: context.sandbox,
    session: context.session,
    entrySelectProfiles,
  }, authority);
  const after = await defer.step({
    goal: selectGoal, satisfactionThreshold: 100, state: partialListing.observed_state_after,
  });
  assert.deepEqual(factsTuple(after), [0, 0, 0, 1]);
  assert.equal(after.evidence.requiredHead, "DEFER");
  assert.equal(after.status, "unknown");
  assert.equal(after.satisfaction, null);
  assert.equal(after.reason, "listing_unobserved");
  assert.equal(after.execution_result.executorInvoked, false);
});
