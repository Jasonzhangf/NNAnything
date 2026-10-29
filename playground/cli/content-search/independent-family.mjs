import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { createCliFilesystemSandbox, runCliContentSearchGoal } = await import("nnanything/cli-content-search");

const RESULT_PATH =
  "/Volumes/Intel/playground/nnanything-runs/cli-programming-search-m2-20261024/family-p2.json";
const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const rawProfile = JSON.parse(await readFile(profileFile, "utf8"));
const profile = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);

// Independent sundial family: every entry name, content byte and needle is
// disjoint from the P1 fixture family and the P2 train/dev/test families.
const NEEDLE = "meridianTide";
const SESSION = Object.freeze({
  id: "s",
  cwd: ".",
  grantedEffects: Object.freeze(["filesystem.read", "process.exec"]),
});
const LIMITS_ONE = Object.freeze({ maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 5 });
const LIMITS_THREE = Object.freeze({ maxTransitions: 51, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_FOUR = Object.freeze({ maxTransitions: 44, maxDepth: 8, maxDerivedGoals: 8 });
const LIMITS_SIX = Object.freeze({ maxTransitions: 30, maxDepth: 8, maxDerivedGoals: 6 });
const LIMITS_CHUNK_TERMINAL = Object.freeze({ maxTransitions: 33, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_STALE_RESCAN = Object.freeze({ maxTransitions: 54, maxDepth: 8, maxDerivedGoals: 7 });
const LIMITS_DEPTH_ONE = Object.freeze({ maxTransitions: 47, maxDepth: 8, maxDerivedGoals: 6 });
const LIMITS_FIVE = Object.freeze({ maxTransitions: 65, maxDepth: 8, maxDerivedGoals: 11 });
const LIMITS_FIVE_NO_HIT = Object.freeze({ maxTransitions: 68, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_SINGLE_TERMINAL = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 3 });
const LIMITS_T12_FIRST = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_T12_SECOND = Object.freeze({ maxTransitions: 31, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_PARTIAL_LISTING = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 3 });

function scan(depth = 0, chunkSize = 65536) {
  return Object.freeze({
    maxBytesPerFile: 65536,
    maxTotalBytes: 262144,
    chunkSize,
    maxDirectoryDepth: depth,
    maxStaleRetries: 1,
  });
}

function request(directory, { requestId, needle, cardinality, recursion }) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality,
        recursion,
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle, encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

function denominators(domain) {
  return [
    domain.denominators.listedDirectories,
    domain.denominators.directoriesComplete,
    domain.denominators.candidatesTotal,
    domain.denominators.candidatesScanned,
    domain.denominators.candidatesMatched,
    domain.denominators.candidatesNegative,
    domain.denominators.candidatesUnresolved,
  ];
}

function lineColumn(bytes, start) {
  let line = 1;
  for (let index = 0; index < start; index += 1) {
    if (bytes[index] === 0x0a) line += 1;
  }
  const lineStart = bytes.lastIndexOf(0x0a, Math.max(0, start - 1)) + 1;
  return { line, column: start - lineStart + 1 };
}

async function listOracleDirectories(scopeRoot, maxDepth) {
  const directories = [{ absolute: scopeRoot, depth: 0 }];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (directory.depth >= maxDepth) continue;
    const found = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of found) {
      if (!entry.isDirectory()) continue;
      directories.push({ absolute: join(directory.absolute, entry.name), depth: directory.depth + 1 });
    }
  }
  return directories;
}

async function oracleScan({ scenarioRoot, scope, maxDepth, needle }) {
  const scopeRoot = resolve(scenarioRoot, scope);
  const directories = await listOracleDirectories(scopeRoot, maxDepth);
  const candidates = [];
  for (const directory of directories) {
    const found = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of found) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const path = join(directory.absolute, entry.name);
      const bytes = await readFile(path);
      const start = bytes.indexOf(Buffer.from(needle, "utf8"));
      const position = start < 0 ? null : lineColumn(bytes, start);
      candidates.push({
        path: await realpath(path),
        size: bytes.length,
        match: start < 0
          ? null
          : {
              byteSpan: { start, end: start + Buffer.byteLength(needle, "utf8") },
              line: position.line,
              column: position.column,
            },
      });
    }
  }
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    directories,
    candidates,
    matchPaths: candidates.filter(candidate => candidate.match !== null).map(candidate => candidate.path),
    negativePaths: candidates.filter(candidate => candidate.match === null).map(candidate => candidate.path),
    bytesTotal: candidates.reduce((total, candidate) => total + candidate.size, 0),
    byPath: new Map(candidates.map(candidate => [candidate.path, candidate])),
  };
}

