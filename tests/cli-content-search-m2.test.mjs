import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMITS_ONE = Object.freeze({ maxTransitions: 24, maxDepth: 8, maxDerivedGoals: 5 });
const LIMITS_TWO = Object.freeze({ maxTransitions: 37, maxDepth: 8, maxDerivedGoals: 7 });
const LIMITS_THREE = Object.freeze({ maxTransitions: 51, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_FOUR = Object.freeze({ maxTransitions: 44, maxDepth: 8, maxDerivedGoals: 8 });
const LIMITS_FIVE = Object.freeze({ maxTransitions: 65, maxDepth: 8, maxDerivedGoals: 11 });
const LIMITS_SIX = Object.freeze({ maxTransitions: 30, maxDepth: 8, maxDerivedGoals: 6 });
const LIMITS_SINGLE_TERMINAL = Object.freeze({ maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 3 });
const LIMITS_CHUNK_TERMINAL = Object.freeze({ maxTransitions: 33, maxDepth: 8, maxDerivedGoals: 4 });
const LIMITS_STALE_RESCAN = Object.freeze({ maxTransitions: 54, maxDepth: 8, maxDerivedGoals: 7 });
const LIMITS_TREE_WIDE = Object.freeze({ maxTransitions: 68, maxDepth: 8, maxDerivedGoals: 9 });
const LIMITS_DEPTH_ONE = Object.freeze({ maxTransitions: 47, maxDepth: 8, maxDerivedGoals: 6 });

const S = Object.freeze({ id: "s", cwd: ".", grantedEffects: ["filesystem.read", "process.exec"] });

function profilePath() {
  const value = process.env.NN_CLI_COMMAND_PROFILE;
  assert.equal(typeof value, "string", "NN_CLI_COMMAND_PROFILE must name an explicit saved CLI command profile");
  assert.notEqual(value.length, 0, "NN_CLI_COMMAND_PROFILE must not be empty");
  return value;
}

async function api() {
  return import("nnanything/cli-content-search");
}

async function profile() {
  return JSON.parse(await readFile(profilePath(), "utf8"));
}

async function fixture(t, options) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-m2-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "m2-test-quartz",
      entries: [
        ...(options.entries ?? []),
      ],
      sessions: options.sessions ?? [S],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
    ...(options.fileReadIo === undefined ? {} : { fileReadIo: options.fileReadIo }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const session = sandbox.bindSession(options.sessionId ?? "s");
  return { module, sandbox, session, root };
}

function request(directory, needle, requestId, cardinality, recursion) {
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

async function run(value, goal, options = {}) {
  return value.module.runCliContentSearchGoal(goal, {
    sandbox: value.sandbox,
    session: value.session,
    profile: options.profile ?? value.profile,
    limits: options.limits,
    scan: options.scan,
    order: options.order,
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
    ...(options.duplicateReadProbe === undefined ? {} : { duplicateReadProbe: options.duplicateReadProbe }),
  });
}

function defaultScan(depth = 0) {
  return {
    maxBytesPerFile: 65536,
    maxTotalBytes: 262144,
    chunkSize: 65536,
    maxDirectoryDepth: depth,
    maxStaleRetries: 1,
  };
}

function denoms(d) {
  return {
    listedDirectories: d.listedDirectories,
    directoriesComplete: d.directoriesComplete,
    directoriesUncovered: d.directoriesUncovered,
    candidatesTotal: d.candidatesTotal,
    candidatesScanned: d.candidatesScanned,
    candidatesMatched: d.candidatesMatched,
    candidatesNegative: d.candidatesNegative,
    candidatesUnresolved: d.candidatesUnresolved,
    typeMismatches: d.typeMismatches,
  };
}

async function bind(fx, name) {
  return fx.sandbox.bindDirectory(fx.session, name);
}

test("T1 normal all hit with strict full scan", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t1",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/amber.ts", kind: "file", contents: `export const quarryMark = "amber-1";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t1-all", "all", "flat"), {
    limits: LIMITS_ONE,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.satisfaction, 100);
  assert.equal(d.coverage, "complete");
  assert.equal(d.rootFact.kind, "matched");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 3);
  assert.equal(d.bytesReadTotal, 37);
  assert.equal(d.duplicateReads, 0);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].scanComplete, true);
  assert.equal(d.matches[0].byteSpan.start, 13);
  assert.equal(d.matches[0].byteSpan.end, 23);
  assert.equal(d.denominators.candidatesScanned, 1);
  assert.equal(d.denominators.candidatesTotal, 1);
});

test("T2 injected-first negative recovers to later match", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t2",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/absent.ts", kind: "file", contents: `export const flutterState = "calm";\n` },
      { path: "scan/present.ts", kind: "file", contents: `export const quarryMark = "present-2";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t2-all", "all", "flat"), {
    limits: LIMITS_TWO,
    scan: defaultScan(0),
    order: { kind: "injected-first", name: "absent.ts" },
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.deliberateSuboptimal, true);
  assert.equal(d.invocationCount, 5);
  assert.equal(d.observationCount, 5);
  assert.equal(d.bytesReadTotal, 75);
  assert.equal(d.duplicateReads, 0);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.negatives[0].path.endsWith("absent.ts"), true);
  assert.equal(d.negatives[0].reason, "complete_read_no_match");
  assert.equal(d.matches[0].path.endsWith("present.ts"), true);
});

