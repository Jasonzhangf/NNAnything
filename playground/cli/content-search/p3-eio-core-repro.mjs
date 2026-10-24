import assert from "node:assert/strict";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const search = await import("nnanything/cli-content-search");
const policy = await import("nnanything/cli-goal");

const NEEDLE = "KX000001";
const NAMES = ["tu-PX000001.p3t", "tv-PX000002.p3t", "tw-PX000003.p3t", "tz-KX000001.p3t"];
const header = (slot) => `T0001${slot}QZ`;
const body = (slot) => {
  const value = header(slot) + "H".repeat(88);
  return slot === 3 ? `${value.slice(0, 16)}${NEEDLE}${value.slice(24)}` : value;
};

const calls = new Map();
const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-eio-repro-")));
const sandbox = await search.createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "p3-eio-repro",
    entries: [
      { path: "src", kind: "directory" },
      ...NAMES.map((name, slot) => ({ path: `src/${name}`, kind: "file", contents: body(slot) })),
    ],
    sessions: [{ id: "s", cwd: ".", grantedEffects: ["filesystem.read", "process.exec"] }],
  },
  fileReadIo: {
    lstat: (path, options) => lstat(path, options),
    open: async (path, flags) => {
      const name = basename(path);
      if (name === NAMES[0] && (calls.get(name) ?? 0) === 0) {
        calls.set(name, 1);
        const error = new Error("P3 read denied");
        error.code = "EIO";
        throw error;
      }
      return open(path, flags);
    },
  },
});

try {
  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectory(session, "src");
  const base = policy.zeroCliCommandProfile();
  const weights = base.weights.map(row => [...row]);
  weights[base.heads.indexOf("ls")][base.wires.indexOf("goalListDirectory")] = 10;
  const inspect = base.heads.indexOf("entry.inspect");
  weights[inspect][base.wires.indexOf("predicate.observe.inspect")] = 10;
  weights[inspect][base.wires.indexOf("property.type")] = 10;
  weights[inspect][base.wires.indexOf("search.nameNeedleSegment")] = 10;
  const result = await search.runCliContentSearchGoal({
    requestId: "p3-eio-repro",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".p3t" },
        cardinality: "one",
        recursion: "flat",
      },
      requirement: { kind: "contains", predicate: { kind: "contains", needle: NEEDLE, encoding: "utf8" } },
    },
    satisfactionThreshold: 100,
  }, {
    sandbox,
    session,
    profile: { ...base, weights },
    limits: { maxTransitions: 256, maxDepth: 8, maxDerivedGoals: 64 },
    scan: { maxBytesPerFile: 256, maxTotalBytes: 4096, chunkSize: 64, maxDirectoryDepth: 0, maxStaleRetries: 1 },
    order: { kind: "injected-first", name: NAMES[0] },
  });
  const report = {
    runId: process.pid,
    expected: {
      status: "achieved",
      match: "tz-KX000001.p3t",
      errorRetained: "EIO",
    },
    actual: {
      status: result.domain.status,
      resolution: result.domain.resolution,
      matches: result.domain.matches.map(match => basename(match.path)),
      rootFact: result.domain.rootFact,
      primaryErrorId: result.domain.preserve.primaryErrorId,
      eioOpenCount: calls.get(NAMES[0]) ?? 0,
    },
    verdict: "BLOCKED_BY_SHARED_CORE",
    gap: "recursive-goal records a failed atomic receipt as a terminal error and cannot continue to the next legal candidate",
  };
  console.log(JSON.stringify(report, null, 2));
  assert.notEqual(result.domain.status, "achieved");
  assert.equal(result.domain.rootFact.errors?.[0]?.code, "EIO");
  process.exitCode = 2;
} finally {
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}
