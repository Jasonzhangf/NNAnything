import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SUPERVISION_SOURCE,
  DEFAULT_TYPED_REQUEST_SOURCE,
  generateFixedStepwise,
} from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";

const RUN_ROOT = "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031";
const CORPUS_ROOT = path.join(
  RUN_ROOT,
  ".worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/corpus",
);

function readJsonl(file) {
  return readFile(file, "utf8").then((text) =>
    text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );
}

async function makeOutputDir() {
  const root = await mkdtemp(path.join(tmpdir(), "carol-r2-stepwise-"));
  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });
  return outDir;
}

function rowBySample(rows, sampleId) {
  const row = rows.find((item) => item.sampleId === sampleId);
  assert.ok(row, `missing ${sampleId}`);
  return row;
}

function stepByIndex(row, index) {
  return row.steps.find((step) => step.stepId === `step-${index}`);
}

function bindingRefs(row, stepIndex) {
  return stepByIndex(row, stepIndex).localSyntax.observedBindings.map((edge) => edge.edgeRef);
}

test("generates fixed local-step corpus without future alias leakage", async () => {
  const outDir = await makeOutputDir();
  await generateFixedStepwise({ corpusRoot: CORPUS_ROOT, outDir });

  const students = await readJsonl(path.join(outDir, "student-observations.jsonl"));
  const supervision = await readJsonl(path.join(outDir, "independent-supervision.jsonl"));
  assert.equal(students.length, 10);
  assert.equal(supervision.length, 10);

  const alias = rowBySample(students, "a-module-positive-alias");
  assert.deepEqual(bindingRefs(alias, 0), ["edge:sources/src/entry-pos.ts:import:0"]);
  assert.deepEqual(bindingRefs(alias, 1), [
    "edge:sources/src/entry-pos.ts:import:0",
    "edge:sources/src/util.ts:reexport:0",
  ]);
  assert.deepEqual(bindingRefs(alias, 2), [
    "edge:sources/src/entry-pos.ts:import:0",
    "edge:sources/src/util.ts:reexport:0",
  ]);

  const step0 = stepByIndex(alias, 0);
  const step1 = stepByIndex(alias, 1);
  const step2 = stepByIndex(alias, 2);
  assert.equal(alias.request.requestRef, "request:a-module-positive-alias");
  assert.deepEqual(alias.request.requestedDeclaration.declarationRef, {
    state: "known",
    value: "decl:sources/src/impl.ts#top:helper",
    reason: null,
    evidenceRefs: [],
  });
  assert.deepEqual(alias.request.requestedDeclaration.moduleRef, {
    state: "known",
    value: "mod:sources/src/impl.ts",
    reason: null,
    evidenceRefs: [],
  });
  assert.deepEqual(alias.request.requestedDeclaration.name, {
    state: "known",
    value: "helper",
    reason: null,
    evidenceRefs: [],
  });
  assert.deepEqual(alias.request.requestedDeclaration.kind, {
    state: "known",
    value: "function",
    reason: null,
    evidenceRefs: [],
  });
  assert.equal(alias.request.relationObligation.pendingRelationRef, "pending:a-module-positive-alias");
  assert.equal(
    alias.request.relationObligation.callSiteRef,
    "call:sources/src/entry-pos.ts:helper",
  );
  assert.equal(step0.receipts[0].outcome, "success");
  assert.equal(step0.localSyntax.observedDeclarations.length, 0);
  assert.equal(step1.localSyntax.observedDeclarations.length, 0);
  assert.deepEqual(
    step2.localSyntax.observedDeclarations.map((declaration) => declaration.declarationRef),
    ["decl:sources/src/impl.ts#top:helper"],
  );
  assert.equal(step0.previousExecution.state, "known");
  assert.equal(step0.previousExecution.value.origin, "source_observation");
  assert.equal(step0.previousExecution.value.fromStepId, null);
  assert.equal(step1.previousExecution.value.fromStepId, "step-0");
  assert.equal(step1.previousExecution.value.optionSemantics, "advance");
  assert.equal(
    step1.remainingObligations.find((item) => item.kind === "advance").informationGain.state,
    "known",
  );
  assert.equal(
    step1.remainingObligations.find((item) => item.kind === "advance").informationGain.value,
    "advances_chain",
  );
  assert.equal(step1.legalCandidates.includes("c:advance:edge:sources/src/entry-pos.ts:import:0"), false);
  assert.equal(step1.legalCandidates.includes("c:advance:edge:sources/src/util.ts:reexport:0"), true);
  assert.equal(step2.legalCandidates.includes("c:return"), true);

  const other = rowBySample(students, "b-closure-negative-other-module");
  const otherStep = stepByIndex(other, 0);
  assert.equal(otherStep.localSyntax.observedBindings.length, 3);
  assert.equal(otherStep.legalCandidates.some((candidate) => candidate.startsWith("c:advance:")), false);
  assert.equal(
    otherStep.currentRelation.binding.value.resolution.declarationRef,
    "decl:sources/src/closure.ts#top:base",
  );
  assert.equal(otherStep.previousExecution.value.outcome, "success");

  const dynamic = rowBySample(supervision, "b-closure-unknown-dynamic-property");
  assert.equal(dynamic.trainingEligible, false);
  assert.deepEqual(dynamic.originalExpected, {
    label: "unknown",
    originalLabel: "unknown",
    originalUnknownReason: "dynamic_undecidable",
    labelMissing: false,
    executionReceiptRef: null,
  });
  const dynamicStep0 = stepByIndex(rowBySample(students, "b-closure-unknown-dynamic-property"), 0);
  assert.deepEqual(
    dynamicStep0.remainingObligations.map((item) => item.ref),
    ["observe:entry-fold", "observe:registry"],
  );
  assert.equal(dynamicStep0.localSyntax.observedDeclarations.length, 0);

  const missing = rowBySample(supervision, "a-module-unknown-missing-module");
  assert.equal(missing.trainingEligible, false);
  assert.match(missing.notReadyReason, /module missing|execution\/coverage/i);
  const missingStep = stepByIndex(rowBySample(students, "a-module-unknown-missing-module"), 0);
  assert.equal(missingStep.localSyntax.sourceContent.state, "failed");
  assert.equal(missingStep.previousExecution.value.outcome, "failed");
  assert.equal(missingStep.receipts[0].outcome, "failed");

  const selfCheck = JSON.parse(await readFile(path.join(outDir, "self-check.json"), "utf8"));
  const noneBranches = selfCheck.gainBranches.filter((item) => item.branch === "known/none");
  assert.ok(noneBranches.length > 0);
  assert.equal(noneBranches.every((item) => item.candidateEmitted === false), true);
});

