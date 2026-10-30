#!/usr/bin/env node
// W0a-Prep-1B Stage 2 independent evaluation and per-class/per-head P/R/F1 module & CLI.
//
// Enforces Section 4.2 Stage 2 one-shot verification gate (cannot read verification
// unless stage1-training-report.json has stage1Passed === true && runKind === "formal_weibo_training")
// and Section 4.4.1 / Table 4.2 per-class Role P/R/F1, per-head Relation P/R/F1,
// zero-denominator rules, P_confirmed vs P_unlabeled separation, and
// repostAuthorContaminationRate.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_CORE_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_POSITIVE_RELATION_HEADS,
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
import {
  validateW0aDataset,
  assertConsistentSnapshotGold,
  resolveConsistentCandidatePairGold,
  readSnapshotsFile,
} from "./validate-w0a-dataset.mjs";

export const STAGE1_THRESHOLDS = Object.freeze({
  candidatePairGenerationRecallMin: 0.98,
  coreRoleMacroF1Min: 0.90,
  coreRolePerHeadRecallMin: 0.85,
  coreRolePerHeadPrecisionMin: 0.85,
  positiveRelationMacroF1Min: 0.90,
  highPriorityRelationHeads: Object.freeze([
    "author_of",
    "body_of",
    "repost_of",
    "submits_input_of",
  ]),
  highPriorityRelationPrecisionMin: 0.92,
  highPriorityRelationRecallMin: 0.88,
  otherPositiveRelationPrecisionMin: 0.85,
  otherPositiveRelationRecallMin: 0.82,
  repostAuthorContaminationRateMax: 0.0,
});

export const STAGE2_VERIFICATION_THRESHOLDS = Object.freeze({
  candidatePairGenerationRecallMin: 0.98,
  coreRoleMacroF1Min: 0.88,
  coreRolePerHeadRecallMin: 0.80,
  coreRolePerHeadPrecisionMin: 0.82,
  positiveRelationMacroF1Min: 0.88,
  highPriorityRelationHeads: Object.freeze([
    "author_of",
    "body_of",
    "repost_of",
    "submits_input_of",
  ]),
  highPriorityRelationPrecisionMin: 0.90,
  highPriorityRelationRecallMin: 0.85,
  otherPositiveRelationPrecisionMin: 0.82,
  otherPositiveRelationRecallMin: 0.80,
  repostAuthorContaminationRateMax: 0.0,
});

export function validateRolePolicyProfile(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid role policy profile: must be an object");
  }
  if (raw.version !== "w0a.v1") {
    throw new Error(`Invalid role policy profile version: ${raw.version}`);
  }
  if (
    !Array.isArray(raw.heads) ||
    raw.heads.length !== WEIBO_W0A_ROLE_HEADS.length ||
    raw.heads.some((h, idx) => h !== WEIBO_W0A_ROLE_HEADS[idx])
  ) {
    throw new Error("Role policy profile heads mismatch WEIBO_W0A_ROLE_HEADS");
  }
  if (
    !Array.isArray(raw.wires) ||
    raw.wires.length !== WEIBO_W0A_ROLE_WIRES.length ||
    raw.wires.some((w, idx) => w !== WEIBO_W0A_ROLE_WIRES[idx])
  ) {
    throw new Error("Role policy profile wires mismatch WEIBO_W0A_ROLE_WIRES");
  }
  if (
    !Array.isArray(raw.weights) ||
    raw.weights.length !== WEIBO_W0A_ROLE_HEADS.length ||
    raw.weights.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== WEIBO_W0A_ROLE_WIRES.length ||
        row.some((v) => typeof v !== "number" || !Number.isFinite(v)),
    )
  ) {
    throw new Error("Role policy profile weights must be a finite 11x36 matrix");
  }
  if (raw.calibration !== "uncalibrated" || raw.adoption !== "not_applied") {
    throw new Error("Role policy profile must maintain calibration=uncalibrated and adoption=not_applied");
  }
  return raw;
}

export function validateRelationPolicyProfile(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid relation policy profile: must be an object");
  }
  if (raw.version !== "w0a.v1") {
    throw new Error(`Invalid relation policy profile version: ${raw.version}`);
  }
  if (
    !Array.isArray(raw.heads) ||
    raw.heads.length !== WEIBO_W0A_RELATION_HEADS.length ||
    raw.heads.some((h, idx) => h !== WEIBO_W0A_RELATION_HEADS[idx])
  ) {
    throw new Error("Relation policy profile heads mismatch WEIBO_W0A_RELATION_HEADS");
  }
  if (
    !Array.isArray(raw.wires) ||
    raw.wires.length !== WEIBO_W0A_RELATION_WIRES.length ||
    raw.wires.some((w, idx) => w !== WEIBO_W0A_RELATION_WIRES[idx])
  ) {
    throw new Error("Relation policy profile wires mismatch WEIBO_W0A_RELATION_WIRES");
  }
  if (
    !Array.isArray(raw.weights) ||
    raw.weights.length !== WEIBO_W0A_RELATION_HEADS.length ||
    raw.weights.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== WEIBO_W0A_RELATION_WIRES.length ||
        row.some((v) => typeof v !== "number" || !Number.isFinite(v)),
    )
  ) {
    throw new Error("Relation policy profile weights must be a finite 9x32 matrix");
  }
  if (raw.calibration !== "uncalibrated" || raw.adoption !== "not_applied") {
    throw new Error("Relation policy profile must maintain calibration=uncalibrated and adoption=not_applied");
  }
  return raw;
}