async function snapshotTree(root) {
  const snapshot = {};
  async function walk(directory, prefix) {
    const found = await readdir(directory, { withFileTypes: true });
    for (const entry of found.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        await walk(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        snapshot[relative] = (await readFile(join(directory, entry.name))).toString("base64");
      } else {
        snapshot[relative] = "other";
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

async function assertReadOnly(context, before, domain) {
  assert.equal(process.cwd(), before.processCwd);
  assert.equal(context.sandbox.getSession(context.session).cwd, before.sessionCwd);
  assert.deepEqual(await snapshotTree(context.scenarioRoot), before.tree);
  const granted = [...context.sandbox.getSession(context.session).grantedEffects].sort();
  assert.deepEqual(granted, ["filesystem.read", "process.exec"]);
  const records = domain.preserve.effects;
  assert.ok(Array.isArray(records), "preserve.effects must be an array");
  for (const record of records) {
    assert.ok(
      ["content-search.list", "content-search.inspect", "content-search.read"].includes(record.skillId),
      `unexpected effect skill ${String(record.skillId)}`,
    );
    for (const effect of record.confirmedEffects ?? []) {
      assert.equal(effect.kind, "cli.content-search.observation");
    }
  }
  return {
    cwdUnchanged: true,
    entriesUnchanged: true,
    contentsUnchanged: true,
    readOnlyEffects: true,
  };
}

async function assertReadOnlyWithChanges(context, before, domain, contentChanges) {
  assert.equal(process.cwd(), before.processCwd);
  assert.equal(context.sandbox.getSession(context.session).cwd, before.sessionCwd);
  const after = await snapshotTree(context.scenarioRoot);
  const expected = { ...before.tree };
  for (const [relative, contents] of Object.entries(contentChanges)) {
    assert.ok(relative in expected, `content change target ${relative} must exist in the baseline tree`);
    expected[relative] = Buffer.from(contents, "utf8").toString("base64");
  }
  assert.deepEqual(after, expected);
  const granted = [...context.sandbox.getSession(context.session).grantedEffects].sort();
  assert.deepEqual(granted, ["filesystem.read", "process.exec"]);
  const records = domain.preserve.effects;
  assert.ok(Array.isArray(records), "preserve.effects must be an array");
  for (const record of records) {
    assert.ok(
      ["content-search.list", "content-search.inspect", "content-search.read"].includes(record.skillId),
      `unexpected effect skill ${String(record.skillId)}`,
    );
    for (const effect of record.confirmedEffects ?? []) {
      assert.equal(effect.kind, "cli.content-search.observation");
    }
  }
  return {
    cwdUnchanged: true,
    entriesUnchanged: true,
    contentsUnchangedExcludingHarnessInjected: Object.keys(contentChanges),
    readOnlyEffects: true,
  };
}

function assertMatches(domain, oracle) {
  assert.deepEqual([...domain.matches].map(match => match.path).sort(), oracle.matchPaths);
  for (const match of domain.matches) {
    const expected = oracle.byPath.get(match.path);
    assert.ok(expected !== undefined, `oracle has no candidate for ${match.path}`);
    assert.ok(expected.match !== null, `oracle expected no match for ${match.path}`);
    assert.deepEqual(match.byteSpan, expected.match.byteSpan);
    assert.equal(match.line, expected.match.line);
    assert.equal(match.column, expected.match.column);
    assert.equal(match.size, expected.size);
  }
}

function summary(domain) {
  return {
    status: domain.status,
    resolution: domain.resolution,
    satisfaction: domain.satisfaction,
    coverage: domain.coverage,
    rootFact: domain.rootFact.kind,
    invocationCount: domain.invocationCount,
    observationCount: domain.observationCount,
    bytesReadTotal: domain.bytesReadTotal,
    duplicateReads: domain.duplicateReads,
    budgetUsed: domain.budgetUsed,
    denominators: domain.denominators,
    matches: domain.matches.map(match => ({
      path: match.path,
      byteSpan: match.byteSpan,
      line: match.line,
      column: match.column,
      size: match.size,
      bytesRead: match.bytesRead,
      scanComplete: match.scanComplete,
    })),
    negatives: domain.negatives.map(negative => ({
      path: negative.path,
      offset: negative.offset,
      length: negative.length,
      size: negative.size,
      reason: negative.reason,
    })),
  };
}

async function trajectory(label, options, assertions) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-independent-p2-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId,
      entries: options.entries,
      sessions: [SESSION],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
    ...(options.fileReadIo === undefined ? {} : { fileReadIo: options.fileReadIo }),
  });
  try {
    const session = sandbox.bindSession("s");
    const scope = options.scope ?? "vault";
    const directory = await sandbox.bindDirectory(session, scope);
    const scenarioRoot = sandbox.scenarioRoot;
    const oracle = await oracleScan({
      scenarioRoot,
      scope,
      maxDepth: options.scan.maxDirectoryDepth,
      needle: options.needle,
    });
    const before = {
      processCwd: process.cwd(),
      sessionCwd: sandbox.getSession(session).cwd,
      tree: await snapshotTree(scenarioRoot),
    };
    const result = await runCliContentSearchGoal(
      request(directory, {
        requestId: options.requestId,
        needle: options.needle,
        cardinality: options.cardinality,
        recursion: options.recursion,
      }),
      {
        sandbox,
        session,
        profile,
        limits: options.limits,
        scan: options.scan,
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
      },
    );
    const domain = result.domain;
    const effectiveOracle = options.oracleAfterRun === true
      ? await oracleScan({
          scenarioRoot,
          scope,
          maxDepth: options.scan.maxDirectoryDepth,
          needle: options.needle,
        })
      : oracle;
    assertions(domain, effectiveOracle, result);
    const readOnly = options.contentChanges === undefined
      ? await assertReadOnly({ sandbox, session, scenarioRoot }, before, domain)
      : await assertReadOnlyWithChanges({ sandbox, session, scenarioRoot }, before, domain, options.contentChanges);
    return {
      label,
      domain,
      continuation: domain.preserve.continuation,
      oracle: {
        directories: effectiveOracle.directories.map(directory => directory.absolute),
        candidates: effectiveOracle.candidates,
        matchPaths: effectiveOracle.matchPaths,
        negativePaths: effectiveOracle.negativePaths,
        bytesTotal: effectiveOracle.bytesTotal,
      },
      result: summary(domain),
      readOnly,
    };
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

const payload = {
  consumer: "independent-family",
  family: {
    scenarioId: "m2-independent-p2-sundial",
    needle: NEEDLE,
    note: "sundial entries and bytes are disjoint from quartz, train and dev families",
  },
  entry: "nnanything/cli-content-search",
  profile: profileFile,
  oracle: "node:fs directory walk plus Buffer.indexOf",
  generatedAt: new Date().toISOString(),
};

function pick(trajectory) {
  return {
    label: trajectory.label,
    oracle: trajectory.oracle,
    result: trajectory.result,
    readOnly: trajectory.readOnly,
  };
}

async function t1() {
  return trajectory("T1-all-flat-hit", {
    scenarioId: "m2-independent-p2-t1",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/tide.ts", kind: "file", contents: `export const meridianTide = "tide-77";\n` },
      { path: "vault/harbor.ts", kind: "file", contents: `export const harborState = "still";\n` },
    ],
    requestId: "sundial-t1-all",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_FOUR,
    scan: scan(0),
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(denominators(domain), [1, 1, 2, 2, 1, 1, 0]);
    assertMatches(domain, oracle);
  });
}

async function t3() {
  const entries = [
    { path: "vault", kind: "directory" },
    { path: "vault/anchor.ts", kind: "file", contents: `export const meridianTide = "anchor-1";\n` },
    { path: "vault/keel.ts", kind: "file", contents: `export const keelState = "quiet";\n` },
    { path: "vault/oar.ts", kind: "file", contents: `export const oarState = "quiet";\n` },
  ];
  const one = await trajectory("T3-one-first-hit", {
    scenarioId: "m2-independent-p2-t3",
    scope: "vault",
    entries,
    requestId: "sundial-t3-one",
    needle: NEEDLE,
    cardinality: "one",
    recursion: "flat",
    limits: LIMITS_ONE,
    scan: scan(0),
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.bytesReadTotal, oracle.byPath.get(domain.matches[0].path)?.size);
    assert.deepEqual(denominators(domain), [1, 1, 3, 1, 1, 0, 2]);
    assertMatches(domain, oracle);
  });
  const all = await trajectory("T3-all-full-scan", {
    scenarioId: "m2-independent-p2-t3",
    scope: "vault",
    entries,
    requestId: "sundial-t3-all",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_THREE,
    scan: scan(0),
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(denominators(domain), [1, 1, 3, 3, 1, 2, 0]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
  });
  assert.ok(one.result.invocationCount < all.result.invocationCount);
  assert.ok(one.result.bytesReadTotal < all.result.bytesReadTotal);
  return { one: pick(one), all: pick(all) };
}

async function t5() {
  return trajectory("T5-same-name-nested", {
    scenarioId: "m2-independent-p2-t5",
    scope: ".",
    entries: [
      { path: "port", kind: "directory" },
      { path: "starboard", kind: "directory" },
      { path: "port/celestial.ts", kind: "file", contents: `export const celestialState = "port";\n` },
      { path: "starboard/celestial.ts", kind: "file", contents: `export const meridianTide = "starboard";\n` },
    ],
    requestId: "sundial-t5-all",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "nested",
    limits: LIMITS_THREE,
    scan: scan(1),
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(denominators(domain), [3, 3, 2, 2, 1, 1, 0]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.rootFact.candidateNames, ["celestial.ts", "celestial.ts"]);
  });
}

async function t8() {
  return trajectory("T8-partial-listing", {
    scenarioId: "m2-independent-p2-t8",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/beacon.ts", kind: "file", contents: `export const meridianTide = "beacon-8";\n` },
    ],
    requestId: "sundial-t8-all",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_PARTIAL_LISTING,
    scan: scan(0),
    listingObserver: async input => {
      const { runDirectoryListHelper } = await import("../../../dist/adapters/cli/directory-listing.js");
      const result = await runDirectoryListHelper(input);
      if (!result.ok) return result;
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: "partial",
          errors: [{ name: "obscured.ts", code: "EACCES", message: "listing denied" }],
        },
      };
    },
  }, (domain, oracle) => {
    assert.equal(domain.status, "unknown");
    assert.equal(domain.resolution, "partial");
    assert.equal(domain.coverage, "partial");
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(domain.rootFact.listing.errors, ["EACCES"]);
    assert.deepEqual(denominators(domain), [1, 0, 1, 1, 1, 0, 0]);
    assertMatches(domain, oracle);
  });
}

