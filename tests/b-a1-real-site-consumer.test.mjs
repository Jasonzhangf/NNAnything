import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1FirstResultExistsError,
  BA1RealSiteAcceptanceChangedError,
  BA1RealSiteFreshnessError,
  BA1_REAL_SITE_FAMILY,
  runBA1RealSiteFirstResult,
} from "../dist/adapters/browser/b-a1-real-site-consumer.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
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

function operationRead(identity, generation = 1) {
  return { identity: { ...identity }, generation };
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

test("a selected projected observation saves the first result with forward completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-success-"));
  const packagePath = await packageScoringHasLabel(dir, 1);
  const observed = observation([candidate("c1")]);
  const current = operationRead(observed.identity);
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: () => current,
    gold: selectedGold("c1"),
    sampleId: "sample-1",
    outputDir: join(dir, "out"),
  });
  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "selected");
  assert.equal(result.evaluation.passed, true);
  assert.equal(Object.hasOwn(result.projection, "gold"), false);
  const projectionFile = JSON.parse(await readFile(result.artifacts.projection, "utf8"));
  assert.equal(projectionFile.forward.status, "completed");
  assert.equal(projectionFile.acceptance.status, "accepted");
  assert.deepEqual(projectionFile.acceptance.operation, current);
  assert.deepEqual(projectionFile.acceptance.observed, current);
  assert.equal(result.artifacts.failureReceipt, null);
});

test("a second save is create-only and does not overwrite the accepted record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-duplicate-"));
  const packagePath = await packageScoringHasLabel(dir, 2);
  const observed = observation([candidate("c1")]);
  const current = operationRead(observed.identity);
  const request = {
    observation: observed,
    packagePath,
    currentControl: () => current,
    gold: selectedGold("c1"),
    sampleId: "sample-2",
    outputDir: join(dir, "out"),
  };
  const first = await runBA1RealSiteFirstResult(request);
  const before = await readFile(first.artifacts.projection, "utf8");
  await assert.rejects(
    runBA1RealSiteFirstResult(request),
    error => error instanceof BA1FirstResultExistsError,
  );
  assert.equal(await readFile(first.artifacts.projection, "utf8"), before);
});

test("a missing package keeps a failure receipt and no success artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-failure-"));
  const observed = observation([candidate("c1")]);
  const current = operationRead(observed.identity);
  const outputDir = join(dir, "out");
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: observed,
      packagePath: join(dir, "missing.json"),
      currentControl: () => current,
      gold: selectedGold("c1"),
      sampleId: "sample-3",
      outputDir,
    }),
    /missing or unreadable/,
  );
  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.stage, "package");
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
});

test("admission rejects a stale projected observation before package load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-stale-"));
  const observed = observation([candidate("c1")]);
  const stale = operationRead({ ...observed.identity, observationId: "obs-2" });
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: observed,
      packagePath: join(dir, "missing.json"),
      currentControl: () => stale,
      gold: selectedGold("c1"),
      sampleId: "sample-stale",
      outputDir: join(dir, "out"),
    }),
    error => error instanceof BA1RealSiteFreshnessError && error.stage === "admission",
  );
  const receipt = JSON.parse(await readFile(join(dir, "out", "failure-receipt.json"), "utf8"));
  assert.equal(receipt.stage, "admission");
  assert.equal(receipt.failure.code, "stale_candidate");
  assert.equal(receipt.failure.forward.status, "not_run");
  assert.deepEqual(receipt.failure.scores, []);
});

test("provider replacement while package load is pending rejects stale_forward_gate with no forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-forward-gate-"));
  const packagePath = await packageScoringHasLabel(dir, 3);
  const observed = observation([candidate("c1")]);
  const operation = operationRead(observed.identity, 1);
  let reads = 0;
  const reader = () => {
    reads += 1;
    return reads === 2
      ? operationRead({ ...observed.identity, observationId: "obs-2" }, 2)
      : operation;
  };
  const outputDir = join(dir, "out");
  const promise = runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: reader,
    gold: selectedGold("c1"),
    sampleId: "sample-forward",
    outputDir,
  });
  await assert.rejects(
    promise,
    error => error instanceof BA1RealSiteFreshnessError && error.code === "stale_forward_gate",
  );
  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.stage, "forward_gate");
  assert.equal(receipt.failure.code, "stale_forward_gate");
  assert.equal(receipt.failure.forward.status, "not_run");
  assert.deepEqual(receipt.failure.scores, []);
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
});

test("provider change after forward before acceptance preserves completed scores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-acceptance-"));
  const packagePath = await packageScoringHasLabel(dir, 4);
  const observed = observation([candidate("c1")]);
  const operation = operationRead(observed.identity, 1);
  let reads = 0;
  const reader = () => {
    reads += 1;
    return reads === 3
      ? operationRead({ ...observed.identity, observationId: "obs-3" }, 2)
      : operation;
  };
  const outputDir = join(dir, "out");
  const promise = runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: reader,
    gold: selectedGold("c1"),
    sampleId: "sample-acceptance",
    outputDir,
  });
  const error = await promise.then(() => null, value => value);
  assert.ok(error instanceof BA1RealSiteAcceptanceChangedError);
  assert.equal(error.attempt.forward.status, "completed");
  assert.equal(error.attempt.scores.length, 1);
  assert.equal(error.attempt.evaluationRow.output.state, "selected");
  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.stage, "acceptance");
  assert.equal(receipt.failure.kind, "current_control_changed_before_acceptance");
  assert.equal(receipt.attempt.forward.status, "completed");
  assert.equal(receipt.attempt.scores.length, 1);
  assert.equal(receipt.attempt.evaluationRow.output.state, "selected");
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
});

test("a JSON-shaped or callback-bearing observation is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-json-"));
  const observed = observation([candidate("c1")]);
  const current = operationRead(observed.identity);
  const fake = JSON.parse(JSON.stringify(observed));
  fake.candidates[0].tagName = "INPUT";
  const outputDir = join(dir, "out");
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: fake,
      packagePath: join(dir, "missing.json"),
      currentControl: () => current,
      gold: selectedGold("c1"),
      sampleId: "sample-json",
      outputDir,
    }),
    error => error instanceof TypeError && /DOM-like|must contain exactly/.test(error.message),
  );
  const receipt = JSON.parse(await readFile(join(outputDir, "failure-receipt.json"), "utf8"));
  assert.equal(receipt.stage, "input");
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
});

test("after acceptance, a later provider replacement does not rewrite the accepted record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-consumer-later-"));
  const packagePath = await packageScoringHasLabel(dir, 5);
  const observed = observation([candidate("c1")]);
  let current = operationRead(observed.identity, 1);
  const result = await runBA1RealSiteFirstResult({
    observation: observed,
    packagePath,
    currentControl: () => current,
    gold: selectedGold("c1"),
    sampleId: "sample-later",
    outputDir: join(dir, "out"),
  });
  const before = await readFile(result.artifacts.projection, "utf8");
  current = operationRead({ documentRef: "doc-2", observationId: "obs-9", revision: 1 }, 2);
  assert.equal(await readFile(result.artifacts.projection, "utf8"), before);
  const files = (await readdir(join(dir, "out"))).sort();
  assert.deepEqual(files, ["first-projection.json", "real-site-evaluation.jsonl", "summary.json"]);
});
