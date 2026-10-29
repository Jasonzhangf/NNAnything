import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ENTRY_SELECT_WIRES,
  validateEntrySelectProfile,
  zeroEntrySelectProfile,
} from "../../../dist/filters/cli-entry-select-relation.js";
import {
  evaluateEntrySelectDataset,
  fitEntrySelectRelation,
} from "../../../dist/training/cli-entry-select-numeric.js";
import {
  makeEntrySelectDataset,
  validateEntrySelectDataset,
} from "../../../dist/training/cli-entry-select-samples.js";

const execFileAsync = promisify(execFile);

const ALLOWED_FLAGS = new Set([
  "--mode",
  "--output-root",
  "--handwired-root",
  "--epochs",
  "--learning-rate",
]);

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!ALLOWED_FLAGS.has(flag) || value === undefined || options.has(flag)) {
    throw new Error(
      "Expected --mode <validate-only|train> --output-root PATH [--handwired-root PATH] [--epochs N] [--learning-rate N]",
    );
  }
  options.set(flag, value);
}

const mode = options.get("--mode");
if (mode !== "validate-only" && mode !== "train") {
  throw new Error("Explicit --mode <validate-only|train> required");
}
const rawOutputRoot = options.get("--output-root");
if (typeof rawOutputRoot !== "string" || rawOutputRoot.length === 0) {
  throw new Error("Explicit --output-root PATH required");
}
const outputRoot = resolve(rawOutputRoot);

const startedAt = new Date().toISOString();
const consumerStarted = performance.now();

await mkdir(outputRoot, { recursive: true });

const datasetStarted = performance.now();
const dataset = makeEntrySelectDataset();
const validationSummary = validateEntrySelectDataset(dataset);
const datasetValidationMs = performance.now() - datasetStarted;

const zeroDirectoryProfile = validateEntrySelectProfile(zeroEntrySelectProfile("directory", 0.5));
const zeroRegularProfile = validateEntrySelectProfile(zeroEntrySelectProfile("regular", 0.5));

const zeroEvalStarted = performance.now();
const zeroControlEvaluation = evaluateEntrySelectDataset(dataset, {
  directory: zeroDirectoryProfile,
  regular: zeroRegularProfile,
});
const zeroEvalMs = performance.now() - zeroEvalStarted;

if (mode === "validate-only") {
  const samplesPath = join(outputRoot, "samples.json");
  const receiptPath = join(outputRoot, "validation-receipt.json");
  await writeFile(samplesPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");

  const completedAt = new Date().toISOString();
  const receipt = {
    contract: "cli.entry-select-training.validation.v1",
    mode: "validate-only",
    startedAt,
    completedAt,
    completedEpochs: 0,
    trainingSteps: 0,
    handwiredLoaded: false,
    schema: {
      contracts: [
        "cli.directory-select-relation.v1",
        "cli.file-select-relation.v1",
      ],
      wires: [...ENTRY_SELECT_WIRES],
      parametersPerUnit: 4,
      totalUnits: 2,
      threshold: 0.5,
      thresholdEquivalence: "score >= 0.5 <=> logit >= 0",
    },
    datasetValidation: validationSummary,
    zeroWeightControl: {
      profiles: {
        directory: zeroDirectoryProfile,
        regular: zeroRegularProfile,
      },
      knownReplay: {
        trainSets: {
          count: zeroControlEvaluation.knownReplay.train.sets.count,
          correct: zeroControlEvaluation.knownReplay.train.sets.correct,
          conflictCount: zeroControlEvaluation.knownReplay.train.sets.conflictCount,
        },
        developmentSets: {
          count: zeroControlEvaluation.knownReplay.development.sets.count,
          correct: zeroControlEvaluation.knownReplay.development.sets.correct,
          conflictCount: zeroControlEvaluation.knownReplay.development.sets.conflictCount,
        },
      },
      independentVerification: {
        role: "bounded_synthetic_held_out",
        provenance: "synthetic_held_out_from_eight_boolean_templates",
        allEightFeatureVectorsSeenInTrain: true,
        unseenFeatureCapabilityVerified: false,
        fullyVerified: false,
        verificationSets: {
          count: zeroControlEvaluation.independentVerification.sets.count,
          correct: zeroControlEvaluation.independentVerification.sets.correct,
          conflictCount: zeroControlEvaluation.independentVerification.sets.conflictCount,
        },
      },
      probes: {
        count: zeroControlEvaluation.probes.count,
        correct: zeroControlEvaluation.probes.correct,
      },
    },
    verificationScope: "bounded_synthetic_held_out",
    unseenFeatureCapabilityVerified: false,
    fullyVerified: false,
    paths: {
      samples: samplesPath,
      validationReceipt: receiptPath,
    },
    evaluationEntries: {
      validateOnlyCommand: `node playground/cli/entry-select-learning/train.mjs --mode validate-only --output-root ${outputRoot}`,
      futureTrainCommand: `node playground/cli/entry-select-learning/train.mjs --mode train --handwired-root /Volumes/extension/code/handwired --epochs 200 --learning-rate 0.1 --output-root /Volumes/Intel/playground/nnanything-runs/cli-p3-b/training-output`,
      futureReloadCommand: `node playground/cli/entry-select-learning/reload.mjs --output-root /Volumes/Intel/playground/nnanything-runs/cli-p3-b/training-output`,
    },
    timing: {
      datasetValidationMs,
      zeroEvalMs,
      consumerMs: performance.now() - consumerStarted,
    },
    calibration: "uncalibrated",
    adoption: "not_applied",
  };

  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}

const handwiredRoot = options.get("--handwired-root");
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) {
  throw new Error("Explicit --handwired-root PATH required in --mode train");
}
const epochs = Number(options.get("--epochs") ?? 200);
const learningRate = Number(options.get("--learning-rate") ?? 0.1);
if (!Number.isInteger(epochs) || epochs <= 0 || !Number.isFinite(learningRate) || learningRate <= 0) {
  throw new Error("Positive integer --epochs and positive finite --learning-rate required in --mode train");
}