async function t10a() {
  return trajectory("T10a-no-fake-cross-block", {
    scenarioId: "m2-independent-p2-t10a",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/fjord.ts", kind: "file", contents: "efghzzzz" },
    ],
    requestId: "sundial-t10a-all",
    needle: "gzh",
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_CHUNK_TERMINAL,
    scan: scan(0, 4),
  }, (domain, oracle, result) => {
    assert.equal(domain.status, "unmet");
    assert.equal(domain.resolution, "not_found");
    assert.equal(domain.bytesReadTotal, 8);
    assert.deepEqual(domain.matches, []);
    assertMatches(domain, oracle);
    const states = result.response?.report?.states;
    const candidate = states?.at(-1)?.value?.candidates?.find(item => item.path.endsWith("fjord.ts"));
    assert.equal(candidate?.scan?.chunks, 2);
    assert.equal(candidate?.scan?.firstMatch, null);
  });
}

async function t10b() {
  return trajectory("T10b-utf8-cross-block", {
    scenarioId: "m2-independent-p2-t10b",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/whirl.ts", kind: "file", contents: "nvv\u00b1Mqq" },
    ],
    requestId: "sundial-t10b-all",
    needle: "\u00b1M",
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_SIX,
    scan: scan(0, 4),
  }, (domain, oracle, result) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.bytesReadTotal, 8);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.matches[0].byteSpan, { start: 3, end: 6 });
    assert.equal(domain.matches[0].line, 1);
    assert.equal(domain.matches[0].column, 4);
    const states = result.response?.report?.states;
    const candidate = states?.at(-1)?.value?.candidates?.find(item => item.path.endsWith("whirl.ts"));
    assert.equal(candidate?.scan?.chunks, 2);
  });
}