function isEffectiveDescendantOf(nodeRef, ancestorRef, resolvedMap) {
  let cursor = resolvedMap.get(nodeRef);
  const seen = new Set();
  while (cursor && cursor.effectiveRetainedAncestorRef !== null) {
    const nextRef = cursor.effectiveRetainedAncestorRef;
    if (nextRef === ancestorRef) return true;
    if (seen.has(nextRef)) break;
    seen.add(nextRef);
    cursor = resolvedMap.get(nextRef);
  }
  return false;
}

export function evaluateW0aSnapshots({
  snapshots,
  roleProfile,
  relationProfile,
  overrideRolePredictionsBySnapshot = null,
}) {
  validateRolePolicyProfile(roleProfile);
  validateRelationPolicyProfile(relationProfile);

  // Per-role counters across all snapshots
  const roleGoldCount = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));
  const rolePredCount = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));
  const roleTP = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));
  const roleFP = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));
  const roleFN = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));

  let totalConfirmedGoldRoleNodes = 0;
  let roleUnknownCount = 0;
  let roleConflictCount = 0;

  // Per-relation counters across all snapshots (8 positive heads)
  const relGoldCount = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relInPoolGoldCount = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relMissedByCandGenCount = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relConfirmedPredCount = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relTP = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relFP = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const relFN = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );
  const unlabeledPredictedPositiveCount = Object.fromEntries(
    WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
  );

  let totalIndependentGoldEdges = 0;
  let totalInPoolGoldEdges = 0;
  let totalCandidatePairs = 0;
  let confirmedCandidatePairCount = 0;
  let unlabeledCandidatePairCount = 0;
  let relationUnknownCount = 0;
  let relationConflictCount = 0;

  // Repost author contamination tracking
  let repostAuthorTotalCount = 0;
  let repostAuthorContaminatedCount = 0;

  const perSnapshotPredictions = [];

  for (let sIdx = 0; sIdx < snapshots.length; sIdx += 1) {
    const snap = snapshots[sIdx];
    const snapId = snap.snapshotId ?? `snap-${sIdx}`;
    const allSlotsByRef = new Map();
    for (const s of snap.slots ?? []) {
      allSlotsByRef.set(s.nodeRef, s);
    }
    const resolvedMap = resolveRetainedNodesMap({
      slots: snap.slots,
      retainedNodes: snap.retainedNodes ?? [],
    });

    // 1. Role prediction (or override from Step B subprocess)
    const rolePredictionsByRef = new Map();
    const overrideMap = overrideRolePredictionsBySnapshot?.get(snapId) ?? null;

    for (const rNode of snap.retainedNodes ?? []) {
      let pred;
      if (overrideMap && overrideMap.has(rNode.nodeRef)) {
        pred = overrideMap.get(rNode.nodeRef);
      } else {
        const wires36 = extractWeiboRoleWires36(
          rNode.nodeRef,
          resolvedMap,
          allSlotsByRef,
        );
        pred = predictWeiboNodeRole(rNode.nodeRef, wires36, roleProfile);
      }
      rolePredictionsByRef.set(rNode.nodeRef, pred);

      const ann = rNode.roleAnnotation;
      if (ann && ann.reviewStatus === "confirmed_gold" && ann.goldRole) {
        const gRole = ann.goldRole;
        totalConfirmedGoldRoleNodes += 1;
        roleGoldCount[gRole] = (roleGoldCount[gRole] ?? 0) + 1;

        if (pred.roleStatus === "unknown") {
          roleUnknownCount += 1;
        } else if (pred.roleStatus === "conflict") {
          roleConflictCount += 1;
        }

        if (pred.roleStatus === "judged" && pred.predRole) {
          const pRole = pred.predRole;
          rolePredCount[pRole] = (rolePredCount[pRole] ?? 0) + 1;
          if (pRole === gRole) {
            roleTP[gRole] += 1;
          } else {
            roleFP[pRole] += 1;
            roleFN[gRole] += 1;
          }
        } else {
          // unknown or conflict on a gold node of class gRole is an FN for gRole!
          roleFN[gRole] += 1;
        }
      }
    }

    // 2. Candidate pair generation & Relation evaluation
    const pairGen = generateWeiboCandidatePairs(resolvedMap);
    const candKeySet = new Set();
    for (const cand of pairGen.candidatePairs) {
      candKeySet.add(`${cand.sourceRef}->${cand.targetRef}`);
    }
    assertConsistentSnapshotGold(snap, snapId, candKeySet);
    totalCandidatePairs += pairGen.candidatePairs.length;

    // Independent gold edges E_{gold, r}
    const indepGoldByKey = new Map();
    for (const edge of snap.independentGoldRelations ?? []) {
      if (edge.reviewStatus !== "confirmed_gold") continue;
      const key = `${edge.sourceRef}->${edge.targetRef}`;
      indepGoldByKey.set(key, edge.relation);
      if (edge.relation in relGoldCount) {
        relGoldCount[edge.relation] += 1;
        totalIndependentGoldEdges += 1;
        if (candKeySet.has(key)) {
          relInPoolGoldCount[edge.relation] += 1;
          totalInPoolGoldEdges += 1;
        } else {
          // Missed by candidate pair generator -> counts toward FN_r!
          relMissedByCandGenCount[edge.relation] += 1;
          relFN[edge.relation] += 1;
        }
      }
    }

    // Confirmed candidate pair annotations P_confirmed vs P_unlabeled
    const pairAnnByKey = new Map();
    for (const pa of snap.candidatePairAnnotations ?? []) {
      pairAnnByKey.set(`${pa.sourceRef}->${pa.targetRef}`, pa);
    }

    const relationPredictions = [];
    const predictedPositiveEdgesByKey = new Map();

    for (const cand of pairGen.candidatePairs) {
      const key = `${cand.sourceRef}->${cand.targetRef}`;
      const wires32 = extractWeiboRelationWires32(
        cand,
        resolvedMap,
        rolePredictionsByRef,
      );
      const relPred = predictWeiboPairRelation(
        cand,
        wires32,
        relationProfile,
        resolvedMap,
      );
      relationPredictions.push(relPred);

      if (relPred.relationStatus === "unknown") {
        relationUnknownCount += 1;
      } else if (relPred.relationStatus === "conflict") {
        relationConflictCount += 1;
      }

      if (
        relPred.relationStatus === "judged" &&
        relPred.predRelation &&
        relPred.predRelation !== "unrelated"
      ) {
        predictedPositiveEdgesByKey.set(key, relPred.predRelation);
      }

      const goldRel = resolveConsistentCandidatePairGold(
        key,
        indepGoldByKey,
        pairAnnByKey,
        snapId,
      );

      if (goldRel === null) {
        unlabeledCandidatePairCount += 1;
        if (
          relPred.relationStatus === "judged" &&
          relPred.predRelation &&
          relPred.predRelation !== "unrelated"
        ) {
          unlabeledPredictedPositiveCount[relPred.predRelation] += 1;
        }
        continue;
      }

      confirmedCandidatePairCount += 1;
      const predPositive =
        relPred.relationStatus === "judged" &&
        relPred.predRelation &&
        relPred.predRelation !== "unrelated"
          ? relPred.predRelation
          : null;

      if (predPositive !== null) {
        relConfirmedPredCount[predPositive] += 1;
        if (predPositive === goldRel) {
          relTP[predPositive] += 1;
        } else {
          relFP[predPositive] += 1;
          if (goldRel !== "unrelated" && goldRel in relFN) {
            relFN[goldRel] += 1;
          }
        }
      } else {
        // Predicted unrelated, unknown, or conflict on a confirmed pair
        if (goldRel !== "unrelated" && goldRel in relFN) {
          relFN[goldRel] += 1;
        }
      }
    }

    // 3. Repost author contamination check:
    // For every gold author_of(u_a, v_repost) where v_repost is a gold reposted_embedded_post
    // inside an outer gold post_root v_outer, check if model predicted author_of(u_a, v_outer).
    const goldRoleByRef = new Map();
    for (const rNode of snap.retainedNodes ?? []) {
      if (rNode.roleAnnotation?.reviewStatus === "confirmed_gold" && rNode.roleAnnotation.goldRole) {
        goldRoleByRef.set(rNode.nodeRef, rNode.roleAnnotation.goldRole);
      }
    }
    const goldRepostToOuterRoot = new Map();
    for (const edge of snap.independentGoldRelations ?? []) {
      if (edge.reviewStatus === "confirmed_gold" && edge.relation === "repost_of") {
        goldRepostToOuterRoot.set(edge.sourceRef, edge.targetRef);
      }
    }
    for (const edge of snap.independentGoldRelations ?? []) {
      if (edge.reviewStatus === "confirmed_gold" && edge.relation === "author_of") {
        const targetRole = goldRoleByRef.get(edge.targetRef);
        if (targetRole === "reposted_embedded_post") {
          // Find outer post_root via gold repost_of or effective ancestor
          let outerRootRef = goldRepostToOuterRoot.get(edge.targetRef) ?? null;
          if (!outerRootRef) {
            for (const [candRef, cRole] of goldRoleByRef.entries()) {
              if (
                cRole === "post_root" &&
                isEffectiveDescendantOf(edge.targetRef, candRef, resolvedMap)
              ) {
                outerRootRef = candRef;
                break;
              }
            }
          }
          if (outerRootRef) {
            repostAuthorTotalCount += 1;
            const outerKey = `${edge.sourceRef}->${outerRootRef}`;
            if (predictedPositiveEdgesByKey.get(outerKey) === "author_of") {
              repostAuthorContaminatedCount += 1;
            }
          }
        }
      }
    }

    perSnapshotPredictions.push({
      snapshotId: snapId,
      pairGenerationBoundaryStatus: pairGen.pairGenerationBoundaryStatus,
      rolePredictions: [...rolePredictionsByRef.values()],
      relationPredictions,
    });
  }

  // Compute per-class Role P/R/F1 and zero-denominator flags
  const zeroGoldDenominatorViolations = [];
  const rolePerClass = {};
  for (const h of WEIBO_W0A_ROLE_HEADS) {
    const g = roleGoldCount[h];
    const tp = roleTP[h];
    const fp = roleFP[h];
    const fn = roleFN[h];
    const predTotal = tp + fp;
    if (g === 0) {
      zeroGoldDenominatorViolations.push({
        code: "UNVERIFIED_ZERO_GOLD_DENOMINATOR",
        headKind: "role",
        head: h,
      });
    }
    const precision = predTotal > 0 ? tp / predTotal : 0.0;
    const recall = g > 0 ? tp / g : null;
    const f1 =
      recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0.0;
    rolePerClass[h] = {
      goldCount: g,
      predictedCount: predTotal,
      tp,
      fp,
      fn,
      zeroGoldDenominator: g === 0,
      zeroPredictions: predTotal === 0,
      precision,
      recall: recall ?? 0.0,
      f1,
    };
  }

  const coreRoleMacroF1 =
    WEIBO_W0A_CORE_ROLE_HEADS.reduce((acc, h) => acc + rolePerClass[h].f1, 0) /
    WEIBO_W0A_CORE_ROLE_HEADS.length;
  const allRoleMacroF1 =
    WEIBO_W0A_ROLE_HEADS.reduce((acc, h) => acc + rolePerClass[h].f1, 0) /
    WEIBO_W0A_ROLE_HEADS.length;

  const coreRoleTP = WEIBO_W0A_CORE_ROLE_HEADS.reduce((acc, h) => acc + roleTP[h], 0);
  const coreRoleFP = WEIBO_W0A_CORE_ROLE_HEADS.reduce((acc, h) => acc + roleFP[h], 0);
  const coreRoleFN = WEIBO_W0A_CORE_ROLE_HEADS.reduce((acc, h) => acc + roleFN[h], 0);
  const coreRoleMicroPrecision =
    coreRoleTP + coreRoleFP > 0 ? coreRoleTP / (coreRoleTP + coreRoleFP) : 0.0;
  const coreRoleMicroRecall =
    coreRoleTP + coreRoleFN > 0 ? coreRoleTP / (coreRoleTP + coreRoleFN) : 0.0;
  const coreRoleMicroF1 =
    coreRoleMicroPrecision + coreRoleMicroRecall > 0
      ? (2 * coreRoleMicroPrecision * coreRoleMicroRecall) /
        (coreRoleMicroPrecision + coreRoleMicroRecall)
      : 0.0;

  // Compute per-head Relation P/R/F1
  const relationPerHead = {};
  for (const r of WEIBO_W0A_POSITIVE_RELATION_HEADS) {
    const g = relGoldCount[r];
    const inPoolG = relInPoolGoldCount[r];
    const missedG = relMissedByCandGenCount[r];
    const tp = relTP[r];
    const fp = relFP[r];
    const fn = relFN[r];
    const confirmedPredTotal = tp + fp;
    if (g === 0) {
      zeroGoldDenominatorViolations.push({
        code: "UNVERIFIED_ZERO_GOLD_DENOMINATOR",
        headKind: "relation",
        head: r,
      });
    }
    const precision = confirmedPredTotal > 0 ? tp / confirmedPredTotal : 0.0;
    const recall = g > 0 ? tp / g : null;
    const f1 =
      recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0.0;
    relationPerHead[r] = {
      goldCount: g,
      inPoolGoldCount: inPoolG,
      missedByCandidateGenerationCount: missedG,
      confirmedPredictedCount: confirmedPredTotal,
      unlabeledPredictedPositiveCount: unlabeledPredictedPositiveCount[r],
      tp,
      fp,
      fn,
      zeroGoldDenominator: g === 0,
      zeroPredictions: confirmedPredTotal === 0,
      precision,
      recall: recall ?? 0.0,
      f1,
    };
  }

  const positiveRelationMacroF1 =
    WEIBO_W0A_POSITIVE_RELATION_HEADS.reduce((acc, r) => acc + relationPerHead[r].f1, 0) /
    WEIBO_W0A_POSITIVE_RELATION_HEADS.length;

  const posRelTP = WEIBO_W0A_POSITIVE_RELATION_HEADS.reduce((acc, r) => acc + relTP[r], 0);
  const posRelFP = WEIBO_W0A_POSITIVE_RELATION_HEADS.reduce((acc, r) => acc + relFP[r], 0);
  const posRelFN = WEIBO_W0A_POSITIVE_RELATION_HEADS.reduce((acc, r) => acc + relFN[r], 0);
  const posRelMicroPrecision =
    posRelTP + posRelFP > 0 ? posRelTP / (posRelTP + posRelFP) : 0.0;
  const posRelMicroRecall =
    posRelTP + posRelFN > 0 ? posRelTP / (posRelTP + posRelFN) : 0.0;
  const positiveRelationMicroF1 =
    posRelMicroPrecision + posRelMicroRecall > 0
      ? (2 * posRelMicroPrecision * posRelMicroRecall) /
        (posRelMicroPrecision + posRelMicroRecall)
      : 0.0;

  const candidatePairGenerationRecall =
    totalIndependentGoldEdges > 0
      ? totalInPoolGoldEdges / totalIndependentGoldEdges
      : 0.0;

  const totalUnlabeledPositivePreds = Object.values(
    unlabeledPredictedPositiveCount,
  ).reduce((a, b) => a + b, 0);

  const repostAuthorContaminationRate =
    repostAuthorTotalCount > 0
      ? repostAuthorContaminatedCount / repostAuthorTotalCount
      : 0.0;

  return {
    totalSnapshots: snapshots.length,
    totalConfirmedGoldRoleNodes,
    roleMetrics: {
      perClass: rolePerClass,
      coreRoleMacroF1,
      allRoleMacroF1,
      coreRoleMicroF1,
      roleUnknownRate:
        totalConfirmedGoldRoleNodes > 0
          ? roleUnknownCount / totalConfirmedGoldRoleNodes
          : 0.0,
      roleConflictRate:
        totalConfirmedGoldRoleNodes > 0
          ? roleConflictCount / totalConfirmedGoldRoleNodes
          : 0.0,
    },
    relationMetrics: {
      totalIndependentGoldEdges,
      totalInPoolGoldEdges,
      candidatePairGenerationRecall,
      totalCandidatePairs,
      confirmedCandidatePairCount,
      unlabeledCandidatePairCount,
      unlabeledPredictedPositiveCount,
      unverifiedPredictionsOnUnlabeledPairs: totalUnlabeledPositivePreds > 0,
      perHead: relationPerHead,
      positiveRelationMacroF1,
      positiveRelationMicroF1,
      relationUnknownRate:
        totalCandidatePairs > 0 ? relationUnknownCount / totalCandidatePairs : 0.0,
      relationConflictRate:
        totalCandidatePairs > 0 ? relationConflictCount / totalCandidatePairs : 0.0,
      repostAuthorTotalCount,
      repostAuthorContaminatedCount,
      repostAuthorContaminationRate,
    },
    zeroGoldDenominatorViolations,
    perSnapshotPredictions,
  };
}

