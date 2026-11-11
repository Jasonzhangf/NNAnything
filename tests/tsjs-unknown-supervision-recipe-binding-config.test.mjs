import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
} from "../dist/training/unified-student-converter.js";
import {
  convertGoldToSupervisionRow,
  loadGoldFamily,
  loadStepwiseSupervisionFamily,
} from "../dist/training/unified-supervision-converter.js";
import { loadUnifiedModelPackageFromFile } from "../dist/training/unified-model-package.js";
import {
  UNIFIED_TRAIN_CONFIG_SCHEMA,
  validateUnifiedTrainConfig,
} from "../dist/training/unified-train-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, "..");
const CONFIG_DIR = resolve(
  here,
  "fixtures/tsjs-unknown-supervision-recipe-binding-config-r1-20261110",
);
const TRAIN_CONFIG_PATH = join(CONFIG_DIR, "train-warmstart.runner-config.json");
const DEV_CONFIG_PATH = join(CONFIG_DIR, "dev-evaluate.runner-config.json");
const TRAIN_FAMILY_PATH = resolve(
  worktreeRoot,
  "training/samples/neural-cli/tsjs/train-runtime-helper-selector-r1",
);
const TRAIN_ADMISSIONS_PATH = resolve(
  worktreeRoot,
  "training/samples/neural-cli/tsjs/corpus-admissions-v1.json",
);
const DEV_FAMILY_PATH = resolve(
  "/Volumes/Intel/playground/nnanything-runs/tsjs-request-aware-admission-config-r1-20261110/derived-dev",
);
const DEV_ADMISSIONS_PATH = join(DEV_FAMILY_PATH, "familyAdmissions.json");
const SOURCE_PACKAGE_PATH = resolve(
  "/Volumes/Intel/playground/nnanything-runs/tsjs-fixed-candidate-resume-checker-prep-r1-20261110/execution/package/model-package.json",
);
const THRESHOLDS_PATH = resolve(
  worktreeRoot,
  "tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);
const MISSING_MODE_PATH = resolve(
  worktreeRoot,
  "tests/fixtures/unified-64-slot/missing-mode-table.json",
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function targetTrainConfig(config) {
  return {
    schema: UNIFIED_TRAIN_CONFIG_SCHEMA,
    route: config.route,
    inputSchema: "nnanything.unified-step.v1",
    encoderVersion: config.encoderVersion,
    architecture: { input: 64, hidden: [64, 64], output: 1 },
    optimizer: config.training.optimizer,
    learningRate: config.training.learningRate,
    maxEpochs: config.training.maxEpochs,
    seed: config.training.seed,
    init: config.training.init,
    resources: {
      thresholdsRef: THRESHOLDS_PATH,
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: MISSING_MODE_PATH,
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
    modelId: config.training.modelId,
    version: config.training.version,
  };
}

const hasAcceptedRunInputs = existsSync(DEV_FAMILY_PATH)
  && existsSync(DEV_ADMISSIONS_PATH)
  && existsSync(SOURCE_PACKAGE_PATH);

test("TRAIN config binds the accepted supervision without fitting", async () => {
  const config = await readJson(TRAIN_CONFIG_PATH);
  assert.equal(config.schema, "nnanything.unified.runner-config.v1");
  assert.equal(config.command, "warmstart");
  assert.equal(config.phase, "posttraining");
  assert.equal(config.dataGate.partition, "TRAIN");
  assert.equal(resolve(config.corpus.root), TRAIN_FAMILY_PATH);
  assert.equal(resolve(config.corpus.admissionsPath), TRAIN_ADMISSIONS_PATH);
  assert.equal(config.training.optimizer, "full_batch_sgd");
  assert.equal(config.training.learningRate, 0.01);
  assert.equal(config.training.maxEpochs, 200);

  const episodes = await loadStepwiseEpisodeFamily(TRAIN_FAMILY_PATH);
  const supervision = await loadStepwiseSupervisionFamily(TRAIN_FAMILY_PATH);
  const admissions = await readJson(TRAIN_ADMISSIONS_PATH);
  const admission = admissions.familyAdmissions.find(
    entry => entry.sourceGroup === "tsjs-train-runtime-helper-selector-r1",
  );
  assert.equal(admission.partition, "train");
  assert.equal(admission.usableForTrainingSupervision, true);
  assert.equal(admission.usableForIndependentVerification, false);
  assert.deepEqual(episodes.map(episode => episode.sampleId), ["tr-h01", "tr-h02", "tr-h03"]);
  assert.equal(supervision.length, episodes.length);

  const groups = episodes.map(episode => convertEpisodeToStudentGroup(episode));
  const supervisionByGroup = new Map(supervision.map(row => [row.group_id, row]));
  for (const group of groups) {
    assert.equal(group.partition, "TRAIN");
    const row = supervisionByGroup.get(group.group_id);
    assert.ok(row);
    assert.equal(row.partition, "TRAIN");
    assert.equal(row.unknownReason, "runtime_dynamic_selector");
    assert.equal(row.trainingEligible, true);
    assert.equal(row.notReadyReason, null);
    assert.deepEqual(row.goldAllowedCandidateRefs, ["c:judge:unknown"]);
  }

  const nonFittingConfig = structuredClone(config);
  delete nonFittingConfig.warmStart;
  nonFittingConfig.command = "convert-samples";
  const nonFittingRoot = await mkdtemp(join(tmpdir(), "tsjs-unknown-binding-train-"));
  const nonFittingConfigPath = join(nonFittingRoot, "train-nonfitting.runner-config.json");
  await writeFile(nonFittingConfigPath, JSON.stringify(nonFittingConfig), "utf8");
  try {
    await rm(config.outputDir, { recursive: true, force: true });
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", nonFittingConfigPath]), 0);
    assert.equal(await runStandardRunnerCli(["validate-data", "--config", nonFittingConfigPath]), 0);
  } finally {
    await rm(nonFittingRoot, { recursive: true, force: true });
  }

  const report = await readJson(join(config.outputDir, "run-report.json"));
  assert.equal(report.command, "validate-data");
  assert.equal(report.status, "READY");
  assert.equal(report.dataGate.status, "READY");
  assert.equal(report.thisRun.optimizationSeconds, 0);

  const studentRows = await readJsonl(config.corpus.studentRowsPath);
  const supervisionRows = await readJsonl(config.corpus.supervisionRowsPath);
  assert.equal(supervisionRows.length, 3);
  assert.equal(studentRows.some(row => "gold" in row || "allowed" in row), false);
  assert.equal(supervisionRows.some(row => "x" in row || "input" in row), false);
});

test("DEV config binds accepted DEV truth and does not enter TRAIN supervision", {
  skip: !hasAcceptedRunInputs,
}, async () => {
  const config = await readJson(DEV_CONFIG_PATH);
  assert.equal(config.schema, "nnanything.unified.runner-config.v1");
  assert.equal(config.command, "evaluate-dev");
  assert.equal(config.phase, "evaluation");
  assert.equal(config.evaluateDev.schema, "nnanything.unified.dev-evaluate-config.v1");
  assert.equal(config.evaluateDev.consumerEntry, "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision");
  assert.equal(resolve(config.evaluateDev.devFamilyPath), DEV_FAMILY_PATH);
  assert.equal(resolve(config.evaluateDev.admissionsPath), DEV_ADMISSIONS_PATH);

  const admissions = await readJson(DEV_ADMISSIONS_PATH);
  const admission = admissions.familyAdmissions.find(
    entry => entry.sourceGroup === "tsjs-dev-runtime-helper-selector-clean-r1-20261110-derived-dev",
  );
  assert.equal(admission.partition, "DEV");
  assert.equal(admission.usableForTrainingSupervision, false);

  const episodes = await loadStepwiseEpisodeFamily(DEV_FAMILY_PATH);
  const gold = await loadGoldFamily(DEV_FAMILY_PATH);
  const supervision = gold.map(convertGoldToSupervisionRow);
  assert.deepEqual(episodes.map(episode => episode.sampleId), ["dv-c01", "dv-c02"]);
  assert.deepEqual(gold.map(row => row.sampleId), ["dv-c01", "dv-c02"]);
  assert.deepEqual(supervision.map(row => row.partition), ["DEV", "DEV"]);
  assert.deepEqual(supervision.map(row => row.goldAllowedCandidateRefs), [
    ["c:judge:unknown"],
    ["c:judge:unknown"],
  ]);
  assert.deepEqual(supervision.map(row => row.unknownReason), [
    "runtime_dynamic_selector",
    "runtime_dynamic_selector",
  ]);

  const candidate = (await loadUnifiedModelPackageFromFile(config.evaluateDev.candidatePackagePath)).package;
  assert.deepEqual(candidate.route, config.route);
  assert.equal(candidate.encoderVersion, config.encoderVersion);
  assert.equal(config.evaluateDev.devFamilyPath.includes("train-runtime-helper-selector-r1"), false);
});

test("the TRAIN runner rejects the accepted DEV family as training supervision", {
  skip: !hasAcceptedRunInputs,
}, async () => {
  const config = await readJson(TRAIN_CONFIG_PATH);
  const root = await mkdtemp(join(tmpdir(), "tsjs-unknown-binding-dev-reject-"));
  try {
    const mutated = structuredClone(config);
    delete mutated.warmStart;
    mutated.corpus.root = DEV_FAMILY_PATH;
    mutated.corpus.admissionsPath = DEV_ADMISSIONS_PATH;
    mutated.corpus.studentRowsPath = join(root, "student-rows.jsonl");
    mutated.corpus.supervisionRowsPath = join(root, "supervision-rows.jsonl");
    mutated.corpus.packagePath = join(root, "package.json");
    mutated.dataGate.rowsPath = join(root, "data-gate-rows.jsonl");
    mutated.outputDir = join(root, "out");
    const configPath = join(root, "runner-config.json");
    await writeFile(configPath, JSON.stringify(mutated), "utf8");

    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", configPath]), 1);
    const report = await readJson(join(mutated.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, /not usable for training supervision/);
    assert.equal(existsSync(mutated.corpus.studentRowsPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the warmstart source package is compatible with the target recipe", {
  skip: !existsSync(SOURCE_PACKAGE_PATH),
}, async () => {
  const config = await readJson(TRAIN_CONFIG_PATH);
  const target = targetTrainConfig(config);
  validateUnifiedTrainConfig(target);

  const source = (await loadUnifiedModelPackageFromFile(SOURCE_PACKAGE_PATH)).package;
  assert.deepEqual(source.route, target.route);
  assert.equal(source.inputSchema, target.inputSchema);
  assert.equal(source.encoderVersion, target.encoderVersion);
  assert.deepEqual(source.architecture, {
    input: target.architecture.input,
    hidden: target.architecture.hidden,
    output: target.architecture.output,
    activation: "relu",
  });
  assert.equal(source.resources.thresholdsSchema, target.resources.thresholdsSchema);
  assert.equal(source.resources.missingModeSchema, target.resources.missingModeSchema);
});
