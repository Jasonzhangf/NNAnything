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
  "/Volumes/Intel/playground/nnanything-runs/cli-programming-search-m2-20261024/consumer-p2.json";
const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const profile = JSON.parse(await readFile(profileFile, "utf8"));

const SESSION = Object.freeze({
  id: "s",
  cwd: ".",
  grantedEffects: Object.freeze(["filesystem.read", "process.exec"]),
});
const LIMITS_ONE = Object.freeze({ maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 5 });
const LIMITS_THREE = Object.freeze({ maxTransitions: 51, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_FOUR = Object.freeze({ maxTransitions: 44, maxDepth: 8, maxDerivedGoals: 8 });
const LIMITS_SIX = Object.freeze({ maxTransitions: 30, maxDepth: 8, maxDerivedGoals: 6 });
const LIMITS_PARTIAL_LISTING = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 3 });
const LIMITS_T12_FIRST = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_T12_SECOND = Object.freeze({ maxTransitions: 31, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_CHUNK_TERMINAL = Object.freeze({ maxTransitions: 33, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_STALE_RESCAN = Object.freeze({ maxTransitions: 54, maxDepth: 8, maxDerivedGoals: 7 });
const LIMITS_DEPTH_ONE = Object.freeze({ maxTransitions: 47, maxDepth: 8, maxDerivedGoals: 6 });
const LIMITS_FIVE = Object.freeze({ maxTransitions: 65, maxDepth: 8, maxDerivedGoals: 11 });
const LIMITS_FIVE_NO_HIT = Object.freeze({ maxTransitions: 68, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_SINGLE_TERMINAL = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 3 });
const LIMITS_P1 = Object.freeze({ maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 16 });

function scan(depth = 0, chunkSize = 65536) {
  return Object.freeze({
    maxBytesPerFile: 65536,
    maxTotalBytes: 262144,
    chunkSize,
    maxDirectoryDepth: depth,
    maxStaleRetries: 1,
  });
}

function request({ requestId, directory, needle, cardinality, recursion }) {
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
  const directories = [{ relative: "", absolute: scopeRoot, depth: 0 }];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (directory.depth >= maxDepth) continue;
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
      directories.push({
        relative,
        absolute: join(directory.absolute, entry.name),
        depth: directory.depth + 1,
      });
    }
  }
  return directories;
}

// Independent oracle: walks real files with node:fs only. It does not import
// any nnanything filter or adapter decision logic.
async function oracleScan({ scenarioRoot, scope, maxDepth, needle }) {
  const scopeRoot = resolve(scenarioRoot, scope);
  const directories = await listOracleDirectories(scopeRoot, maxDepth);
  const candidates = [];
  for (const directory of directories) {
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of entries) {
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
    directories: directories.map(directory => ({
      path: directory.absolute,
      depth: directory.depth,
    })),
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
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
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

async function freshScenario(options, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-consumer-p2-")));
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
    return await body({ sandbox, session, scenarioRoot: sandbox.scenarioRoot });
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function runSearch(context, goalRequest, options) {
  return runCliContentSearchGoal(goalRequest, {
    sandbox: context.sandbox,
    session: context.session,
    profile,
    limits: options.limits,
    scan: options.scan,
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
    ...(options.order === undefined ? {} : { order: options.order }),
  });
}

async function captureReadOnly(context) {
  return {
    processCwd: process.cwd(),
    sessionCwd: context.sandbox.getSession(context.session).cwd,
    tree: await snapshotTree(context.scenarioRoot),
  };
}

async function assertReadOnly(context, before, domains) {
  assert.equal(process.cwd(), before.processCwd);
  assert.equal(context.sandbox.getSession(context.session).cwd, before.sessionCwd);
  assert.deepEqual(await snapshotTree(context.scenarioRoot), before.tree);
  const granted = [...context.sandbox.getSession(context.session).grantedEffects].sort();
  assert.deepEqual(granted, ["filesystem.read", "process.exec"]);
  for (const domain of domains) {
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
  }
  return {
    cwdUnchanged: true,
    entriesUnchanged: true,
    contentsUnchanged: true,
    readOnlyEffects: true,
  };
}

async function assertReadOnlyWithChanges(context, before, domains, contentChanges) {
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
  for (const domain of domains) {
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

function stateCandidate(result, suffix) {
  const states = result.response?.report?.states;
  const value = Array.isArray(states) && states.length > 0 ? states[states.length - 1]?.value : null;
  return value?.candidates?.find(candidate => candidate.path.endsWith(suffix)) ?? null;
}

function summary(domain) {
  return {
    status: domain.status,
    resolution: domain.resolution,
    satisfaction: domain.satisfaction,
    cardinality: domain.cardinality,
    recursion: domain.recursion,
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

async function scenarioP1() {
  const INGEST = `export const traceToken = "tel-9f3a";\nexport function ingest(){ return "tel-9f3a"; }\n`;
  const RELAY = `export const auditTag = "relay-audit-7";\nexport const relayMode = "shadow";\nexport const relayCapacity = 64;\n`;
  const MANUAL = `traceToken is documented here.\n`;
  return freshScenario({
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
      { path: "src/relay.ts", kind: "file", contents: RELAY },
      { path: "src/manual.txt", kind: "file", contents: MANUAL },
    ],
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "src");
    const before = await captureReadOnly(context);
    const normal = await runSearch(context, request({
      requestId: "consumer-normal",
      directory,
      needle: "traceToken",
      cardinality: "one",
      recursion: "flat",
    }), { limits: LIMITS_P1, scan: scan(0) });
    assert.equal(normal.domain.status, "achieved");
    assert.equal(normal.domain.resolution, "matched");
    assert.equal(normal.domain.invocationCount, 3);
    assert.equal(normal.domain.bytesReadTotal, 85);
    assert.equal(normal.domain.matches.length, 1);
    assert.ok(normal.domain.matches[0].path.endsWith("/ingest.ts"));

    const recovered = await runSearch(context, request({
      requestId: "consumer-recovery",
      directory,
      needle: "traceToken",
      cardinality: "one",
      recursion: "flat",
    }), {
      limits: LIMITS_P1,
      scan: scan(0),
      order: { kind: "injected-first", name: "relay.ts" },
    });
    assert.equal(recovered.domain.status, "achieved");
    assert.equal(recovered.domain.deliberateSuboptimal, true);
    assert.equal(recovered.domain.invocationCount, 5);
    assert.equal(recovered.domain.bytesReadTotal, 194);
    assert.equal(recovered.domain.negatives.length, 1);
    assert.ok(recovered.domain.negatives[0].path.endsWith("/relay.ts"));

    const readOnly = await assertReadOnly(context, before, [normal.domain, recovered.domain]);
    return {
      scenario: "P1-public-one",
      normal: summary(normal.domain),
      recovery: summary(recovered.domain),
      readOnly,
    };
  });
}

async function scenarioT1() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/amber.ts", kind: "file", contents: `export const quarryMark = "amber-1";\n` },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t1", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t1-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_ONE, scan: scan(0) });
    const domain = result.domain;

    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.satisfaction, 100);
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.rootFact.kind, "matched");
    assert.equal(domain.invocationCount, 3);
    assert.equal(domain.observationCount, 3);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.bytesReadTotal, 37);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.deepEqual(denominators(domain), [1, 1, 1, 1, 1, 0, 0]);
    assert.equal(domain.denominators.directoriesUncovered, 0);
    assert.equal(domain.denominators.typeMismatches, 0);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives, []);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T1",
      oracle: {
        directories: oracle.directories,
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        coverage: "complete",
      },
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT3a() {
  const entries = [
    { path: "scan", kind: "directory" },
    {
      path: "scan/large.ts",
      kind: "file",
      contents: "a".repeat(4000) + "quarryMark" + "b".repeat(8192 - 4000 - 10),
    },
    { path: "scan/other.ts", kind: "file", contents: `export const otherState = "idle";\n` },
  ];
  const one = await freshScenario({ scenarioId: "m2-test-quartz-t3a", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t3a-one",
      directory,
      needle: "quarryMark",
      cardinality: "one",
      recursion: "flat",
    }), { limits: LIMITS_ONE, scan: scan(0, 4096) });
    const domain = result.domain;

    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.invocationCount, 3);
    assert.equal(domain.bytesReadTotal, 4096);
    assert.ok(domain.bytesReadTotal < oracle.bytesTotal);
    assert.equal(domain.matches.length, 1);
    assert.equal(domain.matches[0].scanComplete, false);
    // one stops at the first chunk hit; the candidate is not a complete scan.
    // Per Plan §1.2, candidatesScanned counts complete scans only, so the
    // matched-but-unfinished candidate sits in candidatesUnresolved (REV4).
    assert.deepEqual(denominators(domain), [1, 1, 2, 0, 1, 0, 2]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives, []);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T3a-one",
      oracle: {
        candidates: oracle.candidates,
        fullBytesTotal: oracle.bytesTotal,
        firstChunkBytes: 4096,
        coverage: "partial",
      },
      result: summary(domain),
      readOnly,
    };
  });

  const all = await freshScenario({ scenarioId: "m2-test-quartz-t3a", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t3a-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_FOUR, scan: scan(0, 4096) });
    const domain = result.domain;

    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.invocationCount, 6);
    assert.equal(domain.bytesReadTotal, 8226);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.deepEqual(denominators(domain), [1, 1, 2, 2, 1, 1, 0]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T3a-all",
      oracle: {
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        coverage: "complete",
      },
      result: summary(domain),
      readOnly,
    };
  });

  assert.ok(one.result.invocationCount < all.result.invocationCount);
  assert.ok(one.result.bytesReadTotal < all.result.bytesReadTotal);
  return { scenario: "P2-T3a", one, all };
}

