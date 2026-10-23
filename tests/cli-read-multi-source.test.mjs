import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = Object.freeze({
  maxTransitions: 64,
  maxDepth: 4,
  maxDerivedGoals: 12,
});

const GOOD = "GOOD";
const BAD = "BAD!";
const WORSE = "WRS!";
const RANGE = Object.freeze({ offset: 0, length: 4 });

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function requireEnvironment() {
  const names = [
    "NN_HANDWIRED_ROOT",
    "NN_CLI_COMMAND_PROFILE",
    "NN_CWD_RELATION_PROFILE",
  ];
  const values = {};
  for (const name of names) {
    const value = process.env[name];
    assert.equal(typeof value, "string", `${name} must be set explicitly for P4b`);
    assert.notEqual(value.length, 0, `${name} must not be empty`);
    values[name] = value;
  }
  return Object.freeze({
    handwiredRoot: values.NN_HANDWIRED_ROOT,
    commandProfile: values.NN_CLI_COMMAND_PROFILE,
    cwdRelationProfile: values.NN_CWD_RELATION_PROFILE,
  });
}

function makeCountingIo(hooks = {}) {
  let opens = 0;
  const io = {
    lstat: async (path, options) => {
      if (hooks.beforeLstat !== undefined) await hooks.beforeLstat(path, options);
      return lstat(path, options);
    },
    open: async (path, flags) => {
      opens += 1;
      if (hooks.beforeOpen !== undefined) await hooks.beforeOpen(path, flags);
      const handle = await open(path, flags);
      if (hooks.afterOpen !== undefined) await hooks.afterOpen(path, flags, handle);
      return handle;
    },
  };
  return { io, count: () => opens };
}

async function fixture(t, options = {}) {
  const env = requireEnvironment();
  const module = await import("nnanything/cli-read");
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-multi-source-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const counter = makeCountingIo(options.ioHooks);
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "read-multi-source",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/a", kind: "directory" },
        { path: "start/b", kind: "directory" },
        ...(options.entries ?? []),
      ],
      sessions: options.sessions ?? [
        {
          id: "s",
          cwd: "start",
          grantedEffects: ["filesystem.read", "process.exec"],
        },
      ],
    },
    ...(options.listingObserver === undefined
      ? {}
      : { listingObserver: options.listingObserver }),
    fileReadIo: counter.io,
  });
  t.after(async () => {
    await sandbox.cleanup();
  });

  const session = sandbox.bindSession(options.sessionId ?? "s");
  const bindingSession =
    options.bindSessionId === undefined
      ? session
      : sandbox.bindSession(options.bindSessionId);
  const bindDirectoryObject = options.legacyDirectoryBindings
    ? (targetSession, path) => sandbox.bindDirectory(targetSession, path)
    : (targetSession, path) => sandbox.bindDirectoryObject(targetSession, path);
  const refA = await bindDirectoryObject(bindingSession, "a");
  const refB = await bindDirectoryObject(bindingSession, "b");

  const profile = JSON.parse(await readFile(env.commandProfile, "utf8"));
  const startAbs = sandbox.getSession(session).cwd;
  const startEntries = await readdir(startAbs);
  return {
    module,
    env,
    sandbox,
    session,
    refA,
    refB,
    profile,
    startAbs,
    startEntries,
    cwdBefore: sandbox.getSession(session).cwd,
    openCount: counter.count,
  };
}

function orderedSources(refA, refB, orderA, orderB) {
  return [
    {
      directory: refA,
      ...(orderA === undefined ? {} : { order: orderA }),
    },
    {
      directory: refB,
      ...(orderB === undefined ? {} : { order: orderB }),
    },
  ];
}

function multiSourceRequest(sources, name, range, expectedBase64, requestId) {
  return {
    requestId: requestId ?? `read-multi-source-${name}`,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.exact-child-sources",
        sources,
        name,
        requiredType: "regular",
      },
      requirement: {
        kind: "equals",
        range,
        expectedBase64,
      },
    },
    satisfactionThreshold: 100,
  };
}

