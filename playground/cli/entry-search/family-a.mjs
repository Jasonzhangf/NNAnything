import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const { createCliFilesystemSandbox, runCliEntrySearchGoal } = await import("nnanything/cli-search");

const PROFILE_PATH = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof PROFILE_PATH !== "string" || PROFILE_PATH.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE must name the existing cli.command-policy.v1 candidate");
}
const rawProfile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
const PROFILE = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);
const LIMITS = Object.freeze({ maxTransitions: 20, maxDepth: 4, maxDerivedGoals: 8 });

function request(directory, requestId, name, type) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: directory,
      requirement: {
        kind: "matches",
        predicate: { kind: "entrySelector", name, type, cardinality: "one" },
      },
    },
    satisfactionThreshold: 100,
  };
}

async function makeWorld(entries, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-entry-search-family-a-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "family-a",
      entries: [
        { path: "start", kind: "directory" },
        ...entries,
      ],
      sessions: options.sessions ?? [
        { id: "s", cwd: options.cwd ?? "start", grantedEffects: ["filesystem.read", "process.exec"] },
      ],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
  });
  const session = sandbox.bindSession(options.sessionId ?? "s");
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
  const removed = await world.sandbox.cleanup();
  await rm(world.root, { recursive: true, force: true });
  let rootGone = false;
  try {
    await lstat(world.root);
  } catch {
    rootGone = true;
  }
  return { sandboxRemoved: removed.removed, rootGone };
}

async function observeRealListing(input, failName = null) {
  const names = (await readdir(input.physicalDirectory)).sort();
  const entries = [];
  const errors = [];
  for (const name of names) {
    if (name === failName) {
      errors.push({ name, code: "EACCES", message: "controlled lstat denial" });
      continue;
    }
    const stats = await lstat(join(input.physicalDirectory, name));
    entries.push({
      name,
      path: join(input.physicalDirectory, name),
      type: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "other",
    });
  }
  return {
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "family-a-controlled-listing",
      argv: ["family-a-controlled-listing", input.physicalDirectory],
      stdout: JSON.stringify({ directory: input.physicalDirectory, entries, errors }),
      stderr: "",
      exitCode: 0,
      entries,
      coverage: errors.length === 0 ? "complete" : "partial",
      errors,
    },
  };
}

function actualOf(result) {
  const response = result.response;
  return {
    status: result.domain.status,
    resolution: result.domain.resolution,
    satisfaction: result.domain.satisfaction,
    coverage: result.domain.coverage,
    match: result.domain.match === null
      ? null
      : {
          kind: result.domain.match.kind,
          type: result.domain.match.type,
          absolutePath: result.domain.match.absolutePath,
          ino: String(result.domain.match.identity.ino),
          sessionRevision: result.domain.match.sessionRevision,
        },
    heads: response.report.atomicResults.map(item => item.sourceResult.value.policy.selectedHead),
    childSkills: response.report.atomicResults.map(item => item.skillId),
    childOutcomes: response.report.atomicResults.map(item => item.outcome),
    rootEvaluation: response.report.rootEvaluation,
    control: response.report.control,
    errorCodes: response.report.errors.map(item => item.code),
    primaryErrorId: response.report.primaryErrorId,
  };
}

const cases = [];

