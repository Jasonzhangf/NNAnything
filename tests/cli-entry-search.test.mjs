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
import { test } from "node:test";

const LIMITS = Object.freeze({
  maxTransitions: 20,
  maxDepth: 4,
  maxDerivedGoals: 8,
});

const RECURSIVE_LIMITS = Object.freeze({
  maxTransitions: 400,
  maxDepth: 8,
  maxDerivedGoals: 200,
});

function profilePath() {
  const value = process.env.NN_CLI_COMMAND_PROFILE;
  assert.equal(
    typeof value,
    "string",
    "NN_CLI_COMMAND_PROFILE must name an explicit saved CLI command profile",
  );
  assert.notEqual(value.length, 0, "NN_CLI_COMMAND_PROFILE must not be empty");
  return value;
}

async function api() {
  return import("nnanything/cli-search");
}

async function profile() {
  const raw = JSON.parse(await readFile(profilePath(), "utf8"));
  const { migrateCliCommandProfileToCurrent } = await import("nnanything/cli-goal");
  return migrateCliCommandProfileToCurrent(raw);
}

async function fixture(t, options) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-entry-search-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId,
      entries: [
        { path: "start", kind: "directory" },
        { path: "empty", kind: "directory" },
        ...options.entries,
      ],
      sessions: options.sessions ?? [
        {
          id: "s",
          cwd: options.cwd ?? "start",
          grantedEffects: options.grantedEffects ?? ["filesystem.read", "process.exec"],
        },
      ],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const session = sandbox.bindSession(options.sessionId ?? "s");
  const directory = await sandbox.bindDirectory(session, ".");
  return { module, sandbox, session, directory };
}

function request(directory, name, type) {
  return {
    requestId: `entry-search-${name}-${type}`,
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: directory,
      requirement: {
        kind: "matches",
        predicate: {
          kind: "entrySelector",
          name,
          type,
          cardinality: "one",
        },
      },
    },
    satisfactionThreshold: 100,
  };
}

function heads(response) {
  return response.report.atomicResults.map(result => result.sourceResult.value.policy.selectedHead);
}

function childSkillIds(response) {
  return response.report.atomicResults.map(result => result.skillId);
}

async function runWith(fixtureValue, goal, options = {}) {
  const profile = options.profile ?? fixtureValue.profile ?? await profile();
  return fixtureValue.module.runCliEntrySearchGoal(goal, {
    sandbox: fixtureValue.sandbox,
    session: options.session ?? fixtureValue.session,
    profile,
    limits: options.limits ?? LIMITS,
    ...(options.scan === undefined ? {} : { scan: options.scan }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
  });
}

function run(fixtureValue, goal, onSample, session = fixtureValue.session) {
  return runWith(fixtureValue, goal, { session, onSample });
}

function reuseRef(sandbox, ref) {
  return sandbox.execute({
    operation: "entry.inspect",
    parameters: { ref, followSymlinks: false },
  });
}

async function replaceDirectoryWithDifferentInode(path, previousIno) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(path, { recursive: true, force: true });
    await mkdir(path);
    const stat = await lstat(path);
    if (String(stat.ino) !== String(previousIno)) return stat;
  }
  throw new Error("unable to obtain a different directory inode");
}

function forcedHeadProfile(base, head) {
  const index = base.heads.indexOf(head);
  assert.notEqual(index, -1, `profile must contain head ${head}`);
  const weights = base.weights.map(row => row.map(() => 0));
  weights[index][0] = 1000;
  return { ...base, weights };
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
      helperPath: "controlled-real-listing",
      argv: ["controlled-real-listing", input.physicalDirectory],
      stdout: JSON.stringify({ directory: input.physicalDirectory, entries, errors }),
      stderr: "",
      exitCode: 0,
      entries,
      coverage: errors.length === 0 ? "complete" : "partial",
      errors,
    },
  };
}

function assertDenominators(domain, expected) {
  assert.deepEqual(domain.denominators, {
    listedDirectories: expected.listedDirectories,
    directoriesComplete: expected.directoriesComplete,
    directoriesUncovered: expected.directoriesUncovered,
    nameMatchedCandidates: expected.nameMatchedCandidates,
    candidatesInspected: expected.candidatesInspected,
    candidatesMatched: expected.candidatesMatched,
    candidatesStaleOrUnverified: expected.candidatesStaleOrUnverified,
    typeMismatches: expected.typeMismatches,
  });
}

async function assertObservedObjectRef(ref, expected, fixtureValue) {
  assert.deepEqual(Object.keys(ref).sort(), [
    "absolutePath",
    "identity",
    "kind",
    "scenarioId",
    "sessionId",
    "sessionRevision",
    "sourceRun",
    "type",
  ]);
  assert.deepEqual(Object.keys(ref.identity).sort(), ["dev", "ino"]);
  assert.equal(ref.kind, expected.kind);
  assert.equal(ref.scenarioId, fixtureValue.session.scenarioId);
  assert.equal(ref.sessionId, fixtureValue.session.sessionId);
  assert.equal(ref.type, expected.type);
  assert.equal(ref.absolutePath, expected.absolutePath);
  assert.equal(
    ref.sessionRevision,
    fixtureValue.sandbox.getSession(fixtureValue.session).revision,
  );
  assert.equal(typeof ref.sourceRun, "string");
  assert.notEqual(ref.sourceRun.length, 0);
  const stat = await lstat(ref.absolutePath, { bigint: true });
  assert.equal(String(ref.identity.dev), String(stat.dev));
  assert.equal(String(ref.identity.ino), String(stat.ino));
}

function assertDerivationClosedUnknown(result) {
  const report = result.response.report;
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "unknown");
  assert.equal(report.rootEvaluation.satisfaction, null);
  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.equal(report.errors.length, 1);
  const primaryError = report.errors.find(error => error.errorId === report.primaryErrorId);
  assert.ok(primaryError, "primary error id must resolve to the single retained error");
  assert.equal(primaryError.code, "evidence_unavailable");
  assert.equal(primaryError.stage, "aggregation");
  assert.equal(primaryError.source.owner, "module");
  assert.equal(primaryError.source.category, "derivation_closed");
}

async function withProfile(t, entries, options = {}) {
  const loaded = await fixture(t, {
    scenarioId: options.scenarioId ?? "entry-search",
    entries,
    cwd: options.cwd,
    grantedEffects: options.grantedEffects,
    sessions: options.sessions,
    sessionId: options.sessionId,
    listingObserver: options.listingObserver,
  });
  loaded.profile = await profile();
  return loaded;
}

