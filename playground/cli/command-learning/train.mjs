import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isBatch1CommandCase,
  makeCliCommandFixture,
  migrateCliCommandProfileV6,
  runCliCommandTraining,
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

const outputRoot = resolve(options.get("--output-root") ?? fileURLToPath(new URL("../../../training/", import.meta.url)));
const initialSource = options.get("--initial-source")
  ?? "/Volumes/extension/code/NNAnything/training/weights/filesystem/command/ba002b23-b650-4869-87ec-2d36f4fe7485/candidate.json";
const epochs = Number(options.get("--epochs") ?? 600), learningRate = Number(options.get("--learning-rate") ?? 0.1);
const ownerRoot = await mkdtemp(join(tmpdir(), "nn-shared-training-consumer-"));
const startedAt = new Date().toISOString(), started = performance.now();

function compactSummary(summary) {
  return {
    count: summary.count,
    correct: summary.correct,
    passed: summary.passed,
    effectsCorrect: Object.values(summary.byCase).reduce((total, item) => total + item.effectsCorrect, 0),
  };
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
  assert.equal(dataset.samples.filter(sample => !isBatch1CommandCase(sample.case)).length, 58);
  assert.equal(dataset.samples.filter(sample => isBatch1CommandCase(sample.case)).length, 204);

  const receipt = await runCliCommandTraining({
    dataset,
    initial,
    initialSource,
    epochs,
    learningRate,
  }, {
    handwiredRoot: options.get("--handwired-root"),
    outputRoot,
    grantedEffects: ["filesystem.read", "filesystem.write"],
  });

  const reloadStarted = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./reload.mjs", import.meta.url)),
    receipt.paths.profile,
    receipt.paths.samples,
    receipt.paths.report,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const reload = JSON.parse(stdout);
  const reloadPath = join(dirname(receipt.paths.report), "reload.json");
  await writeFile(reloadPath, JSON.stringify({ ...reload, reloadMs: performance.now() - reloadStarted }, null, 2) + "\n", { flag: "wx" });

  assert.equal(receipt.accepted, true);
  assert.equal(reload.fitted, false);
  assert.equal(reload.checked, dataset.samples.length);
  assert.equal(reload.executed, dataset.samples.length);
  assert.equal(reload.executedLegacy, 58);
  assert.equal(reload.executedBatch1, 204);
  assert.equal(reload.unverified, 0);
  assert.equal(reload.failed, 0);
  assert.equal(reload.schema.heads, 10);
  assert.equal(reload.schema.wires, 30);
  assert.equal(reload.profileMatchesSavedFile, true);

  console.log(JSON.stringify({
    runId: receipt.runId,
    startedAt,
    initialSource,
    counts: {
      total: dataset.samples.length,
      train: 174,
      development: 88,
      legacy: 58,
      batch1: 204,
    },
    comparison: {
      train: compactSummary(receipt.comparison.train),
      development: compactSummary(receipt.comparison.development),
    },
    paths: { ...receipt.paths, reload: reloadPath },
    reload,
    timing: {
      ...receipt.timing,
      consumerMs: performance.now() - started,
    },
    calibration: receipt.profile.calibration,
    adoption: receipt.profile.adoption,
  }, null, 2));
} finally {
  await rm(ownerRoot, { recursive: true, force: true });
}