async function scenarioT5() {
  const entries = [
    { path: "left", kind: "directory" },
    { path: "right", kind: "directory" },
    { path: "left/report.ts", kind: "file", contents: `export const reportState = "left";\n` },
    { path: "right/report.ts", kind: "file", contents: `export const quarryMark = "right-5";\n` },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t5", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, ".");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: ".", maxDepth: 1, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t5-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "nested",
    }), { limits: LIMITS_THREE, scan: scan(1) });
    const domain = result.domain;

    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.invocationCount, 7);
    assert.equal(domain.observationCount, 7);
    assert.equal(domain.bytesReadTotal, 72);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(denominators(domain), [3, 3, 2, 2, 1, 1, 0]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    assert.equal(domain.negatives[0].path.endsWith("/left/report.ts"), true);
    assert.deepEqual(domain.rootFact.candidateNames, ["report.ts", "report.ts"]);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T5",
      oracle: {
        directories: oracle.directories,
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        coverage: "complete",
      },
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT8() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/known.ts", kind: "file", contents: `export const quarryMark = "known-8";\n` },
  ];
  return freshScenario({
    scenarioId: "m2-test-quartz-t8",
    entries,
    listingObserver: async input => {
      const { runDirectoryListHelper } = await import("../../../dist/adapters/cli/directory-listing.js");
      const result = await runDirectoryListHelper(input);
      if (!result.ok) return result;
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: "partial",
          errors: [{ name: "uncertain.ts", code: "EACCES", message: "listing denied" }],
        },
      };
    },
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t8-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_PARTIAL_LISTING, scan: scan(0) });
    const domain = result.domain;

    assert.equal(domain.status, "unknown");
    assert.equal(domain.resolution, "partial");
    assert.equal(domain.coverage, "partial");
    assert.equal(domain.rootFact.kind, "partial");
    assert.equal(domain.rootFact.listing.coverage, "partial");
    assert.deepEqual(domain.rootFact.listing.errors, ["EACCES"]);
    assert.deepEqual(domain.rootFact.reasons, ["listing_partial"]);
    assert.equal(domain.invocationCount, 3);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.bytesReadTotal, 37);
    assert.deepEqual(denominators(domain), [1, 0, 1, 1, 1, 0, 0]);
    assert.equal(domain.denominators.directoriesUncovered, 1);
    assert.equal(domain.denominators.typeMismatches, 0);
    assertMatches(domain, oracle);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T8",
      oracle: {
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        coverage: "partial",
      },
      injectedListingError: { name: "uncertain.ts", code: "EACCES" },
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT10b() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/utf.ts", kind: "file", contents: "bxx\u00e9Xyy" },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t10b", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "\u00e9X" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t10b-all",
      directory,
      needle: "\u00e9X",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_SIX, scan: scan(0, 4) });
    const domain = result.domain;

    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.invocationCount, 4);
    assert.equal(domain.observationCount, 4);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.bytesReadTotal, 8);
    assert.deepEqual(denominators(domain), [1, 1, 1, 1, 1, 0, 0]);
    assert.deepEqual(domain.matches[0].byteSpan, { start: 3, end: 6 });
    assert.equal(domain.matches[0].line, 1);
    assert.equal(domain.matches[0].column, 4);
    assert.equal(domain.matches[0].scanComplete, true);
    assertMatches(domain, oracle);
    assert.equal(stateCandidate(result, "utf.ts")?.scan?.chunks, 2);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T10b",
      oracle: {
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        coverage: "complete",
      },
      chunks: stateCandidate(result, "utf.ts")?.scan?.chunks ?? null,
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT12() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/long.ts", kind: "file", contents: "a".repeat(4080) + "quarryMark" + "b".repeat(10) },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t12", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const sharedScan = scan(0, 4096);
    const first = await runSearch(context, request({
      requestId: "p2-t12-part1",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_T12_FIRST, scan: sharedScan });
    const firstDomain = first.domain;

    assert.equal(firstDomain.status, "unknown");
    assert.equal(firstDomain.resolution, "interrupted");
    assert.equal(firstDomain.satisfaction, null);
    assert.equal(firstDomain.coverage, "partial");
    assert.equal(firstDomain.rootFact.kind, "interrupted");
    assert.equal(firstDomain.invocationCount, 3);
    assert.equal(firstDomain.observationCount, 3);
    assert.equal(firstDomain.bytesReadTotal, 4096);
    assert.deepEqual(denominators(firstDomain), [1, 1, 1, 0, 1, 0, 1]);
    assert.equal(firstDomain.matches.length, 1);
    assert.equal(firstDomain.matches[0].scanComplete, false);
    assert.deepEqual(firstDomain.matches[0].byteSpan, oracle.candidates[0].match.byteSpan);
    assert.equal(firstDomain.duplicateReads, 0);
    assert.equal(firstDomain.budgetUsed.transitionsUsed, 26);
    assert.equal(firstDomain.budgetUsed.derivedGoalsUsed, 4);
    assert.ok(firstDomain.preserve.continuation !== null);

    const second = await runSearch(context, request({
      requestId: "p2-t12-part1",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), {
      limits: LIMITS_T12_SECOND,
      scan: sharedScan,
      continuation: firstDomain.preserve.continuation,
    });
    const secondDomain = second.domain;

    assert.equal(secondDomain.status, "achieved");
    assert.equal(secondDomain.resolution, "matched");
    assert.equal(secondDomain.coverage, "complete");
    assert.equal(secondDomain.invocationCount, 4);
    assert.equal(secondDomain.observationCount, 4);
    assert.equal(secondDomain.bytesReadTotal, 4100);
    assert.equal(secondDomain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(secondDomain.duplicateReads, 0);
    assert.equal(secondDomain.matches.length, 1);
    assert.equal(secondDomain.matches[0].scanComplete, true);
    assert.deepEqual(secondDomain.matches[0].byteSpan, { start: 4080, end: 4090 });
    assert.deepEqual(denominators(secondDomain), [1, 1, 1, 1, 1, 0, 0]);
    assert.equal(secondDomain.budgetUsed.transitionsUsed, 31);
    assert.equal(secondDomain.budgetUsed.derivedGoalsUsed, 4);
    assertMatches(secondDomain, oracle);

    const readOnly = await assertReadOnly(context, before, [firstDomain, secondDomain]);
    return {
      scenario: "P2-T12",
      oracle: {
        candidates: oracle.candidates,
        bytesTotal: oracle.bytesTotal,
        firstSliceBytes: 4096,
        coverage: "complete after continuation",
      },
      first: summary(firstDomain),
      second: summary(secondDomain),
      continuation: {
        present: firstDomain.preserve.continuation !== null,
        requestId: "p2-t12-part1",
        transitionsUsed: secondDomain.budgetUsed.transitionsUsed,
        derivedGoalsUsed: secondDomain.budgetUsed.derivedGoalsUsed,
      },
      readOnly,
    };
  });
}

