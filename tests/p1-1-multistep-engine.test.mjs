import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
// Red: the public multi-step consumer is the declared extension of
// runTsJsUnifiedDecision. It does not exist yet on this baseline.
import { runTsJsUnifiedMultiStepDecision } from "../dist/adapters/tsjs-unified-recursive.js";

const RESOURCE_NAMES = {
  thresholds: "feature-thresholds.json",
  missingMode: "missing-mode.json",
};

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

function advancePackage() {
  const tensors = zeroTensors();
  // x[53] is the `candidateKind === "action"` slot, so the forward path
  // deterministically prefers the advance candidate over the judges.
  tensors.W1[53] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-multistep-synthetic",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors,
    resources: {
      thresholdsRef: RESOURCE_NAMES.thresholds,
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: RESOURCE_NAMES.missingMode,
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v1"],
  });
}

async function packagePath(dir) {
  await writeFile(join(dir, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`);
  await writeFile(join(dir, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`);
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), advancePackage());
}

const E1 = "edge:sources/src/entry.ts:import:0";
const E2 = "edge:sources/src/util.ts:reexport:0";
const PENDING = "pending:alias-sample";

function step0() {
  return {
    sampleId: "alias-sample",
    stepId: "step-0",
    requestId: "request:alias-sample",
    sourceGroup: "unified-multistep-synthetic",
    language: "typescript",
    semanticStratum: "relation",
    partition: "verification",
    entryFile: "sources/src/entry.ts",
    targetRef: "decl:sources/src/impl.ts#top:helper",
    observedFacts: ["observed entry module"],
    pendingRelationRef: PENDING,
    callSiteRef: "call:sources/src/entry.ts:helper",
    calleeName: "helper",
    requestedDeclaration: {
      declarationRef: "decl:sources/src/impl.ts#top:helper",
      moduleRef: "mod:sources/src/impl.ts",
      name: "helper",
      role: "export",
      kind: "function",
      evidenceRefs: ["ev:sources/src/entry.ts:read"],
    },
    observedBindings: [{
      edgeRef: E1,
      callSiteRef: null,
      fromNodeRef: `syntax:${E1}`,
      edgeKind: "import",
      sourceName: "helper",
      sourceModule: { state: "known", value: "mod:sources/src/util.ts", reason: null, evidenceRefs: [`ev:${E1}`] },
      targetName: "helper",
      targetModule: { state: "known", value: "mod:sources/src/entry.ts", reason: null, evidenceRefs: [`ev:${E1}`] },
      moduleSpecifierRaw: "./util",
      sourceContent: { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: [`ev:${E1}`] },
      visibility: { state: "known", value: "reachable", reason: null, evidenceRefs: [`ev:${E1}`] },
      hopDepth: 0,
      evidenceRefs: [`ev:${E1}`],
    }],
    observedDeclarations: [],
    evidenceRefs: [`ev:${E1}`],
    failureMode: null,
    derivationFamily: "multistep",
    adapterRef: "test",
    remainingObligations: [{
      kind: "advance",
      ref: E1,
      pendingRelationRef: PENDING,
      informationGain: { state: "known", value: "advances_chain", evidenceRefs: [`ev:${E1}`] },
    }],
    localCandidateCursor: { pendingRelationRef: PENDING, state: "closed", evidenceRefs: [`ev:${E1}`] },
  };
}

function step1() {
  return {
    ...step0(),
    stepId: "step-1",
    observedFacts: ["observed util module"],
    observedBindings: [{
      edgeRef: E2,
      callSiteRef: null,
      fromNodeRef: `syntax:${E2}`,
      edgeKind: "reexport",
      sourceName: "helper",
      sourceModule: { state: "known", value: "mod:sources/src/impl.ts", reason: null, evidenceRefs: [`ev:${E2}`] },
      targetName: "helper",
      targetModule: { state: "known", value: "mod:sources/src/util.ts", reason: null, evidenceRefs: [`ev:${E2}`] },
      moduleSpecifierRaw: "./impl",
      sourceContent: { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: [`ev:${E2}`] },
      visibility: { state: "known", value: "reachable", reason: null, evidenceRefs: [`ev:${E2}`] },
      hopDepth: 1,
      evidenceRefs: [`ev:${E2}`],
    }],
    evidenceRefs: [`ev:${E1}`, `ev:${E2}`],
    remainingObligations: [{
      kind: "advance",
      ref: E2,
      pendingRelationRef: PENDING,
      informationGain: { state: "known", value: "advances_chain", evidenceRefs: [`ev:${E2}`] },
    }],
    previousExecution: {
      state: "known",
      value: {
        actionRef: "action:engine-advance:e1",
        receiptRef: "receipt:engine-advance:e1",
        origin: "model_execution",
        fromStepId: "step-0",
        pendingRelationRef: PENDING,
        optionSemantics: "advance",
        targetRef: "mod:sources/src/util.ts",
        outcome: "success",
      },
      evidenceRefs: [`ev:${E1}`],
    },
    localCandidateCursor: { pendingRelationRef: PENDING, state: "closed", evidenceRefs: [`ev:${E2}`] },
  };
}

test("engine rolls forward through advance(e1) then advance(e2) before any terminal judge", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-engine-"));
  try {
    const modelPath = await packagePath(root);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-rollout",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const steps = result.sampleReceipt?.steps ?? [];
    assert.equal(steps.length >= 2, true, "at least step0 and step1 must execute");
    assert.equal(steps[0]?.optionSemantics, "advance");
    assert.equal(steps[0]?.targetRef, E1);
    assert.equal(steps[0]?.postStepId, "step-1");
    assert.equal(steps[1]?.targetRef, E2);
    assert.equal(steps[0]?.receipt?.receiptId, steps[1]?.previousExecutionReceiptId);
    assert.notEqual(steps[0]?.receipt?.receiptId, steps[1]?.receipt?.receiptId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sample-level receipt never reuses a future receipt as previousExecution", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-receipt-"));
  try {
    const modelPath = await packagePath(root);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-receipt",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
    });
    const steps = result.sampleReceipt?.steps ?? [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const previousIds = steps.slice(0, index).map(item => item.receipt?.receiptId);
      if (step.previousExecutionReceiptId !== null) {
        assert.equal(
          previousIds.includes(step.previousExecutionReceiptId),
          true,
          `step ${index} previousExecution must come from an executed earlier step`,
        );
      }
      assert.equal(step.outcome, "success");
      assert.ok(step.actionRef);
      assert.ok(step.receipt?.receiptRef || step.receipt?.receiptId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
