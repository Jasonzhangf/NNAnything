import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateOldDevStepwise,
} from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";
import { loadStepwiseEpisodeFamily } from "../dist/training/unified-student-converter.js";
import {
  assessTsJsObservedDynamicCompletion,
  assessTsJsObservedStaticSelectedRead,
  assessTsJsObservedTargetMismatchCompletion,
  admitInitialEvidence,
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";

const REPO_FAMILY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../training/samples/neural-cli/tsjs/dev-closure-shadow-b",
);
const MISMATCH_SAMPLE_ID = "c-dev-negative-same-name-other";
const DERIVED_SOURCE_GROUP = "tsjs-negative-target-mismatch-test";

const THRESHOLDS = {
  schema: "nnanything.feature-thresholds.v1",
  route: "r",
  encoderVersion: "nnanything.unified-step.encoder.v2",
  buckets: {
    constraints: [0, 1, 2, 4],
    knownFacts: [1, 2, 4, 8],
    missingFacts: [0, 1, 2, 4],
    objectRefs: [1, 2, 4, 8],
    requiredArgsRatio: [0, 0.25, 0.5, 1],
    requiredMissing: [0, 1, 2, 4],
  },
};
const MISSING_MODE = { schema: "nnanything.unified.missing-mode.v1", entries: [] };

async function buildDerivedFamily() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-target-mismatch-"));
  const familyRoot = join(root, "dev-closure-shadow-b");
  const derivedDir = join(root, "derived");
  await cp(REPO_FAMILY_ROOT, familyRoot, { recursive: true });
  await mkdir(derivedDir, { recursive: true });
  const generated = await generateOldDevStepwise({
    familyRoot,
    outDir: derivedDir,
    receiptPath: join(derivedDir, "control-receipts.json"),
    targetMismatchSourceGroup: DERIVED_SOURCE_GROUP,
  });
  const episodes = await loadStepwiseEpisodeFamily(derivedDir);
  const mismatch = episodes.filter(episode => episode.sampleId === MISMATCH_SAMPLE_ID);
  return { root, familyRoot, derivedDir, generated, episodes, mismatch };
}

function completionState(episode, overrides = {}) {
  return {
    stepSequence: [episode.stepId],
    context: relationStepContext(episode),
    terminal: true,
    terminalKind: "judge",
    terminalJudgement: "judge=false",
    ...overrides,
  };
}

// x[37] is the judge=false feature slot in the unified R encoder. The synthetic
// package selects the terminal judgement; the witness, not the model, decides
// completion.
async function writeJudgeFalseModel(root) {
  const tensors = zeroTensors();
  tensors.W1[37] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  await writeFile(join(root, "feature-thresholds.json"), JSON.stringify(THRESHOLDS));
  await writeFile(join(root, "missing-mode.json"), JSON.stringify(MISSING_MODE));
  return saveUnifiedModelPackageAtomic(
    join(root, "package.json"),
    createUnifiedModelPackage({
      modelId: "tsjs-target-mismatch-test",
      version: "1",
      route: { domain: "tsjs", decisionKind: "R" },
      tensors,
      resources: {
        thresholdsRef: "feature-thresholds.json",
        thresholdsSchema: THRESHOLDS.schema,
        missingModeTableRef: "missing-mode.json",
        missingModeSchema: MISSING_MODE.schema,
      },
      fixedStages: ["nnanything.unified-step.encoder.v2"],
    }),
  );
}

function rawObservationOf(episode) {
  return episode.receipts[0].producerSource.rawObservation;
}

function gapCodes(assessment) {
  return assessment.gaps.map(gap => gap.code);
}

async function writeBoundReadContradiction(built) {
  const observationsPath = join(built.derivedDir, "student-observations.jsonl");
  const records = (await readFile(observationsPath, "utf8"))
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const record = records.find(candidate => candidate.sampleId === MISMATCH_SAMPLE_ID);
  assert.ok(record);
  const producerSource = record.steps[0].receipts[0].producerSource;
  const raw = producerSource.rawObservation;
  const boundReceipt = raw.sourceReadReceipts[1];
  const boundModuleFile = raw.boundDeclaration.moduleRef.replace(/^mod:/, "");
  const contradictoryFile = "sources/src/not-the-bound-module.ts";
  assert.equal(boundReceipt.modules[0].file, boundModuleFile);
  const derivedRead = producerSource.completionWork.items.find(
    item => item.kind === "source_read" && item.subjectRef === boundModuleFile,
  );
  assert.ok(derivedRead);

  boundReceipt.modules[0].file = contradictoryFile;
  derivedRead.subjectRef = contradictoryFile;
  await writeFile(
    observationsPath,
    `${records.map(candidate => JSON.stringify(candidate)).join("\n")}\n`,
  );
}

