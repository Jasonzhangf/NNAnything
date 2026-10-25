// P4f independent family: multi-source read composition via the public
// nnanything/cli-read entry plus a real POSIX filesystem oracle.
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { createCliFilesystemSandbox, runCliReadCompositionGoal } = await import("nnanything/cli-read");
const recursive = await import("nnanything/recursive-goal");

const LOG_PATH =
  "/Volumes/Intel/playground/nnanything-runs/cli-read-multi-20261023/logs/p4f-independent-family.log";
const envNames = ["NN_HANDWIRED_ROOT", "NN_CLI_COMMAND_PROFILE", "NN_CWD_RELATION_PROFILE"];
for (const name of envNames) {
  if (typeof process.env[name] !== "string" || process.env[name].length === 0) {
    throw new Error(`${name} is required`);
  }
}
// A 10x30 profile predates the search.nameNeedleSegment wire; the runtime entry rejects that
// shape by contract, so this caller migrates it by name first. A 10x31 profile passes through.
const rawProfile = JSON.parse(await readFile(process.env.NN_CLI_COMMAND_PROFILE, "utf8"));
const profile = rawProfile.wires?.length === 30
  ? await (await import("nnanything/cli-goal")).migrateCliCommandProfileV10x30(rawProfile)
  : rawProfile;
const fullLimits = Object.freeze({ maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 12 });
const outputLines = [];
const caseResults = [];

const GOOD = "GOOD";
const BAD = "BAD!";
const WORSE = "WRS!";
const EVIL = "EVIL";
const range = Object.freeze({ offset: 0, length: 4 });

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function record(line) {
  const text = JSON.stringify(line);
  outputLines.push(text);
  console.log(text);
}

async function oracleBytes(path, offset, length) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { expectedBase64: bytesRead === length ? buffer.toString("base64") : null, bytesRead };
  } finally {
    await handle.close();
  }
}

async function oracleEntry(path) {
  const stat = await lstat(path, { bigint: true });
  const kind = stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "other";
  return {
    kind,
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
    absolutePath: await realpath(path),
  };
}

async function realListing(input) {
  const names = await readdir(input.physicalDirectory);
  const entries = [];
  for (const name of names) {
    const path = join(input.physicalDirectory, name);
    const stat = await lstat(path);
    entries.push({
      name,
      path,
      type: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
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
      helperPath: "multi-source-independent-real-listing",
      argv: [process.execPath, "multi-source-independent-real-listing"],
      stdout: "",
      stderr: "",
      exitCode: 0,
      entries,
      coverage: "complete",
      errors: [],
    },
  };
}

function partialListing(input) {
  return Promise.resolve({
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "multi-source-independent-partial-listing",
      argv: [process.execPath, "multi-source-independent-partial-listing"],
      stdout: "",
      stderr: "",
      exitCode: 0,
      entries: [],
      coverage: "partial",
      errors: [{ name: "locked", code: "EACCES", message: "permission denied" }],
    },
  });
}

