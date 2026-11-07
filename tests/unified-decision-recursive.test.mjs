import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_INCOMPATIBLE,
  MODEL_NOT_FOUND,
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  runTsJsUnifiedDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";

const RESOURCE_NAMES = {
  thresholds: "feature-thresholds.json",
  missingMode: "missing-mode.json",
};

const THRESHOLDS = {
  schema: "nnanything.feature-thresholds.v1",
  route: "r",
  encoderVersion: "nnanything.unified-step.encoder.v1",
  buckets: {
    constraints: [0, 1, 2, 4],
    knownFacts: [1, 2, 4, 8],
    missingFacts: [0, 1, 2, 4],
    objectRefs: [1, 2, 4, 8],
    requiredArgsRatio: [0, 0.25, 0.5, 1],
    requiredMissing: [0, 1, 2, 4],
  },
};

const MISSING_MODE = {
  schema: "nnanything.unified.missing-mode.v1",
  entries: [],
};

function packageFor(route = { domain: "tsjs", decisionKind: "R" }) {
  const tensors = zeroTensors();
  // Synthetic package: x[36] is the `judge=true` slot, so the forward path
  // deterministically prefers it over the other judge candidates.
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-decision-synthetic",
    version: "1",
    route,
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

async function writeResources(dir) {
  await writeFile(join(dir, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`);
  await writeFile(join(dir, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`);
}

async function packagePath(dir, pkg = packageFor()) {
  await writeResources(dir);
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
}

function episode(overrides = {}) {
  return {
    sampleId: "decision-sample",
    stepId: "step:0",
    requestId: "decision-request",
    sourceGroup: "unified-decision-synthetic",
    language: "typescript",
    semanticStratum: "relation",
    partition: "verification",
    entryFile: "src/entry.ts",
    targetRef: "decl:target",
    observedFacts: ["synthetic observation"],
    pendingRelationRef: "relation:target",
    callSiteRef: "call:target",
    requestedDeclaration: {
      declarationRef: "decl:target",
      moduleRef: "src/entry.ts",
      name: "target",
      role: "local",
      kind: "function",
      evidenceRefs: ["tsjs:evidence"],
    },
    observedBindings: [],
    observedDeclarations: [],
    evidenceRefs: ["tsjs:evidence"],
    failureMode: null,
    derivationFamily: "synthetic",
    adapterRef: "test",
    ...overrides,
  };
}

test("public consumer loads and binds one compatible package", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-load-"));
  const modelPath = await packagePath(root);
  const result = await runTsJsUnifiedDecision({
    requestId: "load-once",
    packagePath: modelPath,
    episode: episode(),
    grantedEffects: ["read_only"],
  });

  assert.equal(result.modelBinding.modelId, "unified-decision-synthetic");
  assert.equal(result.modelBinding.version, "1");
  assert.equal(result.recursiveGoal.kind, "run_result");
});
test("wrong package route returns MODEL_INCOMPATIBLE before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-route-"));
  const modelPath = await packagePath(
    root,
    packageFor({ domain: "rust", decisionKind: "R" }),
  );

  await assert.rejects(
    () => runTsJsUnifiedDecision({
      requestId: "wrong-route",
      packagePath: modelPath,
      episode: episode(),
      grantedEffects: ["read_only"],
    }),
    error => error.code === MODEL_INCOMPATIBLE,
  );
});

test("missing model returns MODEL_NOT_FOUND", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-missing-"));
  await assert.rejects(
    () => runTsJsUnifiedDecision({
      requestId: "missing-model",
      packagePath: join(root, "absent.json"),
      episode: episode(),
      grantedEffects: ["read_only"],
    }),
    error => error.code === MODEL_NOT_FOUND,
  );
});

test("choice, execution receipt, post-state, and root evaluation stay distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-fields-"));
  const modelPath = await packagePath(root);
  const result = await runTsJsUnifiedDecision({
    requestId: "separate-fields",
    packagePath: modelPath,
    episode: episode(),
    grantedEffects: ["read_only"],
  });

  assert.ok(Object.hasOwn(result, "candidateChoice"));
  assert.ok(Object.hasOwn(result, "executionReceipt"));
  assert.ok(Object.hasOwn(result, "observedPostState"));
  assert.ok(Object.hasOwn(result, "rootEvaluation"));
  assert.equal(result.candidateChoice.optionSemantics, "judge=true");
  assert.notEqual(result.candidateChoice, result.executionReceipt);
  assert.notEqual(result.executionReceipt, result.observedPostState);
  assert.notEqual(result.observedPostState, result.rootEvaluation);
  assert.equal(result.executionReceipt.action, "submit_terminal_judgement");
  assert.equal(result.executionReceipt.candidateRef, result.candidateChoice.candidateRef);
  assert.equal(result.observedPostState.candidateRef, result.candidateChoice.candidateRef);
  assert.equal(result.observedPostState.terminalJudgement, "judge=true");
  assert.equal(result.observedPostState.postStateRef, result.observedPostState.stateRef);
  assert.equal(result.rootEvaluation.state, "evaluated");
  assert.equal(result.rootEvaluation.result, "satisfied");
  assert.equal(result.rootEvaluation.satisfaction, 100);
  assert.equal(result.rootEvaluation.evidenceRefs.length > 0, true);
});

test("structural root stays incomplete when the atomic post-state has no decision evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-no-evidence-"));
  const modelPath = await packagePath(root);
  const result = await runTsJsUnifiedDecision({
    requestId: "no-post-evidence",
    packagePath: modelPath,
    episode: episode({ evidenceRefs: [] }),
    grantedEffects: ["read_only"],
  });

  assert.notEqual(result.rootEvaluation.state, "not_evaluated");
  assert.notEqual(result.rootEvaluation.result, "satisfied");
  assert.equal(result.rootEvaluation.satisfaction, null);
});

test("synthetic episode mechanics never read supervision fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-supervision-"));
  const modelPath = await packagePath(root);
  const forbiddenReads = new Set(["goldAction", "originalGold", "label", "headSupervision"]);
  const rawEpisode = episode({
    goldAction: "judge=false",
    originalGold: "false",
    label: "false",
    headSupervision: { R: { label: "false" } },
  });
  const guardedEpisode = new Proxy(rawEpisode, {
    get(target, property, receiver) {
      if (typeof property === "string" && forbiddenReads.has(property)) {
        throw new Error(`supervision leak: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const result = await runTsJsUnifiedDecision({
    requestId: "no-supervision",
    packagePath: modelPath,
    episode: guardedEpisode,
    grantedEffects: ["read_only"],
  });

  assert.equal(result.candidateChoice.optionSemantics, "judge=true");
  assert.equal(result.recursiveGoal.kind, "run_result");
});

test("public selection is score argmax only, with no external override field", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-decision-acceptance-"));
  const modelPath = await packagePath(root);
  const result = await runTsJsUnifiedDecision({
    requestId: "no-acceptance-override",
    packagePath: modelPath,
    episode: episode(),
    grantedEffects: ["read_only"],
  });

  assert.equal(result.candidateChoice.optionSemantics, "judge=true");
});
