import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    family: "model-semantic",
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
    family: "model-semantic",
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

const B_A1_SLOT_MAP = [
  [0, "goal.requestedRoleIsSearchInputHost", "gate-constant", 1],
  [1, "goal.allowedScopeKnown", "gate-constant", 1],
  [2, "coverage.statusComplete", "gate-constant", 1],
  [3, "coverage.countMatch", "gate-constant", 1],
  [4, "coverage.unassessedIframePresent", "gate-constant", 0],
  [5, "coverage.unassessedObjectPresent", "gate-constant", 0],
  [6, "coverage.unassessedShadowRootPresent", "gate-constant", 0],
  [7, "candidate.insideAllowedScope", "gate-constant", 1],
  [8, "access", "feature"],
  [9, "host.input", "feature"],
  [10, "host.textarea", "feature"],
  [11, "host.contentEditable", "feature"],
  [12, "editable", "feature"],
  [13, "disabled", "feature"],
  [14, "readOnly", "feature"],
  [15, "cssHidden", "feature"],
  [16, "intersectsViewport", "feature"],
  [17, "type.text", "feature"],
  [18, "type.search", "feature"],
  [19, "type.tel", "feature"],
  [20, "type.email", "feature"],
  [21, "type.url", "feature"],
  [22, "type.number", "feature"],
  [23, "type.other", "feature"],
  [24, "inForm", "feature"],
  [25, "formRoleSearch", "feature"],
  [26, "nearbySubmit", "feature"],
  [27, "explicitTabIndex.negative", "feature"],
  [28, "explicitTabIndex.nonnegative", "feature"],
  [29, "explicitTabIndex.absent", "feature"],
  [30, "explicitTabIndex.invalid", "feature"],
  [31, "tabIndexFocus", "feature"],
  [32, "depth.shallow", "feature"],
  [33, "depth.middle", "feature"],
  [34, "depth.deep", "feature"],
  [35, "hasLabel", "feature"],
  [36, "hasPlaceholder", "feature"],
  [37, "hasAria", "feature"],
  [38, "nameChannelCoverage.complete", "reserved-constant", 0],
  [39, "nameChannelCoverage.partial", "reserved-constant", 0],
  [40, "markerHit", "feature"],
  [41, "nonSearchMarker", "feature"],
  [42, "textLenBand.empty", "feature"],
  [43, "textLenBand.short", "feature"],
  [44, "textLenBand.long", "feature"],
  [45, "usage.query_support", "reserved-constant", 0],
  [46, "usage.field_support", "reserved-constant", 0],
  [47, "relativePositionBand", "reserved-constant", 0],
  [48, "nearbySubmit.relativeSide", "reserved-constant", 0],
  [49, "nearbySubmit.distanceBand", "reserved-constant", 0],
  [50, "nearbySubmit.enabled", "reserved-constant", 0],
  [51, "ancestorContainmentDepthBand", "reserved-constant", 0],
  [52, "siblingOrderBand", "reserved-constant", 0],
  [53, "precedingTextClass", "reserved-constant", 0],
  [54, "reserved", "reserved-constant", 0],
  [55, "reserved", "reserved-constant", 0],
  [56, "candidateKindIsRelation", "control-constant", 1],
  [57, "optionSemanticsIsSelect", "control-constant", 1],
  [58, "candidateGroupEnumerationComplete", "gate-constant", 1],
  [59, "scorableCountGreaterThanOne", "gate-constant"],
  [60, "scorableCountEqualsOne", "gate-constant"],
  [61, "reserved", "reserved-constant", 0],
  [62, "reserved", "reserved-constant", 0],
  [63, "reserved", "reserved-constant", 0],
].map(([slot, field, kind, constant]) => ({
  slot,
  field,
  kind,
  ...(constant === undefined ? {} : { constant }),
}));

async function writeResourceFiles(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), JSON.stringify({
    schema: "nnanything.feature-thresholds.v1",
    route: "browser/R",
    encoderVersion: BA1_ENCODER_VERSION,
    buckets: {
      constraints: [0, 1, 2, 4],
      knownFacts: [1, 2, 4, 8],
      missingFacts: [0, 1, 2, 4],
      objectRefs: [1, 2, 4, 8],
      requiredArgsRatio: [0, 0.25, 0.5, 1],
      requiredMissing: [0, 1, 2, 4],
    },
  }) + "\n");
  await writeFile(join(dir, "missing.json"), JSON.stringify({
    schema: "nnanything.unified.missing-mode.v1",
    entries: [],
  }) + "\n");
  await writeFile(join(dir, "slots.json"), JSON.stringify({
    schema: "nnanything.b-a1.slot-map.v1",
    route: "browser/R",
    encoderVersion: BA1_ENCODER_VERSION,
    slots: B_A1_SLOT_MAP,
  }) + "\n");
}

async function writePackageResources(packageOutPath) {
  await writeResourceFiles(join(packageOutPath, ".."));
}