export function checkMetricsAgainstThresholds(evalResult, thresholds) {
  const failures = [];
  if (evalResult.zeroGoldDenominatorViolations.length > 0) {
    for (const v of evalResult.zeroGoldDenominatorViolations) {
      failures.push({
        code: v.code,
        headKind: v.headKind,
        head: v.head,
        message: `Zero gold denominator on ${v.headKind} head ${v.head}`,
      });
    }
  }
  if (evalResult.relationMetrics.unlabeledCandidatePairCount > 0) {
    failures.push({
      code: "UNLABELED_CANDIDATE_PAIRS_PRESENT",
      count: evalResult.relationMetrics.unlabeledCandidatePairCount,
      message: `Evaluation split has ${evalResult.relationMetrics.unlabeledCandidatePairCount} unlabeled candidate pairs`,
    });
  }
  if (
    evalResult.relationMetrics.candidatePairGenerationRecall <
    thresholds.candidatePairGenerationRecallMin
  ) {
    failures.push({
      code: "BELOW_CANDIDATE_PAIR_GENERATION_RECALL",
      actual: evalResult.relationMetrics.candidatePairGenerationRecall,
      required: thresholds.candidatePairGenerationRecallMin,
    });
  }
  if (evalResult.roleMetrics.coreRoleMacroF1 < thresholds.coreRoleMacroF1Min) {
    failures.push({
      code: "BELOW_CORE_ROLE_MACRO_F1",
      actual: evalResult.roleMetrics.coreRoleMacroF1,
      required: thresholds.coreRoleMacroF1Min,
    });
  }
  for (const h of WEIBO_W0A_CORE_ROLE_HEADS) {
    const m = evalResult.roleMetrics.perClass[h];
    if (m.precision < thresholds.coreRolePerHeadPrecisionMin) {
      failures.push({
        code: "BELOW_CORE_ROLE_HEAD_PRECISION",
        head: h,
        actual: m.precision,
        required: thresholds.coreRolePerHeadPrecisionMin,
      });
    }
    if (m.recall < thresholds.coreRolePerHeadRecallMin) {
      failures.push({
        code: "BELOW_CORE_ROLE_HEAD_RECALL",
        head: h,
        actual: m.recall,
        required: thresholds.coreRolePerHeadRecallMin,
      });
    }
  }
  if (
    evalResult.relationMetrics.positiveRelationMacroF1 <
    thresholds.positiveRelationMacroF1Min
  ) {
    failures.push({
      code: "BELOW_POSITIVE_RELATION_MACRO_F1",
      actual: evalResult.relationMetrics.positiveRelationMacroF1,
      required: thresholds.positiveRelationMacroF1Min,
    });
  }
  for (const r of WEIBO_W0A_POSITIVE_RELATION_HEADS) {
    const m = evalResult.relationMetrics.perHead[r];
    const isHigh = thresholds.highPriorityRelationHeads.includes(r);
    const reqP = isHigh
      ? thresholds.highPriorityRelationPrecisionMin
      : thresholds.otherPositiveRelationPrecisionMin;
    const reqR = isHigh
      ? thresholds.highPriorityRelationRecallMin
      : thresholds.otherPositiveRelationRecallMin;
    if (m.precision < reqP) {
      failures.push({
        code: "BELOW_RELATION_HEAD_PRECISION",
        head: r,
        actual: m.precision,
        required: reqP,
      });
    }
    if (m.recall < reqR) {
      failures.push({
        code: "BELOW_RELATION_HEAD_RECALL",
        head: r,
        actual: m.recall,
        required: reqR,
      });
    }
  }
  if (
    evalResult.relationMetrics.repostAuthorContaminationRate >
    thresholds.repostAuthorContaminationRateMax
  ) {
    failures.push({
      code: "REPOST_AUTHOR_CONTAMINATION_EXCEEDED",
      actual: evalResult.relationMetrics.repostAuthorContaminationRate,
      required: thresholds.repostAuthorContaminationRateMax,
    });
  }
  return {
    passed: failures.length === 0,
    failures,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dataset-path") {
      options.datasetPath = argv[++i];
    } else if (arg === "--split-kind") {
      options.splitKind = argv[++i];
    } else if (arg === "--role-weights") {
      options.roleWeights = argv[++i];
    } else if (arg === "--relation-weights") {
      options.relationWeights = argv[++i];
    } else if (arg === "--stage1-report") {
      options.stage1Report = argv[++i];
    } else if (arg === "--train-path") {
      options.trainPath = argv[++i];
    } else if (arg === "--dev-path") {
      options.devPath = argv[++i];
    } else if (arg === "--handwired-root") {
      options.handwiredRoot = argv[++i];
    } else if (arg === "--out-report") {
      options.outReport = argv[++i];
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (
    !options.datasetPath ||
    !options.splitKind ||
    !options.roleWeights ||
    !options.relationWeights ||
    !options.outReport
  ) {
    throw new Error(
      "--dataset-path, --split-kind, --role-weights, --relation-weights, and --out-report are required",
    );
  }
  if (
    options.splitKind !== "development_diagnostic" &&
    options.splitKind !== "one_shot_verification" &&
    options.splitKind !== "demoted_seen_regression"
  ) {
    throw new Error(
      `Invalid --split-kind ${options.splitKind}: must be development_diagnostic, one_shot_verification, or demoted_seen_regression`,
    );
  }
  return options;
}

export function getOneShotConsumedLedgerPaths(outReportPath, stage1ReportPath) {
  const paths = new Set();
  if (typeof outReportPath === "string" && outReportPath.length > 0) {
    paths.add(
      resolve(dirname(resolve(outReportPath)), "one-shot-verification-consumed.jsonl"),
    );
  }
  if (typeof stage1ReportPath === "string" && stage1ReportPath.length > 0) {
    paths.add(
      resolve(dirname(resolve(stage1ReportPath)), "one-shot-verification-consumed.jsonl"),
    );
  }
  return [...paths];
}

export function readOneShotConsumedEntries(ledgerPaths, outReportPath) {
  const entries = [];
  for (const ledgerPath of ledgerPaths) {
    if (!existsSync(ledgerPath)) continue;
    const raw = readFileSync(ledgerPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(
          `ONE_SHOT_CONSUMPTION_LEDGER_CORRUPTED: invalid JSON line in ${ledgerPath} (${error.message})`,
        );
      }
      if (parsed && typeof parsed === "object") {
        entries.push({ ...parsed, ledgerPath });
      }
    }
  }
  if (typeof outReportPath === "string" && outReportPath.length > 0) {
    const resolvedOut = resolve(outReportPath);
    if (existsSync(resolvedOut)) {
      let existingReport = null;
      try {
        existingReport = JSON.parse(readFileSync(resolvedOut, "utf8"));
      } catch (error) {
        throw new Error(
          `ONE_SHOT_CONSUMPTION_RECEIPT_CORRUPTED: invalid JSON at ${resolvedOut} (${error.message})`,
        );
      }
      if (
        existingReport &&
        existingReport.splitKind === "one_shot_verification" &&
        existingReport.oneShotHoldoutConsumed === true
      ) {
        entries.push({
          kind: "nnanything.w0a.one-shot-consumption-event.v1",
          event: "existing_consumed_receipt",
          oneShotHoldoutConsumed: true,
          datasetPath:
            typeof existingReport.datasetPath === "string"
              ? resolve(existingReport.datasetPath)
              : null,
          receiptPath: resolvedOut,
          partitionStatus: existingReport.partitionStatus ?? null,
        });
      }
    }
  }
  return entries;
}

