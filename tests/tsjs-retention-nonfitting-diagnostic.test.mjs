import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTsjsRetentionNonfittingDiagnosticConfig,
  runTsjsRetentionNonfittingDiagnostic,
  TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
  TSJS_RETENTION_NONFITTING_DIAGNOSTIC_REPORT_SCHEMA,
} from "../dist/training/tsjs-retention-nonfitting-diagnostic.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import { UNIFIED_ENCODER_VERSION } from "../dist/training/unified-encoder.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";

const THRESHOLDS_REF = "feature-thresholds.json";
const MISSING_MODE_REF = "missing-mode.json";

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path, rows) {
  return writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-retention-diagnostic-"));
  await writeJson(join(root, THRESHOLDS_REF), {});
  await writeJson(join(root, MISSING_MODE_REF), {});
  return root;
}

function baseTensors(w1 = {}) {
  const tensors = zeroTensors();
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  for (const [slot, value] of Object.entries(w1)) {
    tensors.W1[Number(slot)] = value;
  }
  return tensors;
}

async function writePackage(root, name, tensors, overrides = {}) {
  return saveUnifiedModelPackageAtomic(
    join(root, `${name}.json`),
    createUnifiedModelPackage({
      modelId: `test-${name}`,
      version: "1",
      route: { domain: "tsjs", decisionKind: "R" },
      tensors,
      resources: {
        thresholdsRef: THRESHOLDS_REF,
        thresholdsSchema: "nnanything.feature-thresholds.v1",
        missingModeTableRef: MISSING_MODE_REF,
        missingModeSchema: "nnanything.unified.missing-mode.v1",
      },
      fixedStages: ["nnanything.unified-step.encoder.v2"],
      ...overrides,
    }),
  );
}

function oneHot(slot, extraSlots = []) {
  const vector = Array.from({ length: 64 }, () => 0);
  vector[slot] = 1;
  for (const extra of extraSlots) vector[extra] = 1;
  return vector;
}

function studentRow(groupId, sampleId, sourceGroup, candidateRef, x) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: groupId,
    sampleId,
    requestRef: `request:${groupId}`,
    stepId: "step-1",
    targetRef: "target-1",
    pendingRelationRef: null,
    sourceGroup,
    language: "ts",
    adapterRef: "test-adapter",
    derivationFamily: "test-family",
    semanticStratum: "module_export",
    stepContextRef: `ctx:${groupId}`,
    candidateGroupRef: `candidate-group:${groupId}`,
    featureSchemaVersion: "v1",
    encoderVersion: UNIFIED_ENCODER_VERSION,
    partition: "TRAIN",
    candidateEnumeration: "complete",
    coverageCursorRef: "cursor:complete",
    evidenceRefs: [],
    failureMode: null,
    candidateRef,
    optionSemantics: "judge=true",
    candidateKind: "action",
    x,
    missingMode: [],
  };
}

function supervisionRow(groupId, sampleId, sourceGroup, allowedRefs, labelMissing = false) {
  return {
    schema: "nnanything.unified.supervision-row.v1",
    group_id: groupId,
    sampleId,
    sourceGroup,
    partition: "TRAIN",
    goldAllowedCandidateRefs: labelMissing ? [] : allowedRefs,
    labelMissing,
    unknownReason: labelMissing ? "label_missing" : null,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    teacherResolutionRef: `teacher:${groupId}`,
    trainingEligible: true,
  };
}

