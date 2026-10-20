import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  makeCliCommandFixture,
  migrateLegacyCliCommandProfile,
  runCliCommandTraining,
  sampleFacts,
  sampleGoal,
} from "nnanything/cli-goal";

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
  ?? "/Volumes/extension/code/NNAnything/training/weights/filesystem/command/d7c4a3e5-4111-4e09-857f-5f20f4fa18c0/candidate.json";
const epochs = Number(options.get("--epochs") ?? 200), learningRate = Number(options.get("--learning-rate") ?? 0.1);
const ownerRoot = await mkdtemp(join(tmpdir(), "nn-shared-training-owner-"));
const started = performance.now();
try {
  await mkdir(outputRoot, { recursive: true });
  const legacy = JSON.parse(await readFile(initialSource, "utf8"));
  const initial = migrateLegacyCliCommandProfile(legacy);
  const { dataset } = await makeCliCommandFixture({ root: ownerRoot });
  const legacyHeadRows = [0, 3, 4, 5];
  const legacyLogits = dataset.samples.filter(sample => sample.partition === "train")
    .map(sample => {
      const scene = dataset.scenarios.find(candidate => candidate.id === sample.scenarioId);
      if (!scene) throw new Error(`Missing scenario ${sample.scenarioId}`);
      const goal = sampleGoal(sample, scene);
      const features = [
        1,
        goal.property === "file.property.relation.sessionCwd" && goal.requirement.kind === "observed" ? 1 : 0,
        goal.property === "file.property.relation.sessionCwd" && goal.requirement.kind === "equals" ? 1 : 0,
        goal.property === "file.property.directory.entries" ? 1 : 0,
      ];
      const before = legacy.weights.map(row => row.reduce((sum, weight, index) => sum + weight * features[index], 0));
      const after = legacyHeadRows.map(row => initial.weights[row].slice(0, 4)
        .reduce((sum, weight, index) => sum + weight * features[index], 0));
      assert.deepEqual(after, before, `legacy logits changed for ${sample.id}`);
      return { id: sample.id, expectedHead: sample.expectedHead, features, before, after };
    });
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
  assert.equal(receipt.accepted, true, "single shared candidate did not meet train/dev and legacy gates");
  assert.equal(receipt.verification.status, "not_provided");
  assert.equal(receipt.fullyVerified, false);
  assert.equal(receipt.profile.weights.length, 6);
  assert.equal(receipt.profile.weights[0].length, 14);
  assert.equal(receipt.timing.completedEpochs, epochs);
  assert.equal(receipt.timing.gradientRowEpochs, receipt.comparison.train.count * epochs);
  const reloadStarted = performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./reload.mjs", import.meta.url)),
    receipt.paths.profile, receipt.paths.samples, receipt.paths.report], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const reload = JSON.parse(stdout);
  assert.equal(reload.fitted, false);
  assert.equal(reload.checked, receipt.comparison.train.count + receipt.comparison.development.count);
  assert.equal(reload.failed, 0);
  const summary = {
    runId: receipt.runId,
    initialSource,
    paths: receipt.paths,
    parameterCount: receipt.profile.weights.flat().length,
    comparison: receipt.comparison,
    controls: receipt.controls,
    regression: receipt.regression,
    semanticChanges: receipt.semanticChanges,
    legacyLogits: { count: legacyLogits.length, rows: legacyLogits },
    timing: receipt.timing,
    reload,
    reloadMs: performance.now() - reloadStarted,
    consumerMs: performance.now() - started,
    calibration: "uncalibrated",
    adoption: "not_applied",
    independentVerification: "separate; not part of this training consumer",
  };
  const reportDirectory = dirname(receipt.paths.report);
  await writeFile(join(reportDirectory, "consumer-summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await rm(ownerRoot, { recursive: true, force: true });
}
