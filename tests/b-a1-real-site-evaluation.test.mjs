import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1_REAL_SITE_THRESHOLD,
  projectBA1RealSiteEvaluationInput,
} from "../dist/adapters/browser/b-a1-real-site-evaluation.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import { evaluateBA1Sample } from "../dist/training/b-a1-evaluator.js";
import {
  createUnifiedModelPackage,
  loadUnifiedModelPackageFromFile,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { forwardUnifiedScore, UNIFIED_PARAMETER_COUNTS } from "../dist/training/unified-forward.js";

// The production projection reads a real DOM. These stubs are the smallest
// surface the projection touches, so the adapter itself stays real.
globalThis.document = { documentElement: { clientWidth: 1200, clientHeight: 800 } };
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });

function element(overrides = {}) {
  return {
    tagName: "INPUT",
    textContent: "",
    labels: [],
    isContentEditable: false,
    readOnly: false,
    closest: () => null,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 200, height: 24, top: 10, left: 10, right: 210, bottom: 34 }),
    parentElement: null,
    ...overrides,
  };
}

function labelHost(text = "搜索", overrides = {}) {
  return element({
    getAttribute: name => (name === "type" ? "search" : null),
    labels: text === null ? [] : [element({ tagName: "LABEL", textContent: text })],
    ...overrides,
  });
}

const scopeRoot = element({ tagName: "DIV" });

function observation(nodes, overrides = {}) {
  return {
    documentRef: "doc-1",
    observationId: "obs-1",
    revision: 3,
    scopeRef: "scope-1",
    scopeRoot,
    nodes,
    propertiesOf: () => ({ disabled: false, explicitTabIndexKind: "absent", tabIndexFocus: false }),
    coverage: {
      scopeRef: "scope-1",
      observedCandidateCount: nodes.length,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
    access: "available",
    ...overrides,
  };
}

/** The saved package path plus hand-set tensors that score x[35] (hasLabel). */
async function packageScoringHasLabel(dir, seed) {
  const W1 = new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  W1[0 * 64 + 35] = 1;
  const W2 = new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  W2[0 * 64 + 0] = 1;
  const W3 = new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  W3[0] = 1;
  const tensors = {
    W1,
    b1: new Array(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
    W2,
    b2: new Array(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
    W3,
    b3: [0],
  };
  const pkg = createUnifiedModelPackage({
    modelId: `b-a1-real-site-eval-fixture-${seed}`,
    version: "0.0.1",
    route: { domain: "browser", decisionKind: "R" },
    encoderVersion: BA1_ENCODER_VERSION,
    tensors,
    resources: {
      thresholdsRef: "thresholds.json",
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: "missing.json",
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), "{}\n");
  await writeFile(join(dir, "missing.json"), "{}\n");
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
}

test("the adapter reuses the shared loader and forward contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-loader-"));
  const path = await packageScoringHasLabel(dir, 1);
  const loaded = await loadUnifiedModelPackageFromFile(path);
  const x = new Array(64).fill(0);
  x[35] = 1;
  x[59] = 1;
  assert.equal(forwardUnifiedScore(x, loaded.package.tensors), 1);
});

test("admitted observation produces gold-free evaluator input that selects the unique host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-selected-"));
  const packagePath = await packageScoringHasLabel(dir, 2);
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([
      { nodeRef: "c1", element: labelHost("搜索") },
      { nodeRef: "c2", element: labelHost(null) },
    ]),
    packagePath,
  });
  assert.equal(projection.output.kind, "bound");
  assert.equal(projection.output.state, "selected");
  assert.equal(projection.output.selectedRef, "c1");
  assert.equal(projection.coverage.status, "complete");
  assert.equal(projection.evaluatedCount, 2);
  assert.equal(projection.expectedCount, 2);
  assert.equal(projection.measuredCandidateCount, 2);
  assert.equal(projection.evidenceRecords.length, 2, "coverage plus the selected evidence");
  assert.equal(projection.scoredCandidates.length, 2);
  assert.deepEqual(projection.scoredCandidates.map(entry => entry.score), [1, 0]);

  // Gold arrives only here, from an independent supervision source.
  const evaluation = evaluateBA1Sample({
    gold: { kind: "bound", state: "selected", selectedRef: "c1", family: "real-site-held-out", group: "g1" },
    output: projection.output,
    allowedScopeRef: projection.allowedScopeRef,
    candidates: projection.candidates,
    coverage: projection.coverage,
    currentControl: projection.currentControl,
    evidenceRecords: projection.evidenceRecords,
  });
  assert.deepEqual(evaluation.errors, []);
});