async function t10c() {
  let listingCalls = 0;
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-independent-p2-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "m2-independent-p2-t10c",
      entries: [
        { path: "vault", kind: "directory" },
        { path: "vault/ship.ts", kind: "file", contents: "abcdef" },
      ],
      sessions: [SESSION],
    },
    listingObserver: async input => {
      listingCalls += 1;
      const { runDirectoryListHelper } = await import("../../../dist/adapters/cli/directory-listing.js");
      return runDirectoryListHelper(input);
    },
  });
  try {
    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, "vault");
    const before = { cwd: process.cwd(), sessionCwd: sandbox.getSession(session).cwd, tree: await snapshotTree(sandbox.scenarioRoot) };
    await assert.rejects(
      runCliContentSearchGoal(
        request(directory, { requestId: "sundial-t10c-reject", needle: "\u00b1M", cardinality: "all", recursion: "flat" }),
        { sandbox, session, profile, limits: LIMITS_ONE, scan: scan(0, 2) },
      ),
      TypeError,
    );
    assert.equal(listingCalls, 0);
    assert.equal(process.cwd(), before.cwd);
    assert.equal(sandbox.getSession(session).cwd, before.sessionCwd);
    assert.deepEqual(await snapshotTree(sandbox.scenarioRoot), before.tree);
    assert.deepEqual([...sandbox.getSession(session).grantedEffects].sort(), ["filesystem.read", "process.exec"]);
    return {
      label: "T10c-needle-longer-than-chunk",
      rejected: "TypeError",
      listingCalls,
      readOnly: { cwdUnchanged: true, entriesUnchanged: true, contentsUnchanged: true, readOnlyEffects: true },
    };
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function t11() {
  let lstatCalls = 0;
  return trajectory("T11-size-change-history", {
    scenarioId: "m2-independent-p2-t11",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/gulf.ts", kind: "file", contents: "x".repeat(10) + NEEDLE + "y".repeat(20) },
    ],
    requestId: "sundial-t11-all",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_THREE,
    scan: scan(0, 4096),
    oracleAfterRun: true,
    contentChanges: {
      "vault/gulf.ts": "x".repeat(10) + NEEDLE + "y".repeat(20) + "z".repeat(20),
    },
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        lstatCalls += 1;
        if (lstatCalls === 1) await appendFile(path, "z".repeat(20));
        return stats;
      },
      open: (path, flags) => open(path, flags),
    },
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.historicalMatches[0].size, 42);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal + domain.historicalMatches[0].size);
    assert.equal(domain.historicalMatches.length, 1);
    assert.equal(domain.historicalMatches[0].invalidation.kind, "size_changed");
    assertMatches(domain, oracle);
  });
}