async function scenarioT3() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/first.ts", kind: "file", contents: `export const quarryMark = "first-3";\n` },
    { path: "scan/second.ts", kind: "file", contents: `export const secondState = "idle";\n` },
    { path: "scan/third.ts", kind: "file", contents: `export const thirdState = "idle";\n` },
  ];
  const one = await freshScenario({ scenarioId: "m2-test-quartz-t3", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t3-one",
      directory,
      needle: "quarryMark",
      cardinality: "one",
      recursion: "flat",
    }), { limits: LIMITS_ONE, scan: scan(0) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.equal(domain.cardinality, "one");
    assert.equal(domain.invocationCount, 3);
    assert.equal(domain.bytesReadTotal, 37);
    assert.deepEqual(denominators(domain), [1, 1, 3, 1, 1, 0, 2]);
    assertMatches(domain, oracle);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.deepEqual(domain.negatives, []);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T3-one",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      readOnly,
    };
  });

  const all = await freshScenario({ scenarioId: "m2-test-quartz-t3", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t3-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_THREE, scan: scan(0) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.equal(domain.cardinality, "all");
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.invocationCount, 7);
    assert.equal(domain.bytesReadTotal, 106);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.deepEqual(denominators(domain), [1, 1, 3, 3, 1, 2, 0]);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T3-all",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      readOnly,
    };
  });
  assert.ok(one.result.invocationCount < all.result.invocationCount);
  assert.ok(one.result.bytesReadTotal < all.result.bytesReadTotal);
  return { scenario: "P2-T3", one, all };
}

