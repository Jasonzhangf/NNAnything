import assert from "node:assert/strict";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

const ALL_EFFECTS = Object.freeze(["filesystem.read", "process.exec", "session.write"]);

async function api() {
  return import("nnanything/cli-goal");
}

function forceHead(profile, head) {
  const index = profile.heads.indexOf(head);
  assert.notEqual(index, -1);
  return {
    ...profile,
    weights: profile.weights.map((row, rowIndex) =>
      row.map((weight, columnIndex) => (rowIndex === index && columnIndex === 0 ? 1 : weight))),
  };
}

function deterministicProfile(module) {
  const profile = module.zeroCliCommandProfile();
  const weights = profile.weights.map(row => [...row]);
  const set = (head, wire, value) => {
    const row = profile.heads.indexOf(head);
    const column = profile.wires.indexOf(wire);
    assert.notEqual(row, -1, `missing head ${head}`);
    assert.notEqual(column, -1, `missing wire ${wire}`);
    weights[row][column] = value;
  };
  set("pwd", "predicate.observe.sessionCwd", 4);
  set("cd", "predicate.equals.sessionCwd", 4);
  set("ls", "property.directory.entries", 4);
  set("NOOP", "state.requiredConditionHolds*state.hasFreshEvidence", 8);
  set("path.resolve", "property.path.absolute", 4);
  set("path.relative", "property.path.relative", 4);
  set("path.parts", "property.path.parent", 4);
  set("path.parts", "property.path.name", 4);
  set("entry.inspect", "predicate.observe.inspect", 4);
  return { ...profile, weights };
}

async function fixture(t, options = {}) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cli-autonomous-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    ...(options.fileReadIo === undefined ? {} : { fileReadIo: options.fileReadIo }),
    recipe: {
      scenarioId: options.scenarioId ?? "cli-autonomous-goal",
      entries: options.entries ?? [
        { path: "start", kind: "directory" },
        { path: "start/file.txt", kind: "file", contents: "hello" },
        { path: "start/other.txt", kind: "file", contents: "other" },
        { path: "start/sub", kind: "directory" },
        { path: "start/sub/dir", kind: "directory" },
      ],
      sessions: [{
        id: "s",
        cwd: options.cwd ?? "start",
        grantedEffects: options.grantedEffects ?? ["filesystem.read", "process.exec", "session.write"],
      }],
    },
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { module, sandbox, session: sandbox.bindSession("s") };
}

function sessionCwdGoal(session, requirement) {
  return {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: { kind: "cli.file-query", relation: "sessionCwd", session },
    requirement,
  };
}

function contentBytesGoal(expectedBase64, range = { offset: 0, length: 5 }) {
  return {
    kind: "file.property",
    property: "file.property.content.bytes",
    target: {
      kind: "cli.file-query",
      relation: "entrySelector",
      selector: { type: "regular" },
      cardinality: "one",
    },
    requirement: { kind: "equals", range, expectedBase64 },
  };
}

async function contentFixture(t, options = {}) {
  return fixture(t, {
    scenarioId: options.scenarioId ?? "cli-autonomous-content",
    cwd: options.cwd ?? "payload",
    entries: options.entries ?? [
      { path: "payload", kind: "directory" },
      { path: "payload/hello.txt", kind: "file", contents: "hello" },
    ],
    grantedEffects: options.grantedEffects,
    fileReadIo: options.fileReadIo,
  });
}

async function replaceWithDifferentInode(path, contents) {
  const original = await lstat(path, { bigint: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(path, { force: true });
    await writeFile(path, contents);
    const current = await lstat(path, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino) return current;
  }
  throw new Error("unable to obtain a different file inode");
}

test("CA1-P1 sessionCwd observed uses one pwd invocation", async t => {
  const { module, sandbox, session } = await fixture(t);
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.reason, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.policyStepCount, 1);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["pwd"]);
  assert.equal(
    result.domain.cwdObservation.physicalCwd,
    await realpath(join(sandbox.scenarioRoot, "start")),
  );
});

test("CA1-P2 sessionCwd equals derives pwd then cd", async t => {
  const { module, sandbox, session } = await fixture(t);
  const expected = await sandbox.bindDirectory(session, "sub/dir");
  const expectedPhysical = (await sandbox.resolveDirectory(expected)).physicalPath;
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 2);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["pwd", "cd"]);
  assert.equal(
    sandbox.getSession(session).cwd,
    expectedPhysical,
  );
});

