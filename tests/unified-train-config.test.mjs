import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildEncodedGroups,
  loadStudentRowsFile,
  runUnifiedTraining,
  saveUnifiedTrainPackage,
  verifyUnifiedTrainPackageReload,
  UnifiedTrainDataError,
  UNIFIED_TRAIN_CONFIG_SCHEMA,
} from "../dist/training/unified-train-config.js";
import { convertEpisodeToStudentGroup } from "../dist/training/unified-student-converter.js";
import { convertGoldToSupervisionRow } from "../dist/training/unified-supervision-converter.js";

const here = new URL(".", import.meta.url);
const thresholdsRef = resolve(here.pathname, "../tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v1.json");
const missingModeRef = resolve(here.pathname, "../tests/fixtures/unified-64-slot/missing-mode-table.json");

function episode(sampleId, partition = "train") {
  return {
    sampleId,
    requestId: `request-${sampleId}`,
    sourceGroup: "source-group",
    language: "ts",
    semanticStratum: "module_export",
    partition,
    entryFile: "sources/src/entry.ts",
    targetRef: "sources/src/impl.ts#top:helper",
    observedFacts: ["import forwarded as helper from ./util"],
    evidenceRefs: ["evidence/pre-state.jsonl#sample"],
    failureMode: null,
    derivationFamily: "family-1",
    adapterRef: "tsjs-unified-adapter:ts",
  };
}

function gold(sampleId, action, labelMissing = false) {
  return {
    sampleId,
    sourceGroup: "source-group",
    partition: "train",
    labelMissing,
    unknownReason: labelMissing ? "label_missing" : null,
    goldAction: action,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
  };
}

