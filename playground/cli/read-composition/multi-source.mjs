import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { createCliFilesystemSandbox, runCliReadCompositionGoal } = await import("nnanything/cli-read");
const recursive = await import("nnanything/recursive-goal");

const envNames = ["NN_HANDWIRED_ROOT", "NN_CLI_COMMAND_PROFILE", "NN_CWD_RELATION_PROFILE"];
const env = Object.freeze(Object.fromEntries(envNames.map(name => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return [name, value];
})));
const rawProfile = JSON.parse(await readFile(env.NN_CLI_COMMAND_PROFILE, "utf8"));
const profile = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);
const limits = Object.freeze({ maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 12 });

const GOOD = "GOOD";
const BAD = "BAD!";
const EVIL = "EVIL";
const RANGE = Object.freeze({ offset: 0, length: 4 });
const b64 = value => Buffer.from(value).toString("base64");

function multiRequest(sources, name, expected, requestId) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: { kind: "cli.exact-child-sources", sources, name, requiredType: "regular" },
      requirement: { kind: "equals", range: RANGE, expectedBase64: b64(expected) },
    },
    satisfactionThreshold: 100,
  };
}

async function makeWorld(entries, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-multi-consumer-")));
  let opens = 0;
  const ioHooks = options.ioHooks ?? {};
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "read-multi-consumer",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/a", kind: "directory" },
        { path: "start/b", kind: "directory" },
        ...entries,
      ],
      sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
    fileReadIo: {
      lstat: async (path, optionsValue) => (await import("node:fs/promises")).lstat(path, optionsValue),
      open: async (path, flags) => {
        opens += 1;
        if (ioHooks.beforeOpen !== undefined) await ioHooks.beforeOpen(path);
        const handle = await open(path, flags);
        if (ioHooks.afterOpen !== undefined) await ioHooks.afterOpen(path, flags, handle);
        return handle;
      },
    },
  });
  const session = sandbox.bindSession("s");
  const refA = await sandbox.bindDirectoryObject(session, "a");
  const refB = await sandbox.bindDirectoryObject(session, "b");
  const startAbs = sandbox.getSession(session).cwd;
  return { sandbox, session, refA, refB, profile, startAbs, openCount: () => opens };
}

async function closeWorld(world) {
  await world.sandbox.cleanup();
}

function ordered(refA, refB, orderA, orderB) {
  return [
    { directory: refA, ...(orderA === undefined ? {} : { order: orderA }) },
    { directory: refB, ...(orderB === undefined ? {} : { order: orderB }) },
  ];
}

async function run(world, request, options = {}) {
  return runCliReadCompositionGoal(request, {
    sandbox: world.sandbox,
    session: world.session,
    profile: world.profile,
    limits,
    ...(options.decision === undefined ? {} : { decision: options.decision }),
  });
}

function sourceById(result, sourceId) {
  const source = result.domain.sources.find(item => item.sourceId === sourceId);
  assert.ok(source, `domain.sources must contain ${sourceId}`);
  return source;
}

const cases = [];

// 1. preferred matches the expected bytes directly (order_first picks source:0).
{
  const world = await makeWorld([
    { path: "start/a/target.bin", kind: "file", contents: GOOD },
    { path: "start/b/target.bin", kind: "file", contents: GOOD },
  ]);
  try {
    const result = await run(world, multiRequest(ordered(world.refA, world.refB, 0, 1), "target.bin", GOOD, "consumer-order-first"));
    assert.equal(result.domain.status, "achieved");
    assert.equal(result.domain.resolution, "matched");
    assert.equal(result.domain.satisfaction, 100);
    assert.equal(result.domain.decision?.chosen, "source:0");
    assert.equal(result.domain.match.absolutePath, join(world.startAbs, "a", "target.bin"));
    assert.equal(world.openCount(), 1, "matched preferred must open once");
    cases.push({ id: "order-first-matched", status: result.domain.status, chosen: result.domain.decision.chosen });
  } finally {
    await closeWorld(world);
  }
}