test("E01 public exact-name hit returns trusted observed object references", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "file", contents: "must not be read" },
    { path: "start/subdir", kind: "directory" },
    { path: "start/other.txt", kind: "file", contents: "other" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const directoryObject = await value.sandbox.bindDirectoryObject(value.session, ".");

  const fileResult = await run(value, request(directoryObject, "target.txt", "regular"));
  assert.equal(fileResult.domain.status, "achieved");
  assert.equal(fileResult.domain.resolution, "matched");
  assert.equal(fileResult.domain.satisfaction, 100);
  assert.equal(fileResult.domain.match.kind, "cli.file");
  assert.equal(fileResult.domain.match.scenarioId, value.session.scenarioId);
  assert.equal(fileResult.domain.match.sessionId, value.session.sessionId);
  assert.equal(fileResult.domain.match.type, "regular");
  assert.equal(fileResult.domain.match.absolutePath, join(start, "target.txt"));
  assert.equal(basename(fileResult.domain.match.absolutePath), "target.txt");
  assert.equal(fileResult.domain.match.sessionRevision, value.sandbox.getSession(value.session).revision);
  assert.equal(typeof fileResult.domain.match.sourceRun, "string");
  assert.notEqual(fileResult.domain.match.sourceRun.length, 0);
  const fileStat = await lstat(join(start, "target.txt"), { bigint: true });
  assert.equal(String(fileResult.domain.match.identity.ino), String(fileStat.ino));
  assert.equal(String(fileResult.domain.match.identity.dev), String(fileStat.dev));
  assert.notEqual(fileResult.domain.match.sourceRun, fileResult.domain.rootFact.inspect.sourceRun);
  assert.deepEqual(fileResult.domain.rootFact.ref, fileResult.domain.match);
  assert.equal(fileResult.domain.rootFact.inspect.observedWith, "lstat");
  const fileReuse = await reuseRef(value.sandbox, fileResult.domain.match);
  assert.equal(fileReuse.status, "succeeded");
  assert.equal(fileReuse.execution.executorInvoked, true);
  assert.equal(String(fileReuse.execution.observation.snapshot.ino), String(fileStat.ino));
  assert.deepEqual(heads(fileResult.response), ["ls", "entry.inspect"]);
  assert.deepEqual(
    childSkillIds(fileResult.response),
    ["entry-search.list", "entry-search.inspect"],
  );
  assert.equal(fileResult.response.report.rootEvaluation.result, "satisfied");

  const directoryResult = await run(value, request(directoryObject, "subdir", "directory"));
  assert.equal(directoryResult.domain.status, "achieved");
  assert.equal(directoryResult.domain.match.kind, "cli.directory");
  assert.equal(directoryResult.domain.match.type, "directory");
  assert.equal(directoryResult.domain.match.absolutePath, join(start, "subdir"));
  assert.equal(basename(directoryResult.domain.match.absolutePath), "subdir");
  assert.equal(directoryResult.domain.match.sessionRevision, value.sandbox.getSession(value.session).revision);
  assert.equal(typeof directoryResult.domain.match.sourceRun, "string");
  const directoryStat = await lstat(join(start, "subdir"), { bigint: true });
  assert.equal(String(directoryResult.domain.match.identity.ino), String(directoryStat.ino));
  assert.equal(String(directoryResult.domain.match.identity.dev), String(directoryStat.dev));
  assert.equal(directoryResult.domain.match.scenarioId, value.session.scenarioId);
  assert.equal(directoryResult.domain.match.sessionId, value.session.sessionId);
  assert.notEqual(directoryResult.domain.match.sourceRun, directoryResult.domain.rootFact.inspect.sourceRun);
  assert.deepEqual(directoryResult.domain.rootFact.ref, directoryResult.domain.match);
  const directoryReuse = await reuseRef(value.sandbox, directoryResult.domain.match);
  assert.equal(directoryReuse.status, "succeeded");
  assert.equal(directoryReuse.execution.executorInvoked, true);
  assert.equal(String(directoryReuse.execution.observation.snapshot.ino), String(directoryStat.ino));
  assert.deepEqual(heads(directoryResult.response), ["ls", "entry.inspect"]);
});

test("E02 complete listing without the name is unmet and never inspects a guessed path", async t => {
  const value = await withProfile(
    t,
    [
      { path: "empty/other.txt", kind: "file", contents: "other" },
      { path: "empty/other-dir", kind: "directory" },
    ],
    { cwd: "empty" },
  );

  const result = await run(value, request(value.directory, "missing.txt", "regular"));
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "not_found");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.coverage, "complete");
  assert.deepEqual(heads(result.response), ["ls"]);
  assert.deepEqual(childSkillIds(result.response), ["entry-search.list"]);
  assert.equal(result.response.report.rootEvaluation.result, "unsatisfied");
  assert.equal(
    result.response.report.atomicResults.some(
      item => item.sourceResult.value.policy.selectedHead === "entry.inspect",
    ),
    false,
  );
});

test("E09 a match removed after listing is stale evidence, not a complete not_found", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "file", contents: "do not read" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const target = join(start, "target.txt");
  const deletedAfter = [];

  const result = await run(
    value,
    request(value.directory, "target.txt", "regular"),
    async sample => {
      if (
        sample.goal.property === "file.property.directory.entries" &&
        sample.status === "achieved"
      ) {
        await rm(target, { force: true });
        deletedAfter.push(target);
      }
    },
  );

  assert.equal(deletedAfter.length, 1);
  assert.equal(
    result.domain.status,
    "unknown",
    JSON.stringify(result.response.report.errors),
  );
  assert.equal(result.domain.resolution, "stale_or_unverified");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "stale_or_unverified");
  assert.equal(result.domain.rootFact.ref, null);
  assert.match(JSON.stringify(result.response.report.errors), /ENOENT/);
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
});

test("E13 achieved child observations cannot make a type-mismatched root achieved", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "directory" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;

  const result = await run(value, request(value.directory, "target.txt", "regular"));
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "type_mismatch");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.match, null);
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
  assert.deepEqual(
    result.response.report.atomicResults.map(item => item.outcome),
    ["succeeded", "succeeded"],
  );
  assert.equal(result.response.report.rootEvaluation.result, "unsatisfied");
  assert.equal(result.domain.rootFact.kind, "type_mismatch");
  assert.equal(result.domain.rootFact.inspect.type, "directory");
  assert.equal(result.domain.rootFact.ref.kind, "cli.directory");
  assert.equal(result.domain.rootFact.ref.type, "directory");
  assert.equal(result.domain.rootFact.ref.absolutePath, join(start, "target.txt"));
  assert.equal(result.domain.rootFact.ref.sessionRevision, value.sandbox.getSession(value.session).revision);
});