async function scenarioT10a() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/boundary.ts", kind: "file", contents: "abcdxxxx" },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t10a", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "dcd" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t10a-all",
      directory,
      needle: "dcd",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_CHUNK_TERMINAL, scan: scan(0, 4) });
    const domain = result.domain;
    assert.equal(domain.status, "unmet");
    assert.equal(domain.resolution, "not_found");
    assert.equal(domain.bytesReadTotal, 8);
    assert.deepEqual(denominators(domain), [1, 1, 1, 1, 0, 1, 0]);
    assert.deepEqual(domain.matches, []);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    assert.equal(stateCandidate(result, "boundary.ts")?.scan?.chunks, 2);
    assert.equal(stateCandidate(result, "boundary.ts")?.scan?.firstMatch, null);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T10a",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      chunks: stateCandidate(result, "boundary.ts")?.scan?.chunks ?? null,
      readOnly,
    };
  });
}

async function scenarioT10c() {
  let listingCalls = 0;
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/byte.ts", kind: "file", contents: "abcdef" },
  ];
  return freshScenario({
    scenarioId: "m2-test-quartz-t10c",
    entries,
    listingObserver: async input => {
      listingCalls += 1;
      const { runDirectoryListHelper } = await import("../../../dist/adapters/cli/directory-listing.js");
      return runDirectoryListHelper(input);
    },
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const before = await captureReadOnly(context);
    await assert.rejects(
      runSearch(context, request({
        requestId: "p2-t10c-reject",
        directory,
        needle: "\u00e9X",
        cardinality: "all",
        recursion: "flat",
      }), { limits: LIMITS_ONE, scan: scan(0, 2) }),
      TypeError,
    );
    assert.equal(listingCalls, 0);
    assert.equal(process.cwd(), before.processCwd);
    assert.equal(context.sandbox.getSession(context.session).cwd, before.sessionCwd);
    assert.deepEqual(await snapshotTree(context.scenarioRoot), before.tree);
    assert.deepEqual(
      [...context.sandbox.getSession(context.session).grantedEffects].sort(),
      ["filesystem.read", "process.exec"],
    );
    return {
      scenario: "P2-T10c",
      rejected: "TypeError",
      listingCalls,
      readOnly: {
        cwdUnchanged: true,
        entriesUnchanged: true,
        contentsUnchanged: true,
        readOnlyEffects: true,
      },
    };
  });
}

