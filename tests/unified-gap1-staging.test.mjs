import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const here = new URL(".", import.meta.url);
const worktreeRoot = resolve(here.pathname, "..");
// P1-1: the reviewed milestone names scripts/stage-stepwise-converter-corpus.mjs
// as the final mechanical join adapter for Carol's fixed-stepwise corpus. The
// corpus itself is owned by Carol's accepted fixed-stepwise generator
// (playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs),
// so these tests build controlled student/supervision fixtures and exercise
// the committed adapter's keyed bilateral join directly.
const stagingAdapterPath = resolve(worktreeRoot, "scripts/stage-stepwise-converter-corpus.mjs");

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
  const fixtureFamilies = new Map();
  for (const student of students) {
    fixtureFamilies.set(student.family, student.sourceGroup ?? "group-a");
  }
  for (const sample of supervision) {
    if (!fixtureFamilies.has(sample.family)) {
      fixtureFamilies.set(sample.family, sample.sourceGroup ?? "group-a");
    }
  }
  await writeJson(join(sourceRoot, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [...fixtureFamilies].map(([family, sourceGroup]) => ({
      family,
      sourceGroup,
      partition: "train",
      usableForTrainingSupervision: true,
    })),
  });
  const families = new Map();
  for (const student of students) {
    families.set(student.family, {
      family: student.family,
      sourceGroup: student.sourceGroup ?? "group-a",
    });
  }
  for (const sample of supervision) {
    if (!families.has(sample.family)) {
      families.set(sample.family, {
        family: sample.family,
        sourceGroup: sample.sourceGroup ?? "group-a",
      });
    }
  }
  const samples = new Map();
  for (const student of students) {
    samples.set(`${student.family}\u0000${student.sampleId}`, {
      sampleId: student.sampleId,
      family: student.family,
      sourceGroup: student.sourceGroup ?? "group-a",
      entryFile: student.entryFile ?? "sources/src/entry.ts",
    });
  }
  for (const sample of supervision) {
    const key = `${sample.family}\u0000${sample.sampleId}`;
    if (!samples.has(key)) {
      samples.set(key, {
        sampleId: sample.sampleId,
        family: sample.family,
        sourceGroup: sample.sourceGroup ?? families.get(sample.family)?.sourceGroup ?? "group-a",
        entryFile: "sources/src/entry.ts",
      });
    }
  }
  for (const family of families.values()) {
    const familyDir = join(sourceRoot, family.family);
    await writeJson(join(familyDir, "manifest.json"), {
      schemaVersion: "neural-cli-source-family-v1",
      sourceGroup: family.sourceGroup,
      language: "ts",
      semanticStratum: "module_export",
      partition: "train",
      derivationFamily: { familyId: family.family },
    });
  }
  for (const sample of samples.values()) {
    await writeJsonl(
      join(sourceRoot, sample.family, `episode-${sample.sampleId}.jsonl`),
      [sample],
    );
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

test("final staging adapter rejects a supervision without student", async () => {
  const orphanSupervision = supervisionRecord({ sampleId: "sample-b" });
  const fixture = await makeStagingFixture(
    [studentRecord()],
    [supervisionRecord(), orphanSupervision],
  );
  try {
    assertAdapterFailed(
      runStagingAdapter(fixture),
      /missing student row for family train-family-a sample sample-b/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("final staging adapter stages cross-source sample ids independently", async () => {
  const crossGroupStudentA = studentRecord();
  const crossGroupStudentB = studentRecord({
    family: "train-family-b",
    sourceGroup: "group-b",
  });
  const crossGroupSupervisionA = supervisionRecord();
  const crossGroupSupervisionB = supervisionRecord({ family: "train-family-b" });
  const crossGroup = await makeStagingFixture(
    [crossGroupStudentA, crossGroupStudentB],
    [crossGroupSupervisionA, crossGroupSupervisionB],
  );
  try {
    const result = runStagingAdapter(crossGroup);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stagedStudentA = (await readJsonl(
      join(crossGroup.stagingOut, "train-family-a", "student-observations.jsonl"),
    ))[0];
    const stagedStudentB = (await readJsonl(
      join(crossGroup.stagingOut, "train-family-b", "student-observations.jsonl"),
    ))[0];
    assert.equal(stagedStudentA.sampleId, "sample-a");
    assert.equal(stagedStudentB.sampleId, "sample-a");
    assert.equal(stagedStudentA.family, "train-family-a");
    assert.equal(stagedStudentB.family, "train-family-b");
    assert.equal(stagedStudentA.sourceGroup, "group-a");
    assert.equal(stagedStudentB.sourceGroup, "group-b");
  } finally {
    await rm(crossGroup.root, { recursive: true, force: true });
  }
});