function runWith(fixtureValue, request, options = {}) {
  return fixtureValue.module.runCliReadCompositionGoal(request, {
    sandbox: fixtureValue.sandbox,
    session: options.session ?? fixtureValue.session,
    profile: options.profile ?? fixtureValue.profile,
    limits: options.limits ?? LIMITS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
  });
}

function assertRoot(result, status, resolution, satisfaction) {
  assert.equal(result.domain.status, status, "root status");
  assert.equal(result.domain.resolution, resolution, "root resolution");
  assert.equal(result.domain.satisfaction, satisfaction, "root satisfaction");
}

function sourceById(result, sourceId) {
  assert.ok(Array.isArray(result.domain.sources), "domain.sources must be an array");
  const source = result.domain.sources.find(item => item.sourceId === sourceId);
  assert.ok(source, `domain.sources must contain ${sourceId}`);
  return source;
}

function commandTransitions(response) {
  return (response.report?.atomicResults ?? []).filter(
    result => result.sourceResult?.tag === "cli.command.transition.v1",
  );
}

function heads(response) {
  return commandTransitions(response).map(
    result => result.sourceResult.value.policy.selectedHead,
  );
}

function collectStatePaths(value, key, output, seen) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStatePaths(item, key, output, seen);
    return;
  }
  const fact = value[key];
  if (fact !== null && typeof fact === "object") {
    if (typeof fact.path === "string") output.add(fact.path);
    if (typeof fact.absolutePath === "string") output.add(fact.absolutePath);
  }
  for (const child of Object.values(value)) {
    collectStatePaths(child, key, output, seen);
  }
}

function statePaths(response, key) {
  const output = new Set();
  for (const record of response.report?.states ?? []) {
    collectStatePaths(record, key, output, new Set());
  }
  return [...output].sort();
}

async function assertNoSideEffects(fixtureValue) {
  const entries = await readdir(fixtureValue.startAbs);
  assert.deepEqual(
    [...entries].sort(),
    [...fixtureValue.startEntries].sort(),
    "start directory entries must not change",
  );
  assert.equal(
    fixtureValue.sandbox.getSession(fixtureValue.session).cwd,
    fixtureValue.cwdBefore,
    "session cwd must not change",
  );
}

async function observeRealListing(input) {
  const names = (await readdir(input.physicalDirectory)).sort();
  const entries = [];
  const errors = [];
  for (const name of names) {
    const stats = await lstat(join(input.physicalDirectory, name));
    entries.push({
      name,
      path: join(input.physicalDirectory, name),
      type: stats.isDirectory()
        ? "directory"
        : stats.isSymbolicLink()
          ? "symlink"
          : stats.isFile()
            ? "file"
            : "other",
    });
  }
  return {
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "p4b-real-listing",
      argv: ["p4b-real-listing", input.physicalDirectory],
      stdout: JSON.stringify({
        directory: input.physicalDirectory,
        entries,
        errors,
      }),
      stderr: "",
      exitCode: 0,
      entries,
      coverage: "complete",
      errors,
    },
  };
}

function planningProfile(recursive, rankOrderWeight, unitVersion) {
  const weights = Array(recursive.PLANNING_DECISION_WIRES.length).fill(0);
  const rankOrderIndex = recursive.PLANNING_DECISION_WIRES.indexOf("rankOrder.value");
  assert.notEqual(rankOrderIndex, -1, "rankOrder.value wire must exist");
  weights[rankOrderIndex] = rankOrderWeight;
  return {
    contract: recursive.PLANNING_DECISION_CONTRACT,
    providerRef: { id: "test.p4b.planning.handwired", version: "1" },
    unitRef: { id: `test.p4b.ranking.${unitVersion}`, version: "1" },
    wireSchemaVersion: recursive.PLANNING_DECISION_WIRE_SCHEMA_VERSION,
    wires: [...recursive.PLANNING_DECISION_WIRES],
    featureRange: { min: 0, max: 1 },
    weights,
    normalization: {
      satisfaction: { min: 0, max: 1 },
      risk: { scaleRef: { id: "risk", version: "1" }, maxOrdinal: 4 },
      cost: { unit: "step", min: 0, max: 10 },
      rankOrder: { min: 0, max: 2 },
    },
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
}

test("M01 preferred source matches and leaves the alternate unattempted", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  assert.equal(result.domain.decision?.kind, "ranked");
  assert.equal(result.domain.decision?.chosen, "source:0");
  assert.equal(sourceById(result, "source:1").attempt, "not_attempted");
  assert.equal(value.openCount(), 1, "only the chosen source is read");
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "a", "target.bin"),
  );
});