async function scenarioT11() {
  let lstatCalls = 0;
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/shift.ts", kind: "file", contents: "x".repeat(10) + "quarryMark" + "y".repeat(20) },
  ];
  return freshScenario({
    scenarioId: "m2-test-quartz-t11",
    entries,
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        lstatCalls += 1;
        if (lstatCalls === 1) await appendFile(path, "z".repeat(20));
        return stats;
      },
      open: (path, flags) => open(path, flags),
    },
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t11-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_THREE, scan: scan(0, 4096) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.invocationCount, 5);
    assert.equal(domain.observationCount, 5);
    assert.equal(domain.bytesReadTotal, 100);
    assert.equal(domain.duplicateReads, 0);
    assert.equal(domain.matches.length, 1);
    assert.equal(domain.matches[0].size, 60);
    assert.equal(domain.matches[0].bytesRead, 60);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.equal(domain.historicalMatches.length, 1);
    assert.equal(domain.historicalMatches[0].size, 40);
    assert.equal(domain.historicalMatches[0].bytesRead, 40);
    assert.equal(domain.historicalMatches[0].invalidation.kind, "size_changed");
    assert.equal(domain.historicalMatches[0].invalidation.code, null);
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    assertMatches(domain, oracle);
    const readOnly = await assertReadOnlyWithChanges(
      context,
      before,
      [domain],
      {
        "scan/shift.ts": "x".repeat(10) + "quarryMark" + "y".repeat(20) + "z".repeat(20),
      },
    );
    return {
      scenario: "P2-T11",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      historicalMatches: domain.historicalMatches.map(match => ({
        byteSpan: match.byteSpan,
        size: match.size,
        bytesRead: match.bytesRead,
        invalidation: match.invalidation,
      })),
      readOnly,
    };
  });
}

