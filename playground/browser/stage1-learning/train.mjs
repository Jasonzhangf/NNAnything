import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runBrowserStage1Training } from "../../../dist/nodes/browser-stage1-training.js";
import {
  buildBrowserStage1Dataset,
  enumerateBrowserStage1TruthTables,
  validateBrowserStage1Dataset
} from "../../../dist/training/browser-stage1-samples.js";
import { renderFamilyCDevSearchPage } from "../search-fixture/family-c-dev/page.mjs";

const execFileAsync = promisify(execFile);

const ALLOWED_FLAGS = new Set([
  "--mode",
  "--output-root",
  "--handwired-root",
  "--epochs",
  "--learning-rate"
]);

export function parseTrainCliArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("CLI argv must be an array");
  }
  const seen = new Set();
  const raw = {
    mode: undefined,
    outputRoot: undefined,
    handwiredRoot: undefined,
    epochs: undefined,
    learningRate: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !ALLOWED_FLAGS.has(token)) {
      throw new TypeError(`Unknown or unsupported CLI argument: ${String(token)}`);
    }
    if (seen.has(token)) {
      throw new TypeError(`Duplicate CLI argument: ${token}`);
    }
    const next = argv[i + 1];
    if (typeof next !== "string" || next.trim().length === 0 || next.startsWith("--")) {
      throw new TypeError(`Missing value for CLI argument: ${token}`);
    }
    seen.add(token);
    i += 1;
    if (token === "--mode") {
      raw.mode = next;
    } else if (token === "--output-root") {
      raw.outputRoot = path.resolve(next);
    } else if (token === "--handwired-root") {
      raw.handwiredRoot = path.resolve(next);
    } else if (token === "--epochs") {
      raw.epochs = Number(next);
    } else if (token === "--learning-rate") {
      raw.learningRate = Number(next);
    }
  }

  if (raw.mode !== "validate-only" && raw.mode !== "train") {
    throw new TypeError(
      `Explicit --mode <validate-only|train> is required; got ${String(raw.mode)}`
    );
  }
  if (!raw.outputRoot) {
    throw new TypeError("Explicit --output-root <dir> is required");
  }

  if (raw.mode === "validate-only") {
    if (raw.handwiredRoot !== undefined) {
      throw new TypeError("--handwired-root must not be passed in --mode validate-only");
    }
    if (raw.epochs !== undefined && raw.epochs !== 0) {
      throw new TypeError(
        `--mode validate-only requires zero fitting (epochs=0); got --epochs ${String(raw.epochs)}`
      );
    }
    if (
      raw.learningRate !== undefined &&
      (!Number.isFinite(raw.learningRate) || raw.learningRate < 0)
    ) {
      throw new TypeError(`Invalid --learning-rate in validate-only mode: ${String(raw.learningRate)}`);
    }
    return {
      mode: "validate-only",
      outputRoot: raw.outputRoot,
      handwiredRoot: "",
      epochs: 0,
      learningRate: 0
    };
  }

  // Formal training mode: contract requires explicit --handwired-root, --epochs 200, --learning-rate 0.1, --output-root
  if (!raw.handwiredRoot) {
    throw new TypeError("Formal --mode train requires explicit --handwired-root <dir>");
  }
  if (raw.epochs !== 200) {
    throw new TypeError(
      `Formal --mode train requires explicit --epochs 200 (fixed recipe); got ${String(raw.epochs)}`
    );
  }
  if (raw.learningRate !== 0.1) {
    throw new TypeError(
      `Formal --mode train requires explicit --learning-rate 0.1 (fixed recipe); got ${String(raw.learningRate)}`
    );
  }

  return {
    mode: "train",
    outputRoot: raw.outputRoot,
    handwiredRoot: raw.handwiredRoot,
    epochs: 200,
    learningRate: 0.1
  };
}

