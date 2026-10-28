import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMITS = Object.freeze({
  maxTransitions: 40,
  maxDepth: 4,
  maxDerivedGoals: 16,
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
  return import("nnanything/cli-content-search");
}

async function profile() {
  const raw = JSON.parse(await readFile(profilePath(), "utf8"));
  if (raw.wires?.length === 30) {
    const { migrateCliCommandProfileV10x30 } = await import("nnanything/cli-goal");
    return migrateCliCommandProfileV10x30(raw);
  }
  return raw;
}

async function fixture(t, options) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "content-search",
      entries: [
        { path: "src", kind: "directory" },
        ...(options.entries ?? []),
      ],
      sessions: options.sessions ?? [
        {
          id: "s",
          cwd: "src",
          grantedEffects: ["filesystem.read", "process.exec"],
        },
      ],
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

function request(directory, needle, requestId, options = {}) {
  return {
    requestId: requestId ?? `content-search-${needle}`,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: options.fileCondition ?? { type: "regular", suffix: ".ts" },
        cardinality: "one",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle, encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

async function run(value, directory, goal, options = {}) {
  return value.module.runCliContentSearchGoal(goal, {
    sandbox: value.sandbox,
    session: value.session,
    profile: options.profile ?? value.profile,
    limits: options.limits ?? LIMITS,
    scan: options.scan,
    order: options.order,
    ...(options.duplicateReadProbe === undefined ? {} : { duplicateReadProbe: options.duplicateReadProbe }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
  });
}

const INGEST = `export const traceToken = "tel-9f3a";\nexport function ingest(){ return "tel-9f3a"; }\n`;
const RELAY = `export const auditTag = "relay-audit-7";\nexport const relayMode = "shadow";\nexport const relayCapacity = 64;\n`;
const MANUAL = `traceToken is documented here.\n`;
const DEEP_INGEST = `export const traceToken = "nested-tel-0000";\n`;
const DEEP_RELAY = `export const relayMode = "deep-shadow";\nexport const relayCapacity = 16;\n`;

function shortReadIo(maxBytes) {
  return {
    lstat: (path, options) => lstat(path, options),
    open: async (path, flags) => {
      const handle = await open(path, flags);
      return {
        stat: options => handle.stat(options),
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, Math.min(length, maxBytes), position);
          return { bytesRead: result.bytesRead };
        },
        close: () => handle.close(),
      };
    },
  };
}

function deniedReadIo(name) {
  return {
    lstat: async (path, options) => {
      if (path.endsWith(name)) {
        const error = new Error("controlled read denial");
        error.code = "EACCES";
        throw error;
      }
      return lstat(path, options);
    },
    open: (path, flags) => open(path, flags),
  };
}

function domainSummary(domain) {
  return {
    status: domain.status,
    resolution: domain.resolution,
    satisfaction: domain.satisfaction,
    matches: domain.matches.map(m => ({ path: m.path, start: m.byteSpan.start, end: m.byteSpan.end })),
    negatives: domain.negatives.map(n => n.path),
    coverage: domain.coverage,
    deliberateSuboptimal: domain.deliberateSuboptimal,
    invocationCount: domain.invocationCount,
    observationCount: domain.observationCount,
    bytesReadTotal: domain.bytesReadTotal,
    duplicateReads: domain.duplicateReads,
    rootKind: domain.rootFact.kind,
  };
}

test("T1 normal preferred first hit is matched with one read", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
      { path: "src/relay.ts", kind: "file", contents: RELAY },
      { path: "src/manual.txt", kind: "file", contents: MANUAL },
      { path: "src/deep", kind: "directory" },
      { path: "src/deep/ingest.ts", kind: "file", contents: DEEP_INGEST },
      { path: "src/deep/relay.ts", kind: "file", contents: DEEP_RELAY },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T1"));
  const d = result.domain;
  assert.deepEqual(domainSummary(d), {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    matches: [{ path: join(value.sandbox.getSession(value.session).cwd, "ingest.ts"), start: 13, end: 23 }],
    negatives: [],
    coverage: "complete",
    deliberateSuboptimal: false,
    invocationCount: 3,
    observationCount: 3,
    bytesReadTotal: 85,
    duplicateReads: 0,
    rootKind: "matched",
  });
});

test("T2/T6a/T12 injected-first distractors are proven negative before recovery", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
      { path: "src/relay.ts", kind: "file", contents: RELAY },
      { path: "src/manual.txt", kind: "file", contents: MANUAL },
      { path: "src/deep", kind: "directory" },
      { path: "src/deep/ingest.ts", kind: "file", contents: DEEP_INGEST },
      { path: "src/deep/relay.ts", kind: "file", contents: DEEP_RELAY },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T2"), {
    order: { kind: "injected-first", name: "relay.ts" },
  });
  const d = result.domain;
  const start = value.sandbox.getSession(value.session).cwd;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.deliberateSuboptimal, true);
  assert.equal(d.invocationCount, 5);
  assert.equal(d.observationCount, 5);
  assert.equal(d.bytesReadTotal, 194);
  assert.equal(d.duplicateReads, 0);
  assert.deepEqual(d.matches.map(m => m.path), [join(start, "ingest.ts")]);
  assert.deepEqual(d.negatives.map(n => n.path), [join(start, "relay.ts")]);
  assert.equal(d.negatives[0].offset, 0);
  assert.equal(d.negatives[0].length, 109);
  assert.equal(d.negatives[0].size, 109);
  assert.equal(d.negatives[0].reason, "complete_read_no_match");
  assert.equal(d.coverage, "complete");
});