test("CA1-P3 trusted initial state satisfies sessionCwd equals with NOOP", async t => {
  const { module, sandbox, session } = await fixture(t, { cwd: "start/sub/dir" });
  const snapshot = sandbox.getSession(session);
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  assert.equal(receipt.execution.status, "succeeded");
  const observation = receipt.execution.observation;
  assert.equal(observation.kind, "pwd");
  const authority = module.createEvidenceAuthority();
  authority.record({
    kind: "pwd",
    session: session.sessionId,
    revision: snapshot.revision,
    runId: receipt.execution.runId,
    observation,
  });
  const initialState = {
    session: session.sessionId,
    cwdObservation: {
      physicalCwd: observation.physicalCwd,
      evidence: observation,
      revision: snapshot.revision,
      sourceRun: receipt.execution.runId,
    },
    directoryListing: null,
  };
  const expected = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      initialState,
      authority,
    },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.noopSatisfied, true);
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 1);
  assert.equal(result.domain.steps[0].selectedHead, "NOOP");
  assert.equal(result.domain.steps[0].executorInvoked, false);
});

test("CA1-P4 directory entries observed uses one ls invocation", async t => {
  const { module, sandbox, session } = await fixture(t);
  const target = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.policyStepCount, 1);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls"]);
  assert.deepEqual(
    result.domain.directoryListing.entries.map(entry => entry.name),
    ["file.txt", "other.txt", "sub"],
  );
});

test("CA1-N1 unknown properties are rejected without executor invocation", async t => {
  const { module, sandbox, session } = await fixture(t);
  const target = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: {
      kind: "file.property",
      property: "file.property.links",
      target,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    resources: { sandbox, session, profile: module.zeroCliCommandProfile(), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "unsupported_property");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 1);
  assert.equal(result.domain.steps[0].selectedHead, "unsupported");
  assert.equal(result.domain.steps[0].executorInvoked, false);
});

test("CA1-N2 missing session.write blocks cd", async t => {
  const { module, sandbox, session } = await fixture(t);
  const expected = await sandbox.bindDirectory(session, "sub");
  const before = sandbox.getSession(session).cwd;
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ["filesystem.read", "process.exec"],
    },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "permission_denied");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.steps.at(-1).selectedHead, "cd");
  assert.equal(result.domain.steps.at(-1).executorInvoked, false);
  assert.equal(sandbox.getSession(session).cwd, before);
});

test("CA1-N3 targets outside the sandbox are rejected before execution", async t => {
  const { module, sandbox, session } = await fixture(t);
  const expected = {
    kind: "cli.directory",
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: "../../outside",
  };
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "path_outside_workspace");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N6 wrong candidate weights are rejected as unexpected head", async t => {
  const { module, sandbox, session } = await fixture(t);
  const profile = forceHead(module.zeroCliCommandProfile(), "ls");
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
    resources: { sandbox, session, profile, grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "unexpected_head");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.steps[0].selectedHead, "ls");
  assert.equal(result.domain.steps[0].executorInvoked, false);
  assert.equal(result.domain.policyError.expectedHead, "pwd");
  assert.equal(result.domain.policyError.selectedHead, "ls");
});

test("CA1-N7 a target that cannot be resolved is rejected as target_unresolvable", async t => {
  const { module, sandbox, session } = await fixture(t);
  const beforeRevision = sandbox.getSession(session).revision;
  const missing = {
    kind: "cli.directory",
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: "missing-child/nested",
  };
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected: missing }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "target_unresolvable");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
  assert.equal(sandbox.getSession(session).revision, beforeRevision);
});

test("CA1-P5 content bytes equals reads the only regular file in scope", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.family, "content_bytes_equals");
  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.reason, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 3);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", "entry.inspect", null]);
  assert.deepEqual(
    result.domain.steps.map(step => step.decisionMechanism),
    ["trained_policy_v1", "trained_policy_v1", "deterministic_exec"],
  );
  assert.deepEqual(
    result.domain.steps.map(step => step.operation),
    ["ls", "entry.inspect", "file.read"],
  );
  assert.equal(result.domain.readReceipt.operation, "file.read");
  assert.equal(result.domain.readReceipt.offset, 0);
  assert.equal(result.domain.readReceipt.length, 5);
  assert.equal(result.domain.readReceipt.bytesRead, 5);
  assert.equal(result.domain.readReceipt.eof, false);
  assert.notEqual(result.domain.readReceipt.observedObject.dev, null);
  assert.notEqual(result.domain.readReceipt.observedObject.ino, null);
});

