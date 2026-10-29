import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCliFilesystemSandbox, runCliReadCompositionGoal } = await import("nnanything/cli-read");

const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const rawProfile = JSON.parse(await readFile(profileFile, "utf8"));
const profile = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);
const limits = Object.freeze({ maxTransitions: 23, maxDepth: 4, maxDerivedGoals: 8 });

function request(directory, name, range, expectedBase64, requestId) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: { kind: "cli.exact-child", directory, name, requiredType: "regular" },
      requirement: { kind: "equals", range, expectedBase64 },
    },
    satisfactionThreshold: 100,
  };
}

function b64(value) {
  return Buffer.from(value).toString("base64");
}

async function makeWorld(entries, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-consumer-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "read-composition-consumer",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/sub", kind: "directory" },
        ...entries,
      ],
      sessions: options.sessions ?? [
        { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
      ],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
  });
  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectoryObject(session, ".");
  return {
    sandbox,
    session,
    directory,
    root,
    start: sandbox.getSession(session).cwd,
  };
}

async function closeWorld(world) {
  await world.sandbox.cleanup();
  await rm(world.root, { recursive: true, force: true });
}

async function runCase(id, entries, readArgs, expected, options = {}) {
  const world = await makeWorld(entries, options);
  try {
    const goal = request(
      world.directory,
      readArgs.name,
      readArgs.range,
      readArgs.expectedBase64,
      `consumer-${id}`,
    );
    const result = await runCliReadCompositionGoal(goal, {
      sandbox: world.sandbox,
      session: world.session,
      profile,
      ...("limits" in options ? { limits: options.limits } : { limits }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
    });
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(result.domain[key], value, `${id}.${key}`);
    }
    return {
      id,
      status: result.domain.status,
      resolution: result.domain.resolution,
      satisfaction: result.domain.satisfaction,
      coverage: result.domain.coverage,
    };
  } finally {
    await closeWorld(world);
  }
}

const cases = [];
cases.push(await runCase(
  "matched",
  [{ path: "start/target.bin", kind: "file", contents: "abcdef" }],
  { name: "target.bin", range: { offset: 1, length: 3 }, expectedBase64: b64("bcd") },
  { status: "achieved", resolution: "matched", satisfaction: 100, coverage: "complete" },
));
cases.push(await runCase(
  "not-found",
  [{ path: "start/other.bin", kind: "file", contents: "other" }],
  { name: "absent.bin", range: { offset: 0, length: 1 }, expectedBase64: b64("x") },
  { status: "unmet", resolution: "not_found", satisfaction: 0, coverage: "complete" },
));
cases.push(await runCase(
  "type-mismatch",
  [{ path: "start/dir-name", kind: "directory" }],
  { name: "dir-name", range: { offset: 0, length: 0 }, expectedBase64: "" },
  { status: "unmet", resolution: "type_mismatch", satisfaction: 0, coverage: "complete" },
));
cases.push(await runCase(
  "byte-mismatch",
  [{ path: "start/target.bin", kind: "file", contents: "abcdef" }],
  { name: "target.bin", range: { offset: 1, length: 3 }, expectedBase64: b64("XYZ") },
  { status: "unmet", resolution: "byte_mismatch", satisfaction: 0, coverage: "complete" },
  { limits: undefined, signal: AbortSignal.timeout(15000) },
));
cases.push(await runCase(
  "zero-length",
  [{ path: "start/empty.bin", kind: "file", contents: "" }],
  { name: "empty.bin", range: { offset: 0, length: 0 }, expectedBase64: "" },
  { status: "achieved", resolution: "matched", satisfaction: 100, coverage: "complete" },
));
cases.push(await runCase(
  "short-read",
  [{ path: "start/target.bin", kind: "file", contents: "abc" }],
  { name: "target.bin", range: { offset: 2, length: 10 }, expectedBase64: b64("cxxxxxxxxx") },
  { status: "unknown", resolution: "insufficient_evidence", satisfaction: null, coverage: "complete" },
  { limits: undefined, signal: AbortSignal.timeout(15000) },
));

const staleWorld = await makeWorld([{ path: "start/target.bin", kind: "file", contents: "original" }]);
try {
  const target = join(staleWorld.start, "target.bin");
  const stale = await runCliReadCompositionGoal(
    request(
      staleWorld.directory,
      "target.bin",
      { offset: 0, length: 8 },
      b64("original"),
      "consumer-stale",
    ),
    {
      sandbox: staleWorld.sandbox,
      session: staleWorld.session,
      profile,
      limits,
      onSample: async sample => {
        if (sample.goal.property === "file.property.type" && sample.status === "achieved") {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await rm(target, { force: true });
            await writeFile(target, `replacement-${attempt}`);
            const stat = await lstat(target);
            const previous = String(sample.observed_state_after.entryKnowledge.identity.ino);
            if (String(stat.ino) !== previous) return;
          }
          throw new Error("unable to replace with a different inode");
        }
      },
    },
  );
  assert.equal(stale.domain.status, "unknown");
  assert.equal(stale.domain.resolution, "stale_or_unverified");
  assert.equal(stale.domain.satisfaction, null);
  cases.push({
    id: "stale-or-unverified",
    status: stale.domain.status,
    resolution: stale.domain.resolution,
    satisfaction: stale.domain.satisfaction,
    coverage: stale.domain.coverage,
  });
} finally {
  await closeWorld(staleWorld);
}

const budgetWorld = await makeWorld([{ path: "start/target.bin", kind: "file", contents: "abcdef" }]);
try {
  const budgetCuts = [
    {
      maxTransitions: 20,
      range: { offset: 0, length: 6 },
      expectedBase64: b64("abcdef"),
      readBytes: b64("abcdef"),
      rootResult: null,
    },
    {
      maxTransitions: 23,
      range: { offset: 1, length: 3 },
      expectedBase64: b64("XYZ"),
      readBytes: b64("bcd"),
      rootResult: "unsatisfied",
    },
  ];
  for (const cut of budgetCuts) {
    const result = await runCliReadCompositionGoal(
      request(
        budgetWorld.directory,
        "target.bin",
        cut.range,
        cut.expectedBase64,
        `consumer-budget-exhausted-${cut.maxTransitions}`,
      ),
      {
        sandbox: budgetWorld.sandbox,
        session: budgetWorld.session,
        profile,
        limits: { maxTransitions: cut.maxTransitions, maxDepth: 4, maxDerivedGoals: 8 },
      },
    );
    assert.equal(result.domain.status, "unknown");
    assert.equal(result.domain.resolution, "budget_exhausted");
    assert.equal(result.domain.satisfaction, null);
    assert.equal(result.response.report.control.budget.dimension, "maxTransitions");
    assert.equal(result.response.report.control.budget.limit, cut.maxTransitions);
    assert.equal(result.domain.rootFact.read.bytes, cut.readBytes);
    assert.deepEqual(
      result.domain.preserve.rootEvaluation,
      result.response.report.rootEvaluation,
      "the root evaluation must be preserved on a budget stop",
    );
    if (cut.rootResult !== null) {
      assert.equal(result.response.report.rootEvaluation.result, cut.rootResult);
    }
    cases.push({
      id: `budget-exhausted-${cut.maxTransitions}`,
      status: result.domain.status,
      resolution: result.domain.resolution,
      satisfaction: result.domain.satisfaction,
      coverage: result.domain.coverage,
    });
  }
} finally {
  await closeWorld(budgetWorld);
}

process.stdout.write(JSON.stringify({ consumer: "public", exitCode: 0, cases }) + "\n");