async function runCase(id, premise, body) {
  const started = performance.now();
  try {
    const evidence = await body();
    cases.push({ id, status: "pass", premise, actual: evidence.actual, cleanup: evidence.cleanup });
  } catch (error) {
    cases.push({
      id,
      status: "fail",
      premise,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify({ ...cases[cases.length - 1], durationMs: Math.round(performance.now() - started) })}\n`);
}

await runCase(
  "A-E01",
  "real direct file and directory hits required real inspect evidence",
  async () => {
    const world = await makeWorld([
      { path: "start/target.txt", kind: "file", contents: "must not be read" },
      { path: "start/subdir", kind: "directory" },
    ]);
    try {
      const file = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e01-file", "target.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const directory = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e01-directory", "subdir", "directory"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const fileStat = await lstat(join(world.start, "target.txt"));
      const dirStat = await lstat(join(world.start, "subdir"));
      assert.equal(file.domain.status, "achieved");
      assert.equal(file.domain.satisfaction, 100);
      assert.deepEqual(actualOf(file).heads, ["ls", "entry.inspect"]);
      assert.equal(String(file.domain.match.identity.ino), String(fileStat.ino));
      assert.equal(directory.domain.match.type, "directory");
      assert.equal(String(directory.domain.match.identity.ino), String(dirStat.ino));
      return { actual: { file: actualOf(file), directory: actualOf(directory) }, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E02",
  "a complete listing without the exact name is negative knowledge, not a found object",
  async () => {
    const world = await makeWorld([{ path: "start/other.txt", kind: "file", contents: "other" }]);
    try {
      const result = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e02", "missing.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const actual = actualOf(result);
      assert.equal(actual.status, "unmet");
      assert.equal(actual.resolution, "not_found");
      assert.equal(actual.satisfaction, 0);
      assert.deepEqual(actual.heads, ["ls"]);
      assert.equal(actual.match, null);
      return { actual, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E03",
  "a symlink with the requested name is inspected itself and never followed",
  async () => {
    const world = await makeWorld([
      { path: "start/real.txt", kind: "file", contents: "link target" },
    ]);
    try {
      await symlink("real.txt", join(world.start, "link.txt"));
      const result = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e03", "link.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const actual = actualOf(result);
      assert.equal(actual.status, "unmet");
      assert.equal(actual.resolution, "type_mismatch");
      assert.equal(actual.match, null);
      assert.equal(actual.rootEvaluation.result, "unsatisfied");
      assert.equal(result.domain.rootFact.inspect.type, "symlink");
      assert.equal(await readFile(join(world.start, "real.txt"), "utf8"), "link target");
      return { actual, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E05",
  "special names are passed as one exact string with no shell interpolation",
  async () => {
    const names = ["line\nbreak", "$(touch nope)", "-dash"];
    const world = await makeWorld(names.map(name => ({ path: `start/${name}`, kind: "file", contents: name })));
    try {
      const observations = [];
      for (const name of names) {
        const result = await runCliEntrySearchGoal(
          request(world.directory, `family-a-e05-${names.indexOf(name)}`, name, "regular"),
          { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
        );
        const actual = actualOf(result);
        assert.equal(actual.status, "achieved");
        assert.equal(basename(actual.match.absolutePath), name);
        observations.push(actual);
      }
      assert.equal((await readdir(world.start)).includes("nope"), false);
      return { actual: observations, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E07",
  "a partial listing with a same-name clue stays unknown and never inspects",
  async () => {
    const world = await makeWorld(
      [
        { path: "start/target.txt", kind: "file", contents: "do not read" },
        { path: "start/unrelated.bin", kind: "file", contents: "unrelated" },
      ],
      { listingObserver: input => observeRealListing(input, "unrelated.bin") },
    );
    try {
      const result = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e07", "target.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const actual = actualOf(result);
      assert.equal(actual.status, "unknown");
      assert.equal(actual.resolution, "insufficient_evidence");
      assert.equal(actual.satisfaction, null);
      assert.equal(actual.coverage, "partial");
      assert.deepEqual(actual.heads, ["ls"]);
      assert.equal(actual.match, null);
      assert.deepEqual(result.domain.rootFact.listing.candidateNames, ["target.txt"]);
      return { actual, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E09",
  "a listed entry removed before inspect preserves ENOENT and stays unknown",
  async () => {
    const world = await makeWorld([{ path: "start/target.txt", kind: "file", contents: "x" }]);
    try {
      const target = join(world.start, "target.txt");
      const result = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e09", "target.txt", "regular"),
        {
          sandbox: world.sandbox,
          session: world.session,
          profile: PROFILE,
          limits: LIMITS,
          onSample: async sample => {
            if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
              await rm(target, { force: true });
            }
          },
        },
      );
      const actual = actualOf(result);
      assert.equal(actual.status, "unknown");
      assert.equal(actual.resolution, "stale_or_unverified");
      assert.equal(actual.match, null);
      assert.match(JSON.stringify(result.response.report.errors), /ENOENT/);
      return { actual, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E13",
  "both child observations can succeed while the root type requirement stays unmet",
  async () => {
    const world = await makeWorld([{ path: "start/target.txt", kind: "directory" }]);
    try {
      const result = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e13", "target.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const actual = actualOf(result);
      assert.equal(actual.status, "unmet");
      assert.equal(actual.resolution, "type_mismatch");
      assert.deepEqual(actual.childOutcomes, ["succeeded", "succeeded"]);
      assert.equal(actual.rootEvaluation.result, "unsatisfied");
      assert.equal(actual.match, null);
      return { actual, cleanup: await closeWorld(world) };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

await runCase(
  "A-E14",
  "repeated evaluation makes no extra listing call and leaves cwd, entries and contents unchanged",
  async () => {
    let listingCalls = 0;
    const world = await makeWorld(
      [
        { path: "start/shared.txt", kind: "file", contents: "start" },
        { path: "other/shared.txt", kind: "file", contents: "other" },
      ],
      {
        sessions: [
          { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
          { id: "s2", cwd: "other", grantedEffects: ["filesystem.read", "process.exec"] },
        ],
        listingObserver: async input => {
          listingCalls += 1;
          return observeRealListing(input);
        },
      },
    );
    try {
      const second = world.sandbox.bindSession("s2");
      const secondDirectory = await world.sandbox.bindDirectoryObject(second, ".");
      const other = world.sandbox.getSession(second).cwd;
      const parentCwd = process.cwd();
      const startEntries = (await readdir(world.start)).sort();
      const otherEntries = (await readdir(other)).sort();
      const first = await runCliEntrySearchGoal(
        request(world.directory, "family-a-e14-first", "shared.txt", "regular"),
        { sandbox: world.sandbox, session: world.session, profile: PROFILE, limits: LIMITS },
      );
      const secondRun = await runCliEntrySearchGoal(
        request(secondDirectory, "family-a-e14-second", "shared.txt", "regular"),
        { sandbox: world.sandbox, session: second, profile: PROFILE, limits: LIMITS },
      );
      assert.equal(first.domain.status, "achieved");
      assert.equal(secondRun.domain.status, "achieved");
      assert.equal(listingCalls, 2);
      assert.equal(first.response.report.atomicResults.length, 2);
      assert.equal(secondRun.response.report.atomicResults.length, 2);
      assert.equal(first.domain.match.absolutePath, join(world.start, "shared.txt"));
      assert.equal(secondRun.domain.match.absolutePath, join(other, "shared.txt"));
      assert.equal(await readFile(join(world.start, "shared.txt"), "utf8"), "start");
      assert.equal(await readFile(join(other, "shared.txt"), "utf8"), "other");
      assert.equal(process.cwd(), parentCwd);
      assert.equal(world.sandbox.getSession(world.session).cwd, world.start);
      assert.equal(world.sandbox.getSession(second).cwd, other);
      assert.deepEqual((await readdir(world.start)).sort(), startEntries);
      assert.deepEqual((await readdir(other)).sort(), otherEntries);
      return {
        actual: { first: actualOf(first), second: actualOf(secondRun), listingCalls },
        cleanup: await closeWorld(world),
      };
    } finally {
      await world.sandbox.cleanup().catch(() => undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

const passed = cases.filter(item => item.status === "pass").length;
process.stdout.write(`${JSON.stringify({ family: "A", cases: cases.length, passed, failed: cases.length - passed })}\n`);