async function createWorld(options) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-multi-independent-")));
  let opens = 0;
  const ioHooks = options.ioHooks ?? {};
  let sandbox;
  try {
    sandbox = await createCliFilesystemSandbox({
      root,
      ownerGrantedEffects: ["filesystem.write"],
      recipe: {
        scenarioId: options.scenarioId,
        entries: [
          { path: "start", kind: "directory" },
          { path: "start/a", kind: "directory" },
          { path: "start/b", kind: "directory" },
          ...(options.entries ?? []),
        ],
        sessions: [
          {
            id: "s",
            cwd: "start",
            grantedEffects: options.grantedEffects ?? ["filesystem.read", "process.exec"],
          },
        ],
      },
      ...(options.listingObserver === undefined
        ? {}
        : { listingObserver: options.listingObserver }),
      fileReadIo: {
        lstat: async (path, ioOptions) => lstat(path, ioOptions),
        open: async (path, flags) => {
          opens += 1;
          if (ioHooks.beforeOpen !== undefined) await ioHooks.beforeOpen(path);
          const handle = await open(path, flags);
          if (ioHooks.afterOpen !== undefined) await ioHooks.afterOpen(path, flags, handle);
          return handle;
        },
      },
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const session = sandbox.bindSession("s");
  const refA = options.legacyBindings === true
    ? await sandbox.bindDirectory(session, "a")
    : await sandbox.bindDirectoryObject(session, "a");
  const refB = options.legacyBindings === true
    ? await sandbox.bindDirectory(session, "b")
    : await sandbox.bindDirectoryObject(session, "b");
  const cwd = sandbox.getSession(session).cwd;
  return {
    root,
    sandbox,
    session,
    refA,
    refB,
    cwd,
    opens: () => opens,
    cleanup: async () => {
      await sandbox.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function request(sources, name, expectedBase64, requestId) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.exact-child-sources",
        sources,
        name,
        requiredType: "regular",
      },
      requirement: { kind: "equals", range, expectedBase64 },
    },
    satisfactionThreshold: 100,
  };
}

function run(world, goalRequest, options = {}) {
  return runCliReadCompositionGoal(goalRequest, {
    sandbox: world.sandbox,
    session: world.session,
    profile,
    limits: options.limits ?? fullLimits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
  });
}

function sourceById(domain, sourceId) {
  return domain.sources.find((source) => source.sourceId === sourceId) ?? null;
}

function nativeErrorCodes(domain) {
  const codes = new Set();
  for (const item of domain.preserve?.atomicResults ?? []) {
    const sourceResult = item?.sourceResult;
    if (sourceResult?.tag !== "cli.file.read.receipt.v1") continue;
    const error = sourceResult.value?.receipt?.execution?.error;
    if (typeof error?.code === "string") codes.add(error.code);
  }
  for (const error of domain.preserve?.errors ?? []) {
    if (typeof error?.nativeCode === "string") codes.add(error.nativeCode);
  }
  return [...codes];
}

function programmaticDecision(rankOrderWeight, unitVersion) {
  const weights = Array(recursive.PLANNING_DECISION_WIRES.length).fill(0);
  const rankOrderIndex = recursive.PLANNING_DECISION_WIRES.indexOf("rankOrder.value");
  if (rankOrderIndex === -1) throw new Error("rankOrder.value wire must exist");
  weights[rankOrderIndex] = rankOrderWeight;
  return {
    contract: recursive.PLANNING_DECISION_CONTRACT,
    providerRef: { id: "p4f.independent.planning.handwired", version: "1" },
    unitRef: { id: `p4f.independent.ranking.${unitVersion}`, version: "1" },
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

async function runSingleWorld(options) {
  const failures = [];
  let world = null;
  let thrown = null;
  let result = null;
  let oracle = null;
  try {
    world = await createWorld(options.create);
    const outcome = await options.run(world);
    if (outcome !== null && typeof outcome === "object" && "result" in outcome) {
      result = outcome.result;
      oracle = outcome.oracle ?? null;
    } else {
      result = outcome;
    }
  } catch (error) {
    thrown = error;
  }
  try {
    options.verify?.({
      world,
      result,
      oracle,
      thrown,
      checks: (condition, message) => {
        if (!condition) failures.push(message);
      },
      openCount: world === null ? 0 : world.opens(),
    });
  } catch (error) {
    failures.push(`verify threw: ${error.message}`);
  } finally {
    if (world !== null) {
      try {
        await world.cleanup();
      } catch (error) {
        failures.push(`cleanup threw: ${error.message}`);
      }
    }
  }
  const actual = thrown
    ? { status: "rejected", resolution: "rejected", satisfaction: null, thrown: thrown.message }
    : result?.domain === undefined
      ? { status: "missing", resolution: "missing", satisfaction: null }
      : {
          status: result.domain.status,
          resolution: result.domain.resolution,
          satisfaction: result.domain.satisfaction,
          chosen: result.domain.decision?.chosen ?? null,
          match: result.domain.match?.absolutePath ?? null,
          sources: result.domain.sources.map((item) => ({
            sourceId: item.sourceId,
            attempt: item.attempt,
            negative: item.negative,
          })),
        };
  const line = {
    caseId: options.caseId,
    expected: options.expected,
    actual,
    openCount: world === null ? 0 : world.opens(),
    oracleOk: failures.length === 0,
  };
  if (failures.length > 0) line.failures = failures;
  record(line);
  caseResults.push(line);
  return line;
}

async function singleCase(options) {
  return runSingleWorld(options);
}

async function pairedCase(options) {
  const left = await runSingleWorld(options.left);
  if (!left.oracleOk) return left;
  return runSingleWorld(options.right);
}

// 1. Preferred source matches directly; alternate is never attempted.
await singleCase({
  caseId: "p4f-01-preferred-direct-match",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:0",
  },
  create: {
    scenarioId: "p4f-01",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-01",
        ),
      ),
      oracle: {
        aBytes: aOracle.expectedBase64,
        bBytes: bOracle.expectedBase64,
        aPath: join(world.cwd, "a", "target.bin"),
        bPath: join(world.cwd, "b", "target.bin"),
        aType: (await oracleEntry(join(world.cwd, "a", "target.bin"))).kind,
        bType: (await oracleEntry(join(world.cwd, "b", "target.bin"))).kind,
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 100, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.decision?.chosen === "source:0", "decision.chosen is not source:0");
    checks(
      result.domain.match?.absolutePath === oracle.aPath,
      `match path ${result.domain.match?.absolutePath} !== oracle ${oracle.aPath}`,
    );
    checks(sourceById(result.domain, "source:1")?.attempt === "not_attempted", "source:1 was attempted");
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 2. Preferred byte mismatch falls back to the alternate match.
await singleCase({
  caseId: "p4f-02-byte-mismatch-fallback",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 2,
    chosen: "source:0",
  },
  create: {
    scenarioId: "p4f-02",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          bOracle.expectedBase64,
          "p4f-02",
        ),
      ),
      oracle: { aPath: join(world.cwd, "a", "target.bin"), bPath: join(world.cwd, "b", "target.bin") },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 100, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.decision?.chosen === "source:0", "decision.chosen is not source:0");
    const first = sourceById(result.domain, "source:0");
    checks(first?.attempt === "definitive_negative", `source:0 attempt ${first?.attempt}`);
    checks(first?.negative === "byte_mismatch", `source:0 negative ${first?.negative}`);
    checks(sourceById(result.domain, "source:1")?.attempt === "matched", "source:1 is not matched");
    checks(result.domain.match?.absolutePath === oracle.bPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 2, `openCount ${openCount}`);
  },
});