// 2. preferred is a symlink (type mismatch); fallback reads the alternate and matches.
{
  const world = await makeWorld([
    { path: "start/a/real.bin", kind: "file", contents: GOOD },
    { path: "start/b/target.bin", kind: "file", contents: GOOD },
  ]);
  try {
    await symlink("real.bin", join(world.startAbs, "a", "target.bin"));
    const result = await run(world, multiRequest(ordered(world.refA, world.refB, 0, 1), "target.bin", GOOD, "consumer-fallback"));
    assert.equal(result.domain.status, "achieved");
    assert.equal(result.domain.decision?.chosen, "source:0");
    assert.equal(sourceById(result, "source:0").negative, "type_mismatch");
    assert.equal(sourceById(result, "source:1").attempt, "matched");
    assert.equal(world.openCount(), 1, "type mismatch must not open a read");
    cases.push({ id: "fallback-type-mismatch", status: result.domain.status, source1: sourceById(result, "source:1").attempt });
  } finally {
    await closeWorld(world);
  }
}

// 3. preferred is replaced before open; read refuses the changed identity and the
//    alternate matches, so the root stays achieved while source:0 is unknown.
{
  let swapped = false;
  const world2 = await makeWorld([
    { path: "start/a/target.bin", kind: "file", contents: GOOD },
    { path: "start/a/swap.bin", kind: "file", contents: EVIL },
    { path: "start/b/target.bin", kind: "file", contents: GOOD },
  ], {
    ioHooks: {
      beforeOpen: async path => {
        if (swapped || path !== join(world2.startAbs, "a", "target.bin")) return;
        swapped = true;
        const directory = dirname(path);
        await rename(join(directory, "target.bin"), join(directory, "original.bin"));
        await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
      },
    },
  });
  try {
    const result = await run(world2, multiRequest(ordered(world2.refA, world2.refB, 0, 1), "target.bin", GOOD, "consumer-stale-fallback"));
    assert.equal(result.domain.status, "achieved");
    assert.equal(sourceById(result, "source:0").attempt, "unknown");
    assert.equal(sourceById(result, "source:1").attempt, "matched");
    assert.equal(JSON.stringify(result.domain).includes(b64(EVIL)), false, "replacement bytes must not leak");
    cases.push({ id: "stale-refused-fallback", status: result.domain.status, source0: sourceById(result, "source:0").attempt });
  } finally {
    await closeWorld(world2);
  }
}

// 4. both sources are byte mismatches -> unmet, never a partial score.
{
  const world = await makeWorld([
    { path: "start/a/target.bin", kind: "file", contents: BAD },
    { path: "start/b/target.bin", kind: "file", contents: "WRS!" },
  ]);
  try {
    const result = await run(world, multiRequest(ordered(world.refA, world.refB, 0, 1), "target.bin", GOOD, "consumer-both-mismatch"));
    assert.equal(result.domain.status, "unmet");
    assert.equal(result.domain.resolution, "byte_mismatch");
    assert.equal(result.domain.satisfaction, 0);
    cases.push({ id: "both-byte-mismatch", status: result.domain.status, resolution: result.domain.resolution });
  } finally {
    await closeWorld(world);
  }
}

// 5. no order declared -> defer before any inspect/read, unknown root.
{
  const world = await makeWorld([
    { path: "start/a/target.bin", kind: "file", contents: GOOD },
    { path: "start/b/target.bin", kind: "file", contents: GOOD },
  ]);
  try {
    const result = await run(world, multiRequest(ordered(world.refA, world.refB), "target.bin", GOOD, "consumer-defer"));
    assert.equal(result.domain.status, "unknown");
    assert.equal(result.domain.resolution, "insufficient_evidence");
    assert.equal(result.domain.decision?.kind, "defer");
    assert.ok(result.domain.decision?.missingKeys.includes("rankOrder"));
    assert.equal(world.openCount(), 0, "defer must not open");
    cases.push({ id: "defer-no-order", status: result.domain.status, decision: result.domain.decision.kind });
  } finally {
    await closeWorld(world);
  }
}