function appendOneShotConsumedEntry(ledgerPaths, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  for (const ledgerPath of ledgerPaths) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, line, "utf8");
  }
}

function allocateAppendOnlyReceiptPath(baseOutReportPath, suffixTag) {
  const resolvedBase = resolve(baseOutReportPath);
  if (!existsSync(resolvedBase)) {
    return resolvedBase;
  }
  let idx = 1;
  while (true) {
    const candidate = `${resolvedBase}.${suffixTag}-${idx}.json`;
    if (!existsSync(candidate)) {
      return candidate;
    }
    idx += 1;
  }
}

export function runW0aStage2Evaluation(options) {
  const stage1ReportPath =
    options.stage1Report ??
    resolve(dirname(options.roleWeights), "..", "stage1-training-report.json");
  const resolvedDatasetPath = resolve(options.datasetPath);
  const resolvedOutReport = resolve(options.outReport);
  const consumedLedgerPaths =
    options.splitKind === "one_shot_verification"
      ? getOneShotConsumedLedgerPaths(resolvedOutReport, stage1ReportPath)
      : [];

  if (options.splitKind === "one_shot_verification") {
    const consumedEntries = readOneShotConsumedEntries(
      consumedLedgerPaths,
      resolvedOutReport,
    );
    const priorConsumed = consumedEntries.find(
      (entry) =>
        entry.oneShotHoldoutConsumed === true &&
        (entry.datasetPath === resolvedDatasetPath ||
          entry.receiptPath === resolvedOutReport),
    );
    if (priorConsumed) {
      const rejectionReceiptPath = allocateAppendOnlyReceiptPath(
        resolvedOutReport,
        "replay-rejected",
      );
      const replayRejectedReport = {
        kind: "nnanything.w0a.evaluation-report.v1",
        splitKind: options.splitKind,
        datasetPath: resolvedDatasetPath,
        verificationGateBlocked: true,
        verificationDatasetValidationFailed: false,
        oneShotHoldoutConsumed: true,
        alreadyConsumedReplayRejected: true,
        verificationPassed: false,
        formalBenchmarkEligible: false,
        partitionStatus: "rejected_already_consumed_one_shot_verification_holdout",
        priorConsumedReceiptPath: priorConsumed.receiptPath ?? null,
        priorPartitionStatus: priorConsumed.partitionStatus ?? null,
        consumedLedgerPaths,
        receiptPath: rejectionReceiptPath,
        reason: `ONE_SHOT_HOLDOUT_ALREADY_CONSUMED: one_shot_verification dataset (${resolvedDatasetPath}) was already opened/consumed (prior receipt: ${priorConsumed.receiptPath ?? "ledger"}) and cannot be re-opened, re-scored, or overwritten.`,
      };
      mkdirSync(dirname(rejectionReceiptPath), { recursive: true });
      writeFileSync(
        rejectionReceiptPath,
        `${JSON.stringify(replayRejectedReport, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      appendOneShotConsumedEntry(consumedLedgerPaths, {
        kind: "nnanything.w0a.one-shot-consumption-event.v1",
        event: "replay_rejected_before_open",
        recordedAt: new Date().toISOString(),
        datasetPath: resolvedDatasetPath,
        requestedOutReport: resolvedOutReport,
        receiptPath: rejectionReceiptPath,
        priorConsumedReceiptPath: priorConsumed.receiptPath ?? null,
        oneShotHoldoutConsumed: true,
      });
      return {
        report: replayRejectedReport,
        passed: false,
        receiptPath: rejectionReceiptPath,
      };
    }
  }

  const roleProfile = validateRolePolicyProfile(
    JSON.parse(readFileSync(options.roleWeights, "utf8")),
  );
  const relationProfile = validateRelationPolicyProfile(
    JSON.parse(readFileSync(options.relationWeights, "utf8")),
  );

  let stage1Report = null;
  if (options.splitKind === "one_shot_verification") {
    try {
      stage1Report = JSON.parse(readFileSync(stage1ReportPath, "utf8"));
    } catch (error) {
      throw new Error(
        `W0A_VERIFICATION_GATE_BLOCKED: cannot read stage1-training-report.json at ${stage1ReportPath} before opening one_shot_verification (${error.message})`,
      );
    }
    const stage1FormalReady =
      stage1Report.stage1Passed === true &&
      stage1Report.runKind === "formal_weibo_training" &&
      roleProfile.runKind === "formal_weibo_training" &&
      relationProfile.runKind === "formal_weibo_training";
    if (!stage1FormalReady) {
      const blockedReceiptPath = allocateAppendOnlyReceiptPath(
        resolvedOutReport,
        "gate-blocked",
      );
      const blockedReport = {
        kind: "nnanything.w0a.evaluation-report.v1",
        splitKind: options.splitKind,
        datasetPath: resolvedDatasetPath,
        verificationGateBlocked: true,
        verificationDatasetValidationFailed: false,
        oneShotHoldoutConsumed: false,
        verificationPassed: false,
        formalBenchmarkEligible: false,
        stage1Passed: stage1Report.stage1Passed ?? false,
        stage1RunKind: stage1Report.runKind ?? null,
        roleProfileRunKind: roleProfile.runKind ?? null,
        relationProfileRunKind: relationProfile.runKind ?? null,
        receiptPath: blockedReceiptPath,
        reason:
          "Stage 1 did not pass formal_weibo_training; one_shot_verification dataset was NOT read.",
      };
      mkdirSync(dirname(blockedReceiptPath), { recursive: true });
      writeFileSync(
        blockedReceiptPath,
        `${JSON.stringify(blockedReport, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return { report: blockedReport, passed: false, receiptPath: blockedReceiptPath };
    }
  }

  // At this point, if splitKind === "one_shot_verification", Stage 1 precondition gate passed
  // and we record durable append-only consumption before reading the verification dataset from disk.
  const oneShotHoldoutConsumed = options.splitKind === "one_shot_verification";
  const finalReceiptPath = oneShotHoldoutConsumed
    ? allocateAppendOnlyReceiptPath(resolvedOutReport, "consumed")
    : resolvedOutReport;

  if (oneShotHoldoutConsumed) {
    appendOneShotConsumedEntry(consumedLedgerPaths, {
      kind: "nnanything.w0a.one-shot-consumption-event.v1",
      event: "holdout_opened_and_consumed",
      recordedAt: new Date().toISOString(),
      datasetPath: resolvedDatasetPath,
      receiptPath: finalReceiptPath,
      roleProfileId: roleProfile.profileId,
      relationProfileId: relationProfile.profileId,
      oneShotHoldoutConsumed: true,
    });
  }

  const snapshots = readSnapshotsFile(options.datasetPath, options.splitKind);

  let datasetValidation = null;
  if (options.splitKind === "one_shot_verification") {
    const trainPath = options.trainPath ?? stage1Report?.trainPath ?? null;
    const devPath = options.devPath ?? stage1Report?.devPath ?? null;
    let trainSnapshots = null;
    let devSnapshots = null;
    let sourceReadError = null;
    if (!trainPath || !devPath) {
      sourceReadError =
        "Stage 1 trainPath and devPath are required to verify source-family disjointness before scoring one_shot_verification";
    } else {
      try {
        trainSnapshots = readSnapshotsFile(trainPath, "stage1-train-path");
        devSnapshots = readSnapshotsFile(devPath, "stage1-dev-path");
      } catch (error) {
        sourceReadError = error.message;
      }
    }

    if (sourceReadError !== null) {
      const failedSourceReport = {
        kind: "nnanything.w0a.evaluation-report.v1",
        splitKind: options.splitKind,
        datasetPath: resolvedDatasetPath,
        verificationGateBlocked: false,
        verificationDatasetValidationFailed: true,
        oneShotHoldoutConsumed: true,
        verificationPassed: false,
        formalBenchmarkEligible: false,
        partitionStatus: "failed_one_shot_verification_admission_do_not_reuse",
        roleProfileId: roleProfile.profileId,
        relationProfileId: relationProfile.profileId,
        runKind: roleProfile.runKind,
        consumedLedgerPaths,
        receiptPath: finalReceiptPath,
        datasetValidation: {
          kind: "nnanything.w0a.dataset-validation.v1",
          valid: false,
          allowSyntheticEngineeringSmoke: false,
          violations: [
            {
              code: "MISSING_STAGE1_TRAIN_DEV_SOURCES_FOR_DISJOINTNESS",
              split: "verification",
              message: sourceReadError,
            },
          ],
        },
      };
      mkdirSync(dirname(finalReceiptPath), { recursive: true });
      writeFileSync(
        finalReceiptPath,
        `${JSON.stringify(failedSourceReport, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      appendOneShotConsumedEntry(consumedLedgerPaths, {
        kind: "nnanything.w0a.one-shot-consumption-event.v1",
        event: "holdout_consumption_completed",
        recordedAt: new Date().toISOString(),
        datasetPath: resolvedDatasetPath,
        receiptPath: finalReceiptPath,
        partitionStatus: failedSourceReport.partitionStatus,
        verificationDatasetValidationFailed: true,
        verificationPassed: false,
        oneShotHoldoutConsumed: true,
      });
      return {
        report: failedSourceReport,
        passed: false,
        receiptPath: finalReceiptPath,
      };
    }

    datasetValidation = validateW0aDataset({
      trainSnapshots,
      devSnapshots,
      verificationSnapshots: snapshots,
      allowSyntheticEngineeringSmoke: false,
    });

    if (!datasetValidation.valid) {
      const failedAdmissionReport = {
        kind: "nnanything.w0a.evaluation-report.v1",
        splitKind: options.splitKind,
        datasetPath: resolvedDatasetPath,
        verificationGateBlocked: false,
        verificationDatasetValidationFailed: true,
        oneShotHoldoutConsumed: true,
        verificationPassed: false,
        formalBenchmarkEligible: false,
        partitionStatus: "failed_one_shot_verification_admission_do_not_reuse",
        roleProfileId: roleProfile.profileId,
        relationProfileId: relationProfile.profileId,
        runKind: roleProfile.runKind,
        consumedLedgerPaths,
        receiptPath: finalReceiptPath,
        datasetValidation,
      };
      mkdirSync(dirname(finalReceiptPath), { recursive: true });
      writeFileSync(
        finalReceiptPath,
        `${JSON.stringify(failedAdmissionReport, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      appendOneShotConsumedEntry(consumedLedgerPaths, {
        kind: "nnanything.w0a.one-shot-consumption-event.v1",
        event: "holdout_consumption_completed",
        recordedAt: new Date().toISOString(),
        datasetPath: resolvedDatasetPath,
        receiptPath: finalReceiptPath,
        partitionStatus: failedAdmissionReport.partitionStatus,
        verificationDatasetValidationFailed: true,
        verificationPassed: false,
        oneShotHoldoutConsumed: true,
      });
      return {
        report: failedAdmissionReport,
        passed: false,
        receiptPath: finalReceiptPath,
      };
    }
  }

  const evalResult = evaluateW0aSnapshots({
    snapshots,
    roleProfile,
    relationProfile,
  });
  const thresholds =
    options.splitKind === "one_shot_verification"
      ? STAGE2_VERIFICATION_THRESHOLDS
      : STAGE1_THRESHOLDS;
  const thresholdCheck = checkMetricsAgainstThresholds(evalResult, thresholds);

  const report = {
    kind: "nnanything.w0a.evaluation-report.v1",
    splitKind: options.splitKind,
    datasetPath: resolvedDatasetPath,
    verificationGateBlocked: false,
    verificationDatasetValidationFailed: false,
    oneShotHoldoutConsumed,
    verificationPassed: thresholdCheck.passed,
    partitionStatus:
      options.splitKind === "one_shot_verification" && !thresholdCheck.passed
        ? "failed_one_shot_verification_do_not_reuse_if_inspected"
        : options.splitKind,
    roleProfileId: roleProfile.profileId,
    relationProfileId: relationProfile.profileId,
    runKind: roleProfile.runKind,
    formalBenchmarkEligible:
      roleProfile.formalBenchmarkEligible === true &&
      relationProfile.formalBenchmarkEligible === true &&
      options.splitKind === "one_shot_verification" &&
      thresholdCheck.passed,
    ...(oneShotHoldoutConsumed
      ? { consumedLedgerPaths, receiptPath: finalReceiptPath }
      : {}),
    ...(datasetValidation ? { datasetValidation } : {}),
    thresholdCheck,
    totalSnapshots: evalResult.totalSnapshots,
    totalConfirmedGoldRoleNodes: evalResult.totalConfirmedGoldRoleNodes,
    roleMetrics: evalResult.roleMetrics,
    relationMetrics: evalResult.relationMetrics,
    zeroGoldDenominatorViolations: evalResult.zeroGoldDenominatorViolations,
  };

  mkdirSync(dirname(finalReceiptPath), { recursive: true });
  writeFileSync(
    finalReceiptPath,
    `${JSON.stringify(report, null, 2)}\n`,
    oneShotHoldoutConsumed ? { encoding: "utf8", flag: "wx" } : "utf8",
  );
  if (oneShotHoldoutConsumed) {
    appendOneShotConsumedEntry(consumedLedgerPaths, {
      kind: "nnanything.w0a.one-shot-consumption-event.v1",
      event: "holdout_consumption_completed",
      recordedAt: new Date().toISOString(),
      datasetPath: resolvedDatasetPath,
      receiptPath: finalReceiptPath,
      partitionStatus: report.partitionStatus,
      verificationDatasetValidationFailed: false,
      verificationPassed: thresholdCheck.passed,
      oneShotHoldoutConsumed: true,
    });
  }
  return {
    report,
    passed: thresholdCheck.passed,
    receiptPath: finalReceiptPath,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report, passed, receiptPath } = runW0aStage2Evaluation(options);
  if (!passed) {
    if (report.alreadyConsumedReplayRejected) {
      console.error(
        `W0A_ONE_SHOT_HOLDOUT_ALREADY_CONSUMED: ${report.reason} (rejection receipt: ${receiptPath})`,
      );
    } else if (report.verificationGateBlocked) {
      console.error(
        `W0A_VERIFICATION_GATE_BLOCKED: stage1Passed=${report.stage1Passed}, runKind=${report.stage1RunKind}`,
      );
    } else if (report.verificationDatasetValidationFailed) {
      console.error(
        `W0A_VERIFICATION_ADMISSION_FAILED: ${report.datasetValidation?.violations?.length ?? 0} dataset violation(s) written to ${receiptPath}`,
      );
    } else {
      console.error(
        `W0A_EVALUATION_FAILED: ${report.thresholdCheck?.failures?.length ?? 0} threshold failure(s) written to ${receiptPath}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(`W0A_EVALUATION_PASSED: report written to ${receiptPath}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