function smokeCheckFamilyCDevRenderer() {
  const html = renderFamilyCDevSearchPage({
    query: "quartz",
    corpusKey: "sparse",
    batchStage: 1,
    hasMore: "true",
    terminalBannerVisible: false
  });
  const checks = {
    hasGridCollection: html.includes('id="grid-main-collection"'),
    hasGridCard: html.includes('class="grid-card"'),
    hasRequestState: html.includes('id="request-state"'),
    hasScrollBox: html.includes('id="result-scroll-box"'),
    hasLoadMore: html.includes('id="load-more"'),
    hasTerminalBanner: html.includes('id="collection-terminal-banner"'),
    hasLongFooterSpacer: html.includes('id="long-footer-spacer"')
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) {
    throw new Error(`Family C Dev card-grid renderer smoke check failed: ${JSON.stringify(checks)}`);
  }
  return {
    ok,
    familyId: "BF_DEV_F6B_family_c_grid",
    checks
  };
}

async function spawnChildReload(bundleRoot, assertUnfitted) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const reloadScript = path.join(currentDir, "reload.mjs");
  const args = [reloadScript, "--bundle-root", bundleRoot];
  if (assertUnfitted) {
    args.push("--assert-unfitted");
  }
  const { stdout } = await execFileAsync(process.execPath, args);
  return JSON.parse(stdout.trim());
}

export async function finalizeFormalStage1TrainingRun({
  outputRoot,
  bundle,
  runReload = spawnChildReload
}) {
  const reportPath = path.join(outputRoot, "report.json");
  const baseAssessment = bundle.report.assessment;

  if (!baseAssessment || baseAssessment.trainDev100PercentPassed !== true) {
    const failedAssessment = {
      ...(baseAssessment ?? {}),
      mode: "formal_training",
      acceptanceStatus: "REJECTED_TRAIN_DEV_GATE_FAILED",
      trainDev100PercentPassed: false,
      reloadConsistencyPassed: null,
      acceptedForDownstreamEvaluation: false,
      downstreamStatus: {
        reloadVerification: "not_run",
        independentEvaluation: "not_run",
        nativeAcceptance: "not_run"
      }
    };
    const updatedReport = {
      ...bundle.report,
      assessment: failedAssessment
    };
    await fs.writeFile(reportPath, `${JSON.stringify(updatedReport, null, 2)}\n`, "utf8");
    const err = new Error(
      `Stage 1 train/development 100% acceptance gate failed (${JSON.stringify(failedAssessment.failedUnits ?? [])}); candidate and report preserved at ${outputRoot}; independent evaluation and native acceptance marked not_run`
    );
    err.code = "STAGE1_TRAIN_DEV_GATE_FAILED";
    err.report = updatedReport;
    throw err;
  }

  let childReloadResult;
  try {
    childReloadResult = await runReload(outputRoot, false);
  } catch (reloadError) {
    const failedReloadAssessment = {
      ...baseAssessment,
      mode: "formal_training",
      acceptanceStatus: "REJECTED_RELOAD_PARITY_FAILED",
      trainDev100PercentPassed: true,
      reloadConsistencyPassed: false,
      acceptedForDownstreamEvaluation: false,
      downstreamStatus: {
        reloadVerification: "failed",
        independentEvaluation: "not_run",
        nativeAcceptance: "not_run"
      }
    };
    const updatedReport = {
      ...bundle.report,
      assessment: failedReloadAssessment
    };
    await fs.writeFile(reportPath, `${JSON.stringify(updatedReport, null, 2)}\n`, "utf8");
    const err = new Error(
      `Stage 1 child-process reload consistency gate failed: ${reloadError instanceof Error ? reloadError.message : String(reloadError)}; candidate and report preserved at ${outputRoot}; independent evaluation and native acceptance marked not_run`
    );
    err.code = "STAGE1_RELOAD_PARITY_GATE_FAILED";
    err.report = updatedReport;
    throw err;
  }

  if (
    !childReloadResult ||
    childReloadResult.allParityMatched !== true ||
    childReloadResult.perRowParityMatched !== true
  ) {
    const failedReloadAssessment = {
      ...baseAssessment,
      mode: "formal_training",
      acceptanceStatus: "REJECTED_RELOAD_PARITY_FAILED",
      trainDev100PercentPassed: true,
      reloadConsistencyPassed: false,
      acceptedForDownstreamEvaluation: false,
      downstreamStatus: {
        reloadVerification: "failed",
        independentEvaluation: "not_run",
        nativeAcceptance: "not_run"
      }
    };
    const updatedReport = {
      ...bundle.report,
      assessment: failedReloadAssessment
    };
    await fs.writeFile(reportPath, `${JSON.stringify(updatedReport, null, 2)}\n`, "utf8");
    const err = new Error(
      `Stage 1 reload per-row prediction parity did not match report.json; candidate and report preserved at ${outputRoot}; independent evaluation and native acceptance marked not_run`
    );
    err.code = "STAGE1_RELOAD_PARITY_GATE_FAILED";
    err.report = updatedReport;
    throw err;
  }

  const passedAssessment = {
    ...baseAssessment,
    mode: "formal_training",
    acceptanceStatus: "TRAIN_DEV_AND_RELOAD_PASSED",
    trainDev100PercentPassed: true,
    reloadConsistencyPassed: true,
    acceptedForDownstreamEvaluation: true,
    downstreamStatus: {
      reloadVerification: "passed",
      independentEvaluation: "not_run",
      nativeAcceptance: "not_run"
    }
  };
  const updatedReport = {
    ...bundle.report,
    assessment: passedAssessment
  };
  await fs.writeFile(reportPath, `${JSON.stringify(updatedReport, null, 2)}\n`, "utf8");

  return {
    childReloadResult,
    updatedReport
  };
}

