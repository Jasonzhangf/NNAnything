import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { forwardUnifiedScore, zeroTensors } from "../dist/training/unified-forward.js";
// The multi-step consumer must drive every step from one runRecursiveGoal
// invocation, and must require a real executor instead of a synthetic success.
import { runTsJsUnifiedMultiStepDecision } from "../dist/adapters/tsjs-unified-recursive.js";
import { encodeUnifiedCandidateGroup } from "../dist/training/unified-encoder.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";

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
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

async function packagePath(dir) {
  await writeFile(join(dir, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`);
  await writeFile(join(dir, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`);
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), advancePackage());
}

function controlPackage() {
  const tensors = zeroTensors();
  // x[52] is the `candidateKind === "control"` slot.
  tensors.W1[52] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-multistep-control",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors,
    resources: {
      thresholdsRef: RESOURCE_NAMES.thresholds,
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: RESOURCE_NAMES.missingMode,
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

function judgePackage() {
  const tensors = zeroTensors();
  // x[36] is the `judge=true` terminal semantic slot.
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-multistep-judge",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors,
    resources: {
      thresholdsRef: RESOURCE_NAMES.thresholds,
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: RESOURCE_NAMES.missingMode,
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

function previousAwarePackage() {
  const tensors = zeroTensors();
  // The action candidate scores only when the action-context slot x[16] is
  // present together with the action candidate slot x[53]. The control
  // candidate gets a fixed positive score, so removing previousExecution
  // changes the selected candidate from advance to DEFER.
  tensors.W1[0 * 64 + 16] = 1;
  tensors.W1[0 * 64 + 53] = 1;
  tensors.b1[0] = -1;
  tensors.W1[1 * 64 + 52] = 1;
  tensors.W2[0 * 64 + 0] = 1;
  tensors.W2[1 * 64 + 1] = 1;
  tensors.W3[0] = 2;
  tensors.W3[1] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-multistep-previous-aware",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors,
    resources: {
      thresholdsRef: RESOURCE_NAMES.thresholds,
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: RESOURCE_NAMES.missingMode,
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

async function packagePathFor(dir, model) {
  await writeFile(join(dir, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`);
  await writeFile(join(dir, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`);
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), model());
}

const E1 = "edge:sources/src/entry.ts:import:0";
const E2 = "edge:sources/src/util.ts:reexport:0";
const PENDING = "pending:alias-sample";
const DECOY_ACTION_REF = "action:decoy-should-be-overwritten";
const REAL_PREVIOUS_ACTION_REF = "action:real-step0-injected";

function chooseHighest(context, tensors) {
  const encoded = encodeUnifiedCandidateGroup(context, THRESHOLDS);
  const scored = encoded.map(result => {
    const candidate = context.candidateGroup.candidates.find(
      item => item.candidateRef === result.candidateRef,
    );
    assert.ok(candidate);
    return { candidate, score: forwardUnifiedScore(result.vector, tensors) };
  });
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidate.candidateRef.localeCompare(right.candidate.candidateRef);
  });
  return scored[0];
}

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
      edgeKind: "re_export",
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
    // Decoy pre-set previousExecution. The engine must overwrite every value
    // here with the real receipt from the executed step-0 advance.
    previousExecution: {
      state: "known",
      value: {
        actionRef: DECOY_ACTION_REF,
        receiptRef: "receipt:decoy-should-be-overwritten",
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

/**
 * Explicit synthetic executor. It records every call so the test can prove the
 * advance reads ran through the injected executor.
 */
function recordingExecutor({ fail = null } = {}) {
  const calls = [];
  const read = async (input) => {
    calls.push(input);
    if (fail !== null && input.edgeRef === fail) {
      return {
        outcome: "failed",
        observedFacts: [],
        evidenceRefs: [],
        coverage: null,
        failure: { code: "ENOENT", message: `missing ${input.moduleRef}`, nativeCode: "ENOENT" },
      };
    }
    const moduleFacts = [];
    if (input.edgeRef === E1) {
      moduleFacts.push({
        kind: "import",
        moduleRef: "sources/src/entry.ts",
        name: "helper",
        sourceName: "helper",
        localName: "helper",
        exportedAlias: null,
        moduleSpecifierRaw: "./util",
        resolvedModuleRef: "sources/src/util.ts",
        sourceTargetRef: "mod:sources/src/util.ts#top:helper",
        legacyFacts: ["import:helper as helper<-./util"],
      });
      moduleFacts.push({
        kind: "re_export",
        moduleRef: "sources/src/util.ts",
        name: "helper",
        sourceName: "helper",
        localName: "helper",
        exportedAlias: "helper",
        moduleSpecifierRaw: "./impl",
        resolvedModuleRef: "sources/src/impl.ts",
        sourceTargetRef: "mod:sources/src/impl.ts#top:helper",
        legacyFacts: ["export:helper", "reexport:helper<-./impl"],
      });
    } else if (input.edgeRef === E2) {
      moduleFacts.push({
        kind: "declaration",
        moduleRef: "sources/src/impl.ts",
        name: "helper",
        sourceName: null,
        localName: null,
        exportedAlias: null,
        moduleSpecifierRaw: null,
        resolvedModuleRef: null,
        sourceTargetRef: "mod:sources/src/impl.ts#top:helper",
        legacyFacts: ["decl:helper"],
      });
      moduleFacts.push({
        kind: "export",
        moduleRef: "sources/src/impl.ts",
        name: "helper",
        sourceName: "helper",
        localName: "helper",
        exportedAlias: "helper",
        moduleSpecifierRaw: null,
        resolvedModuleRef: null,
        sourceTargetRef: "mod:sources/src/impl.ts#top:helper",
        legacyFacts: ["export:helper"],
      });
    }
    return {
      outcome: "success",
      observedFacts: [
        `real-read:${input.moduleRef ?? input.stepId}`,
        "decl:helper",
        "export:helper",
      ],
      moduleFacts,
      evidenceRefs: [`ev:executor:${input.stepId}:${input.edgeRef ?? "none"}`],
      coverage: { modules: [input.moduleRef ?? ""], targetModuleReached: true, note: null },
      failure: null,
    };
  };
  return { executor: { read, observe: read }, calls };
}

test("one invocation drives advance(e1) then advance(e2) through the real executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-engine-"));
  try {
    const modelPath = await packagePath(root);
    const { executor, calls } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-rollout",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
      executor,
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
    // The executor actually ran the advance reads against the real step inputs.
    assert.equal(calls.length >= 2, true, "each advance must invoke the executor read");
    assert.equal(calls[0]?.edgeRef, E1);
    assert.equal(calls[1]?.edgeRef, E2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previousExecution feeds the next step input from the real receipt, not the pre-set value", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-previous-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-previous",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
      executor,
    });
    const stepResults = result.steps ?? [];
    assert.equal(stepResults.length >= 2, true);
    const step0Result = stepResults[0];
    const step1Result = stepResults[1];
    // The engine's second step consumed the real receipt actionRef, not the
    // decoy the episode carried.
    assert.equal(step1Result?.previousActionRef, step0Result?.executionReceipt?.actionRef);
    assert.notEqual(step1Result?.previousActionRef, DECOY_ACTION_REF);
    assert.equal(stepResults[0]?.previousActionRef, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previousExecution changes the next encoded decision when changed or removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-previous-decision-"));
  try {
    const modelPath = await packagePathFor(root, previousAwarePackage);
    const loaded = await import("../dist/training/unified-model-package.js")
      .then(module => module.loadUnifiedModelPackageFromFile(modelPath));
    const binding = loaded.bind();
    const withPrevious = relationStepContext({
      ...step1(),
      previousExecution: {
        state: "known",
        value: {
          actionRef: REAL_PREVIOUS_ACTION_REF,
          receiptRef: "receipt:real-step0-injected",
          origin: "model_execution",
          fromStepId: "step-0",
          pendingRelationRef: PENDING,
          optionSemantics: "advance",
          targetRef: "mod:sources/src/util.ts",
          outcome: "success",
        },
        evidenceRefs: [`ev:${E1}`],
      },
    });
    const withoutPrevious = relationStepContext({
      ...step1(),
      previousExecution: undefined,
    });
    assert.equal(withPrevious.action.previousActionRef, REAL_PREVIOUS_ACTION_REF);
    assert.equal(withoutPrevious.action.previousActionRef, null);
    const previousChoice = chooseHighest(withPrevious, binding.tensors);
    const absentChoice = chooseHighest(withoutPrevious, binding.tensors);
    assert.equal(previousChoice.candidate.optionSemantics, "advance");
    assert.notEqual(absentChoice.candidate.optionSemantics, "advance");
    assert.equal(absentChoice.candidate.optionSemantics, "DEFER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a next episode without previousExecution receives the real previous receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-injected-previous-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-injected-previous",
      packagePath: modelPath,
      episodes: [{ ...step0() }, { ...step1(), previousExecution: undefined }],
      grantedEffects: ["read_only"],
      executor,
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    assert.deepEqual(
      result.sampleReceipt?.steps.map(step => step.stepId),
      ["step-0", "step-1"],
    );
    assert.equal(
      result.steps[1]?.previousActionRef,
      result.steps[0]?.executionReceipt?.actionRef,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("episode array order and stepId order do not drive the next step", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-order-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-order",
      packagePath: modelPath,
      episodes: [step1(), step0()],
      grantedEffects: ["read_only"],
      executor,
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    assert.deepEqual(
      result.sampleReceipt?.steps.map(step => step.stepId),
      ["step-0", "step-1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request limits are cumulative across the single rollout", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-limits-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-limits",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
      executor,
      limits: { maxTransitions: 1 },
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    assert.equal(result.recursiveGoal.report.control.outcome, "exceeded");
    assert.equal(result.recursiveGoal.report.control.stopReason, "budget");
    assert.equal(result.recursiveGoal.report.control.budget?.dimension, "maxTransitions");
    assert.equal(
      (result.sampleReceipt?.steps ?? []).length < 2,
      true,
      "one cumulative maxTransitions budget cannot complete both steps",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sample-level receipt never reuses a future receipt as previousExecution", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-receipt-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor();
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-receipt",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
      executor,
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

test("advance without an injected executor fails with a typed executor-missing error", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-noexec-"));
  try {
    const modelPath = await packagePath(root);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-noexec",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const report = result.recursiveGoal.report;
    assert.equal(report.control.outcome, "error");
    const diagnostics = report.errors;
    assert.equal(
      diagnostics.some(item => String(item.diagnosticMessage).includes("EXECUTOR_MISSING")),
      true,
      "the failure must be the typed executor-missing error",
    );
    assert.equal((result.sampleReceipt?.steps ?? []).length, 0, "no step may claim success without a reader");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RETURN stops the rollout after one step instead of taking the next array item", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-return-"));
  try {
    const modelPath = await packagePathFor(root, controlPackage);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-return",
      packagePath: modelPath,
      episodes: [{ ...step0(), remainingObligations: [] }, step1()],
      grantedEffects: ["read_only"],
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const steps = result.sampleReceipt?.steps ?? [];
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.optionSemantics, "RETURN");
    assert.equal(result.recursiveGoal.report.control.outcome, "stalled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DEFER stops the rollout after one step instead of taking the next array item", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-defer-"));
  try {
    const modelPath = await packagePathFor(root, controlPackage);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-defer",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const steps = result.sampleReceipt?.steps ?? [];
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.optionSemantics, "DEFER");
    assert.equal(result.recursiveGoal.report.control.outcome, "stalled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a judge action without real read evidence does not satisfy the request root", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-judge-root-"));
  try {
    const modelPath = await packagePathFor(root, judgePackage);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-judge-root",
      packagePath: modelPath,
      episodes: [{ ...step0(), remainingObligations: [] }, step1()],
      grantedEffects: ["read_only"],
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const steps = result.sampleReceipt?.steps ?? [];
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.optionSemantics, "judge=true");
    assert.equal(steps[0]?.outcome, "success");
    assert.notEqual(result.rootEvaluation.result, "satisfied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cross-request next episode is rejected, not silently adopted", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-cross-request-"));
  try {
    const modelPath = await packagePath(root);
    await assert.rejects(
      () => runTsJsUnifiedMultiStepDecision({
        requestId: "multistep-cross-request",
        packagePath: modelPath,
        episodes: [step0(), { ...step1(), requestId: "request:other-request" }],
        grantedEffects: ["read_only"],
        executor: recordingExecutor().executor,
      }),
      /must belong to one request/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incompatible next-step target is rejected, not silently adopted", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-incompatible-"));
  try {
    const modelPath = await packagePath(root);
    const incompatible = {
      ...step1(),
      previousExecution: {
        ...step1().previousExecution,
        value: {
          ...step1().previousExecution.value,
          targetRef: "mod:sources/src/other.ts",
        },
      },
    };
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-incompatible",
      packagePath: modelPath,
      episodes: [step0(), incompatible],
      grantedEffects: ["read_only"],
      executor: recordingExecutor().executor,
    });
    assert.equal(result.recursiveGoal.report.control.outcome, "error");
    assert.equal(
      result.recursiveGoal.report.errors.some(item =>
        String(item.diagnosticMessage).includes("incompatible previousExecution"),
      ),
      true,
    );
    assert.equal((result.sampleReceipt?.steps ?? []).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real read failure is surfaced and never swallowed as success", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-1-multistep-readfail-"));
  try {
    const modelPath = await packagePath(root);
    const { executor } = recordingExecutor({ fail: E1 });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "multistep-readfail",
      packagePath: modelPath,
      episodes: [step0(), step1()],
      grantedEffects: ["read_only"],
      executor,
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    assert.equal(result.recursiveGoal.report.control.outcome, "error");
    const fail = (result.sampleReceipt?.steps ?? []).find(step => step.outcome === "failed");
    assert.ok(fail, "the failed step must be reported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
