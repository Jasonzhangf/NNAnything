#!/usr/bin/env node
// W0a-Prep-1B Stage 1 sequential cascade trainer & subprocess reload verifier.
//
// Strictly follows Section 4.1 & 4.2 & 6.3(1):
// - Physically has NO --verification-path option; never reads verification split.
// - Step A: fit Unit W0-Role (11x36 = 396 parameters) for 200 epochs, lr=0.1,
//   save <outDir>/weights/role-policy.w0a.json.
// - Step B: spawn a fresh Node subprocess to reload role-policy.w0a.json from disk,
//   verify perRowParityMatched === true && maxAbsScoreDiff === 0 on train + dev,
//   and emit frozen cascaded predictions (predRole, predRoleStatus) without goldRole.
// - Step C: extract 32-dim relation wires using Step B's cascaded role predictions,
//   fit Unit W0-Rel (9x32 = 288 parameters) for 200 epochs, lr=0.1,
//   save <outDir>/weights/relation-policy.w0a.json.
// - Step D: spawn a fresh Node subprocess to reload BOTH role-policy.w0a.json and
//   relation-policy.w0a.json from disk, verify perRowParityMatched === true &&
//   maxAbsScoreDiff === 0 on train + dev, and check Table 4.2 Stage 1 thresholds.
// - If any step fails, preserve all generated artifacts, write stage1-training-report.json
//   with subsequent steps marked status: "not_run", and exit non-zero (exit 1).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_ROLE_WIRES,
  WEIBO_W0A_RELATION_WIRES,
} from "../../../../dist/filters/weibo-filtered-dom-contract.js";
import {
  resolveRetainedNodesMap,
  extractWeiboRoleWires36,
  generateWeiboCandidatePairs,
  extractWeiboRelationWires32,
  predictWeiboNodeRole,
  predictWeiboPairRelation,
} from "../../../../dist/filters/weibo-filtered-dom-w0a.js";
import { loadHandwired } from "../../../../dist/training/handwired.js";
import { buildLinearPolicyCircuit } from "../../../../dist/nodes/trainable/linear-policy.js";
import {
  validateW0aDataset,
  assertConsistentSnapshotGold,
  resolveConsistentCandidatePairGold,
} from "./validate-w0a-dataset.mjs";
import {
  STAGE1_THRESHOLDS,
  evaluateW0aSnapshots,
  checkMetricsAgainstThresholds,
  validateRolePolicyProfile,
  validateRelationPolicyProfile,
} from "./evaluate-w0a-independent.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);

export const W0A_FIXED_HYPERPARAMETERS = Object.freeze({
  epochs: 200,
  learningRate: 0.1,
  momentum: 0,
  l2: 0,
  minScore: 0.6,
  minMargin: 0.15,
});

function readSnapshotsFile(filePath, label) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.snapshots)) return raw.snapshots;
  if (raw && typeof raw === "object" && Array.isArray(raw.slots)) return [raw];
  throw new Error(`Invalid snapshots file for ${label} at ${filePath}`);
}

function zeroMatrix(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
}

function extractRoleTrainingRows(snapshots, heads, wires) {
  const rows = [];
  for (let sIdx = 0; sIdx < snapshots.length; sIdx += 1) {
    const snap = snapshots[sIdx];
    const snapId = snap.snapshotId ?? `snap-${sIdx}`;
    assertConsistentSnapshotGold(snap, snapId);
    const allSlotsByRef = new Map();
    for (const s of snap.slots ?? []) allSlotsByRef.set(s.nodeRef, s);
    const resolvedMap = resolveRetainedNodesMap({
      slots: snap.slots,
      retainedNodes: snap.retainedNodes ?? [],
    });
    for (const rNode of snap.retainedNodes ?? []) {
      const ann = rNode.roleAnnotation;
      if (!ann || ann.reviewStatus !== "confirmed_gold" || !ann.goldRole) continue;
      const expectedIndex = heads.indexOf(ann.goldRole);
      if (expectedIndex < 0) {
        throw new Error(`Unknown goldRole ${ann.goldRole} on ${rNode.nodeRef}`);
      }
      const wObj = extractWeiboRoleWires36(rNode.nodeRef, resolvedMap, allSlotsByRef);
      const features = wires.map((w) => wObj[w] ?? 0);
      rows.push({
        snapshotId: snapId,
        nodeRef: rNode.nodeRef,
        features,
        expectedIndex,
      });
    }
  }
  return rows;
}