// 3. Preferred same-name type mismatch (symlink elsewhere); alternate matches.
await singleCase({
  caseId: "p4f-03-type-mismatch-fallback",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:0",
  },
  create: {
    scenarioId: "p4f-03",
    entries: [
      { path: "start/a/real.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const targetPath = join(world.cwd, "a", "target.bin");
    await symlink("real.bin", targetPath);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          bOracle.expectedBase64,
          "p4f-03",
        ),
      ),
      oracle: {
        aEntry: await oracleEntry(targetPath),
        bPath: join(world.cwd, "b", "target.bin"),
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(oracle.aEntry.kind === "symlink", "source:0 is not a symlink");
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(sourceById(result.domain, "source:0")?.negative === "type_mismatch", "source:0 is not type_mismatch");
    checks(sourceById(result.domain, "source:1")?.attempt === "matched", "source:1 is not matched");
    checks(result.domain.match?.absolutePath === oracle.bPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 4. Preferred same-name absent; alternate matches.
await singleCase({
  caseId: "p4f-04-not-found-fallback",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:1",
  },
  create: {
    scenarioId: "p4f-04",
    entries: [
      { path: "start/a/other.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aNames = (await readdir(join(world.cwd, "a"))).sort();
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          bOracle.expectedBase64,
          "p4f-04",
        ),
      ),
      oracle: { aNames, bPath: join(world.cwd, "b", "target.bin") },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(!oracle.aNames.includes("target.bin"), "source:0 unexpectedly contains target.bin");
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(sourceById(result.domain, "source:0")?.negative === "not_found", "source:0 is not not_found");
    checks(sourceById(result.domain, "source:1")?.attempt === "matched", "source:1 is not matched");
    checks(result.domain.match?.absolutePath === oracle.bPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 5. Both sources are definitive byte mismatches.
await singleCase({
  caseId: "p4f-05-both-byte-mismatch",
  expected: {
    status: "unmet",
    resolution: "byte_mismatch",
    satisfaction: 0,
    openCount: 2,
    chosen: null,
  },
  create: {
    scenarioId: "p4f-05",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: WORSE },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          b64(GOOD),
          "p4f-05",
        ),
      ),
      oracle: {
        aBytes: aOracle.expectedBase64,
        bBytes: bOracle.expectedBase64,
        expected: b64(GOOD),
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(oracle.aBytes !== oracle.expected && oracle.bBytes !== oracle.expected, "oracle bytes do not differ from GOOD");
    checks(result.domain.status === "unmet", `status ${result.domain.status}`);
    checks(result.domain.resolution === "byte_mismatch", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 0, `satisfaction ${result.domain.satisfaction}`);
    checks(sourceById(result.domain, "source:0")?.negative === "byte_mismatch", "source:0 is not byte_mismatch");
    checks(sourceById(result.domain, "source:1")?.negative === "byte_mismatch", "source:1 is not byte_mismatch");
    checks(openCount === 2, `openCount ${openCount}`);
  },
});

// 5b. byte_mismatch outranks not_found when the negative set is mixed.
await singleCase({
  caseId: "p4f-05b-byte-mismatch-priority-over-not-found",
  expected: {
    status: "unmet",
    resolution: "byte_mismatch",
    satisfaction: 0,
    openCount: 1,
  },
  create: {
    scenarioId: "p4f-05b",
    entries: [
      { path: "start/a/other.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
  },
  run: async (world) => {
    const aNames = (await readdir(join(world.cwd, "a"))).sort();
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          b64(GOOD),
          "p4f-05b",
        ),
      ),
      oracle: { aNames, bBytes: bOracle.expectedBase64, expected: b64(GOOD) },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(!oracle.aNames.includes("target.bin"), "source:0 unexpectedly contains target.bin");
    checks(oracle.bBytes !== oracle.expected, "source:1 oracle unexpectedly matched");
    checks(result.domain.status === "unmet", `status ${result.domain.status}`);
    checks(result.domain.resolution === "byte_mismatch", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 0, `satisfaction ${result.domain.satisfaction}`);
    checks(sourceById(result.domain, "source:0")?.negative === "not_found", "source:0 is not not_found");
    checks(sourceById(result.domain, "source:1")?.negative === "byte_mismatch", "source:1 is not byte_mismatch");
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 6. Preferred direct match short-circuits; alternate is never inspected or read.
await singleCase({
  caseId: "p4f-06-preferred-match-short-circuit",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:0",
  },
  create: {
    scenarioId: "p4f-06",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-06",
        ),
      ),
      oracle: {
        aPath: join(world.cwd, "a", "target.bin"),
        aBytes: aOracle.expectedBase64,
        bBytes: bOracle.expectedBase64,
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.decision?.chosen === "source:0", "decision.chosen is not source:0");
    checks(result.domain.match?.absolutePath === oracle.aPath, `match ${result.domain.match?.absolutePath}`);
    checks(sourceById(result.domain, "source:1")?.attempt === "not_attempted", "source:1 was attempted");
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 7. Declared order 1/0 makes source:1 preferred.
await singleCase({
  caseId: "p4f-07-order-reversed",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:1",
  },
  create: {
    scenarioId: "p4f-07",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 1 }, { directory: world.refB, order: 0 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-07",
        ),
      ),
      oracle: { aPath: join(world.cwd, "a", "target.bin"), bPath: join(world.cwd, "b", "target.bin") },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.decision?.chosen === "source:1", "decision.chosen is not source:1");
    checks(sourceById(result.domain, "source:0")?.attempt === "not_attempted", "source:0 was attempted");
    checks(result.domain.match?.absolutePath === oracle.bPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 8. Two legal candidates without order defer before any inspect or read.
await singleCase({
  caseId: "p4f-08-defer-no-order",
  expected: {
    status: "unknown",
    resolution: "insufficient_evidence",
    satisfaction: null,
    openCount: 0,
    deferKind: "defer",
  },
  create: {
    scenarioId: "p4f-08",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA }, { directory: world.refB }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-08",
        ),
      ),
      oracle: { expected: aOracle.expectedBase64 },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "insufficient_evidence", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.decision?.kind === "defer", `decision ${result.domain.decision?.kind}`);
    checks(
      result.domain.decision?.missingKeys?.includes("rankOrder"),
      `missingKeys ${JSON.stringify(result.domain.decision?.missingKeys)}`,
    );
    checks(openCount === 0, `openCount ${openCount}`);
  },
});

// 9. Preferred is replaced before open; READ_TARGET_CHANGED refuses it, alternate matches.
await singleCase({
  caseId: "p4f-09-stale-refused-fallback",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 2,
    chosen: "source:0",
    source0Attempt: "unknown",
  },
  create: {
    scenarioId: "p4f-09",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/a/swap.bin", kind: "file", contents: EVIL },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    ioHooks: {
      beforeOpen: async (path) => {
        const directory = dirname(path);
        if (!directory.endsWith("/a")) return;
        await rename(join(directory, "target.bin"), join(directory, "original.bin"));
        await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
      },
    },
  },
  run: async (world) => {
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        bOracle.expectedBase64,
        "p4f-09",
      ),
    );
    return {
      result,
      oracle: {
        bPath: join(world.cwd, "b", "target.bin"),
        evilBase64: b64(EVIL),
        errorCodes: nativeErrorCodes(result.domain),
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 100, `satisfaction ${result.domain.satisfaction}`);
    checks(sourceById(result.domain, "source:0")?.attempt === "unknown", "source:0 is not unknown");
    checks(sourceById(result.domain, "source:1")?.attempt === "matched", "source:1 is not matched");
    checks(result.domain.match?.absolutePath === oracle.bPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 2, `openCount ${openCount}`);
    checks(
      !JSON.stringify(result.domain).includes(oracle.evilBase64),
      "replacement bytes leaked into the domain",
    );
    checks(
      oracle.errorCodes.includes("READ_TARGET_CHANGED"),
      `read refusal codes ${JSON.stringify(oracle.errorCodes)}`,
    );
  },
});

// 10. Preferred replacement plus definitive alternate byte mismatch stays unknown.
await singleCase({
  caseId: "p4f-10-stale-plus-negative",
  expected: {
    status: "unknown",
    resolution: "stale_or_unverified",
    satisfaction: null,
    openCount: 2,
    chosen: null,
    source0Attempt: "unknown",
    source1Negative: "byte_mismatch",
  },
  create: {
    scenarioId: "p4f-10",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/a/swap.bin", kind: "file", contents: EVIL },
      { path: "start/b/target.bin", kind: "file", contents: BAD },
    ],
    ioHooks: {
      beforeOpen: async (path) => {
        const directory = dirname(path);
        if (!directory.endsWith("/a")) return;
        await rename(join(directory, "target.bin"), join(directory, "original.bin"));
        await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
      },
    },
  },
  run: async (world) => {
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        b64(GOOD),
        "p4f-10",
      ),
    );
    return {
      result,
      oracle: {
        bBytes: bOracle.expectedBase64,
        expected: b64(GOOD),
        errorCodes: nativeErrorCodes(result.domain),
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(oracle.bBytes !== oracle.expected, "alternate oracle unexpectedly matched");
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "stale_or_unverified", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(sourceById(result.domain, "source:0")?.attempt === "unknown", "source:0 is not unknown");
    checks(sourceById(result.domain, "source:1")?.negative === "byte_mismatch", "source:1 is not byte_mismatch");
    checks(openCount === 2, `openCount ${openCount}`);
    checks(
      oracle.errorCodes.includes("READ_TARGET_CHANGED"),
      `read refusal codes ${JSON.stringify(oracle.errorCodes)}`,
    );
  },
});