async function runValidateOnlyMode(options) {
  await fs.mkdir(options.outputRoot, { recursive: true });

  const familyCDevGridSmoke = smokeCheckFamilyCDevRenderer();
  const dataset = buildBrowserStage1Dataset();
  const validation = validateBrowserStage1Dataset(dataset);
  if (!validation.ok) {
    throw new Error(`Stage 1 dataset validation failed: ${JSON.stringify(validation)}`);
  }

  const wireReceipt = enumerateBrowserStage1TruthTables();
  if (!wireReceipt.allSeparable || wireReceipt.totalCollisions !== 0) {
    throw new Error(`Stage 1 truth-table enumeration failed: ${JSON.stringify(wireReceipt)}`);
  }
  const wireEnumerationReceiptPath = path.join(
    options.outputRoot,
    "wire-enumeration-receipt.json"
  );
  await fs.writeFile(
    wireEnumerationReceiptPath,
    `${JSON.stringify(wireReceipt, null, 2)}\n`,
    "utf8"
  );

  const zeroEpochProbeRoot = path.join(
    options.outputRoot,
    "public-workflow-zero-epoch-probe"
  );
  const bundle = await runBrowserStage1Training({
    dataset,
    epochs: 0,
    learningRate: 0,
    outputRoot: zeroEpochProbeRoot
  });

  const timingUnits = bundle.report.timing.units;
  const handwiredLoaded =
    timingUnits.inputPolicy.handwiredLoaded ||
    timingUnits.queryRelation.handwiredLoaded ||
    timingUnits.stepPolicy.handwiredLoaded;
  const weightsUpdated =
    bundle.fitted.inputPolicy ||
    bundle.fitted.queryRelation ||
    bundle.fitted.stepPolicy ||
    timingUnits.inputPolicy.parameterUpdateCount > 0 ||
    timingUnits.queryRelation.parameterUpdateCount > 0 ||
    timingUnits.stepPolicy.parameterUpdateCount > 0;

  if (handwiredLoaded || weightsUpdated) {
    throw new Error(
      `Validate-only zero-epoch probe must not load Handwired or update weights: handwiredLoaded=${handwiredLoaded}, weightsUpdated=${weightsUpdated}`
    );
  }
  if (
    bundle.report.assessment.mode !== "zero_epoch_preparation" ||
    bundle.report.assessment.acceptanceStatus !== "NON_ACCEPTANCE_ZERO_EPOCH_PREP" ||
    bundle.report.assessment.trainDev100PercentPassed !== false ||
    bundle.report.assessment.acceptedForDownstreamEvaluation !== false ||
    bundle.report.assessment.downstreamStatus.independentEvaluation !== "not_run" ||
    bundle.report.assessment.downstreamStatus.nativeAcceptance !== "not_run"
  ) {
    throw new Error(
      `Validate-only zero-epoch probe must remain explicitly non-acceptance: ${JSON.stringify(bundle.report.assessment)}`
    );
  }

  const childReloadResult = await spawnChildReload(zeroEpochProbeRoot, true);

  const validationReceipt = {
    schemaVersion: "browser.stage1.validation-receipt.v1",
    generatedAt: new Date().toISOString(),
    mode: "validate-only",
    epochsExecuted: 0,
    weightsUpdated: false,
    handwiredLoaded: false,
    acceptanceStatus: bundle.report.assessment.acceptanceStatus,
    acceptedForDownstreamEvaluation: false,
    downstreamStatus: bundle.report.assessment.downstreamStatus,
    trainEpisodeCount: validation.trainEpisodeCount,
    developmentEpisodeCount: validation.developmentEpisodeCount,
    totalEpisodeCount: validation.totalEpisodeCount,
    heldOutEpisodesInDataset: validation.heldOutEpisodesInDataset,
    forbiddenHeldOutImportsPresent: validation.forbiddenHeldOutImportsPresent,
    unitRowCounts: validation.unitRowCounts,
    uniqueWireVectors: validation.uniqueWireVectors,
    collisionCount: validation.collisionCount,
    familyEpisodeCounts: validation.familyEpisodeCounts,
    familyCDevGridSmoke,
    wireEnumerationReceiptPath,
    publicWorkflowZeroEpochProbe: {
      outputRoot: zeroEpochProbeRoot,
      workflowId: bundle.workflowId,
      workflowVersion: bundle.workflowVersion,
      nodeOrder: bundle.nodeOrder,
      fitted: {
        "B-S1.1": bundle.fitted.inputPolicy,
        "B-S1.2": bundle.fitted.queryRelation,
        "B-S1.3": bundle.fitted.stepPolicy
      },
      assessment: bundle.report.assessment,
      reloadChildPid: childReloadResult.pid,
      reloadPerRowParityMatched: childReloadResult.perRowParityMatched,
      reloadReceiptPath: path.join(zeroEpochProbeRoot, "reload.json")
    }
  };

  const validationReceiptPath = path.join(options.outputRoot, "validation-receipt.json");
  await fs.writeFile(
    validationReceiptPath,
    `${JSON.stringify(validationReceipt, null, 2)}\n`,
    "utf8"
  );
  return validationReceipt;
}

