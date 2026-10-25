import test from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const searchApi = () => import("nnanything/cli-content-search");
const policyApi = () => import("nnanything/cli-goal");

const SCAN = Object.freeze({
  maxBytesPerFile: 4096,
  maxTotalBytes: 4096,
  chunkSize: 16,
  maxDirectoryDepth: 0,
  maxStaleRetries: 1,
});

const LIMITS = Object.freeze({ maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 16 });

async function fixture(t, entries) {
  const module = await searchApi();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-inc-a-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "p3-inc-a",
      entries,
      sessions: [{ id: "s", cwd: "src", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { module, sandbox, session: sandbox.bindSession("s"), root };
}

function request(directory) {
  return {
    requestId: "p3-inc-a",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality: "one",
        recursion: "flat",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle: "KX000001", encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

function baselineProfile(module) {
  // Bias-only profiles would leave ls and entry.inspect tied and make every
  // atomic selection a policy error. The baseline must keep the legacy trained
  // ls preference (forced through its real wire) and inspect preference so the
  // only difference between baseline and weighted runs is the name column.
  const profile = module.zeroCliCommandProfile();
  const weights = profile.weights.map(row => [...row]);
  const goalList = profile.wires.indexOf("goalListDirectory");
  weights[profile.heads.indexOf("ls")][goalList] = 10;
  const inspect = profile.heads.indexOf("entry.inspect");
  weights[inspect][profile.wires.indexOf("predicate.observe.inspect")] = 10;
  weights[inspect][profile.wires.indexOf("property.type")] = 10;
  return { ...profile, weights };
}

function namedProfile(module) {
  const profile = baselineProfile(module);
  const weights = profile.weights.map(row => [...row]);
  const inspect = profile.heads.indexOf("entry.inspect");
  const nameWire = profile.wires.indexOf("search.nameNeedleSegment");
  weights[inspect][nameWire] = 10;
  return { ...profile, weights };
}

function inspectTransitions(result) {
  const report = result.response?.report;
  const atomicResults = report?.atomicResults ?? [];
  return atomicResults
    .map(item => item?.sourceResult?.value)
    .filter(value => value && value.goal?.property === "file.property.type")
    .map(value => basename(value.goal.target.ref.path));
}

const THREE_FILES = Object.freeze([
  { path: "src", kind: "directory" },
  { path: "src/a-PX000001.ts", kind: "file", contents: "no needle here".padEnd(16, "x") },
  { path: "src/b-PX000002.ts", kind: "file", contents: "no needle here".padEnd(16, "y") },
  { path: "src/z-KX000001.ts", kind: "file", contents: "KX000001" },
]);

test("R1 a positive name-relation weight reorders indistinguishable inspect candidates", async t => {
  const value = await fixture(t, THREE_FILES);
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const zero = await value.module.runCliContentSearchGoal(request(directory), {
    sandbox: value.sandbox,
    session: value.session,
    profile: baselineProfile(await policyApi()),
    limits: LIMITS,
    scan: SCAN,
  });
  const weighted = await value.module.runCliContentSearchGoal(request(directory), {
    sandbox: value.sandbox,
    session: value.session,
    profile: namedProfile(await policyApi()),
    limits: LIMITS,
    scan: SCAN,
  });
  assert.equal(zero.domain.status, "achieved");
  assert.equal(weighted.domain.status, "achieved");
  assert.equal(weighted.domain.invocationCount, 3);
  assert.ok(zero.domain.invocationCount > weighted.domain.invocationCount);
  assert.deepEqual(inspectTransitions(weighted), ["z-KX000001.ts"]);
});

test("R2 head supervision cannot carry a same-head candidate comparison", async () => {
  const module = await policyApi();
  const facts = { hasFreshEvidence: 1, knownValue: 1, requiredConditionHolds: 1, hasDestinationRef: 1 };
  const inspectGoal = target => ({
    kind: "file.property",
    property: "file.property.type",
    target,
    requirement: { kind: "observed", freshness: "this_run" },
  });
  // The head-selection context only reads the registered property and predicate.
  // Candidate names are absent from that feature vector, so the old head cross-
  // entropy cannot produce a same-head candidate-comparison gradient.
  const headFeaturesA = module.cliCommandFeatures(inspectGoal({ path: "src/a-PX000001.ts" }), facts);
  const headFeaturesZ = module.cliCommandFeatures(inspectGoal({ path: "src/z-KX000001.ts" }), facts);
  assert.deepEqual(headFeaturesA, headFeaturesZ);
  assert.equal(headFeaturesA[module.CLI_COMMAND_WIRES.indexOf("search.nameNeedleSegment")], 0);
  // The dedicated candidate context is the only vector that carries the
  // name-relation feature, and it is separate from head supervision.
  const candidateFeaturesA = module.cliCandidateFeatures("a-PX000001.ts", "KX000001");
  const candidateFeaturesZ = module.cliCandidateFeatures("z-KX000001.ts", "KX000001");
  assert.notDeepEqual(candidateFeaturesA, candidateFeaturesZ);
});

test("R4 experiment condition never changes the candidate feature vector", async () => {
  const module = await policyApi();
  const natural = module.cliCandidateFeatures("z-KX000001.ts", "KX000001");
  const forced = module.cliCandidateFeatures("z-KX000001.ts", "KX000001", {
    order: { kind: "injected-first", name: "a-PX000001.ts" },
    experimentCondition: "forced",
  });
  assert.deepEqual(forced, natural);
  assert.deepEqual(natural, Array.from({ length: 31 }, (_, index) => index === module.zeroCliCommandProfile().wires.indexOf("search.nameNeedleSegment") ? 1 : 0));
  assert.deepEqual(module.cliCandidateFeatures("a-PX000001.ts", "KX000001"), Array(31).fill(0));
});

test("R5 a forced first candidate is consumed and does not permanently pin the next selection", async t => {
  const value = await fixture(t, THREE_FILES);
  const directory = await value.sandbox.bindDirectory(value.session, ".");
  const zero = await value.module.runCliContentSearchGoal(request(directory), {
    sandbox: value.sandbox,
    session: value.session,
    profile: baselineProfile(await policyApi()),
    limits: LIMITS,
    scan: SCAN,
    order: { kind: "injected-first", name: "a-PX000001.ts" },
  });
  const weighted = await value.module.runCliContentSearchGoal(request(directory), {
    sandbox: value.sandbox,
    session: value.session,
    profile: namedProfile(await policyApi()),
    limits: LIMITS,
    scan: SCAN,
    order: { kind: "injected-first", name: "a-PX000001.ts" },
  });
  assert.deepEqual(inspectTransitions(zero), ["a-PX000001.ts", "b-PX000002.ts", "z-KX000001.ts"]);
  // After the forced slot 0 is consumed, the positive name-relation weight moves
  // the matching candidate ahead. cardinality=one then closes without inspecting
  // the remaining distractor, which is the observed reuse point.
  assert.deepEqual(inspectTransitions(weighted), ["a-PX000001.ts", "z-KX000001.ts"]);
  assert.equal(weighted.domain.deliberateSuboptimal, true);
});

test("R6 the runtime accepts only the explicit 10x31 contract and rejects retired 30/32 shapes", async () => {
  const module = await policyApi();
  const current = module.zeroCliCommandProfile();
  assert.equal(current.wires.length, 31);
  assert.equal(current.weights.flat().length, 310);
  assert.deepEqual(module.validateCliCommandProfile(current).wires, current.wires);

  const old30 = {
    ...current,
    wires: current.wires.filter(wire => wire !== "search.nameNeedleSegment"),
    weights: current.weights.map(row =>
      row.filter((_, index) => current.wires[index] !== "search.nameNeedleSegment")
        .map((_, index) => index + 1)),
  };
  assert.equal(old30.wires[29], "state.requiredConditionHolds*state.hasFreshEvidence");
  assert.throws(() => module.validateCliCommandProfile(old30), /migrateCliCommandProfileV10x30/);
  const migrated = module.migrateCliCommandProfileV10x30(old30);
  assert.equal(migrated.wires.length, 31);
  assert.equal(migrated.weights.flat().length, 310);
  for (let column = 0; column < 30; column += 1) {
    const wire = old30.wires[column];
    const migratedColumn = migrated.wires.indexOf(wire);
    for (let row = 0; row < 10; row += 1) {
      assert.equal(migrated.weights[row][migratedColumn], old30.weights[row][column], `${wire} copied by name`);
    }
  }
  for (const row of migrated.weights) assert.equal(row[migrated.wires.indexOf("search.nameNeedleSegment")], 0);

  const bad32 = {
    ...current,
    wires: [...current.wires, "search.nameNeedleSegment*observedFailure"],
    weights: current.weights.map(row => [...row, 0]),
  };
  assert.throws(() => module.validateCliCommandProfile(bad32), /32-wire|10x31/);
});
