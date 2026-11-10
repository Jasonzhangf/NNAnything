import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admitInitialEvidence } from "../dist/adapters/tsjs-unified-recursive.js";
import { loadStepwiseEpisodeFamily } from "../dist/training/unified-student-converter.js";

const familyDir = fileURLToPath(
  new URL("../training/samples/neural-cli/tsjs/verification-independent-callgraph-d/", import.meta.url),
);

function evidenceIds(admission) {
  assert.notEqual(admission.initialObservation, null);
  return admission.initialObservation.evidence.map(record => record.id);
}

test("negative-shadow admission keeps only the real read and import evidence", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const sampleEpisodes = episodes.filter(
    episode => episode.sampleId === "d2-verification-negative-shadow",
  );
  assert.equal(sampleEpisodes.length, 1);

  const requestId = "evaluate:root-evidence-admission:negative-shadow";
  const admission = admitInitialEvidence(requestId, sampleEpisodes);
  const ids = evidenceIds(admission);

  assert.deepEqual(ids, [
    "ev:sources/src/shadow.ts:read",
    "ev:sources/src/shadow.ts:import:0",
  ]);
  assert.equal(
    admission.initialStateRef,
    "ms:evaluate:root-evidence-admission:negative-shadow:step-0",
  );
  assert.equal(admission.initialObservation.stateId, admission.initialStateRef);
  assert.deepEqual(admission.invalidReasons, []);
  assert.equal(
    sampleEpisodes[0].requestedDeclaration.evidenceRefs.includes(
      "ev:sources/src/math-ops.ts:read",
    ),
    true,
  );
  assert.equal(ids.includes("ev:sources/src/math-ops.ts:read"), false);
});

test("failed or relation-mismatched source reads are not admitted as valid read evidence", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const sampleEpisodes = episodes.filter(
    episode => episode.sampleId === "d2-verification-negative-shadow",
  );

  const failedRead = structuredClone(sampleEpisodes[0]);
  failedRead.receipts[0].outcome = "failed";
  const failedAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:failed-read",
    [failedRead],
  );
  assert.equal(
    failedAdmission.invalidReasons.includes("source read receipt outcome not success"),
    true,
  );
  assert.equal(
    evidenceIds(failedAdmission).includes("ev:sources/src/shadow.ts:read"),
    false,
  );

  const mismatchedRead = structuredClone(sampleEpisodes[0]);
  mismatchedRead.receipts[0].pendingRelationRef = "pending:another-request";
  const mismatchedAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:mismatched-read",
    [mismatchedRead],
  );
  assert.equal(
    mismatchedAdmission.invalidReasons.includes("source read receipt pendingRelationRef mismatch"),
    true,
  );
  assert.equal(
    evidenceIds(mismatchedAdmission).includes("ev:sources/src/shadow.ts:read"),
    false,
  );
});

test("invalid import bindings do not become import evidence", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const sampleEpisodes = episodes.filter(
    episode => episode.sampleId === "d2-verification-negative-shadow",
  );
  const invalidImport = structuredClone(sampleEpisodes[0]);
  invalidImport.observedBindings[0].sourceModule.state = "unknown";

  const admission = admitInitialEvidence(
    "evaluate:root-evidence-admission:invalid-import",
    [invalidImport],
  );
  const ids = evidenceIds(admission);

  assert.equal(
    admission.invalidReasons.includes(
      "import binding edge:sources/src/shadow.ts:import:0 not admitted: import module is not known",
    ),
    true,
  );
  assert.equal(ids.includes("ev:sources/src/shadow.ts:read"), true);
  assert.equal(ids.includes("ev:sources/src/shadow.ts:import:0"), false);
});

test("dynamic row admits the real source read and keeps the declaration audit ref out", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const sampleEpisodes = episodes.filter(
    episode => episode.sampleId === "d2-verification-unknown-dynamic",
  );
  const requestId = "evaluate:root-evidence-admission:unknown-dynamic";
  const admission = admitInitialEvidence(requestId, sampleEpisodes);
  const ids = evidenceIds(admission);

  assert.equal(ids.includes("ev:sources/src/entry-dynamic.ts:read"), true);
  assert.equal(ids.includes("ev:sources/src/entry-dynamic.ts:import:0"), true);
  assert.equal(ids.includes("ev:sources/src/entry-dynamic.ts:import:1"), true);
  assert.equal(ids.includes("ev:sources/src/math-ops.ts:read"), false);
  assert.equal(
    admission.initialStateRef,
    "ms:evaluate:root-evidence-admission:unknown-dynamic:step-0",
  );
});