function config(overrides = {}) {
  return {
    schema: UNIFIED_TRAIN_CONFIG_SCHEMA,
    route: { domain: "tsjs", decisionKind: "R" },
    architecture: { input: 64, hidden: [64, 64], output: 1 },
    optimizer: "full_batch_sgd",
    learningRate: 0.01,
    maxEpochs: 3,
    seed: 20261104,
    init: "xavier_uniform",
    resources: {
      thresholdsRef,
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: missingModeRef,
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
    modelId: "tests.unified",
    version: "0.0.0-test",
    ...overrides,
  };
}

test("joins student and supervision groups by group_id", () => {
  const groups = [
    convertEpisodeToStudentGroup(episode("s1")),
    convertEpisodeToStudentGroup(episode("s2")),
  ];
  const supervision = [
    convertGoldToSupervisionRow(gold("s1", "c:judge:true")),
    convertGoldToSupervisionRow(gold("s2", "c:judge:unknown")),
  ];
  const encoded = buildEncodedGroups(groups, supervision);
  assert.equal(encoded.length, 2);
  assert.deepEqual(encoded[0].allowedCandidateRefs, ["c:judge:true"]);
  assert.deepEqual(encoded[1].allowedCandidateRefs, ["c:judge:unknown"]);
});

test("empty A_g is DATA_INVALID", () => {
  const groups = [convertEpisodeToStudentGroup(episode("s1"))];
  const supervision = [{
    schema: "nnanything.unified.supervision-row.v1",
    group_id: groups[0].group_id,
    sampleId: "s1",
    sourceGroup: "source-group",
    partition: "TRAIN",
    goldAllowedCandidateRefs: [],
    labelMissing: false,
    unknownReason: null,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    teacherResolutionRef: "teacher:s1",
  }];
  assert.throws(() => buildEncodedGroups(groups, supervision), UnifiedTrainDataError);
});

test("A_g outside S_g is DATA_INVALID", () => {
  const groups = [convertEpisodeToStudentGroup(episode("s1"))];
  const supervision = [convertGoldToSupervisionRow(gold("s1", "c:judge:present"))];
  assert.throws(() => buildEncodedGroups(groups, supervision), UnifiedTrainDataError);
});

test("non-TRAIN student partition is DATA_INVALID", () => {
  const groups = [convertEpisodeToStudentGroup(episode("s-dev", "dev"))];
  const supervision = [convertGoldToSupervisionRow(gold("s-dev", "c:judge:true"))];
  assert.throws(() => buildEncodedGroups(groups, supervision), UnifiedTrainDataError);
});

test("missing supervision is DATA_INVALID", () => {
  const groups = [convertEpisodeToStudentGroup(episode("s1"))];
  assert.throws(() => buildEncodedGroups(groups, []), UnifiedTrainDataError);
});

test("fitter core records epochs, loss, finite, and stop reason", () => {
  const groups = [
    convertEpisodeToStudentGroup(episode("s1")),
    convertEpisodeToStudentGroup(episode("s2")),
  ];
  const supervision = [
    convertGoldToSupervisionRow(gold("s1", "c:judge:true")),
    convertGoldToSupervisionRow(gold("s2", "c:judge:unknown")),
  ];
  const encoded = buildEncodedGroups(groups, supervision);
  const { report, tensors } = runUnifiedTraining(encoded, config());
  assert.equal(report.status, "completed");
  assert.equal(report.stopReason, "epoch_limit_exhausted");
  assert.equal(report.completedEpochs, 3);
  assert.equal(report.epochs.length, 3);
  for (const record of report.epochs) {
    assert.equal(record.finite, true);
    assert.equal(Number.isFinite(record.maxAbsGrad), true);
  }
  assert.equal(tensors.W1.length, 4096);
});

test("increasing epoch limits never silently retry over the declared budget", () => {
  const groups = [convertEpisodeToStudentGroup(episode("s1")), convertEpisodeToStudentGroup(episode("s2"))];
  const supervision = [
    convertGoldToSupervisionRow(gold("s1", "c:judge:true")),
    convertGoldToSupervisionRow(gold("s2", "c:judge:false")),
  ];
  const encoded = buildEncodedGroups(groups, supervision);
  const first = runUnifiedTraining(encoded, config({ maxEpochs: 2 }));
  assert.equal(first.report.completedEpochs, 2);
  assert.equal(first.report.stopReason, "epoch_limit_exhausted");
});

test("package save and new-process-style reload preserve tensors", async () => {
  const groups = [convertEpisodeToStudentGroup(episode("s1"))];
  const supervision = [convertGoldToSupervisionRow(gold("s1", "c:judge:true"))];
  const encoded = buildEncodedGroups(groups, supervision);
  const { tensors } = runUnifiedTraining(encoded, config({ maxEpochs: 1 }));
  const dir = await mkdtemp(join(tmpdir(), "unified-train-package-"));
  try {
    const packagePath = join(dir, "package.json");
    const pkg = await saveUnifiedTrainPackage(packagePath, config(), tensors);
    const receipt = await verifyUnifiedTrainPackageReload(packagePath, pkg);
    assert.equal(receipt.tensorsMatch, true);
    assert.equal(receipt.modelId, "tests.unified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function studentRow(overrides = {}) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: "g1",
    sampleId: "s1",
    sourceGroup: "sg",
    requestRef: "req-1",
    language: "ts",
    derivationFamily: "family-1",
    adapterRef: "tsjs-unified-adapter:ts",
    partition: "TRAIN",
    candidateEnumeration: "complete",
    evidenceRefs: [],
    failureMode: null,
    candidateRef: "c:judge:true",
    optionSemantics: "present",
    candidateKind: "present",
    x: Array.from({ length: 64 }, () => 0),
    ...overrides,
  };
}

async function writeStudentRows(rows) {
  const dir = await mkdtemp(join(tmpdir(), "unified-student-rows-"));
  const rowsPath = join(dir, "rows.jsonl");
  await writeFile(rowsPath, rows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return rowsPath;
}

test("loadStudentRowsFile rejects declared missing slots that do not hold -1", async () => {
  const rowsPath = await writeStudentRows([studentRow({
    x: Array.from({ length: 64 }, (_, i) => (i === 3 ? 0 : 0)),
    missingMode: [{ block: "G0", fieldRef: "f", reason: "not_requested", slotIndex: 3, fill: -1 }],
  })]);
  await assert.rejects(() => loadStudentRowsFile(rowsPath), UnifiedTrainDataError);
});

test("loadStudentRowsFile rejects malformed missing mode entries", async () => {
  const badModes = [
    { slotIndex: 64, fill: -1, reason: "not_requested" },
    { slotIndex: 1.5, fill: -1, reason: "not_requested" },
    { slotIndex: 3, fill: 0, reason: "not_requested" },
    { slotIndex: 3, fill: -1, reason: "" },
    null,
    "not-an-array",
  ];
  for (const badMode of badModes) {
    const rowsPath = await writeStudentRows([studentRow({ missingMode: badMode })]);
    await assert.rejects(
      () => loadStudentRowsFile(rowsPath),
      error => error instanceof UnifiedTrainDataError
        && error.message.includes("candidate c:judge:true")
        && error.message.includes("invalid missingMode"),
      `expected candidate-scoped rejection for ${JSON.stringify(badMode)}`,
    );
  }
});

test("loadStudentRowsFile accepts declared missing slots and normal finite values", async () => {
  const declaredRowsPath = await writeStudentRows([studentRow({
    x: Array.from({ length: 64 }, (_, i) => (i === 3 ? -1 : 0)),
    missingMode: [{ block: "G0", fieldRef: "f", reason: "not_requested", slotIndex: 3, fill: -1 }],
  })]);
  const declaredGroups = await loadStudentRowsFile(declaredRowsPath);
  assert.equal(declaredGroups[0].candidates[0].input[3], -1);

  const normalRowsPath = await writeStudentRows([studentRow({
    x: Array.from({ length: 64 }, (_, i) => (i === 3 ? 0.5 : 0)),
  })]);
  const normalGroups = await loadStudentRowsFile(normalRowsPath);
  assert.equal(normalGroups[0].candidates[0].input[3], 0.5);
});

test("loadStudentRowsFile keeps historical inference for undefined missingMode", async () => {
  const derivedRowsPath = await writeStudentRows([studentRow({
    x: Array.from({ length: 64 }, (_, i) => (i === 3 ? -1 : 0)),
  })]);
  const derivedGroups = await loadStudentRowsFile(derivedRowsPath);
  assert.deepEqual(derivedGroups[0].candidates[0].missingMode, [{
    block: "G0", fieldRef: "c:judge:true:slot3", reason: "not_requested", slotIndex: 3, fill: -1,
  }]);

  const plainRowsPath = await writeStudentRows([studentRow()]);
  const plainGroups = await loadStudentRowsFile(plainRowsPath);
  assert.deepEqual(plainGroups[0].candidates[0].missingMode, []);
});