test("student rows stay byte-identical when independent supervision changes", async () => {
  const baseDir = await makeOutputDir();
  const overrideDir = await makeOutputDir();
  const supervisionRows = await readJsonl(DEFAULT_SUPERVISION_SOURCE);
  const changedRows = structuredClone(supervisionRows);
  const changed = rowBySample(changedRows, "a-module-positive-alias");
  changed.gold.label = "false";
  changed.gold.goldAction = "c:judge:false";
  changed.gold.teacherEvidence = "teacher-only-evaluation-that-must-not-affect-students";
  changed.steps[0].S_g = [...changed.steps[0].S_g, "c:defer"];
  changed.steps[0].A_g = ["c:defer"];
  changed.steps[0].agSubsetOfSg = true;

  await generateFixedStepwise({ corpusRoot: CORPUS_ROOT, outDir: baseDir });
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir: overrideDir,
    supervisionRowsOverride: changedRows,
  });

  const baseStudents = await readFile(path.join(baseDir, "student-observations.jsonl"), "utf8");
  const overrideStudents = await readFile(path.join(overrideDir, "student-observations.jsonl"), "utf8");
  assert.equal(baseStudents, overrideStudents);
  assert.doesNotMatch(baseStudents, /"A_g"|"gold"|teacher-only-evaluation-that-must-not-affect-students/i);

  const baseSupervision = await readJsonl(path.join(baseDir, "independent-supervision.jsonl"));
  const overrideSupervision = await readJsonl(path.join(overrideDir, "independent-supervision.jsonl"));
  assert.equal(
    rowBySample(overrideSupervision, "a-module-positive-alias").gold.label,
    "false",
  );
  assert.deepEqual(
    rowBySample(overrideSupervision, "a-module-positive-alias").steps[0].S_g,
    changed.steps[0].S_g,
  );
  assert.deepEqual(
    rowBySample(overrideSupervision, "a-module-positive-alias").steps[0].A_g,
    changed.steps[0].A_g,
  );
  assert.equal(rowBySample(baseSupervision, "a-module-positive-alias").gold.label, "true");
  assert.equal(
    rowBySample(baseSupervision, "a-module-positive-alias").steps[0].S_g.includes("c:defer"),
    true,
  );
});

