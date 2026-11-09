import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUnitCoverageReport,
  convertAllExistingUnitsToCoverageReport,
  descriptiveWilsonInterval,
  serializeFeatureVector,
} from "../dist/training/generalization-coverage.js";
import { makeCliCommandFixture } from "../dist/training/cli-command-samples.js";
import { validatePathProfile, zeroPathProfile } from "../dist/cli-training.js";

const worktreeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliScriptPath = resolve(worktreeRoot, "scripts/report-generalization-coverage.mjs");
const PATH_RUN_ID = "5be5fe28-1dbe-4558-9d23-23d2b441870a";
const CLI_COMMAND_RUN_ID = "35bd5ad9-15dc-409e-9001-bcab24f75398";
const DOM_RESULT_RELATIVE =
  "training/results/dom-basic-kinds/existing-properties-320c80ef-447e-41b3-be03-33197cd4b8d6.result.json";

function writeFixture(root, relativePath, value) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function makeSyntheticPathProfile(divergent = false) {
  const profile = zeroPathProfile();
  const weights = profile.weights.map(row => [...row]);
  if (divergent) {
    // Keep the rollout state deliberately different from teacher rows.
    weights[1][1] = 1;
    weights[4][1] = 1;
    weights[4][2] = 1;
  } else {
    weights[0][1] = 1;
    weights[1][1] = 1;
    weights[1][3] = -1;
    weights[2][2] = 1;
    weights[2][6] = 1;
    weights[3][2] = 1;
    weights[3][5] = 1;
    weights[3][7] = -1;
    weights[4][2] = 1;
    weights[4][4] = 1;
    weights[4][5] = 1;
  }
  return validatePathProfile({ ...profile, weights });
}

function makeSyntheticPathReport(dataset) {
  const comparison = {};
  for (const partition of ["train", "development", "holdout"]) {
    const rows = dataset.samples
      .filter(sample => sample.partition === partition)
      .map(sample => ({
        id: sample.id,
        expected: sample.expected,
        rollout: { ok: true, absolute: sample.expected },
      }));
    comparison[partition] = { trained: { rows }, candidate: { rows } };
  }
  return { comparison };
}

function makeSyntheticDomResult() {
  const transitions = { fixed: 0, regressed: 0, retained: 1, unresolved: 0, unassessed: 0 };
  return {
    assessment: {
      comparison: {
        rows: [{ index: 0, split: "train", transition: "retained", expectedLabel: "button", new: { basicKind: "button" } }],
        splits: {
          train: { eligibleCount: 1, transitions },
          eval: { eligibleCount: 1, transitions },
        },
      },
      candidate: { baseProfileId: "synthetic-base", candidateId: "synthetic-candidate" },
    },
  };
}

async function makePortableFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "a1-coverage-"));
  const cliSandboxRoot = join(root, "cli-sandbox");
  mkdirSync(cliSandboxRoot, { recursive: true });
  const { dataset: cliCommandDataset } = await makeCliCommandFixture({ root: cliSandboxRoot });
  writeFixture(
    root,
    `training/samples/filesystem/command/${CLI_COMMAND_RUN_ID}/samples.json`,
    cliCommandDataset,
  );
  const pathSamples = JSON.parse(
    readFileSync(join(worktreeRoot, "playground/cli/path-resolve/samples.fixture.json"), "utf8"),
  );
  writeFixture(root, `training/samples/path-resolve/${PATH_RUN_ID}/samples.json`, pathSamples);
  writeFixture(
    root,
    "training/samples/training-m1/reviewed-existing.json",
    readFileSync(join(worktreeRoot, "playground/training/reviewed.fixture.json"), "utf8"),
  );
  writeFixture(root, `training/weights/path-resolve/${PATH_RUN_ID}/candidate.json`, {
    profile: makeSyntheticPathProfile(false),
  });
  const pathReportPath = join(root, `training/results/path-resolve/${PATH_RUN_ID}/report.json`);
  writeFixture(root, `training/results/path-resolve/${PATH_RUN_ID}/report.json`, makeSyntheticPathReport(pathSamples));
  const domResultPath = join(root, DOM_RESULT_RELATIVE);
  writeFixture(root, DOM_RESULT_RELATIVE, makeSyntheticDomResult());
  return { root, pathReportPath, domResultPath };
}