test("T3 complete no-match across candidates is not_found", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t3",
    entries: [
      { path: "src/capture.ts", kind: "file", contents: `export const captureMode = "raw";\n` },
      { path: "src/output.ts", kind: "file", contents: `export const outputSink = "disk";\n` },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T3"));
  const d = result.domain;
  assert.equal(d.status, "unmet");
  assert.equal(d.resolution, "not_found");
  assert.equal(d.satisfaction, 0);
  assert.equal(d.invocationCount, 5);
  assert.equal(d.observationCount, 5);
  assert.equal(d.bytesReadTotal, 68);
  assert.equal(d.coverage, "complete");
  assert.deepEqual(d.matches, []);
  assert.equal(d.negatives.length, 2);
});

test("T4a a file larger than maxBytesPerFile is unknown without reading", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t4",
    entries: [
      { path: "src/large.ts", kind: "file", contents: "x".repeat(89) + "traceToken" + "\n" },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T4a"), {
    scan: { maxBytesPerFile: 64, maxTotalBytes: 262144 },
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "insufficient_evidence");
  assert.equal(d.invocationCount, 2);
  assert.equal(d.observationCount, 2);
  assert.equal(d.bytesReadTotal, 0);
  assert.deepEqual(d.negatives, []);
});

test("T4b short read containing the needle is unknown, not matched", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t4b",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
    fileReadIo: shortReadIo(80),
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T4b"));
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "insufficient_evidence");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 3);
  assert.equal(d.bytesReadTotal, 80);
  assert.deepEqual(d.matches, []);
  assert.deepEqual(d.negatives, []);
});

test("T4c short read without the needle is unknown and never a negative", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t4c",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
    fileReadIo: shortReadIo(10),
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T4c"));
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "insufficient_evidence");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 3);
  assert.equal(d.bytesReadTotal, 10);
  assert.deepEqual(d.matches, []);
  assert.deepEqual(d.negatives, []);
});

test("T5 a same-name symlink is excluded and a regular hit still recovers", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t5",
    entries: [
      { path: "src/wired.ts", kind: "file", contents: `export const traceToken = "real-tel-1";\n` },
    ],
  });
  value.profile = await profile();
  const scenarioRoot = value.sandbox.scenarioRoot;
  await symlink("wired.ts", join(scenarioRoot, "src", "alias.ts"));
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T5"));
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 3);
  assert.equal(d.bytesReadTotal, 40);
  const start = value.sandbox.getSession(value.session).cwd;
  assert.deepEqual(d.matches.map(m => m.path), [join(start, "wired.ts")]);
  assert.deepEqual(d.negatives, []);
});