test("M02 preferred byte mismatch falls back to the alternate match", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  assert.equal(result.domain.decision?.chosen, "source:0");
  const first = sourceById(result, "source:0");
  assert.equal(first.attempt, "definitive_negative");
  assert.equal(first.negative, "byte_mismatch");
  const second = sourceById(result, "source:1");
  assert.equal(second.attempt, "matched");
  assert.equal(second.negative, null);
  assert.equal(value.openCount(), 2, "one read per attempted source");
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "b", "target.bin"),
  );
});

test("M03 preferred type mismatch falls back to the alternate regular file", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/real.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  await symlink("real.bin", join(value.startAbs, "a", "target.bin"));
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  assert.equal(sourceById(result, "source:0").negative, "type_mismatch");
  assert.equal(sourceById(result, "source:1").attempt, "matched");
  assert.equal(value.openCount(), 1, "type mismatch must not open a read");
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "b", "target.bin"),
  );
});

test("M04 both sources are byte mismatches", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: WORSE },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "unmet", "byte_mismatch", 0);
  assert.equal(sourceById(result, "source:0").negative, "byte_mismatch");
  assert.equal(sourceById(result, "source:1").negative, "byte_mismatch");
  assert.equal(value.openCount(), 2);
});

test("M05 both complete listings are missing the exact name", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/other.bin", kind: "file", contents: GOOD },
      { path: "start/b/other.bin", kind: "file", contents: BAD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "unmet", "not_found", 0);
  assert.ok(
    result.domain.decision === null || result.domain.decision.kind === "ranked",
    "missing candidates may produce a null or ranked decision",
  );
  assert.equal(value.openCount(), 0);
  assert.deepEqual(heads(result.response), ["ls", "ls"]);
});

test("M06 absent source plus byte mismatch keeps byte_mismatch precedence", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/other.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "unmet", "byte_mismatch", 0);
  assert.equal(value.openCount(), 1, "the absent source is never read");
  assert.equal(sourceById(result, "source:0").negative, "not_found");
  assert.equal(sourceById(result, "source:1").negative, "byte_mismatch");
});

test("M07 short preferred read stays unknown while fallback matches", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: "GO" },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  const first = sourceById(result, "source:0");
  assert.equal(first.attempt, "unknown");
  assert.equal(first.negative, null);
  assert.equal(sourceById(result, "source:1").attempt, "matched");
  assert.equal(value.openCount(), 2);
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "b", "target.bin"),
  );
});

test("M08 preferred replacement before open is unknown and never returns replacement bytes", async t => {
  const hooks = {};
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/a/swap.bin", kind: "file", contents: "EVIL" },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    ioHooks: hooks,
  });
  const aTarget = join(value.startAbs, "a", "target.bin");
  let swapped = false;
  hooks.beforeOpen = async path => {
    if (swapped || path !== aTarget) return;
    swapped = true;
    const directory = dirname(path);
    await rename(join(directory, "target.bin"), join(directory, "original.bin"));
    await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
  };
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  assert.equal(swapped, true);
  assert.equal(sourceById(result, "source:0").attempt, "unknown");
  assert.equal(sourceById(result, "source:1").attempt, "matched");
  assert.equal(value.openCount(), 2);
  assert.equal(
    JSON.stringify(result.domain).includes(b64("EVIL")),
    false,
    "replacement bytes must not be returned",
  );
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "b", "target.bin"),
  );
});

