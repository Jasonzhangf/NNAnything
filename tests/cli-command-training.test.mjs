import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const api = () => import("../dist/cli-goal.js");
const relation = () => import("../dist/filters/cli-entry-select-relation.js");
const execFileAsync = promisify(execFile);

const TEST_RELATION_WEIGHTS = Object.freeze([-2.217413902282715, 0.7973229289054871, 0.7973229289054871, 0.7973229289054871]);

async function makeTestEntrySelectProfiles() {
  const { validateEntrySelectProfile, zeroEntrySelectProfile } = await relation();
  return Object.freeze({
    directory: validateEntrySelectProfile({
      ...zeroEntrySelectProfile("directory"),
      weights: TEST_RELATION_WEIGHTS,
    }),
    regular: validateEntrySelectProfile({
      ...zeroEntrySelectProfile("regular"),
      weights: TEST_RELATION_WEIGHTS,
    }),
  });
}

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
    rows: [{ features: Array(38).fill(0), expectedHead: "pwd" }],
    handwiredRoot: "/backend/is/not/loaded/for/frozen/epochs",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.backendLoadMs, 0);
  assert.equal(frozen.timing.trainableParamCount, 494);
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
  assert.equal(fit.timing.trainableParamCount, 494);
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

test("R02 explicit 6x14 and 11x34 to 13x38 expansions copy all existing values by name and zero-fill the rest", async () => {
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
  assert.equal(typeof module.migrateCliCommandProfileV6, "function");
  assert.equal(typeof module.migrateCliCommandProfileStage1ToStage2, "function");
  const expanded = module.migrateCliCommandProfileV6(legacy);
  assert.deepEqual(expanded.heads, [
    "unsupported", "DEFER", "NOOP", "pwd", "cd", "ls",
    "path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect",
    "directory.select", "file.select",
  ]);
  assert.equal(expanded.wires.length, 38);
  assert.equal(expanded.weights.length, 13);
  assert.equal(expanded.weights.every(row => row.length === 38), true);
  assert.equal(expanded.weights.flat().length, 494);

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

  for (const head of ["path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect", "directory.select", "file.select"]) {
    const row = expanded.heads.indexOf(head);
    assert.deepEqual(expanded.weights[row], Array(38).fill(0));
  }
  for (const head of sixHeads) {
    const row = expanded.heads.indexOf(head);
    for (const wire of expanded.wires) {
      if (fourteenWires.includes(wire)) continue;
      assert.equal(expanded.weights[row][expanded.wires.indexOf(wire)], 0, `${head}/${wire} must be zero-filled`);
    }
  }

  // Also verify 11x34 -> 13x38 named migration preserves all 374 slots and zero-fills 120 new slots
  const stage1Heads = [
    "unsupported", "DEFER", "NOOP", "pwd", "cd", "ls",
    "path.resolve", "path.relative", "path.parts", "path.realpath", "entry.inspect",
  ];
  const stage1Wires = expanded.wires.filter(
    wire => !["predicate.select.entry", "selectorTargetType.unspecified", "selectorTargetType.regular", "selectorTargetType.directory"].includes(wire),
  );
  assert.equal(stage1Wires.length, 34);
  const p3ExactWeight = 2.9020536351949002;
  const stage1Profile = {
    contract: "cli.command-policy.v1",
    heads: stage1Heads,
    properties: expanded.properties,
    predicates: expanded.predicates.filter(p => p !== "predicate.select.entry"),
    wires: stage1Wires,
    weights: stage1Heads.map((head, r) =>
      stage1Wires.map((wire, c) =>
        head === "entry.inspect" && wire === "search.nameNeedleSegment"
          ? p3ExactWeight
          : r * 100 + c + 1,
      ),
    ),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  const stage2Migrated = module.migrateCliCommandProfileStage1ToStage2(stage1Profile);
  assert.equal(stage2Migrated.heads.length, 13);
  assert.equal(stage2Migrated.wires.length, 38);
  assert.equal(stage2Migrated.weights.flat().length, 494);
  const inspectRow = stage2Migrated.heads.indexOf("entry.inspect");
  const nameCol = stage2Migrated.wires.indexOf("search.nameNeedleSegment");
  assert.equal(stage2Migrated.weights[inspectRow][nameCol], p3ExactWeight);
  assert.equal(stage2Migrated.weights[inspectRow][nameCol] - p3ExactWeight, 0);
});

test("R24 public consumer reloads a 13x38 candidate in a new process and reports fitted=false", async () => {
  const module = await api();
  const entrySelectProfiles = await makeTestEntrySelectProfiles();
  const root = await mkdtemp(join(tmpdir(), "nn-command-reload-shape-"));
  try {
    const profile = module.zeroCliCommandProfile();
    assert.equal(profile.heads.length, 13);
    assert.equal(profile.wires.length, 38);
    assert.equal(profile.weights.length, 13);
    assert.equal(profile.weights.every(row => row.length === 38), true);

    const fixtureRoot = join(root, "fixture");
    await mkdir(fixtureRoot);
    const { dataset } = await module.makeCliCommandFixture({ root: fixtureRoot });
    const profilePath = join(root, "candidate.json");
    const datasetPath = join(root, "samples.json");
    const reportPath = join(root, "report.json");
    const bDirPath = join(root, "b-directory.json");
    const bFilePath = join(root, "b-file.json");
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n");
    await writeFile(datasetPath, JSON.stringify(dataset, null, 2) + "\n");
    await writeFile(reportPath, JSON.stringify({ profile }, null, 2) + "\n");
    await writeFile(bDirPath, JSON.stringify(entrySelectProfiles.directory, null, 2) + "\n");
    await writeFile(bFilePath, JSON.stringify(entrySelectProfiles.regular, null, 2) + "\n");

    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const reloadScript = join(repositoryRoot, "playground/cli/command-learning/reload.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        reloadScript,
        "--stage",
        "stage2-13x38",
        "--b-directory-profile",
        bDirPath,
        "--b-file-profile",
        bFilePath,
        profilePath,
        datasetPath,
        reportPath,
      ],
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

test("F3 training execution constructs the batch1, stage1, and stage2 typed goals and evaluates their real effects", async () => {
  const module = await api();
  const entrySelectProfiles = await makeTestEntrySelectProfiles();
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
      ["select-entry-dir-ready", "file.property.directory.entries", "directory.select", "achieved", 100],
      ["select-entry-file-ready", "file.property.directory.entries", "file.select", "achieved", 100],
      ["select-entry-dir-not-found", "file.property.directory.entries", "directory.select", "unmet", 0],
      ["select-entry-dir-satisfied-noop", "file.property.directory.entries", "NOOP", "achieved", 100],
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
        (binding, authority) => module.createCliCommandPolicy(binding, authority),
        evidencePath,
        { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
        { entrySelectProfiles },
      );
      assert.equal(result.transition.goal.kind, "file.property");
      assert.equal(result.transition.goal.property, property, `${sampleCase} must use its typed property`);
      if (sampleCase === "inspect-resolved-target" || sampleCase === "inspect-resolved-target-broken") {
        assert.equal(result.transition.goal.requirement.kind, "matches");
        assert.equal(result.transition.goal.requirement.predicate.kind, "resolvedTarget");
      } else if (sampleCase.startsWith("select-entry-")) {
        assert.equal(result.transition.goal.requirement.kind, "matches");
        assert.equal(result.transition.goal.requirement.predicate.kind, "entrySelector");
      } else {
        assert.equal(result.transition.goal.requirement.kind, "observed");
        assert.equal(result.transition.goal.requirement.freshness, "this_run");
      }
      if (head === "path.resolve" || head === "path.relative") {
        assert.equal(result.transition.goal.target.kind, "cli.path-query");
      } else if (head === "path.parts" || head === "path.realpath") {
        assert.equal(result.transition.goal.target.kind, "cli.path");
      } else if (sampleCase.startsWith("select-entry-")) {
        assert.equal(result.transition.goal.target.kind, "cli.directory");
      } else {
        assert.equal(result.transition.goal.target.kind, "cli.entry-query");
        assert.equal(typeof result.transition.goal.target.followSymlinks, "boolean");
      }
      assert.equal(result.selectedHead, head);
      assert.equal(result.status, expectedStatus);
      assert.equal(result.satisfaction, expectedSatisfaction);
      assert.equal(result.factsMatched, true, `${sampleCase} must match runtime PropertyFacts`);
      assert.equal(result.featuresMatched, true, `${sampleCase} must match 38-wire feature vector`);
      assert.equal(result.effectsOk, true, `${sampleCase} must pass its batch1/stage1/stage2 effect contract`);
      assert.equal(result.sideEffectsOk, true);
    }

    // Verify all 3 bound DEFER listing states (unobserved [0,0,0,1], stale_listing [0,1,0,1], stale_selected [0,1,1,1])
    const deferSamples = dataset.samples.filter(candidate => candidate.case === "select-entry-dir-unobserved");
    assert.equal(deferSamples.length, 12);
    assert.equal(deferSamples.filter(candidate => candidate.variant === "select-entry-dir-unobserved").length, 6);
    assert.equal(deferSamples.filter(candidate => candidate.variant === "select-entry-dir-unobserved-stale").length, 6);
    const seenFacts = new Set();
    for (const sample of deferSamples) {
      const scene = sceneById.get(sample.scenarioId);
      const profile = module.zeroCliCommandProfile();
      const deferRow = profile.heads.indexOf("DEFER");
      const witness = {
        ...profile,
        weights: profile.weights.map((weights, index) =>
          index === deferRow ? weights.map((weight, column) => column === 0 ? 10 : weight) : [...weights]),
      };
      const result = await module.executeCliCommandTrainingSample(
        sample,
        scene,
        witness,
        (binding, authority) => module.createCliCommandPolicy(binding, authority),
        evidencePath,
        { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
        { entrySelectProfiles },
      );
      assert.equal(result.selectedHead, "DEFER");
      assert.equal(result.factsMatched, true);
      assert.equal(result.featuresMatched, true);
      assert.equal(result.effectsOk, true);
      seenFacts.add(
        `[${result.actualFacts.hasFreshEvidence},${result.actualFacts.knownValue},${result.actualFacts.requiredConditionHolds},${result.actualFacts.hasDestinationRef}]`,
      );
    }
    assert.deepEqual([...seenFacts].sort(), ["[0,0,0,1]", "[0,1,0,1]", "[0,1,1,1]"]);

    // Verify missing entrySelectProfiles throws TypeError (no embedded fallback)
    const selectSample = dataset.samples.find(candidate => candidate.case === "select-entry-dir-ready");
    await assert.rejects(
      module.executeCliCommandTrainingSample(
        selectSample,
        sceneById.get(selectSample.scenarioId),
        module.zeroCliCommandProfile(),
        (binding, authority) => module.createCliCommandPolicy(binding, authority),
        evidencePath,
        { status: selectSample.expectedStatus, satisfaction: selectSample.expectedSatisfaction },
      ),
      TypeError,
    );
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

test("R1 executeCliCommandTrainingSample honors custom 1-argument and throwing factory callbacks without bypass", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-r1-factory-contract-"));
  try {
    const fixtureRoot = join(root, "fixture");
    await mkdir(fixtureRoot);
    const { dataset } = await module.makeCliCommandFixture({ root: fixtureRoot, extended: false, stage: "stage1-11x34" });
    const sample = dataset.samples.find(candidate => candidate.case === "cwd-observed");
    assert.ok(sample);
    const scene = dataset.scenarios.find(candidate => candidate.id === sample.scenarioId);
    assert.ok(scene);
    const evidencePath = join(root, "executions.jsonl");
    await writeFile(evidencePath, "");
    const baseStage2 = module.zeroCliCommandProfile();
    const stage1Wires = baseStage2.wires.filter(
      wire => !["predicate.select.entry", "selectorTargetType.unspecified", "selectorTargetType.regular", "selectorTargetType.directory"].includes(wire),
    );
    const baseProfile = module.validateCliCommandProfile({
      contract: "cli.command-policy.v1",
      heads: baseStage2.heads.filter(head => head !== "directory.select" && head !== "file.select"),
      properties: baseStage2.properties,
      predicates: baseStage2.predicates.filter(pred => pred !== "predicate.select.entry"),
      wires: stage1Wires,
      weights: Array.from({ length: 11 }, () => Array(34).fill(0)),
      calibration: "uncalibrated",
      adoption: "not_applied",
    }, "stage1-11x34");
    const pwdIdx = baseProfile.heads.indexOf("pwd");
    const profile = {
      ...baseProfile,
      weights: baseProfile.weights.map((row, index) => (index === pwdIdx ? row.map((v, col) => (col === 0 ? 10 : v)) : [...row])),
    };

    let oneArgFactoryCalls = 0;
    const oneArgFactory = binding => {
      oneArgFactoryCalls += 1;
      return module.createCliCommandPolicy(binding);
    };
    assert.equal(oneArgFactory.length, 1);
    const row = await module.executeCliCommandTrainingSample(
      sample,
      scene,
      profile,
      oneArgFactory,
      evidencePath,
      { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
      { stage: "stage1-11x34" },
    );
    assert.equal(oneArgFactoryCalls, 2);
    assert.equal(row.selectedHead, "pwd");
    assert.equal(row.effectsOk, true);
    assert.equal(typeof row.setupWallTimeMs, "number");
    assert.equal(typeof row.candidateStepWallTimeMs, "number");
    assert.equal(typeof row.totalWallTimeMs, "number");

    const throwingFactory = _binding => {
      throw new Error("custom_factory_sentinel_error");
    };
    await assert.rejects(
      module.executeCliCommandTrainingSample(
        sample,
        scene,
        profile,
        throwingFactory,
        evidencePath,
        { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
        { stage: "stage1-11x34" },
      ),
      /custom_factory_sentinel_error/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R2 stage1-11x34 and stage2-13x38 fixture and dataset preparation enforce 310/34-wire vs 370 (358+12)/38-wire contracts", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-r2-stage-routing-"));
  try {
    const stage1Root = join(root, "stage1");
    const stage2Root = join(root, "stage2");
    await mkdir(stage1Root);
    await mkdir(stage2Root);

    const stage1Fixture = await module.makeCliCommandFixture({ root: stage1Root, extended: true, stage: "stage1-11x34" });
    assert.equal(stage1Fixture.dataset.samples.length, 310);
    assert.equal(stage1Fixture.dataset.samples.some(sample => sample.case.startsWith("select-entry-")), false);
    const preparedStage1 = module.prepareCliCommandDataset(stage1Fixture.dataset, ["train", "development"], "stage1-11x34");
    assert.equal(preparedStage1.samples.length, 310);
    assert.equal(preparedStage1.train.length + preparedStage1.development.length, 310);
    assert.equal(
      preparedStage1.samples.every(sample => module.sampleFeatures(sample, preparedStage1.scenes.get(sample.scenarioId), "stage1-11x34").length === 34),
      true,
    );

    const stage2Fixture = await module.makeCliCommandFixture({ root: stage2Root, extended: true, stage: "stage2-13x38" });
    assert.equal(stage2Fixture.dataset.samples.length, 370);
    assert.equal(stage2Fixture.dataset.samples.filter(sample => !sample.id.endsWith("-unobserved-stale")).length, 358);
    assert.equal(stage2Fixture.dataset.samples.filter(sample => sample.id.endsWith("-unobserved-stale")).length, 12);
    assert.equal(stage2Fixture.dataset.samples.filter(sample => sample.case.startsWith("select-entry-")).length, 60);
    const preparedStage2 = module.prepareCliCommandDataset(stage2Fixture.dataset, ["train", "development"], "stage2-13x38");
    assert.equal(preparedStage2.samples.length, 370);
    assert.equal(preparedStage2.train.length, 246);
    assert.equal(preparedStage2.development.length, 124);
    assert.equal(preparedStage2.train.filter(sample => !sample.id.endsWith("-unobserved-stale")).length, 238);
    assert.equal(preparedStage2.development.filter(sample => !sample.id.endsWith("-unobserved-stale")).length, 120);
    assert.equal(preparedStage2.train.filter(sample => sample.id.endsWith("-unobserved-stale")).length, 8);
    assert.equal(preparedStage2.development.filter(sample => sample.id.endsWith("-unobserved-stale")).length, 4);
    assert.equal(preparedStage2.train.length + preparedStage2.development.length, 370);
    assert.equal(
      preparedStage2.samples.every(sample => module.sampleFeatures(sample, preparedStage2.scenes.get(sample.scenarioId), "stage2-13x38").length === 38),
      true,
    );

    assert.throws(
      () => module.prepareCliCommandDataset(stage2Fixture.dataset, ["train", "development"], "stage1-11x34"),
      /Stage 1 dataset must not contain Stage 2 entry.select samples/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R3 public runCliCommandTraining 8N8E workflow executes Stage 2 entry.select with epochs=0 and zero fitting", async () => {
  const module = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-r3-public-8n8e-zero-epoch-"));
  try {
    const fixtureRoot = join(root, "fixture");
    const outputRoot = join(root, "output");
    await mkdir(fixtureRoot);
    await mkdir(outputRoot);
    const { dataset } = await module.makeCliCommandFixture({ root: fixtureRoot, extended: true, stage: "stage2-13x38" });
    const stage2SelectSubset = {
      ...dataset,
      samples: dataset.samples.filter(sample =>
        sample.case === "select-entry-dir-ready" || sample.case === "select-entry-file-ready",
      ),
    };
    assert.equal(stage2SelectSubset.samples.length, 12);

    const entrySelectProfiles = await makeTestEntrySelectProfiles();

    const base = module.zeroCliCommandProfile();
    const weights = base.weights.map(row => [...row]);
    weights[11][28] = -4;
    weights[11][29] = -10;
    weights[11][30] = -10;
    weights[11][31] = 4;
    weights[11][32] = 4;
    weights[11][35] = 2;
    weights[11][37] = -6;
    weights[12][28] = -4;
    weights[12][29] = -10;
    weights[12][30] = 4;
    weights[12][31] = -10;
    weights[12][32] = 4;
    weights[12][35] = 2;
    weights[12][37] = -6;
    const witnessProfile = module.validateCliCommandProfile({
      ...base,
      weights: weights.map(row => Object.freeze(row)),
    }, "stage2-13x38");

    const receipt = await module.runCliCommandTraining({
      dataset: stage2SelectSubset,
      initial: witnessProfile,
      initialSource: null,
      epochs: 0,
      learningRate: 0.1,
      stage: "stage2-13x38",
      entrySelectProfiles,
    }, {
      handwiredRoot: root,
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
      entrySelectProfiles,
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.fullyVerified, false);
    assert.equal(receipt.timing.completedEpochs, 0);
    assert.equal(receipt.timing.gradientRowEpochs, 0);
    assert.equal(receipt.timing.totalRowPasses, 0);
    assert.equal(receipt.timing.backendLoadMs, 0);
    assert.equal(receipt.timing.circuitBuildMs, 0);
    assert.equal(receipt.timing.trainEpochGradMs, 0);
    assert.equal(receipt.comparison.train.count, 8);
    assert.equal(receipt.comparison.train.correct, 8);
    assert.equal(receipt.comparison.development.count, 4);
    assert.equal(receipt.comparison.development.correct, 4);
    assert.equal(typeof receipt.timing.perHeadSetupWallTimeMs["directory.select"], "number");
    assert.equal(typeof receipt.timing.perHeadCandidateStepWallTimeMs["file.select"], "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
