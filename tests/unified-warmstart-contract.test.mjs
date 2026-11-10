import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cloneTensors, createXavierTensors } from "../dist/training/unified-forward.js";
import {
  checkWarmStartEpochZeroEquality,
  runUnifiedTraining,
} from "../dist/training/unified-train-config.js";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";

const here = new URL(".", import.meta.url);
const thresholdsPath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);
const missingModeTablePath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/missing-mode-table.json",
);

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path, rows) {
  return writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertMissing(path) {
  await assert.rejects(access(path), error => error.code === "ENOENT");
}

function vector(pattern, salt = 0) {
  return Array.from({ length: 64 }, (_, index) => (index % pattern) + salt);
}

function studentRow(groupId, candidateRef, x) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: groupId,
    sampleId: "sample-1",
    requestRef: "request-1",
    stepId: "step-1",
    targetRef: "target-1",
    pendingRelationRef: null,
    sourceGroup: "tests",
    language: "ts",
    adapterRef: "test-adapter",
    derivationFamily: "test-family",
    semanticStratum: "module_export",
    stepContextRef: `ctx:${groupId}`,
    candidateGroupRef: `candidate-group:${groupId}`,
    featureSchemaVersion: "v1",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    partition: "TRAIN",
    candidateEnumeration: "complete",
    coverageCursorRef: "cursor:complete",
    evidenceRefs: [],
    failureMode: null,
    candidateRef,
    optionSemantics: "c:judge:true",
    candidateKind: "action",
    x,
    missingMode: [],
  };
}

function supervisionRow(groupId) {
  return {
    schema: "nnanything.unified.supervision-row.v1",
    group_id: groupId,
    sampleId: "sample-1",
    sourceGroup: "tests",
    partition: "TRAIN",
    goldAllowedCandidateRefs: ["a"],
    labelMissing: false,
    unknownReason: null,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    teacherResolutionRef: "teacher:sample-1",
    trainingEligible: true,
  };
}

function gateRow(groupId, firstInput, candidateInputs) {
  return {
    schema: "nnanything.unified.data-row.v1",
    rowId: groupId,
    partition: "TRAIN",
    route: { domain: "tsjs", decisionKind: "R" },
    input: firstInput,
    candidateInputs,
    missingMode: [],
    candidates: candidateInputs.map(candidate => candidate.candidateRef),
    allowed: ["a"],
    gold: "a",
    labelMissing: false,
    enumeration: "complete",
  };
}

async function makeCorpus(root) {
  const studentRowsPath = join(root, "student-rows", "student-rows.jsonl");
  const supervisionRowsPath = join(root, "labels", "supervision.jsonl");
  const gateRowsPath = join(root, "data-rows.jsonl");
  await mkdir(join(root, "student-rows"), { recursive: true });
  await mkdir(join(root, "labels"), { recursive: true });

  const xA0 = vector(5, 0);
  const xA1 = vector(7, 1);
  const xB0 = vector(11, 0);
  const xB1 = vector(13, 1);
  await writeJsonl(studentRowsPath, [
    studentRow("group-a", "a", xA0),
    studentRow("group-a", "b", xA1),
    studentRow("group-b", "a", xB0),
    studentRow("group-b", "b", xB1),
  ]);
  await writeJsonl(supervisionRowsPath, [
    supervisionRow("group-a"),
    supervisionRow("group-b"),
  ]);
  await writeJsonl(gateRowsPath, [
    gateRow("group-a", xA0, [
      { candidateRef: "a", input: xA0 },
      { candidateRef: "b", input: xA1 },
    ]),
    gateRow("group-b", xB0, [
      { candidateRef: "a", input: xB0 },
      { candidateRef: "b", input: xB1 },
    ]),
  ]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tests",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return { root, studentRowsPath, supervisionRowsPath, gateRowsPath };
}

async function makeConfig(root, overrides = {}) {
  const {
    studentRowsPath,
    supervisionRowsPath,
    gateRowsPath,
  } = await makeCorpus(root);
  const outputDir = join(root, "out");
  const packagePath = join(outputDir, "package.json");
  const config = {
    schema: "nnanything.unified.runner-config.v1",
    command: "train",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "pretraining",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      thresholdsPath,
      rowsPath: gateRowsPath,
    },
    outputDir,
    corpus: {
      root,
      admissionsPath: join(root, "corpus-admissions-v1.json"),
      studentRowsPath,
      supervisionRowsPath,
      packagePath,
      missingModeTablePath,
    },
    training: {
      modelId: "tests.unified-warmstart",
      version: "0.0.1-test",
      optimizer: "full_batch_sgd",
      learningRate: 0.01,
      maxEpochs: 2,
      seed: 20261104,
      init: "xavier_uniform",
    },
    ...overrides,
  };
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, config);
  return {
    root,
    configPath,
    outputDir,
    studentRowsPath,
    supervisionRowsPath,
    gateRowsPath,
    packagePath,
    admissionsPath: join(root, "corpus-admissions-v1.json"),
  };
}