const trainDirectoryRows = dataset.candidateRows
  .filter(row => row.partition === "train" && row.targetType === "directory")
  .map(row => ({ features: row.features, expectedLabel: row.expectedLabel }));
const trainRegularRows = dataset.candidateRows
  .filter(row => row.partition === "train" && row.targetType === "regular")
  .map(row => ({ features: row.features, expectedLabel: row.expectedLabel }));

assert.equal(trainDirectoryRows.length, 32);
assert.equal(trainRegularRows.length, 32);

const directoryFit = await fitEntrySelectRelation({
  initial: zeroDirectoryProfile,
  rows: trainDirectoryRows,
  handwiredRoot,
  epochs,
  learningRate,
});

const regularFit = await fitEntrySelectRelation({
  initial: zeroRegularProfile,
  rows: trainRegularRows,
  handwiredRoot,
  epochs,
  learningRate,
});

const fittedEvalStarted = performance.now();
const fittedEvaluation = evaluateEntrySelectDataset(dataset, {
  directory: directoryFit.profile,
  regular: regularFit.profile,
});
const fittedEvalMs = performance.now() - fittedEvalStarted;

const runId = randomUUID();
const weightsDir = join(outputRoot, "weights", "filesystem", "entry-select", runId);
const samplesDir = join(outputRoot, "samples", "filesystem", "entry-select", runId);
const resultsDir = join(outputRoot, "results", "filesystem", "entry-select", runId);
await mkdir(weightsDir, { recursive: true });
await mkdir(samplesDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });

const directoryProfilePath = join(weightsDir, "directory-candidate.json");
const regularProfilePath = join(weightsDir, "file-candidate.json");
const samplesPath = join(samplesDir, "samples.json");
const reportPath = join(resultsDir, "report.json");
const latestReportPath = join(outputRoot, "latest-report.json");

