import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    version: 3,
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
    version: 3,
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
    rows: [{ features: Array(34).fill(0), expectedHead: "pwd" }],
    handwiredRoot: "/backend/is/not/loaded/for/frozen/epochs",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.backendLoadMs, 0);
  assert.equal(frozen.timing.trainableParamCount, 374);
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
  assert.equal(fit.timing.trainableParamCount, 374);
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

test("R02 explicit 6x14 to 11x34 expansion copies all 84 existing values by name and zero-fills the rest", async () => {
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
    "R02 needs the public explicit 6x14 -> 11x34 expansion tool migrateCliCommandProfileV6(profile6x14)",
  );
  const expanded = module.migrateCliCommandProfileV6(legacy);
  assert.deepEqual(expanded.heads, [
    "unsupported", "DEFER", "NOOP", "pwd", "cd", "ls",
    "path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect",
  ]);
  assert.equal(expanded.wires.length, 34);
  assert.equal(expanded.weights.length, 11);
  assert.equal(expanded.weights.every(row => row.length === 34), true);
  assert.equal(expanded.weights.flat().length, 374);

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

  for (const head of ["path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect"]) {
    const row = expanded.heads.indexOf(head);
    assert.deepEqual(expanded.weights[row], Array(34).fill(0));
  }
  for (const head of sixHeads) {
    const row = expanded.heads.indexOf(head);
    for (const wire of expanded.wires) {
      if (fourteenWires.includes(wire)) continue;
      assert.equal(expanded.weights[row][expanded.wires.indexOf(wire)], 0, `${head}/${wire} must be zero-filled`);
    }
  }
});