test("A1-1: repeated step vectors report novelDistinctVectors=0 while preserving trajectory exactPathRate=1 without any auto boolean generalization flag", () => {
  const report = buildUnitCoverageReport({
    unitId: "cli.path-controller.v1",
    mode: "audit_diagnostic",
    samplingUnit: "step_clustered_by_trajectory",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [
      {
        rowId: "tr-1-s0",
        unitId: "cli.path-controller.v1",
        headGroupId: "cli.path.step-4x9.teacher_conditioned",
        featureSchemaId: "cli.path.step.v1",
        expectedDimension: 3,
        projectionSource: "teacher_conditioned",
        upstreamProfileSource: "teacherPathRows",
        features: [1, 0, 1],
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "structure-0",
        site: null,
        episodeOrTrajectoryId: "tr-1",
        rowOutcome: "passed",
      },
      {
        rowId: "ho-1-s0",
        unitId: "cli.path-controller.v1",
        headGroupId: "cli.path.step-4x9.teacher_conditioned",
        featureSchemaId: "cli.path.step.v1",
        expectedDimension: 3,
        projectionSource: "teacher_conditioned",
        upstreamProfileSource: "teacherPathRows",
        features: [1, 0, 1],
        partition: "holdout",
        partitionRole: "independent_verification",
        sourceGroupId: "structure-8",
        site: null,
        episodeOrTrajectoryId: "ho-1",
        rowOutcome: "passed",
      },
      {
        rowId: "ho-1-s1",
        unitId: "cli.path-controller.v1",
        headGroupId: "cli.path.step-4x9.teacher_conditioned",
        featureSchemaId: "cli.path.step.v1",
        expectedDimension: 3,
        projectionSource: "teacher_conditioned",
        upstreamProfileSource: "teacherPathRows",
        features: [1, 0, 1],
        partition: "holdout",
        partitionRole: "independent_verification",
        sourceGroupId: "structure-8",
        site: null,
        episodeOrTrajectoryId: "ho-1",
        rowOutcome: "passed",
      },
    ],
    episodeRows: [
      {
        episodeOrTrajectoryId: "tr-1",
        unitId: "cli.path-controller.v1",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "structure-0",
        site: null,
        compositionTag: "depth:1",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "ho-1",
        unitId: "cli.path-controller.v1",
        partition: "holdout",
        partitionRole: "independent_verification",
        sourceGroupId: "structure-8",
        site: null,
        compositionTag: "depth:6",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  });

  assert.equal("generalizationEvidence" in report, false);
  const group = report.headGroups["cli.path.step-4x9.teacher_conditioned"];
  assert.equal(group.projectionSource, "teacher_conditioned");
  assert.equal(group.upstreamProfileSource, "teacherPathRows");
  const holdoutHead = group.partitions.holdout;
  assert.equal(holdoutHead.inputVectorCoverage.distinctVectors, 1);
  assert.equal(holdoutHead.inputVectorCoverage.novelDistinctVectors, 0);
  assert.equal(holdoutHead.inputVectorCoverage.novelRowCount, 0);
  assert.equal(holdoutHead.inputVectorCoverage.novelRowAccuracy, null);
  assert.equal(holdoutHead.wilsonInterval.independenceAssumptionHolds, false);

  const holdoutTrajectory = report.trajectoryAndDecisionSetMetrics.partitions.holdout;
  assert.equal(holdoutTrajectory.totalCount, 1);
  assert.equal(holdoutTrajectory.evaluatedCount, 1);
  assert.equal(holdoutTrajectory.passedCount, 1);
  assert.equal(holdoutTrajectory.passRate, 1);
  assert.equal(holdoutTrajectory.realTargetAchievedCount, "not_available");
  assert.equal(holdoutTrajectory.wilsonInterval.samplingUnit, "step_clustered_by_trajectory");
  assert.equal(holdoutTrajectory.wilsonInterval.independenceAssumptionHolds, false);
});

test("A1-2: typed feature dimension, schema, or projectionSource mismatch within the same headGroupId is rejected", () => {
  assert.throws(
    () =>
      buildUnitCoverageReport({
        unitId: "browser.single-action-policy.v1",
        mode: "audit_diagnostic",
        samplingUnit: "element_row_clustered_by_snapshot",
        sourceClusterKey: "synthetic_family",
        targetBehaviorStatus: "static_forward_only",
        headRows: [
          {
            rowId: "r1",
            unitId: "browser.single-action-policy.v1",
            headGroupId: "browser.single-action.capability-3x8",
            featureSchemaId: "browser.single-action.capability.v1",
            expectedDimension: 8,
            projectionSource: "teacher_conditioned",
            upstreamProfileSource: "episode.teacher.providerRefs+unknownRefs",
            features: new Array(8).fill(0),
            partition: "train",
            partitionRole: "train",
            sourceGroupId: "fam-1",
            site: null,
            episodeOrTrajectoryId: "ep-1",
            rowOutcome: "not_available",
          },
          {
            rowId: "r2-mixed-projection-source",
            unitId: "browser.single-action-policy.v1",
            headGroupId: "browser.single-action.capability-3x8",
            featureSchemaId: "browser.single-action.capability.v1",
            expectedDimension: 8,
            projectionSource: "candidate_inference",
            upstreamProfileSource: "/path/to/candidate.json",
            features: new Array(8).fill(0),
            partition: "development",
            partitionRole: "development_diagnostic",
            sourceGroupId: "fam-2",
            site: null,
            episodeOrTrajectoryId: "ep-2",
            rowOutcome: "passed",
          },
        ],
        episodeRows: [],
      }),
    TypeError,
  );

  // Also reject candidateInferenceStatus="available" when no headGroup has projectionSource="candidate_inference"
  assert.throws(
    () =>
      buildUnitCoverageReport({
        unitId: "cli.path-controller.v1",
        mode: "audit_diagnostic",
        samplingUnit: "step_clustered_by_trajectory",
        sourceClusterKey: "synthetic_family",
        targetBehaviorStatus: "static_forward_only",
        candidateInferenceStatus: "available",
        headRows: [
          {
            rowId: "r1",
            unitId: "cli.path-controller.v1",
            headGroupId: "cli.path.step-4x9.teacher_conditioned",
            featureSchemaId: "cli.path.step.v1",
            expectedDimension: 3,
            projectionSource: "teacher_conditioned",
            upstreamProfileSource: "teacherPathRows",
            features: [1, 0, 1],
            partition: "train",
            partitionRole: "train",
            sourceGroupId: "structure-0",
            site: null,
            episodeOrTrajectoryId: "tr-1",
            rowOutcome: "not_available",
          },
        ],
        episodeRows: [],
      }),
    TypeError,
  );
});

test("A1-3: F2 candidate rows with not_applicable_candidate_row never copy decision-set accuracy onto candidate rows", () => {
  const report = buildUnitCoverageReport({
    unitId: "browser.strategy-policy.v1",
    mode: "audit_diagnostic",
    samplingUnit: "candidate_row_clustered_by_decision_set",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [
      {
        rowId: "c1",
        unitId: "browser.strategy-policy.v1",
        headGroupId: "browser.strategy.candidate-2x10.handwired_reference_diagnostic",
        featureSchemaId: "browser.strategy.candidate.v1",
        expectedDimension: 2,
        projectionSource: "handwired_reference_diagnostic",
        upstreamProfileSource: "inline_handwired_atomic_and_feedback_reference_weights",
        features: [1, 0],
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "mode-1",
        site: null,
        episodeOrTrajectoryId: "ep-1",
        rowOutcome: "not_applicable_candidate_row",
      },
      {
        rowId: "c2",
        unitId: "browser.strategy-policy.v1",
        headGroupId: "browser.strategy.candidate-2x10.handwired_reference_diagnostic",
        featureSchemaId: "browser.strategy.candidate.v1",
        expectedDimension: 2,
        projectionSource: "handwired_reference_diagnostic",
        upstreamProfileSource: "inline_handwired_atomic_and_feedback_reference_weights",
        features: [0, 1],
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "mode-1",
        site: null,
        episodeOrTrajectoryId: "ep-1",
        rowOutcome: "not_applicable_candidate_row",
      },
      {
        rowId: "c3",
        unitId: "browser.strategy-policy.v1",
        headGroupId: "browser.strategy.candidate-2x10.handwired_reference_diagnostic",
        featureSchemaId: "browser.strategy.candidate.v1",
        expectedDimension: 2,
        projectionSource: "handwired_reference_diagnostic",
        upstreamProfileSource: "inline_handwired_atomic_and_feedback_reference_weights",
        features: [1, 1],
        partition: "development",
        partitionRole: "development_diagnostic",
        sourceGroupId: "mode-2",
        site: null,
        episodeOrTrajectoryId: "ep-2",
        rowOutcome: "not_applicable_candidate_row",
      },
    ],
    episodeRows: [
      {
        episodeOrTrajectoryId: "ep-1",
        unitId: "browser.strategy-policy.v1",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "mode-1",
        site: null,
        compositionTag: "mode-1",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "ep-2",
        unitId: "browser.strategy-policy.v1",
        partition: "development",
        partitionRole: "development_diagnostic",
        sourceGroupId: "mode-2",
        site: null,
        compositionTag: "mode-2",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  });

  const devHead =
    report.headGroups["browser.strategy.candidate-2x10.handwired_reference_diagnostic"]
      .partitions.development;
  assert.equal(devHead.inputVectorCoverage.totalRowCount, 1);
  assert.equal(devHead.inputVectorCoverage.evaluatedRowCount, 0);
  assert.equal(devHead.inputVectorCoverage.overallRowAccuracy, null);
  assert.equal(devHead.inputVectorCoverage.novelRowAccuracy, null);
  assert.equal(devHead.wilsonInterval, null);

  const devDec = report.trajectoryAndDecisionSetMetrics.partitions.development;
  assert.equal(devDec.totalCount, 1);
  assert.equal(devDec.evaluatedCount, 1);
  assert.equal(devDec.passedCount, 1);
  assert.equal(devDec.passRate, 1);
});

test("A1-4: serializeFeatureVector strictly distinguishes missing null from numeric 0 and normalizes -0", () => {
  const kNull = serializeFeatureVector([null, 1, 0], 3);
  const kZero = serializeFeatureVector([0, 1, 0], 3);
  const kNegZero = serializeFeatureVector([-0, 1, 0], 3);
  assert.notEqual(kNull, kZero);
  assert.equal(kZero, kNegZero);
  assert.equal(descriptiveWilsonInterval(0, 0, "independent_scene_request", 0), null);
});

test("A1-5: cross-partition sourceGroupId overlap throws in admission_gate mode but reports leakage in audit_diagnostic mode for both headRows and episodeRows (including headRows=[])", () => {
  const sharedHeadInput = {
    unitId: "cli.command-policy.v1",
    samplingUnit: "independent_scene_request",
    sourceClusterKey: "scene_group",
    targetBehaviorStatus: "static_forward_only",
    headRows: [
      {
        rowId: "r1",
        unitId: "cli.command-policy.v1",
        headGroupId: "cli.command.head-13x38",
        featureSchemaId: "cli.command.stage2.v1",
        expectedDimension: 2,
        projectionSource: "direct_sample_features",
        upstreamProfileSource: "none_required",
        features: [1, 0],
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "leaked-scene-1",
        site: null,
        episodeOrTrajectoryId: "r1",
        rowOutcome: "passed",
      },
      {
        rowId: "r2",
        unitId: "cli.command-policy.v1",
        headGroupId: "cli.command.head-13x38",
        featureSchemaId: "cli.command.stage2.v1",
        expectedDimension: 2,
        projectionSource: "direct_sample_features",
        upstreamProfileSource: "none_required",
        features: [0, 1],
        partition: "development",
        partitionRole: "development_diagnostic",
        sourceGroupId: "leaked-scene-1",
        site: null,
        episodeOrTrajectoryId: "r2",
        rowOutcome: "passed",
      },
    ],
    episodeRows: [],
  };

  assert.throws(
    () => buildUnitCoverageReport({ ...sharedHeadInput, mode: "admission_gate" }),
    TypeError,
  );

  const diagnostic = buildUnitCoverageReport({ ...sharedHeadInput, mode: "audit_diagnostic" });
  const devSource =
    diagnostic.headGroups["cli.command.head-13x38"].partitions.development
      .sourceIndependence;
  assert.equal(devSource.sourceIsolationStatus, "leaked_across_partitions");
  assert.equal(devSource.overlappingSourceGroupCount, 1);
  assert.deepEqual(devSource.overlappingSourceGroupIds, ["leaked-scene-1"]);

  // Carol r4 probe 1: headRows=[] with episodeRows sharing sourceGroupId="same-family" across train/holdout
  const episodeOnlyLeakedInput = {
    unitId: "audit-probe",
    samplingUnit: "step_clustered_by_trajectory",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [],
    episodeRows: [
      {
        episodeOrTrajectoryId: "a",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "b",
        unitId: "audit-probe",
        partition: "holdout",
        partitionRole: "independent_verification",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  };

  assert.throws(
    () => buildUnitCoverageReport({ ...episodeOnlyLeakedInput, mode: "admission_gate" }),
    TypeError,
  );

  const epDiag = buildUnitCoverageReport({
    ...episodeOnlyLeakedInput,
    mode: "audit_diagnostic",
  });
  const holdoutEpStats = epDiag.trajectoryAndDecisionSetMetrics.partitions.holdout;
  assert.equal(holdoutEpStats.sourceIsolationStatus, "leaked_across_partitions");
  assert.equal(holdoutEpStats.overlappingSourceGroupCount, 1);
  assert.deepEqual(holdoutEpStats.overlappingSourceGroupIds, ["same-family"]);
  assert.equal(holdoutEpStats.wilsonInterval.independenceAssumptionHolds, false);

  // Positive admission_gate case with disjoint episode sourceGroupId:
  const episodeOnlyClean = buildUnitCoverageReport({
    ...episodeOnlyLeakedInput,
    mode: "admission_gate",
    samplingUnit: "independent_scene_request",
    episodeRows: [
      episodeOnlyLeakedInput.episodeRows[0],
      {
        ...episodeOnlyLeakedInput.episodeRows[1],
        sourceGroupId: "disjoint-family",
      },
    ],
  });
  assert.equal(
    episodeOnlyClean.trajectoryAndDecisionSetMetrics.partitions.holdout
      .sourceIsolationStatus,
    "clean",
  );
  assert.equal(
    episodeOnlyClean.trajectoryAndDecisionSetMetrics.partitions.holdout.wilsonInterval
      .independenceAssumptionHolds,
    true,
  );
});

test("A1-6: trajectory/decision-set Wilson interval respects samplingUnit and within-partition family clustering (Carol r4 probe 2)", () => {
  // Negative case 1 (Carol r4 probe 2): samplingUnit="step_clustered_by_trajectory" and two episodes in train with sourceGroupId="same-family"
  const clusteredProbe = buildUnitCoverageReport({
    unitId: "audit-probe",
    mode: "audit_diagnostic",
    samplingUnit: "step_clustered_by_trajectory",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [],
    episodeRows: [
      {
        episodeOrTrajectoryId: "a",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "b",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  });
  const trainStats = clusteredProbe.trajectoryAndDecisionSetMetrics.partitions.train;
  assert.equal(trainStats.wilsonInterval.passed, 2);
  assert.equal(trainStats.wilsonInterval.total, 2);
  assert.equal(trainStats.wilsonInterval.samplingUnit, "step_clustered_by_trajectory");
  assert.equal(trainStats.withinPartitionClustered, true);
  assert.equal(trainStats.wilsonInterval.withinPartitionClustered, true);
  assert.equal(trainStats.wilsonInterval.independenceAssumptionHolds, false);

  // Negative case 2: even with samplingUnit="independent_scene_request", two episodes sharing sourceGroupId="same-family" in one partition are clustered!
  const sameFamilySceneProbe = buildUnitCoverageReport({
    unitId: "audit-probe",
    mode: "audit_diagnostic",
    samplingUnit: "independent_scene_request",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [],
    episodeRows: [
      {
        episodeOrTrajectoryId: "a",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "b",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "same-family",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  });
  assert.equal(
    sameFamilySceneProbe.trajectoryAndDecisionSetMetrics.partitions.train.wilsonInterval
      .independenceAssumptionHolds,
    false,
  );

  // Positive case: samplingUnit="independent_scene_request", no cross-partition overlap, and each episode has its own independent sourceGroupId
  const independentScenes = buildUnitCoverageReport({
    unitId: "audit-probe",
    mode: "audit_diagnostic",
    samplingUnit: "independent_scene_request",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    headRows: [],
    episodeRows: [
      {
        episodeOrTrajectoryId: "a",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "family-1",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
      {
        episodeOrTrajectoryId: "b",
        unitId: "audit-probe",
        partition: "train",
        partitionRole: "train",
        sourceGroupId: "family-2",
        site: null,
        compositionTag: "a",
        episodeOutcome: "passed",
        realTargetStatus: "not_available",
      },
    ],
  });
  const indepTrain = independentScenes.trajectoryAndDecisionSetMetrics.partitions.train;
  assert.equal(indepTrain.withinPartitionClustered, false);
  assert.equal(indepTrain.wilsonInterval.independenceAssumptionHolds, true);
});

test("A1-7: portable six-unit converter separates teacher_conditioned from candidate_inference and keeps historical diagnostics when candidates are omitted", async () => {
  const fixture = await makePortableFixtureRepository();
  try {
    const commonOptions = {
      repositoryRoot: fixture.root,
      mode: "audit_diagnostic",
      cliPathReportPath: fixture.pathReportPath,
      domResultPath: fixture.domResultPath,
      browserAtomicProfilePath: null,
      browserFeedbackProfilePath: null,
      browserStrategyProfilePath: null,
    };
    const bundleWithCandidates = convertAllExistingUnitsToCoverageReport({
      ...commonOptions,
      includeUpstreamCandidateInference: true,
    });

    const cliBase =
      bundleWithCandidates.units["cli.command-policy.v1"].headGroups[
        "cli.command.head-13x38"
      ].partitions;
    assert.ok(cliBase.train.inputVectorCoverage.totalRowCount > 0);
    assert.ok(cliBase.development.inputVectorCoverage.totalRowCount > 0);

    const pathUnit = bundleWithCandidates.units["cli.path-controller.v1"];
    assert.equal(pathUnit.candidateInferenceStatus, "available");
    assert.equal(pathUnit.historicalDiagnosticSource, fixture.pathReportPath);
    const pathTeacherGroup =
      pathUnit.headGroups["cli.path.step-4x9.teacher_conditioned"];
    assert.equal(pathTeacherGroup.projectionSource, "teacher_conditioned");
    assert.equal(pathTeacherGroup.upstreamProfileSource, "teacherPathRows");
    assert.ok(pathTeacherGroup.partitions.train.inputVectorCoverage.totalRowCount > 0);
    assert.ok(pathTeacherGroup.partitions.development.inputVectorCoverage.totalRowCount > 0);
    assert.ok(pathTeacherGroup.partitions.holdout.inputVectorCoverage.totalRowCount > 0);

    const pathCandGroup =
      pathUnit.headGroups["cli.path.step-4x9.candidate_inference"];
    assert.equal(pathCandGroup.projectionSource, "candidate_inference");
    assert.equal(
      pathCandGroup.upstreamProfileSource.endsWith(
        `training/weights/path-resolve/${PATH_RUN_ID}/candidate.json`,
      ),
      true,
    );
    assert.equal(
      pathCandGroup.partitions.train.inputVectorCoverage.evaluatedRowCount,
      pathCandGroup.partitions.train.inputVectorCoverage.totalRowCount,
    );
    const pathWithHoldout = pathUnit.trajectoryAndDecisionSetMetrics.partitions.holdout;
    assert.ok(pathWithHoldout.totalCount > 0);
    assert.equal(pathWithHoldout.evaluatedCount, pathWithHoldout.totalCount);
    assert.equal(pathWithHoldout.passRate, 1);
    assert.equal(
      pathUnit.trajectoryAndDecisionSetMetrics.partitions.holdout.realTargetAchievedCount,
      "not_available",
    );

    const domWithHistorical = bundleWithCandidates.units["dom.basic-kinds.v1"];
    assert.notEqual(domWithHistorical.domPairedTransitions, "not_available");
    assert.equal(domWithHistorical.domPairedTransitions.splits.train.eligibleCount, 1);

    const bundleWithoutCandidates = convertAllExistingUnitsToCoverageReport({
      ...commonOptions,
      includeUpstreamCandidateInference: false,
    });
    const pathNoCand = bundleWithoutCandidates.units["cli.path-controller.v1"];
    assert.equal(pathNoCand.candidateInferenceStatus, "not_available");
    assert.equal(
      "cli.path.step-4x9.candidate_inference" in pathNoCand.headGroups,
      false,
    );
    assert.equal(
      "cli.path.step-4x9.teacher_conditioned" in pathNoCand.headGroups,
      true,
    );
    assert.equal(pathNoCand.historicalDiagnosticSource, fixture.pathReportPath);
    const pathNoCandHoldout = pathNoCand.trajectoryAndDecisionSetMetrics.partitions.holdout;
    assert.ok(pathNoCandHoldout.totalCount > 0);
    assert.equal(pathNoCandHoldout.evaluatedCount, pathNoCandHoldout.totalCount);
    assert.equal(pathNoCandHoldout.passedCount, pathNoCandHoldout.totalCount);
    assert.equal(pathNoCandHoldout.passRate, 1);
    assert.equal(pathNoCandHoldout.realTargetAchievedCount, "not_available");

    const domNoCand = bundleWithoutCandidates.units["dom.basic-kinds.v1"];
    assert.equal(domNoCand.candidateInferenceStatus, "not_applicable");
    assert.notEqual(domNoCand.domPairedTransitions, "not_available");
    assert.equal(domNoCand.domPairedTransitions.historicalResultSource, fixture.domResultPath);
    assert.equal(domNoCand.domPairedTransitions.splits.train.eligibleCount, 1);

    const saNoCand = bundleWithoutCandidates.units["browser.single-action-policy.v1"];
    assert.equal(saNoCand.candidateInferenceStatus, "not_available");
    assert.equal(
      "browser.single-action.capability-3x8.candidate_inference" in saNoCand.headGroups,
      false,
    );
    assert.equal(
      "browser.single-action.capability-3x8.teacher_conditioned" in saNoCand.headGroups,
      true,
    );

    const f2NoCand = bundleWithoutCandidates.units["browser.strategy-policy.v1"];
    assert.equal(f2NoCand.candidateInferenceStatus, "not_available");
    assert.equal(
      "browser.strategy.candidate-2x10.candidate_inference" in f2NoCand.headGroups,
      false,
    );
    assert.equal(
      "browser.strategy.candidate-2x10.handwired_reference_diagnostic" in f2NoCand.headGroups,
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("A1-8: CLI entry scripts/report-generalization-coverage.mjs supports --repo-root, --mode, and --without-upstream-candidates and rejects unknown flags", async () => {
  const fixture = await makePortableFixtureRepository();
  try {
    const stdoutWithCandidates = execFileSync(
      process.execPath,
      [
        cliScriptPath,
        "--repo-root",
        fixture.root,
        "--mode",
        "audit_diagnostic",
        "--cli-command-samples",
        join(
          fixture.root,
          `training/samples/filesystem/command/${CLI_COMMAND_RUN_ID}/samples.json`,
        ),
      ],
      { encoding: "utf8", cwd: tmpdir() },
    );
    assert.doesNotMatch(stdoutWithCandidates, /\/Volumes\/|\/Users\//);
    const parsedWith = JSON.parse(stdoutWithCandidates);
    assert.equal(parsedWith.schemaVersion, 1);
    assert.equal(parsedWith.mode, "audit_diagnostic");
    assert.equal(
      parsedWith.units["cli.path-controller.v1"].candidateInferenceStatus,
      "available",
    );
    assert.equal(
      "cli.path.step-4x9.candidate_inference" in
        parsedWith.units["cli.path-controller.v1"].headGroups,
      true,
    );

    const stdoutWithoutCandidates = execFileSync(
      process.execPath,
      [
        cliScriptPath,
        "--repo-root",
        fixture.root,
        "--mode",
        "audit_diagnostic",
        "--without-upstream-candidates",
        "--cli-command-samples",
        join(
          fixture.root,
          `training/samples/filesystem/command/${CLI_COMMAND_RUN_ID}/samples.json`,
        ),
      ],
      { encoding: "utf8", cwd: tmpdir() },
    );
    assert.doesNotMatch(stdoutWithoutCandidates, /\/Volumes\/|\/Users\//);
    const parsedWithout = JSON.parse(stdoutWithoutCandidates);
    assert.equal(parsedWithout.schemaVersion, 1);
    assert.equal(parsedWithout.mode, "audit_diagnostic");
    assert.equal(
      parsedWithout.units["cli.path-controller.v1"].candidateInferenceStatus,
      "not_available",
    );
    assert.equal(
      "cli.path.step-4x9.candidate_inference" in
        parsedWithout.units["cli.path-controller.v1"].headGroups,
      false,
    );
    assert.equal(
      parsedWithout.units["cli.path-controller.v1"].trajectoryAndDecisionSetMetrics
        .partitions.holdout.evaluatedCount,
      parsedWithout.units["cli.path-controller.v1"].trajectoryAndDecisionSetMetrics
        .partitions.holdout.totalCount,
    );
    assert.notEqual(
      parsedWithout.units["dom.basic-kinds.v1"].domPairedTransitions,
      "not_available",
    );

    assert.throws(() =>
      execFileSync(process.execPath, [cliScriptPath, "--unknown-flag"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [cliScriptPath], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /--repo-root is required/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("A1-9: diverging path candidate profile proves candidate_inference uses rollout state rather than teacher rows, and missing historical reports preserve not_available boundaries", async () => {
  const fixture = await makePortableFixtureRepository();
  const tmpDir = mkdtempSync(join(tmpdir(), "a1-path-divergence-"));
  try {
    const divergingProfile = makeSyntheticPathProfile(true);
    const divergingProfilePath = join(tmpDir, "diverging-path-candidate.json");
    writeFileSync(
      divergingProfilePath,
      JSON.stringify({ profile: divergingProfile }, null, 2),
    );

    const bundleDiverged = convertAllExistingUnitsToCoverageReport({
      repositoryRoot: fixture.root,
      mode: "audit_diagnostic",
      cliCommandSamplesPath: join(
        fixture.root,
        `training/samples/filesystem/command/${CLI_COMMAND_RUN_ID}/samples.json`,
      ),
      cliPathProfilePath: divergingProfilePath,
      cliPathReportPath: null,
      domResultPath: null,
      browserAtomicProfilePath: null,
      browserFeedbackProfilePath: null,
      browserStrategyProfilePath: null,
      includeUpstreamCandidateInference: false,
    });

    const pathUnit = bundleDiverged.units["cli.path-controller.v1"];
    assert.equal(pathUnit.candidateInferenceStatus, "available");
    assert.equal(pathUnit.historicalDiagnosticSource, null);

    const teacherTrain =
      pathUnit.headGroups["cli.path.step-4x9.teacher_conditioned"].partitions.train
        .inputVectorCoverage;
    const candTrain =
      pathUnit.headGroups["cli.path.step-4x9.candidate_inference"].partitions.train
        .inputVectorCoverage;

    assert.ok(teacherTrain.totalRowCount > 0);
    assert.ok(teacherTrain.distinctVectors > 1);
    assert.equal(candTrain.evaluatedRowCount, candTrain.totalRowCount);
    assert.equal(candTrain.passedRowCount < candTrain.totalRowCount, true);
    assert.notEqual(candTrain.distinctVectors, teacherTrain.distinctVectors);

    const holdoutTraj = pathUnit.trajectoryAndDecisionSetMetrics.partitions.holdout;
    assert.ok(holdoutTraj.totalCount > 0);
    assert.equal(holdoutTraj.evaluatedCount, 0);
    assert.equal(holdoutTraj.passRate, null);
    assert.equal(holdoutTraj.wilsonInterval, null);
    assert.equal(holdoutTraj.realTargetAchievedCount, "not_available");

    const domUnit = bundleDiverged.units["dom.basic-kinds.v1"];
    assert.equal(domUnit.historicalDiagnosticSource, null);
    assert.equal(domUnit.domPairedTransitions, "not_available");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