// 11. Replacement with bytes matching the expectation still leaves the source unknown.
await singleCase({
  caseId: "p4f-11-stale-refused-good-replacement",
  expected: {
    status: "unknown",
    resolution: "stale_or_unverified",
    satisfaction: null,
    openCount: 1,
    chosen: null,
    source0Attempt: "unknown",
    source1Negative: "not_found",
  },
  create: {
    scenarioId: "p4f-11",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/a/swap.bin", kind: "file", contents: GOOD },
      { path: "start/b/other.bin", kind: "file", contents: GOOD },
    ],
    ioHooks: {
      beforeOpen: async (path) => {
        const directory = dirname(path);
        if (!directory.endsWith("/a")) return;
        await rename(join(directory, "target.bin"), join(directory, "original.bin"));
        await rename(join(directory, "swap.bin"), join(directory, "target.bin"));
      },
    },
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-11",
        ),
      ),
      oracle: { expectedBytes: aOracle.expectedBase64, aPath: join(world.cwd, "a", "target.bin") },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "stale_or_unverified", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.match === null, "stale refusal produced a match");
    checks(sourceById(result.domain, "source:0")?.attempt === "unknown", "source:0 is not unknown");
    checks(sourceById(result.domain, "source:1")?.negative === "not_found", "source:1 is not not_found");
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 12. Forged reference is rejected before any listing or read.
await singleCase({
  caseId: "p4f-12-forged-reference-rejected",
  expected: {
    status: "rejected",
    resolution: "rejected",
    satisfaction: null,
    openCount: 0,
  },
  create: {
    scenarioId: "p4f-12",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    listingObserver: async () => {
      throw new Error("unexpected listing for forged reference");
    },
  },
  run: async (world) => {
    const forged = {
      kind: "cli.directory",
      scenarioId: "other",
      sessionId: world.session.sessionId,
      path: "a",
    };
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: forged, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        aOracle.expectedBase64,
        "p4f-12",
      ),
    );
    return { result, oracle: { expected: aOracle.expectedBase64 } };
  },
  verify: ({ result, checks, openCount }) => {
    checks(result.response?.kind === "request_rejected", `response kind ${result.response?.kind}`);
    checks(result.domain.status === "rejected", `status ${result.domain.status}`);
    checks(result.domain.resolution === "rejected", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(openCount === 0, `openCount ${openCount}`);
  },
});

