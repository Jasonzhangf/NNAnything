import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BA1_REAL_SITE_THRESHOLD,
  projectBA1RealSiteEvaluationInput,
} from "../dist/adapters/browser/b-a1-real-site-evaluation.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import { evaluateBA1Sample } from "../dist/training/b-a1-evaluator.js";
import { createUnifiedModelPackage } from "../dist/training/unified-model-package.js";
import { UNIFIED_PARAMETER_COUNTS } from "../dist/training/unified-forward.js";

function candidate(ref, overrides = {}) {
  return {
    ref,
    scopeRef: "#scope",
    documentRef: "doc-1",
    observationId: "obs-1",
    revision: 1,
    host: "input",
    type: "search",
    contentEditable: false,
    editable: true,
    disabled: false,
    readOnly: false,
    cssHidden: false,
    intersectsViewport: true,
    explicitTabIndexKind: "absent",
    tabIndexFocus: false,
    inForm: false,
    formRoleSearch: false,
    nearbySubmit: false,
    depthBand: "shallow",
    hasLabel: true,
    hasPlaceholder: false,
    hasAria: false,
    markerHit: true,
    nonSearchMarker: false,
    textLenBand: 1,
    access: "available",
    ...overrides,
  };
}

function observation(candidates, overrides = {}) {
  return {
    identity: { documentRef: "doc-1", observationId: "obs-1", revision: 1 },
    scopeRef: "#scope",
    requestedRole: "search-input-host",
    candidates,
    outsideScopeRefs: [],
    coverage: {
      scopeRef: "#scope",
      observedCandidateCount: candidates.length,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
    ...overrides,
  };
}

function modelPackage(seed) {
  const W1 = new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  W1[0 * 64 + 35] = 1;
  const W2 = new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  W2[0 * 64 + 0] = 1;
  const W3 = new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: `b-a1-real-site-evaluation-fixture-${seed}`,
    version: "0.0.1",
    route: { domain: "browser", decisionKind: "R" },
    encoderVersion: BA1_ENCODER_VERSION,
    tensors: {
      W1,
      b1: new Array(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
      W2,
      b2: new Array(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
      W3,
      b3: [0],
    },
    resources: {
      thresholdsRef: "thresholds.json",
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: "missing.json",
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
  });
}

test("a projected observation selects the unique measured host without live DOM", () => {
  const observed = observation([candidate("c1"), candidate("c2", { hasLabel: false })]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(1),
    currentControl: observed.identity,
  });
  assert.equal(projection.output.kind, "bound");
  assert.equal(projection.output.state, "selected");
  assert.equal(projection.output.selectedRef, "c1");
  assert.equal(projection.scoredCandidates.length, 2);
  assert.deepEqual(projection.scoredCandidates.map(entry => entry.score), [1, 0]);
  assert.deepEqual(
    evaluateBA1Sample({
      gold: { kind: "bound", state: "selected", selectedRef: "c1", family: "real-site-held-out", group: "g1" },
      output: projection.output,
      allowedScopeRef: projection.allowedScopeRef,
      candidates: projection.candidates,
      coverage: projection.coverage,
      currentControl: projection.currentControl,
      evidenceRecords: projection.evidenceRecords,
    }).errors,
    [],
  );
});

test("a tied maximum remains ambiguous", () => {
  const observed = observation([candidate("c1"), candidate("c2")]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(2),
    currentControl: observed.identity,
  });
  assert.equal(projection.output.kind, "bound");
  assert.equal(projection.output.state, "ambiguous");
  assert.equal(projection.output.selectedRef, null);
  assert.equal(projection.evidenceRecords.filter(record => record.type === "ambiguity").length, 2);
});

test("missing measurements stop before forward and preserve the denominator", () => {
  const observed = observation([candidate("c1", { disabled: null })]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(3),
    currentControl: observed.identity,
  });
  assert.equal(projection.output.state, "insufficient_observation");
  assert.equal(projection.scoredCandidates.length, 0);
  assert.equal(projection.expectedCount, 1);
  assert.equal(projection.evaluatedCount, 0);
  const record = projection.evidenceRecords.find(entry => entry.type === "insufficient_observation");
  assert.equal(record?.payload.insufficientReason, "missing_measurement");
});

test("all measured scores below threshold stay insufficient and expose scores", () => {
  const observed = observation([candidate("c1", { hasLabel: false })]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(4),
    currentControl: observed.identity,
  });
  assert.equal(projection.output.state, "insufficient_observation");
  assert.equal(projection.scoredCandidates[0].score < BA1_REAL_SITE_THRESHOLD, true);
});

test("coverage and scope gates reject before encoding", () => {
  const mismatch = observation([candidate("c1")], {
    coverage: {
      scopeRef: "#scope",
      observedCandidateCount: 2,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
  });
  const coverageProjection = projectBA1RealSiteEvaluationInput({
    observation: mismatch,
    modelPackage: modelPackage(5),
    currentControl: mismatch.identity,
  });
  assert.equal(coverageProjection.output.kind, "reject");
  assert.equal(coverageProjection.output.reason, "unverified_coverage");
  assert.equal(coverageProjection.scoredCandidates.length, 0);

  const outside = observation([candidate("c1")], { outsideScopeRefs: ["c1"] });
  const outsideProjection = projectBA1RealSiteEvaluationInput({
    observation: outside,
    modelPackage: modelPackage(6),
    currentControl: outside.identity,
  });
  assert.equal(outsideProjection.output.kind, "reject");
  assert.equal(outsideProjection.output.reason, "outside_scope");
  assert.equal(outsideProjection.scoredCandidates.length, 0);
});

test("a mismatched authority token is rejected from the independent control value", () => {
  const observed = observation([candidate("c1")]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(7),
    currentControl: { documentRef: "doc-1", observationId: "obs-2", revision: 2 },
  });
  assert.equal(projection.output.kind, "reject");
  assert.equal(projection.output.reason, "stale_candidate");
  assert.equal(projection.scoredCandidates.length, 0);
});

test("the projected evaluator carries no gold and rejects a non-route package", () => {
  const observed = observation([candidate("c1")]);
  const projection = projectBA1RealSiteEvaluationInput({
    observation: observed,
    modelPackage: modelPackage(8),
    currentControl: observed.identity,
  });
  assert.equal(Object.hasOwn(projection, "gold"), false);

  const wrong = createUnifiedModelPackage({
    modelId: "wrong-encoder",
    version: "0.0.1",
    route: { domain: "browser", decisionKind: "R" },
    tensors: {
      W1: new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0),
      b1: new Array(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
      W2: new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0),
      b2: new Array(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
      W3: new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0),
      b3: [0],
    },
    resources: {
      thresholdsRef: "thresholds.json",
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: "missing.json",
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
  });
  assert.throws(
    () => projectBA1RealSiteEvaluationInput({
      observation: observed,
      modelPackage: wrong,
      currentControl: observed.identity,
    }),
    /not the B-A1 route encoder/,
  );
});