function extractRelationTrainingRows(
  snapshots,
  cascadedRolePredsBySnapshot,
  heads,
  wires,
) {
  const rows = [];
  for (let sIdx = 0; sIdx < snapshots.length; sIdx += 1) {
    const snap = snapshots[sIdx];
    const snapId = snap.snapshotId ?? `snap-${sIdx}`;
    const resolvedMap = resolveRetainedNodesMap({
      slots: snap.slots,
      retainedNodes: snap.retainedNodes ?? [],
    });
    const rolePredsByRef = cascadedRolePredsBySnapshot.get(snapId);
    if (!rolePredsByRef) {
      throw new Error(`Missing cascaded role predictions for snapshot ${snapId}`);
    }
    const pairGen = generateWeiboCandidatePairs(resolvedMap);
    const candKeySet = new Set(
      pairGen.candidatePairs.map((c) => `${c.sourceRef}->${c.targetRef}`),
    );
    assertConsistentSnapshotGold(snap, snapId, candKeySet);

    const indepGoldByKey = new Map();
    for (const edge of snap.independentGoldRelations ?? []) {
      if (edge.reviewStatus === "confirmed_gold") {
        indepGoldByKey.set(`${edge.sourceRef}->${edge.targetRef}`, edge.relation);
      }
    }
    const pairAnnByKey = new Map();
    for (const pa of snap.candidatePairAnnotations ?? []) {
      pairAnnByKey.set(`${pa.sourceRef}->${pa.targetRef}`, pa);
    }

    for (const cand of pairGen.candidatePairs) {
      const key = `${cand.sourceRef}->${cand.targetRef}`;
      const goldRel = resolveConsistentCandidatePairGold(
        key,
        indepGoldByKey,
        pairAnnByKey,
        snapId,
      );
      if (goldRel === null) continue;
      const expectedIndex = heads.indexOf(goldRel);
      if (expectedIndex < 0) {
        throw new Error(`Unknown goldRelation ${goldRel} on pair ${key}`);
      }
      const wObj = extractWeiboRelationWires32(cand, resolvedMap, rolePredsByRef);
      const features = wires.map((w) => wObj[w] ?? 0);
      rows.push({
        snapshotId: snapId,
        sourceRef: cand.sourceRef,
        targetRef: cand.targetRef,
        features,
        expectedIndex,
      });
    }
  }
  return rows;
}

function fitLinearPolicyWithHandwired({
  handwiredModule,
  heads,
  wires,
  rows,
  epochs,
  learningRate,
  featureExtractionMs,
}) {
  if (rows.length === 0) {
    throw new Error("Training rows must be non-empty");
  }
  const classCount = heads.length;
  const featureCount = wires.length;
  const parameterCount = classCount * featureCount;

  const circuitStart = performance.now();
  const graph = buildLinearPolicyCircuit(handwiredModule, classCount, featureCount);
  const circuitBuildMs = performance.now() - circuitStart;

  let weights = new Float32Array(parameterCount);
  let forwardTotalMs = 0;
  let lossTotalMs = 0;
  let backwardTotalMs = 0;
  let parameterUpdateTotalMs = 0;
  const trajectory = [];

  const epochsStart = performance.now();
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = new Float64Array(parameterCount);
    let totalLoss = 0;

    for (const row of rows) {
      const fwdStart = performance.now();
      const source = new Float32Array(graph.circuit.sourceSize);
      for (let i = 0; i < parameterCount; i += 1) {
        source[graph.parameters[i]] = weights[i];
      }
      for (let j = 0; j < featureCount; j += 1) {
        source[graph.features[j]] = Math.fround(row.features[j]);
      }
      const values = graph.circuit.evaluateReference(source);
      const logits = graph.logits.map((wire) => values[wire]);
      forwardTotalMs += performance.now() - fwdStart;

      const lossStart = performance.now();
      const maxLogit = Math.max(...logits);
      const exps = logits.map((l) => Math.exp(l - maxLogit));
      const sumExp = exps.reduce((a, b) => a + b, 0);
      const loss = Math.log(sumExp) + maxLogit - logits[row.expectedIndex];
      if (!Number.isFinite(loss)) {
        throw new Error(`Non-finite loss at epoch ${epoch + 1}`);
      }
      totalLoss += loss;
      lossTotalMs += performance.now() - lossStart;

      const bwdStart = performance.now();
      const outputGradient = new Float32Array(values.length);
      for (let c = 0; c < classCount; c += 1) {
        outputGradient[graph.logits[c]] = Math.fround(
          exps[c] / sumExp - (c === row.expectedIndex ? 1 : 0),
        );
      }
      const sourceGradient = graph.circuit.backpropagateReference(
        values,
        outputGradient,
      );
      for (let i = 0; i < parameterCount; i += 1) {
        gradient[i] += sourceGradient[graph.parameters[i]];
      }
      backwardTotalMs += performance.now() - bwdStart;
    }

    const updStart = performance.now();
    const nextWeights = new Float32Array(parameterCount);
    for (let i = 0; i < parameterCount; i += 1) {
      nextWeights[i] =
        gradient[i] === 0
          ? weights[i]
          : Math.fround(weights[i] - (learningRate * gradient[i]) / rows.length);
      if (!Number.isFinite(nextWeights[i])) {
        throw new Error(`Non-finite weight update at epoch ${epoch + 1}`);
      }
    }
    weights = nextWeights;
    parameterUpdateTotalMs += performance.now() - updStart;

    const meanLoss = totalLoss / rows.length;
    if (epoch === 0 || epoch === epochs - 1 || (epoch + 1) % 25 === 0) {
      trajectory.push({ epoch: epoch + 1, loss: meanLoss });
    }
  }
  const totalEpochsMs = performance.now() - epochsStart;
  const perEpochMeanMs = epochs > 0 ? totalEpochsMs / epochs : 0;

  const matrix = [];
  for (let c = 0; c < classCount; c += 1) {
    const row = [];
    for (let f = 0; f < featureCount; f += 1) {
      row.push(Number(weights[c * featureCount + f]));
    }
    matrix.push(row);
  }

  return {
    weightsMatrix: matrix,
    trajectory,
    initialLoss: trajectory[0]?.loss ?? null,
    finalLoss: trajectory[trajectory.length - 1]?.loss ?? null,
    partialTiming: {
      featureExtractionMs,
      circuitBuildMs,
      forwardTotalMs,
      lossTotalMs,
      backwardTotalMs,
      parameterUpdateTotalMs,
      perEpochMeanMs,
    },
  };
}