test("T3 one vs all differ on later candidates and full scans", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t3",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/first.ts", kind: "file", contents: `export const quarryMark = "first-3";\n` },
      { path: "scan/second.ts", kind: "file", contents: `export const secondState = "idle";\n` },
      { path: "scan/third.ts", kind: "file", contents: `export const thirdState = "idle";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const one = await run(fx, request(directory, "quarryMark", "p2-t3-one", "one", "flat"), {
    limits: LIMITS_ONE,
    scan: defaultScan(0),
  });
  const all = await run(fx, request(directory, "quarryMark", "p2-t3-all", "all", "flat"), {
    limits: LIMITS_THREE,
    scan: defaultScan(0),
  });
  assert.equal(one.domain.invocationCount, 3);
  assert.equal(one.domain.bytesReadTotal, 37);
  // Frozen fixture 4.3 wants scanComplete:false here, but first.ts is read once
  // as [0,size) with end_observed, so the contract (Plan 1.2) requires true.
  // T3a covers the one "stop at first block" case where false is legal.
  assert.equal(one.domain.matches[0].scanComplete, true);
  assert.equal(one.domain.denominators.candidatesUnresolved, 2);
  assert.equal(all.domain.invocationCount, 7);
  assert.equal(all.domain.bytesReadTotal, 106);
  assert.equal(all.domain.coverage, "complete");
  assert.equal(all.domain.matches[0].scanComplete, true);
  assert.equal(all.domain.denominators.candidatesScanned, 3);
  assert.equal(all.domain.denominators.candidatesTotal, 3);
  assert.equal(all.domain.negatives.length, 2);
});

test("T3a one first-block hit stops; all completes the whole file", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t3a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/large.ts", kind: "file", contents: "a".repeat(4000) + "quarryMark" + "b".repeat(8192 - 4000 - 10) },
      { path: "scan/other.ts", kind: "file", contents: `export const otherState = "idle";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const scan = { ...defaultScan(0), chunkSize: 4096 };
  const one = await run(fx, request(directory, "quarryMark", "p2-t3a-one", "one", "flat"), {
    limits: LIMITS_ONE,
    scan,
  });
  const all = await run(fx, request(directory, "quarryMark", "p2-t3a-all", "all", "flat"), {
    limits: LIMITS_FOUR,
    scan,
  });
  assert.equal(one.domain.invocationCount, 3);
  assert.equal(one.domain.bytesReadTotal, 4096);
  assert.equal(one.domain.matches[0].scanComplete, false);
  assert.equal(all.domain.invocationCount, 6);
  assert.equal(all.domain.bytesReadTotal, 8226);
  assert.equal(all.domain.matches[0].scanComplete, true);
  assert.equal(all.domain.matches[0].byteSpan.start, 4000);
  assert.equal(all.domain.negatives.length, 1);
});

