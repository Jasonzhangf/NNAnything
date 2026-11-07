import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { generateFixedStepwise } from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  loadStepwiseEpisodeFamily,
} from "../dist/training/unified-student-converter.js";
import {
  loadStepwiseSupervisionFamily,
} from "../dist/training/unified-supervision-converter.js";
import { convertEpisodeToStudentGroup } from "../dist/training/unified-student-converter.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";

const here = new URL(".", import.meta.url);
const worktreeRoot = resolve(here.pathname, "..");
const RUN_ROOT = "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031";
const CORPUS_ROOT = join(
  RUN_ROOT,
  ".worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/corpus",
);
const thresholdsPath = resolve(
  worktreeRoot,
  "tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);
const missingModeTablePath = resolve(
  worktreeRoot,
  "tests/fixtures/unified-64-slot/missing-mode-table.json",
);
const stagingAdapterPath = resolve(worktreeRoot, "scripts/stage-stepwise-converter-corpus.mjs");

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function generateAndStage(root, { supervisionRowsOverride } = {}) {
  const generated = join(root, "generated");
  const staged = join(root, "staged");
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir: generated,
    ...(supervisionRowsOverride === undefined ? {} : { supervisionRowsOverride }),
  });
  const stagedRun = spawnSync(
    process.execPath,
    [
      stagingAdapterPath,
      "--student",
      join(generated, "student-observations.jsonl"),
      "--supervision",
      join(generated, "independent-supervision.jsonl"),
      "--source-corpus-root",
      CORPUS_ROOT,
      "--out",
      staged,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  assert.equal(stagedRun.status, 0, stagedRun.stdout + stagedRun.stderr);
  return { generated, staged };
}

async function writeRunnerConfig(root, command, options = {}) {
  const outputDir = options.outputDir ?? join(root, "out", command);
  const configPath = join(root, `runner-${command}.json`);
  const studentRowsPath = join(outputDir, "student-rows", "student-rows.jsonl");
  const supervisionRowsPath = join(outputDir, "labels", "supervision.jsonl");
  const gateRowsPath = options.rowsPath ?? join(outputDir, "data-rows.jsonl");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command,
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "sample_migration",
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
      root: join(root, "staged"),
      admissionsPath: join(root, "staged", "corpus-admissions-v1.json"),
      studentRowsPath,
      supervisionRowsPath,
      packagePath: join(outputDir, "package.json"),
      missingModeTablePath,
    },
  });
  return { configPath, outputDir, studentRowsPath, gateRowsPath };
}