test("M09 stale preferred source plus definitive alternate negative stays unknown", async t => {
  const hooks = {};
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/a/swap.bin", kind: "file", contents: "EVIL" },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
    ioHooks: hooks,
  });
  const aTarget = join(value.startAbs, "a", "target.bin");
  let swapped = false;
  hooks.beforeOpen = async path => {
    if (swapped || path !== aTarget) return;
    swapped = true;
    const directory = dirname(path);
    await rename(join(directory, "target.bin"), join(directory, "original.bin"));
    await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
  };
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "unknown", "stale_or_unverified", null);
  assert.equal(result.domain.match, null);
  assert.equal(sourceById(result, "source:0").attempt, "unknown");
  assert.equal(sourceById(result, "source:1").negative, "byte_mismatch");
  assert.equal(value.openCount(), 2);
  assert.notEqual(result.domain.satisfaction, 0, "an unknown source must not become 0");
});

test("M10 declared order selects the second source for inspect and read", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 1, 0),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "achieved", "matched", 100);
  assert.equal(result.domain.decision?.chosen, "source:1");
  assert.equal(sourceById(result, "source:0").attempt, "not_attempted");
  assert.equal(value.openCount(), 1);
  assert.equal(
    result.domain.match.absolutePath,
    join(value.startAbs, "b", "target.bin"),
  );
  assert.ok(
    statePaths(result.response, "candidate").includes(
      join(value.startAbs, "b", "target.bin"),
    ),
    "states must contain the chosen candidate path",
  );
});

test("M11 two legal candidates without order defer before any inspect or read", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assertRoot(result, "unknown", "insufficient_evidence", null);
  assert.equal(result.domain.decision?.kind, "defer");
  assert.ok(
    result.domain.decision?.missingKeys?.includes("rankOrder"),
    "defer must report the missing rank order",
  );
  assert.equal(value.openCount(), 0);
  assert.deepEqual(heads(result.response), ["ls", "ls"]);
});

test("M12 Handwired order weights reverse the chosen source without changing the root fact", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const recursive = await import("nnanything/recursive-goal");
  assert.equal(typeof recursive.createHandwiredPlanningDecisionBinding, "function");
  const orderFirstProfile = planningProfile(recursive, -1, "order-first");
  const reversedProfile = planningProfile(recursive, 1, "reversed");
  for (const [label, profile] of [
    ["order-first", orderFirstProfile],
    ["reversed", reversedProfile],
  ]) {
    assert.equal(profile.calibration, "uncalibrated", `${label} calibration`);
    assert.equal(profile.adoption, "not_applied", `${label} adoption`);
  }
  const orderFirstBinding = await recursive.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: orderFirstProfile,
    handwiredRoot: value.env.handwiredRoot,
  });
  const reversedBinding = await recursive.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: reversedProfile,
    handwiredRoot: value.env.handwiredRoot,
  });
  const request = multiSourceRequest(
    orderedSources(value.refA, value.refB, 0, 1),
    "target.bin",
    RANGE,
    b64(GOOD),
    "m12-handwired",
  );
  const orderFirst = await runWith(value, request, { decision: orderFirstBinding });
  const reversed = await runWith(value, request, { decision: reversedBinding });
  assertRoot(orderFirst, "achieved", "matched", 100);
  assertRoot(reversed, "achieved", "matched", 100);
  assert.equal(orderFirst.domain.decision?.chosen, "source:0");
  assert.equal(reversed.domain.decision?.chosen, "source:1");
  assert.notEqual(
    orderFirst.domain.decision?.chosen,
    reversed.domain.decision?.chosen,
    "Handwired weights must reverse the chosen source",
  );
  assert.equal(orderFirst.domain.rootFact?.kind, "matched");
  assert.equal(reversed.domain.rootFact?.kind, "matched");
});

test("M13 forged and stale source references are rejected with zero execution", async t => {
  let listings = 0;
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
    listingObserver: async input => {
      listings += 1;
      return observeRealListing(input);
    },
  });
  const forged = {
    kind: "cli.directory",
    scenarioId: "other",
    sessionId: value.session.sessionId,
    path: "a",
  };
  const stale = {
    ...value.refA,
    sessionRevision: value.refA.sessionRevision + 1,
  };
  for (const [label, replacement] of [
    ["forged", forged],
    ["stale", stale],
  ]) {
    const request = multiSourceRequest(
      [{ directory: replacement, order: 0 }, { directory: value.refB, order: 1 }],
      "target.bin",
      RANGE,
      b64(GOOD),
      `m13-${label}`,
    );
    const result = await runWith(value, request);
    assert.equal(result.response.kind, "request_rejected", `${label} response kind`);
    assertRoot(result, "rejected", "rejected", null);
    assert.equal(result.domain.match, null);
  }
  assert.equal(listings, 0, "rejected references must not list");
  assert.equal(value.openCount(), 0, "rejected references must not open");
});

