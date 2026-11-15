import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertAcceptedCellCoverage,
  assertCallerSourceAdmission,
  assertOldReplayCounts,
  assertPreStepStudentRecord,
  classifyProducerOutcome,
  decideGoldFromPreStep,
  reconcileOldReplay,
  reconcilePreparedGroups,
  runMaterialization,
  validateMatrixEntry,
} from "../scripts/materialize-tsjs-computed-a1-observe.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATERIALIZER = resolve(REPO_ROOT, "scripts/materialize-tsjs-computed-a1-observe.mjs");

const JUDGE_CONTROL_CANDIDATES = [
  "c:judge:true",
  "c:judge:false",
  "c:judge:unknown",
  "c:return",
];

const OBSERVE_OBLIGATION = {
  kind: "observe",
  ref: "obligation:computed",
  pendingRelationRef: "pending:1",
  informationGain: 1,
};

test("student metadata rejects a selected declaration but permits the requested goal", () => {
  const record = {
    request: {
      requestedDeclaration: { declarationRef: "decl:requested" },
    },
    steps: [{
      localSyntax: { observedDeclarations: [] },
    }],
    metadata: {
      selectedDeclaration: { declarationRef: "decl:future" },
    },
  };

  assert.throws(
    () => assertPreStepStudentRecord(record),
    /selectedDeclaration.*future observation leakage/,
  );
});

test("supported requested-declaration mismatch still gives observe action gold", () => {
  const result = decideGoldFromPreStep({
    cell: "TRAIN-P2",
    episode: {
      remainingObligations: [OBSERVE_OBLIGATION],
    },
    candidateRefs: [
      "c:judge:true",
      "c:judge:false",
      "c:judge:unknown",
      "c:observe:obligation:computed",
      "c:defer",
    ],
    producerEvidence: {
      requestedDeclarationRef: "decl:requested",
      selectedDeclarationRef: "decl:actual",
    },
  });

  assert.deepEqual(result.A_g, ["c:observe:obligation:computed"]);
});

test("positive observe gold requires the runtime observe candidate", () => {
  assert.throws(
    () => decideGoldFromPreStep({
      cell: "TRAIN-P1",
      episode: { remainingObligations: [OBSERVE_OBLIGATION] },
      candidateRefs: ["c:judge:true", "c:judge:false", "c:judge:unknown", "c:defer"],
    }),
    /exact positive runtime candidate order/,
  );
});

test("producer evidence cannot change retained positive gold", () => {
  assert.throws(
    () => decideGoldFromPreStep({
      cell: "TRAIN-P1",
      episode: { remainingObligations: [OBSERVE_OBLIGATION] },
      candidateRefs: [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        "c:observe:obligation:computed",
        "c:defer",
      ],
      producerEvidence: {
        requestedDeclarationRef: "decl:requested",
        selectedDeclarationRef: "decl:requested",
      },
    }),
    /producer evidence cannot be admitted inside positive student materialization/,
  );
});

test("no-obligation control emits exact unknown and rejects an observe candidate", () => {
  const control = decideGoldFromPreStep({
    cell: "TRAIN-N1",
    episode: { remainingObligations: [] },
    candidateRefs: JUDGE_CONTROL_CANDIDATES,
  });
  assert.deepEqual(control.A_g, ["c:judge:unknown"]);
  assert.throws(
    () => decideGoldFromPreStep({
      cell: "TRAIN-N1",
      episode: { remainingObligations: [] },
      candidateRefs: [
        ...JUDGE_CONTROL_CANDIDATES,
        "c:observe:obligation:computed",
      ],
    }),
    /control must not contain an observe candidate/,
  );
});

