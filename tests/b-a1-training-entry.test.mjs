import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  encodeBA1RouteCandidate,
  encodeBA1RouteGroup,
} from "../dist/training/b-a1-route-encoder.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import { BA1_TRAIN_CONFIG_SCHEMA, trainBA1UnifiedRelationDecision } from "../dist/training/b-a1-training-entry.js";

function gateContext(overrides = {}) {
  return {
    requestedRole: "search-input-host",
    allowedScopeRef: "scope-1",
    coverage: {
      status: "complete",
      evaluatedCount: 3,
      expectedCount: 3,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
    },
    candidateGroupEnumerationComplete: true,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    candidateRef: "c1",
    candidateKind: "relation",
    optionSemantics: "select",
    scopeRef: "scope-1",
    host: "input",
    type: "text",
    contentEditable: false,
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
    markerHit: false,
    nonSearchMarker: false,
    textLenBand: 1,
    access: "available",
    ...overrides,
  };
}

function encodedGroup(groupRef, refs) {
  const candidates = refs.map((ref, index) => candidate({ candidateRef: ref }));
  return encodeBA1RouteGroup({
    groupRef,
    context: gateContext(),
    candidates,
    allowedCandidateRefs: [refs[0]],
  });
}

function studentRow(group_id, candidateRef, x) {
  return {
    schema: "nnanything.b-a1-unified.student-row.v1",
    group_id,
    sampleId: `s-${group_id}`,
    sourceGroup: "family-b-a1",
    partition: "TRAIN",
    candidateRef,
    x,
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
    maxEpochs: 200,
    seed: 20261104,
    init: "xavier_uniform",
    resources: {
      thresholdsRef: "thresholds.json",
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: "missing.json",
      missingModeSchema: "nnanything.unified.missing-mode.v1",
      slotMapRef: "slots.json",
    },
    modelId: "b-a1-test",
    version: "0.0.1",
    ...overrides,
  };
}

async function writeResourceFiles(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), JSON.stringify({ schema: "nnanything.feature-thresholds.v1" }) + "\n");
  await writeFile(join(dir, "missing.json"), JSON.stringify({ schema: "nnanything.unified.missing-mode.v1" }) + "\n");
  await writeFile(join(dir, "slots.json"), JSON.stringify({ schema: "nnanything.b-a1.slot-map.v1" }) + "\n");
}

async function writePackageResources(packageOutPath) {
  await writeResourceFiles(join(packageOutPath, ".."));
}

async function writeRows(dir, student, supervision) {
  await writeFile(join(dir, "student.jsonl"), student.map(r => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(dir, "supervision.jsonl"), supervision.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { studentRowsPath: join(dir, "student.jsonl"), supervisionRowsPath: join(dir, "supervision.jsonl") };
}

test("the fixed entry trains two groups, saves a package and a checkpoint, and verifies reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const g1 = encodedGroup("g1", ["c1", "c2"]);
  const g2 = encodedGroup("g2", ["c1"]);
  const student = [
    studentRow("g1", "c1", g1.candidates[0].input),
    studentRow("g1", "c2", g1.candidates[1].input),
    studentRow("g2", "c1", g2.candidates[0].input),
  ];
  const supervision = [supervisionRow("g1", ["c1"]), supervisionRow("g2", ["c1"])];
  const { studentRowsPath, supervisionRowsPath } = await writeRows(dir, student, supervision);
  const packageOutPath = join(dir, "pkg", "package.json");
  await writePackageResources(packageOutPath);
  const result = await trainBA1UnifiedRelationDecision({
    config: config({ maxEpochs: 3, fixedRecipe: false }),
    studentRowsPath,
    supervisionRowsPath,
    packageOutPath,
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
  assert.equal(result.receipt.packageReload.resourceFilesRead, true);
  assert.equal(result.receipt.packageReload.newProcessVerified, true);
  assert.equal(result.receipt.checkpointReload.tensorsMatch, true);
  assert.equal(result.receipt.checkpointReload.completedEpochs, 3);
  assert.ok(result.receipt.timing.optimizationSeconds >= 0);
  assert.equal(result.receipt.timing.attemptOptimizerSteps, 3);
  assert.equal(result.receipt.timing.completedOptimizerSteps, 3);
  assert.ok(result.report.initialLoss !== null && result.report.finalLoss !== null);
  assert.ok(result.receipt.checkpointOutPath !== null);
});

test("the fixed entry rejects an incompatible encoder version before training", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const g1 = encodedGroup("g1", ["c1"]);
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );
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
  const g1 = encodedGroup("g1", ["c1"]);
  const poisoned = { ...studentRow("g1", "c1", g1.candidates[0].input), gold: "forbidden" };
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
  const g1 = encodedGroup("g1", ["c1"]);
  const poisoned = { ...supervisionRow("g1", ["c1"]), x: g1.candidates[0].input };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [poisoned],
  );
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
  const g1 = encodedGroup("g1", ["c1"]);
  const outside = { ...supervisionRow("g1", ["c1"]), goldAllowedCandidateRefs: ["c1", "ghost"] };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [outside],
  );
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
  const paths = await writeRows(emptyDir, [studentRow("g1", "c1", g1.candidates[0].input)], [emptyA]);
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
  const g1 = encodedGroup("g1", ["c1"]);
  const short = { ...studentRow("g1", "c1", g1.candidates[0].input), x: g1.candidates[0].input.slice(0, 63) };
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [short],
    [supervisionRow("g1", ["c1"])],
  );
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
  const nan = {
    ...studentRow("g1", "c1", g1.candidates[0].input),
    x: g1.candidates[0].input.map((v, i) => (i === 0 ? Number.NaN : v)),
  };
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