test("E03 a same-name entry with another real type is a mismatch and a symlink is not followed", async t => {
  const value = await withProfile(t, [
    { path: "start/real.txt", kind: "file", contents: "link target content" },
    { path: "start/plain.txt", kind: "file", contents: "plain" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  await symlink("real.txt", join(start, "link.txt"));

  const reverse = await run(value, request(value.directory, "plain.txt", "directory"));
  assert.equal(reverse.domain.status, "unmet");
  assert.equal(reverse.domain.resolution, "type_mismatch");
  assert.equal(reverse.domain.satisfaction, 0);
  assert.equal(reverse.domain.match, null);
  assert.equal(reverse.domain.rootFact.kind, "type_mismatch");
  assert.equal(reverse.domain.rootFact.inspect.type, "regular");

  const link = await run(value, request(value.directory, "link.txt", "regular"));
  assert.equal(link.domain.status, "unmet");
  assert.equal(link.domain.resolution, "type_mismatch");
  assert.equal(link.domain.match, null);
  assert.equal(link.domain.rootFact.inspect.type, "symlink");
  assert.equal(link.domain.rootFact.inspect.observedWith, "lstat");
  assert.equal(link.domain.rootFact.ref.kind, "cli.entry");
  assert.equal(link.domain.rootFact.ref.type, "symlink");
  assert.equal(link.domain.rootFact.ref.absolutePath, join(start, "link.txt"));
  assert.equal(await readFile(join(start, "real.txt"), "utf8"), "link target content");
  assert.deepEqual(heads(link.response), ["ls", "entry.inspect"]);
});

test("E04 only direct children of the bound directory are searched", async t => {
  const value = await withProfile(t, [
    { path: "start/a", kind: "file", contents: "a" },
    { path: "start/ab", kind: "file", contents: "ab" },
    { path: "start/child", kind: "directory" },
    { path: "start/child/target.txt", kind: "file", contents: "grandchild" },
    { path: "other", kind: "directory" },
    { path: "other/target.txt", kind: "file", contents: "sibling" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;

  const a = await run(value, request(value.directory, "a", "regular"));
  assert.equal(a.domain.status, "achieved");
  assert.equal(basename(a.domain.match.absolutePath), "a");
  assert.equal(a.domain.match.absolutePath, join(start, "a"));

  const ab = await run(value, request(value.directory, "ab", "regular"));
  assert.equal(ab.domain.status, "achieved");
  assert.equal(basename(ab.domain.match.absolutePath), "ab");
  assert.equal(ab.domain.match.absolutePath, join(start, "ab"));

  const target = await run(value, request(value.directory, "target.txt", "regular"));
  assert.equal(target.domain.status, "unmet");
  assert.equal(target.domain.resolution, "not_found");
  assert.equal(target.domain.match, null);
  assert.deepEqual(heads(target.response), ["ls"]);
  assert.equal(childSkillIds(target.response).includes("entry-search.inspect"), false);
});

test("E05 special names are compared exactly and never shell-interpolated", async t => {
  const names = [
    "with space",
    "line\nbreak",
    "中文.txt",
    "-dash",
    "back\\slash",
    "$(touch nope)",
    "a;b",
    "*",
  ];
  const value = await withProfile(
    t,
    names.map(name => ({ path: `start/${name}`, kind: "file", contents: name })),
  );
  const start = value.sandbox.getSession(value.session).cwd;

  for (const name of names) {
    const result = await run(value, request(value.directory, name, "regular"));
    assert.equal(result.domain.status, "achieved", `expected hit for ${JSON.stringify(name)}`);
    assert.equal(basename(result.domain.match.absolutePath), name);
    assert.equal(result.domain.match.absolutePath, join(start, name));
  }
  assert.equal((await readdir(start)).includes("nope"), false);
});

test("E06 case and Unicode normalization differences are not folded", async t => {
  const value = await withProfile(t, [
    { path: "start/Alpha", kind: "file", contents: "case" },
    { path: "start/café", kind: "file", contents: "unicode" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const actual = await readdir(start);

  const caseActual = actual.find(name => name.toLowerCase() === "alpha");
  assert.ok(caseActual, "fixture must expose one case variant");
  const caseQuery = caseActual === caseActual.toLowerCase()
    ? caseActual.toUpperCase()
    : caseActual.toLowerCase();
  assert.notEqual(caseQuery, caseActual);
  const caseResult = await run(value, request(value.directory, caseQuery, "regular"));
  assert.equal(caseResult.domain.status, "unmet");
  assert.equal(caseResult.domain.resolution, "not_found");

  const nfc = "caf\u00e9";
  const nfd = "cafe\u0301";
  const unicodeActual = actual.find(name => name.normalize("NFC") === nfc || name.normalize("NFD") === nfd);
  assert.ok(unicodeActual, "fixture must expose one Unicode normalization form");
  const unicodeQuery = unicodeActual === nfc ? nfd : nfc;
  assert.notEqual(unicodeQuery, unicodeActual);
  const unicodeResult = await run(value, request(value.directory, unicodeQuery, "regular"));
  assert.equal(unicodeResult.domain.status, "unmet");
  assert.equal(unicodeResult.domain.resolution, "not_found");
});

test("E07 partial listings stay unknown with or without a same-name clue and never inspect", async t => {
  const withClue = await withProfile(
    t,
    [
      { path: "start/target.txt", kind: "file", contents: "do not read" },
      { path: "start/unrelated.bin", kind: "file", contents: "unrelated" },
    ],
    { listingObserver: input => observeRealListing(input, "unrelated.bin") },
  );
  const clue = await run(withClue, request(withClue.directory, "target.txt", "regular"));
  assert.equal(clue.domain.status, "unknown");
  assert.equal(clue.domain.resolution, "insufficient_evidence");
  assert.equal(clue.domain.satisfaction, null);
  assert.equal(clue.domain.match, null);
  assert.equal(clue.domain.coverage, "partial");
  assert.deepEqual(heads(clue.response), ["ls"]);
  assert.equal(clue.domain.rootFact.kind, "insufficient_evidence");
  assert.deepEqual(clue.domain.rootFact.listing.candidateNames, ["target.txt"]);
  assert.match(JSON.stringify(clue.domain.rootFact.listing.errors), /EACCES/);

  const withoutClue = await withProfile(
    t,
    [{ path: "start/unrelated.bin", kind: "file", contents: "unrelated" }],
    { listingObserver: input => observeRealListing(input, "unrelated.bin") },
  );
  const none = await run(withoutClue, request(withoutClue.directory, "missing.txt", "regular"));
  assert.equal(none.domain.status, "unknown");
  assert.equal(none.domain.resolution, "insufficient_evidence");
  assert.equal(none.domain.satisfaction, null);
  assert.equal(none.domain.match, null);
  assert.equal(none.domain.coverage, "partial");
  assert.deepEqual(heads(none.response), ["ls"]);
  assert.deepEqual(none.domain.rootFact.listing.candidateNames, []);
  assert.match(JSON.stringify(none.domain.rootFact.listing.errors), /EACCES/);
});

test("E08 missing effects reject before execution and a real helper failure stays failed", async t => {
  const denied = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    { grantedEffects: ["filesystem.read"] },
  );
  const rejected = await run(denied, request(denied.directory, "target.txt", "regular"));
  assert.equal(rejected.domain.status, "rejected");
  assert.equal(rejected.domain.resolution, "rejected");
  assert.equal(rejected.domain.satisfaction, null);
  assert.equal(rejected.domain.match, null);
  const rejectedAtomic = rejected.response.report.atomicResults[0];
  assert.equal(rejectedAtomic.outcome, "rejected");
  assert.equal(rejectedAtomic.executorInvoked, false);
  assert.match(JSON.stringify(rejected.response.report.errors), /EFFECT_DENIED/);

  let missingReadListings = 0;
  const missingRead = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    {
      grantedEffects: ["process.exec"],
      listingObserver: async input => {
        missingReadListings += 1;
        return observeRealListing(input);
      },
    },
  );
  const refused = await run(missingRead, request(missingRead.directory, "target.txt", "regular"));
  assert.equal(refused.domain.status, "rejected");
  assert.equal(refused.domain.resolution, "rejected");
  assert.equal(refused.domain.satisfaction, null);
  assert.equal(refused.domain.match, null);
  const refusedAtomic = refused.response.report.atomicResults[0];
  assert.equal(refusedAtomic.outcome, "rejected");
  assert.equal(refusedAtomic.executorInvoked, false);
  assert.equal(refusedAtomic.sourceResult.value.execution_result.executorInvoked, false);
  assert.equal(refusedAtomic.sourceResult.value.execution_result.receipt.execution.status, "failed");
  assert.equal(refusedAtomic.sourceResult.value.execution_result.receipt.execution.error.code, "EFFECT_DENIED");
  assert.equal(missingReadListings, 0);
  assert.deepEqual(heads(refused.response), ["ls"]);
  assert.equal(childSkillIds(refused.response).includes("entry-search.inspect"), false);
  assert.match(JSON.stringify(refused.response.report.errors), /EFFECT_DENIED/);

  const broken = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    {
      listingObserver: async () => ({
        ok: false,
        error: {
          operation: "directory.list",
          stage: "observe",
          code: "INVALID_HELPER_RESPONSE",
          message: "controlled helper protocol failure",
        },
      }),
    },
  );
  const failed = await run(broken, request(broken.directory, "target.txt", "regular"));
  assert.equal(failed.domain.status, "failed");
  assert.equal(failed.domain.resolution, "failed");
  assert.equal(failed.domain.satisfaction, null);
  assert.equal(failed.domain.match, null);
  assert.match(JSON.stringify(failed.domain.preserve.errors), /INVALID_HELPER_RESPONSE|execution_failed/);
});

test("E10 replacement before verification uses the current object instead of the old list entry", async t => {
  const sameType = await withProfile(t, [
    { path: "start/target.txt", kind: "file", contents: "old" },
  ]);
  const start = sameType.sandbox.getSession(sameType.session).cwd;
  const target = join(start, "target.txt");
  const replacement = [];
  const replaced = await run(
    sameType,
    request(sameType.directory, "target.txt", "regular"),
    async sample => {
      if (
        sample.goal.property === "file.property.directory.entries" &&
        sample.status === "achieved"
      ) {
        await rm(target, { force: true });
        await writeFile(target, "new");
        replacement.push(await lstat(target));
      }
    },
  );
  assert.equal(replacement.length, 1);
  assert.equal(replaced.domain.status, "achieved");
  assert.equal(replaced.domain.match.kind, "cli.file");
  assert.equal(basename(replaced.domain.match.absolutePath), "target.txt");
  assert.equal(String(replaced.domain.match.identity.ino), String(replacement[0].ino));
  assert.equal(await readFile(target, "utf8"), "new");

  const otherType = await withProfile(t, [
    { path: "start/swap.txt", kind: "file", contents: "old" },
  ]);
  const swapRoot = otherType.sandbox.getSession(otherType.session).cwd;
  const swap = join(swapRoot, "swap.txt");
  const swapped = await run(
    otherType,
    request(otherType.directory, "swap.txt", "regular"),
    async sample => {
      if (
        sample.goal.property === "file.property.directory.entries" &&
        sample.status === "achieved"
      ) {
        await rm(swap, { force: true });
        await mkdir(swap);
      }
    },
  );
  assert.equal(swapped.domain.status, "unmet");
  assert.equal(swapped.domain.resolution, "type_mismatch");
  assert.equal(swapped.domain.match, null);
  assert.equal(swapped.domain.rootFact.inspect.type, "directory");
});

test("E11 foreign scope and inconsistent listings never yield a successful object", async t => {
  let listings = 0;
  const value = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    {
      listingObserver: async input => {
        listings += 1;
        return observeRealListing(input);
      },
    },
  );
  const foreign = { ...value.directory, sessionId: "another-session" };
  await assert.rejects(
    run(value, request(foreign, "target.txt", "regular")),
    /bound session and scenario/,
  );
  assert.equal(listings, 0);

  const duplicate = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    {
      listingObserver: async input => {
        const observation = await observeRealListing(input);
        const entry = observation.observation.entries.find(item => item.name === "target.txt");
        observation.observation.entries = [entry, { ...entry }];
        return observation;
      },
    },
  );
  const dup = await run(duplicate, request(duplicate.directory, "target.txt", "regular"));
  assert.notEqual(dup.domain.status, "achieved");
  assert.equal(dup.domain.match, null);
  assert.equal(dup.domain.coverage, "partial");
  assert.match(JSON.stringify(dup.domain.rootFact.listing.errors), /duplicate_name/);
  assert.deepEqual(heads(dup.response), ["ls"]);

  const mismatched = await withProfile(
    t,
    [{ path: "start/target.txt", kind: "file", contents: "x" }],
    {
      listingObserver: async input => {
        const observation = await observeRealListing(input);
        observation.observation.entries = observation.observation.entries.map(item => ({
          ...item,
          path: join(input.physicalDirectory, "elsewhere", item.name),
        }));
        return observation;
      },
    },
  );
  const mis = await run(mismatched, request(mismatched.directory, "target.txt", "regular"));
  assert.notEqual(mis.domain.status, "achieved");
  assert.equal(mis.domain.match, null);
  assert.equal(mis.domain.coverage, "partial");
  assert.match(JSON.stringify(mis.domain.rootFact.listing.errors), /path_name_mismatch/);
  assert.deepEqual(heads(mis.response), ["ls"]);
});

test("E11 authority rejects forged, stale, wrong-identity, and replaced directory refs with zero listing", async t => {
  let listings = 0;
  const value = await withProfile(
    t,
    [
      { path: "start/scope/target.txt", kind: "file", contents: "x" },
      { path: "start/scope", kind: "directory" },
    ],
    {
      listingObserver: async input => {
        listings += 1;
        return observeRealListing(input);
      },
    },
  );
  const scope = await value.sandbox.bindDirectoryObject(value.session, "scope");

  const forged = await run(
    value,
    request({ ...scope, sourceRun: "never-issued-by-sandbox" }, "target.txt", "regular"),
  );
  assert.equal(forged.domain.status, "rejected");
  assert.equal(forged.domain.resolution, "rejected");
  assert.equal(forged.domain.match, null);

  const staleRevision = await run(
    value,
    request({ ...scope, sessionRevision: scope.sessionRevision + 1 }, "target.txt", "regular"),
  );
  assert.equal(staleRevision.domain.status, "rejected");
  assert.equal(staleRevision.domain.match, null);

  const wrongIdentity = await run(
    value,
    request({
      ...scope,
      identity: {
        dev: scope.identity.dev,
        ino: typeof scope.identity.ino === "number"
          ? scope.identity.ino + 1
          : String(BigInt(scope.identity.ino) + 1n),
      },
    }, "target.txt", "regular"),
  );
  assert.equal(wrongIdentity.domain.status, "rejected");
  assert.equal(wrongIdentity.domain.match, null);

  await replaceDirectoryWithDifferentInode(scope.absolutePath, scope.identity.ino);
  const replaced = await run(value, request(scope, "target.txt", "regular"));
  assert.equal(replaced.domain.status, "rejected");
  assert.equal(replaced.domain.match, null);

  for (const result of [forged, staleRevision, wrongIdentity, replaced]) {
    assert.equal(result.response.kind, "request_rejected");
    assert.equal(result.response.acceptedRoot, null);
    assert.equal(Object.hasOwn(result.response, "report"), false);
  }
  assert.equal(listings, 0);
});

test("returned match is issued and rejected after same-path replacement or session revision change", async t => {
  const value = await withProfile(
    t,
    [
      { path: "start/target.txt", kind: "file", contents: "original" },
      { path: "start/other", kind: "directory" },
    ],
    {
      sessions: [
        {
          id: "s",
          cwd: "start",
          grantedEffects: ["filesystem.read", "process.exec", "session.write"],
        },
      ],
    },
  );
  const start = value.sandbox.getSession(value.session).cwd;
  const target = join(start, "target.txt");

  const hit = await run(value, request(value.directory, "target.txt", "regular"));
  assert.equal(hit.domain.status, "achieved");
  const match = hit.domain.match;

  const beforeReplacement = await reuseRef(value.sandbox, match);
  assert.equal(beforeReplacement.status, "succeeded");
  assert.equal(beforeReplacement.execution.executorInvoked, true);
  assert.equal(String(beforeReplacement.execution.observation.snapshot.ino), String(match.identity.ino));

  await rm(target, { force: true });
  await writeFile(target, "replaced");
  const afterReplacement = await reuseRef(value.sandbox, match);
  assert.equal(afterReplacement.status, "failed");
  assert.equal(afterReplacement.execution.executorInvoked, false);
  assert.equal(afterReplacement.execution.error.code, "STALE_REFERENCE");

  const freshHit = await run(value, request(value.directory, "target.txt", "regular"));
  assert.equal(freshHit.domain.status, "achieved");
  const freshMatch = freshHit.domain.match;
  const beforeRevision = await reuseRef(value.sandbox, freshMatch);
  assert.equal(beforeRevision.status, "succeeded");

  const otherDirectory = await value.sandbox.bindDirectory(value.session, "other");
  const cd = await value.sandbox.execute({
    operation: "cwd.set",
    parameters: { session: value.session, directory: otherDirectory },
  });
  assert.equal(cd.status, "succeeded");

  const afterRevision = await reuseRef(value.sandbox, freshMatch);
  assert.equal(afterRevision.status, "failed");
  assert.equal(afterRevision.execution.executorInvoked, false);
  assert.equal(afterRevision.execution.error.code, "STALE_REFERENCE");
});

test("E12 a wrong head is a policy error with zero execution", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "file", contents: "x" },
  ]);
  const wrong = forcedHeadProfile(await profile(), "pwd");
  const result = await runWith(value, request(value.directory, "target.txt", "regular"), {
    profile: wrong,
  });
  assert.equal(result.domain.status, "failed");
  assert.equal(result.domain.resolution, "failed");
  assert.equal(result.domain.match, null);
  const atomic = result.response.report.atomicResults[0];
  assert.equal(atomic.sourceResult.value.policy.selectedHead, "pwd");
  assert.equal(atomic.sourceResult.value.policy_error.expectedHead, "ls");
  assert.equal(atomic.sourceResult.value.execution_result.executorInvoked, false);
  assert.match(JSON.stringify(result.response.report.errors), /policy_error/);
  assert.equal(heads(result.response).includes("entry.inspect"), false);
});