async function makeRelocatedSourcePackage(root, sourcePackagePath, options = {}) {
  const sharedDir = join(root, "shared");
  const sourceDir = join(root, "source-package");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await copyFile(thresholdsPath, join(sharedDir, "thresholds.json"));
  await copyFile(missingModeTablePath, join(sharedDir, "missing-mode-table.json"));
  const slotMapPath = join(sharedDir, "slot-map.json");
  await writeJson(slotMapPath, { schema: "synthetic-slot-map", entries: [] });

  const original = await readJson(sourcePackagePath);
  original.resources = {
    thresholdsRef: "../shared/thresholds.json",
    thresholdsSchema: original.resources.thresholdsSchema,
    missingModeTableRef: "../shared/missing-mode-table.json",
    missingModeSchema: original.resources.missingModeSchema,
    ...(options.slotMap === false ? {} : { slotMapRef: "../shared/slot-map.json" }),
  };
  if (options.resourceSuffix !== undefined) {
    original.resources.thresholdsRef = `../shared/thresholds${options.resourceSuffix}.json`;
  }
  if (options.mutateRouteDomain) {
    original.route.domain = "not-tsjs";
  }
  if (options.mutateArchitecture) {
    original.architecture.hidden = [64];
  }
  if (options.mutateTensorShape) {
    original.tensors.b3 = [];
  }
  if (options.nonFinite) {
    original.tensors.b3[0] = Number.NaN;
  }
  const relocatedPath = join(sourceDir, "package.json");
  await writeJson(relocatedPath, original);
  return {
    relocatedPath,
    sharedDir,
    slotMapPath,
    thresholdsSharedPath: join(sharedDir, "thresholds.json"),
    missingModeSharedPath: join(sharedDir, "missing-mode-table.json"),
  };
}

function buildWarmConfig(base, warmRoot, relocated, overrides = {}) {
  const outputDir = join(warmRoot, "warm-out");
  const packagePath = join(outputDir, "package.json");
  const checkpointPath = join(outputDir, "checkpoint.json");
  const config = {
    ...base,
    command: "warmstart",
    phase: "posttraining",
    outputDir,
    dataGate: {
      ...base.dataGate,
      thresholdsPath: relocated.thresholdsSharedPath,
    },
    corpus: {
      ...base.corpus,
      packagePath,
      missingModeTablePath: relocated.missingModeSharedPath,
      slotMapPath: relocated.slotMapPath,
    },
    training: {
      ...base.training,
      maxEpochs: 2,
      epochsThisRun: 1,
      checkpointPath,
    },
    warmStart: { sourcePackagePath: relocated.relocatedPath },
    ...overrides,
  };
  return {
    config,
    configPath: join(warmRoot, "warm-config.json"),
    outputDir,
    packagePath,
    checkpointPath,
  };
}

