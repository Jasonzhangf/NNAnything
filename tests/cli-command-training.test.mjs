import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const api = () => import("../dist/cli-goal.js");
const execFileAsync = promisify(execFile);

function scenario(id, partition, sourceGroup = id) {
  return {
    id,
    sourceGroup,
    partition,
    startPath: "start",
    targetPath: "target",
    expectedEntries: [],
    recipe: {
      scenarioId: id,
      entries: [{ path: "start", kind: "directory" }, { path: "target", kind: "directory" }],
      sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] }],
    },
  };
}

function verificationFromPrimary(dataset, originPartition) {
  const selected = dataset.scenarios.filter(scene => scene.partition === originPartition);
  const ids = new Map(selected.map(scene => [scene.id, `verification-${scene.id}`]));
  return {
    version: 2,
    scenarios: selected.map(scene => ({
      ...structuredClone(scene),
      id: ids.get(scene.id),
      partition: "verification",
      recipe: { ...structuredClone(scene.recipe), scenarioId: ids.get(scene.id) },
    })),
    samples: dataset.samples.filter(sample => sample.partition === originPartition).map(sample => ({
      ...structuredClone(sample),
      id: `verification-${sample.id}`,
      scenarioId: ids.get(sample.scenarioId),
      partition: "verification",
    })),
  };
}

function disjointVerificationDataset(dataset) {
  const scene = dataset.scenarios.find(candidate => candidate.startPath !== candidate.targetPath);
  assert.ok(scene);
  const id = "verification-independent-directory";
  return {
    version: 2,
    scenarios: [{
      ...structuredClone(scene),
      id,
      sourceGroup: "verification-independent-family",
      partition: "verification",
      recipe: { ...structuredClone(scene.recipe), scenarioId: id },
    }],
    samples: dataset.samples.filter(sample => sample.scenarioId === scene.id).map(sample => ({
      ...structuredClone(sample),
      id: `verification-${sample.id}`,
      scenarioId: id,
      sourceGroup: "verification-independent-family",
      partition: "verification",
    })),
  };
}