test("T4 all no-hit is not_found with every candidate negative", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t4",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/one.ts", kind: "file", contents: `export const oneState = "idle";\n` },
      { path: "scan/two.ts", kind: "file", contents: `export const twoState = "idle";\n` },
      { path: "scan/three.ts", kind: "file", contents: `export const threeState = "idle";\n` },
      { path: "scan/four.ts", kind: "file", contents: `export const fourState = "idle";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t4-all", "all", "flat"), {
    limits: LIMITS_TREE_WIDE,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "unmet");
  assert.equal(d.resolution, "not_found");
  assert.equal(d.satisfaction, 0);
  assert.equal(d.coverage, "complete");
  assert.equal(d.invocationCount, 9);
  assert.equal(d.bytesReadTotal, 131);
  assert.equal(d.negatives.length, 4);
  assert.equal(d.denominators.candidatesNegative, 4);
});

test("T5 same-name across directories stays independent", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t5",
    entries: [
      { path: "left", kind: "directory" },
      { path: "right", kind: "directory" },
      { path: "left/report.ts", kind: "file", contents: `export const reportState = "left";\n` },
      { path: "right/report.ts", kind: "file", contents: `export const quarryMark = "right-5";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, ".");
  const result = await run(fx, request(directory, "quarryMark", "p2-t5-all", "all", "nested"), {
    limits: LIMITS_THREE,
    scan: defaultScan(1),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.invocationCount, 7);
  assert.equal(d.bytesReadTotal, 72);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.negatives[0].path.endsWith("left/report.ts"), true);
  assert.equal(d.matches[0].path.endsWith("right/report.ts"), true);
  assert.equal(d.denominators.listedDirectories, 3);
  assert.equal(d.denominators.directoriesComplete, 3);
});

test("T6a escaping scope binding is rejected before any IO", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t6a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/plain.ts", kind: "file", contents: `export const plainState = "idle";\n` },
    ],
  });
  fx.profile = await profile();
  await assert.rejects(bind(fx, ".."), error => error?.code === "SANDBOX_ESCAPE");
});

test("T6b in-scope symlink is not followed and plain negative completes", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t6b",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/plain.ts", kind: "file", contents: `export const plainState = "idle";\n` },
    ],
  });
  fx.profile = await profile();
  const scenarioRoot = fx.sandbox.scenarioRoot;
  const outside = join(scenarioRoot, "..", "outside-t6");
  await writeFile(outside, "x");
  await symlink(outside, join(scenarioRoot, "scan", "portal"));
  await assert.rejects(bind(fx, "scan/portal"), error => error?.code === "SANDBOX_ESCAPE");
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t6b-all", "all", "nested"), {
    limits: LIMITS_SINGLE_TERMINAL,
    scan: defaultScan(1),
  });
  const d = result.domain;
  assert.equal(d.status, "unmet");
  assert.equal(d.resolution, "not_found");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 34);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.denominators.typeMismatches, 0);
  assert.equal(d.denominators.directoriesUncovered, 0);
});

test("T7 symlink alias is type-mismatch and never read", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t7",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/real.ts", kind: "file", contents: `export const quarryMark = "real-7";\n` },
    ],
  });
  fx.profile = await profile();
  await symlink("real.ts", join(fx.sandbox.scenarioRoot, "scan", "alias.ts"));
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t7-all", "all", "flat"), {
    limits: LIMITS_ONE,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 36);
  assert.equal(d.denominators.typeMismatches, 1);
  assert.equal(d.matches[0].path.endsWith("real.ts"), true);
});