test("default old DEV generation keeps the mismatch sample free of the target read", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-target-mismatch-default-"));
  try {
    const familyRoot = join(root, "dev-closure-shadow-b");
    await cp(REPO_FAMILY_ROOT, familyRoot, { recursive: true });
    const result = await generateOldDevStepwise({
      familyRoot,
      outDir: familyRoot,
      receiptPath: join(root, "control-receipts.json"),
    });
    const control = result.controlReceipts.controls.find(
      entry => entry.sampleId === MISMATCH_SAMPLE_ID,
    );
    assert.equal(control.requestTargetRead, false);
    assert.equal(control.readFiles.includes("sources/src/alternate.ts"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader rejects a bound read that contradicts the bound declaration module", async () => {
  const built = await buildDerivedFamily();
  try {
    await writeBoundReadContradiction(built);
    await assert.rejects(
      () => loadStepwiseEpisodeFamily(built.derivedDir),
      /bound read does not back the bound declaration module/,
    );
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("admission rejects typed episodes with a bound read module contradiction", async () => {
  const built = await buildDerivedFamily();
  try {
    const contradictory = structuredClone(built.mismatch[0]);
    const raw = rawObservationOf(contradictory);
    const boundModuleFile = raw.boundDeclaration.moduleRef.replace(/^mod:/, "");
    const contradictoryFile = "sources/src/not-the-bound-module.ts";
    raw.sourceReadReceipts[1].modules[0].file = contradictoryFile;
    const derivedRead = contradictory.receipts[0].producerSource.completionWork.items.find(
      item => item.kind === "source_read" && item.subjectRef === boundModuleFile,
    );
    assert.ok(derivedRead);
    derivedRead.subjectRef = contradictoryFile;

    const admission = admitInitialEvidence(contradictory.requestId, [contradictory]);
    assert.ok(admission.invalidReasons.some(reason =>
      reason.includes("target-mismatch bound read does not back the bound declaration module")));
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("target-mismatch producer emits three real reads and a distinct target read", async () => {
  const built = await buildDerivedFamily();
  try {
    const control = built.generated.controlReceipts.controls.find(
      entry => entry.sampleId === MISMATCH_SAMPLE_ID,
    );
    assert.equal(control.shape, "direct-import-target-read");
    assert.equal(control.requestTargetRead, true);
    assert.ok(control.readFiles.includes("sources/src/entry-known.ts"));
    assert.ok(control.readFiles.includes("sources/src/factory.ts"));
    assert.ok(control.readFiles.includes("sources/src/alternate.ts"));
    assert.equal(control.requestShellPreserved, true);

    assert.equal(built.mismatch.length, 1);
    const episode = built.mismatch[0];
    const raw = rawObservationOf(episode);
    assert.equal(raw.kind, "resolved_target_mismatch");
    assert.equal(raw.sourceReadReceipts.length, 3);
    assert.deepEqual(
      raw.sourceReadReceipts.map(read => read.modules[0].file),
      [
        "sources/src/entry-known.ts",
        "sources/src/factory.ts",
        "sources/src/alternate.ts",
      ],
    );
    assert.notEqual(raw.boundDeclaration.declarationRef, raw.requestedDeclaration.declarationRef);
    assert.notEqual(raw.boundDeclaration.moduleRef, raw.requestedDeclaration.moduleRef);
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("admitted real target read completes judge=false as complete_false through the public entry", async () => {
  const built = await buildDerivedFamily();
  try {
    const packagePath = await writeJudgeFalseModel(built.root);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: built.mismatch[0].requestId,
      packagePath,
      episodes: built.mismatch,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: built.familyRoot }),
    });
    assert.deepEqual(result.initialEvidenceInvalidReasons, []);
    assert.equal(result.rootCompletion.predictedJudgement, "false");
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "complete_false");
    const gap = result.rootCompletion.positiveRootGaps.find(
      candidate => candidate.code === "POSITIVE_RELATION_NOT_ESTABLISHED",
    );
    assert.ok(gap);
    for (const receiptId of [
      "receipt:c-dev-negative-same-name-other:step0-source-read",
      "receipt:c-dev-negative-same-name-other:step1-bound-read",
      "receipt:c-dev-negative-same-name-other:step2-target-read",
    ]) {
      assert.ok(gap.refs.includes(receiptId));
    }
    assert.ok(result.rootCompletion.evidenceRefs.includes("ev:sources/src/factory.ts:read"));
    assert.ok(result.rootCompletion.evidenceRefs.includes("ev:sources/src/alternate.ts:read"));
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("target-mismatch assessment is supported while dynamic and static assessments stay not_applicable", async () => {
  const built = await buildDerivedFamily();
  try {
    const episode = built.mismatch[0];
    const admission = admitInitialEvidence(episode.requestId, built.mismatch);
    assert.deepEqual(admission.invalidReasons, []);
    const evidence = admission.initialObservation?.evidence ?? [];

    const assessment = assessTsJsObservedTargetMismatchCompletion(
      built.mismatch,
      completionState(episode),
      evidence,
    );
    assert.equal(assessment.status, "supported");
    assert.equal(assessment.producer_backed, true);
    assert.deepEqual(assessment.gaps, []);
    assert.equal(
      assessment.evidenceRefs.filter(ref => ref.startsWith("receipt:")).length,
      3,
    );

    assert.equal(
      assessTsJsObservedDynamicCompletion(built.mismatch, completionState(episode), evidence).status,
      "not_applicable",
    );
    assert.equal(
      assessTsJsObservedStaticSelectedRead(built.mismatch, completionState(episode), evidence).status,
      "not_applicable",
    );
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("target-mismatch reuse controls stay incomplete", async () => {
  const built = await buildDerivedFamily();
  try {
    const episode = built.mismatch[0];
    const admission = admitInitialEvidence(episode.requestId, built.mismatch);
    const evidence = admission.initialObservation?.evidence ?? [];
    const assess = (target, override = {}, evidenceOverride = evidence) =>
      assessTsJsObservedTargetMismatchCompletion(
        [target],
        completionState(episode, override),
        evidenceOverride,
      );

    // missing requested_target_mapping
    const missingMapping = structuredClone(episode);
    const work = missingMapping.receipts[0].producerSource.completionWork;
    work.items = work.items.filter(item => item.kind !== "requested_target_mapping");
    const missingMappingAssessment = assess(missingMapping);
    assert.equal(missingMappingAssessment.status, "incomplete");
    assert.ok(gapCodes(missingMappingAssessment).includes("completion_work_omits_required_item"));

    // T not admitted
    const targetReceiptId = rawObservationOf(episode).requestedDeclaration.readRef;
    const noTargetAdmission = evidence.filter(record => record.id !== targetReceiptId);
    const noTargetAssessment = assess(episode, {}, noTargetAdmission);
    assert.equal(noTargetAssessment.status, "incomplete");
    assert.ok(gapCodes(noTargetAssessment).includes("read_record_missing"));

    // name mismatch
    const nameMismatch = structuredClone(episode);
    const nameMismatchRaw = rawObservationOf(nameMismatch);
    nameMismatchRaw.boundDeclaration.name = "createShadowedStepper";
    nameMismatchRaw.callSiteBinding.symbolRef = "symbol:createShadowedStepper";
    for (const declaration of nameMismatch.observedDeclarations) {
      if (declaration.declarationRef === nameMismatchRaw.boundDeclaration.declarationRef) {
        declaration.name = "createShadowedStepper";
      }
    }
    const nameMismatchAssessment = assess(nameMismatch);
    assert.equal(nameMismatchAssessment.status, "incomplete");
    assert.ok(gapCodes(nameMismatchAssessment).includes("target_mismatch_declaration_invalid"));

    // same module
    const sameModule = structuredClone(episode);
    const sameModuleRaw = rawObservationOf(sameModule);
    sameModuleRaw.boundDeclaration.moduleRef = sameModuleRaw.requestedDeclaration.moduleRef;
    const sameModuleAssessment = assess(sameModule);
    assert.equal(sameModuleAssessment.status, "incomplete");
    assert.ok(gapCodes(sameModuleAssessment).includes("target_mismatch_declaration_invalid"));

    // wrong-edge: the createShadowedStepper edge is present but must not join
    const wrongEdge = structuredClone(episode);
    wrongEdge.observedBindings[0].targetName = "createShadowedStepper";
    wrongEdge.observedBindings[0].sourceName = "createShadowedStepper";
    const wrongEdgeAssessment = assess(wrongEdge);
    assert.equal(wrongEdgeAssessment.status, "incomplete");
    assert.ok(gapCodes(wrongEdgeAssessment).includes("target_mismatch_edge_invalid"));

    // unvisited episode outside the executed sequence
    const unvisited = assess(episode, {
      stepSequence: [],
      context: { ...relationStepContext(episode), stepId: "not-visited" },
    });
    assert.equal(unvisited.status, "not_applicable");

    // unadmitted read
    const unadmitted = assess(episode, {}, []);
    assert.equal(unadmitted.status, "incomplete");
    assert.ok(gapCodes(unadmitted).includes("read_record_missing"));

    // judge=false prediction without any witness episode
    const bareAssessment = assessTsJsObservedTargetMismatchCompletion([], completionState(episode), evidence);
    assert.equal(bareAssessment.status, "not_applicable");
    assert.equal(bareAssessment.producer_backed, false);
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});
