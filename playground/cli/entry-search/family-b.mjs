import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
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

// Family B is a separate consumer implementation. It uses only the package
// public entry and node built-ins, and it does not import or copy family A.
const { createCliFilesystemSandbox, runCliEntrySearchGoal } = await import("nnanything/cli-search");

const PROFILE_FILE = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof PROFILE_FILE !== "string" || PROFILE_FILE.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE must name the shared saved policy profile");
}
const rawProfile = JSON.parse(await readFile(PROFILE_FILE, "utf8"));
const PROFILE = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);
const LIMITS = Object.freeze({ maxTransitions: 24, maxDepth: 4, maxDerivedGoals: 8 });

function goalFor(directory, requestId, name, type) {
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

function call(world, requestId, name, type, extra = {}) {
  return runCliEntrySearchGoal(goalFor(world.directory, requestId, name, type), {
    sandbox: world.sandbox,
    session: world.session,
    profile: extra.profile ?? PROFILE,
    limits: extra.limits ?? LIMITS,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    ...(extra.onSample === undefined ? {} : { onSample: extra.onSample }),
  });
}

function snapshot(result) {
  const atomic = result.response.report.atomicResults;
  return {
    status: result.domain.status,
    resolution: result.domain.resolution,
    satisfaction: result.domain.satisfaction,
    coverage: result.domain.coverage,
    match: result.domain.match === null ? null : {
      kind: result.domain.match.kind,
      type: result.domain.match.type,
      absolutePath: result.domain.match.absolutePath,
      ino: String(result.domain.match.identity.ino),
      sessionRevision: result.domain.match.sessionRevision,
    },
    heads: atomic.map(item => item.sourceResult.value.policy.selectedHead),
    childOutcomes: atomic.map(item => item.outcome),
    rootEvaluation: result.response.report.rootEvaluation,
    control: result.response.report.control,
    errorCodes: result.response.report.errors.map(item => item.code),
  };
}

function expectShape(actual, expected) {
  for (const key of ["status", "resolution", "satisfaction"]) {
    assert.equal(actual[key], expected[key], `${key} must be ${expected[key]}`);
  }
}

function expectNoMatch(actual) {
  assert.equal(actual.match, null);
}

async function openWorld(spec = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-family-b-")));
  const sessions = spec.sessions ?? [
    { id: "s", cwd: spec.cwd ?? "work", grantedEffects: spec.grantedEffects ?? ["filesystem.read", "process.exec"] },
  ];
  const directories = new Set(
    spec.entries.filter(entry => entry.kind === "directory").map(entry => entry.path),
  );
  for (const session of sessions) {
    const parts = session.cwd.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  const files = spec.entries.filter(entry => entry.kind !== "directory");
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: spec.scenarioId ?? "family-b",
      entries: [
        ...[...directories].map(path => ({ path, kind: "directory" })),
        ...files,
      ],
      sessions,
    },
    ...(spec.listingObserver === undefined ? {} : { listingObserver: spec.listingObserver }),
  });
  const session = sandbox.bindSession(spec.sessionId ?? "s");
  const directory = await sandbox.bindDirectoryObject(session, ".");
  return {
    root,
    sandbox,
    session,
    directory,
    cwd: sandbox.getSession(session).cwd,
    async close() {
      const receipt = await sandbox.cleanup();
      await rm(root, { recursive: true, force: true });
      let gone = false;
      try { await lstat(root); } catch { gone = true; }
      return { sandboxRemoved: receipt.removed, rootGone: gone };
    },
  };
}

async function listFromOs(input, missingName = null) {
  const entries = [];
  const errors = [];
  for (const name of (await readdir(input.physicalDirectory)).sort()) {
    if (name === missingName) {
      errors.push({ name, code: "EACCES", message: "family B controlled lstat failure" });
      continue;
    }
    const item = await lstat(join(input.physicalDirectory, name));
    entries.push({
      name,
      path: join(input.physicalDirectory, name),
      type: item.isFile() ? "file" : item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "other",
    });
  }
  return {
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "family-b-listing-seam",
      argv: ["family-b-listing-seam", input.physicalDirectory],
      stdout: JSON.stringify({ entries }),
      stderr: "",
      exitCode: 0,
      entries,
      coverage: errors.length === 0 ? "complete" : "partial",
      errors,
    },
  };
}