async function runTrainMode(options) {
  await fs.mkdir(options.outputRoot, { recursive: true });
  const familyCDevGridSmoke = smokeCheckFamilyCDevRenderer();
  const dataset = buildBrowserStage1Dataset();
  const validation = validateBrowserStage1Dataset(dataset);
  if (!validation.ok) {
    throw new Error(`Stage 1 dataset validation failed: ${JSON.stringify(validation)}`);
  }

  const wireReceipt = enumerateBrowserStage1TruthTables();
  const wireEnumerationReceiptPath = path.join(
    options.outputRoot,
    "wire-enumeration-receipt.json"
  );
  await fs.writeFile(
    wireEnumerationReceiptPath,
    `${JSON.stringify(wireReceipt, null, 2)}\n`,
    "utf8"
  );

  const bundle = await runBrowserStage1Training({
    dataset,
    epochs: options.epochs,
    learningRate: options.learningRate,
    outputRoot: options.outputRoot,
    handwiredRoot: options.handwiredRoot
  });

  const { childReloadResult, updatedReport } = await finalizeFormalStage1TrainingRun({
    outputRoot: options.outputRoot,
    bundle,
    runReload: spawnChildReload
  });

  return {
    mode: "train",
    epochsExecuted: options.epochs,
    outputRoot: options.outputRoot,
    workflowId: bundle.workflowId,
    workflowVersion: bundle.workflowVersion,
    nodeOrder: bundle.nodeOrder,
    assessment: updatedReport.assessment,
    familyCDevGridSmoke,
    wireEnumerationReceiptPath,
    reloadChildPid: childReloadResult.pid,
    reloadPerRowParityMatched: childReloadResult.perRowParityMatched,
    reloadReceiptPath: path.join(options.outputRoot, "reload.json")
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseTrainCliArgs(process.argv.slice(2));
  const result =
    options.mode === "validate-only"
      ? await runValidateOnlyMode(options)
      : await runTrainMode(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