test("fixed-generator student schema reaches the public stepwise loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-student-bridge-"));
  try {
    const { staged } = await generateAndStage(root);
    const episodes = await loadStepwiseEpisodeFamily(join(staged, "train-module-export-alias-a"));
    const alias = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    assert.deepEqual(alias.map(episode => episode.stepId), ["step-0", "step-1", "step-2"]);
    assert.equal(alias[0].targetRef, "decl:sources/src/impl.ts#top:helper");
    assert.equal(alias[0].requestId, "request:a-module-positive-alias");
    assert.equal(alias[0].requestedDeclaration?.declarationRef, "decl:sources/src/impl.ts#top:helper");
    assert.equal(alias[0].requestedDeclaration?.name, "helper");
    assert.equal(alias[0].requestedDeclaration?.kind, "function");
    assert.equal(alias[0].localCandidateCursor?.pendingRelationRef, "pending:a-module-positive-alias");
    const step0Receipt = alias[0].receipts?.[0];
    assert.ok(step0Receipt, "step0 must keep its real receipt");
    assert.equal(step0Receipt.receiptId, "receipt:a-module-positive-alias:step0-source-read");
    assert.equal(step0Receipt.actionRef, "action:a-module-positive-alias:step0-source-read");
    assert.equal(step0Receipt.target, "mod:sources/src/entry-pos.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixed-generator supervision schema preserves every non-judge A_g entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-supervision-bridge-"));
  try {
    const { staged } = await generateAndStage(root);
    const rows = await loadStepwiseSupervisionFamily(join(staged, "train-module-export-alias-a"));
    const aliasRows = rows.filter(row => row.sampleId === "a-module-positive-alias");
    const byStep = new Map(aliasRows.map(row => [row.stepId, row]));
    assert.deepEqual(
      byStep.get("step-0")?.goldAllowedCandidateRefs,
      ["c:advance:edge:sources/src/entry-pos.ts:import:0"],
    );
    assert.deepEqual(
      byStep.get("step-1")?.goldAllowedCandidateRefs,
      ["c:advance:edge:sources/src/util.ts:reexport:0"],
    );
    assert.deepEqual(byStep.get("step-2")?.goldAllowedCandidateRefs, ["c:judge:true"]);
    assert.equal(aliasRows.every(row => row.trainingEligible), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public convert-samples and validate-data accept the staged real generator output", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-public-acceptance-"));
  try {
    const { staged } = await generateAndStage(root);
    assert.equal(staged.endsWith(join(root, "staged")), true);
    const convert = await writeRunnerConfig(root, "convert-samples");
    const convertCode = await runStandardRunnerCli([
      "convert-samples",
      "--config",
      convert.configPath,
    ]);
    const convertReport = JSON.parse(
      await readFile(join(convert.outputDir, "run-report.json"), "utf8"),
    );
    assert.equal(
      convertCode,
      0,
      `convert-samples exited ${convertCode}: ${JSON.stringify(convertReport.error)}`,
    );
    assert.equal(convertReport.status, "READY");
    assert.ok(convertReport.counts.learnedRows > 0);
    const validate = await writeRunnerConfig(root, "validate-data", {
      outputDir: join(root, "out", "validate-data"),
      rowsPath: convert.gateRowsPath,
    });
    const validateCode = await runStandardRunnerCli([
      "validate-data",
      "--config",
      validate.configPath,
    ]);
    const validateReport = JSON.parse(
      await readFile(join(validate.outputDir, "run-report.json"), "utf8"),
    );
    assert.equal(
      validateCode,
      0,
      `validate-data exited ${validateCode}: ${JSON.stringify(validateReport.error)}`,
    );
    assert.equal(validateReport.status, "READY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alias terminal candidate set is three judges plus RETURN", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-terminal-set-"));
  try {
    const { generated, staged } = await generateAndStage(root);
    const students = await readJsonl(join(generated, "student-observations.jsonl"));
    const alias = students.find(row => row.sampleId === "a-module-positive-alias");
    assert.ok(alias);
    const terminal = alias.steps.find(step => step.stepId === "step-2");
    assert.deepEqual(terminal.legalCandidates, [
      "c:judge:true",
      "c:judge:false",
      "c:judge:unknown",
      "c:return",
    ]);
    const episodes = await loadStepwiseEpisodeFamily(join(staged, "train-module-export-alias-a"));
    const terminalEpisode = episodes.find(
      episode => episode.sampleId === "a-module-positive-alias" && episode.stepId === "step-2",
    );
    assert.ok(terminalEpisode);
    const context = relationStepContext(terminalEpisode);
    assert.deepEqual(
      context.candidateGroup.candidates.map(candidate => candidate.candidateRef).sort(),
      [...terminal.legalCandidates].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent supervision changes do not move staged students or converter vectors", async () => {
  const baseRoot = await mkdtemp(join(tmpdir(), "p1-1-isolation-base-"));
  const overrideRoot = await mkdtemp(join(tmpdir(), "p1-1-isolation-override-"));
  try {
    const baseSupervision = await readJsonl(
      join(RUN_ROOT, "emma-tsjs-typed-observation-corpus-r1/independent-supervision.jsonl"),
    );
    const changed = structuredClone(baseSupervision);
    const alias = changed.find(row => row.sampleId === "a-module-positive-alias");
    assert.ok(alias);
    alias.gold.label = "false";
    alias.gold.goldAction = "c:judge:false";
    alias.steps[0].A_g = ["c:judge:false"];
    alias.steps[0].agSubsetOfSg = true;

    const base = await generateAndStage(baseRoot);
    const override = await generateAndStage(overrideRoot, {
      supervisionRowsOverride: changed,
    });
    const baseBytes = await readFile(
      join(base.staged, "train-module-export-alias-a", "student-observations.jsonl"),
      "utf8",
    );
    const overrideBytes = await readFile(
      join(override.staged, "train-module-export-alias-a", "student-observations.jsonl"),
      "utf8",
    );
    assert.equal(baseBytes, overrideBytes);

    const baseEpisodes = await loadStepwiseEpisodeFamily(
      join(base.staged, "train-module-export-alias-a"),
    );
    const overrideEpisodes = await loadStepwiseEpisodeFamily(
      join(override.staged, "train-module-export-alias-a"),
    );
    const baseGroups = baseEpisodes.map(episode => convertEpisodeToStudentGroup(episode));
    const overrideGroups = overrideEpisodes.map(episode => convertEpisodeToStudentGroup(episode));
    assert.deepEqual(overrideGroups, baseGroups);
  } finally {
    await rm(baseRoot, { recursive: true, force: true });
    await rm(overrideRoot, { recursive: true, force: true });
  }
});
