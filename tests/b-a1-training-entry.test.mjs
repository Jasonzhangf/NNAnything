import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import { BA1_TRAIN_CONFIG_SCHEMA, trainBA1UnifiedRelationDecision } from "../dist/training/b-a1-training-entry.js";

function x64(seed) {
  return Array.from({ length: 64 }, (_, i) => Math.sin(seed + i) * 0.3);
}

function studentRow(group_id, candidateRef, seed) {
  return {
    schema: "nnanything.b-a1-unified.student-row.v1",
    group_id,
    sampleId: `s-${group_id}`,
    sourceGroup: "family-b-a1",
    partition: "TRAIN",
    candidateRef,
    x: x64(seed),
    missingMode: [],
    optionSemantics: "select",
    candidateKind: "relation",
  };
}

function supervisionRow(group_id, allowedRefs) {
  return {
    schema: "nnanything.b-a1-unified.supervision-row.v1",
    group_id,
    sampleId: `s-${group_id}`,
    sourceGroup: "family-b-a1",
    partition: "TRAIN",
    supervisionStatus: "labeled_selected",
    goldAllowedCandidateRefs: allowedRefs,
    trainingEligible: true,
    evaluationClass: "semantic",
  };
}

function config(overrides = {}) {
  return {
    schema: BA1_TRAIN_CONFIG_SCHEMA,
    route: { domain: "browser", decisionKind: "R" },
    inputSchema: "nnanything.unified-step.v1",
    encoderVersion: BA1_ENCODER_VERSION,
    architecture: { input: 64, hidden: [64, 64], output: 1, activation: "relu" },
    loss: { kind: "absolute_threshold_group", theta: 0.5, margin: 0.1 },
    optimizer: "full_batch_sgd",
    learningRate: 0.01,
    maxEpochs: 3,
    seed: 20261104,
    init: "xavier_uniform",
    resources: { thresholdsRef: "thresholds.json", missingModeTableRef: "missing.json", slotMapRef: "slots.json" },
    modelId: "b-a1-test",
    version: "0.0.1",
    ...overrides,
  };
}

async function writeRows(dir, student, supervision) {
  await writeFile(join(dir, "student.jsonl"), student.map(r => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(dir, "supervision.jsonl"), supervision.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { studentRowsPath: join(dir, "student.jsonl"), supervisionRowsPath: join(dir, "supervision.jsonl") };
}

test("the fixed entry trains two groups, saves a package and a checkpoint, and verifies reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const student = [studentRow("g1", "c1", 1), studentRow("g1", "c2", 2), studentRow("g2", "c1", 3)];
  const supervision = [supervisionRow("g1", ["c1"]), supervisionRow("g2", ["c1"])];
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, student, supervision);
  const result = await trainBA1UnifiedRelationDecision({
    config: config({ maxEpochs: 3 }),
    studentRowsPath,
    supervisionRowsPath,
    packageOutPath: join(dir, "pkg", "package.json"),
    checkpointOutPath: join(dir, "ckpt", "checkpoint.json"),
  });
  assert.equal(result.report.schema, "nnanything.b-a1-unified.train-report.v1");
  assert.equal(result.report.status, "completed");
  assert.equal(result.report.stopReason, "epoch_limit_exhausted");
  assert.equal(result.report.groupCount, 2);
  assert.equal(result.report.completedEpochs, 3);
  assert.equal(result.report.lossKind, "absolute_threshold_group");
  assert.equal(result.report.theta, 0.5);
  assert.equal(result.report.margin, 0.1);
  assert.equal(result.report.lossGoal, "all eligible TRAIN groups margin_satisfied");
  assert.equal(result.report.groupMarginSatisfiedCount <= result.report.groupCount, true);
  assert.equal(result.report.not_converged, result.report.groupMarginSatisfiedCount < result.report.groupCount);
  assert.equal(result.receipt.packageReload.tensorsMatch, true);
  assert.deepEqual(result.receipt.packageReload.route, { domain: "browser", decisionKind: "R" });
  assert.equal(result.receipt.packageReload.encoderVersion, BA1_ENCODER_VERSION);
  assert.equal(result.receipt.packageReload.resourcesMatch, true);
  assert.ok(result.receipt.checkpointOutPath !== null);
});

test("the fixed entry rejects an incompatible encoder version before training", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, [studentRow("g1", "c1", 1)], [supervisionRow("g1", ["c1"])]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config({ encoderVersion: "nnanything.unified-step.encoder.v2" }),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /encoderVersion must be/,
  );
});

test("student rows carrying a forbidden gold/allowed field fail before any optimizer step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const poisoned = { ...studentRow("g1", "c1", 1), gold: "forbidden" };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, [poisoned], [supervisionRow("g1", ["c1"])]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /forbidden field/,
  );
});

test("supervision rows carrying x/input fail as a data-invalid contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const poisoned = { ...supervisionRow("g1", ["c1"]), x: x64(1) };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, [studentRow("g1", "c1", 1)], [poisoned]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /forbidden field/,
  );
});

test("A_g outside S_g and empty A_g are explicit data errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const outside = { ...supervisionRow("g1", ["c1"]), goldAllowedCandidateRefs: ["c1", "ghost"] };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, [studentRow("g1", "c1", 1)], [outside]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /outside S_g/,
  );
  const emptyDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const emptyA = { ...supervisionRow("g1", ["c1"]), goldAllowedCandidateRefs: [] };
  const paths = await writeRows(emptyDir, [studentRow("g1", "c1", 1)], [emptyA]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: paths.studentRowsPath,
      supervisionRowsPath: paths.supervisionRowsPath,
      packageOutPath: join(emptyDir, "pkg.json"),
    }),
    /empty A_g/,
  );
});

test("x[64] must be strictly finite and exactly 64 entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const short = { ...studentRow("g1", "c1", 1), x: x64(1).slice(0, 63) };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, [short], [supervisionRow("g1", ["c1"])]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /x\[64\]/,
  );
  const nanDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const nan = { ...studentRow("g1", "c1", 1), x: x64(1).map((v, i) => (i === 0 ? Number.NaN : v)) };
  const nanPaths = await writeRows(nanDir, [nan], [supervisionRow("g1", ["c1"])]);
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: nanPaths.studentRowsPath,
      supervisionRowsPath: nanPaths.supervisionRowsPath,
      packageOutPath: join(nanDir, "pkg.json"),
    }),
    /x\[64\] must be strictly finite/,
  );
});