test("known-none control requires typed pre-step none and rejects observe", () => {
  const knownNone = decideGoldFromPreStep({
    cell: "TRAIN-N2",
    episode: {
      remainingObligations: [{
        ...OBSERVE_OBLIGATION,
        informationGain: { state: "known", value: "none", evidenceRefs: [] },
      }],
    },
    candidateRefs: JUDGE_CONTROL_CANDIDATES,
  });
  assert.deepEqual(knownNone.A_g, ["c:judge:unknown"]);
  assert.throws(
    () => decideGoldFromPreStep({
      cell: "TRAIN-N2",
      episode: {
        remainingObligations: [{
          ...OBSERVE_OBLIGATION,
          informationGain: { state: "known", value: "none", evidenceRefs: [] },
        }],
      },
      candidateRefs: [
        ...JUDGE_CONTROL_CANDIDATES,
        "c:observe:obligation:computed",
      ],
    }),
    /control must not contain an observe candidate/,
  );
});

test("old TRAIN replay rejects a missing supervision group", () => {
  const original = {
    admissions: {
      familyAdmissions: [
        "tsjs-train-module-export-alias-a",
        "tsjs-train-closure-call-a",
        "tsjs-train-runtime-helper-selector-r1",
        "tsjs-train-retention-contrast-r1",
        "tsjs-train-lexical-declaration-contrast-r1-20261113",
      ].map(sourceGroup => ({
        sourceGroup,
        partition: "TRAIN",
        admission: "accepted_train_supervision",
        usableForTrainingSupervision: true,
      })),
    },
    studentRows: [
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "TRAIN", candidateRef: "c:judge:true", x: [1] },
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "TRAIN", candidateRef: "c:judge:unknown", x: [2] },
    ],
    supervisionRows: [{
      group_id: "g1",
      sourceGroup: "tsjs-train-module-export-alias-a",
      partition: "TRAIN",
      goldAllowedCandidateRefs: ["c:judge:true"],
    }],
  };
  const damaged = structuredClone(original);
  damaged.supervisionRows = [{ group_id: "orphan", sourceGroup: "x", partition: "TRAIN", goldAllowedCandidateRefs: ["c:judge:true"] }];

  assert.throws(
    () => reconcileOldReplay(damaged),
    /old TRAIN replay.*missing supervision group/,
  );
  assert.deepEqual(reconcileOldReplay(original), original);
});

test("old TRAIN replay rejects gold outside retained candidate rows", () => {
  const damaged = {
    admissions: {
      familyAdmissions: [
        "tsjs-train-module-export-alias-a",
        "tsjs-train-closure-call-a",
        "tsjs-train-runtime-helper-selector-r1",
        "tsjs-train-retention-contrast-r1",
        "tsjs-train-lexical-declaration-contrast-r1-20261113",
      ].map(sourceGroup => ({
        sourceGroup,
        partition: "TRAIN",
        usableForTrainingSupervision: true,
      })),
    },
    studentRows: [
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "TRAIN", candidateRef: "c:judge:true", x: [1] },
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "TRAIN", candidateRef: "c:judge:unknown", x: [2] },
    ],
    supervisionRows: [{
      group_id: "g1",
      sourceGroup: "tsjs-train-module-export-alias-a",
      partition: "TRAIN",
      goldAllowedCandidateRefs: ["c:judge:false"],
    }],
  };
  assert.throws(
    () => reconcileOldReplay(damaged),
    /allowed ref c:judge:false is outside the candidate rows/,
  );
});

test("old TRAIN replay rejects DEV leakage", () => {
  const damaged = {
    admissions: {
      familyAdmissions: [
        "tsjs-train-module-export-alias-a",
        "tsjs-train-closure-call-a",
        "tsjs-train-runtime-helper-selector-r1",
        "tsjs-train-retention-contrast-r1",
        "tsjs-train-lexical-declaration-contrast-r1-20261113",
      ].map(sourceGroup => ({
        sourceGroup,
        partition: "TRAIN",
        usableForTrainingSupervision: true,
      })),
    },
    studentRows: [
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "DEV", candidateRef: "c:judge:true", x: [1] },
      { group_id: "g1", sourceGroup: "tsjs-train-module-export-alias-a", partition: "DEV", candidateRef: "c:judge:unknown", x: [2] },
    ],
    supervisionRows: [{
      group_id: "g1",
      sourceGroup: "tsjs-train-module-export-alias-a",
      partition: "TRAIN",
      goldAllowedCandidateRefs: ["c:judge:true"],
    }],
  };
  assert.throws(
    () => reconcileOldReplay(damaged),
    /must stay TRAIN/,
  );
});

