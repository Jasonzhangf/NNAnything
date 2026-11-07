import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const here = new URL(".", import.meta.url);
const worktreeRoot = resolve(here.pathname, "..");
const adapterPath = resolve(worktreeRoot, "scripts/generate-four-mappings-corpus.mjs");
// P1-1: the reviewed milestone names scripts/stage-stepwise-converter-corpus.mjs
// as the final mechanical join adapter for Carol's fixed-stepwise corpus. Its
// keyed bilateral join is therefore exercised directly, in addition to the
// generator that produced the accepted gcm-gap1-03 ready-slice.
const stagingAdapterPath = resolve(worktreeRoot, "scripts/stage-stepwise-converter-corpus.mjs");
const runnerPath = resolve(worktreeRoot, "dist/training/l2-standard-runner.js");
const fixtureRoot = resolve(here.pathname, "fixtures/unified-64-slot");
const thresholdsPath = join(fixtureRoot, "feature-thresholds-r-unified-step-encoder-v1.json");
const missingModeTablePath = join(fixtureRoot, "missing-mode-table.json");

const EDGE_REF = "edge:sources/src/entry.ts:import:0";
const PENDING_REF = "pending:sample-a";
const EVIDENCE_REF = "ev:sources/src/entry.ts:import:0";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function studentRecord(overrides = {}) {
  return {
    schemaVersion: "carol-tsjs-fixed-stepwise-student-v1",
    sampleId: "sample-a",
    family: "train-family-a",
    sourceGroup: "group-a",
    partition: "train",
    language: "ts",
    semanticStratum: "module_export",
    entryFile: "sources/src/entry.ts",
    request: {
      requestRef: "request:sample-a",
      requestedDeclaration: {
        declarationRef: "decl:sources/src/impl.ts#top:helper",
        moduleRef: "mod:sources/src/impl.ts",
        name: "helper",
        kind: "function",
        sourceTargetRef: "sources/src/impl.ts#top:helper",
      },
      relationObligation: {
        pendingRelationRef: PENDING_REF,
        callSiteRef: "call:sources/src/entry.ts:helper",
        calleeName: "helper",
      },
    },
    steps: [{
      stepId: "step-0",
      observedAt: "current-step",
      localSyntax: {
        observedBindings: [{
          edgeRef: EDGE_REF,
          callSiteRef: null,
          fromNodeRef: `syntax:${EDGE_REF}`,
          edgeKind: "import",
          sourceName: "helper",
          sourceModule: {
            state: "known",
            value: "mod:sources/src/util.ts",
            reason: null,
            evidenceRefs: [EVIDENCE_REF],
          },
          targetName: "helper",
          targetModule: {
            state: "known",
            value: "mod:sources/src/entry.ts",
            reason: null,
            evidenceRefs: [EVIDENCE_REF],
          },
          moduleSpecifierRaw: "./util",
          sourceContent: {
            state: "not_requested",
            resultRefs: [],
            reason: null,
            evidenceRefs: [EVIDENCE_REF],
          },
          visibility: {
            state: "known",
            value: "reachable",
            reason: null,
            evidenceRefs: [EVIDENCE_REF],
          },
          hopDepth: 0,
          evidenceRefs: [EVIDENCE_REF],
        }],
        observedDeclarations: [],
        moduleSpecifierRaw: "./util",
        sourceContent: {
          state: "not_requested",
          resultRefs: [],
          reason: null,
          evidenceRefs: [EVIDENCE_REF],
        },
        shadowFacts: [],
      },
      currentRelation: {
        pendingRelationRef: PENDING_REF,
        callSiteRef: "call:sources/src/entry.ts:helper",
        binding: {
          state: "known",
          value: {
            symbolRef: `symbol:${EDGE_REF}`,
            callSiteRef: "call:sources/src/entry.ts:helper",
            role: "import",
            bindingMode: "unbound",
            resolution: {
              status: "unresolved",
              reason: "not_requested",
              evidenceRefs: [EVIDENCE_REF],
            },
            declarationRefs: [],
            scopeRef: null,
            evidenceRefs: [EVIDENCE_REF],
          },
          evidenceRefs: [EVIDENCE_REF],
        },
      },
      remainingObligations: [{
        kind: "advance",
        ref: EDGE_REF,
        pendingRelationRef: PENDING_REF,
        skillRef: "skill:relation.read",
        arguments: [{ name: "target", type: "binding_edge", valueRef: EDGE_REF }],
        informationGain: {
          state: "known",
          value: "advances_chain",
          evidenceRefs: [EVIDENCE_REF],
        },
        informationGainExplanation: "",
        evidenceRefs: [EVIDENCE_REF],
      }],
      legalCandidates: [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        `c:advance:${EDGE_REF}`,
        "c:defer",
      ],
      previousExecution: {
        state: "known",
        value: {
          actionRef: "action:sample-a:step0",
          receiptRef: "receipt:sample-a:step0",
          origin: "source_observation",
          fromStepId: null,
          pendingRelationRef: PENDING_REF,
          optionSemantics: "observe",
          targetRef: "mod:sources/src/entry.ts",
          outcome: "success",
        },
        evidenceRefs: [EVIDENCE_REF],
      },
      receipts: [{
        receiptId: "receipt:sample-a:step0",
        action: "action:sample-a:step0",
        origin: "source_observation",
        target: "mod:sources/src/entry.ts",
        fromStepId: null,
        pendingRelationRef: PENDING_REF,
        optionSemantics: "observe",
        outcome: "success",
        result: { bindingEdge: EDGE_REF },
        evidenceRefs: [EVIDENCE_REF],
      }],
      localCandidateCursor: {
        pendingRelationRef: PENDING_REF,
        state: "closed",
        evidenceRefs: [EVIDENCE_REF],
      },
      coverage: null,
      notReady: false,
    }],
    ...overrides,
  };
}

