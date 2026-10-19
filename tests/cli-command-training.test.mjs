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
    targetPath: "start",
    expectedEntries: [],
    recipe: {
      scenarioId: id,
      entries: [{ path: "start", kind: "directory" }],
      sessions: [{
        id: "s",
        cwd: "start",
        grantedEffects: ["filesystem.read", "process.exec", "session.write"],
      }],
    },
  };
}

function verificationFromPrimary(dataset, originPartition) {
  const scenarios = dataset.scenarios.filter(scene => scene.partition === originPartition);
  const scenarioIds = new Map(scenarios.map(scene => [scene.id, `verification-${scene.id}`]));
  return {
    version: 1,
    scenarios: scenarios.map(scene => ({
      ...structuredClone(scene),
      id: scenarioIds.get(scene.id),
      partition: "verification",
      recipe: { ...structuredClone(scene.recipe), scenarioId: scenarioIds.get(scene.id) },
    })),
    samples: dataset.samples.filter(sample => sample.partition === originPartition).map(sample => ({
      ...structuredClone(sample),
      id: `verification-${sample.id}`,
      scenarioId: scenarioIds.get(sample.scenarioId),
      partition: "verification",
    })),
  };
}

function disjointVerificationDataset() {
  const scenarioId = "verification-independent-directory";
  const sourceGroup = "verification-independent-family";
  const goals = [
    ["observe_cwd", "pwd"],
    ["set_cwd", "cd"],
    ["list_directory", "ls"],
    ["unsupported_operation", "unsupported"],
  ];
  return {
    version: 1,
    scenarios: [{
      id: scenarioId,
      sourceGroup,
      partition: "verification",
      targetPath: "target",
      expectedEntries: [
        { name: "record.txt", type: "file" },
        { name: "nested", type: "directory" },
      ],
      recipe: {
        scenarioId,
        entries: [
          { path: "start", kind: "directory" },
          { path: "target", kind: "directory" },
          { path: "target/record.txt", kind: "file", contents: "independent verification bytes" },
          { path: "target/nested", kind: "directory" },
        ],
        sessions: [
          { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] },
          { id: "other", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] },
        ],
      },
    }],
    samples: goals.map(([goalKind, expectedHead], index) => ({
      id: `verification-independent-${index}`,
      scenarioId,
      sourceGroup,
      partition: "verification",
      goalKind,
      expectedHead,
    })),
  };
}

test("shared prepare rejects scenario source groups that cross partitions", async () => {
  const { prepareCliCommandDataset } = await api();
  const dataset = {
    version: 1,
    scenarios: [
      scenario("train-scene", "train", "shared-source"),
      scenario("development-scene", "development", "shared-source"),
    ],
    samples: [],
  };
  assert.throws(
    () => prepareCliCommandDataset(dataset, ["pwd", "cd", "ls"]),
    /Source group crosses partitions/,
  );
});

test("shared prepare rejects retired binary labels that conflict with semantic goals", async () => {
  const { prepareCliCommandDataset } = await api();
  const dataset = {
    version: 1,
    scenarios: [scenario("train-scene", "train")],
    samples: [{
      id: "legacy-cd-reject",
      scenarioId: "train-scene",
      sourceGroup: "train-scene",
      partition: "train",
      goalKind: "observe_cwd",
      expectedHead: "cd",
    }],
  };
  assert.throws(
    () => prepareCliCommandDataset(dataset, ["pwd", "cd", "ls"]),
    /Legacy binary labels conflict with shared semantic teacher/,
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
      const outcome = await library.runCliCommandTraining({
        dataset,
        commands: ["pwd", "cd", "ls"],
        initial: library.zeroCliCommandProfile([]),
        initialSource: null,
        epochs: 200,
        learningRate: 0.1,
      }, {
        handwiredRoot: process.env.NN_HANDWIRED_ROOT,
        outputRoot,
        grantedEffects: ["filesystem.read", "filesystem.write"],
        verification,
      }).then(receipt => ({ receipt }), error => ({ error }));
      if (!("error" in outcome)) {
        assert.fail(`overlapping ${originPartition} sources were certified: fullyVerified=${outcome.receipt.fullyVerified}`);
      }
      assert.match(outcome.error.message, /Verification source group overlaps primary train\/development sources/);
      assert.deepEqual(outcome.error.partialPaths, {});
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
    const outputRoot = join(root, "results");
    await mkdir(outputRoot);
    const receipt = await library.runCliCommandTraining({
      dataset,
      commands: ["pwd", "cd", "ls"],
      initial: library.zeroCliCommandProfile([]),
      initialSource: null,
      epochs: 200,
      learningRate: 0.1,
    }, {
      handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
      verification: disjointVerificationDataset(),
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.verification.status, "evaluated");
    assert.equal(receipt.verification.evaluation.count, 4);
    assert.deepEqual(receipt.verification.evaluation.rows.map(row => row.sourceGroup),
      Array(4).fill("verification-independent-family"));
    assert.equal(receipt.verification.evaluation.passed, true);
    assert.equal(receipt.fullyVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen named expansion preserves prior weights and does not reset the profile", async () => {
  const { fitCliCommandProfile, zeroCliCommandProfile } = await api();
  const initial = {
    ...zeroCliCommandProfile(["pwd"]),
    weights: [[1, 2], [3, 4]],
  };
  const frozen = await fitCliCommandProfile({
    initial,
    commands: ["pwd", "cd", "ls"],
    rows: [{ goal: { kind: "observe_cwd", session: "s" }, expectedHead: "pwd" }],
    handwiredRoot: "/backend/is/not/loaded/for/frozen/epochs",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozen.profile.heads, ["unsupported", "pwd", "cd", "ls"]);
  assert.deepEqual(frozen.profile.weights, [
    [1, 2, 0, 0],
    [3, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(frozen.profile, frozen.initialProfile);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.backendLoadMs, 0);
});

test("real Handwired fit changes shared parameters and reports training work", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const { fitCliCommandProfile, predictCliCommand, zeroCliCommandProfile } = await api();
  const rows = [
    { goal: { kind: "observe_cwd", session: "s" }, expectedHead: "pwd" },
    { goal: { kind: "observe_cwd", session: "s" }, expectedHead: "pwd" },
    { goal: { kind: "unsupported_operation", session: "s" }, expectedHead: "unsupported" },
    { goal: { kind: "unsupported_operation", session: "s" }, expectedHead: "unsupported" },
  ];
  const initial = zeroCliCommandProfile(["pwd"]);
  const fit = await fitCliCommandProfile({
    initial,
    commands: ["pwd"],
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
  assert.equal(fit.timing.trainableParamCount, 4);
  assert.ok(fit.timing.fitTotalMs >= 0);
  for (const row of rows) {
    assert.equal(predictCliCommand(row.goal, fit.profile).selectedHead, row.expectedHead);
  }
});

test("missing Handwired backend fails explicitly and retains zero completed epochs", async () => {
  const { fitCliCommandProfile, zeroCliCommandProfile } = await api();
  await assert.rejects(
    fitCliCommandProfile({
      initial: zeroCliCommandProfile(["pwd"]),
      commands: ["pwd"],
      rows: [{ goal: { kind: "observe_cwd", session: "s" }, expectedHead: "pwd" }],
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