async function scenarioT11a() {
  const current = await freshScenario({
    scenarioId: "m2-test-quartz-t11a-current",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/a.ts", kind: "file", contents: "x".repeat(30) },
    ],
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        if (path.endsWith("a.ts")) {
          const handle = await open(path, "r+");
          await handle.write("w".repeat(20) + "quarryMark", 0, "utf8");
          await handle.close();
        }
        return stats;
      },
      open: (path, flags) => open(path, flags),
    },
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t11a-current",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_ONE, scan: scan(0) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.equal(domain.invocationCount, 3);
    assert.equal(domain.bytesReadTotal, 30);
    assert.equal(domain.historicalMatches.length, 0);
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    assertMatches(domain, oracle);
    assert.equal(domain.matches[0].byteSpan.start, 20);
    assert.equal(domain.matches[0].scanComplete, true);
    const readOnly = await assertReadOnlyWithChanges(
      context,
      before,
      [domain],
      {
        "scan/a.ts": "w".repeat(20) + "quarryMark",
      },
    );
    return {
      scenario: "P2-T11a-current",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      readOnly,
    };
  });

  let readCalls = 0;
  const stale = await freshScenario({
    scenarioId: "m2-test-quartz-t11a-stale",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/a.ts", kind: "file", contents: "a".repeat(6) + "quarryMark" + "b".repeat(14) },
    ],
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
              const rewrite = await open(path, "r+");
              await rewrite.write("c".repeat(30), 0, "utf8");
              await rewrite.close();
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
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t11a-stale",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_STALE_RESCAN, scan: scan(0, 16) });
    const domain = result.domain;
    assert.equal(domain.status, "unmet");
    assert.equal(domain.resolution, "not_found");
    assert.equal(domain.invocationCount, 7);
    assert.equal(domain.observationCount, 6);
    assert.equal(domain.bytesReadTotal, 46);
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "quarryMark" });
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    assert.equal(domain.historicalMatches.length, 1);
    assert.equal(domain.historicalMatches[0].invalidation.kind, "read_stale");
    assert.equal(domain.historicalMatches[0].invalidation.code, "READ_TARGET_CHANGED");
    const readOnly = await assertReadOnlyWithChanges(
      context,
      before,
      [domain],
      {
        "scan/a.ts": "c".repeat(30),
      },
    );
    return {
      scenario: "P2-T11a-stale",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      historicalMatches: domain.historicalMatches.map(match => ({
        byteSpan: match.byteSpan,
        size: match.size,
        bytesRead: match.bytesRead,
        invalidation: match.invalidation,
      })),
      readOnly,
    };
  });
  return { scenario: "P2-T11a", current, stale };
}