test("T8 partial listing keeps known hit and never completes", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t8",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/known.ts", kind: "file", contents: `export const quarryMark = "known-8";\n` },
    ],
    listingObserver: async input => {
      const { runDirectoryListHelper } = await import("../dist/adapters/cli/directory-listing.js");
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
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t8-all", "all", "flat"), {
    limits: LIMITS_SINGLE_TERMINAL,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "partial");
  assert.equal(d.coverage, "partial");
  assert.equal(d.rootFact.kind, "partial");
  assert.equal(d.rootFact.listing.coverage, "partial");
  assert.deepEqual(d.rootFact.listing.errors, ["EACCES"]);
  assert.deepEqual(d.rootFact.reasons, ["listing_partial"]);
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 37);
  assert.equal(d.matches.length, 1);
  assert.equal(d.denominators.directoriesComplete, 0);
  assert.equal(d.denominators.directoriesUncovered, 1);
});

test("T9a short read is partial evidence and never a negative", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t9a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/short.ts", kind: "file", contents: "a".repeat(70) + "quarryMark" + "b".repeat(40) },
    ],
    fileReadIo: {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: opts => handle.stat(opts),
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, Math.min(length, 60), position);
            return { bytesRead: result.bytesRead };
          },
          close: () => handle.close(),
        };
      },
    },
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t9a-all", "all", "flat"), {
    limits: LIMITS_SINGLE_TERMINAL,
    scan: { ...defaultScan(0), chunkSize: 4096 },
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "insufficient_evidence");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 60);
  assert.deepEqual(d.matches, []);
  assert.deepEqual(d.negatives, []);
  assert.deepEqual(d.rootFact.reasons, ["short_read"]);
});

test("T9b read error preserves EACCES and fails", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t9b",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/locked.ts", kind: "file", contents: `export const lockedState = "idle";\n` },
    ],
    fileReadIo: {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        if (path.endsWith("locked.ts")) {
          const error = new Error("denied");
          error.code = "EACCES";
          throw error;
        }
        return open(path, flags);
      },
    },
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t9b-all", "all", "flat"), {
    limits: LIMITS_ONE,
    scan: { ...defaultScan(0), chunkSize: 4096 },
  });
  const d = result.domain;
  assert.equal(d.status, "failed");
  assert.equal(d.resolution, "failed");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 2);
  assert.equal(d.bytesReadTotal, 0);
  assert.deepEqual(d.negatives, []);
  assert.equal(d.rootFact.errors[0].code, "EACCES");
});

test("T10a non-overlapping chunks do not fabricate a cross-boundary hit", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t10a",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/boundary.ts", kind: "file", contents: "abcdxxxx" },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "dcd", "p2-t10a-all", "all", "flat"), {
    limits: LIMITS_CHUNK_TERMINAL,
    scan: { ...defaultScan(0), chunkSize: 4 },
  });
  const d = result.domain;
  assert.equal(d.status, "unmet");
  assert.equal(d.resolution, "not_found");
  assert.equal(d.invocationCount, 4);
  assert.equal(d.bytesReadTotal, 8);
  assert.deepEqual(d.matches, []);
  assert.equal(d.negatives.length, 1);
  const state = result.response?.report?.states?.at(-1)?.value;
  const candidate = state?.candidates?.find(item => item.path.endsWith("boundary.ts"));
  assert.equal(candidate?.scan?.chunks, 2);
  assert.equal(candidate?.scan?.complete, true);
  assert.equal(candidate?.scan?.firstMatch, null);
});