async function writeRows(dir, student, supervision, options = {}) {
  if (options.resources !== false) await writeResourceFiles(dir);
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
    { resources: false },
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

test("the training entry rejects contract-gate and aggregator-test families before encoding", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  for (const family of ["contract-gate", "aggregator-test"]) {
    const dir = await mkdtemp(join(tmpdir(), `b-a1-family-${family}-`));
    const student = { ...studentRow("g1", "c1", g1.candidates[0].input), family };
    const supervision = { ...supervisionRow("g1", ["c1"]), family };
    const { studentRowsPath, supervisionRowsPath } = await writeRows(
      dir,
      [student],
      [supervision],
    );
    await assert.rejects(
      trainBA1UnifiedRelationDecision({
        config: config(),
        studentRowsPath,
        supervisionRowsPath,
        packageOutPath: join(dir, "pkg.json"),
      }),
      /only admits model-semantic/,
    );
  }
});

test("A_g duplicate refs and selected A_g cardinality are explicit data errors", async () => {
  const g1 = encodedGroup("g1", ["c1", "c2"]);
  const dupDir = await mkdtemp(join(tmpdir(), "b-a1-a-g-dup-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dupDir,
    [
      studentRow("g1", "c1", g1.candidates[0].input),
      studentRow("g1", "c2", g1.candidates[1].input),
    ],
    [supervisionRow("g1", ["c1", "c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dupDir, "pkg.json"),
    }),
    /A_g contains duplicate refs/,
  );

  const cardinalityDir = await mkdtemp(join(tmpdir(), "b-a1-a-g-cardinality-"));
  const cardinalityPaths = await writeRows(
    cardinalityDir,
    [
      studentRow("g1", "c1", g1.candidates[0].input),
      studentRow("g1", "c2", g1.candidates[1].input),
    ],
    [supervisionRow("g1", ["c1", "c2"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: cardinalityPaths.studentRowsPath,
      supervisionRowsPath: cardinalityPaths.supervisionRowsPath,
      packageOutPath: join(cardinalityDir, "pkg.json"),
    }),
    /exactly one allowed candidate/,
  );
});

test("ambiguous A_g cardinality and non-training supervision statuses are rejected", async () => {
  const g1 = encodedGroup("g1", ["c1", "c2"]);
  const ambiguousDir = await mkdtemp(join(tmpdir(), "b-a1-a-g-ambiguous-"));
  const ambiguousPaths = await writeRows(
    ambiguousDir,
    [
      studentRow("g1", "c1", g1.candidates[0].input),
      studentRow("g1", "c2", g1.candidates[1].input),
    ],
    [{
      ...supervisionRow("g1", ["c1"]),
      supervisionStatus: "labeled_ambiguous",
    }],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath: ambiguousPaths.studentRowsPath,
      supervisionRowsPath: ambiguousPaths.supervisionRowsPath,
      packageOutPath: join(ambiguousDir, "pkg.json"),
    }),
    /at least two allowed candidates/,
  );

  for (const [status, eligibility, evaluationClass] of [
    ["labeled_none", false, "none"],
    ["observation_missing", false, "insufficient"],
    ["unresolved_supervision", false, "unresolved"],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), `b-a1-status-${status}-`));
    const supervision = {
      ...supervisionRow("g1", ["c1"]),
      supervisionStatus: status,
      trainingEligible: eligibility,
      evaluationClass,
    };
    const paths = await writeRows(
      dir,
      [studentRow("g1", "c1", g1.candidates[0].input)],
      [supervision],
    );
    await assert.rejects(
      trainBA1UnifiedRelationDecision({
        config: config(),
        studentRowsPath: paths.studentRowsPath,
        supervisionRowsPath: paths.supervisionRowsPath,
        packageOutPath: join(dir, "pkg.json"),
      }),
      /not training-eligible/,
    );
  }
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
    /source\/family mismatch/,
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

test("student x with non-route finite but illegal semantic values is rejected by slot semantics", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  for (const slot of [9, 12, 17, 27, 32, 42]) {
    const bad = g1.candidates[0].input.slice();
    bad[slot] = 2;
    const dir = await mkdtemp(join(tmpdir(), `b-a1-slot-${slot}-`));
    const { studentRowsPath, supervisionRowsPath } = await writeRows(
      dir,
      [studentRow("g1", "c1", bad)],
      [supervisionRow("g1", ["c1"])],
    );
    await assert.rejects(
      trainBA1UnifiedRelationDecision({
        config: config(),
        studentRowsPath,
        supervisionRowsPath,
        packageOutPath: join(dir, "pkg.json"),
      }),
      /route encoder rejected/,
    );
  }

  const doubleType = g1.candidates[0].input.slice();
  doubleType[18] = 1;
  const dir = await mkdtemp(join(tmpdir(), "b-a1-one-hot-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", doubleType)],
    [supervisionRow("g1", ["c1"])],
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config(),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "pkg.json"),
    }),
    /exactly one 1/,
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