test("keeps known and missing typed request fields without rebuilding them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "carol-r2-request-"));
  const typedSource = path.join(root, "student-observations.jsonl");
  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    typedSource,
    `${JSON.stringify({
      family: "train-module-export-alias-a",
      sampleId: "a-module-positive-alias",
      request: {
        requestRef: "request:partial-alias",
        requestedDeclaration: {
          declarationRef: "decl:opaque#helper",
          moduleRef: null,
          name: "helper",
          kind: null,
          sourceTargetRef: "opaque:source-target",
        },
        relationObligation: {
          pendingRelationRef: "pending:partial-alias",
          callSiteRef: "call:opaque:call-site",
          calleeName: "helper",
        },
      },
    })}\n`,
  );

  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir,
    typedRequestSource: typedSource,
  });
  const students = await readJsonl(path.join(outDir, "student-observations.jsonl"));
  const supervision = await readJsonl(path.join(outDir, "independent-supervision.jsonl"));
  const alias = rowBySample(students, "a-module-positive-alias");
  assert.equal(alias.request.requestRef, "request:partial-alias");
  assert.deepEqual(alias.request.requestedDeclaration.declarationRef, {
    state: "known",
    value: "decl:opaque#helper",
    reason: null,
    evidenceRefs: [],
  });
  assert.equal(alias.request.requestedDeclaration.moduleRef.state, "missing");
  assert.deepEqual(alias.request.requestedDeclaration.name, {
    state: "known",
    value: "helper",
    reason: null,
    evidenceRefs: [],
  });
  assert.equal(alias.request.requestedDeclaration.kind.state, "missing");
  assert.equal(alias.request.requestedDeclaration.sourceTargetRef, "opaque:source-target");
  assert.equal(alias.request.relationObligation.pendingRelationRef, "pending:partial-alias");
  assert.equal(alias.request.relationObligation.callSiteRef, "call:opaque:call-site");
  for (const step of alias.steps) {
    assert.equal(step.currentRelation.pendingRelationRef, "pending:partial-alias");
    assert.equal(step.currentRelation.callSiteRef, "call:opaque:call-site");
    assert.equal(step.previousExecution.value.pendingRelationRef, "pending:partial-alias");
  }
  assert.equal(
    alias.steps[0].remainingObligations[0].pendingRelationRef,
    "pending:partial-alias",
  );
  const changedRequestSupervision = rowBySample(supervision, "a-module-positive-alias");
  assert.equal(changedRequestSupervision.trainingEligible, false);
  assert.match(
    changedRequestSupervision.notReadyReason,
    /student request does not match independent supervision requestRef/i,
  );
  assert.equal(
    changedRequestSupervision.joinFailures.some(
      (failure) =>
        failure.reason === "student request does not match independent supervision requestRef",
    ),
    true,
  );
  assert.equal(changedRequestSupervision.requestRef, "request:a-module-positive-alias");
  assert.equal(changedRequestSupervision.gold.label, "true");
  const missingRequestRow = rowBySample(supervision, "b-closure-positive-inner-call");
  assert.equal(missingRequestRow.trainingEligible, false);
  assert.match(missingRequestRow.notReadyReason, /typed request row missing/i);
  assert.equal(
    missingRequestRow.joinFailures.some(
      (failure) => failure.reason === "typed request row missing",
    ),
    true,
  );

  const duplicateRoot = await mkdtemp(path.join(tmpdir(), "carol-r2-request-duplicate-"));
  const duplicateSource = path.join(duplicateRoot, "student-observations.jsonl");
  const duplicateOut = path.join(duplicateRoot, "out");
  await mkdir(duplicateOut, { recursive: true });
  const duplicateRow = {
    family: "train-module-export-alias-a",
    sampleId: "a-module-positive-alias",
    request: {
      requestRef: "request:duplicate-alias",
      requestedDeclaration: { declarationRef: "decl:opaque#helper" },
      relationObligation: {
        pendingRelationRef: "pending:duplicate-alias",
        callSiteRef: "call:opaque:duplicate",
      },
    },
  };
  await writeFile(
    duplicateSource,
    `${JSON.stringify(duplicateRow)}\n${JSON.stringify(duplicateRow)}\n`,
  );
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir: duplicateOut,
    typedRequestSource: duplicateSource,
  });
  const duplicateSupervision = await readJsonl(
    path.join(duplicateOut, "independent-supervision.jsonl"),
  );
  const duplicateAlias = rowBySample(duplicateSupervision, "a-module-positive-alias");
  assert.equal(duplicateAlias.trainingEligible, false);
  assert.match(duplicateAlias.notReadyReason, /duplicate typed request join/i);
  assert.equal(
    duplicateAlias.joinFailures.some(
      (failure) => failure.reason === "duplicate typed request join",
    ),
    true,
  );

  const sourceMismatchRoot = await mkdtemp(
    path.join(tmpdir(), "carol-r2-request-source-mismatch-"),
  );
  const sourceMismatchSource = path.join(sourceMismatchRoot, "student-observations.jsonl");
  const sourceMismatchOut = path.join(sourceMismatchRoot, "out");
  await mkdir(sourceMismatchOut, { recursive: true });
  await writeFile(
    sourceMismatchSource,
    `${JSON.stringify({
      ...duplicateRow,
      sourceGroup: "other-source-group",
      request: {
        requestRef: "request:source-mismatch",
        requestedDeclaration: { declarationRef: "decl:opaque#helper" },
        relationObligation: {
          pendingRelationRef: "pending:source-mismatch",
          callSiteRef: "call:opaque:source-mismatch",
        },
      },
    })}\n`,
  );
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir: sourceMismatchOut,
    typedRequestSource: sourceMismatchSource,
  });
  const sourceMismatchSupervision = await readJsonl(
    path.join(sourceMismatchOut, "independent-supervision.jsonl"),
  );
  const sourceMismatchAlias = rowBySample(sourceMismatchSupervision, "a-module-positive-alias");
  assert.equal(sourceMismatchAlias.trainingEligible, false);
  assert.match(
    sourceMismatchAlias.notReadyReason,
    /typed request sourceGroup does not match student sourceGroup/i,
  );
});