test("E12 budget stops as budget_exhausted and cancellation stops as interrupted", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "file", contents: "x" },
  ]);
  const budget = await runWith(value, request(value.directory, "target.txt", "regular"), {
    limits: { maxTransitions: 1, maxDepth: 4, maxDerivedGoals: 8 },
  });
  assert.equal(budget.domain.status, "unknown");
  assert.equal(budget.domain.resolution, "budget_exhausted");
  assert.equal(budget.domain.satisfaction, null);
  assert.equal(budget.domain.match, null);
  assert.match(JSON.stringify(budget.response.report.control), /budget/);

  const controller = new AbortController();
  const cancelled = await runWith(value, request(value.directory, "target.txt", "regular"), {
    signal: controller.signal,
    onSample: async sample => {
      if (
        sample.goal.property === "file.property.directory.entries" &&
        sample.status === "achieved"
      ) {
        controller.abort();
      }
    },
  });
  assert.equal(cancelled.domain.status, "unknown");
  assert.equal(cancelled.domain.resolution, "interrupted");
  assert.equal(cancelled.domain.satisfaction, null);
  assert.equal(cancelled.domain.match, null);
  assert.match(JSON.stringify(cancelled.response.report.control), /cancel/);
});

test("E12b budget after listing or inspection stays budget_exhausted", async t => {
  const value = await withProfile(t, [
    { path: "start/target.txt", kind: "directory" },
    { path: "start/other.txt", kind: "file", contents: "other" },
  ]);
  const scenarios = [
    { label: "not_found", goal: request(value.directory, "missing.txt", "regular") },
    { label: "type_mismatch", goal: request(value.directory, "target.txt", "regular") },
  ];
  for (const scenario of scenarios) {
    const baseline = await run(value, scenario.goal);
    assert.equal(baseline.domain.resolution, scenario.label);
    const used = baseline.response.report.budgetUsed.transitionsUsed;
    let sawListing = false;
    let sawInspect = false;
    let sawInspectPreserved = false;
    for (let maxTransitions = 1; maxTransitions < used; maxTransitions += 1) {
      const result = await runWith(value, scenario.goal, {
        limits: { maxTransitions, maxDepth: 4, maxDerivedGoals: 8 },
      });
      if (result.response.report.control.stopReason !== "budget") continue;
      const selectedHeads = heads(result.response);
      sawListing ||= selectedHeads.includes("ls");
      sawInspect ||= selectedHeads.includes("entry.inspect");
      if (selectedHeads.includes("entry.inspect")) {
        const preserved = result.domain.preserve.atomicResults ?? [];
        sawInspectPreserved ||= preserved.some(
          item => item?.sourceResult?.value?.policy?.selectedHead === "entry.inspect",
        );
      }
      assert.equal(
        result.domain.status,
        "unknown",
        `${scenario.label} budget ${maxTransitions} status`,
      );
      assert.equal(
        result.domain.resolution,
        "budget_exhausted",
        `${scenario.label} budget ${maxTransitions} resolution`,
      );
      assert.equal(result.domain.satisfaction, null);
      assert.equal(result.domain.match, null);
      if (scenario.label === "type_mismatch") {
        const listed = selectedHeads.includes("ls");
        assert.equal(
          result.domain.rootFact.kind,
          listed ? "stale_or_unverified" : "insufficient_evidence",
          `type_mismatch budget ${maxTransitions} must not overwrite the budget stop`,
        );
        if (selectedHeads.includes("entry.inspect")) {
          assert.equal(
            result.domain.rootFact.inspect?.type,
            "directory",
            `type_mismatch budget ${maxTransitions} must keep the observed directory type`,
          );
        }
      }
      assert.deepEqual(
        result.domain.preserve.control.budget,
        result.response.report.control.budget,
        `${scenario.label} budget ${maxTransitions} preserve detail`,
      );
    }
    assert.equal(sawListing, true, `${scenario.label} must cover a listing receipt`);
    if (scenario.label === "type_mismatch") {
      assert.equal(sawInspect, true, "the type-mismatch scenario must cover an inspect receipt");
      assert.equal(
        sawInspectPreserved,
        true,
        "the inspect receipt must remain a preserved partial fact",
      );
    }
  }
});