async function t11aCurrent() {
  return trajectory("T11a-in-place-rewrite", {
    scenarioId: "m2-independent-p2-t11a-current",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/hull.ts", kind: "file", contents: "x".repeat(32) },
    ],
    requestId: "sundial-t11a-current",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_ONE,
    scan: scan(0),
    oracleAfterRun: true,
    contentChanges: {
      "vault/hull.ts": "w".repeat(20) + NEEDLE,
    },
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        if (path.endsWith("hull.ts")) {
          const handle = await open(path, "r+");
          await handle.write("w".repeat(20) + NEEDLE, 0, "utf8");
          await handle.close();
        }
        return stats;
      },
      open: (path, flags) => open(path, flags),
    },
  }, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.historicalMatches.length, 0);
    assertMatches(domain, oracle);
  });
}

async function t11aStale() {
  let readCalls = 0;
  return trajectory("T11a-mid-read-stale-history", {
    scenarioId: "m2-independent-p2-t11a-stale",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/quay.ts", kind: "file", contents: "a".repeat(2) + NEEDLE + "b".repeat(18) },
    ],
    requestId: "sundial-t11a-stale",
    needle: NEEDLE,
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_STALE_RESCAN,
    scan: scan(0, 16),
    oracleAfterRun: true,
    contentChanges: {
      "vault/quay.ts": "c".repeat(30),
    },
    fileReadIo: {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: opts => handle.stat(opts),
          read: async (buffer, offset, length, position) => {
            readCalls += 1;
            if (readCalls === 1) {
              const result = await handle.read(buffer, offset, length, position);
              return { bytesRead: result.bytesRead };
            }
            if (readCalls === 2) {
              await writeFile(path, "c".repeat(30));
              const error = new Error("changed");
              error.code = "READ_TARGET_CHANGED";
              throw error;
            }
            const result = await handle.read(buffer, offset, length, position);
            return { bytesRead: result.bytesRead };
          },
          close: () => handle.close(),
        };
      },
    },
  }, (domain, oracle) => {
    assert.equal(domain.status, "unmet");
    assert.equal(domain.resolution, "not_found");
    assert.equal(domain.bytesReadTotal, 46);
    assert.equal(domain.historicalMatches.length, 1);
    assert.equal(domain.historicalMatches[0].invalidation.kind, "read_stale");
    assert.equal(domain.historicalMatches[0].invalidation.code, "READ_TARGET_CHANGED");
    assertMatches(domain, oracle);
  });
}