test("T6c/T6d negatives are scoped to a single file, needle and directory", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t6",
    entries: [
      { path: "src/left", kind: "directory" },
      { path: "src/right", kind: "directory" },
      { path: "src/left/report.ts", kind: "file", contents: `export const auditTag = "left-audit-1";\n` },
      { path: "src/right/report.ts", kind: "file", contents: `export const traceToken = "right-tel-2";\n` },
    ],
  });
  value.profile = await profile();

  const left = await value.sandbox.bindDirectory(value.session, "left");
  const leftMiss = await run(value, left, request(left, "traceToken", "T6c-1"), {
    order: { kind: "injected-first", name: "report.ts" },
  });
  assert.equal(leftMiss.domain.status, "unmet");
  assert.equal(leftMiss.domain.resolution, "not_found");
  assert.equal(leftMiss.domain.invocationCount, 3);
  assert.equal(leftMiss.domain.bytesReadTotal, 40);
  assert.equal(leftMiss.domain.negatives.length, 1);

  const leftHit = await run(value, left, request(left, "auditTag", "T6c-2"), {
    order: { kind: "injected-first", name: "report.ts" },
  });
  assert.equal(leftHit.domain.status, "achieved");
  assert.equal(leftHit.domain.negatives.length, 0);
  assert.equal(leftHit.domain.bytesReadTotal, 40);

  const right = await value.sandbox.bindDirectory(value.session, "right");
  const rightHit = await run(value, right, request(right, "traceToken", "T6d"), {
    order: { kind: "lexicographic" },
  });
  assert.equal(rightHit.domain.status, "achieved");
  assert.equal(rightHit.domain.negatives.length, 0);
  assert.equal(rightHit.domain.bytesReadTotal, 41);
});

test("T9 a forged directory reference is rejected with zero IO", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const forged = { ...directory, sourceRun: "never-issued-by-sandbox" };
  const result = await run(value, directory, request(forged, "traceToken", "T9"));
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.resolution, "rejected");
  assert.equal(result.domain.invocationCount, 0);
  assert.equal(result.domain.observationCount, 0);
  assert.equal(result.domain.bytesReadTotal, 0);
});

test("T10 a hard read error preserves errno and stays failed", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-t10",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
    fileReadIo: deniedReadIo("ingest.ts"),
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T10"));
  const d = result.domain;
  assert.equal(d.status, "failed");
  assert.equal(d.resolution, "failed");
  assert.equal(d.invocationCount, 3);
  assert.equal(d.observationCount, 2);
  assert.equal(d.bytesReadTotal, 0);
  assert.deepEqual(d.negatives, []);
  assert.match(JSON.stringify(result.response), /EACCES/);
});

test("T11 an exhausted transition budget stops as budget_exhausted with zero IO", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T11"), {
    limits: { maxTransitions: 1, maxDepth: 4, maxDerivedGoals: 8 },
  });
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "budget_exhausted");
  assert.equal(d.invocationCount, 0);
  assert.equal(d.observationCount, 0);
  assert.equal(d.bytesReadTotal, 0);
  assert.deepEqual(d.matches, []);
});

test("T13 re-reading an already proven negative counts as a duplicate", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
      { path: "src/relay.ts", kind: "file", contents: RELAY },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T13"), {
    limits: { ...LIMITS, maxTransitions: 44 },
    order: { kind: "injected-first", name: "relay.ts" },
    duplicateReadProbe: ["relay.ts"],
  });
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.deliberateSuboptimal, true);
  assert.equal(d.invocationCount, 6);
  assert.equal(d.observationCount, 6);
  assert.equal(d.bytesReadTotal, 303);
  assert.equal(d.duplicateReads, 1);
  assert.equal(d.negatives.length, 1);
});

function genericRoot(result) {
  const report = result.response?.report;
  const evaluation = report?.rootEvaluation;
  return {
    evaluated: evaluation?.state === "evaluated" ? evaluation.result : evaluation?.state,
    satisfaction: evaluation?.state === "evaluated" ? evaluation.satisfaction : null,
    outcome: report?.control?.outcome,
    stopReason: report?.control?.stopReason,
  };
}

test("T14 a completed hit whose root evaluation is unfinished reports budget_exhausted with partial facts", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-budget-hit",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T14"), {
    limits: { ...LIMITS, maxTransitions: 20 },
  });
  const d = result.domain;
  assert.deepEqual(genericRoot(result), {
    evaluated: "unknown",
    satisfaction: null,
    outcome: "exceeded",
    stopReason: "budget",
  });
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "budget_exhausted");
  assert.equal(d.satisfaction, null);
  assert.equal(d.rootFact.kind, "partial");
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].path, join(value.sandbox.getSession(value.session).cwd, "ingest.ts"));
  assert.equal(d.matches[0].needle, "traceToken");
  assert.equal(d.bytesReadTotal, 85);
});