async function writeMainRows(root) {
  const groups = [
    {
      groupId: "g-control",
      sampleId: "s-control",
      sourceGroup: "control",
      allowed: ["c:judge:true"],
      candidates: [
        ["c:judge:true", oneHot(46)],
        ["c:judge:false", oneHot(47)],
      ],
    },
    {
      groupId: "g-score",
      sampleId: "s-score",
      sourceGroup: "score",
      allowed: ["c:judge:true"],
      candidates: [
        ["c:judge:true", oneHot(44)],
        ["c:judge:false", oneHot(45)],
      ],
    },
    {
      groupId: "g-policy",
      sampleId: "s-policy",
      sourceGroup: "policy",
      allowed: ["candidate-a"],
      candidates: [
        ["candidate-a", oneHot(42)],
        ["candidate-b", oneHot(43)],
      ],
    },
    {
      groupId: "g-collision-left",
      sampleId: "s-collision-left",
      sourceGroup: "collision",
      allowed: ["false-arm"],
      candidates: [
        ["false-arm", oneHot(40, [36])],
        ["other", oneHot(49)],
      ],
    },
    {
      groupId: "g-collision-right",
      sampleId: "s-collision-right",
      sourceGroup: "collision",
      allowed: ["unknown-arm"],
      candidates: [
        ["unknown-arm", oneHot(40, [37])],
        ["other", oneHot(49)],
      ],
    },
    {
      groupId: "g-no-collision-left",
      sampleId: "s-no-collision-left",
      sourceGroup: "no-collision",
      allowed: ["false-arm"],
      candidates: [
        ["false-arm", oneHot(40, [36])],
        ["other", oneHot(49)],
      ],
    },
    {
      groupId: "g-no-collision-right",
      sampleId: "s-no-collision-right",
      sourceGroup: "no-collision",
      allowed: ["unknown-arm"],
      candidates: [
        ["unknown-arm", oneHot(41, [36])],
        ["other", oneHot(49)],
      ],
    },
    {
      groupId: "g-label-missing",
      sampleId: "s-label-missing",
      sourceGroup: "missing",
      allowed: [],
      labelMissing: true,
      candidates: [["missing", oneHot(48)]],
    },
  ];

  const studentRows = groups.flatMap(group =>
    group.candidates.map(([candidateRef, x]) =>
      studentRow(group.groupId, group.sampleId, group.sourceGroup, candidateRef, x)
    )
  );
  const supervisionRows = groups.map(group =>
    supervisionRow(
      group.groupId,
      group.sampleId,
      group.sourceGroup,
      group.allowed,
      group.labelMissing === true,
    )
  );
  const studentRowsPath = join(root, "student-rows.jsonl");
  const supervisionRowsPath = join(root, "supervision-rows.jsonl");
  await writeJsonl(studentRowsPath, studentRows);
  await writeJsonl(supervisionRowsPath, supervisionRows);
  return { studentRowsPath, supervisionRowsPath };
}

async function makeMainFixture() {
  const root = await makeRoot();
  const sourcePackagePath = await writePackage(
    root,
    "source",
    baseTensors({
      40: 1,
      41: 1,
      42: 1,
      43: 0,
      44: 1,
      45: 0,
      46: 1,
      47: 0,
      48: 1,
    }),
  );
  const renewedPackagePath = await writePackage(
    root,
    "renewed",
    baseTensors({
      40: 1,
      41: 1,
      42: 0,
      43: 1,
      44: 2,
      45: 1,
      46: 2,
      47: 0,
      48: 1,
    }),
  );
  const rows = await writeMainRows(root);
  return { root, sourcePackagePath, renewedPackagePath, ...rows };
}

function mainConfig(fixture, comparisons) {
  return {
    schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
    sourcePackagePath: fixture.sourcePackagePath,
    renewedPackagePath: fixture.renewedPackagePath,
    studentRowsPath: fixture.studentRowsPath,
    supervisionRowsPath: fixture.supervisionRowsPath,
    tau: 0.1,
    ...(comparisons === undefined ? {} : { comparisons }),
  };
}

const declaredComparisons = [
  {
    comparisonRef: "collision-positive",
    pairRef: "rc-p01",
    leftGroupId: "g-collision-left",
    leftCandidateRef: "false-arm",
    rightGroupId: "g-collision-right",
    rightCandidateRef: "unknown-arm",
  },
  {
    comparisonRef: "collision-negative",
    pairRef: "rc-p02",
    leftGroupId: "g-no-collision-left",
    leftCandidateRef: "false-arm",
    rightGroupId: "g-no-collision-right",
    rightCandidateRef: "unknown-arm",
  },
];

