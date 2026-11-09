import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1FirstResultExistsError,
  BA1_REAL_SITE_FAMILY,
  runBA1RealSiteFirstResult,
} from "../dist/adapters/browser/b-a1-real-site-consumer.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { UNIFIED_PARAMETER_COUNTS } from "../dist/training/unified-forward.js";

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

const scopeRoot = element({ tagName: "DIV" });

function labelHost(text = "搜索", overrides = {}) {
  return element({
    getAttribute: name => (name === "type" ? "search" : null),
    labels: text === null ? [] : [element({ tagName: "LABEL", textContent: text })],
    parentElement: scopeRoot,
    ...overrides,
  });
}

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

async function packageScoringHasLabel(dir, seed) {
  const W1 = new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  W1[0 * 64 + 35] = 1;
  const W2 = new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  W2[0 * 64 + 0] = 1;
  const W3 = new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  W3[0] = 1;
  const pkg = createUnifiedModelPackage({
    modelId: `b-a1-real-site-consumer-fixture-${seed}`,
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
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), "{}\n");
  await writeFile(join(dir, "missing.json"), "{}\n");
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
}

function selectedGold(ref = "c1", group = "g1") {
  return {
    kind: "bound",
    state: "selected",
    selectedRef: ref,
    family: BA1_REAL_SITE_FAMILY,
    group,
  };
}

test("a fixed non-search branch is recorded as not-run forward without a failure receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-none-"));
  const packagePath = await packageScoringHasLabel(dir, 5);
  const observed = observation([
    { nodeRef: "c1", element: labelHost("备注") },
  ]);
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: {
      documentRef: observed.documentRef,
      observationId: observed.observationId,
      revision: observed.revision,
    },
    gold: {
      kind: "bound",
      state: "none",
      family: BA1_REAL_SITE_FAMILY,
      group: "fixed",
    },
    sampleId: "sample-none",
    outputDir: join(dir, "out"),
  });

  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "none");
  assert.equal(result.artifacts.failureReceipt, null);
  const projectionFile = JSON.parse(await readFile(result.artifacts.projection, "utf8"));
  assert.equal(projectionFile.forward.status, "not_run");
  assert.equal(projectionFile.forward.noForwardReason, "fixed_non_search_branch");
  assert.equal(result.evaluation.passed, true);
});

test("saves one consistent first projection, evaluation row, and summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-success-"));
  const packagePath = await packageScoringHasLabel(dir, 1);
  const observed = observation([
    { nodeRef: "c1", element: labelHost("搜索") },
    { nodeRef: "c2", element: labelHost(null) },
  ]);
  const currentControl = {
    documentRef: observed.documentRef,
    observationId: observed.observationId,
    revision: observed.revision,
  };
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl,
    gold: selectedGold("c1"),
    sampleId: "sample-1",
    outputDir: join(dir, "out"),
  });

  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "selected");
  assert.equal(result.projection.output.selectedRef, "c1");
  assert.deepEqual(result.projection.currentControl, currentControl);
  assert.equal(Object.hasOwn(result.projection, "gold"), false);
  assert.equal(result.evaluation.passed, true);

  const projectionFile = JSON.parse(await readFile(result.artifacts.projection, "utf8"));
  assert.equal(projectionFile.schema, "nnanything.b-a1.real-site-first-projection.v1");
  assert.equal(projectionFile.package.modelId, "b-a1-real-site-consumer-fixture-1");
  assert.deepEqual(projectionFile.projection, result.projection);
  assert.equal(projectionFile.forward.status, "completed");
  assert.equal(projectionFile.forward.noForwardReason, null);

  const rows = (await readFile(result.artifacts.evaluationRows, "utf8")).trim().split("\n");
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0]), result.evaluationRow);

  const summary = JSON.parse(await readFile(result.artifacts.summary, "utf8"));
  assert.deepEqual(summary, result.summary);
  assert.equal(summary.denominators[0].family, BA1_REAL_SITE_FAMILY);
  assert.equal(result.artifacts.failureReceipt, null);
});