test("warmstart starts a fresh stage, then resume continues without rereading the source", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-target-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);

    const sourcePackagePath = source.packagePath;
    const relocated = await makeRelocatedSourcePackage(warmRoot, sourcePackagePath);
    const warmOutputDir = join(warmRoot, "warm-out");
    const targetPackagePath = join(warmOutputDir, "package.json");
    const targetCheckpointPath = join(warmOutputDir, "checkpoint.json");
    const warmConfig = {
      ...JSON.parse(await readFile(source.configPath, "utf8")),
      command: "warmstart",
      phase: "posttraining",
      outputDir: warmOutputDir,
      dataGate: {
        ...JSON.parse(await readFile(source.configPath, "utf8")).dataGate,
        thresholdsPath: relocated.thresholdsSharedPath,
      },
      corpus: {
        ...JSON.parse(await readFile(source.configPath, "utf8")).corpus,
        packagePath: targetPackagePath,
        missingModeTablePath: relocated.missingModeSharedPath,
        slotMapPath: relocated.slotMapPath,
      },
      training: {
        ...JSON.parse(await readFile(source.configPath, "utf8")).training,
        maxEpochs: 2,
        epochsThisRun: 1,
        checkpointPath: targetCheckpointPath,
      },
      warmStart: { sourcePackagePath: relocated.relocatedPath },
    };
    const warmConfigPath = join(warmRoot, "warm-config.json");
    await writeJson(warmConfigPath, warmConfig);

    assert.equal(await runStandardRunnerCli(["warmstart", "--config", warmConfigPath]), 0);
    let report = await readJson(join(warmOutputDir, "run-report.json"));
    assert.equal(report.status, "paused");
    assert.equal(report.warmStart.initializer, "inherited_package");
    assert.equal(report.warmStart.inheritanceSource, "source_package");
    assert.equal(report.warmStart.sourcePackageLoadedThisRun, true);
    assert.equal(typeof report.warmStart.sourcePackageLoadSeconds, "number");
    assert.equal(report.warmStart.sourceTiming, null);
    assert.equal(report.warmStart.sourceTimingReason, "package_carries_no_training_timing");
    assert.deepEqual(report.warmStart.epochZero, {
      exact: true,
      tensorEquality: true,
      checkedInputs: 4,
      maxAbsDelta: 0,
    });
    assert.equal(report.trainReport.completedEpochs, 1);
    assert.equal(report.cumulative.optimizerSteps, 1);
    assert.equal(report.optimizerSteps, 1);

    let checkpoint = await readJson(targetCheckpointPath);
    assert.equal(checkpoint.completedEpochs, 1);
    assert.equal(checkpoint.warmStart.kind, "package-warm-start");
    assert.deepEqual(checkpoint.warmStart.epochZero, report.warmStart.epochZero);
    assert.equal(checkpoint.warmStart.sourceModelId, "tests.unified-warmstart");
    assert.equal(checkpoint.modelId, checkpoint.warmStart.sourceModelId);
    assert.equal(checkpoint.version, checkpoint.warmStart.sourceVersion);

    await rm(relocated.relocatedPath, { force: true });
    await assertMissing(relocated.relocatedPath);
    delete warmConfig.warmStart;
    warmConfig.command = "resume";
    warmConfig.training.epochsThisRun = 1;
    await writeJson(warmConfigPath, warmConfig);
    assert.equal(await runStandardRunnerCli(["resume", "--config", warmConfigPath]), 0);

    report = await readJson(join(warmOutputDir, "run-report.json"));
    assert.equal(report.status, "completed");
    assert.equal(report.resumedFromEpoch, 1);
    assert.equal(report.trainReport.completedEpochs, 2);
    assert.equal(report.cumulative.optimizerSteps, 2);
    assert.equal(report.optimizerSteps, 1);
    assert.equal(report.warmStart.inheritanceSource, "checkpoint");
    assert.equal(report.warmStart.sourcePackageLoadedThisRun, false);
    assert.equal(report.warmStart.sourcePackageLoadSeconds, null);
    assert.deepEqual(report.warmStart.epochZero, {
      exact: true,
      tensorEquality: true,
      checkedInputs: 4,
      maxAbsDelta: 0,
    });

    checkpoint = await readJson(targetCheckpointPath);
    assert.equal(checkpoint.completedEpochs, 2);
    assert.equal(checkpoint.warmStart.kind, "package-warm-start");
    assert.deepEqual(checkpoint.warmStart.epochZero, {
      exact: true,
      tensorEquality: true,
      checkedInputs: 4,
      maxAbsDelta: 0,
    });
    await assertMissing(relocated.relocatedPath);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart keeps committed work and timing when package output fails after optimization", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-package-fail-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath);
    const base = await readJson(source.configPath);
    const setup = buildWarmConfig(base, warmRoot, relocated);
    setup.config.training.maxEpochs = 1;
    delete setup.config.training.epochsThisRun;
    await mkdir(setup.packagePath, { recursive: true });
    await writeJson(setup.configPath, setup.config);

    assert.equal(await runStandardRunnerCli(["warmstart", "--config", setup.configPath]), 1);
    const report = await readJson(join(setup.outputDir, "run-report.json"));
    assert.equal(report.status, "failed");
    assert.equal(report.error.code, "PACKAGE_SAVE_ERROR");
    assert.equal(report.optimizerSteps, 1);
    assert.equal(report.processedRows > 0, true);
    assert.equal(report.thisRun.completedOptimizerSteps, 1);
    assert.equal(report.trainReport.completedEpochs, 1);
    assert.equal(report.thisRun.optimizationSeconds !== null, true);
    assert.equal(report.thisRun.checkpointIoSecs !== null, true);
    assert.equal(report.checkpointReload.tensorsMatch, true);
    assert.notEqual(report.warmStart.epochZero, null);

    const checkpoint = await readJson(setup.checkpointPath);
    assert.equal(checkpoint.completedEpochs, 1);
    await assert.rejects(
      readFile(setup.packagePath, "utf8"),
      error => error.code === "EISDIR" || error.code === "ENOTFILE",
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("epoch-zero helper rejects a deliberately perturbed clone before optimization", () => {
  const sourceTensors = createXavierTensors(20261104);
  const postTensors = cloneTensors(sourceTensors);
  postTensors.b3[0] += 1;
  const inputs = [Array.from({ length: 64 }, () => 0)];
  assert.throws(
    () => checkWarmStartEpochZeroEquality(sourceTensors, postTensors, inputs),
    error => error.code === "WARMSTART_EPOCH0_MISMATCH"
      && /epoch-zero/.test(error.message),
  );
});

test("warmstart config and source guards fail before optimizer work", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-guard-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath);
    const base = JSON.parse(await readFile(source.configPath, "utf8"));
    const configPath = join(warmRoot, "guard-config.json");

    const attempt = async (overrides, expectedCode, expectedPattern) => {
      const next = { ...base, ...overrides };
      await writeJson(configPath, next);
      assert.equal(await runStandardRunnerCli([next.command, "--config", configPath]), 1);
      const report = await readJson(join(next.outputDir, "run-report.json"));
      assert.equal(report.status, "failed");
      assert.equal(report.error.code, expectedCode);
      assert.match(report.error.message, expectedPattern);
      assert.equal(report.optimizerSteps, next.command === "warmstart" ? 0 : null);
      return report;
    };

    await attempt(
      {
        command: "warmstart",
        phase: "pretraining",
        warmStart: { sourcePackagePath: relocated.relocatedPath },
      },
      "CONFIG_ERROR",
      /phase=posttraining/,
    );
    await attempt(
      {
        command: "warmstart",
        phase: "posttraining",
      },
      "CONFIG_ERROR",
      /config\.warmStart/,
    );
    await attempt(
      {
        command: "resume",
        phase: "posttraining",
        warmStart: { sourcePackagePath: relocated.relocatedPath },
      },
      "CONFIG_ERROR",
      /only valid for command=warmstart/,
    );
    await attempt(
      {
        command: "train",
        phase: "pretraining",
        warmStart: { sourcePackagePath: relocated.relocatedPath },
      },
      "CONFIG_ERROR",
      /only valid for command=warmstart/,
    );
    await attempt(
      {
        command: "warmstart",
        phase: "posttraining",
        training: {
          ...base.training,
          ceilingAmendment: { previousMaxEpochs: 2, amendedMaxEpochs: 3 },
        },
        warmStart: { sourcePackagePath: relocated.relocatedPath },
      },
      "CONFIG_ERROR",
      /ceilingAmendment is only valid for command=resume/,
    );
    const missingSourceReport = await attempt(
      {
        command: "warmstart",
        phase: "posttraining",
        warmStart: { sourcePackagePath: join(warmRoot, "missing-package.json") },
      },
      "WARMSTART_SOURCE_INVALID",
      /missing or invalid/,
    );
    assert.match(missingSourceReport.error.cause, /MODEL_NOT_FOUND|missing or unreadable/);

    const missingTraining = {
      ...base,
      command: "warmstart",
      phase: "posttraining",
      outputDir: join(warmRoot, "missing-training-out"),
      warmStart: { sourcePackagePath: relocated.relocatedPath },
    };
    delete missingTraining.training;
    await writeJson(configPath, missingTraining);
    assert.equal(await runStandardRunnerCli(["warmstart", "--config", configPath]), 1);
    const missingTrainingReport = await readJson(join(missingTraining.outputDir, "run-report.json"));
    assert.equal(missingTrainingReport.status, "failed");
    assert.equal(missingTrainingReport.error.code, "CONFIG_ERROR");
    assert.equal(missingTrainingReport.optimizerSteps, 0);
    assert.equal("warmStart" in missingTrainingReport, false);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart data-gate failure retains loaded source evidence with epoch-zero null", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-data-fail-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath);
    const base = await readJson(source.configPath);
    const setup = buildWarmConfig(base, warmRoot, relocated);
    const invalidRowsPath = join(warmRoot, "invalid-data-rows.jsonl");
    const gateRows = (await readFile(source.gateRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    gateRows[0].allowed = ["outside-s-g"];
    await writeJsonl(invalidRowsPath, gateRows);
    setup.config.dataGate.rowsPath = invalidRowsPath;
    await writeJson(setup.configPath, setup.config);

    assert.equal(await runStandardRunnerCli(["warmstart", "--config", setup.configPath]), 1);
    const report = await readJson(join(setup.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.equal(report.optimizerSteps, 0);
    assert.equal(report.warmStart.sourceModelId, "tests.unified-warmstart");
    assert.equal(report.warmStart.inheritanceSource, "source_package");
    assert.equal(report.warmStart.sourcePackageLoadedThisRun, true);
    assert.equal(typeof report.warmStart.sourcePackageLoadSeconds, "number");
    assert.equal(report.warmStart.epochZero, null);
    await assertMissing(setup.packagePath);
    await assertMissing(setup.checkpointPath);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart rejects source/target path conflicts", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-path-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath);
    const base = JSON.parse(await readFile(source.configPath, "utf8"));
    const warmOutputDir = join(warmRoot, "warm-out");
    const targetPackagePath = join(warmOutputDir, "package.json");
    const configPath = join(warmRoot, "path-config.json");

    for (const sourcePackagePath of [targetPackagePath, `${targetPackagePath}.checkpoint.json`]) {
      const next = {
        ...base,
        command: "warmstart",
        phase: "posttraining",
        outputDir: warmOutputDir,
        corpus: {
          ...base.corpus,
          packagePath: targetPackagePath,
          missingModeTablePath: relocated.missingModeSharedPath,
          slotMapPath: relocated.slotMapPath,
        },
        training: {
          ...base.training,
          maxEpochs: 2,
          epochsThisRun: 1,
          checkpointPath: `${targetPackagePath}.checkpoint.json`,
        },
        warmStart: { sourcePackagePath },
      };
      await writeJson(configPath, next);
      assert.equal(await runStandardRunnerCli(["warmstart", "--config", configPath]), 1);
      const report = await readJson(join(warmOutputDir, "run-report.json"));
      assert.equal(report.error.code, "WARMSTART_PATH_CONFLICT");
      assert.equal(report.optimizerSteps, 0);
    }

    const targetIsCheckpoint = {
      ...base,
      command: "warmstart",
      phase: "posttraining",
      outputDir: warmOutputDir,
      corpus: {
        ...base.corpus,
        packagePath: `${warmOutputDir}/same.json`,
        missingModeTablePath: relocated.missingModeSharedPath,
        slotMapPath: relocated.slotMapPath,
      },
      training: {
        ...base.training,
        maxEpochs: 2,
        epochsThisRun: 1,
        checkpointPath: `${warmOutputDir}/same.json`,
      },
      warmStart: { sourcePackagePath: relocated.relocatedPath },
    };
    await writeJson(configPath, targetIsCheckpoint);
    assert.equal(await runStandardRunnerCli(["warmstart", "--config", configPath]), 1);
    const report = await readJson(join(warmOutputDir, "run-report.json"));
    assert.equal(report.error.code, "WARMSTART_PATH_CONFLICT");
    assert.equal(report.optimizerSteps, 0);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart rejects a source package whose resolved resources differ", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-resource-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath, {
      resourceSuffix: "-other",
    });
    await writeJson(join(warmRoot, "shared", "thresholds-other.json"), { schema: "other" });
    const base = JSON.parse(await readFile(source.configPath, "utf8"));
    const warmOutputDir = join(warmRoot, "warm-out");
    const next = {
      ...base,
      command: "warmstart",
      phase: "posttraining",
      outputDir: warmOutputDir,
      dataGate: { ...base.dataGate, thresholdsPath: relocated.thresholdsSharedPath },
      corpus: {
        ...base.corpus,
        packagePath: join(warmOutputDir, "package.json"),
        missingModeTablePath: relocated.missingModeSharedPath,
        slotMapPath: relocated.slotMapPath,
      },
      training: {
        ...base.training,
        maxEpochs: 2,
        epochsThisRun: 1,
        checkpointPath: join(warmOutputDir, "checkpoint.json"),
      },
      warmStart: { sourcePackagePath: relocated.relocatedPath },
    };
    const configPath = join(warmRoot, "resource-config.json");
    await writeJson(configPath, next);
    assert.equal(await runStandardRunnerCli(["warmstart", "--config", configPath]), 1);
    const report = await readJson(join(warmOutputDir, "run-report.json"));
    assert.equal(report.error.code, "WARMSTART_SOURCE_INCOMPATIBLE");
    assert.match(report.error.message, /thresholds resolved source/);
    assert.equal(report.optimizerSteps, 0);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart rejects target contract mismatches before optimizer work", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-contract-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(warmRoot, source.packagePath);
    const base = await readJson(source.configPath);
    const cases = [
      {
        name: "route",
        overrides: { route: { domain: "not-tsjs", decisionKind: "R" } },
        pattern: /route/,
      },
      {
        name: "encoder",
        overrides: { encoderVersion: "nnanything.unified-step.encoder.other" },
        pattern: /encoderVersion/,
      },
    ];
    for (const entry of cases) {
      const setup = buildWarmConfig(base, warmRoot, relocated, entry.overrides);
      await writeJson(setup.configPath, setup.config);
      assert.equal(await runStandardRunnerCli(["warmstart", "--config", setup.configPath]), 1);
      const report = await readJson(join(setup.outputDir, "run-report.json"));
      assert.equal(report.error.code, "WARMSTART_SOURCE_INCOMPATIBLE", entry.name);
      assert.match(report.error.message, entry.pattern);
      assert.equal(report.optimizerSteps, 0);
      await assertMissing(setup.packagePath);
      await assertMissing(setup.checkpointPath);
    }

    const sourceWithoutSlotMap = await makeRelocatedSourcePackage(
      warmRoot,
      source.packagePath,
      { slotMap: false },
    );
    const slotMapSetup = buildWarmConfig(base, warmRoot, sourceWithoutSlotMap);
    await writeJson(slotMapSetup.configPath, slotMapSetup.config);
    assert.equal(
      await runStandardRunnerCli(["warmstart", "--config", slotMapSetup.configPath]),
      1,
    );
    const slotMapReport = await readJson(join(slotMapSetup.outputDir, "run-report.json"));
    assert.equal(slotMapReport.error.code, "WARMSTART_SOURCE_INCOMPATIBLE");
    assert.match(slotMapReport.error.message, /slotMap/);
    assert.equal(slotMapReport.optimizerSteps, 0);
    await assertMissing(slotMapSetup.packagePath);
    await assertMissing(slotMapSetup.checkpointPath);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart rejects invalid source packages before optimizer work", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-invalid-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const base = await readJson(source.configPath);
    const cases = [
      { name: "non-finite", options: { nonFinite: true }, pattern: /finite/ },
      { name: "architecture", options: { mutateArchitecture: true }, pattern: /architecture/ },
      { name: "tensor-shape", options: { mutateTensorShape: true }, pattern: /tensors\.b3/ },
    ];
    for (const entry of cases) {
      const relocated = await makeRelocatedSourcePackage(
        warmRoot,
        source.packagePath,
        entry.options,
      );
      const setup = buildWarmConfig(base, warmRoot, relocated);
      await writeJson(setup.configPath, setup.config);
      assert.equal(await runStandardRunnerCli(["warmstart", "--config", setup.configPath]), 1);
      const report = await readJson(join(setup.outputDir, "run-report.json"));
      assert.equal(report.error.code, "WARMSTART_SOURCE_INVALID", entry.name);
      assert.match(report.error.message, entry.pattern);
      assert.equal(report.optimizerSteps, 0);
      await assertMissing(setup.packagePath);
      await assertMissing(setup.checkpointPath);
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart accepts matching omitted slot maps and persists omission", async () => {
  const source = await makeConfig(await mkdtemp(join(tmpdir(), "unified-warmstart-source-")));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-warmstart-no-slotmap-"));
  try {
    await mkdir(source.outputDir, { recursive: true });
    assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);
    const relocated = await makeRelocatedSourcePackage(
      warmRoot,
      source.packagePath,
      { slotMap: false },
    );
    const base = await readJson(source.configPath);
    const setup = buildWarmConfig(base, warmRoot, relocated);
    delete setup.config.corpus.slotMapPath;
    setup.config.training.maxEpochs = 1;
    delete setup.config.training.epochsThisRun;
    await writeJson(setup.configPath, setup.config);

    assert.equal(await runStandardRunnerCli(["warmstart", "--config", setup.configPath]), 0);
    const report = await readJson(join(setup.outputDir, "run-report.json"));
    assert.equal(report.status, "completed");
    const targetPackage = await readJson(setup.packagePath);
    assert.equal("slotMapRef" in targetPackage.resources, false);
    const checkpoint = await readJson(setup.checkpointPath);
    assert.equal(checkpoint.warmStart.kind, "package-warm-start");
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(warmRoot, { recursive: true, force: true });
  }
});

test("warmstart rejects non-unified runner config and simultaneous initializers", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-warmstart-boundary-"));
  try {
    const configPath = join(root, "standard-runner-config.json");
    await writeJson(configPath, {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "R",
      phase: "posttraining",
      handwiredRoot: root,
      inputPackagePath: join(root, "input-package.json"),
      outputDir: root,
    });
    assert.equal(await runStandardRunnerCli(["warmstart", "--config", configPath]), 2);

    const trainConfig = {
      schema: "nnanything.unified.train-config.v1",
      route: { domain: "tsjs", decisionKind: "R" },
      inputSchema: "nnanything.unified-step.v1",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      architecture: { input: 64, hidden: [64, 64], output: 1 },
      optimizer: "full_batch_sgd",
      learningRate: 0.01,
      maxEpochs: 2,
      seed: 20261104,
      init: "xavier_uniform",
      resources: {
        thresholdsRef: thresholdsPath,
        thresholdsSchema: "nnanything.feature-thresholds.v1",
        missingModeTableRef: missingModeTablePath,
        missingModeSchema: "nnanything.unified.missing-mode.v1",
      },
      modelId: "tests.unified-warmstart",
      version: "0.0.1-test",
    };
    assert.throws(
      () => runUnifiedTraining([{}], trainConfig, {
        resumeFrom: {},
        warmStartFrom: {},
      }),
      /warmStartFrom and resumeFrom are mutually exclusive/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