function supervisionRecord(overrides = {}) {
  return {
    schemaVersion: "carol-tsjs-fixed-stepwise-supervision-v1",
    sampleId: "sample-a",
    family: "train-family-a",
    requestRef: "request:sample-a",
    gold: {
      label: "true",
      allowedEquivalentLabels: ["true"],
      labelAuthority: "researcher_structural_proof+typescript_language_service",
      oracleKind: "independent_tsc+typescript_compiler_api",
      unknownReason: null,
      originalLabel: null,
      originalUnknownReason: null,
      goldAction: "c:judge:true",
      candidateSet: ["c:judge:true"],
      admission: "superseded",
      supersededBy: "evidence/manual-structural-proof.md",
      teacherEvidence: null,
    },
    steps: [{
      stepId: "step-0",
      S_g: [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        `c:advance:${EDGE_REF}`,
        "c:defer",
      ],
      A_g: [`c:advance:${EDGE_REF}`],
      agSubsetOfSg: true,
      labelAuthority: "researcher_structural_proof+typescript_language_service",
      oracleKind: "independent_tsc+typescript_compiler_api",
      unknownReason: null,
    }],
    trainingEligible: true,
    notReadyReason: null,
    originalExpected: {
      label: "true",
      originalLabel: null,
      originalUnknownReason: null,
      labelMissing: false,
      executionReceiptRef: null,
    },
    terminalDeclarationRef: "decl:sources/src/impl.ts#top:helper",
    conflicts: [],
    joinFailures: [],
    ...overrides,
  };
}

function observed(value, state = "known", reason = null) {
  return {
    state,
    value,
    reason,
    evidenceRefs: [`ev:${state}:${value ?? "missing"}`],
  };
}

async function makeFixture(students, supervisionRows) {
  const root = await mkdtemp(join(tmpdir(), "unified-gap1-staging-"));
  const studentPath = join(root, "student-observations.jsonl");
  const supervisionPath = join(root, "independent-supervision.jsonl");
  const out = join(root, "corpus");
  await writeJsonl(studentPath, students);
  await writeJsonl(supervisionPath, supervisionRows);
  return { root, studentPath, supervisionPath, out };
}