test("missing or invalid resource files fail before package reload", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const dir = await mkdtemp(join(tmpdir(), "b-a1-train-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
    { resources: false },
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

test("invalid resource content fails before any optimizer step or package output", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const baseDir = await mkdtemp(join(tmpdir(), "b-a1-resource-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    baseDir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );

  for (const [name, patch] of [
    ["wrong slot map schema", { slots: { schema: "not-b-a1" } }],
    ["wrong slot map route", { slots: { route: "browser/D" } }],
    ["wrong slot map encoder", { slots: { encoderVersion: "wrong" } }],
    ["wrong slot map cardinality", { slots: { slots: [{ slot: 0 }] } }],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), `b-a1-resource-${name.replace(/\W+/g, "-")}-`));
    await writeResourceFiles(dir);
    if (patch.thresholds) {
      const raw = JSON.parse(await readFile(join(dir, "thresholds.json"), "utf8"));
      await writeFile(join(dir, "thresholds.json"), JSON.stringify({ ...raw, ...patch.thresholds }) + "\n");
    }
    if (patch.slots) {
      const raw = JSON.parse(await readFile(join(dir, "slots.json"), "utf8"));
      await writeFile(join(dir, "slots.json"), JSON.stringify({ ...raw, ...patch.slots }) + "\n");
    }
    await assert.rejects(
      trainBA1UnifiedRelationDecision({
        config: config({ maxEpochs: 3, fixedRecipe: false }),
        studentRowsPath,
        supervisionRowsPath,
        packageOutPath: join(dir, "package.json"),
      }),
      error => {
        assert.equal(error?.code, "DATA_INVALID");
        return true;
      },
    );
    await assert.rejects(readFile(join(dir, "package.json")));
  }
});

test("slot map uses the accepted B-A1 field semantics and rejects drift before output", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const baseDir = await mkdtemp(join(tmpdir(), "b-a1-resource-semantics-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    baseDir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );

  const cases = [
    ["swapped fields", slots => {
      [slots[9].field, slots[10].field] = [slots[10].field, slots[9].field];
    }],
    ["wrong gate constant", slots => {
      slots[4].constant = 1;
    }],
    ["feature carrying a constant", slots => {
      slots[8].constant = 1;
    }],
  ];

  for (const [name, mutate] of cases) {
    const dir = await mkdtemp(join(tmpdir(), `b-a1-resource-${name.replace(/\W+/g, "-")}-`));
    await writeResourceFiles(dir);
    const raw = JSON.parse(await readFile(join(dir, "slots.json"), "utf8"));
    mutate(raw.slots);
    await writeFile(join(dir, "slots.json"), JSON.stringify(raw) + "\n");
    await assert.rejects(
      trainBA1UnifiedRelationDecision({
        config: config({ maxEpochs: 3, fixedRecipe: false }),
        studentRowsPath,
        supervisionRowsPath,
        packageOutPath: join(dir, "package.json"),
      }),
      error => {
        assert.equal(error?.code, "DATA_INVALID");
        return true;
      },
    );
    await assert.rejects(readFile(join(dir, "package.json")));
  }
});

test("generic TS/JS threshold buckets are not a B-A1 training precondition", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const dir = await mkdtemp(join(tmpdir(), "b-a1-threshold-unused-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );
  await writeFile(join(dir, "thresholds.json"), JSON.stringify({
    schema: "nnanything.feature-thresholds.v1",
    route: "browser/R",
    encoderVersion: BA1_ENCODER_VERSION,
    buckets: {},
  }) + "\n");

  const result = await trainBA1UnifiedRelationDecision({
    config: config({ maxEpochs: 1, fixedRecipe: false }),
    studentRowsPath,
    supervisionRowsPath,
    packageOutPath: join(dir, "package.json"),
  });
  assert.equal(result.report.completedEpochs, 1);
});

test("missing resource files fail before any optimizer step or package output", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const dir = await mkdtemp(join(tmpdir(), "b-a1-resource-missing-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
    { resources: false },
  );
  await assert.rejects(
    trainBA1UnifiedRelationDecision({
      config: config({ maxEpochs: 3, fixedRecipe: false }),
      studentRowsPath,
      supervisionRowsPath,
      packageOutPath: join(dir, "package.json"),
    }),
    error => {
      assert.equal(error?.code, "DATA_INVALID");
      return true;
    },
  );
  await assert.rejects(readFile(join(dir, "package.json")));
});

test("non-finite optimizer output is classified as non_finite, not data_invalid", async () => {
  const g1 = encodedGroup("g1", ["c1"]);
  const dir = await mkdtemp(join(tmpdir(), "b-a1-nonfinite-"));
  const { studentRowsPath, supervisionRowsPath } = await writeRows(
    dir,
    [studentRow("g1", "c1", g1.candidates[0].input)],
    [supervisionRow("g1", ["c1"])],
  );
  const result = await trainBA1UnifiedRelationDecision({
    config: config({ maxEpochs: 1, learningRate: 1e308, fixedRecipe: false }),
    studentRowsPath,
    supervisionRowsPath,
    packageOutPath: join(dir, "package.json"),
  });
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.stopReason, "non_finite");
  assert.equal(result.report.completedEpochs, 0);
  assert.match(result.report.violations.join("\n"), /non-finite loss or gradient/);
});