function profileWithForcedHead(head) {
  const row = PROFILE.heads.indexOf(head);
  assert.notEqual(row, -1, `unknown forced head ${head}`);
  const weights = PROFILE.weights.map(item => item.map(() => 0));
  weights[row][0] = 1000;
  return { ...PROFILE, weights };
}

const CASES = [
  {
    id: "B-E01",
    premise: "direct regular file and direct directory both need a real lstat-backed inspect",
    injected: "none",
    expected: { status: "achieved", resolution: "matched", satisfaction: 100 },
    async body() {
      const world = await openWorld({
        entries: [
          { path: "work/file.txt", kind: "file", contents: "not read" },
          { path: "work/dir", kind: "directory" },
        ],
      });
      const file = await call(world, "b-e01-file", "file.txt", "regular");
      const directory = await call(world, "b-e01-dir", "dir", "directory");
      const fileStat = await lstat(join(world.cwd, "file.txt"));
      const dirStat = await lstat(join(world.cwd, "dir"));
      expectShape(snapshot(file), this.expected);
      expectShape(snapshot(directory), this.expected);
      assert.deepEqual(snapshot(file).heads, ["ls", "entry.inspect"]);
      assert.equal(snapshot(file).match.type, "regular");
      assert.equal(snapshot(directory).match.type, "directory");
      assert.equal(snapshot(file).match.ino, String(fileStat.ino));
      assert.equal(snapshot(directory).match.ino, String(dirStat.ino));
      return { actual: { file: snapshot(file), directory: snapshot(directory) }, cleanup: await world.close() };
    },
  },
  {
    id: "B-E02",
    premise: "complete direct listing has no exact name",
    injected: "none",
    expected: { status: "unmet", resolution: "not_found", satisfaction: 0 },
    async body() {
      const world = await openWorld({
        entries: [{ path: "work/only.txt", kind: "file", contents: "only" }],
      });
      const result = await call(world, "b-e02", "absent.txt", "regular");
      const actual = snapshot(result);
      expectShape(actual, this.expected);
      expectNoMatch(actual);
      assert.deepEqual(actual.heads, ["ls"]);
      return { actual, cleanup: await world.close() };
    },
  },
  {
    id: "B-E03",
    premise: "same name with the wrong real type, including a symlink to a regular file",
    injected: "real symlink created after fixture setup",
    expected: { status: "unmet", resolution: "type_mismatch", satisfaction: 0 },
    async body() {
      const world = await openWorld({
        entries: [
          { path: "work/plain.txt", kind: "file", contents: "plain" },
          { path: "work/real.txt", kind: "file", contents: "target" },
        ],
      });
      await symlink("real.txt", join(world.cwd, "alias.txt"));
      const reverse = await call(world, "b-e03-reverse", "plain.txt", "directory");
      const alias = await call(world, "b-e03-alias", "alias.txt", "regular");
      expectShape(snapshot(reverse), this.expected);
      expectShape(snapshot(alias), this.expected);
      expectNoMatch(snapshot(reverse));
      expectNoMatch(snapshot(alias));
      assert.equal(reverse.domain.rootFact.inspect.type, "regular");
      assert.equal(alias.domain.rootFact.inspect.type, "symlink");
      assert.equal(await readFile(join(world.cwd, "real.txt"), "utf8"), "target");
      return { actual: { reverse: snapshot(reverse), alias: snapshot(alias) }, cleanup: await world.close() };
    },
  },
  {
    id: "B-E04",
    premise: "grandchild and sibling names must not widen the direct directory scope",
    injected: "none",
    expected: { status: "unmet", resolution: "not_found", satisfaction: 0 },
    async body() {
      const world = await openWorld({
        entries: [
          { path: "work/a", kind: "file", contents: "a" },
          { path: "work/ab", kind: "file", contents: "ab" },
          { path: "work/child", kind: "directory" },
          { path: "work/child/hit.txt", kind: "file", contents: "grandchild" },
          { path: "sibling", kind: "directory" },
          { path: "sibling/hit.txt", kind: "file", contents: "sibling" },
        ],
      });
      const a = await call(world, "b-e04-a", "a", "regular");
      const ab = await call(world, "b-e04-ab", "ab", "regular");
      const miss = await call(world, "b-e04-miss", "hit.txt", "regular");
      assert.equal(basename(snapshot(a).match.absolutePath), "a");
      assert.equal(basename(snapshot(ab).match.absolutePath), "ab");
      expectShape(snapshot(miss), this.expected);
      assert.deepEqual(snapshot(miss).heads, ["ls"]);
      return { actual: { a: snapshot(a), ab: snapshot(ab), miss: snapshot(miss) }, cleanup: await world.close() };
    },
  },
  {
    id: "B-E05",
    premise: "space, newline, leading dash, backslash, shell metacharacters and unicode are exact names",
    injected: "none",
    expected: { status: "achieved", resolution: "matched", satisfaction: 100 },
    async body() {
      const names = ["two words", "line\nbreak", "-leading", "back\\slash", "$(touch should-not-exist)", "\u4e2d\u6587"];
      const world = await openWorld({
        entries: names.map(name => ({ path: `work/${name}`, kind: "file", contents: name })),
      });
      const actual = [];
      for (let index = 0; index < names.length; index += 1) {
        const result = await call(world, `b-e05-${index}`, names[index], "regular");
        expectShape(snapshot(result), this.expected);
        assert.equal(basename(snapshot(result).match.absolutePath), names[index]);
        actual.push(snapshot(result));
      }
      assert.equal((await readdir(world.cwd)).includes("should-not-exist"), false);
      return { actual, cleanup: await world.close() };
    },
  },
  {
    id: "B-E06",
    premise: "case folding and Unicode normalization are not part of the exact relation",
    injected: "none",
    expected: { status: "unmet", resolution: "not_found", satisfaction: 0 },
    async body() {
      const world = await openWorld({
        entries: [
          { path: "work/CaseName", kind: "file", contents: "case" },
          { path: "work/café", kind: "file", contents: "unicode" },
        ],
      });
      const names = await readdir(world.cwd);
      const caseName = names.find(name => name.toLowerCase() === "casename");
      const caseQuery = caseName === caseName.toLowerCase() ? caseName.toUpperCase() : caseName.toLowerCase();
      const unicodeName = names.find(name => name.normalize("NFC") === "caf\u00e9" || name.normalize("NFD") === "cafe\u0301");
      const unicodeQuery = unicodeName === "caf\u00e9" ? "cafe\u0301" : "caf\u00e9";
      const caseResult = await call(world, "b-e06-case", caseQuery, "regular");
      const unicodeResult = await call(world, "b-e06-unicode", unicodeQuery, "regular");
      expectShape(snapshot(caseResult), this.expected);
      expectShape(snapshot(unicodeResult), this.expected);
      return { actual: { case: snapshot(caseResult), unicode: snapshot(unicodeResult) }, cleanup: await world.close() };
    },
  },
  {
    id: "B-E07",
    premise: "partial coverage with and without a same-name clue is unknown and never inspected",
    injected: "controlled real lstat EACCES for one non-target entry",
    expected: { status: "unknown", resolution: "insufficient_evidence", satisfaction: null },
    async body() {
      const clueWorld = await openWorld({
        entries: [
          { path: "work/hit.txt", kind: "file", contents: "hit" },
          { path: "work/broken.bin", kind: "file", contents: "broken" },
        ],
        listingObserver: input => listFromOs(input, "broken.bin"),
      });
      const noClueWorld = await openWorld({
        entries: [{ path: "work/broken.bin", kind: "file", contents: "broken" }],
        listingObserver: input => listFromOs(input, "broken.bin"),
      });
      const clue = await call(clueWorld, "b-e07-clue", "hit.txt", "regular");
      const noClue = await call(noClueWorld, "b-e07-none", "hit.txt", "regular");
      expectShape(snapshot(clue), this.expected);
      expectShape(snapshot(noClue), this.expected);
      assert.equal(snapshot(clue).coverage, "partial");
      assert.equal(snapshot(noClue).coverage, "partial");
      assert.deepEqual(snapshot(clue).heads, ["ls"]);
      assert.deepEqual(snapshot(noClue).heads, ["ls"]);
      assert.deepEqual(clue.domain.rootFact.listing.candidateNames, ["hit.txt"]);
      assert.deepEqual(noClue.domain.rootFact.listing.candidateNames, []);
      return {
        actual: { clue: snapshot(clue), noClue: snapshot(noClue) },
        cleanup: { clue: await clueWorld.close(), noClue: await noClueWorld.close() },
      };
    },
  },
  {
    id: "B-E08",
    premise: "missing process.exec rejects before a business call; helper protocol failure is failed",
    injected: "controlled missing effect and controlled helper failure",
    expected: { rejected: { status: "rejected", resolution: "rejected", satisfaction: null }, failed: { status: "failed", resolution: "failed", satisfaction: null } },
    async body() {
      const deniedWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
        grantedEffects: ["filesystem.read"],
      });
      const brokenWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
        listingObserver: async () => ({
          ok: false,
          error: { operation: "directory.list", stage: "observe", code: "INVALID_HELPER_RESPONSE", message: "controlled protocol failure" },
        }),
      });
      const denied = await call(deniedWorld, "b-e08-denied", "hit.txt", "regular");
      const broken = await call(brokenWorld, "b-e08-broken", "hit.txt", "regular");
      expectShape(snapshot(denied), this.expected.rejected);
      expectShape(snapshot(broken), this.expected.failed);
      assert.equal(denied.response.report.atomicResults[0].executorInvoked, false);
      assert.match(JSON.stringify(denied.response.report.errors), /EFFECT_DENIED/);
      assert.match(JSON.stringify(broken.domain.preserve.errors), /INVALID_HELPER_RESPONSE|execution_failed/);
      return { actual: { denied: snapshot(denied), broken: snapshot(broken) }, cleanup: { denied: await deniedWorld.close(), broken: await brokenWorld.close() } };
    },
  },
  {
    id: "B-E09",
    premise: "a hit removed between listing and inspect is stale evidence, not complete not_found",
    injected: "controlled unlink after the listing sample",
    expected: { status: "unknown", resolution: "stale_or_unverified", satisfaction: null },
    async body() {
      const world = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
      });
      const hit = join(world.cwd, "hit.txt");
      const result = await call(world, "b-e09", "hit.txt", "regular", {
        onSample: async sample => {
          if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
            await rm(hit, { force: true });
          }
        },
      });
      const actual = snapshot(result);
      expectShape(actual, this.expected);
      expectNoMatch(actual);
      assert.match(JSON.stringify(result.response.report.errors), /ENOENT/);
      return { actual, cleanup: await world.close() };
    },
  },
  {
    id: "B-E10",
    premise: "current inspect wins over a replaced same-name listing entry",
    injected: "controlled replacement after the listing sample",
    expected: { sameType: { status: "achieved", resolution: "matched", satisfaction: 100 }, otherType: { status: "unmet", resolution: "type_mismatch", satisfaction: 0 } },
    async body() {
      const sameWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "old" }],
      });
      const sameHit = join(sameWorld.cwd, "hit.txt");
      const replacements = [];
      const same = await call(sameWorld, "b-e10-same", "hit.txt", "regular", {
        onSample: async sample => {
          if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
            await rm(sameHit, { force: true });
            await writeFile(sameHit, "new");
            replacements.push(await lstat(sameHit));
          }
        },
      });
      expectShape(snapshot(same), this.expected.sameType);
      assert.equal(snapshot(same).match.ino, String(replacements[0].ino));

      const otherWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "old" }],
      });
      const otherHit = join(otherWorld.cwd, "hit.txt");
      const other = await call(otherWorld, "b-e10-other", "hit.txt", "regular", {
        onSample: async sample => {
          if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
            await rm(otherHit, { force: true });
            await mkdir(otherHit);
          }
        },
      });
      expectShape(snapshot(other), this.expected.otherType);
      assert.equal(other.domain.rootFact.inspect.type, "directory");
      return { actual: { same: snapshot(same), other: snapshot(other) }, cleanup: { same: await sameWorld.close(), other: await otherWorld.close() } };
    },
  },
  {
    id: "B-E11",
    premise: "foreign session scope, duplicate direct names and path/name mismatch never become matches",
    injected: "controlled duplicate and mismatched listing observations",
    expected: { duplicate: "unknown", mismatch: "unknown" },
    async body() {
      let listings = 0;
      const scopeWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
        listingObserver: async input => {
          listings += 1;
          return listFromOs(input);
        },
      });
      const foreign = { ...scopeWorld.directory, sessionId: "foreign-session" };
      await assert.rejects(
        runCliEntrySearchGoal(goalFor(foreign, "b-e11-foreign", "hit.txt", "regular"), {
          sandbox: scopeWorld.sandbox,
          session: scopeWorld.session,
          profile: PROFILE,
          limits: LIMITS,
        }),
        /bound session and scenario/,
      );
      assert.equal(listings, 0);
      await scopeWorld.close();

      const duplicateWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
        listingObserver: async input => {
          const item = await listFromOs(input);
          const entry = item.observation.entries[0];
          item.observation.entries = [entry, { ...entry }];
          return item;
        },
      });
      const duplicate = await call(duplicateWorld, "b-e11-duplicate", "hit.txt", "regular");
      assert.equal(snapshot(duplicate).status, "unknown");
      assert.equal(snapshot(duplicate).match, null);
      assert.match(JSON.stringify(duplicate.domain.rootFact.listing.errors), /duplicate_name/);

      const mismatchWorld = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
        listingObserver: async input => {
          const item = await listFromOs(input);
          item.observation.entries = item.observation.entries.map(entry => ({
            ...entry,
            path: join(input.physicalDirectory, "other", entry.name),
          }));
          return item;
        },
      });
      const mismatch = await call(mismatchWorld, "b-e11-mismatch", "hit.txt", "regular");
      assert.equal(snapshot(mismatch).status, "unknown");
      assert.equal(snapshot(mismatch).match, null);
      assert.match(JSON.stringify(mismatch.domain.rootFact.listing.errors), /path_name_mismatch/);
      return {
        actual: { duplicate: snapshot(duplicate), mismatch: snapshot(mismatch) },
        cleanup: { duplicate: await duplicateWorld.close(), mismatch: await mismatchWorld.close() },
      };
    },
  },
  {
    id: "B-E12",
    premise: "wrong head is a policy error; budget is budget_exhausted and cancellation is interrupted",
    injected: "forced pwd head, maxTransitions=1, abort after listing",
    expected: { wrongHead: { status: "failed", resolution: "failed", satisfaction: null }, budget: { status: "unknown", resolution: "budget_exhausted", satisfaction: null }, cancelled: { status: "unknown", resolution: "interrupted", satisfaction: null } },
    async body() {
      const world = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "file", contents: "hit" }],
      });
      const wrongHead = await call(world, "b-e12-head", "hit.txt", "regular", {
        profile: profileWithForcedHead("pwd"),
      });
      expectShape(snapshot(wrongHead), this.expected.wrongHead);
      assert.equal(wrongHead.response.report.atomicResults[0].sourceResult.value.policy.selectedHead, "pwd");
      assert.equal(wrongHead.response.report.atomicResults[0].sourceResult.value.policy_error.expectedHead, "ls");
      assert.equal(wrongHead.response.report.atomicResults[0].sourceResult.value.execution_result.executorInvoked, false);
      assert.match(JSON.stringify(wrongHead.response.report.errors), /policy_error/);

      const budget = await call(world, "b-e12-budget", "hit.txt", "regular", {
        limits: { maxTransitions: 1, maxDepth: 4, maxDerivedGoals: 8 },
      });
      expectShape(snapshot(budget), this.expected.budget);
      assert.match(JSON.stringify(budget.response.report.control), /budget/);

      const controller = new AbortController();
      const cancelled = await call(world, "b-e12-cancel", "hit.txt", "regular", {
        signal: controller.signal,
        onSample: async sample => {
          if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
            controller.abort();
          }
        },
      });
      expectShape(snapshot(cancelled), this.expected.cancelled);
      assert.match(JSON.stringify(cancelled.response.report.control), /cancel/);
      return { actual: { wrongHead: snapshot(wrongHead), budget: snapshot(budget), cancelled: snapshot(cancelled) }, cleanup: await world.close() };
    },
  },
  {
    id: "B-E13",
    premise: "two successful child observations do not satisfy a root type requirement",
    injected: "none",
    expected: { status: "unmet", resolution: "type_mismatch", satisfaction: 0 },
    async body() {
      const world = await openWorld({
        entries: [{ path: "work/hit.txt", kind: "directory" }],
      });
      const result = await call(world, "b-e13", "hit.txt", "regular");
      const actual = snapshot(result);
      expectShape(actual, this.expected);
      assert.deepEqual(actual.childOutcomes, ["succeeded", "succeeded"]);
      assert.equal(actual.rootEvaluation.result, "unsatisfied");
      expectNoMatch(actual);
      return { actual, cleanup: await world.close() };
    },
  },
  {
    id: "B-E14",
    premise: "repeated evaluation is IO-free and two interleaved sessions keep cwd, entries and content",
    injected: "real listing seam counts one call per run",
    expected: { status: "achieved", resolution: "matched", satisfaction: 100 },
    async body() {
      let lists = 0;
      const world = await openWorld({
        entries: [
          { path: "work/shared.txt", kind: "file", contents: "work" },
          { path: "second/shared.txt", kind: "file", contents: "second" },
        ],
        sessions: [
          { id: "s", cwd: "work", grantedEffects: ["filesystem.read", "process.exec"] },
          { id: "s2", cwd: "second", grantedEffects: ["filesystem.read", "process.exec"] },
        ],
        listingObserver: async input => {
          lists += 1;
          return listFromOs(input);
        },
      });
      const secondSession = world.sandbox.bindSession("s2");
      const secondDirectory = await world.sandbox.bindDirectoryObject(secondSession, ".");
      const secondCwd = world.sandbox.getSession(secondSession).cwd;
      const beforeCwd = process.cwd();
      const beforeWork = (await readdir(world.cwd)).sort();
      const beforeSecond = (await readdir(secondCwd)).sort();
      const first = await call(world, "b-e14-first", "shared.txt", "regular");
      const repeated = await runCliEntrySearchGoal(goalFor(world.directory, "b-e14-repeat", "shared.txt", "regular"), {
        sandbox: world.sandbox,
        session: world.session,
        profile: PROFILE,
        limits: LIMITS,
      });
      const [left, right] = await Promise.all([
        call(world, "b-e14-left", "shared.txt", "regular"),
        runCliEntrySearchGoal(goalFor(secondDirectory, "b-e14-right", "shared.txt", "regular"), {
          sandbox: world.sandbox,
          session: secondSession,
          profile: PROFILE,
          limits: LIMITS,
        }),
      ]);
      for (const result of [first, repeated, left, right]) expectShape(snapshot(result), this.expected);
      assert.equal(lists, 4);
      assert.equal(snapshot(first).match.absolutePath, join(world.cwd, "shared.txt"));
      assert.equal(snapshot(right).match.absolutePath, join(secondCwd, "shared.txt"));
      assert.equal(process.cwd(), beforeCwd);
      assert.equal(world.sandbox.getSession(world.session).cwd, world.cwd);
      assert.equal(world.sandbox.getSession(secondSession).cwd, secondCwd);
      assert.deepEqual((await readdir(world.cwd)).sort(), beforeWork);
      assert.deepEqual((await readdir(secondCwd)).sort(), beforeSecond);
      assert.equal(await readFile(join(world.cwd, "shared.txt"), "utf8"), "work");
      assert.equal(await readFile(join(secondCwd, "shared.txt"), "utf8"), "second");
      return { actual: { first: snapshot(first), repeated: snapshot(repeated), left: snapshot(left), right: snapshot(right), lists }, cleanup: await world.close() };
    },
  },
];

const report = [];
for (const item of CASES) {
  const start = performance.now();
  try {
    const evidence = await item.body();
    report.push({ id: item.id, premise: item.premise, injected: item.injected, expected: item.expected, actual: evidence.actual, cleanup: evidence.cleanup, status: "pass" });
  } catch (error) {
    report.push({ id: item.id, premise: item.premise, injected: item.injected, expected: item.expected, status: "fail", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify({ ...report[report.length - 1], durationMs: Math.round(performance.now() - start) })}\n`);
}
const passed = report.filter(item => item.status === "pass").length;
process.stdout.write(`${JSON.stringify({ family: "B", cases: report.length, passed, failed: report.length - passed })}\n`);