function typedRows(apiModule) {
  const session = { kind: "cli.session", scenarioId: "fit", sessionId: "s" };
  const observed = {
    goal: {
      kind: "file.property",
      property: "file.property.relation.sessionCwd",
      target: { kind: "cli.file-query", relation: "sessionCwd", session },
      requirement: { kind: "observed", freshness: "this_run" },
    },
    facts: { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
    expectedHead: "pwd",
  };
  const unsupported = {
    goal: {
      kind: "file.property",
      property: "file.property.exists",
      target: { kind: "cli.directory", scenarioId: "fit", sessionId: "s", path: "." },
      requirement: { kind: "equals", expected: true },
    },
    facts: { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
    expectedHead: "unsupported",
  };
  return [observed, observed, unsupported, unsupported].map(row => ({
    ...row,
    features: apiModule.cliCommandFeatures(row.goal, row.facts),
  }));
}

test("shared prepare rejects scenario source groups that cross partitions", async () => {
  const { prepareCliCommandDataset } = await api();
  const dataset = {
    version: 2,
    scenarios: [
      scenario("train-scene", "train", "shared-source"),
      scenario("development-scene", "development", "shared-source"),
    ],
    samples: [],
  };
  assert.throws(
    () => prepareCliCommandDataset(dataset, ["train", "development"]),
    /Source group crosses partitions/,
  );
});

test("shared prepare rejects sample expectations outside the registered case contract", async () => {
  const { prepareCliCommandDataset } = await api();
  const dataset = {
    version: 2,
    scenarios: [scenario("train-scene", "train")],
    samples: [{
      id: "conflicting-teacher",
      scenarioId: "train-scene",
      sourceGroup: "train-scene",
      partition: "train",
      case: "cwd-observed",
      expectedHead: "cd",
      expectedStatus: "achieved",
      expectedSatisfaction: 100,
    }],
  };
  assert.throws(
    () => prepareCliCommandDataset(dataset, ["train", "development"]),
    /expectation conflicts/,
  );
});

test("optional verification rejects primary train or development source groups before fitting", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const library = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-verification-overlap-"));
  try {
    const { dataset } = await library.makeCliCommandFixture({ root });
    for (const originPartition of ["train", "development"]) {
      const outputRoot = join(root, `overlap-${originPartition}`);
      await mkdir(outputRoot);
      const verification = verificationFromPrimary(dataset, originPartition);
      assert.ok(verification.samples.length > 0);
      await assert.rejects(library.runCliCommandTraining({
        dataset,
        initial: library.zeroCliCommandProfile(),
        initialSource: null,
        epochs: 200,
        learningRate: 0.1,
      }, {
        handwiredRoot: process.env.NN_HANDWIRED_ROOT,
        outputRoot,
        grantedEffects: ["filesystem.read", "filesystem.write"],
        verification,
      }), error => /Verification source group overlaps primary train\/development sources/.test(error.message)
        && Object.keys(error.partialPaths ?? {}).length === 0);
      assert.deepEqual(await readdir(outputRoot), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional verification with disjoint source groups evaluates and fully verifies", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const library = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-verification-independent-"));
  try {
    const { dataset } = await library.makeCliCommandFixture({ root });
    const verification = disjointVerificationDataset(dataset);
    const outputRoot = join(root, "results");
    await mkdir(outputRoot);
    const receipt = await library.runCliCommandTraining({
      dataset,
      initial: library.zeroCliCommandProfile(),
      initialSource: null,
      epochs: 200,
      learningRate: 0.1,
    }, {
      handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
      verification,
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.verification.status, "evaluated");
    assert.equal(receipt.verification.evaluation.count, verification.samples.length);
    assert.deepEqual(receipt.verification.evaluation.rows.map(row => row.sourceGroup),
      Array(verification.samples.length).fill("verification-independent-family"));
    assert.equal(receipt.verification.evaluation.passed, true);
    assert.equal(receipt.fullyVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-epoch fit preserves the explicit named migration", async () => {
  const { fitCliCommandProfile, migrateLegacyCliCommandProfile } = await api();
  const initial = migrateLegacyCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: ["unsupported", "pwd", "cd", "ls"],
    wires: ["bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory"],
    weights: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]],
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
  const frozen = await fitCliCommandProfile({
    initial,
    rows: [{ features: Array(30).fill(0), expectedHead: "pwd" }],
    handwiredRoot: "/backend/is/not/loaded/for/frozen/epochs",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.backendLoadMs, 0);
  assert.equal(frozen.timing.trainableParamCount, 300);
});

test("real Handwired fit changes shared parameters and reports training work", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const library = await api();
  const { fitCliCommandProfile, predictCliCommand, zeroCliCommandProfile } = library;
  const rows = typedRows(library);
  const initial = zeroCliCommandProfile();
  const fit = await fitCliCommandProfile({
    initial,
    rows,
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    epochs: 20,
    learningRate: 0.1,
  });
  assert.notDeepEqual(fit.profile.weights, initial.weights);
  assert.equal(fit.timing.completedEpochs, 20);
  assert.equal(fit.timing.processedRowCount, rows.length);
  assert.equal(fit.timing.gradientRowEpochs, 20 * rows.length);
  assert.equal(fit.timing.totalRowPasses, 20 * rows.length);
  assert.equal(fit.timing.trainableParamCount, 300);
  assert.ok(fit.timing.fitTotalMs >= 0);
  for (const row of rows) {
    assert.equal(predictCliCommand(row.goal, row.facts, fit.profile).selectedHead, row.expectedHead);
  }
});

test("missing Handwired backend fails explicitly and retains zero completed epochs", async () => {
  const library = await api();
  const { fitCliCommandProfile, zeroCliCommandProfile } = library;
  const rows = typedRows(library);
  await assert.rejects(
    fitCliCommandProfile({
      initial: zeroCliCommandProfile(),
      rows,
      handwiredRoot: join(tmpdir(), `nn-missing-handwired-${process.pid}-${Date.now()}`),
      epochs: 1,
      learningRate: 0.1,
    }),
    error => /Handwired core is missing/.test(error.message)
      && error.timing?.completedEpochs === 0
      && error.timing?.gradientRowEpochs === 0
      && error.timing?.fitTotalMs >= 0,
  );
});

test("R02 explicit 6x14 to 10x30 expansion copies all 84 existing values by name and zero-fills the rest", async () => {
  const module = await api();
  const sixHeads = ["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"];
  const fourteenWires = [
    "bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory",
    "property.directory.entries", "property.relation.sessionCwd",
    "predicate.observe.sessionCwd", "predicate.equals.sessionCwd", "predicate.observe.entries",
    "state.hasFreshEvidence", "state.knownValue", "state.requiredConditionHolds",
    "state.hasDestinationRef", "state.requiredConditionHolds*state.hasFreshEvidence",
  ];
  const legacy = {
    contract: "cli.command-policy.v1",
    heads: sixHeads,
    properties: ["property.directory.entries", "property.relation.sessionCwd"],
    predicates: ["predicate.observe.sessionCwd", "predicate.equals.sessionCwd", "predicate.observe.entries"],
    wires: fourteenWires,
    weights: sixHeads.map((_, row) => fourteenWires.map((__, column) => row * 100 + column + 1)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  assert.equal(
    typeof module.migrateCliCommandProfileV6,
    "function",
    "R02 needs the public explicit 6x14 -> 10x30 expansion tool migrateCliCommandProfileV6(profile6x14)",
  );
  const expanded = module.migrateCliCommandProfileV6(legacy);
  assert.deepEqual(expanded.heads, [
    "unsupported", "DEFER", "NOOP", "pwd", "cd", "ls",
    "path.resolve", "path.relative", "path.parts", "entry.inspect",
  ]);
  assert.equal(expanded.wires.length, 30);
  assert.equal(expanded.weights.length, 10);
  assert.equal(expanded.weights.every(row => row.length === 30), true);
  assert.equal(expanded.weights.flat().length, 300);

  let copied = 0;
  for (const [legacyRow, head] of sixHeads.entries()) {
    const row = expanded.heads.indexOf(head);
    assert.notEqual(row, -1);
    for (const [legacyColumn, wire] of fourteenWires.entries()) {
      const column = expanded.wires.indexOf(wire);
      assert.notEqual(column, -1);
      assert.equal(expanded.weights[row][column], legacy.weights[legacyRow][legacyColumn], `${head}/${wire} changed by name`);
      copied += 1;
    }
  }
  assert.equal(copied, 84);

  for (const head of ["path.resolve", "path.relative", "path.parts", "entry.inspect"]) {
    const row = expanded.heads.indexOf(head);
    assert.deepEqual(expanded.weights[row], Array(30).fill(0));
  }
  for (const head of sixHeads) {
    const row = expanded.heads.indexOf(head);
    for (const wire of expanded.wires) {
      if (fourteenWires.includes(wire)) continue;
      assert.equal(expanded.weights[row][expanded.wires.indexOf(wire)], 0, `${head}/${wire} must be zero-filled`);
    }
  }
});

test("R24 public consumer reloads a 10x30 candidate in a new process and reports fitted=false", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-command-reload-shape-"));
  try {
    const profile = module.zeroCliCommandProfile();
    assert.equal(profile.heads.length, 10);
    assert.equal(profile.wires.length, 30);
    assert.equal(profile.weights.length, 10);
    assert.equal(profile.weights.every(row => row.length === 30), true);

    const fixtureRoot = join(root, "fixture");
    await mkdir(fixtureRoot);
    const { dataset } = await module.makeCliCommandFixture({ root: fixtureRoot });
    const profilePath = join(root, "candidate.json");
    const datasetPath = join(root, "samples.json");
    const reportPath = join(root, "report.json");
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n");
    await writeFile(datasetPath, JSON.stringify(dataset, null, 2) + "\n");
    await writeFile(reportPath, JSON.stringify({ profile }, null, 2) + "\n");

    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const reloadScript = join(repositoryRoot, "playground/cli/command-learning/reload.mjs");
    const { stdout } = await execFileAsync(process.execPath, [reloadScript, profilePath, datasetPath, reportPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.fitted, false);
    assert.equal(receipt.checked, dataset.samples.length);
    assert.equal(typeof receipt.processId, "number");
    assert.notEqual(receipt.processId, process.pid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