function computeInProcessRolePredictions(snapshots, roleProfile) {
  const bySnap = new Map();
  for (let sIdx = 0; sIdx < snapshots.length; sIdx += 1) {
    const snap = snapshots[sIdx];
    const snapId = snap.snapshotId ?? `snap-${sIdx}`;
    const allSlotsByRef = new Map();
    for (const s of snap.slots ?? []) allSlotsByRef.set(s.nodeRef, s);
    const resolvedMap = resolveRetainedNodesMap({
      slots: snap.slots,
      retainedNodes: snap.retainedNodes ?? [],
    });
    const nodePreds = new Map();
    for (const rNode of snap.retainedNodes ?? []) {
      const wires36 = extractWeiboRoleWires36(
        rNode.nodeRef,
        resolvedMap,
        allSlotsByRef,
      );
      const pred = predictWeiboNodeRole(rNode.nodeRef, wires36, roleProfile);
      nodePreds.set(rNode.nodeRef, pred);
    }
    bySnap.set(snapId, nodePreds);
  }
  return bySnap;
}

function compareRolePredictionsParity(inProcBySnap, subprocOutBySnap) {
  let perRowParityMatched = true;
  let maxAbsScoreDiff = 0;
  let rowCount = 0;
  for (const [snapId, nodePreds] of inProcBySnap.entries()) {
    const subMap = subprocOutBySnap.get(snapId);
    if (!subMap) {
      perRowParityMatched = false;
      continue;
    }
    for (const [nodeRef, inPred] of nodePreds.entries()) {
      const subPred = subMap.get(nodeRef);
      if (!subPred) {
        perRowParityMatched = false;
        continue;
      }
      rowCount += 1;
      if (
        inPred.roleStatus !== subPred.roleStatus ||
        inPred.predRole !== subPred.predRole
      ) {
        perRowParityMatched = false;
      }
      const diffTop = Math.abs(inPred.topScore - subPred.topScore);
      const diffMargin = Math.abs(inPred.margin - subPred.margin);
      if (diffTop > maxAbsScoreDiff) maxAbsScoreDiff = diffTop;
      if (diffMargin > maxAbsScoreDiff) maxAbsScoreDiff = diffMargin;
      for (const h of WEIBO_W0A_ROLE_HEADS) {
        const dL = Math.abs((inPred.logits[h] ?? 0) - (subPred.logits[h] ?? 0));
        if (dL > maxAbsScoreDiff) maxAbsScoreDiff = dL;
      }
    }
  }
  return { perRowParityMatched: perRowParityMatched && maxAbsScoreDiff === 0, maxAbsScoreDiff, rowCount };
}