async function depthTrajectory(label, depth, hit, limits) {
  const scenarioId = `m2-independent-p2-t14-${depth}-${hit ? "hit" : "nohit"}`;
  const entries = [
    { path: "scan", kind: "directory" },
    {
      path: "scan/pier.ts",
      kind: "file",
      contents: hit ? `export const meridianTide = "pier";\n` : `export const pierState = "idle";\n`,
    },
    { path: "scan/beacon", kind: "directory" },
    { path: "scan/beacon/pier.ts", kind: "file", contents: `export const pierState = "branch";\n` },
    { path: "scan/beacon/reef", kind: "directory" },
    {
      path: "scan/beacon/reef/floor.ts",
      kind: "file",
      contents: hit ? `export const meridianTide = "floor";\n` : `export const floorState = "idle";\n`,
    },
  ];
  return trajectory(label, {
    scenarioId,
    scope: "scan",
    entries,
    requestId: `sundial-t14-${depth}-${hit ? "hit" : "nohit"}`,
    needle: NEEDLE,
    cardinality: "all",
    recursion: "nested",
    limits,
    scan: scan(depth),
  }, (domain, oracle) => {
    const expectedResolution = depth === 2
      ? hit ? "matched" : "not_found"
      : hit ? "partial" : "insufficient_evidence";
    assert.equal(domain.resolution, expectedResolution);
    assert.equal(domain.coverage, depth === 2 ? "complete" : "partial");
    assert.equal(domain.denominators.listedDirectories, depth + 1);
    assert.equal(domain.denominators.directoriesUncovered, depth === 2 ? 0 : 1);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
  });
}

