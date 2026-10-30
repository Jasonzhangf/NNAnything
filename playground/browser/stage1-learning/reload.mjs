import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  readBrowserInputPolicyProfile,
  readBrowserQueryRelationProfile,
  readBrowserStepPolicyProfile
} from "../../../dist/filters/browser-stage1-policy.js";
import { evaluateBrowserStage1Cascade } from "../../../dist/training/browser-stage1-numeric.js";
import {
  partitionBrowserStage1Dataset,
  readBrowserStage1Dataset
} from "../../../dist/training/browser-stage1-samples.js";

function parseArgs(argv) {
  const args = {
    bundleRoot: "",
    assertUnfitted: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === "--bundle-root" || token === "--output-root") && argv[i + 1]) {
      args.bundleRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === "--assert-unfitted") {
      args.assertUnfitted = true;
    } else if (!token.startsWith("--") && !args.bundleRoot) {
      args.bundleRoot = path.resolve(token);
    }
  }
  if (!args.bundleRoot) {
    throw new Error("Usage: node reload.mjs --bundle-root <dir> [--assert-unfitted]");
  }
  return args;
}

function hasNonZeroWeight(weights) {
  return weights.some((row) => row.some((v) => v !== 0));
}

export function comparePerRowPredictions(actualPredictions, expectedPredictions) {
  if (!Array.isArray(actualPredictions) || !Array.isArray(expectedPredictions)) {
    return false;
  }
  if (actualPredictions.length === 0 || actualPredictions.length !== expectedPredictions.length) {
    return false;
  }
  for (let i = 0; i < actualPredictions.length; i += 1) {
    const actual = actualPredictions[i];
    const expected = expectedPredictions[i];
    if (
      !actual ||
      !expected ||
      actual.id !== expected.id ||
      actual.goldHead !== expected.goldHead ||
      actual.predictedHead !== expected.predictedHead ||
      actual.correct !== expected.correct
    ) {
      return false;
    }
  }
  return true;
}