test("a second save is create-only and does not overwrite the first result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-duplicate-"));
  const packagePath = await packageScoringHasLabel(dir, 2);
  const observed = observation([{ nodeRef: "c1", element: labelHost("搜索") }]);
  const request = {
    observation: observed,
    packagePath,
    currentControl: {
      documentRef: observed.documentRef,
      observationId: observed.observationId,
      revision: observed.revision,
    },
    gold: selectedGold("c1"),
    sampleId: "sample-2",
    outputDir: join(dir, "out"),
  };

  const first = await runBA1RealSiteFirstResult(request);
  const beforeProjection = await readFile(first.artifacts.projection, "utf8");
  const beforeRows = await readFile(first.artifacts.evaluationRows, "utf8");

  await assert.rejects(
    runBA1RealSiteFirstResult(request),
    error => error instanceof BA1FirstResultExistsError
      && error.code === "BA1_FIRST_RESULT_EXISTS",
  );
  assert.equal(await readFile(first.artifacts.projection, "utf8"), beforeProjection);
  assert.equal(await readFile(first.artifacts.evaluationRows, "utf8"), beforeRows);
});

test("an independently supplied current control is preserved and typed failure is receipted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-control-"));
  const packagePath = await packageScoringHasLabel(dir, 3);
  const observed = observation([{ nodeRef: "c1", element: labelHost("搜索") }]);
  const currentControl = {
    documentRef: observed.documentRef,
    observationId: "control-obs",
    revision: 4,
  };
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl,
    gold: { kind: "reject", reason: "stale_candidate", family: BA1_REAL_SITE_FAMILY, group: "stale" },
    sampleId: "sample-3",
    outputDir: join(dir, "out"),
  });

  assert.equal(result.projection.output.kind, "reject");
  assert.equal(result.projection.output.reason, "stale_candidate");
  assert.deepEqual(result.projection.currentControl, currentControl);
  assert.notEqual(result.projection.currentControl.observationId, observed.observationId);
  assert.ok(result.artifacts.failureReceipt);

  const receipt = JSON.parse(await readFile(result.artifacts.failureReceipt, "utf8"));
  assert.equal(receipt.stage, "projection");
  assert.equal(receipt.failure.kind, "reject");
  assert.equal(receipt.failure.reason, "stale_candidate");
  assert.deepEqual(receipt.identity.currentControl, currentControl);
  assert.deepEqual(receipt.identity.observed, {
    documentRef: observed.documentRef,
    observationId: observed.observationId,
    revision: observed.revision,
  });

  const projectionFile = JSON.parse(await readFile(result.artifacts.projection, "utf8"));
  assert.equal(projectionFile.forward.status, "not_run");
  assert.equal(projectionFile.forward.noForwardReason, "reject:stale_candidate");
});

test("missing measurement is receipted without shrinking the expected denominator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-missing-"));
  const packagePath = await packageScoringHasLabel(dir, 4);
  const observed = observation([{ nodeRef: "c1", element: labelHost("搜索") }], {
    propertiesOf: () => null,
  });
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: {
      documentRef: observed.documentRef,
      observationId: observed.observationId,
      revision: observed.revision,
    },
    gold: {
      kind: "bound",
      state: "insufficient_observation",
      family: BA1_REAL_SITE_FAMILY,
      group: "missing",
    },
    sampleId: "sample-4",
    outputDir: join(dir, "out"),
  });

  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "insufficient_observation");
  assert.equal(result.projection.expectedCount, 1);
  assert.equal(result.projection.evaluatedCount, 0);
  assert.ok(result.artifacts.failureReceipt);
  const receipt = JSON.parse(await readFile(result.artifacts.failureReceipt, "utf8"));
  assert.equal(receipt.failure.noForwardReason, "missing_measurement");
  assert.equal(receipt.expectedCount, 1);
  assert.equal(receipt.evaluatedCount, 0);
});