async function t14() {
  return {
    aHit: pick(await depthTrajectory("T14a-depth-0-hit", 0, true, LIMITS_SINGLE_TERMINAL)),
    aNoHit: pick(await depthTrajectory("T14a-depth-0-no-hit", 0, false, LIMITS_SINGLE_TERMINAL)),
    bHit: pick(await depthTrajectory("T14b-depth-1-hit", 1, true, LIMITS_DEPTH_ONE)),
    bNoHit: pick(await depthTrajectory("T14b-depth-1-no-hit", 1, false, LIMITS_DEPTH_ONE)),
    cHit: pick(await depthTrajectory("T14c-depth-2-hit", 2, true, LIMITS_FIVE)),
    cNoHit: pick(await depthTrajectory("T14c-depth-2-no-hit", 2, false, LIMITS_FIVE_NO_HIT)),
  };
}

async function trajectoryT12(label) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-independent-p2-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "m2-independent-p2-t12",
      entries: [
        { path: "vault", kind: "directory" },
        { path: "vault/long.ts", kind: "file", contents: "a".repeat(4080) + NEEDLE + "b".repeat(10) },
      ],
      sessions: [SESSION],
    },
  });
  try {
    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, "vault");
    const scenarioRoot = sandbox.scenarioRoot;
    const oracle = await oracleScan({ scenarioRoot, scope: "vault", maxDepth: 0, needle: NEEDLE });
    const before = { processCwd: process.cwd(), sessionCwd: sandbox.getSession(session).cwd, tree: await snapshotTree(scenarioRoot) };
    const requestArgs = { requestId: "sundial-t12", needle: NEEDLE, cardinality: "all", recursion: "flat" };
    const first = await runCliContentSearchGoal(request(directory, requestArgs), {
      sandbox, session, profile, limits: LIMITS_T12_FIRST, scan: scan(0, 4096),
    });
    assert.equal(first.domain.status, "unknown");
    assert.equal(first.domain.resolution, "interrupted");
    assert.equal(first.domain.bytesReadTotal, 4096);
    assert.ok(first.domain.preserve.continuation !== null);
    const second = await runCliContentSearchGoal(request(directory, requestArgs), {
      sandbox, session, profile, limits: LIMITS_T12_SECOND, scan: scan(0, 4096),
      continuation: first.domain.preserve.continuation,
    });
    assert.equal(second.domain.status, "achieved");
    assert.equal(second.domain.resolution, "matched");
    assert.equal(second.domain.bytesReadTotal, 4102);
    assert.equal(second.domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(second.domain.duplicateReads, 0);
    assertMatches(second.domain, oracle);
    const readOnly = await assertReadOnly({ sandbox, session, scenarioRoot }, before, second.domain);
    return {
      label,
      oracle: { candidates: oracle.candidates, matchPaths: oracle.matchPaths, bytesTotal: oracle.bytesTotal },
      first: summary(first.domain),
      second: summary(second.domain),
      continuation: { present: true, requestId: "sundial-t12" },
      readOnly,
    };
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function f1ZeroBudget() {
  return trajectory("F1-zero-byte-budget", {
    scenarioId: "m2-independent-p2-f1",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/sandbar.ts", kind: "file", contents: "abzqwmkl" },
    ],
    requestId: "sundial-f1-budget",
    needle: "zmq",
    cardinality: "all",
    recursion: "flat",
    limits: { maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 4 },
    scan: { ...scan(0, 4), maxTotalBytes: 0 },
  }, (domain, oracle) => {
    assert.equal(domain.status, "unknown");
    assert.equal(domain.resolution, "interrupted");
    assert.equal(domain.rootFact.kind, "interrupted");
    assert.equal(domain.coverage, "partial");
    assert.equal(domain.bytesReadTotal, 0);
    assert.deepEqual(domain.matches, []);
    assert.equal(oracle.candidates.length, 1);
  });
}