test("retention diagnostic reports per-package decisions and declared feature differences", async () => {
  const fixture = await makeMainFixture();
  try {
    const result = await runTsjsRetentionNonfittingDiagnostic(mainConfig(fixture, declaredComparisons));
    assert.equal(result.exitCode, 0);
    const report = result.report;
    assert.equal(report.schema, TSJS_RETENTION_NONFITTING_DIAGNOSTIC_REPORT_SCHEMA);
    assert.equal(report.status, "completed");
    assert.equal(report.error, null);
    assert.equal(report.inputs.tau, 0.1);
    assert.equal(report.comparisons.length, 2);

    const byGroup = new Map(report.groups.map(group => [group.groupId, group]));
    const control = byGroup.get("g-control");
    assert.equal(control.candidates.length, 2);
    assert.equal(control.source.selectedCandidateRef, "c:judge:true");
    assert.equal(control.renewed.selectedCandidateRef, "c:judge:true");
    assert.equal(control.source.margin, 1);
    assert.equal(control.renewed.margin, 2);
    assert.equal(control.marginDelta, 1);
    assert.equal(control.classification.scoreChange, true);
    assert.equal(control.classification.candidatePolicySelection, true);
    assert.equal(control.classification.featureCollision, null);

    const trueCandidate = control.candidates.find(candidate => candidate.candidateRef === "c:judge:true");
    assert.equal(trueCandidate.sourceScore, 1);
    assert.equal(trueCandidate.renewedScore, 2);
    assert.equal(trueCandidate.scoreDelta, 1);

    const score = byGroup.get("g-score");
    assert.equal(score.source.margin, 1);
    assert.equal(score.renewed.margin, 1);
    assert.equal(score.classification.scoreChange, true);
    assert.equal(score.classification.candidatePolicySelection, false);

    const policy = byGroup.get("g-policy");
    assert.equal(policy.source.selectedCandidateRef, "candidate-a");
    assert.equal(policy.renewed.selectedCandidateRef, "candidate-b");
    assert.equal(policy.classification.candidatePolicySelection, true);

    const collisionPositive = report.comparisons.find(entry => entry.comparisonRef === "collision-positive");
    assert.equal(collisionPositive.featureCollision, true);
    assert.deepEqual([...collisionPositive.differingSlotsOutsideOptionIdentity].sort((a, b) => a - b), []);
    assert.deepEqual([...collisionPositive.optionIdentityDifferences].sort((a, b) => a - b), [36, 37]);

    const collisionNegative = report.comparisons.find(entry => entry.comparisonRef === "collision-negative");
    assert.equal(collisionNegative.featureCollision, false);
    assert.deepEqual([...collisionNegative.differingSlotsOutsideOptionIdentity].sort((a, b) => a - b), [40, 41]);

    assert.equal(byGroup.get("g-collision-left").classification.featureCollision, true);
    assert.equal(byGroup.get("g-collision-right").classification.featureCollision, true);
    assert.equal(byGroup.get("g-no-collision-left").classification.featureCollision, false);
    assert.equal(byGroup.get("g-no-collision-right").classification.featureCollision, false);

    assert.equal(report.labelMissing.count, 1);
    assert.equal(report.labelMissing.rows[0].groupId, "g-label-missing");
    assert.equal(byGroup.has("g-label-missing"), false);
    assert.equal(report.summary.groups, 7);
    assert.equal(report.summary.candidates, 14);
    assert.equal(report.summary.labelMissingExclusions, 1);
    assert.equal(report.summary.comparisons, 2);
    assert.equal(report.summary.collisions, 1);
    assert.equal(report.summary.scoreChanges, 3);
    assert.equal(report.summary.policySelectionChanges, 2);

    const noComparisons = await runTsjsRetentionNonfittingDiagnostic(mainConfig(fixture));
    assert.equal(noComparisons.exitCode, 0);
    assert.equal(noComparisons.report.comparisons, "not_requested");
    assert.equal(noComparisons.report.summary.comparisons, 0);
    assert.ok(
      noComparisons.report.groups.every(
        group => group.classification.featureCollision === null,
      ),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retention diagnostic returns typed failures for package and comparison mismatches", async () => {
  const root = await makeRoot();
  try {
    const sourcePackagePath = await writePackage(root, "source", baseTensors());
    const renewedPackagePath = await writePackage(
      root,
      "renewed",
      baseTensors(),
      {
        route: { domain: "browser", decisionKind: "R" },
        encoderVersion: BA1_ENCODER_VERSION,
      },
    );
    const incompatible = await runTsjsRetentionNonfittingDiagnostic({
      schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
      sourcePackagePath,
      renewedPackagePath,
      studentRowsPath: join(root, "unused-student.jsonl"),
      supervisionRowsPath: join(root, "unused-supervision.jsonl"),
      tau: 0.1,
    });
    assert.equal(incompatible.exitCode, 1);
    assert.equal(incompatible.report.status, "failed");
    assert.equal(incompatible.report.error.code, "PACKAGE_INCOMPATIBLE");
    assert.match(incompatible.report.error.message, /incompatible/);
    assert.ok(incompatible.report.sourcePackage);
    assert.ok(incompatible.report.renewedPackage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const fixture = await makeMainFixture();
  try {
    const missing = await runTsjsRetentionNonfittingDiagnostic(mainConfig(fixture, [
      {
        comparisonRef: "missing",
        pairRef: "rc-missing",
        leftGroupId: "not-a-group",
        leftCandidateRef: "not-a-candidate",
        rightGroupId: "g-collision-right",
        rightCandidateRef: "unknown-arm",
      },
    ]));
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.report.status, "failed");
    assert.equal(missing.report.error.code, "COMPARISON_TARGET_MISSING");
    assert.match(missing.report.error.message, /not-a-group/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retention diagnostic rejects extra package slots and invalid tau", async () => {
  const fixture = await makeMainFixture();
  try {
    const extraPackage = await runTsjsRetentionNonfittingDiagnostic({
      ...mainConfig(fixture),
      candidatePackagePath: fixture.renewedPackagePath,
    });
    assert.equal(extraPackage.exitCode, 1);
    assert.equal(extraPackage.report.error.code, "CONFIG_INVALID");
    assert.match(extraPackage.report.error.message, /unexpected field/);

    const badTau = await runTsjsRetentionNonfittingDiagnostic({
      ...mainConfig(fixture),
      tau: 0.2,
    });
    assert.equal(badTau.exitCode, 1);
    assert.equal(badTau.report.error.code, "CONFIG_INVALID");
    assert.match(badTau.report.error.message, /fixed 0\.1/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retention config loader validates without loading packages or rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-retention-config-loader-"));
  const configPath = join(root, "retention-nonfitting.runner-config.json");
  const notAssessedComparisons = [
    {
      pairRef: "rc-p01",
      status: "not_assessed",
      reason: "no retained static-false arm for this contrast",
    },
    {
      pairRef: "rc-p02",
      status: "not_assessed",
      reason: "no retained static-false arm for this contrast",
    },
    {
      pairRef: "rc-p03",
      status: "not_assessed",
      reason: "no retained static-false arm for this contrast",
    },
  ];
  try {
    await writeJson(configPath, {
      schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
      sourcePackagePath: join(root, "missing-source-package.json"),
      renewedPackagePath: join(root, "missing-renewed-package.json"),
      studentRowsPath: join(root, "missing-student-rows.jsonl"),
      supervisionRowsPath: join(root, "missing-supervision-rows.jsonl"),
      tau: 0.1,
      notAssessedComparisons,
    });
    const config = await loadTsjsRetentionNonfittingDiagnosticConfig(configPath);
    assert.equal(config.schema, TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA);
    assert.equal(config.tau, 0.1);
    assert.equal(config.comparisons, undefined);
    assert.deepEqual(config.notAssessedComparisons, notAssessedComparisons);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention config loader rejects invalid not_assessed declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-retention-config-loader-"));
  const configPath = join(root, "retention-nonfitting.runner-config.json");
  const base = {
    schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
    sourcePackagePath: join(root, "missing-source-package.json"),
    renewedPackagePath: join(root, "missing-renewed-package.json"),
    studentRowsPath: join(root, "missing-student-rows.jsonl"),
    supervisionRowsPath: join(root, "missing-supervision-rows.jsonl"),
    tau: 0.1,
  };
  try {
    await writeJson(configPath, {
      ...base,
      notAssessedComparisons: [
        { pairRef: "rc-p01", status: "assessed", reason: "invalid status" },
      ],
    });
    await assert.rejects(
      () => loadTsjsRetentionNonfittingDiagnosticConfig(configPath),
      error => error.code === "CONFIG_INVALID" && /status must be not_assessed/.test(error.message),
    );

    await writeJson(configPath, {
      ...base,
      comparisons: [
        {
          comparisonRef: "assessed-p01",
          pairRef: "rc-p01",
          leftGroupId: "left",
          leftCandidateRef: "left-candidate",
          rightGroupId: "right",
          rightCandidateRef: "right-candidate",
        },
      ],
      notAssessedComparisons: [
        { pairRef: "rc-p01", status: "not_assessed", reason: "duplicate pair" },
      ],
    });
    await assert.rejects(
      () => loadTsjsRetentionNonfittingDiagnosticConfig(configPath),
      error => error.code === "CONFIG_INVALID" && /both assessed and not_assessed/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention diagnostic does not import the standard runner or hardcode production data paths", async () => {
  const modulePath = fileURLToPath(
    new URL("../lib/training/tsjs-retention-nonfitting-diagnostic.ts", import.meta.url),
  );
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /l2-standard-runner/);
  assert.doesNotMatch(source, /nnanything-runs/);
  assert.doesNotMatch(source, /\/Volumes\/extension\/code\/NNAnything/);
});
