import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { createCliFilesystemSandbox, runCliContentSearchGoal } = await import("nnanything/cli-content-search");

const RESULT_PATH =
  "/Volumes/Intel/playground/nnanything-runs/cli-programming-search-m2-20261024/family-p2.json";
const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const profile = JSON.parse(await readFile(profileFile, "utf8"));

// Independent family: no entry name, content byte, or needle is shared with the
// P1 fixture family or the P2 train/dev/test recipes.
const NEEDLE = "quasarGauge";
const MAGNET = `export const magnetState = "dormant";\nexport function pull(){ return "hold"; }\n`;
const RELIC = `export const quasarGauge = "relic-77";\nexport function awaken(){ return "relic-77"; }\n`;
const RELIC_QUIET = `export const relicState = "quiet";\nexport function rest(){ return 0; }\n`;
const NOTE = `quasarGauge is only mentioned in this note.\n`;
const LIMITS = Object.freeze({ maxTransitions: 52, maxDepth: 8, maxDerivedGoals: 9 });
const SCAN = Object.freeze({
  maxBytesPerFile: 65536,
  maxTotalBytes: 262144,
  chunkSize: 65536,
  maxDirectoryDepth: 1,
  maxStaleRetries: 1,
});
const SESSION = Object.freeze({
  id: "s",
  cwd: ".",
  grantedEffects: Object.freeze(["filesystem.read", "process.exec"]),
});

function entries(relic) {
  return [
    { path: "vault", kind: "directory" },
    { path: "vault/magnet.ts", kind: "file", contents: MAGNET },
    { path: "vault/cache", kind: "directory" },
    { path: "vault/cache/relic.ts", kind: "file", contents: relic },
    { path: "vault/cache/readme.txt", kind: "file", contents: NOTE },
  ];
}

function request(directory) {
  return {
    requestId: "independent-family-p2",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality: "all",
        recursion: "nested",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle: NEEDLE, encoding: "utf8" },
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

// Independent oracle: walks the real tree with node:fs only and computes the
// expected matches, absolute byte spans, coverage and read totals itself.
async function oracleScan(scenarioRoot) {
  const scopeRoot = resolve(scenarioRoot, "vault");
  const directories = await listOracleDirectories(scopeRoot, SCAN.maxDirectoryDepth);
  const candidates = [];
  for (const directory of directories) {
    const found = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of found) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const path = join(directory.absolute, entry.name);
      const bytes = await readFile(path);
      const start = bytes.indexOf(Buffer.from(NEEDLE, "utf8"));
      const position = start < 0 ? null : lineColumn(bytes, start);
      candidates.push({
        path: await realpath(path),
        size: bytes.length,
        match: start < 0
          ? null
          : {
              byteSpan: { start, end: start + Buffer.byteLength(NEEDLE, "utf8") },
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

async function trajectory(label, relic, assertions) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-independent-p2-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "m2-independent-p2-vault",
      entries: entries(relic),
      sessions: [SESSION],
    },
  });
  try {
    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, "vault");
    const scenarioRoot = sandbox.scenarioRoot;
    const oracle = await oracleScan(scenarioRoot);
    const before = {
      processCwd: process.cwd(),
      sessionCwd: sandbox.getSession(session).cwd,
      tree: await snapshotTree(scenarioRoot),
    };
    const result = await runCliContentSearchGoal(request(directory), {
      sandbox,
      session,
      profile,
      limits: LIMITS,
      scan: SCAN,
    });
    const domain = result.domain;
    assertions(domain, oracle);
    const readOnly = await assertReadOnly({ sandbox, session, scenarioRoot }, before, domain);
    return {
      label,
      oracle: {
        directories: oracle.directories.map(directory => directory.absolute),
        candidates: oracle.candidates,
        matchPaths: oracle.matchPaths,
        negativePaths: oracle.negativePaths,
        bytesTotal: oracle.bytesTotal,
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
    scenarioId: "m2-independent-p2-vault",
    needle: NEEDLE,
    entries: ["vault/magnet.ts", "vault/cache/relic.ts", "vault/cache/readme.txt"],
    note: "readme.txt contains the needle but is excluded by the .ts suffix condition",
  },
  entry: "nnanything/cli-content-search",
  profile: profileFile,
  oracle: "node:fs directory walk plus Buffer.indexOf",
  generatedAt: new Date().toISOString(),
};

try {
  const beforeCwd = process.cwd();
  const normal = await trajectory("all-nested-hit", RELIC, (domain, oracle) => {
    assert.equal(domain.status, "achieved");
    assert.equal(domain.resolution, "matched");
    assert.equal(domain.satisfaction, 100);
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.rootFact.kind, "matched");
    assert.equal(domain.cardinality, "all");
    assert.equal(domain.recursion, "nested");
    assert.equal(domain.invocationCount, 6);
    assert.equal(domain.observationCount, 6);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.duplicateReads, 0);
    assert.deepEqual(denominators(domain), [2, 2, 2, 2, 1, 1, 0]);
    assert.equal(domain.denominators.directoriesUncovered, 0);
    assert.equal(domain.denominators.typeMismatches, 0);
    assert.equal(oracle.candidates.length, 2);
    assertMatches(domain, oracle);
    assert.equal(domain.matches.length, 1);
    assert.equal(domain.matches[0].path.endsWith("/vault/cache/relic.ts"), true);
    assert.equal(domain.matches[0].scanComplete, true);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    assert.equal(domain.negatives[0].path.endsWith("/vault/magnet.ts"), true);
  });
  normal.oracle.coverage = "complete";

  const noHit = await trajectory("all-nested-complete-no-hit", RELIC_QUIET, (domain, oracle) => {
    assert.equal(domain.status, "unmet");
    assert.equal(domain.resolution, "not_found");
    assert.equal(domain.satisfaction, 0);
    assert.equal(domain.coverage, "complete");
    assert.equal(domain.rootFact.kind, "not_found");
    assert.equal(domain.cardinality, "all");
    assert.equal(domain.recursion, "nested");
    assert.equal(domain.invocationCount, 6);
    assert.equal(domain.observationCount, 6);
    assert.equal(domain.bytesReadTotal, oracle.bytesTotal);
    assert.equal(domain.duplicateReads, 0);
    assert.deepEqual(denominators(domain), [2, 2, 2, 2, 0, 2, 0]);
    assert.equal(domain.denominators.directoriesUncovered, 0);
    assert.equal(domain.denominators.typeMismatches, 0);
    assert.equal(oracle.candidates.length, 2);
    assert.deepEqual(domain.matches, []);
    assert.equal(oracle.matchPaths.length, 0);
    assert.deepEqual(domain.negatives.map(negative => negative.path), oracle.negativePaths);
    assert.equal(domain.negatives.every(negative => negative.reason === "complete_read_no_match"), true);
  });
  noHit.oracle.coverage = "complete";

  assert.notEqual(normal.result.bytesReadTotal, 0);
  assert.equal(process.cwd(), beforeCwd);
  payload.trajectories = { normal, noHit };
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
    normal: normal.result.resolution,
    noHit: noHit.result.resolution,
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