test("T10b UTF-8 needle split across chunks still matches at absolute offset", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t10b",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/utf.ts", kind: "file", contents: "bxx\u00e9Xyy" },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "\u00e9X", "p2-t10b-all", "all", "flat"), {
    limits: LIMITS_SIX,
    scan: { ...defaultScan(0), chunkSize: 4 },
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.invocationCount, 4);
  assert.equal(d.bytesReadTotal, 8);
  assert.equal(d.matches[0].byteSpan.start, 3);
  assert.equal(d.matches[0].byteSpan.end, 6);
  assert.equal(d.matches[0].line, 1);
  assert.equal(d.matches[0].column, 4);
  const state = result.response?.report?.states?.at(-1)?.value;
  const candidate = state?.candidates?.find(item => item.path.endsWith("utf.ts"));
  assert.equal(candidate?.scan?.chunks, 2);
  assert.equal(candidate?.scan?.complete, true);
});

test("T10c needle longer than chunkSize is rejected before any IO", async t => {
  const calls = [];
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t10c",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/byte.ts", kind: "file", contents: "abcdef" },
    ],
    listingObserver: async input => {
      calls.push("list");
      const { runDirectoryListHelper } = await import("../dist/adapters/cli/directory-listing.js");
      return runDirectoryListHelper(input);
    },
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  await assert.rejects(
    run(fx, request(directory, "\u00e9X", "p2-t10c-reject", "all", "flat"), {
      limits: LIMITS_ONE,
      scan: { ...defaultScan(0), chunkSize: 2 },
    }),
    TypeError,
  );
  assert.deepEqual(calls, []);
});

test("T11 size change moves the old hit to historicalMatches and rescans", async t => {
  let lstatCalls = 0;
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t11",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/shift.ts", kind: "file", contents: "x".repeat(10) + "quarryMark" + "y".repeat(20) },
    ],
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        lstatCalls += 1;
        if (lstatCalls === 1) {
          await appendFile(path, "z".repeat(20));
        }
        return stats;
      },
      open: (path, flags) => open(path, flags),
    },
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t11-all", "all", "flat"), {
    limits: LIMITS_TWO,
    scan: { ...defaultScan(0), chunkSize: 4096 },
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.invocationCount, 5);
  assert.equal(d.observationCount, 5);
  assert.equal(d.bytesReadTotal, 100);
  assert.equal(d.duplicateReads, 0);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].size, 60);
  assert.equal(d.matches[0].bytesRead, 60);
  assert.equal(d.matches[0].scanComplete, true);
  assert.equal(d.historicalMatches.length, 1);
  const historical = d.historicalMatches[0];
  assert.equal(historical.historical, true);
  assert.equal(historical.size, 40);
  assert.equal(historical.bytesRead, 40);
  assert.equal(historical.invalidation.kind, "size_changed");
  assert.equal(historical.invalidation.code, null);
});

test("T11 identity change is stale, rescans fresh identity from zero", async t => {
  let lstatCalls = 0;
  let openCalls = 0;
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t11-old",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/a.ts", kind: "file", contents: "x".repeat(30) },
    ],
    fileReadIo: {
      lstat: async (path, options) => {
        const stats = await lstat(path, options);
        lstatCalls += 1;
        if (path.endsWith("a.ts") && lstatCalls === 1) {
          await rename(path, join(path, "..", "a.old.ts"));
          await writeFile(path, "w".repeat(20) + "quarryMark");
        }
        return stats;
      },
      open: async (path, flags) => {
        openCalls += 1;
        if (path.endsWith("a.ts") && openCalls === 1) {
          const error = new Error("stale");
          error.code = "STALE_REFERENCE";
          throw error;
        }
        return open(path, flags);
      },
    },
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t11-old", "all", "flat"), {
    limits: LIMITS_TWO,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.invocationCount, 5);
  assert.equal(d.observationCount, 4);
  assert.equal(d.bytesReadTotal, 30);
  assert.equal(d.historicalMatches.length, 0);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].byteSpan.start, 20);
  assert.equal(d.matches[0].byteSpan.end, 30);
  assert.equal(d.matches[0].scanComplete, true);
});