// 13. Same directory twice is rejected before any listing or read.
await singleCase({
  caseId: "p4f-13-duplicate-directory-rejected",
  expected: {
    status: "rejected",
    resolution: "rejected",
    satisfaction: null,
    openCount: 0,
  },
  create: {
    scenarioId: "p4f-13",
    entries: [{ path: "start/a/target.bin", kind: "file", contents: GOOD }],
    listingObserver: async () => {
      throw new Error("unexpected listing for duplicate directory");
    },
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refA, order: 1 }],
        "target.bin",
        aOracle.expectedBase64,
        "p4f-13",
      ),
    );
    return { result, oracle: { expected: aOracle.expectedBase64 } };
  },
  verify: ({ result, checks, openCount }) => {
    checks(result.response?.kind === "request_rejected", `response kind ${result.response?.kind}`);
    checks(result.domain.status === "rejected", `status ${result.domain.status}`);
    checks(result.domain.resolution === "rejected", `resolution ${result.domain.resolution}`);
    checks(openCount === 0, `openCount ${openCount}`);
  },
});

// 14. Read-less session is rejected by the public entry, not merely a contract error.
await singleCase({
  caseId: "p4f-14-read-less-session-rejected",
  expected: {
    status: "rejected",
    resolution: "rejected",
    satisfaction: null,
    openCount: 0,
  },
  create: {
    scenarioId: "p4f-14",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    grantedEffects: ["process.exec"],
    legacyBindings: true,
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        aOracle.expectedBase64,
        "p4f-14",
      ),
    );
    return { result, oracle: { expected: aOracle.expectedBase64 } };
  },
  verify: ({ result, checks, openCount }) => {
    checks(result.response?.kind === "request_rejected", `response kind ${result.response?.kind}`);
    checks(result.domain.status === "rejected", `status ${result.domain.status}`);
    checks(result.domain.resolution === "rejected", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(openCount === 0, `openCount ${openCount}`);
  },
});

