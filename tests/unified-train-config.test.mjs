import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildEncodedGroups,
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