test("T11a same-inode same-size in-place rewrite is judged on read bytes", async t => {
  const fx = await fixture(t, {
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
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t11a-current", "all", "flat"), {
    limits: LIMITS_ONE,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 30);
  assert.equal(d.historicalMatches.length, 0);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].byteSpan.start, 20);
  assert.equal(d.matches[0].scanComplete, true);
});

test("T11a stale mid-read moves the old hit to history and rescans", async t => {
  let readCalls = 0;
  const fx = await fixture(t, {
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
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t11a-stale", "all", "flat"), {
    limits: LIMITS_STALE_RESCAN,
    scan: { ...defaultScan(0), chunkSize: 16 },
  });
  const d = result.domain;
  assert.equal(d.status, "unmet");
  assert.equal(d.resolution, "not_found");
  assert.equal(d.invocationCount, 7);
  assert.equal(d.observationCount, 6);
  assert.equal(d.bytesReadTotal, 46);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.historicalMatches.length, 1);
  const historical = d.historicalMatches[0];
  assert.equal(historical.invalidation.kind, "read_stale");
  assert.equal(historical.invalidation.code, "READ_TARGET_CHANGED");
  assert.equal(historical.byteSpan.start, 6);
  assert.equal(historical.byteSpan.end, 16);
});

test("T12 budget interruption keeps facts and continuation resumes without replay", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t12",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/long.ts", kind: "file", contents: "a".repeat(4080) + "quarryMark" + "b".repeat(10) },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const scan = { ...defaultScan(0), chunkSize: 4096 };
  const first = await run(fx, request(directory, "quarryMark", "p2-t12-part1", "all", "flat"), {
    // Measured: 29 already dispatches read 2. 26 stops after read 1, which is
    // the frozen interrupted slice (bytes 4096, scanComplete false).
    limits: { maxTransitions: 26, maxDepth: 8, maxDerivedGoals: 4 },
    scan,
  });
  const d1 = first.domain;
  assert.equal(d1.status, "unknown");
  assert.equal(d1.resolution, "interrupted");
  assert.equal(d1.rootFact.kind, "interrupted");
  assert.equal(d1.coverage, "partial");
  assert.equal(d1.invocationCount, 3);
  assert.equal(d1.bytesReadTotal, 4096);
  assert.equal(d1.matches.length, 1);
  assert.equal(d1.matches[0].scanComplete, false);
  assert.ok(d1.budgetUsed.transitionsUsed < 30);
  assert.ok(first.domain.preserve.continuation !== null);

  // The shared continuation contract binds acceptedRoot.requestId, so the
  // resumed request keeps the root requestId.
  const second = await run(fx, request(directory, "quarryMark", "p2-t12-part1", "all", "flat"), {
    limits: { maxTransitions: 31, maxDepth: 8, maxDerivedGoals: 4 },
    scan,
    continuation: first.domain.preserve.continuation,
  });
  const d2 = second.domain;
  assert.equal(d2.status, "achieved");
  assert.equal(d2.resolution, "matched");
  assert.equal(d2.invocationCount, 4);
  assert.equal(d2.bytesReadTotal, 4100);
  assert.equal(d2.duplicateReads, 0);
  assert.equal(d2.matches.length, 1);
  assert.equal(d2.matches[0].scanComplete, true);
  assert.equal(d2.matches[0].byteSpan.start, 4080);
  assert.equal(d2.budgetUsed.transitionsUsed, 31);
  assert.equal(d2.budgetUsed.derivedGoalsUsed, 4);
});

test("T13 proven negatives are never re-chosen", async t => {
  const fx = await fixture(t, {
    scenarioId: "m2-test-quartz-t13",
    entries: [
      { path: "scan", kind: "directory" },
      { path: "scan/quill.ts", kind: "file", contents: `export const quillState = "idle";\n` },
      { path: "scan/ember.ts", kind: "file", contents: `export const quarryMark = "ember-13";\n` },
    ],
  });
  fx.profile = await profile();
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t13-all", "all", "flat"), {
    limits: LIMITS_TWO,
    scan: defaultScan(0),
    order: { kind: "injected-first", name: "quill.ts" },
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.deliberateSuboptimal, true);
  assert.equal(d.invocationCount, 5);
  assert.equal(d.bytesReadTotal, 72);
  assert.equal(d.duplicateReads, 0);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.matches[0].path.endsWith("ember.ts"), true);
});

