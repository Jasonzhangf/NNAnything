import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1_HARNESS_OBSERVATION_SCHEMA,
  BA1SampleConverterError,
  convertObservations,
} from "../dist/training/b-a1-sample-converter.js";
import {
  loadBA1StudentRowsFile,
  loadBA1SupervisionRowsFile,
} from "../dist/training/b-a1-training-entry.js";

function features(overrides = {}) {
  return {
    host: "input",
    type: "text",
    editable: true,
    disabled: false,
    readOnly: false,
    cssHidden: false,
    intersectsViewport: true,
    explicitTabIndexKind: "absent",
    tabIndexFocus: true,
    inForm: true,
    formRoleSearch: false,
    nearbySubmit: true,
    depthBand: "middle",
    hasLabel: true,
    hasPlaceholder: true,
    hasAria: false,
    markerHit: true,
    nonSearchMarker: false,
    textLenBand: 1,
    access: "available",
    ...overrides,
  };
}

function candidate(candidateRef, overrides = {}, featureOverrides = {}) {
  return {
    candidateRef,
    scopeRef: "scope-1",
    documentRef: "doc-1",
    observationId: "obs-1",
    revision: 1,
    unmeasured: [],
    features: features(featureOverrides),
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schema: BA1_HARNESS_OBSERVATION_SCHEMA,
    caseId: "case-1",
    sourceFamily: "family-a",
    sampleFamily: "model-semantic",
    partition: "TRAIN",
    queryText: "搜索",
    requestedRole: "search-input-host",
    allowedScopeRef: "scope-1",
    sourceGroup: "family-a",
    sampleId: "case-1",
    stepContextRef: "case-1-step",
    candidateGroupRef: "case-1-group",
    observation: {
      documentRef: "doc-1",
      observationId: "obs-1",
      revision: 1,
      coverage: {
        status: "complete",
        scopeRef: "scope-1",
        documentRef: "doc-1",
        observationId: "obs-1",
        revision: 1,
        evaluatedCount: 1,
        expectedCount: 1,
        unassessedIframeCount: 0,
        unassessedObjectCount: 0,
        unassessedOpenShadowRootCount: 0,
        evidenceRefs: ["cov-1"],
      },
      currentControl: { documentRef: "doc-1", observationId: "obs-1", revision: 1 },
      candidateGroupEnumerationComplete: true,
    },
    candidates: [candidate("case-1:query")],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_selected",
      goldAllowedCandidateRefs: ["case-1:query"],
      labelAuthority: "independent-teacher:test",
      oracleKind: "search-input-host-single",
    },
    ...overrides,
  };
}