test("E12c budget after a partial listing stays budget_exhausted with partial facts", async t => {
  const value = await withProfile(
    t,
    [
      { path: "start/target.txt", kind: "file", contents: "do not read" },
      { path: "start/unrelated.bin", kind: "file", contents: "unrelated" },
    ],
    { listingObserver: input => observeRealListing(input, "unrelated.bin") },
  );
  const goal = request(value.directory, "target.txt", "regular");
  const baseline = await run(value, goal);
  assert.equal(baseline.domain.status, "unknown");
  assert.equal(baseline.domain.resolution, "insufficient_evidence");
  assert.equal(baseline.domain.coverage, "partial");
  const used = baseline.response.report.budgetUsed.transitionsUsed;
  let sawPartialBudget = false;
  for (let maxTransitions = 1; maxTransitions < used; maxTransitions += 1) {
    const result = await runWith(value, goal, {
      limits: { maxTransitions, maxDepth: 4, maxDerivedGoals: 8 },
    });
    if (result.response.report.control.stopReason !== "budget") continue;
    assert.equal(result.domain.status, "unknown", `partial budget ${maxTransitions} status`);
    assert.equal(
      result.domain.resolution,
      "budget_exhausted",
      `partial budget ${maxTransitions} resolution`,
    );
    assert.equal(result.domain.satisfaction, null);
    assert.equal(result.domain.match, null);
    assert.equal(result.domain.rootFact.kind, "insufficient_evidence");
    assert.ok(
      result.domain.coverage === "partial" || result.domain.coverage === null,
      `partial budget ${maxTransitions} coverage`,
    );
    if (result.domain.coverage === "partial") {
      sawPartialBudget = true;
    }
    assert.deepEqual(
      result.domain.preserve.control.budget,
      result.response.report.control.budget,
      `partial budget ${maxTransitions} preserve detail`,
    );
  }
  assert.equal(
    sawPartialBudget,
    true,
    "the loop must cover a budget stop after a partial listing fact",
  );
});