test("fresh CLI returns a typed INVALID receipt without a matrix", () => {
  const result = spawnSync(process.execPath, [MATERIALIZER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const receipt = JSON.parse(result.stderr);
  assert.equal(receipt.schema, "nnanything.tsjs.computed-a1-observe-materialize.v1");
  assert.equal(receipt.status, "INVALID");
  assert.match(receipt.error.message, /missing required argument --matrix/);
});

test("CLI materializes the accepted matrix with truthful UNAVAILABLE producer", async () => {
  const RUN = "/Volumes/Intel/playground/nnanything-runs/tsjs-computed-a1-training-preparation-20261115";
  const OLD = "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113";
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const out = await mkdtemp(join(tmpdir(), "a1-observe-cli-"));
  const result = spawnSync(process.execPath, [
    MATERIALIZER,
    "--matrix", resolve(RUN, "source-family-matrix.json"),
    "--old-run", OLD,
    "--out", out,
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, `expected UNAVAILABLE exit 2, got ${result.status}; stderr=${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, "nnanything.tsjs.computed-a1-observe-materialize.v1");
  assert.equal(receipt.status, "UNAVAILABLE");
  assert.equal(receipt.optimizationSeconds, 0);
  assert.equal(receipt.fitStatus, "not_trained");
  assert.equal(receipt.oldReplay.retainedStudentRows, 95);
  assert.equal(receipt.oldReplay.retainedSupervisionGroups, 22);
  assert.equal(receipt.partitionTotals.TRAIN, 6);
  assert.equal(receipt.partitionTotals.DEV, 3);
  for (const family of receipt.families) {
    assert.equal(family.producerOutcome, "unavailable");
    assert.match(family.producerReason, /not integrated/);
  }
  const leakage = JSON.parse(await readFile(resolve(out, "leakage-receipt.json"), "utf8"));
  assert.equal(leakage.status, "READY");
  const replay = JSON.parse(await readFile(resolve(out, "replay-receipt.json"), "utf8"));
  assert.equal(replay.status, "READY");
  const oldStudent = (await readFile(resolve(OLD, "student-rows.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  const trainStudent = (await readFile(resolve(out, "student-rows.train.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  assert.equal(trainStudent.length, 123);
  assert.deepEqual(trainStudent.slice(0, 95), oldStudent);
  const oldSupervision = (await readFile(resolve(OLD, "supervision-rows.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  const trainSupervision = (await readFile(resolve(out, "supervision-rows.train.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  assert.equal(trainSupervision.length, 28);
  assert.deepEqual(trainSupervision.slice(0, 22), oldSupervision);
  const devStudent = (await readFile(resolve(out, "student-rows.dev.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  assert.equal(devStudent.length, 14);
  const devSupervision = (await readFile(resolve(out, "supervision-rows.dev.jsonl"), "utf8")).split("\n").filter(line => line.length > 0);
  assert.equal(devSupervision.length, 3);
  const oldAdmissions = JSON.parse(await readFile(resolve(OLD, "corpus-admissions.train-only.json"), "utf8"));
  const trainAdmissions = JSON.parse(await readFile(resolve(out, "corpus-admissions.train-only.json"), "utf8"));
  assert.equal(trainAdmissions.familyAdmissions.length, 11);
  assert.deepEqual(trainAdmissions.familyAdmissions.slice(0, 5), oldAdmissions.familyAdmissions);
});

test("repeat CLI run is deterministic for semantic outputs", async () => {
  const RUN = "/Volumes/Intel/playground/nnanything-runs/tsjs-computed-a1-training-preparation-20261115";
  const OLD = "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113";
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const first = await mkdtemp(join(tmpdir(), "a1-observe-repeat-a-"));
  const second = await mkdtemp(join(tmpdir(), "a1-observe-repeat-b-"));
  const argv = [
    MATERIALIZER,
    "--matrix", resolve(RUN, "source-family-matrix.json"),
    "--old-run", OLD,
  ];
  for (const out of [first, second]) {
    const result = spawnSync(process.execPath, [...argv, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 2);
  }
  const files = [
    "student-rows.train.jsonl",
    "supervision-rows.train.jsonl",
    "student-rows.dev.jsonl",
    "supervision-rows.dev.jsonl",
    "data-gate-rows.train.jsonl",
    "corpus-admissions.train-only.json",
    "corpus-admissions.dev-only.json",
    "leakage-receipt.json",
    "replay-receipt.json",
  ];
  for (const file of files) {
    const left = await readFile(resolve(first, file), "utf8");
    const right = await readFile(resolve(second, file), "utf8");
    assert.equal(left, right, `repeat output differs for ${file}`);
  }
  const leftReceipt = JSON.parse(await readFile(resolve(first, "materialize-receipt.json"), "utf8"));
  const rightReceipt = JSON.parse(await readFile(resolve(second, "materialize-receipt.json"), "utf8"));
  for (const key of ["oldReplay", "partitionTotals", "families", "optimizationSeconds", "fitStatus", "producerAvailability"]) {
    assert.deepEqual(leftReceipt[key], rightReceipt[key], `receipt key differs: ${key}`);
  }
});

test("injected producer failure keeps pre-step gold and writes no teacher result", async () => {
  const RUN = "/Volumes/Intel/playground/nnanything-runs/tsjs-computed-a1-training-preparation-20261115";
  const OLD = "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113";
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const out = await mkdtemp(join(tmpdir(), "a1-observe-producer-failure-"));
  const receipt = await runMaterialization({
    matrixPath: resolve(RUN, "source-family-matrix.json"),
    oldRunPath: OLD,
    outPath: out,
  }, {
    producer: async () => ({ status: "rejected", reasonCode: "fixture_producer_failure" }),
  });
  assert.equal(receipt.status, "INVALID");
  for (const family of receipt.families) {
    assert.equal(family.producerOutcome, "rejected");
    assert.equal(family.producerReason, "fixture_producer_failure");
    if (/-(?:p[1-4])$/u.test(family.sourceGroup)) {
      assert.equal(family.A_g.length, 1);
      assert.match(family.A_g[0], /^c:observe:/);
    } else {
      assert.deepEqual(family.A_g, ["c:judge:unknown"]);
    }
  }
  await assert.rejects(
    readFile(resolve(out, "teacher-evidence", "tsjs-computed-a1-train-p1", "producer-result.json")),
  );
});

test("matrix admission rejects a cell whose partition mismatches", () => {
  const entry = {
    cell: "DEV-P1",
    source_family_id: "tsjs-computed-a1-dev-p1",
    repo_root: "/tmp/source",
    caller_file: "caller.ts",
    source_file: "source.ts",
    call_site_ref: "call:caller.ts@1:1-1:9",
    symbol_name: "epsilonDevP1",
    selector_form: "string + string",
    read_set: { files: ["caller.ts", "source.ts"] },
    semantic_proof_ref: "proofs/dev-p1.md",
    partition: "TRAIN",
  };
  assert.throws(
    () => validateMatrixEntry(entry, 0),
    /partition TRAIN does not match cell DEV-P1/,
  );
});

test("matrix admission rejects a partial A1 cell set", () => {
  assert.throws(
    () => assertAcceptedCellCoverage([{ cell: "TRAIN-P1" }]),
    /each accepted A1 cell exactly once/,
  );
});

test("producer failure cannot replace pre-step observe gold", () => {
  const result = decideGoldFromPreStep({
    cell: "TRAIN-P1",
    episode: { remainingObligations: [OBSERVE_OBLIGATION] },
    candidateRefs: [
      "c:judge:true",
      "c:judge:false",
      "c:judge:unknown",
      "c:observe:obligation:computed",
      "c:defer",
    ],
    producerEvidence: { rejected: true, reason: "producer unavailable" },
  });
  assert.deepEqual(result.A_g, ["c:observe:obligation:computed"]);
  assert.equal(result.kind, "positive");
});

test("producer outcome classification is truthful about missing observations", () => {
  assert.deepEqual(
    classifyProducerOutcome({ status: "rejected", reasonCode: "unsupported_selector" }, "call:1"),
    { outcome: "rejected", reason: "unsupported_selector", observation: null },
  );
  const success = classifyProducerOutcome({
    status: "ok",
    result: { constantComputedPropertyObservations: [{ callSiteRef: "call:1" }] },
  }, "call:1");
  assert.equal(success.outcome, "success");
  assert.deepEqual(success.observation, { callSiteRef: "call:1" });
  assert.equal(
    classifyProducerOutcome({
      status: "ok",
      result: { constantComputedPropertyObservations: [] },
    }, "call:1").outcome,
    "rejected",
  );
  const mutation = classifyProducerOutcome({
    status: "ok",
    result: {
      A_g: ["c:judge:true"],
      constantComputedPropertyObservations: [{ callSiteRef: "call:1" }],
    },
  }, "call:1");
  assert.equal(mutation.outcome, "rejected");
  assert.match(mutation.reason, /attempted to mutate fixed student supervision via A_g/);
});

test("source admission rejects an aliased import with a semantic error", async () => {
  const root = "/Volumes/Intel/playground/nnanything-runs/tsjs-computed-a1-training-preparation-20261115/sources/train-p1";
  const entry = {
    cell: "TRAIN-P1",
    source_family_id: "tsjs-computed-a1-train-p1",
    caller_file: "caller.ts",
    source_file: "source.ts",
    call_site_ref: "call:caller.ts@6:23-6:64",
    symbol_name: "alphaTrainP1",
    selector_form: "string_literal + string_literal",
  };
  const record = {
    request: {
      requestedDeclaration: { name: "alphaTrainP1" },
    },
  };
  const caller = await readFile(resolve(root, "caller.ts"), "utf8");
  const source = await readFile(resolve(root, "source.ts"), "utf8");
  assert.doesNotThrow(() => assertCallerSourceAdmission(entry, caller, source, record));
  const aliased = caller.replace(
    'import { alphaTrainP1 } from "./source";',
    'import { alphaTrainP1 as selected } from "./source";',
  );
  assert.throws(
    () => assertCallerSourceAdmission(entry, aliased, source, record),
    /must use an unaliased named import for alphaTrainP1/,
  );
});

test("old TRAIN replay count gate rejects a truncated corpus", () => {
  assert.throws(
    () => assertOldReplayCounts({
      admissions: { familyAdmissions: [] },
      studentRows: [],
      supervisionRows: [],
      dataGateRows: [],
    }),
    /must retain exactly 5 admissions/,
  );
});

test("prepared join rejects A_g outside the retained candidate group", () => {
  const group = {
    group_id: "g1",
    partition: "TRAIN",
    sourceGroup: "s1",
    sampleId: "sample1",
    stepId: "step-0",
    requestRef: "request:1",
    candidates: [{ candidateRef: "c:judge:true" }, { candidateRef: "c:judge:unknown" }],
  };
  const supervision = [{
    group_id: "g1",
    partition: "TRAIN",
    sourceGroup: "s1",
    sampleId: "sample1",
    stepId: "step-0",
    requestRef: "request:1",
    trainingEligible: true,
    goldAllowedCandidateRefs: ["c:observe:missing"],
  }];
  assert.throws(
    () => reconcilePreparedGroups([group], supervision),
    /prepared A_g must be non-empty and within S_g for g1/,
  );
});
