import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const api = () => import("../dist/cli-goal.js");

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
    rows: [{ features: Array(14).fill(0), expectedHead: "pwd" }],
    handwiredRoot: "/backend/is/not/loaded/for/frozen/epochs",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.backendLoadMs, 0);
  assert.equal(frozen.timing.trainableParamCount, 84);
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
  assert.equal(fit.timing.trainableParamCount, 84);
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
