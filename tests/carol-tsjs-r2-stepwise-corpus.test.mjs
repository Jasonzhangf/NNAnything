import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateFixedStepwise } from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";

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
  assert.equal(alias.request.requestedDeclaration.name.state, "missing");
  assert.equal(alias.request.requestedDeclaration.kind.state, "missing");
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

test("student rows stay byte-identical when gold or teacher supervision changes", async () => {
  const baseDir = await makeOutputDir();
  const overrideDir = await makeOutputDir();
  await generateFixedStepwise({ corpusRoot: CORPUS_ROOT, outDir: baseDir });
  await generateFixedStepwise({
    corpusRoot: CORPUS_ROOT,
    outDir: overrideDir,
    supervisionOverride: {
      "a-module-positive-alias": {
        goldLabel: "false",
        goldAction: "c:judge:false",
        teacherEvidence: "teacher-only-evaluation-that-must-not-affect-students",
      },
    },
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
  assert.equal(rowBySample(baseSupervision, "a-module-positive-alias").gold.label, "true");
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
});

test.after(async () => {
  // The test uses private temp directories. Cleanup is intentionally left to the
  // OS tmpdir sweeper; no shared or project-owned resource is touched.
});