test("M14 two references to the same directory are rejected with zero execution", async t => {
  let listings = 0;
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
    ],
    listingObserver: async input => {
      listings += 1;
      return observeRealListing(input);
    },
  });
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refA, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assert.equal(result.response.kind, "request_rejected");
  assertRoot(result, "rejected", "rejected", null);
  assert.equal(listings, 0);
  assert.equal(value.openCount(), 0);
});

test("M15 a read-less session is rejected with zero open", async t => {
  let listings = 0;
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
    sessions: [
      {
        id: "s",
        cwd: "start",
        grantedEffects: ["process.exec"],
      },
    ],
    legacyDirectoryBindings: true,
    listingObserver: async input => {
      listings += 1;
      return observeRealListing(input);
    },
  });
  assert.deepEqual(
    value.sandbox.getSession(value.session).grantedEffects,
    ["process.exec"],
  );
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assert.equal(result.response.kind, "request_rejected");
  assertRoot(result, "rejected", "rejected", null);
  assert.equal(listings, 0);
  assert.equal(value.openCount(), 0);
});

test("M16 a budget of N-1 stops after the preferred chain without a partial score", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const sources = orderedSources(value.refA, value.refB, 0, 1);
  const baseline = await runWith(
    value,
    multiSourceRequest(sources, "target.bin", RANGE, b64(GOOD), "m16-baseline"),
  );
  assertRoot(baseline, "achieved", "matched", 100);
  const atomicCount = baseline.response.report.atomicResults.length;
  assert.ok(atomicCount > 0, "the baseline must execute real atomic results");
  const budgetResult = await runWith(
    value,
    multiSourceRequest(sources, "target.bin", RANGE, b64(GOOD), "m16-budget"),
    {
      limits: Object.freeze({
        maxTransitions: atomicCount - 1,
        maxDepth: 4,
        maxDerivedGoals: 12,
      }),
    },
  );
  assertRoot(budgetResult, "unknown", "interrupted", null);
  assert.equal(budgetResult.domain.match, null);
  assert.notEqual(budgetResult.domain.satisfaction, 0);
  assert.notEqual(budgetResult.domain.satisfaction, 100);
});

test("M17 cancellation before the alternate chain keeps the preferred source facts", async t => {
  const controller = new AbortController();
  const hooks = {};
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    ioHooks: hooks,
  });
  const aTarget = join(value.startAbs, "a", "target.bin");
  const bTarget = join(value.startAbs, "b", "target.bin");
  let aborted = false;
  hooks.afterOpen = async path => {
    if (aborted || path !== bTarget) return;
    aborted = true;
    controller.abort();
  };
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
    { signal: controller.signal },
  );
  assert.equal(aborted, true, "the alternate read must be the abort point");
  assertRoot(result, "unknown", "interrupted", null);
  assert.equal(result.domain.match, null);
  assert.equal(
    sourceById(result, "source:0").negative,
    "byte_mismatch",
    "the preferred chain fact must survive cancellation",
  );
  assert.equal(value.openCount(), 2, "the preferred read and the alternate open must be visible");
  assert.ok(
    statePaths(result.response, "candidate").includes(aTarget),
    "the preferred candidate path must survive cancellation",
  );
  assert.ok(
    statePaths(result.response, "inspected").includes(aTarget),
    "the preferred inspected path must survive cancellation",
  );
  assert.notEqual(result.domain.satisfaction, 0);
  assert.notEqual(result.domain.satisfaction, 100);
});