test("E14 repeated evaluation does no extra IO and interleaved sessions stay isolated", async t => {
  let listingCalls = 0;
  const value = await withProfile(
    t,
    [
      { path: "start/one.txt", kind: "file", contents: "one" },
      { path: "start/shared.txt", kind: "file", contents: "start" },
      { path: "other/two.txt", kind: "file", contents: "two" },
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
  const start = value.sandbox.getSession(value.session).cwd;
  const second = value.sandbox.bindSession("s2");
  const secondDirectory = await value.sandbox.bindDirectoryObject(second, ".");
  const other = value.sandbox.getSession(second).cwd;
  const startEntries = (await readdir(start)).sort();
  const otherEntries = (await readdir(other)).sort();
  const parentCwd = process.cwd();

  const first = await runWith(value, request(value.directory, "one.txt", "regular"));
  assert.equal(first.domain.status, "achieved");
  assert.equal(first.response.report.atomicResults.length, 2);
  assert.equal(listingCalls, 1);

  const repeated = await runWith(value, request(value.directory, "shared.txt", "regular"));
  assert.equal(repeated.domain.status, "achieved");
  assert.equal(repeated.response.report.atomicResults.length, 2);
  assert.equal(listingCalls, 2);

  const [left, right] = await Promise.all([
    runWith(value, request(value.directory, "shared.txt", "regular")),
    runWith(value, request(secondDirectory, "shared.txt", "regular"), { session: second }),
  ]);
  assert.equal(left.domain.status, "achieved");
  assert.equal(right.domain.status, "achieved");
  assert.equal(left.domain.match.absolutePath, join(start, "shared.txt"));
  assert.equal(right.domain.match.absolutePath, join(other, "shared.txt"));
  assert.equal(listingCalls, 4);
  assert.equal(await readFile(join(start, "shared.txt"), "utf8"), "start");
  assert.equal(await readFile(join(other, "shared.txt"), "utf8"), "other");
  assert.equal(process.cwd(), parentCwd);
  assert.equal(value.sandbox.getSession(value.session).cwd, start);
  assert.equal(value.sandbox.getSession(second).cwd, other);
  assert.deepEqual((await readdir(start)).sort(), startEntries);
  assert.deepEqual((await readdir(other)).sort(), otherEntries);
});

function recursiveRequest(directory, name, type, cardinality, recursion) {
  return {
    requestId: `entry-search-${name}-${type}-${cardinality}-${recursion}`,
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: directory,
      requirement: {
        kind: "matches",
        predicate: {
          kind: "entrySelector",
          name,
          type,
          cardinality,
          recursion,
        },
      },
    },
    satisfactionThreshold: 100,
  };
}

test("DEV_CE01 cardinality one early-stop keeps coverage partial", async t => {
  const value = await withProfile(t, [
    { path: "start/target.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/other.ts", kind: "file", contents: "other" },
  ]);
  let listingCalls = 0;
  const first = await runWith(value, recursiveRequest(value.directory, "target.ts", "regular", "one", "nested"), {
    limits: RECURSIVE_LIMITS,
    scan: undefined,
    onSample: async sample => {
      if (sample.goal.property === "file.property.directory.entries") {
        listingCalls += 1;
      }
    },
  });
  assert.equal(first.domain.status, "achieved");
  assert.equal(first.domain.resolution, "matched");
  assert.equal(first.domain.satisfaction, 100);
  assert.equal(first.domain.coverage, "partial");
  assert.equal(basename(first.domain.match.absolutePath), "target.ts");
  assertDenominators(first.domain, {
    listedDirectories: 1,
    directoriesComplete: 1,
    directoriesUncovered: 0,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 1,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 0,
  });
  assert.deepEqual(heads(first.response), ["ls", "entry.inspect"]);
  assert.equal(listingCalls, 1);
});

test("DEV_CE02 all-nested full tree with disappeared candidate stays unknown stale_or_unverified", async t => {
  const value = await withProfile(t, [
    { path: "start/a/item", kind: "directory" },
    { path: "start/a", kind: "directory" },
    { path: "start/b/item", kind: "file", contents: "candidate" },
    { path: "start/b", kind: "directory" },
  ]);
  let deleted = false;
  const observer = async input => {
    const result = await observeRealListing(input);
    if (result.ok && input.physicalDirectory.endsWith("/b") && !deleted) {
      deleted = true;
      await rm(join(input.physicalDirectory, "item"), { force: true });
    }
    return result;
  };
  const valueWithHook = await withProfile(t, [
    { path: "start/a/item", kind: "directory" },
    { path: "start/a", kind: "directory" },
    { path: "start/b/item", kind: "file", contents: "candidate" },
    { path: "start/b", kind: "directory" },
  ], { listingObserver: observer });
  const result = await runWith(valueWithHook, recursiveRequest(valueWithHook.directory, "item", "regular", "all", "nested"), {
    limits: RECURSIVE_LIMITS,
  });
  assert.equal(
    result.domain.status,
    "unknown",
    JSON.stringify(result.response.report.errors),
  );
  assert.equal(result.domain.resolution, "stale_or_unverified");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.rootFact.kind, "stale_or_unverified");
  assert.ok(result.domain.rootFact.reasons.includes("disappeared"));
  assertDenominators(result.domain, {
    listedDirectories: 4,
    directoriesComplete: 4,
    directoriesUncovered: 0,
    nameMatchedCandidates: 2,
    candidatesInspected: 2,
    candidatesMatched: 0,
    candidatesStaleOrUnverified: 1,
    typeMismatches: 1,
  });
  const start = valueWithHook.sandbox.getSession(valueWithHook.session).cwd;
  assert.equal(result.domain.typeMismatches.length, 1);
  await assertObservedObjectRef(result.domain.typeMismatches[0], {
    kind: "cli.directory",
    type: "directory",
    absolutePath: join(start, "a", "item"),
  }, valueWithHook);
  assert.deepEqual(result.domain.rootFact.typeMismatches, result.domain.typeMismatches);
  assertDerivationClosedUnknown(result);

  let firstDeleted = false;
  const valueWithFirstDisappearing = await withProfile(t, [
    { path: "start/a/item", kind: "file", contents: "disappears first" },
    { path: "start/a", kind: "directory" },
    { path: "start/b/item", kind: "file", contents: "survives" },
    { path: "start/b", kind: "directory" },
  ], {
    listingObserver: async input => {
      const listing = await observeRealListing(input);
      if (listing.ok && input.physicalDirectory.endsWith("/a") && !firstDeleted) {
        firstDeleted = true;
        await rm(join(input.physicalDirectory, "item"), { force: true });
      }
      return listing;
    },
  });
  const successor = await runWith(
    valueWithFirstDisappearing,
    recursiveRequest(
      valueWithFirstDisappearing.directory,
      "item",
      "regular",
      "all",
      "nested",
    ),
    { limits: RECURSIVE_LIMITS },
  );
  const successorStart = valueWithFirstDisappearing.sandbox.getSession(
    valueWithFirstDisappearing.session,
  ).cwd;
  assert.equal(firstDeleted, true);
  assert.equal(successor.domain.status, "unknown");
  assert.equal(successor.domain.resolution, "partial");
  assert.equal(successor.domain.matches.length, 1);
  assert.equal(successor.domain.rootFact.kind, "partial");
  assert.deepEqual(successor.domain.rootFact.matches, successor.domain.matches);
  assert.deepEqual(successor.domain.rootFact.typeMismatches, successor.domain.typeMismatches);
  assert.ok(successor.domain.rootFact.reasons.includes("disappeared"));
  await assertObservedObjectRef(successor.domain.matches[0], {
    kind: "cli.file",
    type: "regular",
    absolutePath: join(successorStart, "b", "item"),
  }, valueWithFirstDisappearing);
  const inspectedPaths = successor.response.report.atomicResults
    .map(result => result.sourceResult.value)
    .filter(transition => transition.action?.kind === "entry.inspect")
    .map(transition => transition.action.ref.path);
  assert.ok(inspectedPaths.includes(join(successorStart, "a", "item")));
  assert.ok(inspectedPaths.includes(join(successorStart, "b", "item")));
  assertDenominators(successor.domain, {
    listedDirectories: 3,
    directoriesComplete: 3,
    directoriesUncovered: 0,
    nameMatchedCandidates: 2,
    candidatesInspected: 2,
    candidatesMatched: 1,
    candidatesStaleOrUnverified: 1,
    typeMismatches: 0,
  });
});

