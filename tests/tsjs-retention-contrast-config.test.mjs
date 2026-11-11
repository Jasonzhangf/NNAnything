import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  runTsjsRetentionContrastConfigValidation,
  TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA,
  TSJS_RETENTION_CONTRAST_REPORT_SCHEMA,
} from "../dist/training/tsjs-retention-contrast-config.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import { UNIFIED_ENCODER_VERSION } from "../dist/training/unified-encoder.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VALIDATOR_SCRIPT = join(
  REPO_ROOT,
  "scripts",
  "validate-tsjs-retention-contrast.mjs",
);

const THRESHOLDS_REF = "feature-thresholds.json";
const MISSING_MODE_REF = "missing-mode.json";

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path, rows) {
  return writeFile(
    path,
    `${rows.map(row => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function oneHot(slot) {
  const vector = Array.from({ length: 64 }, () => 0);
  vector[slot] = 1;
  return vector;
}

function studentRow(
  groupId,
  sampleId,
  candidateRef,
  slot,
  options = {},
) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: groupId,
    sampleId,
    requestRef: `request:${sampleId}`,
    stepId: "step:0",
    targetRef: "target-1",
    pendingRelationRef: `pending:${sampleId}`,
    sourceGroup: options.sourceGroup ?? "baseline",
    language: "ts",
    adapterRef: "test-adapter",
    derivationFamily: "test-family",
    semanticStratum: "module_export",
    stepContextRef: `ctx:${sampleId}:step:0`,
    candidateGroupRef: `cg:${sampleId}:step:0:0`,
    featureSchemaVersion: "nnanything.unified.feature.v1",
    encoderVersion: UNIFIED_ENCODER_VERSION,
    partition: options.partition ?? "TRAIN",
    candidateEnumeration: "complete",
    coverageCursorRef: `coverage:${sampleId}`,
    evidenceRefs: [],
    failureMode: null,
    candidateRef,
    optionSemantics: candidateRef,
    candidateKind: "relation",
    x: oneHot(slot),
    missingMode: [],
  };
}

function supervisionRow(groupId, sampleId, allowed, options = {}) {
  return {
    schema: "nnanything.unified.supervision-row.v1",
    group_id: groupId,
    sampleId,
    sourceGroup: options.sourceGroup ?? "baseline",
    partition: options.partition ?? "TRAIN",
    goldAllowedCandidateRefs: options.labelMissing ? [] : allowed,
    labelMissing: options.labelMissing ?? false,
    unknownReason: options.unknownReason ?? null,
    labelAuthority: options.labelAuthority ?? "researcher_structural_proof",
    oracleKind: options.oracleKind ?? "independent_tsc",
    teacherResolutionRef: null,
    requestRef: `request:${sampleId}`,
    stepId: "step:0",
    trainingEligible: options.trainingEligible ?? true,
    notReadyReason: null,
    agSubsetOfSg: true,
  };
}

function contrastStudentRows(groupId, sampleId, firstSlot) {
  return [
    studentRow(groupId, sampleId, "c:judge:true", firstSlot, {
      sourceGroup: "tsjs-train-retention-contrast-r1",
    }),
    studentRow(groupId, sampleId, "c:judge:false", firstSlot + 1, {
      sourceGroup: "tsjs-train-retention-contrast-r1",
    }),
    studentRow(groupId, sampleId, "c:judge:unknown", firstSlot + 2, {
      sourceGroup: "tsjs-train-retention-contrast-r1",
    }),
  ];
}

async function writePackage(root, name) {
  return saveUnifiedModelPackageAtomic(
    join(root, `${name}.json`),
    createUnifiedModelPackage({
      modelId: "nn-code.tsjs.symbols.r",
      version: "1",
      route: { domain: "tsjs", decisionKind: "R" },
      tensors: zeroTensors(),
      resources: {
        thresholdsRef: THRESHOLDS_REF,
        thresholdsSchema: "nnanything.feature-thresholds.v1",
        missingModeTableRef: MISSING_MODE_REF,
        missingModeSchema: "nnanything.unified.missing-mode.v1",
      },
      fixedStages: ["nnanything.unified-step.encoder.v2"],
    }),
  );
}

async function writeFixtures() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-retention-contrast-"));
  await writeJson(join(root, THRESHOLDS_REF), {});
  await writeJson(join(root, MISSING_MODE_REF), {});
  const packagePath = await writePackage(root, "package");
  const initializationSourcePackagePath = await writePackage(
    root,
    "initialization-source",
  );

  const baselineStudentRows = [];
  const baselineSupervisionRows = [];
  for (let index = 0; index < 18; index += 1) {
    const sampleId = `baseline-${index}`;
    const groupId = `group:${sampleId}`;
    baselineStudentRows.push(
      studentRow(groupId, sampleId, "c:judge:true", index),
      studentRow(groupId, sampleId, "c:judge:false", index + 20),
    );
    baselineSupervisionRows.push(
      supervisionRow(groupId, sampleId, ["c:judge:true"]),
    );
  }

  const falseSampleId = "rc-p01-false";
  const falseGroupId = `group:${falseSampleId}`;
  const unknownSampleId = "rc-p01-unknown";
  const unknownGroupId = `group:${unknownSampleId}`;
  const pairStudentRows = [
    ...contrastStudentRows(falseGroupId, falseSampleId, 10),
    ...contrastStudentRows(unknownGroupId, unknownSampleId, 13),
  ];
  const pairSupervisionRows = [
    supervisionRow(falseGroupId, falseSampleId, ["c:judge:false"], {
      sourceGroup: "tsjs-train-retention-contrast-r1",
    }),
    supervisionRow(unknownGroupId, unknownSampleId, ["c:judge:unknown"], {
      sourceGroup: "tsjs-train-retention-contrast-r1",
      unknownReason: "runtime_dynamic_selector",
      labelAuthority: "researcher_semantic_proof",
      oracleKind: "runtime_selector_structural_proof",
    }),
  ];

  const baselineStudentRowsPath = join(root, "baseline-student-rows.jsonl");
  const baselineSupervisionRowsPath = join(
    root,
    "baseline-supervision-rows.jsonl",
  );
  const studentRowsPath = join(root, "student-rows.jsonl");
  const supervisionRowsPath = join(root, "supervision-rows.jsonl");
  await writeJsonl(baselineStudentRowsPath, baselineStudentRows);
  await writeJsonl(baselineSupervisionRowsPath, baselineSupervisionRows);
  await writeJsonl(studentRowsPath, [
    ...baselineStudentRows,
    ...pairStudentRows,
  ]);
  await writeJsonl(supervisionRowsPath, [
    ...baselineSupervisionRows,
    ...pairSupervisionRows,
  ]);

  const config = {
    schema: TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA,
    initializationSourcePackagePath,
    packagePath,
    baselineStudentRowsPath,
    baselineSupervisionRowsPath,
    studentRowsPath,
    supervisionRowsPath,
    expectedBaselineGroupCount: 18,
    expectedFinalGroupCount: 20,
    contrastPairs: [
      {
        pairRef: "rc-p01",
        falseArm: {
          sampleId: falseSampleId,
          observationKind: "static_selected",
          allowedCandidateRef: "c:judge:false",
          unknownReason: null,
        },
        unknownArm: {
          sampleId: unknownSampleId,
          observationKind: "runtime_dynamic",
          allowedCandidateRef: "c:judge:unknown",
          unknownReason: "runtime_dynamic_selector",
        },
      },
    ],
    unsupportedControls: [
      {
        pairRef: "rc-p02",
        controlSampleId: "control-static-alias",
        reason: "static_alias_unsupported",
      },
      {
        pairRef: "rc-p03",
        controlSampleId: "control-static-nested",
        reason: "static_alias_unsupported",
      },
    ],
    acceptanceGates: {
      existingTrainRetention: "baseline_18_groups_unchanged",
      helperCompletion: "helper_completion_required_before_fit",
      exposedOldDevRegression: "exposed_old_dev_regression_external_not_read",
      correctnessAndMargin: "authorized_fit_acceptance_only",
      staticSelectedCompletion: "unsupported_separate_prerequisite_before_fit",
    },
  };
  const configPath = join(root, "config.json");
  await writeJson(configPath, config);

  return {
    root,
    config,
    configPath,
    initializationSourcePackagePath,
    studentRowsPath,
    supervisionRowsPath,
    pairStudentRows,
  };
}

async function withFixture(run) {
  const fixture = await writeFixtures();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function assertFailure(result, code) {
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.schema, TSJS_RETENTION_CONTRAST_REPORT_SCHEMA);
  assert.equal(result.report.status, "FAILED");
  assert.equal(result.report.error.code, code);
}

test("fixed package validates denominator 20 without scoring", async () => {
  await withFixture(async fixture => {
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.schema, TSJS_RETENTION_CONTRAST_REPORT_SCHEMA);
    assert.equal(result.report.status, "READY");
    assert.equal(result.report.error, null);
    assert.equal(result.report.package.modelId, "nn-code.tsjs.symbols.r");
    assert.equal(
      result.report.package.encoderVersion,
      "nnanything.unified-step.encoder.v2",
    );
    assert.equal(result.report.counts.baselineGroups, 18);
    assert.equal(result.report.counts.baselineSupervisionRows, 18);
    assert.equal(result.report.counts.finalGroups, 20);
    assert.equal(result.report.counts.finalSupervisionRows, 20);
    assert.equal(result.report.counts.contrastGroups, 2);
    assert.equal(result.report.counts.studentRows, 42);
    assert.equal(result.report.counts.unsupportedControls, 2);
    assert.equal(result.report.counts.denominator, 20);
    assert.equal(result.report.pairs.length, 1);
    assert.equal(result.report.pairs[0].pairRef, "rc-p01");
    assert.equal(
      result.report.pairs[0].falseArm.observationKind,
      "static_selected",
    );
    assert.equal(
      result.report.pairs[0].falseArm.allowedCandidateRef,
      "c:judge:false",
    );
    assert.equal(result.report.pairs[0].falseArm.unknownReason, null);
    assert.equal(
      result.report.pairs[0].unknownArm.observationKind,
      "runtime_dynamic",
    );
    assert.equal(
      result.report.pairs[0].unknownArm.allowedCandidateRef,
      "c:judge:unknown",
    );
    assert.equal(
      result.report.pairs[0].unknownArm.unknownReason,
      "runtime_dynamic_selector",
    );
    assert.equal(
      result.report.acceptanceGates.helperCompletion,
      "helper_completion_required_before_fit",
    );
    assert.equal(
      result.report.acceptanceGates.exposedOldDevRegression,
      "exposed_old_dev_regression_external_not_read",
    );
    assert.equal(
      result.report.acceptanceGates.staticSelectedCompletion,
      "unsupported_separate_prerequisite_before_fit",
    );
  });
});

test("rejects a removed contrast arm", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    const kept = rows.filter(row => row.sampleId !== "rc-p01-unknown");
    await writeJsonl(fixture.studentRowsPath, kept);
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(
      fixture.supervisionRowsPath,
      supervision.filter(row => row.sampleId !== "rc-p01-unknown"),
    );
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "PAIR_ARM_MISSING");
  });
});

test("rejects a duplicated contrast arm group", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    const duplicate = fixture.pairStudentRows
      .filter(row => row.sampleId === "rc-p01-unknown")
      .map(row => ({
        ...row,
        group_id: "group:rc-p01-unknown-duplicate",
      }));
    await writeJsonl(fixture.studentRowsPath, [...rows, ...duplicate]);
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "PAIR_ARM_DUPLICATE");
  });
});

test("rejects an unexpected extra group", async () => {
  await withFixture(async fixture => {
    const extraGroupId = "group:extra-sample";
    const extraRows = contrastStudentRows(extraGroupId, "extra-sample", 50);
    const rows = await readJsonl(fixture.studentRowsPath);
    await writeJsonl(fixture.studentRowsPath, [...rows, ...extraRows]);
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(fixture.supervisionRowsPath, [
      ...supervision,
      supervisionRow(extraGroupId, "extra-sample", ["c:judge:true"]),
    ]);
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "GROUP_UNEXPECTED");
  });
});

test("rejects a modified baseline group", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    const index = rows.findIndex(row => row.sampleId === "baseline-0");
    rows[index].x[0] = rows[index].x[0] === 1 ? 0 : 1;
    await writeJsonl(fixture.studentRowsPath, rows);
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "BASELINE_GROUP_CHANGED");
  });
});

test("rejects a missing baseline group", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    await writeJsonl(
      fixture.studentRowsPath,
      rows.filter(row => row.sampleId !== "baseline-0"),
    );
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(
      fixture.supervisionRowsPath,
      supervision.filter(row => row.sampleId !== "baseline-0"),
    );
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "BASELINE_GROUP_MISSING");
  });
});

test("rejects an admitted unsupported control", async () => {
  await withFixture(async fixture => {
    const controlGroupId = "group:control-static-alias";
    const controlRows = contrastStudentRows(
      controlGroupId,
      "control-static-alias",
      52,
    );
    const rows = await readJsonl(fixture.studentRowsPath);
    await writeJsonl(fixture.studentRowsPath, [...rows, ...controlRows]);
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(
      fixture.supervisionRowsPath,
      [
        ...supervision,
        supervisionRow(controlGroupId, "control-static-alias", [
          "c:judge:false",
        ]),
      ],
    );
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "UNSUPPORTED_CONTROL_PRESENT");
  });
});

test("rejects a fixed package that changes the initialization source", async () => {
  await withFixture(async fixture => {
    const text = await readFile(fixture.initializationSourcePackagePath, "utf8");
    const value = JSON.parse(text);
    value.version = "2";
    await writeJson(fixture.initializationSourcePackagePath, value);
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "INITIALIZATION_SOURCE_MISMATCH");
  });
});

test("rejects a non-TRAIN contrast arm", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    const updated = rows.map(row =>
      row.sampleId === "rc-p01-unknown"
        ? { ...row, partition: "DEV" }
        : row,
    );
    await writeJsonl(fixture.studentRowsPath, updated);
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(
      fixture.supervisionRowsPath,
      supervision.map(row =>
        row.sampleId === "rc-p01-unknown"
          ? { ...row, partition: "DEV" }
          : row,
      ),
    );
    const result = await runTsjsRetentionContrastConfigValidation(
      fixture.config,
    );
    assertFailure(result, "PARTITION_VIOLATION");
  });
});

test("rejects a config that omits the static completion gate", async () => {
  await withFixture(async fixture => {
    const config = JSON.parse(JSON.stringify(fixture.config));
    delete config.acceptanceGates.staticSelectedCompletion;
    const result = await runTsjsRetentionContrastConfigValidation(config);
    assertFailure(result, "CONFIG_INVALID");
  });
});

test("public validation entry writes a READY report and exits 0", async () => {
  await withFixture(async fixture => {
    const reportPath = join(fixture.root, "validate-report.json");
    const command = spawnSync(
      process.execPath,
      [
        VALIDATOR_SCRIPT,
        "--config",
        fixture.configPath,
        "--report",
        reportPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(command.status, 0);
    const stdout = JSON.parse(command.stdout);
    assert.equal(stdout.status, "READY");
    assert.equal(stdout.counts.denominator, 20);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.schema, TSJS_RETENTION_CONTRAST_REPORT_SCHEMA);
    assert.equal(report.status, "READY");
    assert.equal(report.counts.denominator, 20);
  });
});

test("public validation entry writes a FAILED report and exits 1", async () => {
  await withFixture(async fixture => {
    const rows = await readJsonl(fixture.studentRowsPath);
    await writeJsonl(
      fixture.studentRowsPath,
      rows.filter(row => row.sampleId !== "rc-p01-false"),
    );
    const supervision = await readJsonl(fixture.supervisionRowsPath);
    await writeJsonl(
      fixture.supervisionRowsPath,
      supervision.filter(row => row.sampleId !== "rc-p01-false"),
    );
    const reportPath = join(fixture.root, "validate-report.json");
    const command = spawnSync(
      process.execPath,
      [
        VALIDATOR_SCRIPT,
        "--config",
        fixture.configPath,
        "--report",
        reportPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(command.status, 1);
    const stdout = JSON.parse(command.stdout);
    assert.equal(stdout.status, "FAILED");
    assert.equal(stdout.error.code, "PAIR_ARM_MISSING");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "FAILED");
    assert.equal(report.error.code, "PAIR_ARM_MISSING");
  });
});