async function depthFixture(t, scenarioId, hit) {
  const fx = await fixture(t, {
    scenarioId,
    entries: [
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
    ],
  });
  fx.profile = await profile();
  return fx;
}

test("T14a depth 0 lists only the root and cannot complete", async t => {
  const fx = await depthFixture(t, "m2-test-quartz-t14a", true);
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t14a-all", "all", "nested"), {
    limits: LIMITS_SINGLE_TERMINAL,
    scan: defaultScan(0),
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "partial");
  assert.equal(d.coverage, "partial");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.bytesReadTotal, 33);
  assert.equal(d.denominators.directoriesUncovered, 1);
  assert.deepEqual(d.rootFact.reasons, ["depth_limit"]);

  const noHit = await depthFixture(t, "m2-test-quartz-t14a-nohit", false);
  const dirNoHit = await bind(noHit, "scan");
  const resultNoHit = await run(noHit, request(dirNoHit, "quarryMark", "p2-t14a-all", "all", "nested"), {
    limits: LIMITS_SINGLE_TERMINAL,
    scan: defaultScan(0),
  });
  const dNo = resultNoHit.domain;
  assert.equal(dNo.resolution, "insufficient_evidence");
  assert.equal(dNo.rootFact.kind, "insufficient_evidence");
  assert.deepEqual(dNo.rootFact.matchPaths, []);
});

test("T14b depth 1 lists root and direct child directories", async t => {
  const fx = await depthFixture(t, "m2-test-quartz-t14b", true);
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t14b-all", "all", "nested"), {
    limits: LIMITS_DEPTH_ONE,
    scan: defaultScan(1),
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "partial");
  assert.equal(d.invocationCount, 6);
  assert.equal(d.bytesReadTotal, 68);
  assert.equal(d.denominators.listedDirectories, 2);
  assert.equal(d.denominators.directoriesComplete, 2);
  assert.equal(d.denominators.directoriesUncovered, 1);
  assert.equal(d.rootFact.listing.sourceRuns.length, 2);
  assert.deepEqual(d.rootFact.reasons, ["depth_limit"]);
});

test("T14c depth 2 covers the whole tree and returns matched", async t => {
  const fx = await depthFixture(t, "m2-test-quartz-t14c", true);
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t14c-all", "all", "nested"), {
    limits: LIMITS_FIVE,
    scan: defaultScan(2),
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.coverage, "complete");
  assert.equal(d.invocationCount, 9);
  assert.equal(d.bytesReadTotal, 101);
  assert.equal(d.denominators.listedDirectories, 3);
  assert.equal(d.denominators.directoriesUncovered, 0);
  assert.equal(d.matches.length, 2);
  assert.ok(d.matches.every(match => match.scanComplete === true));
  assert.equal(d.negatives.length, 1);
});

test("T14c depth 2 with an extra unlisted child stays partial", async t => {
  const fx = await depthFixture(t, "m2-test-quartz-t14c-extra", true);
  await (await import("node:fs/promises")).mkdir(join(fx.sandbox.scenarioRoot, "scan", "a", "b", "c"));
  const directory = await bind(fx, "scan");
  const result = await run(fx, request(directory, "quarryMark", "p2-t14c-all", "all", "nested"), {
    limits: LIMITS_TREE_WIDE,
    scan: defaultScan(2),
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "partial");
  assert.equal(d.coverage, "partial");
  assert.equal(d.denominators.directoriesUncovered, 1);
  assert.equal(d.invocationCount, 9);
  assert.equal(d.bytesReadTotal, 101);
});