async function depthResult(label, scenarioId, depth, hit, limits) {
  const entries = [
    { path: "scan", kind: "directory" },
    {
      path: "scan/file.ts",
      kind: "file",
      contents: hit ? `export const quarryMark = "r14";\n` : `export const rootState = "idle";\n`,
    },
    { path: "scan/a", kind: "directory" },
    { path: "scan/a/file.ts", kind: "file", contents: `export const branchState = "idle";\n` },
    { path: "scan/a/b", kind: "directory" },
    {
      path: "scan/a/b/floor.ts",
      kind: "file",
      contents: hit ? `export const quarryMark = "f14";\n` : `export const floorState = "idle";\n`,
    },
  ];
  return freshScenario({ scenarioId, entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({
      scenarioRoot: context.scenarioRoot,
      scope: "scan",
      maxDepth: depth,
      needle: "quarryMark",
    });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: label === "T14a" ? "p2-t14a-all" : label === "T14b" ? "p2-t14b-all" : "p2-t14c-all",
      directory,
      needle: "quarryMark",
      cardinality: "all",
      recursion: "nested",
    }), { limits, scan: scan(depth) });
    const domain = result.domain;
    const expectedResolution = depth === 2
      ? hit ? "matched" : "not_found"
      : hit ? "partial" : "insufficient_evidence";
    assert.equal(domain.resolution, expectedResolution);
    assert.equal(domain.coverage, depth === 2 ? "complete" : "partial");
    assert.equal(domain.denominators.listedDirectories, depth + 1);
    assert.equal(domain.denominators.directoriesUncovered, depth === 2 ? 0 : 1);
    assertMatches(domain, oracle);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: `${label}-${hit ? "hit" : "no-hit"}`,
      depth,
      oracle: {
        directories: oracle.directories,
        candidates: oracle.candidates,
        matchPaths: oracle.matchPaths,
        negativePaths: oracle.negativePaths,
        bytesTotal: oracle.bytesTotal,
      },
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT14() {
  return {
    scenario: "P2-T14",
    aHit: await depthResult("T14a", "m2-test-quartz-t14a", 0, true, LIMITS_SINGLE_TERMINAL),
    aNoHit: await depthResult("T14a", "m2-test-quartz-t14a-nohit", 0, false, LIMITS_SINGLE_TERMINAL),
    bHit: await depthResult("T14b", "m2-test-quartz-t14b", 1, true, LIMITS_DEPTH_ONE),
    bNoHit: await depthResult("T14b", "m2-test-quartz-t14b-nohit", 1, false, LIMITS_DEPTH_ONE),
    cHit: await depthResult("T14c", "m2-test-quartz-t14c", 2, true, LIMITS_FIVE),
    cNoHit: await depthResult("T14c", "m2-test-quartz-t14c-nohit", 2, false, LIMITS_FIVE_NO_HIT),
  };
}

async function scenarioT15() {
  const entries = [
    { path: "scan", kind: "directory" },
    { path: "scan/mica.ts", kind: "file", contents: "abzqwmkl" },
  ];
  return freshScenario({ scenarioId: "m2-test-quartz-t15a", entries }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "zmq" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t15-budget-a",
      directory,
      needle: "zmq",
      cardinality: "all",
      recursion: "flat",
    }), {
      limits: { maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 4 },
      scan: { ...scan(0, 4), maxTotalBytes: 0 },
    });
    const domain = result.domain;
    assert.equal(domain.status, "unknown");
    assert.equal(domain.resolution, "interrupted");
    assert.equal(domain.rootFact.kind, "interrupted");
    assert.equal(domain.coverage, "partial");
    assert.equal(domain.bytesReadTotal, 0);
    assert.deepEqual(domain.matches, []);
    assert.deepEqual(domain.negatives, []);
    assert.deepEqual(domain.denominators, {
      listedDirectories: 1,
      directoriesComplete: 1,
      directoriesUncovered: 0,
      candidatesTotal: 1,
      candidatesScanned: 0,
      candidatesMatched: 0,
      candidatesNegative: 0,
      candidatesUnresolved: 1,
      typeMismatches: 0,
    });
    assert.equal(stateCandidate(result, "mica.ts")?.scan, null);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return {
      scenario: "P2-T15-zero-budget",
      oracle: { candidates: oracle.candidates, bytesTotal: oracle.bytesTotal },
      result: summary(domain),
      readOnly,
    };
  });
}