// 6. Handwired order weights reverse the chosen source; both still achieve.
{
  const world = await makeWorld([
    { path: "start/a/target.bin", kind: "file", contents: GOOD },
    { path: "start/b/target.bin", kind: "file", contents: GOOD },
  ]);
  try {
    const orderFirstProfile = planningProfile(recursive, -1, "order-first");
    const reversedProfile = planningProfile(recursive, 1, "reversed");
    for (const profile of [orderFirstProfile, reversedProfile]) {
      assert.equal(profile.calibration, "uncalibrated");
      assert.equal(profile.adoption, "not_applied");
    }
    const orderFirstBinding = await recursive.createHandwiredPlanningDecisionBinding({
      kind: "planning_decision.handwired.v1",
      profile: orderFirstProfile,
      handwiredRoot: env.NN_HANDWIRED_ROOT,
    });
    const reversedBinding = await recursive.createHandwiredPlanningDecisionBinding({
      kind: "planning_decision.handwired.v1",
      profile: reversedProfile,
      handwiredRoot: env.NN_HANDWIRED_ROOT,
    });
    const request = multiRequest(ordered(world.refA, world.refB, 0, 1), "target.bin", GOOD, "consumer-handwired");
    const orderFirst = await run(world, request, { decision: orderFirstBinding });
    const reversed = await run(world, request, { decision: reversedBinding });
    assert.equal(orderFirst.domain.status, "achieved");
    assert.equal(reversed.domain.status, "achieved");
    assert.equal(orderFirst.domain.decision?.chosen, "source:0");
    assert.equal(reversed.domain.decision?.chosen, "source:1");
    cases.push({ id: "handwired-reversal", orderFirst: orderFirst.domain.decision.chosen, reversed: reversed.domain.decision.chosen });
  } finally {
    await closeWorld(world);
  }
}

// 7. read-less session is rejected with zero execution.
{
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-multi-reject-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "read-multi-consumer",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/a", kind: "directory" },
        { path: "start/b", kind: "directory" },
        { path: "start/a/target.bin", kind: "file", contents: GOOD },
        { path: "start/b/target.bin", kind: "file", contents: BAD },
      ],
      sessions: [{ id: "s", cwd: "start", grantedEffects: ["process.exec"] }],
    },
  });
  try {
    const session = sandbox.bindSession("s");
    const refA = await sandbox.bindDirectory(session, "a");
    const refB = await sandbox.bindDirectory(session, "b");
    const result = await runCliReadCompositionGoal(
      multiRequest([{ directory: refA, order: 0 }, { directory: refB, order: 1 }], "target.bin", GOOD, "consumer-readless"),
      { sandbox, session, profile, limits },
    );
    assert.equal(result.response.kind, "request_rejected");
    assert.equal(result.domain.status, "rejected");
    cases.push({ id: "read-less-rejected", kind: result.response.kind });
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

function planningProfile(recursive, rankOrderWeight, unitVersion) {
  const weights = Array(recursive.PLANNING_DECISION_WIRES.length).fill(0);
  const rankOrderIndex = recursive.PLANNING_DECISION_WIRES.indexOf("rankOrder.value");
  assert.notEqual(rankOrderIndex, -1, "rankOrder.value wire must exist");
  weights[rankOrderIndex] = rankOrderWeight;
  return {
    contract: recursive.PLANNING_DECISION_CONTRACT,
    providerRef: { id: "test.consumer.planning.handwired", version: "1" },
    unitRef: { id: `test.consumer.ranking.${unitVersion}`, version: "1" },
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

process.stdout.write(JSON.stringify({ consumer: "public-multi-source", exitCode: 0, cases }) + "\n");