test("CA1-P6 content bytes equals honors an exact fileName", async t => {
  const { module, sandbox, session } = await contentFixture(t, {
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/hello.txt", kind: "file", contents: "hello" },
      { path: "payload/other.txt", kind: "file", contents: "other" },
    ],
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "hello.txt",
    },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 3);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", "entry.inspect", null]);
  assert.equal(result.domain.readReceipt.bytesRead, 5);
});

test("CA1-N8 multiple content candidates defer without reading", async t => {
  const { module, sandbox, session } = await contentFixture(t, {
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/hello.txt", kind: "file", contents: "hello" },
      { path: "payload/other.txt", kind: "file", contents: "other" },
    ],
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.status, "deferred");
  assert.equal(result.domain.reason, "candidate_ambiguous");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", null]);
  assert.equal(result.domain.steps.some(step => step.operation === "file.read"), false);
  assert.equal(result.domain.readReceipt, null);
});

test("CA1-N9 content mismatch fails after a real read", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("amVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.reason, "content_mismatch");
  assert.equal(result.domain.executorInvocationCount, 3);
  assert.equal(result.domain.steps.at(-1).operation, "file.read");
  assert.equal(result.domain.steps.at(-1).executorInvoked, true);
  assert.notEqual(result.domain.readReceipt, null);
  assert.equal(result.domain.readReceipt.bytesRead, 5);
});

test("CA1-N10 content scope outside workspace is rejected before execution", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = {
    kind: "cli.directory",
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: "../../outside",
  };
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "path_outside_workspace");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N11 content goal without filesystem.read is rejected with zero execution", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      scope,
      grantedEffects: ["process.exec"],
    },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "permission_denied");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N12 missing exact fileName is candidate_missing", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "missing.txt",
    },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "candidate_missing");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", null]);
  assert.equal(result.domain.readReceipt, null);
});

test("CA1-N13 non-regular candidate is rejected before read", async t => {
  const { module, sandbox, session } = await contentFixture(t, {
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/only-dir", kind: "directory" },
    ],
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "only-dir",
    },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "candidate_not_regular");
  assert.equal(result.domain.executorInvocationCount, 2);
  assert.equal(result.domain.policyStepCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", "entry.inspect", null]);
  assert.equal(result.domain.steps.at(-1).status, "rejected");
  assert.equal(result.domain.steps.at(-1).operation, null);
  assert.equal(result.domain.readReceipt, null);
});

test("CA1-N14 content chain stops at the configured step budget", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  // Each independent atomic dispatch costs four controller transitions. The three
  // dispatches plus the root frame need 17 in total, so 10 is the real boundary where
  // ls and entry.inspect have run and file.read has not.
  const budgetUsed = 10;
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      budget: { maxTransitions: budgetUsed },
    },
  });

  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.reason, "budget_exhausted");
  assert.equal(result.domain.executorInvocationCount, 2);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["ls", "entry.inspect"]);
  assert.equal(result.domain.readReceipt, null);
  assert.equal(result.response.kind, "run_result");
  assert.equal(result.response.report.control.stopReason, "budget");
  assert.equal(result.response.report.budgetUsed.transitionsUsed, budgetUsed);
});

test("CA1-N15 missing content scope is target_unresolvable", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = {
    kind: "cli.directory",
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: "missing-scope",
  };
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "target_unresolvable");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

