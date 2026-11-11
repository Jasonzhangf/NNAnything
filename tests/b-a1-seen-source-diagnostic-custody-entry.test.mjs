import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  runBA1SeenSourceDiagnosticAccounting,
} from "../dist/adapters/browser/b-a1-seen-source-diagnostic-custody-entry.js";
import {
  BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
} from "../dist/adapters/browser/b-a1-seen-source-diagnostic-accounting.js";
import {
  BA1_REAL_SITE_FAMILY,
  runBA1RealSiteFirstResult,
} from "../dist/adapters/browser/b-a1-real-site-consumer.js";
import {
  summarizeBA1Evaluations,
} from "../dist/training/b-a1-evaluator.js";
import {
  BA1_ENCODER_VERSION,
} from "../dist/training/b-a1-route-encoder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import {
  UNIFIED_PARAMETER_COUNTS,
} from "../dist/training/unified-forward.js";

const SOURCE_GROUP = "rs-a-q1";
const SAMPLE_ID = "rs-a-q1/rel/search-input";
const PHASE = "wikipedia-initial-projection";

function candidate(ref, overrides = {}) {
  return {
    ref,
    scopeRef: "form#searchform",
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
    inForm: true,
    formRoleSearch: false,
    nearbySubmit: false,
    depthBand: "shallow",
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

function controlRecord(overrides = {}) {
  return {
    schema: "nnanything.b-a1.real-site-control-scope-observation.v1",
    taskId: "diagnostic-custody-entry-test",
    siteId: "zh.wikipedia.org",
    phase: PHASE,
    recordType: "projection",
    observedAt: "2026-11-11T00:00:00.000Z",
    purpose: "retained diagnostic projection fixture",
    scopeSelector: "form#searchform",
    requestedRole: "search-input-host",
    access: "available",
    controlBefore: {
      ok: false,
      error: { name: "Error", code: null, message: "not started", detail: {} },
    },
    projectionIdentity: {
      documentRef: "doc-1",
      observationId: "obs-1",
      revision: 1,
    },
    operationControl: {
      identity: {
        documentRef: "doc-1",
        observationId: "obs-1",
        revision: 1,
      },
      generation: 1,
    },
    controlAfterProjection: {
      ok: true,
      control: {
        identity: {
          documentRef: "doc-1",
          observationId: "obs-1",
          revision: 1,
        },
        generation: 1,
      },
    },
    scopeRef: "form#searchform",
    candidateCount: 2,
    eligibleCandidateCount: 1,
    eligibleCandidateRefs: ["node-136"],
    outsideScopeRefs: [],
    coverage: {
      scopeRef: "form#searchform",
      observedCandidateCount: 2,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
    candidateFacts: [
      candidate("node-136"),
      candidate("node-138", {
        type: "other",
        cssHidden: true,
        intersectsViewport: false,
        hasLabel: false,
        hasPlaceholder: false,
        markerHit: false,
        textLenBand: 0,
      }),
    ],
    error: null,
    ...overrides,
  };
}

function sourceRecord(splitDecisionRef, overrides = {}) {
  return {
    schema: "nnanything.b-a1.real-site-source.v1",
    sourceGroupId: SOURCE_GROUP,
    siteId: "zh.wikipedia.org",
    implementationFamily: "rs-fam-a",
    pageKind: "search-entry-and-article-header-search",
    queryCaseId: "qa-1",
    sequenceId: "independent",
    partition: "seen-source diagnostics",
    priorExposure: "seen-source",
    relatedSourceGroups: [],
    splitAuthority: "Jenny",
    splitDecisionRef,
    evidenceRefs: ["split-decision.json"],
    ...overrides,
  };
}

function splitDecision(overrides = {}) {
  return {
    sourceGroupId: SOURCE_GROUP,
    decision: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    partition: "seen-source diagnostics",
    priorExposureConclusion: "seen",
    priorExposureBasis: ["prior-exposure.md"],
    implementationFamilyIndependence: "UNVERIFIED",
    relatedSourceGroups: [],
    authority: "Jenny",
    decidedAt: "2026-11-11T00:00:00.000Z",
    evidenceRefs: ["split-evidence.md"],
    conditions: ["model-training exposure remains UNVERIFIED"],
    ...overrides,
  };
}

function custodyRecord(splitDecisionRef, overrides = {}) {
  return {
    schema: "nnanything.b-a1.real-site-supervision.v1",
    recordId: "custody-rs-a-q1",
    sourceGroupId: SOURCE_GROUP,
    sampleId: SAMPLE_ID,
    goldStatus: "labeled_selected",
    goldValue: "node-136",
    labelAuthority: "independent gold custodian",
    oracleKind: "human review",
    evidenceRefs: ["observation.json"],
    reviewStatus: "approved",
    observationBinding: {
      sourceRun: "",
      documentRef: "doc-1",
      observationId: "obs-1",
      revision: 1,
      generation: 1,
      candidateRef: "node-136",
      scopeRef: "form#searchform",
      projectionPhase: PHASE,
      bindingRole: "search-input-host",
      sequenceRole: "q1-pre-input",
    },
    supportingActionEvidence: [],
    scoreBlind: true,
    approvedGold: true,
    machineAdmitted: true,
    approvalStatus: "approved",
    approvalEvidence: ["approval.md#rs-a-q1"],
    splitDecisionRef,
    ...overrides,
  };
}

async function packageScoringSelected(dir) {
  const W1 = new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  W1[0 * 64 + 35] = 1;
  const W2 = new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  W2[0 * 64 + 0] = 1;
  const W3 = new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  W3[0] = 1;
  const pkg = createUnifiedModelPackage({
    modelId: "b-a1-seen-source-diagnostic-fixture",
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

async function makeFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "b-a1-diagnostic-custody-"));
  const sourceRun = join(dir, "source-run");
  const splitDecisionPath = join(dir, "split-decision.json");
  const sourcePath = join(dir, "real-site-source.json");
  const custodyPath = join(dir, "real-site-supervision.jsonl");
  const controlPath = join(sourceRun, "control-scope-observations.jsonl");
  await mkdir(sourceRun, { recursive: true });

  const split = splitDecision();
  options.splitMutator?.(split);
  const source = sourceRecord(splitDecisionPath);
  options.sourceMutator?.(source);
  const custody = custodyRecord(splitDecisionPath);
  custody.observationBinding.sourceRun = sourceRun;
  options.custodyMutator?.(custody);
  const control = controlRecord();
  options.controlMutator?.(control);

  await writeFile(splitDecisionPath, `${JSON.stringify(split, null, 2)}\n`);
  await writeFile(sourcePath, `${JSON.stringify([source], null, 2)}\n`);
  await writeFile(custodyPath, `${JSON.stringify(custody)}\n`);
  await writeFile(controlPath, `${JSON.stringify(control)}\n`);

  const packageDir = join(dir, "package");
  const packagePath = options.skipPackage
    ? join(packageDir, "missing-package.json")
    : await packageScoringSelected(packageDir);
  const outputDir = join(dir, "out");
  const diagnosticGold = {
    kind: "bound",
    state: "selected",
    selectedRef: "node-136",
    family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    group: SOURCE_GROUP,
  };
  const descriptor = {
    sourceGroupId: SOURCE_GROUP,
    custodyRef: `${custodyPath}#recordId=custody-rs-a-q1`,
    sourceRef: `${sourcePath}#sourceGroupId=${SOURCE_GROUP}`,
    splitDecisionRef: splitDecisionPath,
    sourceRun,
    controlScopeRef: `${controlPath}#phase=${PHASE}`,
  };

  return {
    dir,
    sourceRun,
    sourcePath,
    custodyPath,
    splitDecisionPath,
    controlPath,
    packagePath,
    outputDir,
    split,
    source,
    custody,
    control,
    diagnosticGold,
    descriptor,
    observation: {
      identity: control.projectionIdentity,
      scopeRef: control.scopeRef,
      requestedRole: control.requestedRole,
      candidates: control.candidateFacts,
      outsideScopeRefs: control.outsideScopeRefs,
      coverage: control.coverage,
    },
  };
}

async function runFixture(fixture, overrides = {}) {
  return runBA1SeenSourceDiagnosticAccounting({
    packagePath: fixture.packagePath,
    diagnosticGold: fixture.diagnosticGold,
    sampleId: SAMPLE_ID,
    outputDir: fixture.outputDir,
    descriptor: fixture.descriptor,
    ...overrides,
  });
}

async function assertNoOutput(path) {
  await assert.rejects(readdir(path));
}

test("P1/P6/P7 matching custody derives the projection and persists diagnostic accounting", async () => {
  const fixture = await makeFixture();
  const request = {
    packagePath: fixture.packagePath,
    diagnosticGold: fixture.diagnosticGold,
    sampleId: SAMPLE_ID,
    outputDir: fixture.outputDir,
    descriptor: fixture.descriptor,
  };
  assert.equal(Object.hasOwn(request, "currentControl"), false);
  const result = await runFixture(fixture);

  assert.equal(result.schema, "nnanything.b-a1.seen-source-diagnostic-entry.v1");
  assert.equal(result.exposureLabel, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(result.modelTrainingExposure, "UNVERIFIED");
  assert.equal(result.sourceGroupId, SOURCE_GROUP);
  assert.equal(result.projection.allowedScopeRef, "form#searchform");
  assert.equal(result.projection.currentControl.documentRef, "doc-1");
  assert.equal(result.projection.candidates.length, 2);
  assert.equal(result.projection.output.kind, "bound");
  assert.equal(result.projection.output.state, "selected");
  assert.equal(result.projection.output.selectedRef, "node-136");
  assert.equal(result.evaluation.passed, true);
  assert.equal(result.evaluationRow.family, BA1_REAL_SITE_DIAGNOSTIC_FAMILY);
  assert.equal(result.evaluationRow.sampleKind, "model-semantic");
  assert.equal(result.evaluationRow.group, SOURCE_GROUP);
  assert.equal(result.evaluationRow.gold.selectedRef, "node-136");
  assert.equal(result.accounting.diagnosticRows, 1);
  assert.equal(result.accounting.heldOutRows, 0);
  assert.deepEqual(
    result.summary.denominators.map(({ family, total, passed, failed }) =>
      ({ family, total, passed, failed })),
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

  const files = (await readdir(fixture.outputDir)).sort();
  assert.deepEqual(files, [
    "seen-source-diagnostic-accounting.jsonl",
    "seen-source-diagnostic-summary.json",
  ]);
});

test("P2 diagnostic and held-out families remain separate denominators", async () => {
  const fixture = await makeFixture();
  const result = await runFixture(fixture);
  const heldOut = {
    ...result.evaluationRow,
    sampleId: "held-out-sample",
    family: BA1_REAL_SITE_FAMILY,
    group: "held-out-group",
    gold: {
      ...result.evaluationRow.gold,
      family: BA1_REAL_SITE_FAMILY,
      group: "held-out-group",
    },
  };
  const summary = summarizeBA1Evaluations([result.evaluationRow, heldOut]);
  assert.deepEqual(
    summary.denominators.map(({ family, total }) => ({ family, total })),
    [
      { family: BA1_REAL_SITE_FAMILY, total: 1 },
      { family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY, total: 1 },
    ],
  );
});

test("N1 the held-out first-result entry rejects diagnostic gold and writes no held-out row", async () => {
  const fixture = await makeFixture();
  const outputDir = join(fixture.dir, "held-out-reject");
  let controlReads = 0;
  await assert.rejects(
    runBA1RealSiteFirstResult({
      observation: fixture.observation,
      packagePath: fixture.packagePath,
      currentControl: () => {
        controlReads += 1;
        return {
          identity: fixture.control.operationControl.identity,
          generation: fixture.control.operationControl.generation,
        };
      },
      gold: fixture.diagnosticGold,
      sampleId: SAMPLE_ID,
      outputDir,
    }),
    /real-site gold\.family must be real-site-held-out/,
  );
  assert.equal(controlReads, 0);
  await assert.rejects(readFile(join(outputDir, "first-projection.json"), "utf8"));
  await assert.rejects(readFile(join(outputDir, "real-site-evaluation.jsonl"), "utf8"));
});

test("N2 a mismatched retained binding is rejected before package forward", async () => {
  const fixture = await makeFixture({
    skipPackage: true,
    controlMutator(control) {
      control.operationControl.generation = 2;
    },
  });
  await assert.rejects(
    runFixture(fixture),
    /control-scope generation does not match accepted custody binding/,
  );
  await assertNoOutput(fixture.outputDir);
});

test("N2 candidate-fact and coverage drift are rejected before package forward", async () => {
  const candidateDrift = await makeFixture({
    skipPackage: true,
    controlMutator(control) {
      control.candidateFacts[0].scopeRef = "other-scope";
    },
  });
  await assert.rejects(
    runFixture(candidateDrift),
    /candidate facts must match projectionIdentity and scopeRef/,
  );
  await assertNoOutput(candidateDrift.outputDir);

  const coverageDrift = await makeFixture({
    skipPackage: true,
    controlMutator(control) {
      control.coverage.observedCandidateCount = 1;
    },
  });
  await assert.rejects(
    runFixture(coverageDrift),
    /coverage must match scopeRef and candidateFacts/,
  );
  await assertNoOutput(coverageDrift.outputDir);
});

test("N2 custody snapshots for candidates, outside refs and coverage must match", async () => {
  const snapshotCases = [
    {
      mutate(custody) {
        custody.observationBinding.candidateFacts = [candidate("node-136")];
      },
      pattern: /candidateFacts do not match accepted custody snapshot/,
    },
    {
      mutate(custody) {
        custody.observationBinding.outsideScopeRefs = ["node-138"];
      },
      pattern: /outsideScopeRefs do not match accepted custody snapshot/,
    },
    {
      mutate(custody) {
        custody.observationBinding.coverage = {
          scopeRef: "form#searchform",
          observedCandidateCount: 2,
          unassessedIframeCount: 0,
          unassessedObjectCount: 0,
          unassessedOpenShadowRootCount: 1,
          excluded: [],
        };
      },
      pattern: /coverage does not match accepted custody snapshot/,
    },
  ];
  for (const entry of snapshotCases) {
    const fixture = await makeFixture({
      skipPackage: true,
      custodyMutator: entry.mutate,
    });
    await assert.rejects(runFixture(fixture), entry.pattern);
    await assertNoOutput(fixture.outputDir);
  }
});

test("N3 mismatched diagnostic gold is rejected before package forward", async () => {
  const fixture = await makeFixture({ skipPackage: true });
  await assert.rejects(
    runFixture(fixture, {
      diagnosticGold: {
        ...fixture.diagnosticGold,
        selectedRef: "node-other",
      },
    }),
    /selectedRef must equal accepted custody goldValue/,
  );
  await assertNoOutput(fixture.outputDir);

  await assert.rejects(
    runFixture(fixture, {
      diagnosticGold: {
        ...fixture.diagnosticGold,
        group: "other-group",
      },
    }),
    /group must equal descriptor\.sourceGroupId/,
  );
  await assertNoOutput(fixture.outputDir);

  await assert.rejects(
    runFixture(fixture, {
      diagnosticGold: {
        ...fixture.diagnosticGold,
        state: "none",
      },
    }),
    /bound none gold must not carry a selectedRef|must be bound selected/,
  );
  await assertNoOutput(fixture.outputDir);
});

test("N4 unapproved custody states are rejected before package forward", async () => {
  const cases = [
    {
      name: "pending",
      mutate(custody) {
        custody.reviewStatus = "pending";
      },
      pattern: /reviewStatus must be approved/,
    },
    {
      name: "rejected",
      mutate(custody) {
        custody.reviewStatus = "rejected";
      },
      pattern: /reviewStatus must be approved/,
    },
    {
      name: "conflicting",
      mutate(custody) {
        custody.reviewStatus = "conflicting";
      },
      pattern: /reviewStatus must be approved/,
    },
    {
      name: "absent",
      mutate(custody) {
        delete custody.reviewStatus;
      },
      pattern: /reviewStatus must be approved/,
    },
    {
      name: "false",
      mutate(custody) {
        custody.approvedGold = false;
      },
      pattern: /approvedGold must be true/,
    },
    {
      name: "approval-status-absent",
      mutate(custody) {
        custody.approvalStatus = null;
      },
      pattern: /approvalStatus must be approved/,
    },
    {
      name: "approval-evidence-empty",
      mutate(custody) {
        custody.approvalEvidence = [];
      },
      pattern: /approvalEvidence must be non-empty/,
    },
  ];
  for (const entry of cases) {
    const fixture = await makeFixture({
      skipPackage: true,
      custodyMutator: entry.mutate,
    });
    await assert.rejects(runFixture(fixture), entry.pattern);
    await assertNoOutput(fixture.outputDir);
  }
});

test("N5 caller authority fields and live-control callbacks are rejected", async () => {
  const fixture = await makeFixture({ skipPackage: true });
  await assert.rejects(
    runFixture(fixture, {
      descriptor: {
        ...fixture.descriptor,
        exposureLabel: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
        reviewStatus: "approved",
      },
    }),
    /descriptor must contain exactly/,
  );
  await assertNoOutput(fixture.outputDir);

  await assert.rejects(
    runFixture(fixture, {
      currentControl: () => {
        throw new Error("live control must not be read");
      },
    }),
    /request must contain exactly/,
  );
  await assertNoOutput(fixture.outputDir);
});

test("N7 unknown or unseen split classifications are unadmitted without output", async () => {
  for (const decision of ["unknown", "candidate-unseen", "real-site-held-out"]) {
    const fixture = await makeFixture({
      skipPackage: true,
      splitMutator(split) {
        split.decision = decision;
      },
    });
    await assert.rejects(
      runFixture(fixture),
      /split decision is not admitted/,
    );
    await assertNoOutput(fixture.outputDir);
  }
});

test("offline entry resolves sourceRun control refs and never creates held-out artifacts", async () => {
  const fixture = await makeFixture();
  const result = await runFixture(fixture);
  assert.equal(fixture.descriptor.sourceRun, fixture.custody.observationBinding.sourceRun);
  assert.ok(
    fixture.descriptor.controlScopeRef.startsWith(
      `${fixture.sourceRun}/control-scope-observations.jsonl#phase=`,
    ),
  );
  assert.equal(result.accounting.heldOutRows, 0);
  const files = await readdir(fixture.outputDir);
  assert.equal(files.includes("real-site-evaluation.jsonl"), false);
  assert.equal(files.includes("summary.json"), false);
});

test("accepted #id custody refs and plain source refs resolve deterministically", async () => {
  const fixture = await makeFixture();
  const result = await runFixture(fixture, {
    descriptor: {
      ...fixture.descriptor,
      custodyRef: `${fixture.custodyPath}#id=custody-rs-a-q1`,
      sourceRef: fixture.sourcePath,
    },
  });
  assert.equal(result.evaluation.passed, true);
  assert.equal(result.evaluationRow.group, SOURCE_GROUP);
});