async function f2() {
  const a = await trajectory("F2-locus-a", {
    scenarioId: "m2-independent-p2-f2a",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/keel.ts", kind: "file", contents: "mno\npqr\n" },
    ],
    requestId: "sundial-f2-a",
    needle: "mno",
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_SIX,
    scan: scan(0, 4),
  }, (domain, oracle, result) => {
    assert.equal(domain.status, "achieved");
    assert.deepEqual(domain.matches[0].byteSpan, { start: 0, end: 3 });
    assert.equal(domain.matches[0].line, 1);
    assert.equal(domain.matches[0].column, 1);
    assertMatches(domain, oracle);
    const states = result.response?.report?.states;
    const candidate = states?.at(-1)?.value?.candidates?.find(item => item.path.endsWith("keel.ts"));
    assert.equal(candidate?.scan?.chunks, 2);
  });
  const b = await trajectory("F2-locus-b", {
    scenarioId: "m2-independent-p2-f2b",
    scope: "vault",
    entries: [
      { path: "vault", kind: "directory" },
      { path: "vault/oar.ts", kind: "file", contents: "z\nw\nq\n" },
    ],
    requestId: "sundial-f2-b",
    needle: "\nq",
    cardinality: "all",
    recursion: "flat",
    limits: LIMITS_SIX,
    scan: scan(0, 4),
  }, (domain, oracle, result) => {
    assert.equal(domain.status, "achieved");
    assert.deepEqual(domain.matches[0].byteSpan, { start: 3, end: 5 });
    assert.equal(domain.matches[0].line, 2);
    assert.equal(domain.matches[0].column, 2);
    assertMatches(domain, oracle);
    const states = result.response?.report?.states;
    const candidate = states?.at(-1)?.value?.candidates?.find(item => item.path.endsWith("oar.ts"));
    assert.equal(candidate?.scan?.chunks, 2);
  });
  return { a: pick(a), b: pick(b) };
}

try {
  const beforeCwd = process.cwd();
  const normal = pick(await t1());
  const t3Result = await t3();
  const sameName = pick(await t5());
  const partial = pick(await t8());
  const t10aResult = pick(await t10a());
  const t10bResult = pick(await t10b());
  const t10cResult = await t10c();
  const t11Result = pick(await t11());
  const t11aCurrentResult = pick(await t11aCurrent());
  const t11aStaleResult = pick(await t11aStale());
  const t12 = await trajectoryT12("T12-budget-continuation");
  const t14Result = await t14();
  const f1 = pick(await f1ZeroBudget());
  const f2Result = await f2();

  assert.notEqual(normal.result.bytesReadTotal, 0);
  assert.equal(process.cwd(), beforeCwd);
  payload.trajectories = {
    t1: normal,
    t3: t3Result,
    t5: sameName,
    t8: partial,
    t10a: t10aResult,
    t10b: t10bResult,
    t10c: t10cResult,
    t11: t11Result,
    t11aCurrent: t11aCurrentResult,
    t11aStale: t11aStaleResult,
    t12,
    t14: t14Result,
    f1,
    f2: f2Result,
  };
  payload.exitCode = 0;
  payload.readOnly = true;
  payload.cwdUnchanged = true;
  payload.entriesUnchanged = true;
  payload.contentsUnchanged = true;
  await writeFile(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    consumer: "independent-family",
    exitCode: 0,
    needle: NEEDLE,
    scenarios: ["T1", "T3", "T5", "T8", "T10a", "T10b", "T10c", "T11", "T11a", "T12", "T14", "F1", "F2"],
    output: RESULT_PATH,
    readOnly: true,
  })}\n`);
} catch (error) {
  await writeFile(RESULT_PATH, `${JSON.stringify({
    ...payload,
    exitCode: 1,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }, null, 2)}\n`);
  throw error;
}