// CA1-N16: the object named by the trusted inspect receipt is replaced between
// inspect and read. The public fileReadIo seam performs the swap on its first
// lstat of the target, which is the pre-open observation inside readFileRange.
// Identity failure must be visible as a typed object_changed outcome, not as a
// generic read failure, and the replacement bytes must never be returned.
test("CA1-N16 a target replaced after inspect is object_changed without replacement bytes", async t => {
  const race = { swapped: false, opened: 0 };
  const raceIo = {
    lstat: async (path, options) => {
      if (!race.swapped && basename(path) === "target.txt") {
        race.swapped = true;
        await replaceWithDifferentInode(path, "replaced");
      }
      return lstat(path, options);
    },
    open: async (path, flags) => {
      race.opened += 1;
      return open(path, flags);
    },
  };
  const { module, sandbox, session } = await contentFixture(t, {
    scenarioId: "cli-autonomous-content-replaced",
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/target.txt", kind: "file", contents: "original" },
      { path: "payload/other.txt", kind: "file", contents: "other" },
    ],
    fileReadIo: raceIo,
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("b3JpZ2luYWw=", { offset: 0, length: 8 }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "target.txt",
    },
  });

  assert.equal(race.swapped, true, "the public fileReadIo seam performed the replacement");
  assert.equal(race.opened, 1, "the executor still opens the path after inspect");
  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.reason, "object_changed");
  assert.equal(result.domain.readReceipt, null);
  assert.equal(
    JSON.stringify(result).includes(Buffer.from("replaced").toString("base64")),
    false,
    "replacement bytes must never be returned",
  );
  const readStep = result.domain.steps.at(-1);
  assert.equal(readStep.operation, "file.read");
  assert.equal(readStep.executorInvoked, true, "the read executor ran and was refused by identity validation");
  assert.equal(readStep.reason, "STALE_REFERENCE");
});

// CA1-N17: the same path keeps its identity while its content changes after
// inspect. dev/ino still match, so identity validation cannot refuse the read
// and the new bytes reach the root equality check. We assert the
// content_mismatch branch, because that is the honest outcome: the bytes read
// are the current bytes of the observed object, and they differ from the goal.
// Returning the stale bytes from before the write is impossible, since the read
// opens the path after the mutation and reads what is on disk at that moment.
test("CA1-N17 in-place content change after inspect is content_mismatch, never stale bytes", async t => {
  const mutation = { done: false, sameIdentity: false };
  const mutationIo = {
    lstat: async (path, options) => lstat(path, options),
    open: async (path, flags) => {
      if (!mutation.done && basename(path) === "target.txt") {
        mutation.done = true;
        // Same inode, new content: write in place just before the executor opens.
        const before = await lstat(path, { bigint: true });
        await writeFile(path, "mutated!");
        const after = await lstat(path, { bigint: true });
        mutation.sameIdentity = before.dev === after.dev && before.ino === after.ino;
      }
      return open(path, flags);
    },
  };
  const { module, sandbox, session } = await contentFixture(t, {
    scenarioId: "cli-autonomous-content-mutated",
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/target.txt", kind: "file", contents: "original" },
    ],
    fileReadIo: mutationIo,
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const mutated = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("b3JpZ2luYWw=", { offset: 0, length: 8 }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "target.txt",
    },
  });

  assert.equal(mutation.done, true, "the read seam mutated the object after inspect");
  assert.equal(mutation.sameIdentity, true, "the in-place write kept the same dev/ino");
  assert.equal(mutated.domain.status, "failed");
  assert.equal(mutated.domain.reason, "content_mismatch");
  assert.notEqual(mutated.domain.readReceipt, null, "the read happened and returned the current bytes");
  assert.equal(mutated.domain.readReceipt.bytesRead, 8);
  const readStep = mutated.domain.steps.at(-1);
  assert.equal(readStep.operation, "file.read");
  assert.equal(readStep.executorInvoked, true);
  assert.equal(readStep.status, "satisfied", "the read itself succeeded; only the equality root condition failed");
});

test("CA1-N18 empty grantedEffects is not inherited from the session and executes nothing", async t => {
  const { module, sandbox, session } = await fixture(t);
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: [] },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "permission_denied");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 1);
  assert.equal(result.domain.steps[0].selectedHead, "pwd");
  assert.equal(result.domain.steps[0].executorInvoked, false);
});

test("CA1-N19 omitting grantedEffects throws TypeError", async t => {
  const { module, sandbox, session } = await fixture(t);
  await assert.rejects(
    module.runCliAutonomousGoal({
      goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
      resources: { sandbox, session, profile: deterministicProfile(module) },
    }),
    /autonomous goal requires resources\.grantedEffects/,
  );
});