test("DEV_CE03 depth limit mixed with type_mismatch stays insufficient_evidence with two uncovered directories", async t => {
  const value = await withProfile(t, [
    { path: "start/entry.ts", kind: "directory" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/entry.ts", kind: "file", contents: "deep" },
  ]);
  const result = await runWith(value, recursiveRequest(value.directory, "entry.ts", "regular", "all", "nested"), {
    limits: RECURSIVE_LIMITS,
    scan: { maxDirectoryDepth: 0 },
  });
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "insufficient_evidence");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.rootFact.kind, "insufficient_evidence");
  assert.ok(result.domain.rootFact.listing.reasons.includes("depth_limit"));
  assert.ok(result.domain.rootFact.reasons.includes("depth_limit"));
  assertDenominators(result.domain, {
    listedDirectories: 1,
    directoriesComplete: 1,
    directoriesUncovered: 2,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 0,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 1,
  });
  assert.equal(result.domain.typeMismatches.length, 1);
  const start = value.sandbox.getSession(value.session).cwd;
  await assertObservedObjectRef(result.domain.typeMismatches[0], {
    kind: "cli.directory",
    type: "directory",
    absolutePath: join(start, "entry.ts"),
  }, value);
  assert.deepEqual(
    result.domain.rootFact.listing.typeMismatchPaths,
    [join(start, "entry.ts")],
  );
});

test("DEV_CE04 type-mismatch directory is still descended and full tree returns unmet type_mismatch", async t => {
  const value = await withProfile(t, [
    { path: "start/a/config.json", kind: "directory" },
    { path: "start/a", kind: "directory" },
    { path: "start/b", kind: "directory" },
  ]);
  const result = await runWith(value, recursiveRequest(value.directory, "config.json", "regular", "all", "nested"), {
    limits: RECURSIVE_LIMITS,
  });
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "type_mismatch");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.coverage, "complete");
  assertDenominators(result.domain, {
    listedDirectories: 4,
    directoriesComplete: 4,
    directoriesUncovered: 0,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 0,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 1,
  });
  assert.equal(result.domain.typeMismatches.length, 1);
  assert.equal(result.domain.rootFact.kind, "type_mismatch");
  const start = value.sandbox.getSession(value.session).cwd;
  await assertObservedObjectRef(result.domain.typeMismatches[0], {
    kind: "cli.directory",
    type: "directory",
    absolutePath: join(start, "a", "config.json"),
  }, value);
  assert.deepEqual(result.domain.rootFact.typeMismatches, result.domain.typeMismatches);
});

test("DEV_CE05 BFS discovery is normalized to absolutePath UTF-16 lexicographic order", async t => {
  const value = await withProfile(t, [
    { path: "start/z-target.ts", kind: "file", contents: "z" },
    { path: "start/a/z-target.ts", kind: "file", contents: "a" },
    { path: "start/a", kind: "directory" },
  ]);
  const result = await runWith(value, recursiveRequest(value.directory, "z-target.ts", "regular", "all", "nested"), {
    limits: RECURSIVE_LIMITS,
  });
  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.satisfaction, 100);
  assert.equal(result.domain.coverage, "complete");
  const start = value.sandbox.getSession(value.session).cwd;
  assert.deepEqual(result.domain.matches.map(match => match.absolutePath), [
    join(start, "a", "z-target.ts"),
    join(start, "z-target.ts"),
  ]);
  assert.equal(result.domain.match.absolutePath, join(start, "a", "z-target.ts"));
  assertDenominators(result.domain, {
    listedDirectories: 2,
    directoriesComplete: 2,
    directoriesUncovered: 0,
    nameMatchedCandidates: 2,
    candidatesInspected: 2,
    candidatesMatched: 2,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 0,
  });
  const order = result.domain.matches.map(match => match.absolutePath);
  assert.deepEqual(order, [...order].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
});

test("DEV_CE06 stale_or_unverified beats depth_limit and both reasons are kept", async t => {
  const value = await withProfile(t, [
    { path: "start/item.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/item.ts", kind: "file", contents: "deep" },
  ]);
  const observer = async input => {
    const result = await observeRealListing(input);
    if (result.ok && input.physicalDirectory.endsWith("/sub") === false) {
      await rm(join(input.physicalDirectory, "item.ts"), { force: true });
    }
    return result;
  };
  const valueWithHook = await withProfile(t, [
    { path: "start/item.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/item.ts", kind: "file", contents: "deep" },
  ], { listingObserver: observer });
  const result = await runWith(valueWithHook, recursiveRequest(valueWithHook.directory, "item.ts", "regular", "all", "nested"), {
    limits: RECURSIVE_LIMITS,
    scan: { maxDirectoryDepth: 0 },
  });
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "stale_or_unverified");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.rootFact.kind, "stale_or_unverified");
  assert.ok(result.domain.rootFact.reasons.includes("disappeared"));
  assert.ok(result.domain.rootFact.reasons.includes("depth_limit"));
  assertDenominators(result.domain, {
    listedDirectories: 1,
    directoriesComplete: 1,
    directoriesUncovered: 1,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 0,
    candidatesStaleOrUnverified: 1,
    typeMismatches: 0,
  });
  assertDerivationClosedUnknown(result);
});