test("M18 a real preferred read failure stays failed and does not fall back", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  });
  const aTarget = join(value.startAbs, "a", "target.bin");
  await chmod(aTarget, 0o000);
  try {
    const result = await runWith(
      value,
      multiSourceRequest(
        orderedSources(value.refA, value.refB, 0, 1),
        "target.bin",
        RANGE,
        b64(GOOD),
      ),
    );
    assertRoot(result, "failed", "failed", null);
    assert.equal(result.domain.match, null);
    assert.equal(sourceById(result, "source:1").attempt, "not_attempted");
    assert.match(
      JSON.stringify(result.domain.preserve.errors),
      /EACCES/,
      "the real errno must be preserved",
    );
    assert.equal(value.openCount(), 1, "the alternate source must not be opened");
  } finally {
    await chmod(aTarget, 0o600);
  }
});

test("M19 successful and failed runs leave the start directory and cwd unchanged", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
  });
  const success = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
      "m19-success",
    ),
  );
  assertRoot(success, "achieved", "matched", 100);
  await assertNoSideEffects(value);

  const failure = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "absent.bin",
      RANGE,
      b64(GOOD),
      "m19-failure",
    ),
  );
  assertRoot(failure, "unmet", "not_found", 0);
  await assertNoSideEffects(value);
});

test("M20 the existing single-source suite keeps exactly 21 tests", async () => {
  const file = fileURLToPath(new URL("./cli-read-composition.test.mjs", import.meta.url));
  const text = await readFile(file, "utf8");
  const count = text.split('test("').length - 1;
  assert.equal(count, 21, "the single-source regression suite must stay fixed at 21 tests");
});

test("M21 two definitive negatives stopped before root evaluation stay unknown", async t => {
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: WORSE },
    ],
  });
  const sources = orderedSources(value.refA, value.refB, 0, 1);
  const baseline = await runWith(
    value,
    multiSourceRequest(sources, "target.bin", RANGE, b64(GOOD), "m21-baseline"),
  );
  assertRoot(baseline, "unmet", "byte_mismatch", 0);
  const used = baseline.response.report.budgetUsed.transitionsUsed;
  assert.ok(Number.isInteger(used) && used > 0, "the baseline must record real transitions");
  for (const cut of [used - 6, used - 3]) {
    const result = await runWith(
      value,
      multiSourceRequest(sources, "target.bin", RANGE, b64(GOOD), `m21-budget-${cut}`),
      {
        limits: Object.freeze({
          maxTransitions: cut,
          maxDepth: 4,
          maxDerivedGoals: 12,
        }),
      },
    );
    const root = result.response.report.rootEvaluation;
    const completedUnsatisfied = root?.state === "evaluated" && root.result === "unsatisfied";
    if (completedUnsatisfied) {
      assertRoot(result, "unmet", "byte_mismatch", 0);
    } else {
      assertRoot(result, "unknown", "interrupted", null);
      assert.equal(result.domain.match, null);
      assert.notEqual(result.domain.satisfaction, 0, "an unfinished root evaluation must not score 0");
      assert.notEqual(result.domain.satisfaction, 100);
    }
  }
});

test("M22 a replaced alternate directory is rejected before fallback dispatch", async t => {
  const hooks = {};
  let listings = 0;
  const value = await fixture(t, {
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
      { path: "start/b-swap", kind: "directory" },
      { path: "start/b-swap/target.bin", kind: "file", contents: GOOD },
    ],
    ioHooks: hooks,
    listingObserver: async input => {
      listings += 1;
      return observeRealListing(input);
    },
  });
  const aTarget = join(value.startAbs, "a", "target.bin");
  let swapped = false;
  hooks.beforeOpen = async path => {
    if (swapped || path !== aTarget) return;
    swapped = true;
    await rename(join(value.startAbs, "b"), join(value.startAbs, "b-old"));
    await rename(join(value.startAbs, "b-swap"), join(value.startAbs, "b"));
  };
  const result = await runWith(
    value,
    multiSourceRequest(
      orderedSources(value.refA, value.refB, 0, 1),
      "target.bin",
      RANGE,
      b64(GOOD),
    ),
  );
  assert.equal(swapped, true, "the alternate directory must be replaced at the preferred open");
  assertRoot(result, "rejected", "rejected", null);
  assert.equal(result.domain.match, null);
  assert.equal(sourceById(result, "source:1").attempt, "not_attempted");
  assert.equal(listings, 2, "a stale alternate must not trigger another listing");
  assert.equal(value.openCount(), 1, "the alternate source must not be opened");
});
