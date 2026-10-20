import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CLI_COMMAND_HEADS,
  fitCliCommandProfile,
  isBatch1CommandCase,
  makeCliCommandFixture,
  migrateCliCommandProfileV6,
  predictCliCommand,
  sampleFacts,
  sampleGoal,
} from "nnanything/cli-goal";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!["--handwired-root", "--output-root", "--initial-source", "--epochs", "--learning-rate"].includes(args[index])
    || args[index + 1] === undefined || options.has(args[index])) {
    throw new Error("Expected --handwired-root PATH [--output-root PATH] [--initial-source PATH] [--epochs N] [--learning-rate N]");
  }
  options.set(args[index], args[index + 1]);
}
if (!options.has("--handwired-root")) throw new Error("Explicit --handwired-root required");

const outputRoot = options.get("--output-root") ?? fileURLToPath(new URL("../../../training/", import.meta.url));
const initialSource = options.get("--initial-source")
  ?? "/Volumes/extension/code/NNAnything/training/weights/filesystem/command/ba002b23-b650-4869-87ec-2d36f4fe7485/candidate.json";
const epochs = Number(options.get("--epochs") ?? 600), learningRate = Number(options.get("--learning-rate") ?? 0.1);
const runId = randomUUID();
const startedAt = new Date().toISOString();
const ownerRoot = await mkdtemp(join(tmpdir(), "nn-shared-training-owner-"));
const started = performance.now();

function predictionRows(rows, profile, scenes) {
  return rows.map(sample => {
    const scene = scenes.get(sample.scenarioId);
    if (!scene) throw new Error(`Missing scenario ${sample.scenarioId}`);
    const prediction = predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile);
    return {
      id: sample.id,
      partition: sample.partition,
      sourceGroup: sample.sourceGroup,
      expectedHead: sample.expectedHead,
      selectedHead: prediction.selectedHead,
      correct: prediction.selectedHead === sample.expectedHead,
    };
  });
}

function summary(rows) {
  return {
    total: rows.length,
    correct: rows.filter(row => row.correct).length,
    failed: rows.filter(row => !row.correct).length,
  };
}

function perHead(rows) {
  return Object.fromEntries(CLI_COMMAND_HEADS.map(head => {
    const positive = rows.filter(row => row.expectedHead === head).length;
    return [head, { p: positive, negatives: rows.length - positive }];
  }));
}

function byCase(rows) {
  return Object.fromEntries([...new Set(rows.map(row => row.case))].sort().map(name => [name, rows.filter(row => row.case === name).length]));
}

async function createRunDirectory(category) {
  const parent = join(outputRoot, category, "filesystem", "command");
  await mkdir(parent, { recursive: true });
  const path = join(parent, runId);
  await mkdir(path, { recursive: false });
  return path;
}