test("duplicate supervision, orphan supervision, source mismatch and ineligible status are data-invalid", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const goodStudent = studentRow("g1", "c1", g1.candidates[0].input);

  const dupDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const dupPaths = await writeRows(
    dupDir,
    [goodStudent],
    [supervisionRow("g1", ["c1"]), supervisionRow("g1", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: dupPaths.studentRowsPath,
      supervisionRowsPath: dupPaths.supervisionRowsPath,
      packageOutPath: join(dupDir, "pkg.json"),
    }),
    /duplicate supervision row/,
  );

  const orphanDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const orphanPaths = await writeRows(
    orphanDir,
    [goodStudent],
    [supervisionRow("g1", ["c1"]), supervisionRow("g2", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: orphanPaths.studentRowsPath,
      supervisionRowsPath: orphanPaths.supervisionRowsPath,
      packageOutPath: join(orphanDir, "pkg.json"),
    }),
    /orphan supervision row/,
  );

  const mismatchDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const mismatchedSupervision = { ...supervisionRow("g1", ["c1"]), sampleId: "different-sample" };
  const mismatchPaths = await writeRows(
    mismatchDir,
    [goodStudent],
    [mismatchedSupervision],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: mismatchPaths.studentRowsPath,
      supervisionRowsPath: mismatchPaths.supervisionRowsPath,
      packageOutPath: join(mismatchDir, "pkg.json"),
    }),
    /source mismatch/,
  );

  const ineligibleDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const unresolvedSupervision = {
    ...supervisionRow("g1", ["c1"]),
    supervisionStatus: "unresolved_supervision",
    trainingEligible: false,
    evaluationClass: "unresolved",
  };
  const ineligiblePaths = await writeRows(
    ineligibleDir,
    [goodStudent],
    [unresolvedSupervision],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: ineligiblePaths.studentRowsPath,
      supervisionRowsPath: ineligiblePaths.supervisionRowsPath,
      packageOutPath: join(ineligibleDir, "pkg.json"),
    }),
    /not training-eligible/,
  );

  const wrongStatusDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const wrongStatus = {
    ...supervisionRow("g1", ["c1"]),
    supervisionStatus: "made_up",
  };
  const wrongStatusPaths = await writeRows(
    wrongStatusDir,
    [goodStudent],
    [wrongStatus],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: wrongStatusPaths.studentRowsPath,
      supervisionRowsPath: wrongStatusPaths.supervisionRowsPath,
      packageOutPath: join(wrongStatusDir, "pkg.json"),
    }),
    /unknown supervisionStatus/,
  );
});

test("student x that violates route gates or reserved slots is rejected by the route encoder path", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const badGateway = g1.candidates[0].input.slice();
  badGateway[58] = 0;
  const gatewayDir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const gatewayPaths = await writeRows(
    gatewayDir,
    [studentRow("g1", "c1", badGateway)],
    [supervisionRow("g1", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: gatewayPaths.studentRowsPath,
      supervisionRowsPath: gatewayPaths.supervisionRowsPath,
      packageOutPath: join(gatewayDir, "pkg.json"),
    }),
    /route encoder rejected/,
  );

  const reserved = g1.candidates[0].input.slice();
  reserved[38] = 1;
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const paths = await writeRows(
    dir,
    [studentRow("g1", "c1", reserved)],
    [supervisionRow("g1", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: paths.studentRowsPath,
      supervisionRowsPath: paths.supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /route encoder rejected/,
  );
});

test("student x with an undeclared -1 sentinel fails the missingMode consistency gate", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const bad = g1.candidates[0].input.slice();
  bad[9] = -1;
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const paths = await writeRows(
    dir,
    [studentRow("g1", "c1", bad)],
    [supervisionRow("g1", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: paths.studentRowsPath,
      supervisionRowsPath: paths.supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /missingMode/,
  );
});

test("missing or unreadable resource files fail package reload", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );
  const packageDir = join(dir, "pkg");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "thresholds.json"), JSON.stringify({ x: 1 }) + "\n");
  await writeFile(join(packageDir, "missing.json"), JSON.stringify({ x: 1 }) + "\n");
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(packageDir, "package.json"),
    }),
    error => error?.code === "DATA_INVALID" || /resource|unreadable|missing/.test(String(error?.message ?? error)),
  );
});