function compareEvalRelationParity(inProcEval, subprocEval) {
  let perRowParityMatched = true;
  let maxAbsScoreDiff = 0;
  let rowCount = 0;
  const subSnapMap = new Map();
  for (const sp of subprocEval.perSnapshotPredictions ?? []) {
    subSnapMap.set(sp.snapshotId, sp);
  }
  for (const inSp of inProcEval.perSnapshotPredictions ?? []) {
    const subSp = subSnapMap.get(inSp.snapshotId);
    if (!subSp) {
      perRowParityMatched = false;
      continue;
    }
    const subRelMap = new Map();
    for (const rp of subSp.relationPredictions ?? []) {
      subRelMap.set(`${rp.sourceRef}->${rp.targetRef}`, rp);
    }
    for (const inRp of inSp.relationPredictions ?? []) {
      const key = `${inRp.sourceRef}->${inRp.targetRef}`;
      const subRp = subRelMap.get(key);
      if (!subRp) {
        perRowParityMatched = false;
        continue;
      }
      rowCount += 1;
      if (
        inRp.relationStatus !== subRp.relationStatus ||
        inRp.predRelation !== subRp.predRelation ||
        inRp.actionableWrapperRef !== subRp.actionableWrapperRef
      ) {
        perRowParityMatched = false;
      }
      const diffTop = Math.abs(inRp.topScore - subRp.topScore);
      const diffMargin = Math.abs(inRp.margin - subRp.margin);
      if (diffTop > maxAbsScoreDiff) maxAbsScoreDiff = diffTop;
      if (diffMargin > maxAbsScoreDiff) maxAbsScoreDiff = diffMargin;
      for (const h of WEIBO_W0A_RELATION_HEADS) {
        const dL = Math.abs((inRp.logits[h] ?? 0) - (subRp.logits[h] ?? 0));
        if (dL > maxAbsScoreDiff) maxAbsScoreDiff = dL;
      }
    }
  }
  return { perRowParityMatched: perRowParityMatched && maxAbsScoreDiff === 0, maxAbsScoreDiff, rowCount };
}

// Subprocess worker mode for Step B and Step D
function runSubprocessWorker(mode, options) {
  const trainSnapshots = readSnapshotsFile(options.trainPath, "train");
  const devSnapshots = readSnapshotsFile(options.devPath, "dev");
  const roleProfile = validateRolePolicyProfile(
    JSON.parse(readFileSync(options.roleWeights, "utf8")),
  );

  if (mode === "stepB_role") {
    const serializeSnapMap = (map) => {
      const obj = {};
      for (const [snapId, nodeMap] of map.entries()) {
        obj[snapId] = Object.fromEntries(nodeMap.entries());
      }
      return obj;
    };
    const trainPreds = computeInProcessRolePredictions(trainSnapshots, roleProfile);
    const devPreds = computeInProcessRolePredictions(devSnapshots, roleProfile);
    writeFileSync(
      options.subprocOut,
      JSON.stringify({
        trainRolePredictions: serializeSnapMap(trainPreds),
        devRolePredictions: serializeSnapMap(devPreds),
      }),
      "utf8",
    );
    return;
  }

  if (mode === "stepD_both") {
    const relationProfile = validateRelationPolicyProfile(
      JSON.parse(readFileSync(options.relationWeights, "utf8")),
    );
    const trainEval = evaluateW0aSnapshots({
      snapshots: trainSnapshots,
      roleProfile,
      relationProfile,
    });
    const devEval = evaluateW0aSnapshots({
      snapshots: devSnapshots,
      roleProfile,
      relationProfile,
    });
    writeFileSync(
      options.subprocOut,
      JSON.stringify({
        trainEval,
        devEval,
      }),
      "utf8",
    );
    return;
  }
}

function deserializeSnapPredMap(rawObj) {
  const outer = new Map();
  for (const [snapId, innerObj] of Object.entries(rawObj ?? {})) {
    const inner = new Map();
    for (const [nodeRef, pred] of Object.entries(innerObj ?? {})) {
      inner.set(nodeRef, pred);
    }
    outer.set(snapId, inner);
  }
  return outer;
}