try {
  await mkdir(outputRoot, { recursive: true });
  const legacy = JSON.parse(await readFile(initialSource, "utf8"));
  const initial = migrateCliCommandProfileV6(legacy);
  assert.equal(initial.heads.length, 10);
  assert.equal(initial.wires.length, 30);

  const { dataset } = await makeCliCommandFixture({ root: ownerRoot, extended: true });
  assert.equal(dataset.version, 3);
  assert.equal(dataset.samples.length, 262);
  assert.equal(dataset.samples.filter(sample => sample.partition === "train").length, 174);
  assert.equal(dataset.samples.filter(sample => sample.partition === "development").length, 88);

  const legacyRows = dataset.samples.filter(sample => !isBatch1CommandCase(sample.case));
  const batch1Rows = dataset.samples.filter(sample => isBatch1CommandCase(sample.case));
  assert.equal(legacyRows.length, 58);
  assert.equal(batch1Rows.length, 204);
  const trainRows = dataset.samples.filter(sample => sample.partition === "train");
  const developmentRows = dataset.samples.filter(sample => sample.partition === "development");
  const scenes = new Map(dataset.scenarios.map(scene => [scene.id, scene]));

  const fitRows = trainRows.map(sample => {
    const scene = scenes.get(sample.scenarioId);
    if (!scene) throw new Error(`Missing scenario ${sample.scenarioId}`);
    const prediction = predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), initial);
    return { features: prediction.features, expectedHead: sample.expectedHead };
  });

  const fit = await fitCliCommandProfile({
    initial,
    rows: fitRows,
    handwiredRoot: options.get("--handwired-root"),
    epochs,
    learningRate,
  });
  assert.equal(fit.profile.calibration, "uncalibrated");
  assert.equal(fit.profile.adoption, "not_applied");

  const trainPredictions = predictionRows(trainRows, fit.profile, scenes);
  const developmentPredictions = predictionRows(developmentRows, fit.profile, scenes);
  const legacyInitial = predictionRows(legacyRows, initial, scenes);
  const legacyCurrent = predictionRows(legacyRows, fit.profile, scenes);
  const legacyChanged = legacyInitial.flatMap((row, index) => {
    const after = legacyCurrent[index];
    return row.selectedHead === after.selectedHead ? [] : [{
      id: row.id,
      expectedHead: row.expectedHead,
      before: row.selectedHead,
      after: after.selectedHead,
    }];
  });
  const regressions = legacyInitial.filter((row, index) => row.correct && !legacyCurrent[index].correct);
  const fixes = legacyInitial.filter((row, index) => !row.correct && legacyCurrent[index].correct);
  const unresolved = legacyInitial.filter((row, index) => !row.correct && !legacyCurrent[index].correct);
  const retained = legacyInitial.filter((row, index) => row.correct && legacyCurrent[index].correct);

  const sampleDirectory = await createRunDirectory("samples");
  const weightDirectory = await createRunDirectory("weights");
  const resultDirectory = await createRunDirectory("results");
  const samplesPath = join(sampleDirectory, "samples.json");
  const profilePath = join(weightDirectory, "candidate.json");
  const reportPath = join(resultDirectory, "report.json");
  const reloadPath = join(resultDirectory, "reload.json");

  const families = dataset.scenarios.filter(scene => scene.familyKind === "batch1").map(scene => {
    const rows = dataset.samples.filter(sample => sample.scenarioId === scene.id);
    return {
      id: scene.id,
      partition: scene.partition,
      rows: rows.length,
      byCase: byCase(rows),
      byHead: perHead(rows),
    };
  });

  const timing = {
    ...fit.timing,
    consumerMs: performance.now() - started,
  };
  const report = {
    runId,
    startedAt,
    initialSource,
    datasetVersion: dataset.version,
    counts: {
      total: dataset.samples.length,
      train: trainRows.length,
      development: developmentRows.length,
      legacy: legacyRows.length,
      batch1: batch1Rows.length,
    },
    families,
    perHead: {
      train: perHead(trainRows),
      development: perHead(developmentRows),
      legacy: perHead(legacyRows),
      batch1: perHead(batch1Rows),
    },
    hits: {
      train: summary(trainPredictions),
      development: summary(developmentPredictions),
      legacy: summary(legacyCurrent),
    },
    fitting: {
      completedEpochs: fit.timing.completedEpochs,
      processedRowCount: fit.timing.processedRowCount,
      learningRate,
      budgetSelection: "200 epochs left six legacy unsupported rows on entry.inspect; development budget selected 600 without optimizer changes",
      trajectory: fit.trajectory,
      timing,
    },
    legacyRegression: {
      count: legacyRows.length,
      retained: retained.length,
      fixed: fixes.length,
      regressed: regressions.length,
      unresolved: unresolved.length,
      changed: legacyChanged,
      regressions,
    },
    profile: fit.profile,
    schema: {
      heads: fit.profile.heads.length,
      wires: fit.profile.wires.length,
      parameters: fit.profile.weights.flat().length,
    },
    calibration: fit.profile.calibration,
    adoption: fit.profile.adoption,
    independentVerification: "separate I7 resource; not provided to fit",
  };

  await writeFile(samplesPath, JSON.stringify(dataset, null, 2) + "\n", { flag: "wx" });
  await writeFile(profilePath, JSON.stringify(fit.profile, null, 2) + "\n", { flag: "wx" });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const reloadStarted = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./reload.mjs", import.meta.url)),
    profilePath,
    samplesPath,
    reportPath,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const reload = JSON.parse(stdout);
  const reloadMs = performance.now() - reloadStarted;
  assert.equal(reload.fitted, false);
  assert.equal(reload.checked, dataset.samples.length);
  assert.equal(reload.schema.heads, 10);
  assert.equal(reload.schema.wires, 30);
  assert.equal(reload.profileMatchesSavedFile, true);
  await writeFile(reloadPath, JSON.stringify({ ...reload, reloadMs }, null, 2) + "\n", { flag: "wx" });

  const summaryPayload = {
    runId,
    paths: { samples: samplesPath, profile: profilePath, report: reportPath, reload: reloadPath },
    counts: report.counts,
    hits: report.hits,
    perHead: report.perHead,
    legacyRegression: report.legacyRegression,
    timing,
    reload,
    calibration: fit.profile.calibration,
    adoption: fit.profile.adoption,
  };
  console.log(JSON.stringify(summaryPayload, null, 2));

  if (regressions.length > 0) throw new Error(`Legacy regression count is ${regressions.length}`);
} finally {
  await rm(ownerRoot, { recursive: true, force: true });
}