test("keeps supervision S_g/A_g unchanged when a student candidate is wrong", async () => {
  const outDir = await makeOutputDir();
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir,
    studentCandidateOverrides: {
      "a-module-positive-alias": {
        "step-0": ["c:judge:false"],
      },
    },
  });

  const supervision = await readJsonl(path.join(outDir, "independent-supervision.jsonl"));
  const row = rowBySample(supervision, "a-module-positive-alias");
  assert.equal(row.trainingEligible, false);
  assert.equal(row.joinFailures.length > 0, true);
  assert.match(row.joinFailures[0].reason, /candidate set differs/i);
  assert.equal(row.steps[0].S_g.includes("c:judge:false"), true);
  assert.equal(row.steps[0].S_g.includes("c:defer"), true);
  assert.deepEqual(row.steps[0].A_g, ["c:advance:edge:sources/src/entry-pos.ts:import:0"]);
});

test("writes a self-check receipt with required audit fields", async () => {
  const outDir = await makeOutputDir();
  await generateFixedStepwise({ corpusRoot: CORPUS_ROOT, outDir });
  const receipt = JSON.parse(await readFile(path.join(outDir, "self-check.json"), "utf8"));
  for (const key of [
    "actualReads",
    "localAstObservations",
    "stepFirsts",
    "bindingSources",
    "gainBranches",
    "predecessorAndConsumption",
    "admissions",
    "isolation",
    "outputPaths",
  ]) {
    assert.ok(key in receipt, `missing self-check field ${key}`);
  }
  assert.equal(receipt.assertions.failed, 0);
  assert.equal(receipt.isolation.studentGenerationConsumesSupervision, false);
  assert.equal(receipt.isolation.studentBuildInputsContainForbiddenFields, false);
  assert.equal(receipt.isolation.checkedStudentInputCount, 10);
  assert.equal(receipt.isolation.supervisionVariantStudentBytesEqual, undefined);
  assert.equal(receipt.isolation.studentRowsByteStableAcrossSupervisionVariants, undefined);
  assert.equal(typeof receipt.isolation.supervisionIsolationTestRef, "string");
});

test.after(async () => {
  // The test uses private temp directories. Cleanup is intentionally left to the
  // OS tmpdir sweeper; no shared or project-owned resource is touched.
});