function greenSet() {
  return [
    observation({ caseId: "g1", sampleId: "g1", stepContextRef: "g1-step", candidateGroupRef: "g1-group" }),
    observation({
      caseId: "g2",
      sampleId: "g2",
      stepContextRef: "g2-step",
      candidateGroupRef: "g2-group",
      candidates: [candidate("g2:a"), candidate("g2:b")],
      supervision: {
        kind: "model-semantic",
        supervisionStatus: "labeled_ambiguous",
        goldAllowedCandidateRefs: ["g2:a", "g2:b"],
        labelAuthority: "independent-teacher:ambiguous",
        oracleKind: "search-input-host-ambiguous",
      },
    }),
    observation({
      caseId: "g3",
      sampleId: "g3",
      stepContextRef: "g3-step",
      candidateGroupRef: "g3-group",
      sourceFamily: "family-b",
      sourceGroup: "family-b",
      partition: "DEV",
      candidates: [candidate("g3:query", { features: features({ markerHit: false }) })],
      supervision: {
        kind: "model-semantic",
        supervisionStatus: "labeled_none",
        goldAllowedCandidateRefs: [],
        labelAuthority: "independent-teacher:none",
        oracleKind: "search-input-host-none",
      },
    }),
    observation({
      caseId: "g4",
      sampleId: "g4",
      stepContextRef: "g4-step",
      candidateGroupRef: "g4-group",
      sourceFamily: "new-independent",
      sourceGroup: "new-independent",
      partition: "VERIFICATION",
    }),
    observation({
      caseId: "g5",
      sampleId: "g5",
      stepContextRef: "g5-step",
      candidateGroupRef: "g5-group",
      sourceFamily: "family-b",
      sourceGroup: "family-b",
      sampleFamily: "contract-gate",
      partition: "DEV",
      observation: {
        documentRef: "doc-g5",
        observationId: "obs-g5",
        revision: 1,
        coverage: {
          status: "complete",
          scopeRef: "scope-1",
          documentRef: "doc-g5",
          observationId: "obs-g5",
          revision: 1,
          evaluatedCount: 1,
          expectedCount: 1,
          unassessedIframeCount: 0,
          unassessedObjectCount: 0,
          unassessedOpenShadowRootCount: 0,
          evidenceRefs: ["cov-g5"],
        },
        currentControl: { documentRef: "doc-g5", observationId: "obs-g5", revision: 1 },
        candidateGroupEnumerationComplete: true,
      },
      candidates: [candidate("g5:query", { scopeRef: "outside-scope" })],
      supervision: { kind: "contract-gate", reason: "outside_scope" },
    }),
    observation({
      caseId: "g6",
      sampleId: "g6",
      stepContextRef: "g6-step",
      candidateGroupRef: "g6-group",
      sampleFamily: "aggregator-test",
      partition: "DEV",
      observation: {
        documentRef: "doc-g6",
        observationId: "obs-g6",
        revision: 1,
        coverage: {
          status: "complete",
          scopeRef: "scope-1",
          documentRef: "doc-g6",
          observationId: "obs-g6",
          revision: 1,
          evaluatedCount: 2,
          expectedCount: 2,
          unassessedIframeCount: 0,
          unassessedObjectCount: 0,
          unassessedOpenShadowRootCount: 0,
          evidenceRefs: ["cov-g6"],
        },
        currentControl: { documentRef: "doc-g6", observationId: "obs-g6", revision: 1 },
        candidateGroupEnumerationComplete: true,
      },
      candidates: [],
      supervision: { kind: "aggregator-test", injectedScores: [0.8, 0.2], expectedState: "selected" },
    }),
  ];
}

test("green: observations convert with family/partition separation and a separated manifest", () => {
  const converted = convertObservations(greenSet());
  const counts = converted.manifest.counts;
  assert.deepEqual(counts.bySampleFamily, {
    "model-semantic": 4,
    "contract-gate": 1,
    "aggregator-test": 1,
  });
  assert.deepEqual(counts.byPartition, { TRAIN: 2, DEV: 3, VERIFICATION: 1 });
  assert.deepEqual(counts.semanticBySourceFamily, {
    "family-a": 2,
    "family-b": 1,
    "new-independent": 1,
  });
  assert.equal(counts.trainEligibleGroups, 2);
  assert.equal(converted.trainStudentRows.length, 3);
  assert.equal(converted.trainSupervisionRows.length, 2);
  assert.equal(converted.devStudentRows.length, 1);
  assert.equal(converted.verificationStudentRows.length, 1);
  assert.equal(converted.contractGateRows.length, 1);
  assert.equal(converted.aggregatorTestRows.length, 1);
  assert.equal(converted.observationMissingRows.length, 0);
});