test("CA1-N20 a target replaced between inspect and bindFile is object_changed without reading", async t => {
  const { module, sandbox, session } = await contentFixture(t, {
    scenarioId: "cli-autonomous-content-bind-race",
    entries: [
      { path: "payload", kind: "directory" },
      { path: "payload/target.txt", kind: "file", contents: "original" },
    ],
  });
  let replaced = false;
  const originalBindFile = sandbox.bindFile.bind(sandbox);
  const racingSandbox = Object.assign(Object.create(null), sandbox, {
    async bindFile(sessionRef, path) {
      if (!replaced && basename(path) === "target.txt") {
        replaced = true;
        await replaceWithDifferentInode(path, "replaced");
      }
      return originalBindFile(sessionRef, path);
    },
  });
  const scope = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("b3JpZ2luYWw=", { offset: 0, length: 8 }),
    resources: {
      sandbox: racingSandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      fileName: "target.txt",
    },
  });

  assert.equal(replaced, true, "the bindFile seam performed the replacement");
  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.reason, "object_changed");
  assert.equal(result.domain.readReceipt, null);
  assert.equal(result.domain.steps.some(step => step.operation === "file.read"), false);
  assert.equal(
    JSON.stringify(result).includes(Buffer.from("replaced").toString("base64")),
    false,
    "replacement bytes must never be returned",
  );
});

test("CA1-P7 atomic path absolute is satisfied through one path.resolve execution", async t => {
  const { module, sandbox, session } = await fixture(t);
  const base = sandbox.bindPath(session, join(sandbox.scenarioRoot, "start"));
  const goal = {
    kind: "file.property",
    property: "file.property.path.absolute",
    target: { kind: "cli.path-query", base, input: "file.txt" },
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const result = await module.runCliAutonomousGoal({
    goal,
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.family, "atomic_file_property");
  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.reason, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.equal(result.domain.policyStepCount, 1);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["path.resolve"]);
});

test("CA1-N21 atomic entry.inspect path outside workspace is rejected as path_outside_workspace", async t => {
  const { module, sandbox, session } = await fixture(t);
  const outside = sandbox.bindPath(session, join(tmpdir(), "nn-cli-autonomous-outside"));
  const goal = {
    kind: "file.property",
    property: "file.property.type",
    target: { kind: "cli.entry-query", ref: outside, followSymlinks: false },
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const result = await module.runCliAutonomousGoal({
    goal,
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS },
  });

  assert.equal(result.domain.family, "atomic_file_property");
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "path_outside_workspace");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 1);
  assert.equal(result.domain.steps[0].selectedHead, "entry.inspect");
  assert.equal(result.domain.steps[0].executorInvoked, false);
});

test("CA1-N22 content scope issued at an older session revision is stale_scope with zero execution", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const set = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory: scope } });
  assert.equal(set.execution.status, "succeeded");
  assert.equal(sandbox.getSession(session).revision, 1);

  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "stale_scope");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N23 content scope from another scenario is stale_scope without throwing", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const bound = await sandbox.bindDirectory(session, ".");
  const scope = { ...bound, scenarioId: "other-scenario" };

  let result;
  await assert.doesNotReject(async () => {
    result = await module.runCliAutonomousGoal({
      goal: contentBytesGoal("aGVsbG8="),
      resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope },
    });
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "stale_scope");
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N24 content goal with empty enabledSkills matches the non-content path with zero execution", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const nonContent = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, enabledSkills: [] },
  });
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope, enabledSkills: [] },
  });

  assert.equal(result.domain.status, nonContent.domain.status);
  assert.equal(result.domain.reason, nonContent.domain.reason);
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-N25 content goal without atomic skill matches the non-content path with zero execution", async t => {
  const { module, sandbox, session } = await contentFixture(t);
  const scope = await sandbox.bindDirectory(session, ".");
  const nonContent = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "observed", freshness: "this_run" }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      enabledSkills: ["cli.autonomous.session-cwd-ensure"],
    },
  });
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("aGVsbG8="),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      scope,
      enabledSkills: ["cli.autonomous.session-cwd-ensure"],
    },
  });

  assert.equal(result.domain.status, nonContent.domain.status);
  assert.equal(result.domain.reason, nonContent.domain.reason);
  assert.equal(result.domain.executorInvocationCount, 0);
  assert.equal(result.domain.policyStepCount, 0);
  assert.deepEqual(result.domain.steps, []);
});