function runAdapter(fixture) {
  return spawnSync(
    process.execPath,
    [
      adapterPath,
      fixture.out,
      "--student",
      fixture.studentPath,
      "--supervision",
      fixture.supervisionPath,
      "--out",
      fixture.out,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}

function assertAdapterFailed(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function stepRecord(overrides = {}) {
  const step = clone(studentRecord().steps[0]);
  return { ...step, ...overrides };
}

async function makeStagingFixture(students, supervision) {
  const root = await mkdtemp(join(tmpdir(), "unified-gap1-stage-script-"));
  const studentPath = join(root, "student-observations.jsonl");
  const supervisionPath = join(root, "independent-supervision.jsonl");
  const sourceRoot = join(root, "source-corpus");
  const stagingOut = join(root, "staged");
  await writeJsonl(studentPath, students);
  await writeJsonl(supervisionPath, supervision);
  await writeJson(join(sourceRoot, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "group-a",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  const samples = new Map();
  for (const student of students) {
    samples.set(student.sampleId, {
      sampleId: student.sampleId,
      sourceGroup: student.sourceGroup,
      entryFile: student.entryFile,
    });
  }
  for (const sample of supervision) {
    if (!samples.has(sample.sampleId)) {
      samples.set(sample.sampleId, {
        sampleId: sample.sampleId,
        sourceGroup: "group-a",
        entryFile: "sources/src/entry.ts",
      });
    }
  }
  const familyDir = join(sourceRoot, "train-family-a");
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "group-a",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    derivationFamily: { familyId: "train-family-a" },
  });
  for (const sample of samples.values()) {
    await writeJsonl(join(familyDir, `episode-${sample.sampleId}.jsonl`), [sample]);
  }
  return { root, studentPath, supervisionPath, sourceRoot, stagingOut };
}

function runStagingAdapter(fixture) {
  return spawnSync(
    process.execPath,
    [
      stagingAdapterPath,
      "--student",
      fixture.studentPath,
      "--supervision",
      fixture.supervisionPath,
      "--source-corpus-root",
      fixture.sourceRoot,
      "--out",
      fixture.stagingOut,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}

test("final staging adapter rejects a student without supervision", async () => {
  const orphan = studentRecord({ sampleId: "sample-b" });
  const fixture = await makeStagingFixture(
    [studentRecord(), orphan],
    [supervisionRecord()],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(fixture),
      /student row without supervision: train-family-a\/sample-b/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("final staging adapter rejects duplicate student and supervision rows", async () => {
  const duplicateStudent = await makeStagingFixture(
    [studentRecord(), studentRecord()],
    [supervisionRecord()],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(duplicateStudent),
      /duplicate student row for family train-family-a sample sample-a/,
    );
  } finally {
    await rm(duplicateStudent.root, { recursive: true, force: true });
  }

  const duplicateSupervision = await makeStagingFixture(
    [studentRecord()],
    [supervisionRecord(), supervisionRecord()],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(duplicateSupervision),
      /duplicate supervision row for family train-family-a sample sample-a/,
    );
  } finally {
    await rm(duplicateSupervision.root, { recursive: true, force: true });
  }
});

test("final staging adapter rejects request, source and step join mismatches", async () => {
  const requestMismatch = await makeStagingFixture(
    [studentRecord()],
    [supervisionRecord({ requestRef: "request:other-sample" })],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(requestMismatch),
      /requestRef mismatch for train-family-a\/sample-a/,
    );
  } finally {
    await rm(requestMismatch.root, { recursive: true, force: true });
  }

  const sourceMismatch = await makeStagingFixture(
    [studentRecord()],
    [supervisionRecord({ sourceGroup: "group-b" })],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(sourceMismatch),
      /sourceGroup mismatch for train-family-a\/sample-a/,
    );
  } finally {
    await rm(sourceMismatch.root, { recursive: true, force: true });
  }

  const extraStudentStep = studentRecord();
  extraStudentStep.steps.push(stepRecord({ stepId: "step-1" }));
  const stepMismatch = await makeStagingFixture([extraStudentStep], [supervisionRecord()]);
  try {
    assertAdapterFailed(
      runStagingAdapter(stepMismatch),
      /step mismatch for train-family-a\/sample-a/,
    );
  } finally {
    await rm(stepMismatch.root, { recursive: true, force: true });
  }

  const missingSupervisionStep = supervisionRecord();
  missingSupervisionStep.steps.push(clone(missingSupervisionStep.steps[0]));
  missingSupervisionStep.steps[1].stepId = "step-1";
  const missingStep = await makeStagingFixture([studentRecord()], [missingSupervisionStep]);
  try {
    assertAdapterFailed(
      runStagingAdapter(missingStep),
      /missing supervision step train-family-a\/sample-a\/step-1/,
    );
  } finally {
    await rm(missingStep.root, { recursive: true, force: true });
  }
});

test("final staging adapter stages a bilateral join without recomputation", async () => {
  const student = studentRecord();
  const supervision = supervisionRecord();
  const fixture = await makeStagingFixture([student], [supervision]);
  try {
    const result = runStagingAdapter(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stagedStudent = (await readJsonl(
      join(fixture.stagingOut, student.family, "student-observations.jsonl"),
    ))[0];
    const stagedSupervision = (await readJsonl(
      join(fixture.stagingOut, student.family, "independent-supervision.jsonl"),
    ))[0];
    assert.equal(stagedStudent.entryFile, student.entryFile);
    assert.equal(stagedStudent.schemaVersion, student.schemaVersion);
    assert.deepEqual(stagedSupervision, supervision);
    assert.deepEqual(stagedSupervision.steps[0].S_g, supervision.steps[0].S_g);
    assert.deepEqual(stagedSupervision.steps[0].A_g, supervision.steps[0].A_g);
    assert.equal(stagedSupervision.trainingEligible, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("generator join rejects a student without and a supervision without a peer", async () => {
  const orphanStudent = studentRecord({ sampleId: "sample-b" });
  const studentWithoutSupervision = await makeFixture(
    [studentRecord(), orphanStudent],
    [supervisionRecord()],
  );
  try {
    assertAdapterFailed(
      runAdapter(studentWithoutSupervision),
      /missing supervision sample train-family-a\/sample-b/,
    );
  } finally {
    await rm(studentWithoutSupervision.root, { recursive: true, force: true });
  }

  const orphanSupervision = supervisionRecord({ sampleId: "sample-b" });
  const supervisionWithoutStudent = await makeFixture(
    [studentRecord()],
    [supervisionRecord(), orphanSupervision],
  );
  try {
    assertAdapterFailed(
      runAdapter(supervisionWithoutStudent),
      /missing student sample train-family-a\/sample-b/,
    );
  } finally {
    await rm(supervisionWithoutStudent.root, { recursive: true, force: true });
  }
});

test("independent supervision values survive staging unchanged", async () => {
  const student = studentRecord();
  const supervision = supervisionRecord();
  const fixture = await makeFixture([student], [supervision]);
  try {
    const result = runAdapter(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const fullFamily = join(fixture.out, student.family);
    const stagedStudent = (await readJsonl(
      join(fullFamily, "student-observations.jsonl"),
    ))[0];
    const stagedSupervision = (await readJsonl(
      join(fullFamily, "independent-supervision.jsonl"),
    ))[0];

    assert.equal(stagedStudent.schemaVersion, "emma-tsjs-student-observation-v2");
    assert.deepEqual(stagedStudent.steps[0].legalCandidates, student.steps[0].legalCandidates);
    assert.deepEqual(stagedStudent.steps[0].S_g, supervision.steps[0].S_g);
    assert.deepEqual(
      { ...stagedSupervision, schemaVersion: supervision.schemaVersion },
      supervision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("join rejects supervision request and source identity mismatches", async () => {
  const requestStudent = studentRecord();
  const requestSupervision = supervisionRecord({ requestRef: "request:other-sample" });
  const requestMismatch = await makeFixture([requestStudent], [requestSupervision]);
  try {
    assertAdapterFailed(
      runAdapter(requestMismatch),
      /requestRef mismatch for train-family-a\/sample-a/,
    );
  } finally {
    await rm(requestMismatch.root, { recursive: true, force: true });
  }

  const sourceStudent = studentRecord();
  const sourceSupervision = supervisionRecord({ sourceGroup: "group-b" });
  const sourceMismatch = await makeFixture([sourceStudent], [sourceSupervision]);
  try {
    assertAdapterFailed(
      runAdapter(sourceMismatch),
      /sourceGroup mismatch for train-family-a\/sample-a/,
    );
  } finally {
    await rm(sourceMismatch.root, { recursive: true, force: true });
  }
});

test("join admits cross-source sample ids and rejects malformed step joins", async () => {
  const crossGroupStudentA = studentRecord();
  const crossGroupStudentB = studentRecord({
    family: "train-family-b",
    sourceGroup: "group-b",
  });
  const crossGroupSupervisionA = supervisionRecord();
  const crossGroupSupervisionB = supervisionRecord({ family: "train-family-b" });
  const crossGroup = await makeFixture(
    [crossGroupStudentA, crossGroupStudentB],
    [crossGroupSupervisionA, crossGroupSupervisionB],
  );
  try {
    const result = runAdapter(crossGroup);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const admissions = JSON.parse(await readFile(
      join(crossGroup.out, "ready-slice", "corpus-admissions-v1.json"),
      "utf8",
    ));
    assert.deepEqual(
      admissions.familyAdmissions.map(entry => entry.sourceGroup),
      ["group-a", "group-b"],
    );
  } finally {
    await rm(crossGroup.root, { recursive: true, force: true });
  }

  const missingStepStudent = studentRecord();
  const extraStep = clone(missingStepStudent.steps[0]);
  extraStep.stepId = "step-1";
  missingStepStudent.steps.push(extraStep);
  const missingStep = await makeFixture([missingStepStudent], [supervisionRecord()]);
  try {
    assertAdapterFailed(runAdapter(missingStep), /missing supervision step sample-a\/step-1/);
  } finally {
    await rm(missingStep.root, { recursive: true, force: true });
  }

  const duplicateSupervision = supervisionRecord();
  duplicateSupervision.steps.push(clone(duplicateSupervision.steps[0]));
  const duplicate = await makeFixture([studentRecord()], [duplicateSupervision]);
  try {
    assertAdapterFailed(runAdapter(duplicate), /duplicate supervision step sample-a\/step-0/);
  } finally {
    await rm(duplicate.root, { recursive: true, force: true });
  }
});

test("source supervision perturbation reaches public consumption as explicit not-ready", async () => {
  const student = studentRecord();
  const supervision = supervisionRecord();
  supervision.steps[0].S_g = ["c:judge:true"];
  supervision.steps[0].A_g = ["c:judge:true"];
  const fixture = await makeFixture([student], [supervision]);
  try {
    const adapterResult = runAdapter(fixture);
    assert.equal(adapterResult.status, 0, adapterResult.stdout + adapterResult.stderr);
    const stagedStudent = (await readJsonl(
      join(fixture.out, student.family, "student-observations.jsonl"),
    ))[0];
    assert.deepEqual(stagedStudent.steps[0].S_g, ["c:judge:true"]);

    const publicOut = join(fixture.root, "public");
    const configPath = join(fixture.root, "convert-samples.config.json");
    await writeJson(configPath, {
      schema: "nnanything.unified.runner-config.v1",
      command: "convert-samples",
      route: { domain: "tsjs", decisionKind: "R" },
      phase: "sample_migration",
      encoderVersion: "nnanything.unified-step.encoder.v1",
      dataGate: {
        schema: "nnanything.unified.data-gate.v1",
        partition: "TRAIN",
        encoderVersion: "nnanything.unified-step.encoder.v1",
        thresholdsPath,
        rowsPath: join(publicOut, "data-rows.jsonl"),
      },
      outputDir: publicOut,
      corpus: {
        root: join(fixture.out, "ready-slice"),
        admissionsPath: join(fixture.out, "ready-slice", "corpus-admissions-v1.json"),
        studentRowsPath: join(publicOut, "student-rows", "student-rows.jsonl"),
        supervisionRowsPath: join(publicOut, "labels", "supervision.jsonl"),
        packagePath: join(publicOut, "package.json"),
        missingModeTablePath,
      },
    });

    const result = spawnSync(
      process.execPath,
      [runnerPath, "convert-samples", "--config", configPath],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(
      await readFile(join(publicOut, "run-report.json"), "utf8"),
    );
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /S_g mismatch/);
    assert.match(report.error.message, /c:judge:true/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("known requestedDeclaration observed fields unwrap to emma scalar values", async () => {
  const student = studentRecord();
  const declaration = student.request.requestedDeclaration;
  student.request.requestedDeclaration = {
    declarationRef: observed(declaration.declarationRef),
    moduleRef: observed(declaration.moduleRef),
    name: observed(declaration.name),
    kind: observed(declaration.kind),
    sourceTargetRef: declaration.sourceTargetRef,
  };
  const supervision = supervisionRecord();
  supervision.steps[0].S_g = ["c:judge:true"];
  supervision.steps[0].A_g = ["c:judge:true"];
  const fixture = await makeFixture([student], [supervision]);
  try {
    const result = runAdapter(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const stagedStudent = (await readJsonl(
      join(fixture.out, student.family, "student-observations.jsonl"),
    ))[0];
    assert.deepEqual(
      stagedStudent.request.requestedDeclaration,
      declaration,
    );
    assert.deepEqual(stagedStudent.steps[0].legalCandidates, student.steps[0].legalCandidates);
    assert.deepEqual(stagedStudent.steps[0].S_g, supervision.steps[0].S_g);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("non-known requestedDeclaration fields stay explicit instead of defaulting", async () => {
  const student = studentRecord();
  student.request.requestedDeclaration.declarationRef = {
    state: "missing",
    reason: "observation_failed",
    evidenceRefs: ["ev:requested:missing"],
  };
  const fixture = await makeFixture([student], [supervisionRecord()]);
  try {
    const result = runAdapter(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const stagedStudent = (await readJsonl(
      join(fixture.out, student.family, "student-observations.jsonl"),
    ))[0];
    assert.deepEqual(
      stagedStudent.request.requestedDeclaration.declarationRef,
      student.request.requestedDeclaration.declarationRef,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("carol receipt and cursor shapes stay explicit after converter schema mapping", async () => {
  const student = studentRecord();
  const actionRef = "action:sample-a:step0";
  const receiptRef = "receipt:sample-a:step0";
  student.steps[0].previousExecution = {
    state: "known",
    value: {
      actionRef,
      receiptRef,
      origin: "source_observation",
      fromStepId: null,
      pendingRelationRef: PENDING_REF,
      optionSemantics: "observe",
      targetRef: "mod:sources/src/entry.ts",
      outcome: "success",
    },
    evidenceRefs: [EVIDENCE_REF],
  };
  student.steps[0].receipts = [{
    receiptRef,
    actionRef,
    action: "read_source",
    origin: "source_observation",
    targetRef: "mod:sources/src/entry.ts",
    fromStepId: null,
    pendingRelationRef: PENDING_REF,
    resultRefs: [EVIDENCE_REF],
    outcome: "success",
    evidenceRefs: [EVIDENCE_REF],
  }];
  student.steps[0].localCandidateCursor = {
    state: "closed",
    evidenceRefs: [EVIDENCE_REF],
  };
  const fixture = await makeFixture([student], [supervisionRecord()]);
  try {
    const result = runAdapter(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const stagedStudent = (await readJsonl(
      join(fixture.out, student.family, "student-observations.jsonl"),
    ))[0];
    assert.equal(stagedStudent.steps[0].receipts[0].receiptId, receiptRef);
    assert.equal(stagedStudent.steps[0].receipts[0].action, actionRef);
    assert.equal(stagedStudent.steps[0].receipts[0].target, "mod:sources/src/entry.ts");
    assert.deepEqual(
      stagedStudent.steps[0].receipts[0].result.resultRefs,
      [EVIDENCE_REF],
    );
    assert.equal(
      stagedStudent.steps[0].localCandidateCursor.pendingRelationRef,
      PENDING_REF,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