test("scored candidates below threshold keep forward executed and preserve typed semantic failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-all-below-"));
  const packagePath = await packageScoringHasLabel(dir, 7);
  const observed = observation([
    { nodeRef: "c1", element: labelHost(null) },
    { nodeRef: "c2", element: labelHost(null) },
  ]);
  const currentControl = {
    documentRef: observed.documentRef,
    observationId: observed.observationId,
    revision: observed.revision,
  };
  const gold = {
    kind: "bound",
    state: "insufficient_observation",
    family: BA1_REAL_SITE_FAMILY,
    group: "all-below",
  };
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl,
    gold,
    sampleId: "sample-all-below",
    outputDir: join(dir, "out"),
  });

  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "insufficient_observation");
  assert.ok(result.projection.scoredCandidates.length > 0);
  const insufficient = result.projection.evidenceRecords.find(
    record => record.type === "insufficient_observation",
  );
  assert.equal(insufficient?.payload.insufficientReason, "all_below_threshold");
  assert.equal(result.evaluation.passed, true);
  assert.ok(result.artifacts.failureReceipt);

  const projectionFile = JSON.parse(await readFile(result.artifacts.projection, "utf8"));
  assert.deepEqual(projectionFile.projection.currentControl, currentControl);
  assert.equal(projectionFile.projection.output.state, "insufficient_observation");
  assert.equal(projectionFile.projection.scoredCandidates.length, result.projection.scoredCandidates.length);
  assert.equal(
    projectionFile.projection.evidenceRecords.find(
      record => record.type === "insufficient_observation",
    )?.payload.insufficientReason,
    "all_below_threshold",
  );
  assert.equal(projectionFile.forward.status, "completed");
  assert.equal(projectionFile.forward.noForwardReason, null);

  const receipt = JSON.parse(await readFile(result.artifacts.failureReceipt, "utf8"));
  assert.equal(receipt.failure.kind, "bound");
  assert.equal(receipt.failure.noForwardReason, "all_below_threshold");
  assert.equal(receipt.identity.sampleId, "sample-all-below");
  assert.equal(receipt.identity.family, BA1_REAL_SITE_FAMILY);
  assert.equal(receipt.identity.group, "all-below");
});

test("a runtime failure keeps a receipt and no success artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-failure-"));
  const observed = observation([{ nodeRef: "c1", element: labelHost("搜索") }]);
  const outputDir = join(dir, "out");
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: observed,
      packagePath: join(dir, "missing-package.json"),
      currentControl: {
        documentRef: observed.documentRef,
        observationId: observed.observationId,
        revision: observed.revision,
      },
      gold: selectedGold("c1"),
      sampleId: "sample-5",
      outputDir,
    }),
    /missing or unreadable/,
  );

  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.stage, "package");
  assert.equal(receipt.identity.sampleId, "sample-5");
  assert.equal(receipt.identity.family, BA1_REAL_SITE_FAMILY);
  assert.equal(receipt.identity.group, "g1");
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
  await assert.rejects(readFile(join(outputDir, "real-site-evaluation.jsonl"), "utf8"));
});

test("a JSON-shaped observation is refused instead of being rehydrated as DOM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-json-"));
  const packagePath = await packageScoringHasLabel(dir, 6);
  const observed = observation([{ nodeRef: "c1", element: labelHost("搜索") }]);
  const jsonObservation = JSON.parse(JSON.stringify(observed));
  jsonObservation.scopeRoot = JSON.parse(JSON.stringify(observed.scopeRoot));
  jsonObservation.nodes = observed.nodes.map(node => ({
    nodeRef: node.nodeRef,
    element: JSON.parse(JSON.stringify(node.element)),
  }));

  const outputDir = join(dir, "out");
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: jsonObservation,
      packagePath,
      currentControl: {
        documentRef: observed.documentRef,
        observationId: observed.observationId,
        revision: observed.revision,
      },
      gold: selectedGold("c1"),
      sampleId: "sample-6",
      outputDir,
    }),
    /runtime Element/,
  );
  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.stage, "input");
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
});