test("DEV_CE07 consecutive distinct empty directories still advance the search frontier", async t => {
  const value = await withProfile(t, [
    { path: "start/a", kind: "directory" },
    { path: "start/b", kind: "directory" },
    { path: "start/c", kind: "directory" },
    { path: "start/z/target.ts", kind: "file", contents: "found" },
    { path: "start/z", kind: "directory" },
  ]);
  const result = await runWith(
    value,
    recursiveRequest(value.directory, "target.ts", "regular", "all", "nested"),
    { limits: RECURSIVE_LIMITS },
  );
  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.satisfaction, 100);
  assert.equal(result.domain.coverage, "complete");
  const start = value.sandbox.getSession(value.session).cwd;
  assert.equal(result.domain.match.absolutePath, join(start, "z", "target.ts"));
  assert.equal(result.domain.rootFact.kind, "matched");
  assert.equal(result.domain.rootFact.ref.absolutePath, join(start, "z", "target.ts"));
});

test("DEV_CE08 all-mode partial with a valid match keeps depth_limit and full partial root fact", async t => {
  const value = await withProfile(t, [
    { path: "start/target.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/target.ts", kind: "file", contents: "deep" },
  ]);
  const result = await runWith(
    value,
    recursiveRequest(value.directory, "target.ts", "regular", "all", "nested"),
    { limits: RECURSIVE_LIMITS, scan: { maxDirectoryDepth: 0 } },
  );
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "partial");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.rootFact.kind, "partial");
  assert.deepEqual(result.domain.rootFact.matches, result.domain.matches);
  assert.deepEqual(result.domain.rootFact.typeMismatches, result.domain.typeMismatches);
  assert.ok(result.domain.rootFact.reasons.includes("depth_limit"));
  assert.equal(result.domain.matches.length, 1);
  const start = value.sandbox.getSession(value.session).cwd;
  assert.equal(result.domain.matches[0].absolutePath, join(start, "target.ts"));
  assertDenominators(result.domain, {
    listedDirectories: 1,
    directoriesComplete: 1,
    directoriesUncovered: 1,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 1,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 0,
  });
});

test("DEV_CE09 all-mode cancellation after a verified match reports an interrupted root fact", async t => {
  const value = await withProfile(t, [
    { path: "start/target.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/target.ts", kind: "file", contents: "deep" },
  ]);
  const controller = new AbortController();
  const actions = [];
  const result = await runWith(
    value,
    recursiveRequest(value.directory, "target.ts", "regular", "all", "nested"),
    {
      limits: RECURSIVE_LIMITS,
      scan: { maxDirectoryDepth: 0 },
      signal: controller.signal,
      onSample: async sample => {
        actions.push(sample.policy.selectedHead);
        if (sample.policy.selectedHead === "entry.inspect") controller.abort();
      },
    },
  );
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(actions, ["ls", "entry.inspect"]);
  assert.equal(heads(result.response).length, actions.length);
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "interrupted");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.deepEqual(result.domain.rootFact, { kind: "interrupted" });
  assert.equal(result.domain.coverage, "partial");
  const start = value.sandbox.getSession(value.session).cwd;
  assert.equal(result.domain.matches.length, 1);
  assert.equal(result.domain.matches[0].absolutePath, join(start, "target.ts"));
  assertDenominators(result.domain, {
    listedDirectories: 1,
    directoriesComplete: 1,
    directoriesUncovered: 1,
    nameMatchedCandidates: 1,
    candidatesInspected: 1,
    candidatesMatched: 1,
    candidatesStaleOrUnverified: 0,
    typeMismatches: 0,
  });
});

test("DEV_CE10 one-mode cancellation after a satisfied inspect reports interrupted", async t => {
  const value = await withProfile(t, [
    { path: "start/target.ts", kind: "file", contents: "top" },
  ]);
  const controller = new AbortController();
  const actions = [];
  const result = await runWith(
    value,
    recursiveRequest(value.directory, "target.ts", "regular", "one", "nested"),
    {
      limits: RECURSIVE_LIMITS,
      signal: controller.signal,
      onSample: async sample => {
        actions.push(sample.policy.selectedHead);
        if (sample.policy.selectedHead === "entry.inspect") controller.abort();
      },
    },
  );
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(actions, ["ls", "entry.inspect"]);
  assert.deepEqual(heads(result.response), actions);
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "interrupted");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.deepEqual(result.domain.rootFact, { kind: "interrupted" });
  assert.equal(result.domain.matches.length, 1);
  const start = value.sandbox.getSession(value.session).cwd;
  assert.equal(result.domain.matches[0].absolutePath, join(start, "target.ts"));
  assert.equal(result.domain.preserve.control.outcome, "cancelled");
  assert.equal(result.domain.preserve.control.stopReason, "cancel");
  assert.equal(result.response.report.control.outcome, "cancelled");
  assert.equal(result.response.report.control.stopReason, "cancel");
  assert.match(JSON.stringify(result.response.report.control), /cancel/);
});

test("DEV_CE11 all-mode cancellation after the last satisfied inspect reports interrupted", async t => {
  const value = await withProfile(t, [
    { path: "start/target.ts", kind: "file", contents: "top" },
    { path: "start/sub", kind: "directory" },
    { path: "start/sub/target.ts", kind: "file", contents: "deep" },
  ]);
  const controller = new AbortController();
  const actions = [];
  let inspections = 0;
  const result = await runWith(
    value,
    recursiveRequest(value.directory, "target.ts", "regular", "all", "nested"),
    {
      limits: RECURSIVE_LIMITS,
      signal: controller.signal,
      onSample: async sample => {
        actions.push(sample.policy.selectedHead);
        if (sample.policy.selectedHead === "entry.inspect") {
          inspections += 1;
          if (inspections === 2) controller.abort();
        }
      },
    },
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(inspections, 2);
  assert.deepEqual(heads(result.response), actions);
  assert.equal(result.domain.coverage, "complete");
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "interrupted");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.deepEqual(result.domain.rootFact, { kind: "interrupted" });
  assert.equal(result.domain.matches.length, 2);
  const start = value.sandbox.getSession(value.session).cwd;
  assert.deepEqual(
    result.domain.matches.map(match => match.absolutePath),
    [join(start, "sub", "target.ts"), join(start, "target.ts")],
  );
  assert.equal(result.domain.preserve.control.outcome, "cancelled");
  assert.equal(result.domain.preserve.control.stopReason, "cancel");
  assert.equal(result.response.report.control.outcome, "cancelled");
  assert.equal(result.response.report.control.stopReason, "cancel");
  assert.match(JSON.stringify(result.response.report.control), /cancel/);
});
