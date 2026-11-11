import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
  persistBA1SeenSourceDiagnosticAccounting,
} from "../dist/adapters/browser/b-a1-seen-source-diagnostic-accounting.js";
import { summarizeBA1Evaluations } from "../dist/training/b-a1-evaluator.js";

const identity = {
  documentRef: "doc-1",
  observationId: "obs-1",
  revision: 9,
};

function candidate(ref, overrides = {}) {
  return { ref, scopeRef: "scope-1", ...identity, ...overrides };
}

function evidence(evidenceRef, type, payload = {}, overrides = {}) {
  return { evidenceRef, type, scopeRef: "scope-1", ...identity, payload, ...overrides };
}

function evaluationRow(overrides = {}) {
  const group = overrides.group ?? "rs-a-q1";
  return {
    sampleId: "sample-1",
    sampleKind: "model-semantic",
    family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    group,
    gold: {
      kind: "bound",
      state: "selected",
      selectedRef: "search",
      family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
      group,
    },
    output: {
      kind: "bound",
      state: "selected",
      selectedRef: "search",
      evidenceRefs: ["search-evidence"],
      observedRevision: 9,
    },
    allowedScopeRef: "scope-1",
    candidates: [candidate("search")],
    coverage: {
      status: "complete",
      scopeRef: "scope-1",
      ...identity,
      evaluatedCount: 1,
      expectedCount: 1,
      evidenceRefs: ["coverage-evidence"],
    },
    currentControl: identity,
    evidenceRecords: [
      evidence("search-evidence", "search_host"),
      evidence("coverage-evidence", "coverage"),
    ],
    ...overrides,
  };
}

test("diagnostic rows persist outside held-out with unresolved rows and exposure unverified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-diagnostic-accounting-"));
  const result = await persistBA1SeenSourceDiagnosticAccounting({
    outputDir: join(dir, "out"),
    evaluationRows: [evaluationRow()],
    unresolvedRows: [
      {
        sourceGroupId: "rs-b-q2",
        unresolvedObligation: "No q2 input or action was observed.",
      },
    ],
  });

  assert.equal(result.exposureLabel, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(result.modelTrainingExposure, "UNVERIFIED");
  assert.deepEqual(result.accounting, {
    diagnosticRows: 1,
    heldOutRows: 0,
    unresolvedRows: 1,
  });
  assert.deepEqual(
    result.summary.denominators.map(({ family, total, passed, failed }) => ({ family, total, passed, failed })),
    [{ family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY, total: 1, passed: 1, failed: 0 }],
  );

  const persistedRow = JSON.parse(await readFile(result.artifacts.evaluationRows, "utf8"));
  assert.equal(persistedRow.exposureLabel, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(persistedRow.modelTrainingExposure, "UNVERIFIED");
  assert.equal(persistedRow.evaluationRow.family, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(Object.hasOwn(persistedRow.evaluationRow, "exposureLabel"), false);
  assert.equal(Object.hasOwn(persistedRow.evaluationRow, "modelTrainingExposure"), false);

  const persistedSummary = JSON.parse(await readFile(result.artifacts.summary, "utf8"));
  assert.equal(persistedSummary.exposureLabel, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(persistedSummary.modelTrainingExposure, "UNVERIFIED");
  assert.deepEqual(persistedSummary.accounting, {
    diagnosticRows: 1,
    heldOutRows: 0,
    unresolvedRows: 1,
  });
  assert.deepEqual(persistedSummary.unresolvedRows, [
    {
      sourceGroupId: "rs-b-q2",
      unresolvedObligation: "No q2 input or action was observed.",
    },
  ]);
});

test("unsupported family and sample-kind combinations are rejected without files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-diagnostic-reject-"));
  const heldOut = evaluationRow({
    family: "real-site-held-out",
    gold: {
      kind: "bound",
      state: "selected",
      selectedRef: "search",
      family: "real-site-held-out",
      group: "rs-a-q1",
    },
  });
  await assert.rejects(
    persistBA1SeenSourceDiagnosticAccounting({
      outputDir: join(dir, "held-out"),
      evaluationRows: [heldOut],
      unresolvedRows: [],
    }),
    /family must be seen-source-diagnostics/,
  );
  await assert.rejects(readdir(join(dir, "held-out")));

  await assert.rejects(
    persistBA1SeenSourceDiagnosticAccounting({
      outputDir: join(dir, "wrong-kind"),
      evaluationRows: [evaluationRow({ sampleKind: "contract-gate" })],
      unresolvedRows: [],
    }),
    /sampleKind must be model-semantic/,
  );
  await assert.rejects(readdir(join(dir, "wrong-kind")));

  await assert.rejects(
    persistBA1SeenSourceDiagnosticAccounting({
      outputDir: join(dir, "wrong-gold-family"),
      evaluationRows: [evaluationRow({
        gold: {
          kind: "bound",
          state: "selected",
          selectedRef: "search",
          family: "real-site-held-out",
          group: "rs-a-q1",
        },
      })],
      unresolvedRows: [],
    }),
    /gold.family must be seen-source-diagnostics/,
  );
  await assert.rejects(readdir(join(dir, "wrong-gold-family")));
});

test("the evaluator summary keeps diagnostic and held-out families separate", () => {
  const heldOut = evaluationRow({
    sampleId: "sample-held-out",
    family: "real-site-held-out",
    gold: {
      kind: "bound",
      state: "selected",
      selectedRef: "search",
      family: "real-site-held-out",
      group: "rs-a-q1",
    },
  });
  const summary = summarizeBA1Evaluations([evaluationRow(), heldOut]);
  assert.deepEqual(
    summary.denominators.map(({ family, total }) => ({ family, total })),
    [
      { family: "real-site-held-out", total: 1 },
      { family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY, total: 1 },
    ],
  );
});