async function scenarioT16() {
  const a = await freshScenario({
    scenarioId: "m2-test-quartz-t16a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/apex.ts", kind: "file", contents: "abc\ndef\n" },
    ],
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "abc" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t16-locus-a",
      directory,
      needle: "abc",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_SIX, scan: scan(0, 4) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.deepEqual(domain.matches[0].byteSpan, { start: 0, end: 3 });
    assert.equal(domain.matches[0].line, 1);
    assert.equal(domain.matches[0].column, 1);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.equal(domain.bytesReadTotal, 8);
    assertMatches(domain, oracle);
    assert.equal(stateCandidate(result, "apex.ts")?.scan?.chunks, 2);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return { scenario: "P2-T16a", result: summary(domain), readOnly };
  });

  const b = await freshScenario({
    scenarioId: "m2-test-quartz-t16b",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/ruby.ts", kind: "file", contents: "a\nb\nx\n" },
    ],
  }, async context => {
    const directory = await context.sandbox.bindDirectory(context.session, "scan");
    const oracle = await oracleScan({ scenarioRoot: context.scenarioRoot, scope: "scan", maxDepth: 0, needle: "\nx" });
    const before = await captureReadOnly(context);
    const result = await runSearch(context, request({
      requestId: "p2-t16-locus-b",
      directory,
      needle: "\nx",
      cardinality: "all",
      recursion: "flat",
    }), { limits: LIMITS_SIX, scan: scan(0, 4) });
    const domain = result.domain;
    assert.equal(domain.status, "achieved");
    assert.deepEqual(domain.matches[0].byteSpan, { start: 3, end: 5 });
    assert.equal(domain.matches[0].line, 2);
    assert.equal(domain.matches[0].column, 2);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.equal(domain.bytesReadTotal, 6);
    assertMatches(domain, oracle);
    assert.equal(stateCandidate(result, "ruby.ts")?.scan?.chunks, 2);
    const readOnly = await assertReadOnly(context, before, [domain]);
    return { scenario: "P2-T16b", result: summary(domain), readOnly };
  });
  return { scenario: "P2-T16", a, b };
}

const payload = {
  consumer: "public",
  entry: "nnanything/cli-content-search",
  profile: profileFile,
  oracle: "node:fs directory walk plus Buffer.indexOf",
  generatedAt: new Date().toISOString(),
  scenarios: {},
};

const scenarios = [
  ["P1", scenarioP1],
  ["T1", scenarioT1],
  ["T3", scenarioT3],
  ["T5", scenarioT5],
  ["T8", scenarioT8],
  ["T10a", scenarioT10a],
  ["T10b", scenarioT10b],
  ["T10c", scenarioT10c],
  ["T11", scenarioT11],
  ["T11a", scenarioT11a],
  ["T12", scenarioT12],
  ["T14", scenarioT14],
  ["T15", scenarioT15],
  ["T16", scenarioT16],
  // T3a runs last so the other public scenarios still record evidence if the
  // frozen one-cardinality denominator row is inconsistent with the contract.
  ["T3a", scenarioT3a],
];
let currentScenario = null;

try {
  const beforeCwd = process.cwd();
  for (const [name, runScenario] of scenarios) {
    currentScenario = name;
    payload.scenarios[name] = await runScenario();
  }
  currentScenario = null;
  assert.equal(process.cwd(), beforeCwd);
  payload.exitCode = 0;
  payload.readOnly = true;
  payload.cwdUnchanged = true;
  payload.entriesUnchanged = true;
  payload.contentsUnchanged = true;
  await writeFile(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    consumer: "public",
    exitCode: 0,
    scenarios: ["P1", "T1", "T3-one", "T3-all", "T5", "T8", "T10a", "T10b", "T10c", "T11", "T11a-current", "T11a-stale", "T12", "T14", "T15-zero-budget", "T16a", "T16b", "T3a-one", "T3a-all"],
    output: RESULT_PATH,
    readOnly: true,
  })}\n`);
} catch (error) {
  await writeFile(RESULT_PATH, `${JSON.stringify({
    ...payload,
    exitCode: 1,
    failedScenario: currentScenario,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }, null, 2)}\n`);
  throw error;
}