test("green: student and supervision rows are physically separated with no teacher/gold leakage", () => {
  const converted = convertObservations(greenSet());
  const supervisionOnlyFields = new Set([
    "supervisionStatus",
    "goldAllowedCandidateRefs",
    "trainingEligible",
    "evaluationClass",
    "labelAuthority",
    "oracleKind",
  ]);
  for (const row of [...converted.trainStudentRows, ...converted.devStudentRows, ...converted.verificationStudentRows]) {
    for (const field of supervisionOnlyFields) {
      assert.ok(!(field in row), `student row ${row.group_id} leaked supervision field ${field}`);
    }
    assert.equal(Array.isArray(row.x), true);
    assert.equal(row.x.length, 64);
  }
  for (const row of [...converted.trainSupervisionRows, ...converted.devSupervisionRows, ...converted.verificationSupervisionRows]) {
    assert.ok(!("x" in row), `supervision row ${row.group_id} leaked x`);
    assert.ok(!("input" in row), `supervision row ${row.group_id} leaked input`);
    assert.ok(!("candidateRef" in row) && !("features" in row), `supervision row ${row.group_id} leaked measurement fields`);
  }
});

test("green: converted train rows load through the fixed training entry one-to-one", async () => {
  const converted = convertObservations(greenSet());
  const dir = await mkdtemp(join(tmpdir(), "ba1-converter-green-"));
  const studentPath = join(dir, "student-rows.jsonl");
  const supervisionPath = join(dir, "supervision-rows.jsonl");
  await writeFile(studentPath, converted.trainStudentRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(supervisionPath, converted.trainSupervisionRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const groups = await loadBA1StudentRowsFile(studentPath);
  const supervision = await loadBA1SupervisionRowsFile(supervisionPath);
  assert.equal(groups.length, 2);
  assert.equal(supervision.length, 2);
  assert.deepEqual(groups.map(group => group.group_id), supervision.map(row => row.group_id));
});

test("red: a student candidate carrying a gold field is rejected", () => {
  const poisoned = greenSet();
  poisoned[0].candidates[0].features = { ...poisoned[0].candidates[0].features, gold: 1 };
  assert.throws(() => convertObservations(poisoned), (error) =>
    error instanceof BA1SampleConverterError && error.code === "FORBIDDEN_FIELD");
});

test("red: a student candidate carrying an allowed field is rejected", () => {
  const poisoned = greenSet();
  poisoned[0].candidates[0].features = { ...poisoned[0].candidates[0].features, allowed: true };
  assert.throws(() => convertObservations(poisoned), (error) =>
    error instanceof BA1SampleConverterError && error.code === "FORBIDDEN_FIELD");
});

test("red: an unmeasured required feature is never filled with false", () => {
  const poisoned = greenSet();
  poisoned[0].candidates[0].unmeasured = ["type"];
  assert.throws(() => convertObservations(poisoned), (error) =>
    error instanceof BA1SampleConverterError && error.code === "MISSING_OBSERVATION");
});

test("red: a null required feature is treated as unmeasured, not as false", () => {
  const poisoned = greenSet();
  poisoned[0].candidates[0].features = { ...poisoned[0].candidates[0].features, type: null };
  assert.throws(() => convertObservations(poisoned), (error) =>
    error instanceof BA1SampleConverterError && error.code === "MISSING_OBSERVATION");
});

test("red: the training entry rejects a student row that carries a gold field", async () => {
  const converted = convertObservations(greenSet());
  const row = { ...converted.trainStudentRows[0], goldAllowedCandidateRefs: ["g1:query"] };
  const dir = await mkdtemp(join(tmpdir(), "ba1-converter-red-student-"));
  const path = join(dir, "student-rows.jsonl");
  await writeFile(path, JSON.stringify(row) + "\n");
  await assert.rejects(() => loadBA1StudentRowsFile(path), /forbidden field/);
});

test("red: the training entry rejects a supervision row that carries x or input", async () => {
  const converted = convertObservations(greenSet());
  const withX = converted.trainSupervisionRows.map((row, index) =>
    index === 0 ? { ...row, x: [] } : row);
  const dir = await mkdtemp(join(tmpdir(), "ba1-converter-red-supervision-"));
  const path = join(dir, "supervision-rows.jsonl");
  await writeFile(path, withX.map(row => JSON.stringify(row)).join("\n") + "\n");
  await assert.rejects(() => loadBA1SupervisionRowsFile(path), /forbidden field/);
});