test("a tied maximum is ambiguous and both tied hosts carry ambiguity evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-tie-"));
  const packagePath = await packageScoringHasLabel(dir, 3);
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([
      { nodeRef: "c1", element: labelHost("搜索") },
      { nodeRef: "c2", element: labelHost("查询") },
    ]),
    packagePath,
  });
  assert.equal(projection.output.state, "ambiguous");
  assert.equal(projection.output.selectedRef, null);
  const ambiguity = projection.evidenceRecords.filter(record => record.type === "ambiguity");
  assert.equal(ambiguity.length, 2);
  assert.deepEqual(projection.output.evidenceRefs, ambiguity.map(record => record.evidenceRef));
  assert.deepEqual(
    evaluateBA1Sample({
      gold: { kind: "bound", state: "ambiguous", family: "real-site-held-out", group: "g2" },
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

test("every score below theta stays insufficient_observation, never none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-all-below-"));
  const packagePath = await packageScoringHasLabel(dir, 4);
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([
      { nodeRef: "c1", element: labelHost(null) },
      { nodeRef: "c2", element: labelHost(null) },
    ]),
    packagePath,
  });
  assert.equal(projection.output.kind, "bound");
  assert.equal(projection.output.state, "insufficient_observation");
  assert.equal(projection.output.selectedRef, null);
  const insufficient = projection.evidenceRecords.find(
    record => record.type === "insufficient_observation",
  );
  assert.equal(insufficient?.payload.insufficientReason, "all_below_threshold");
  assert.equal(projection.scoredCandidates.every(entry => entry.score < BA1_REAL_SITE_THRESHOLD), true);
  assert.equal(projection.coverage.evaluatedCount, 2, "coverage keeps the scorable denominator");
  assert.deepEqual(
    evaluateBA1Sample({
      gold: { kind: "bound", state: "insufficient_observation", family: "real-site-held-out", group: "g3" },
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

test("a folded false disabled stays unmeasured and the whole group stops before forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-missing-"));
  const packagePath = await packageScoringHasLabel(dir, 5);
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([
      { nodeRef: "c1", element: labelHost("搜索") },
      { nodeRef: "c2", element: labelHost("查询") },
    ], {
      // A non-production properties map without a boolean disabled key: the
      // projection folds disabled=false, the adapter must undo that fold.
      propertiesOf: () => ({ explicitTabIndexKind: "absent", tabIndexFocus: false }),
    }),
    packagePath,
  });
  assert.equal(projection.output.kind, "bound");
  assert.equal(projection.output.state, "insufficient_observation");
  const insufficient = projection.evidenceRecords.find(
    record => record.type === "insufficient_observation",
  );
  assert.equal(insufficient?.payload.insufficientReason, "missing_measurement");
  assert.equal(insufficient?.payload.measuredCandidateCount, 0);
  assert.equal(projection.scoredCandidates.length, 0, "no candidate is forwarded");
  assert.equal(projection.evaluatedCount, 0);
  assert.equal(projection.expectedCount, 2, "the expected obligation is never shrunk");
  assert.equal(projection.coverage.status, "partial");
  assert.deepEqual(
    evaluateBA1Sample({
      gold: { kind: "bound", state: "insufficient_observation", family: "real-site-held-out", group: "g4" },
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

test("a coverage mismatch is a typed reject, not a low score", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-coverage-"));
  const packagePath = await packageScoringHasLabel(dir, 6);
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([{ nodeRef: "c1", element: labelHost("搜索") }], {
      coverage: {
        scopeRef: "scope-1",
        observedCandidateCount: 3,
        unassessedIframeCount: 0,
        unassessedObjectCount: 0,
        unassessedOpenShadowRootCount: 0,
        excluded: [],
      },
    }),
    packagePath,
  });
  assert.equal(projection.output.kind, "reject");
  assert.equal(projection.output.reason, "unverified_coverage");
  assert.equal(projection.scoredCandidates.length, 0, "no forward for a contract reject");
  assert.equal(projection.coverage.status, "unverified");
  assert.equal(projection.coverage.evaluatedCount, 0);
  assert.equal(projection.coverage.expectedCount, 3, "the observed count stays the denominator");
  const evaluation = evaluateBA1Sample({
    gold: { kind: "reject", reason: "unverified_coverage", family: "real-site-held-out", group: "g5" },
    output: projection.output,
    allowedScopeRef: projection.allowedScopeRef,
    candidates: projection.candidates,
    coverage: projection.coverage,
    currentControl: projection.currentControl,
    evidenceRecords: projection.evidenceRecords,
  });
  assert.deepEqual(evaluation.errors, []);
});

test("the projection carries no gold field and refuses a different encoder package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-e2-guard-"));
  const projection = await projectBA1RealSiteEvaluationInput({
    observation: observation([]),
    packagePath: join(dir, "missing.json"),
  });
  assert.equal(projection.output.state, "insufficient_observation");
  assert.equal(Object.hasOwn(projection, "gold"), false);

  const otherEncoder = createUnifiedModelPackage({
    modelId: "unified-step",
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
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), "{}\n");
  await writeFile(join(dir, "missing.json"), "{}\n");
  const wrongPackage = await saveUnifiedModelPackageAtomic(join(dir, "package.json"), otherEncoder);
  const populated = observation([{ nodeRef: "c1", element: labelHost("搜索") }]);
  await assert.rejects(
    projectBA1RealSiteEvaluationInput({ observation: populated, packagePath: wrongPackage }),
    error => error instanceof TypeError && /not the B-A1 route encoder/.test(error.message),
  );
});