// 15. A measured budget cutoff keeps the preferred chain's byte mismatch but
// cannot complete the fallback. The 64-transition baseline still achieves.
let p4f15BaselineAtomicCount = null;
await singleCase({
  caseId: "p4f-15-budget-baseline",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 2,
    chosen: "source:0",
  },
  create: {
    scenarioId: "p4f-15-baseline",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        bOracle.expectedBase64,
        "p4f-15-baseline",
      ),
    );
    p4f15BaselineAtomicCount = result.response?.report?.atomicResults?.length ?? 0;
    return {
      result,
      oracle: { bPath: join(world.cwd, "b", "target.bin"), atomicCount: p4f15BaselineAtomicCount },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(result.domain.status === "achieved", `baseline status ${result.domain.status}`);
    checks(result.domain.match?.absolutePath === oracle.bPath, "baseline match path");
    checks(openCount === 2, `baseline openCount ${openCount}`);
    checks(oracle.atomicCount > 0, `baseline atomicCount ${oracle.atomicCount}`);
  },
});
await singleCase({
  caseId: "p4f-15-budget-interrupted",
  expected: {
    status: "unknown",
    resolution: "interrupted",
    satisfaction: null,
    openCount: 1,
    source0Negative: "byte_mismatch",
  },
  create: {
    scenarioId: "p4f-15-budget",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        bOracle.expectedBase64,
        "p4f-15-budget",
      ),
      {
        limits: {
          maxTransitions: 24,
          maxDepth: 4,
          maxDerivedGoals: 12,
        },
      },
    );
    return {
      result,
      oracle: {
        bPath: join(world.cwd, "b", "target.bin"),
        baselineAtomicCount: p4f15BaselineAtomicCount,
        budget: 24,
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(oracle.baselineAtomicCount !== null && oracle.baselineAtomicCount > 0, "baseline atomic count missing");
    checks(oracle.budget === 24, "budget is not the measured cutoff");
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "interrupted", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.match === null, "interrupted run produced a match");
    checks(sourceById(result.domain, "source:0")?.negative === "byte_mismatch", "preferred byte mismatch fact lost");
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 16. Cancellation after the first inspect keeps preferred facts and stops interrupted.
await singleCase({
  caseId: "p4f-16-cancel-after-inspect",
  expected: {
    status: "unknown",
    resolution: "interrupted",
    satisfaction: null,
    openCount: 0,
  },
  create: {
    scenarioId: "p4f-16",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: BAD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const aPath = join(world.cwd, "a", "target.bin");
    const controller = new AbortController();
    let cancelled = false;
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
        "target.bin",
        bOracle.expectedBase64,
        "p4f-16",
      ),
      {
        signal: controller.signal,
        onSample: async (sample) => {
          if (cancelled || sample.action?.kind !== "entry.inspect") return;
          const inspectedPath = sample.observed_state_after?.entryKnowledge?.query?.ref?.path;
          if (typeof inspectedPath !== "string") return;
          if (!inspectedPath.endsWith("/target.bin")) return;
          const resolved = inspectedPath.startsWith("/")
            ? inspectedPath
            : join(world.cwd, inspectedPath);
          if (resolved !== aPath) return;
          cancelled = true;
          controller.abort();
        },
      },
    );
    return {
      result,
      oracle: { cancelled, bPath: join(world.cwd, "b", "target.bin") },
    };
  },
  verify: ({ result, oracle, checks }) => {
    checks(oracle.cancelled === true, "inspect callback did not abort");
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "interrupted", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.match === null, "cancelled run produced a match");
    const first = sourceById(result.domain, "source:0");
    checks(
      first?.attempt === "unknown" || first?.negative === "byte_mismatch",
      `source:0 attempt ${first?.attempt} negative ${first?.negative}`,
    );
  },
});