await writeFile(directoryProfilePath, JSON.stringify(directoryFit.profile, null, 2) + "\n", "utf8");
await writeFile(regularProfilePath, JSON.stringify(regularFit.profile, null, 2) + "\n", "utf8");
await writeFile(samplesPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");

const preReloadAccepted = directoryFit.separatesAllBooleanCombinations
  && regularFit.separatesAllBooleanCombinations
  && fittedEvaluation.allPassed;
const boundedSyntheticVerificationPassed = fittedEvaluation.independentVerification.sets.passed
  && fittedEvaluation.independentVerification.candidates.passed
  && fittedEvaluation.probes.passed;

const report = {
  contract: "cli.entry-select-training.report.v1",
  runId,
  mode: "train",
  startedAt,
  completedAt: new Date().toISOString(),
  accepted: preReloadAccepted,
  reloadPassed: null,
  verificationScope: "bounded_synthetic_held_out",
  allEightFeatureVectorsSeenInTrain: true,
  unseenFeatureCapabilityVerified: false,
  boundedSyntheticVerificationPassed,
  fullyVerified: false,
  budget: {
    epochs,
    learningRate,
  },
  profiles: {
    directory: directoryFit.profile,
    regular: regularFit.profile,
  },
  units: {
    directory: {
      contract: directoryFit.profile.contract,
      initialWeights: directoryFit.initialProfile.weights,
      fittedWeights: directoryFit.profile.weights,
      threshold: directoryFit.profile.threshold,
      separatesAllBooleanCombinations: directoryFit.separatesAllBooleanCombinations,
      logitsByCombination: directoryFit.logitsByCombination,
      timing: directoryFit.timing,
      initialLoss: directoryFit.trajectory[0]?.loss ?? null,
      finalLoss: directoryFit.trajectory[directoryFit.trajectory.length - 1]?.loss ?? null,
      trajectory: directoryFit.trajectory,
    },
    regular: {
      contract: regularFit.profile.contract,
      initialWeights: regularFit.initialProfile.weights,
      fittedWeights: regularFit.profile.weights,
      threshold: regularFit.profile.threshold,
      separatesAllBooleanCombinations: regularFit.separatesAllBooleanCombinations,
      logitsByCombination: regularFit.logitsByCombination,
      timing: regularFit.timing,
      initialLoss: regularFit.trajectory[0]?.loss ?? null,
      finalLoss: regularFit.trajectory[regularFit.trajectory.length - 1]?.loss ?? null,
      trajectory: regularFit.trajectory,
    },
  },
  datasetValidation: validationSummary,
  controls: {
    zero: zeroControlEvaluation,
  },
  evaluation: fittedEvaluation,
  paths: {
    directoryProfile: directoryProfilePath,
    regularProfile: regularProfilePath,
    samples: samplesPath,
    report: reportPath,
  },
  timing: {
    datasetValidationMs,
    zeroEvalMs,
    directoryFitMs: directoryFit.timing.fitTotalMs,
    regularFitMs: regularFit.timing.fitTotalMs,
    fittedEvalMs,
    consumerMs: performance.now() - consumerStarted,
  },
  calibration: "uncalibrated",
  adoption: "not_applied",
};

await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
await writeFile(latestReportPath, JSON.stringify({
  runId,
  directoryProfilePath,
  regularProfilePath,
  samplesPath,
  reportPath,
}, null, 2) + "\n", "utf8");

const reloadStarted = performance.now();
const { stdout } = await execFileAsync(process.execPath, [
  fileURLToPath(new URL("./reload.mjs", import.meta.url)),
  "--output-root",
  outputRoot,
], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const reload = JSON.parse(stdout);
const reloadMs = performance.now() - reloadStarted;

const reloadPassed = reload.knownReplay?.passed === true
  && reload.independentVerification?.passed === true
  && reload.probes?.passed === true
  && reload.totals?.failed === 0;
const accepted = preReloadAccepted && reloadPassed;

report.accepted = accepted;
report.reloadPassed = reloadPassed;
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  runId,
  accepted,
  reloadPassed,
  verificationScope: report.verificationScope,
  allEightFeatureVectorsSeenInTrain: report.allEightFeatureVectorsSeenInTrain,
  unseenFeatureCapabilityVerified: report.unseenFeatureCapabilityVerified,
  boundedSyntheticVerificationPassed: report.boundedSyntheticVerificationPassed,
  fullyVerified: report.fullyVerified,
  exitCode: accepted ? 0 : 1,
  paths: {
    ...report.paths,
    reload: join(dirname(reportPath), "reload.json"),
    reloadRows: join(dirname(reportPath), "reload-rows.json"),
  },
  units: {
    directory: {
      weights: directoryFit.profile.weights,
      initialLoss: report.units.directory.initialLoss,
      finalLoss: report.units.directory.finalLoss,
      separatesAllBooleanCombinations: directoryFit.separatesAllBooleanCombinations,
    },
    regular: {
      weights: regularFit.profile.weights,
      initialLoss: report.units.regular.initialLoss,
      finalLoss: report.units.regular.finalLoss,
      separatesAllBooleanCombinations: regularFit.separatesAllBooleanCombinations,
    },
  },
  reload: {
    ...reload,
    reloadMs,
  },
  timing: {
    ...report.timing,
    reloadMs,
  },
  calibration: "uncalibrated",
  adoption: "not_applied",
}, null, 2));

if (!accepted) {
  process.exitCode = 1;
}