test("T15 the same search with a finished root evaluation reports achieved and matches the controller", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-budget-hit",
    entries: [
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T15"), {
    limits: { ...LIMITS, maxTransitions: 24 },
  });
  const d = result.domain;
  assert.deepEqual(genericRoot(result), {
    evaluated: "satisfied",
    satisfaction: 100,
    outcome: "completed",
    stopReason: "root_evaluation",
  });
  assert.equal(d.status, "achieved");
  assert.equal(d.resolution, "matched");
  assert.equal(d.satisfaction, 100);
  assert.equal(d.rootFact.kind, "matched");
  assert.equal(d.rootFact.match.path, join(value.sandbox.getSession(value.session).cwd, "ingest.ts"));
});

test("T16 the last proven negative whose root evaluation is unfinished reports budget_exhausted with insufficient evidence", async t => {
  const value = await fixture(t, {
    scenarioId: "m1-test-budget-negative",
    entries: [
      { path: "src/capture.ts", kind: "file", contents: `export const captureMode = "raw";\n` },
    ],
  });
  value.profile = await profile();
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await run(value, directory, request(directory, "traceToken", "T16"), {
    limits: { ...LIMITS, maxTransitions: 20 },
  });
  const d = result.domain;
  assert.deepEqual(genericRoot(result), {
    evaluated: "unknown",
    satisfaction: null,
    outcome: "exceeded",
    stopReason: "budget",
  });
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "budget_exhausted");
  assert.equal(d.satisfaction, null);
  assert.equal(d.rootFact.kind, "insufficient_evidence");
  assert.equal(d.matches.length, 0);
  assert.equal(d.negatives.length, 1);
  assert.equal(d.negatives[0].path, join(value.sandbox.getSession(value.session).cwd, "capture.ts"));
  assert.equal(d.negatives[0].reason, "complete_read_no_match");
});

test("R6 an omitted budget scans every chunk until the needle is found", async t => {
  const needle = "nedl1234";
  const body = `${"x".repeat(160)}${needle}`;
  const value = await fixture(t, {
    entries: [{ path: "src/big.ts", kind: "file", contents: body }],
  });
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await value.module.runCliContentSearchGoal(
    request(directory, needle, "R6-chunks"),
    {
      sandbox: value.sandbox,
      session: value.session,
      profile: await profile(),
      scan: {
        maxBytesPerFile: 65536,
        maxTotalBytes: 262144,
        chunkSize: 8,
        maxDirectoryDepth: 0,
        maxStaleRetries: 1,
      },
    },
  );
  const d = result.domain;
  assert.equal(d.status, "achieved");
  assert.equal(d.satisfaction, 100);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].path, join(value.sandbox.getSession(value.session).cwd, "big.ts"));
  assert.ok(d.bytesReadTotal >= body.length);
});

test("R9 an omitted budget honors abort after the in-flight chunk with no further read", async t => {
  const controller = new AbortController();
  let reads = 0;
  const body = "z".repeat(160);
  const fileReadIo = {
    lstat: (path, options) => lstat(path, options),
    open: async (path, flags) => {
      const handle = await open(path, flags);
      return {
        stat: (options) => handle.stat(options),
        read: async (buffer, offset, length, position) => {
          reads += 1;
          const result = await handle.read(
            buffer,
            offset,
            Math.min(length, 8),
            position,
          );
          if (reads === 3) controller.abort();
          return { bytesRead: result.bytesRead };
        },
        close: () => handle.close(),
      };
    },
  };
  const value = await fixture(t, {
    entries: [{ path: "src/big.ts", kind: "file", contents: body }],
    fileReadIo,
  });
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const result = await value.module.runCliContentSearchGoal(
    request(directory, "nope", "R9-abort"),
    {
      sandbox: value.sandbox,
      session: value.session,
      profile: await profile(),
      scan: {
        maxBytesPerFile: 65536,
        maxTotalBytes: 262144,
        chunkSize: 8,
        maxDirectoryDepth: 0,
        maxStaleRetries: 1,
      },
      signal: controller.signal,
    },
  );
  const d = result.domain;
  assert.equal(d.status, "unknown");
  assert.equal(d.resolution, "interrupted");
  assert.equal(d.satisfaction, null);
  assert.equal(reads, 3);
});