// 17. Single legal candidate is inspected directly without invoking the decision unit.
await singleCase({
  caseId: "p4f-17-single-legal-candidate",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 1,
    chosen: "source:0",
    decisionInferCalls: 0,
  },
  create: {
    scenarioId: "p4f-17",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/other.bin", kind: "file", contents: GOOD },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const baseDecision = recursive.createDefaultPlanningDecisionBinding();
    let decisionInferCalls = 0;
    const decision = Object.freeze({
      ref: baseDecision.ref,
      infer: async (input) => {
        decisionInferCalls += 1;
        return baseDecision.infer(input);
      },
    });
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-17",
        ),
        { decision },
      ),
      oracle: {
        aPath: join(world.cwd, "a", "target.bin"),
        aBytes: aOracle.expectedBase64,
        bNames: (await readdir(join(world.cwd, "b"))).sort(),
        decisionInferCalls,
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(!oracle.bNames.includes("target.bin"), "source:1 unexpectedly contains target.bin");
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 100, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.match?.absolutePath === oracle.aPath, `match ${result.domain.match?.absolutePath}`);
    checks(result.domain.decision?.chosen === "source:0", "single legal candidate was not selected");
    checks(oracle.decisionInferCalls === 0, `decision unit infer calls ${oracle.decisionInferCalls}`);
    checks(openCount === 1, `openCount ${openCount}`);
  },
});

// 18a. One unknown source does not poison another source's complete match.
// The decision prefers source:1 first. Its short range read is unknown, then
// the fallback source:0 completes and the root reaches achieved/100.
await singleCase({
  caseId: "p4f-18a-unknown-source-does-not-poison-match",
  expected: {
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    openCount: 2,
    source0Attempt: "matched",
    source1Attempt: "unknown",
  },
  create: {
    scenarioId: "p4f-18a",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: "GOO" },
    ],
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    const result = await run(
      world,
      request(
        [{ directory: world.refA, order: 1 }, { directory: world.refB, order: 0 }],
        "target.bin",
        aOracle.expectedBase64,
        "p4f-18a",
      ),
    );
    return {
      result,
      oracle: {
        aPath: join(world.cwd, "a", "target.bin"),
        aBytes: aOracle.expectedBase64,
        bBytes: bOracle.expectedBase64,
        bBytesRead: bOracle.bytesRead,
      },
    };
  },
  verify: ({ result, oracle, checks, openCount }) => {
    checks(oracle.aBytes === b64(GOOD), "source:0 oracle is not GOOD");
    checks(oracle.bBytes === null && oracle.bBytesRead === 3, "source:1 oracle is not a short read");
    checks(result.domain.status === "achieved", `status ${result.domain.status}`);
    checks(result.domain.resolution === "matched", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === 100, `satisfaction ${result.domain.satisfaction}`);
    checks(sourceById(result.domain, "source:1")?.attempt === "unknown", "source:1 is not unknown");
    checks(sourceById(result.domain, "source:0")?.attempt === "matched", "source:0 is not matched");
    checks(result.domain.match?.absolutePath === oracle.aPath, `match ${result.domain.match?.absolutePath}`);
    checks(openCount === 2, `openCount ${openCount}`);
  },
});