test("R24 public consumer reloads a 11x34 candidate in a new process and reports fitted=false", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-command-reload-shape-"));
  try {
    const profile = module.zeroCliCommandProfile();
    assert.equal(profile.heads.length, 11);
    assert.equal(profile.wires.length, 34);
    assert.equal(profile.weights.length, 11);
    assert.equal(profile.weights.every(row => row.length === 34), true);

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
    const { stdout } = await execFileAsync(
      process.execPath,
      [reloadScript, "--stage", "stage1-11x34", profilePath, datasetPath, reportPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.fitted, false);
    assert.equal(receipt.checked, dataset.samples.length);
    assert.equal(receipt.executed, dataset.samples.length);
    assert.equal(receipt.executedLegacy, dataset.samples.filter(sample => !module.isBatch1CommandCase(sample.case)).length);
    assert.equal(receipt.executedBatch1, dataset.samples.filter(sample => module.isBatch1CommandCase(sample.case)).length);
    assert.equal(receipt.unverified, 0);
    assert.equal(receipt.skippedExecution, undefined);
    assert.equal(receipt.skippedBatch1, undefined);
    assert.equal(typeof receipt.processId, "number");
    assert.notEqual(receipt.processId, process.pid);
    assert.equal(receipt.paths.executions, join(root, "reload-executions.jsonl"));
    assert.equal(receipt.paths.rows, join(root, "reload-rows.json"));
    const executionsText = await readFile(receipt.paths.executions, "utf8");
    const executionLines = executionsText.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(
      executionLines.filter(line => line.kind === "execution" || line.kind === "execution_error").length,
      dataset.samples.length,
    );
    assert.equal(executionLines.filter(line => line.kind === "cleanup" && line.status === "removed").length, dataset.samples.length);
    const savedRows = JSON.parse(await readFile(receipt.paths.rows, "utf8"));
    assert.equal(savedRows.rows.length, dataset.samples.length);
    assert.equal(savedRows.checked, dataset.samples.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F3 training execution constructs the batch1 and stage1 typed goals and evaluates their real effects", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-batch1-training-execution-"));
  try {
    const fixtureRoot = join(root, "fixture");
    await mkdir(fixtureRoot);
    const { dataset } = await module.makeCliCommandFixture({ root: fixtureRoot, extended: true });
    const sceneById = new Map(dataset.scenarios.map(scene => [scene.id, scene]));
    const evidencePath = join(root, "executions.jsonl");
    await writeFile(evidencePath, "");
    const cases = [
      ["path-resolve", "file.property.path.absolute", "path.resolve", "achieved", 100],
      ["path-relative", "file.property.path.relative", "path.relative", "achieved", 100],
      ["path-parts-name", "file.property.path.name", "path.parts", "achieved", 100],
      ["path-realpath", "file.property.path.physical", "path.realpath", "achieved", 100],
      ["inspect-size", "file.property.size", "entry.inspect", "achieved", 100],
      ["inspect-resolved-target", "file.property.link.target", "entry.inspect", "achieved", 100],
      ["inspect-resolved-target-broken", "file.property.link.target", "entry.inspect", "unmet", 0],
    ];
    for (const [sampleCase, property, head, expectedStatus, expectedSatisfaction] of cases) {
      const sample = dataset.samples.find(candidate => candidate.case === sampleCase);
      assert.ok(sample, `missing ${sampleCase} sample`);
      const scene = sceneById.get(sample.scenarioId);
      assert.ok(scene);
      const profile = module.zeroCliCommandProfile();
      const row = profile.heads.indexOf(head);
      assert.notEqual(row, -1);
      const witness = {
        ...profile,
        weights: profile.weights.map((weights, index) =>
          index === row ? weights.map((weight, column) => column === 0 ? 10 : weight) : [...weights]),
      };
      const result = await module.executeCliCommandTrainingSample(
        sample,
        scene,
        witness,
        binding => module.createCliCommandPolicy(binding),
        evidencePath,
        { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
      );
      assert.equal(result.transition.goal.kind, "file.property");
      assert.equal(result.transition.goal.property, property, `${sampleCase} must use its typed property`);
      if (sampleCase === "inspect-resolved-target" || sampleCase === "inspect-resolved-target-broken") {
        assert.equal(result.transition.goal.requirement.kind, "matches");
        assert.equal(result.transition.goal.requirement.predicate.kind, "resolvedTarget");
      } else {
        assert.equal(result.transition.goal.requirement.kind, "observed");
        assert.equal(result.transition.goal.requirement.freshness, "this_run");
      }
      if (head === "path.resolve" || head === "path.relative") {
        assert.equal(result.transition.goal.target.kind, "cli.path-query");
      } else if (head === "path.parts" || head === "path.realpath") {
        assert.equal(result.transition.goal.target.kind, "cli.path");
      } else {
        assert.equal(result.transition.goal.target.kind, "cli.entry-query");
        assert.equal(typeof result.transition.goal.target.followSymlinks, "boolean");
      }
      assert.equal(result.selectedHead, head);
      assert.equal(result.status, expectedStatus);
      assert.equal(result.satisfaction, expectedSatisfaction);
      assert.equal(result.effectsOk, true, `${sampleCase} must pass its batch1/stage1 effect contract`);
      assert.equal(result.sideEffectsOk, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-gradient inherited parameters preserve exact IEEE-754 float64 value without Math.fround rounding drift", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const library = await api();
  const { fitCliCommandProfile, zeroCliCommandProfile } = library;
  const rows = typedRows(library);
  const base = zeroCliCommandProfile();
  const headIdx = base.heads.indexOf("entry.inspect");
  const wireIdx = base.wires.indexOf("search.nameNeedleSegment");
  assert.notEqual(headIdx, -1);
  assert.notEqual(wireIdx, -1);

  const exactInheritedValue = 2.9020536351949002;
  assert.notEqual(Math.fround(exactInheritedValue), exactInheritedValue);

  const initial = {
    ...base,
    weights: base.weights.map((row, r) =>
      row.map((val, c) => (r === headIdx && c === wireIdx ? exactInheritedValue : val)),
    ),
  };

  const fit = await fitCliCommandProfile({
    initial,
    rows,
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    epochs: 5,
    learningRate: 0.1,
  });

  const fittedValue = fit.profile.weights[headIdx][wireIdx];
  assert.equal(
    fittedValue,
    exactInheritedValue,
    `zero-gradient inherited parameter must remain exact (${exactInheritedValue}), got ${fittedValue} (delta=${fittedValue - exactInheritedValue})`,
  );
  assert.equal(fittedValue - exactInheritedValue, 0);
});