test("mismatched read target, action, or step is rejected rather than admitted", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const base = episodes.filter(episode => episode.sampleId === "d2-verification-negative-shadow");

  const wrongTarget = structuredClone(base[0]);
  wrongTarget.receipts[0].target = "mod:sources/src/math-ops.ts";
  const wrongTargetAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:wrong-target",
    [wrongTarget],
  );
  assert.equal(
    wrongTargetAdmission.invalidReasons.includes(
      "source read targetRef does not match previous execution",
    ),
    true,
  );
  assert.equal(evidenceIds(wrongTargetAdmission).includes("ev:sources/src/shadow.ts:read"), false);

  const wrongAction = structuredClone(base[0]);
  wrongAction.receipts[0].actionRef = "action:wrong";
  const wrongActionAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:wrong-action",
    [wrongAction],
  );
  assert.equal(
    wrongActionAdmission.invalidReasons.includes(
      "source read actionRef does not match previous execution",
    ),
    true,
  );
  assert.equal(evidenceIds(wrongActionAdmission).includes("ev:sources/src/shadow.ts:read"), false);

  const wrongStep = structuredClone(base[0]);
  wrongStep.receipts[0].fromStepId = "step-1";
  const wrongStepAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:wrong-step",
    [wrongStep],
  );
  assert.equal(
    wrongStepAdmission.invalidReasons.includes(
      "source read fromStepId does not match previous execution",
    ),
    true,
  );
  assert.equal(evidenceIds(wrongStepAdmission).includes("ev:sources/src/shadow.ts:read"), false);
});

test("receipt result membership alone is not enough for root-eligible read evidence", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const base = episodes.filter(episode => episode.sampleId === "d2-verification-negative-shadow");
  const missingMembership = structuredClone(base[0]);
  missingMembership.receipts[0].evidenceRefs = [];

  const admission = admitInitialEvidence(
    "evaluate:root-evidence-admission:missing-membership",
    [missingMembership],
  );
  assert.equal(
    admission.invalidReasons.includes("source read evidence membership missing"),
    true,
  );
  assert.equal(evidenceIds(admission).includes("ev:sources/src/shadow.ts:read"), false);
});

test("duplicate evidence ids are dropped from root eligibility", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const base = episodes.filter(episode => episode.sampleId === "d2-verification-negative-shadow");
  const duplicate = structuredClone(base[0]);
  duplicate.observedBindings = [
    ...duplicate.observedBindings,
    structuredClone(duplicate.observedBindings[0]),
  ];

  const admission = admitInitialEvidence(
    "evaluate:root-evidence-admission:duplicate-import",
    [duplicate],
  );
  assert.equal(
    admission.invalidReasons.includes(
      "duplicate initial evidence id ev:sources/src/shadow.ts:import:0",
    ),
    true,
  );
  assert.equal(evidenceIds(admission).includes("ev:sources/src/shadow.ts:import:0"), false);
});

test("missing typed previous execution rejects the read and cannot be widened by changed identity fields", async () => {
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const base = episodes.filter(episode => episode.sampleId === "d2-verification-negative-shadow");
  const readRef = "ev:sources/src/shadow.ts:read";

  const missingPrevious = structuredClone(base[0]);
  delete missingPrevious.previousExecution;
  const missingAdmission = admitInitialEvidence(
    "evaluate:root-evidence-admission:missing-previous",
    [missingPrevious],
  );
  assert.equal(
    missingAdmission.invalidReasons.includes(
      "source read receipt requires typed previous execution identity",
    ),
    true,
  );
  assert.equal(evidenceIds(missingAdmission).includes(readRef), false);

  const cases = [
    ["wrong-target", clone => { clone.receipts[0].target = "mod:sources/src/math-ops.ts"; }],
    ["wrong-action", clone => { clone.receipts[0].actionRef = "action:wrong"; }],
    ["wrong-step", clone => { clone.receipts[0].fromStepId = "step-1"; }],
  ];
  for (const [label, mutate] of cases) {
    const clone = structuredClone(base[0]);
    delete clone.previousExecution;
    mutate(clone);
    const admission = admitInitialEvidence(
      `evaluate:root-evidence-admission:missing-previous-${label}`,
      [clone],
    );
    assert.equal(
      admission.invalidReasons.includes(
        "source read receipt requires typed previous execution identity",
      ),
      true,
      label,
    );
    assert.equal(evidenceIds(admission).includes(readRef), false, label);
  }
});