// 18b. Partial alternate listing with a matching preferred source.
// The actual result is unknown/insufficient_evidence: the engine closes before
// source:0 is inspected. Matrix 8.6 assigns unknown to a run with no completed
// source chain and an unknown source. This case therefore records the real
// boundary and proves the partial source is not coerced to a negative; it does
// not claim to demonstrate that a completed preferred match survives unknown.
await singleCase({
  caseId: "p4f-18b-partial-alternate-stops-before-chain",
  expected: {
    status: "unknown",
    resolution: "insufficient_evidence",
    satisfaction: null,
    openCount: 0,
    source0Attempt: "not_attempted",
    source1Attempt: "not_attempted",
    coverage: null,
  },
  create: {
    scenarioId: "p4f-18",
    entries: [
      { path: "start/a/target.bin", kind: "file", contents: GOOD },
      { path: "start/b/target.bin", kind: "file", contents: GOOD },
    ],
    listingObserver: async (input) => {
      if (input.physicalDirectory.endsWith("/a")) return realListing(input);
      return partialListing(input);
    },
  },
  run: async (world) => {
    const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
    const bOracle = await oracleBytes(join(world.cwd, "b", "target.bin"), 0, 4);
    return {
      result: await run(
        world,
        request(
          [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
          "target.bin",
          aOracle.expectedBase64,
          "p4f-18",
        ),
      ),
      oracle: {
        aPath: join(world.cwd, "a", "target.bin"),
        aBytes: aOracle.expectedBase64,
        bBytes: bOracle.expectedBase64,
        aType: (await oracleEntry(join(world.cwd, "a", "target.bin"))).kind,
        bType: (await oracleEntry(join(world.cwd, "b", "target.bin"))).kind,
      },
    };
  },
  verify: ({ result, oracle, checks }) => {
    checks(oracle.aBytes === b64(GOOD) && oracle.bBytes === b64(GOOD), "oracle bytes are not both GOOD");
    checks(oracle.aType === "file" && oracle.bType === "file", "oracle types are not regular files");
    checks(result.domain.status === "unknown", `status ${result.domain.status}`);
    checks(result.domain.resolution === "insufficient_evidence", `resolution ${result.domain.resolution}`);
    checks(result.domain.satisfaction === null, `satisfaction ${result.domain.satisfaction}`);
    checks(result.domain.match === null, "partial alternate produced a match");
    checks(result.domain.coverage === null, `coverage ${result.domain.coverage}`);
    checks(sourceById(result.domain, "source:0")?.attempt === "not_attempted", "source:0 was inspected");
    checks(sourceById(result.domain, "source:1")?.attempt === "not_attempted", "source:1 was inspected");
    checks(sourceById(result.domain, "source:0")?.negative === null, "source:0 became a negative");
    checks(sourceById(result.domain, "source:1")?.negative === null, "source:1 became a negative");
  },
});

// 20. Handwired rank-order reversal flips the chosen source; both sides still achieve.
await pairedCase({
  left: {
    caseId: "p4f-20-handwired-order-first",
    expected: {
      status: "achieved",
      resolution: "matched",
      satisfaction: 100,
      openCount: 1,
      chosen: "source:0",
    },
    create: {
      scenarioId: "p4f-20-order-first",
      entries: [
        { path: "start/a/target.bin", kind: "file", contents: GOOD },
        { path: "start/b/target.bin", kind: "file", contents: GOOD },
      ],
    },
    run: async (world) => {
      const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
      const firstProfile = programmaticDecision(-1, "order-first");
      const binding = await recursive.createHandwiredPlanningDecisionBinding({
        kind: "planning_decision.handwired.v1",
        profile: firstProfile,
        handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      });
      return {
        result: await run(
          world,
          request(
            [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
            "target.bin",
            aOracle.expectedBase64,
            "p4f-20-order-first",
          ),
          { decision: binding },
        ),
        oracle: { aPath: join(world.cwd, "a", "target.bin"), bPath: join(world.cwd, "b", "target.bin") },
      };
    },
    verify: ({ result, oracle, checks, openCount }) => {
      checks(result.domain.status === "achieved", `status ${result.domain.status}`);
      checks(result.domain.decision?.chosen === "source:0", "order-first did not choose source:0");
      checks(result.domain.match?.absolutePath === oracle.aPath, "order-first match path");
      checks(openCount === 1, `openCount ${openCount}`);
    },
  },
  right: {
    caseId: "p4f-20-handwired-reversed",
    expected: {
      status: "achieved",
      resolution: "matched",
      satisfaction: 100,
      openCount: 1,
      chosen: "source:1",
    },
    create: {
      scenarioId: "p4f-20-reversed",
      entries: [
        { path: "start/a/target.bin", kind: "file", contents: GOOD },
        { path: "start/b/target.bin", kind: "file", contents: GOOD },
      ],
    },
    run: async (world) => {
      const aOracle = await oracleBytes(join(world.cwd, "a", "target.bin"), 0, 4);
      const reversedProfile = programmaticDecision(1, "reversed");
      const binding = await recursive.createHandwiredPlanningDecisionBinding({
        kind: "planning_decision.handwired.v1",
        profile: reversedProfile,
        handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      });
      return {
        result: await run(
          world,
          request(
            [{ directory: world.refA, order: 0 }, { directory: world.refB, order: 1 }],
            "target.bin",
            aOracle.expectedBase64,
            "p4f-20-reversed",
          ),
          { decision: binding },
        ),
        oracle: { aPath: join(world.cwd, "a", "target.bin"), bPath: join(world.cwd, "b", "target.bin") },
      };
    },
    verify: ({ result, oracle, checks, openCount }) => {
      checks(result.domain.status === "achieved", `status ${result.domain.status}`);
      checks(result.domain.decision?.chosen === "source:1", "reversed did not choose source:1");
      checks(result.domain.match?.absolutePath === oracle.bPath, "reversed match path");
      checks(openCount === 1, `openCount ${openCount}`);
    },
  },
});

const passed = caseResults.filter((entry) => entry.oracleOk === true).length;
const failedCount = caseResults.length - passed;
const exitCode = failedCount === 0 ? 0 : 1;
const summary = {
  family: "multi-source-independent",
  cases: caseResults.length,
  passed,
  exitCode,
};
record(summary);

await mkdir(dirname(LOG_PATH), { recursive: true });
await writeFile(LOG_PATH, `${outputLines.join("\n")}\n`, "utf8");
process.exitCode = exitCode;