export async function runStage1ReloadVerification({ bundleRoot, assertUnfitted = false }) {
  const reloadStart = performance.now();

  const readStart = performance.now();
  const [inputRaw, relationRaw, stepRaw, samplesRaw, reportRaw] = await Promise.all([
    fs.readFile(path.join(bundleRoot, "input-policy.json"), "utf8"),
    fs.readFile(path.join(bundleRoot, "query-relation.json"), "utf8"),
    fs.readFile(path.join(bundleRoot, "step-policy.json"), "utf8"),
    fs.readFile(path.join(bundleRoot, "samples.json"), "utf8"),
    fs.readFile(path.join(bundleRoot, "report.json"), "utf8")
  ]);

  const inputProfile = readBrowserInputPolicyProfile(JSON.parse(inputRaw));
  const relationProfile = readBrowserQueryRelationProfile(JSON.parse(relationRaw));
  const stepProfile = readBrowserStepPolicyProfile(JSON.parse(stepRaw));
  const dataset = readBrowserStage1Dataset(JSON.parse(samplesRaw));
  const report = JSON.parse(reportRaw);
  const partitioned = partitionBrowserStage1Dataset(dataset);
  const fileReadAndValidateMs = performance.now() - readStart;

  const expectUnfitted = assertUnfitted || report.epochs === 0;
  const reportFitted = {
    input: Boolean(report.units?.["B-S1.1"]?.fitted),
    relation: Boolean(report.units?.["B-S1.2"]?.fitted),
    step: Boolean(report.units?.["B-S1.3"]?.fitted)
  };
  if (expectUnfitted) {
    if (
      reportFitted.input ||
      reportFitted.relation ||
      reportFitted.step ||
      hasNonZeroWeight(inputProfile.weights) ||
      hasNonZeroWeight(relationProfile.weights) ||
      hasNonZeroWeight(stepProfile.weights)
    ) {
      throw new Error(
        `Expected unfitted profiles (fitted === false) in zero-epoch mode, got: ${JSON.stringify(reportFitted)}`
      );
    }
  } else {
    if (
      !reportFitted.input ||
      !reportFitted.relation ||
      !reportFitted.step ||
      !hasNonZeroWeight(inputProfile.weights) ||
      !hasNonZeroWeight(relationProfile.weights) ||
      !hasNonZeroWeight(stepProfile.weights)
    ) {
      throw new Error(
        `Expected fitted profiles (fitted === true) in trained mode, got: ${JSON.stringify(reportFitted)}`
      );
    }
  }

  for (const [unitId, profile] of [
    ["B-S1.1", inputProfile],
    ["B-S1.2", relationProfile],
    ["B-S1.3", stepProfile]
  ]) {
    if (profile.calibration !== "uncalibrated") {
      throw new Error(`${unitId} calibration must remain uncalibrated.`);
    }
    if (profile.adoption !== "not_applied") {
      throw new Error(`${unitId} adoption must remain not_applied.`);
    }
  }

  const profiles = {
    inputPolicy: inputProfile,
    queryRelation: relationProfile,
    stepPolicy: stepProfile
  };

  const trainEvalStart = performance.now();
  const trainEval = evaluateBrowserStage1Cascade(
    partitioned.train,
    profiles,
    expectUnfitted ? "zero_weights" : "learned_candidate"
  );
  const trainEvaluationMs = performance.now() - trainEvalStart;

  const devEvalStart = performance.now();
  const devEval = evaluateBrowserStage1Cascade(
    partitioned.development,
    profiles,
    expectUnfitted ? "zero_weights" : "learned_candidate"
  );
  const developmentEvaluationMs = performance.now() - devEvalStart;

  const buildUnitParity = (actualTrain, reportTrain, actualDev, reportDev) => {
    const trainAggregateMatchesReport =
      actualTrain.correct === reportTrain?.correct &&
      actualTrain.total === reportTrain?.total;
    const developmentAggregateMatchesReport =
      actualDev.correct === reportDev?.correct &&
      actualDev.total === reportDev?.total;
    const trainPerRowMatchesReport = comparePerRowPredictions(
      actualTrain.predictions,
      reportTrain?.predictions
    );
    const developmentPerRowMatchesReport = comparePerRowPredictions(
      actualDev.predictions,
      reportDev?.predictions
    );
    return {
      trainAggregateMatchesReport,
      developmentAggregateMatchesReport,
      trainPerRowMatchesReport,
      developmentPerRowMatchesReport,
      trainMatchesReport: trainAggregateMatchesReport && trainPerRowMatchesReport,
      developmentMatchesReport: developmentAggregateMatchesReport && developmentPerRowMatchesReport
    };
  };

  const parity = {
    "B-S1.1": buildUnitParity(
      trainEval.inputPolicy,
      report.units?.["B-S1.1"]?.train,
      devEval.inputPolicy,
      report.units?.["B-S1.1"]?.development
    ),
    "B-S1.2": buildUnitParity(
      trainEval.queryRelation,
      report.units?.["B-S1.2"]?.train,
      devEval.queryRelation,
      report.units?.["B-S1.2"]?.development
    ),
    "B-S1.3": buildUnitParity(
      trainEval.stepPolicyCascade,
      report.units?.["B-S1.3"]?.train,
      devEval.stepPolicyCascade,
      report.units?.["B-S1.3"]?.development
    )
  };

  const perRowParityMatched = Object.values(parity).every(
    (u) => u.trainPerRowMatchesReport && u.developmentPerRowMatchesReport
  );
  const allParityMatched = Object.values(parity).every(
    (u) => u.trainMatchesReport && u.developmentMatchesReport
  );
  if (!allParityMatched || !perRowParityMatched) {
    throw new Error(`Reload parity mismatch against report.json: ${JSON.stringify(parity)}`);
  }

  const totalReloadMs = performance.now() - reloadStart;
  const reloadReceipt = {
    schemaVersion: "browser.stage1.reload-receipt.v1",
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    bundleRoot,
    expectUnfitted,
    perRowParityMatched,
    allParityMatched,
    episodeCounts: {
      train: partitioned.train.episodes.length,
      development: partitioned.development.episodes.length,
      total: partitioned.dataset.episodes.length
    },
    profiles: {
      "B-S1.1": {
        contract: inputProfile.contract,
        fitted: reportFitted.input,
        calibration: inputProfile.calibration,
        adoption: inputProfile.adoption
      },
      "B-S1.2": {
        contract: relationProfile.contract,
        fitted: reportFitted.relation,
        calibration: relationProfile.calibration,
        adoption: relationProfile.adoption
      },
      "B-S1.3": {
        contract: stepProfile.contract,
        fitted: reportFitted.step,
        calibration: stepProfile.calibration,
        adoption: stepProfile.adoption
      }
    },
    parity,
    evaluation: {
      train: trainEval,
      development: devEval
    },
    timing: {
      fileReadAndValidateMs,
      trainEvaluationMs,
      developmentEvaluationMs,
      totalReloadMs,
      units: {
        inputPolicy: {
          trainEvaluationMs: trainEval.evaluationMs.inputPolicy,
          developmentEvaluationMs: devEval.evaluationMs.inputPolicy
        },
        queryRelation: {
          trainEvaluationMs: trainEval.evaluationMs.queryRelation,
          developmentEvaluationMs: devEval.evaluationMs.queryRelation
        },
        stepPolicy: {
          trainEvaluationMs: trainEval.evaluationMs.stepPolicy,
          developmentEvaluationMs: devEval.evaluationMs.stepPolicy
        }
      }
    }
  };

  const reloadPath = path.join(bundleRoot, "reload.json");
  await fs.writeFile(reloadPath, `${JSON.stringify(reloadReceipt, null, 2)}\n`, "utf8");
  return reloadReceipt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await runStage1ReloadVerification(args);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: receipt.pid,
      bundleRoot: args.bundleRoot,
      perRowParityMatched: receipt.perRowParityMatched,
      allParityMatched: receipt.allParityMatched
    })}\n`
  );
}