export async function runW0aStage1Training({
  trainPath,
  devPath,
  handwiredRoot,
  outDir,
  allowSyntheticEngineeringSmoke = false,
  roleWeightsMutatorForTest = null,
}) {
  if (!handwiredRoot || typeof handwiredRoot !== "string") {
    throw new Error("W0A_HANDWIRED_ROOT_REQUIRED: --handwired-root must be an explicit valid path");
  }
  // Verify handwired loads upfront before proceeding
  const handwiredModule = await loadHandwired(handwiredRoot);

  mkdirSync(outDir, { recursive: true });
  const weightsDir = join(outDir, "weights");
  mkdirSync(weightsDir, { recursive: true });

  const validationReportPath = join(outDir, "dataset-validation.report.json");
  const stage1ReportPath = join(outDir, "stage1-training-report.json");
  const roleWeightsPath = join(weightsDir, "role-policy.w0a.json");
  const relationWeightsPath = join(weightsDir, "relation-policy.w0a.json");

  const trainSnapshots = readSnapshotsFile(trainPath, "train-path");
  const devSnapshots = readSnapshotsFile(devPath, "dev-path");

  const runKind = allowSyntheticEngineeringSmoke
    ? "synthetic_engineering_smoke_only"
    : "formal_weibo_training";
  const formalBenchmarkEligible = !allowSyntheticEngineeringSmoke;

  const stepsStatus = {
    datasetValidation: { status: "not_run" },
    stepA_roleFit: { status: "not_run" },
    stepB_roleReloadAndCascade: { status: "not_run" },
    stepC_relationFit: { status: "not_run" },
    stepD_fullReloadAndStage1Gate: { status: "not_run" },
  };

  const writeReportAndReturn = (stage1Passed, failureReason = null, extra = {}) => {
    const report = {
      kind: "nnanything.w0a.stage1-training-report.v1",
      runKind,
      formalBenchmarkEligible,
      allowSyntheticEngineeringSmoke,
      oneShotHoldoutConsumed: false,
      stage1Passed,
      failureReason,
      trainPath: resolve(trainPath),
      devPath: resolve(devPath),
      hyperparameters: W0A_FIXED_HYPERPARAMETERS,
      steps: stepsStatus,
      ...extra,
    };
    writeFileSync(stage1ReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  };

  // 0. Dataset validation
  const validationReport = validateW0aDataset({
    trainSnapshots,
    devSnapshots,
    allowSyntheticEngineeringSmoke,
  });
  writeFileSync(
    validationReportPath,
    `${JSON.stringify(validationReport, null, 2)}\n`,
    "utf8",
  );
  if (!validationReport.valid) {
    stepsStatus.datasetValidation = {
      status: "failed",
      violationCount: validationReport.violations.length,
      violations: validationReport.violations,
    };
    return writeReportAndReturn(false, "DATASET_VALIDATION_FAILED", {
      datasetValidationReportPath: validationReportPath,
    });
  }
  stepsStatus.datasetValidation = {
    status: "passed",
    splitStats: validationReport.splitStats,
  };

  // Step A: Fit Unit W0-Role (11x36 = 396 parameters)
  const roleWallStart = performance.now();
  let roleProfile;
  let roleFitInfo;
  let roleSerializeMs = 0;
  try {
    const featStart = performance.now();
    const roleRows = extractRoleTrainingRows(
      trainSnapshots,
      WEIBO_W0A_ROLE_HEADS,
      WEIBO_W0A_ROLE_WIRES,
    );
    const roleFeatMs = performance.now() - featStart;

    roleFitInfo = fitLinearPolicyWithHandwired({
      handwiredModule,
      heads: WEIBO_W0A_ROLE_HEADS,
      wires: WEIBO_W0A_ROLE_WIRES,
      rows: roleRows,
      epochs: W0A_FIXED_HYPERPARAMETERS.epochs,
      learningRate: W0A_FIXED_HYPERPARAMETERS.learningRate,
      featureExtractionMs: roleFeatMs,
    });

    roleProfile = {
      profileId: allowSyntheticEngineeringSmoke
        ? "weibo.w0a.role-policy.smoke.v1"
        : "weibo.w0a.role-policy.v1",
      version: "w0a.v1",
      heads: [...WEIBO_W0A_ROLE_HEADS],
      wires: [...WEIBO_W0A_ROLE_WIRES],
      parameterCount: WEIBO_W0A_ROLE_HEADS.length * WEIBO_W0A_ROLE_WIRES.length,
      minScore: W0A_FIXED_HYPERPARAMETERS.minScore,
      minMargin: W0A_FIXED_HYPERPARAMETERS.minMargin,
      calibration: "uncalibrated",
      adoption: "not_applied",
      runKind,
      formalBenchmarkEligible,
      weights: roleFitInfo.weightsMatrix,
    };

    const serStart = performance.now();
    writeFileSync(
      roleWeightsPath,
      `${JSON.stringify(roleProfile, null, 2)}\n`,
      "utf8",
    );
    if (typeof roleWeightsMutatorForTest === "function") {
      roleWeightsMutatorForTest(roleWeightsPath);
    }
    roleSerializeMs = performance.now() - serStart;

    stepsStatus.stepA_roleFit = {
      status: "passed",
      roleWeightsPath,
      parameterCount: roleProfile.parameterCount,
      trainRowCount: roleRows.length,
      initialLoss: roleFitInfo.initialLoss,
      finalLoss: roleFitInfo.finalLoss,
      trajectory: roleFitInfo.trajectory,
    };
  } catch (error) {
    stepsStatus.stepA_roleFit = {
      status: "failed",
      error: error.message,
    };
    return writeReportAndReturn(false, `STEP_A_ROLE_FIT_FAILED: ${error.message}`);
  }

  // Step B: Subprocess reload of role-policy.w0a.json & generate cascaded predictions
  let cascadedTrainRolePreds;
  let cascadedDevRolePreds;
  let roleSubprocessReloadMs = 0;
  let roleTrainEvalMs = 0;
  let roleDevEvalMs = 0;
  try {
    const trainEvalStart = performance.now();
    const inProcTrainRolePreds = computeInProcessRolePredictions(
      trainSnapshots,
      roleProfile,
    );
    roleTrainEvalMs = performance.now() - trainEvalStart;

    const devEvalStart = performance.now();
    const inProcDevRolePreds = computeInProcessRolePredictions(
      devSnapshots,
      roleProfile,
    );
    roleDevEvalMs = performance.now() - devEvalStart;

    const subprocOutPath = join(outDir, "stepb-role-reload-output.json");
    const subStart = performance.now();
    execFileSync(
      process.execPath,
      [
        THIS_FILE,
        "--subprocess-worker",
        "stepB_role",
        "--train-path",
        resolve(trainPath),
        "--dev-path",
        resolve(devPath),
        "--role-weights",
        resolve(roleWeightsPath),
        "--subproc-out",
        resolve(subprocOutPath),
      ],
      { stdio: "pipe" },
    );
    roleSubprocessReloadMs = performance.now() - subStart;

    const subRaw = JSON.parse(readFileSync(subprocOutPath, "utf8"));
    cascadedTrainRolePreds = deserializeSnapPredMap(subRaw.trainRolePredictions);
    cascadedDevRolePreds = deserializeSnapPredMap(subRaw.devRolePredictions);

    const trainParity = compareRolePredictionsParity(
      inProcTrainRolePreds,
      cascadedTrainRolePreds,
    );
    const devParity = compareRolePredictionsParity(
      inProcDevRolePreds,
      cascadedDevRolePreds,
    );
    const perRowParityMatched =
      trainParity.perRowParityMatched && devParity.perRowParityMatched;
    const maxAbsScoreDiff = Math.max(
      trainParity.maxAbsScoreDiff,
      devParity.maxAbsScoreDiff,
    );

    const roleTotalWallMs = performance.now() - roleWallStart;
    const roleTimingMs = {
      ...roleFitInfo.partialTiming,
      weightSerializeMs: roleSerializeMs,
      subprocessReloadMs: roleSubprocessReloadMs,
      trainEvalMs: roleTrainEvalMs,
      devEvalMs: roleDevEvalMs,
      totalWallMs: roleTotalWallMs,
    };
    stepsStatus.stepA_roleFit.timingMs = roleTimingMs;

    if (!perRowParityMatched || maxAbsScoreDiff !== 0) {
      stepsStatus.stepB_roleReloadAndCascade = {
        status: "failed",
        perRowParityMatched,
        maxAbsScoreDiff,
        trainParity,
        devParity,
      };
      return writeReportAndReturn(
        false,
        "STEP_B_ROLE_SUBPROCESS_PARITY_MISMATCH",
        { roleTimingMs },
      );
    }

    stepsStatus.stepB_roleReloadAndCascade = {
      status: "passed",
      perRowParityMatched: true,
      maxAbsScoreDiff: 0,
      trainRowCount: trainParity.rowCount,
      devRowCount: devParity.rowCount,
    };
  } catch (error) {
    stepsStatus.stepB_roleReloadAndCascade = {
      status: "failed",
      error: error.message,
    };
    return writeReportAndReturn(
      false,
      `STEP_B_ROLE_RELOAD_FAILED: ${error.message}`,
    );
  }

  // Step C: Fit Unit W0-Rel (9x32 = 288 parameters) using Step B's cascaded role predictions
  const relWallStart = performance.now();
  let relationProfile;
  let relFitInfo;
  let relSerializeMs = 0;
  try {
    const featStart = performance.now();
    const relRows = extractRelationTrainingRows(
      trainSnapshots,
      cascadedTrainRolePreds,
      WEIBO_W0A_RELATION_HEADS,
      WEIBO_W0A_RELATION_WIRES,
    );
    const relFeatMs = performance.now() - featStart;

    relFitInfo = fitLinearPolicyWithHandwired({
      handwiredModule,
      heads: WEIBO_W0A_RELATION_HEADS,
      wires: WEIBO_W0A_RELATION_WIRES,
      rows: relRows,
      epochs: W0A_FIXED_HYPERPARAMETERS.epochs,
      learningRate: W0A_FIXED_HYPERPARAMETERS.learningRate,
      featureExtractionMs: relFeatMs,
    });

    relationProfile = {
      profileId: allowSyntheticEngineeringSmoke
        ? "weibo.w0a.relation-policy.smoke.v1"
        : "weibo.w0a.relation-policy.v1",
      version: "w0a.v1",
      heads: [...WEIBO_W0A_RELATION_HEADS],
      wires: [...WEIBO_W0A_RELATION_WIRES],
      parameterCount:
        WEIBO_W0A_RELATION_HEADS.length * WEIBO_W0A_RELATION_WIRES.length,
      minScore: W0A_FIXED_HYPERPARAMETERS.minScore,
      minMargin: W0A_FIXED_HYPERPARAMETERS.minMargin,
      calibration: "uncalibrated",
      adoption: "not_applied",
      runKind,
      formalBenchmarkEligible,
      weights: relFitInfo.weightsMatrix,
    };

    const serStart = performance.now();
    writeFileSync(
      relationWeightsPath,
      `${JSON.stringify(relationProfile, null, 2)}\n`,
      "utf8",
    );
    relSerializeMs = performance.now() - serStart;

    stepsStatus.stepC_relationFit = {
      status: "passed",
      relationWeightsPath,
      parameterCount: relationProfile.parameterCount,
      trainRowCount: relRows.length,
      initialLoss: relFitInfo.initialLoss,
      finalLoss: relFitInfo.finalLoss,
      trajectory: relFitInfo.trajectory,
    };
  } catch (error) {
    stepsStatus.stepC_relationFit = {
      status: "failed",
      error: error.message,
    };
    return writeReportAndReturn(
      false,
      `STEP_C_RELATION_FIT_FAILED: ${error.message}`,
      { roleTimingMs: stepsStatus.stepA_roleFit.timingMs },
    );
  }

  // Step D: Subprocess reload of BOTH role-policy.w0a.json & relation-policy.w0a.json
  // and Stage 1 threshold verification on train + development
  try {
    const trainEvalStart = performance.now();
    const inProcTrainEval = evaluateW0aSnapshots({
      snapshots: trainSnapshots,
      roleProfile,
      relationProfile,
      overrideRolePredictionsBySnapshot: cascadedTrainRolePreds,
    });
    const relTrainEvalMs = performance.now() - trainEvalStart;

    const devEvalStart = performance.now();
    const inProcDevEval = evaluateW0aSnapshots({
      snapshots: devSnapshots,
      roleProfile,
      relationProfile,
      overrideRolePredictionsBySnapshot: cascadedDevRolePreds,
    });
    const relDevEvalMs = performance.now() - devEvalStart;

    const subprocOutPath = join(outDir, "stepd-full-reload-output.json");
    const subStart = performance.now();
    execFileSync(
      process.execPath,
      [
        THIS_FILE,
        "--subprocess-worker",
        "stepD_both",
        "--train-path",
        resolve(trainPath),
        "--dev-path",
        resolve(devPath),
        "--role-weights",
        resolve(roleWeightsPath),
        "--relation-weights",
        resolve(relationWeightsPath),
        "--subproc-out",
        resolve(subprocOutPath),
      ],
      { stdio: "pipe" },
    );
    const relSubprocessReloadMs = performance.now() - subStart;

    const subRaw = JSON.parse(readFileSync(subprocOutPath, "utf8"));
    const trainRelParity = compareEvalRelationParity(
      inProcTrainEval,
      subRaw.trainEval,
    );
    const devRelParity = compareEvalRelationParity(
      inProcDevEval,
      subRaw.devEval,
    );
    const perRowParityMatched =
      trainRelParity.perRowParityMatched && devRelParity.perRowParityMatched;
    const maxAbsScoreDiff = Math.max(
      trainRelParity.maxAbsScoreDiff,
      devRelParity.maxAbsScoreDiff,
    );

    const relTotalWallMs = performance.now() - relWallStart;
    const relationTimingMs = {
      ...relFitInfo.partialTiming,
      weightSerializeMs: relSerializeMs,
      subprocessReloadMs: relSubprocessReloadMs,
      trainEvalMs: relTrainEvalMs,
      devEvalMs: relDevEvalMs,
      totalWallMs: relTotalWallMs,
    };
    stepsStatus.stepC_relationFit.timingMs = relationTimingMs;

    const trainThresholdCheck = checkMetricsAgainstThresholds(
      subRaw.trainEval,
      STAGE1_THRESHOLDS,
    );
    const devThresholdCheck = checkMetricsAgainstThresholds(
      subRaw.devEval,
      STAGE1_THRESHOLDS,
    );

    const stage1Passed =
      perRowParityMatched &&
      maxAbsScoreDiff === 0 &&
      trainThresholdCheck.passed &&
      devThresholdCheck.passed;

    stepsStatus.stepD_fullReloadAndStage1Gate = {
      status: stage1Passed ? "passed" : "failed",
      perRowParityMatched,
      maxAbsScoreDiff,
      trainThresholdCheck,
      devThresholdCheck,
    };

    const stripPreds = (ev) => ({
      totalSnapshots: ev.totalSnapshots,
      totalConfirmedGoldRoleNodes: ev.totalConfirmedGoldRoleNodes,
      roleMetrics: ev.roleMetrics,
      relationMetrics: ev.relationMetrics,
      zeroGoldDenominatorViolations: ev.zeroGoldDenominatorViolations,
    });

    return writeReportAndReturn(
      stage1Passed,
      stage1Passed ? null : "STEP_D_STAGE1_GATE_FAILED",
      {
        roleWeightsPath,
        relationWeightsPath,
        roleTimingMs: stepsStatus.stepA_roleFit.timingMs,
        relationTimingMs,
        trainEvaluation: stripPreds(subRaw.trainEval),
        developmentEvaluation: stripPreds(subRaw.devEval),
      },
    );
  } catch (error) {
    stepsStatus.stepD_fullReloadAndStage1Gate = {
      status: "failed",
      error: error.message,
    };
    return writeReportAndReturn(
      false,
      `STEP_D_RELOAD_FAILED: ${error.message}`,
      {
        roleTimingMs: stepsStatus.stepA_roleFit.timingMs,
        relationTimingMs: stepsStatus.stepC_relationFit.timingMs,
      },
    );
  }
}

function parseArgs(argv) {
  const options = {
    allowSyntheticEngineeringSmoke: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--subprocess-worker") {
      options.subprocessWorker = argv[++i];
    } else if (arg === "--train-path") {
      options.trainPath = argv[++i];
    } else if (arg === "--dev-path") {
      options.devPath = argv[++i];
    } else if (arg === "--handwired-root") {
      options.handwiredRoot = argv[++i];
    } else if (arg === "--out-dir") {
      options.outDir = argv[++i];
    } else if (arg === "--role-weights") {
      options.roleWeights = argv[++i];
    } else if (arg === "--relation-weights") {
      options.relationWeights = argv[++i];
    } else if (arg === "--subproc-out") {
      options.subprocOut = argv[++i];
    } else if (arg === "--allow-synthetic-engineering-smoke") {
      options.allowSyntheticEngineeringSmoke = true;
    } else if (arg === "--verification-path") {
      throw new Error(
        "W0A_VERIFICATION_FORBIDDEN_IN_STAGE1: train-w0a-role-relation.mjs does not accept --verification-path",
      );
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.subprocessWorker) {
    runSubprocessWorker(options.subprocessWorker, options);
    return;
  }
  const handwiredRoot =
    options.handwiredRoot ?? process.env.NN_HANDWIRED_ROOT ?? "";
  if (!options.trainPath || !options.devPath || !options.outDir || !handwiredRoot) {
    throw new Error(
      "--train-path, --dev-path, --handwired-root, and --out-dir are required",
    );
  }
  const report = await runW0aStage1Training({
    trainPath: options.trainPath,
    devPath: options.devPath,
    handwiredRoot,
    outDir: options.outDir,
    allowSyntheticEngineeringSmoke: options.allowSyntheticEngineeringSmoke,
  });
  if (!report.stage1Passed) {
    console.error(
      `W0A_STAGE1_TRAINING_FAILED: reason=${report.failureReason} (report saved in ${options.outDir})`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `W0A_STAGE1_TRAINING_PASSED: weights and report saved in ${options.outDir}`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