test("CA1-P8 untrusted initial state is retained instead of silently reset", async t => {
  const { module, sandbox, session } = await fixture(t);
  const snapshot = sandbox.getSession(session);
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  assert.equal(receipt.execution.status, "succeeded");
  const observation = receipt.execution.observation;
  const initialState = {
    session: session.sessionId,
    cwdObservation: {
      physicalCwd: observation.physicalCwd,
      evidence: observation,
      revision: snapshot.revision,
      sourceRun: receipt.execution.runId,
    },
    directoryListing: null,
  };
  const target = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target,
      requirement: { kind: "observed", freshness: "this_run" },
    },
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      initialState,
    },
  });

  assert.equal(result.domain.status, "satisfied");
  assert.notEqual(result.domain.state.cwdObservation, null);
  assert.equal(result.domain.state.cwdObservation.sourceRun, receipt.execution.runId);
});

test("CA1-P9 a purely lexical path goal needs no effect grant", async t => {
  const { module, sandbox, session } = await fixture(t);
  const base = sandbox.bindPath(session, join(sandbox.scenarioRoot, "start"));
  const goal = {
    kind: "file.property",
    property: "file.property.path.absolute",
    target: { kind: "cli.path-query", base, input: "file.txt" },
    requirement: { kind: "observed", freshness: "this_run" },
  };
  const result = await module.runCliAutonomousGoal({
    goal,
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: [] },
  });

  assert.equal(result.domain.family, "atomic_file_property");
  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.reason, "satisfied");
  assert.equal(result.domain.executorInvocationCount, 1);
  assert.deepEqual(result.domain.steps.map(step => step.selectedHead), ["path.resolve"]);
});

test("CA1-N26 an initialState without authority is reported as untrusted and never satisfies NOOP", async t => {
  const { module, sandbox, session } = await fixture(t);
  const snapshot = sandbox.getSession(session);
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  assert.equal(receipt.execution.status, "succeeded");
  const observation = receipt.execution.observation;
  const initialState = {
    session: session.sessionId,
    cwdObservation: {
      physicalCwd: observation.physicalCwd,
      evidence: observation,
      revision: snapshot.revision,
      sourceRun: receipt.execution.runId,
    },
    directoryListing: null,
  };
  const expected = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      initialState,
    },
  });

  assert.equal(result.domain.initialStateStatus, "untrusted");
  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.steps[0].selectedHead, "pwd", "an untrusted cwd observation must be re-observed");
  assert.equal(result.domain.executorInvocationCount >= 1, true);
  assert.equal(result.domain.noopSatisfied, false);
});

test("CA1-N27 a trusted initialState is reported as trusted", async t => {
  const { module, sandbox, session } = await fixture(t, { cwd: "start/sub" });
  const snapshot = sandbox.getSession(session);
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  const observation = receipt.execution.observation;
  const authority = module.createEvidenceAuthority();
  authority.record({
    kind: "pwd",
    session: session.sessionId,
    revision: snapshot.revision,
    runId: receipt.execution.runId,
    observation,
  });
  const initialState = {
    session: session.sessionId,
    cwdObservation: {
      physicalCwd: observation.physicalCwd,
      evidence: observation,
      revision: snapshot.revision,
      sourceRun: receipt.execution.runId,
    },
    directoryListing: null,
  };
  const expected = await sandbox.bindDirectory(session, ".");
  const result = await module.runCliAutonomousGoal({
    goal: sessionCwdGoal(session, { kind: "equals", expected }),
    resources: {
      sandbox,
      session,
      profile: deterministicProfile(module),
      grantedEffects: ALL_EFFECTS,
      initialState,
      authority,
    },
  });

  assert.equal(result.domain.initialStateStatus, "trusted");
  assert.equal(result.domain.status, "satisfied");
  assert.equal(result.domain.noopSatisfied, true);
  assert.equal(result.domain.executorInvocationCount, 0);
});

test("CA1-N28 a scope bound to an unknown session is stale_scope without throwing", async t => {
  const { module, sandbox, session } = await fixture(t);
  const foreign = {
    kind: "cli.directory",
    scenarioId: session.scenarioId,
    sessionId: "no-such-session",
    path: ".",
  };
  const result = await module.runCliAutonomousGoal({
    goal: contentBytesGoal("eA==", { offset: 0, length: 1 }),
    resources: { sandbox, session, profile: deterministicProfile(module), grantedEffects: ALL_EFFECTS, scope: foreign },
  });

  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.reason, "stale_scope");
  assert.equal(result.domain.executorInvocationCount, 0);
});
