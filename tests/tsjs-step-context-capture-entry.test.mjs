import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The diagnostic entry must be consumed through the public package surface.
import { runTsjsStepContextCaptureFromFile } from "nnanything/tsjs-step-context-capture";
import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONSUMER = join(
  REPO_ROOT,
  "playground",
  "training",
  "tsjs-step-context-capture",
  "run.mjs",
);

const CONFIG_SCHEMA = "nnanything.tsjs.step-context-capture-config.v1";
const SOURCE_GROUP = "tsjs-synthetic-retention-stepctx";
const PARTITION = "verification";
const LANGUAGE = "ts";
const PENDING = "pending:synthetic-retention-stepctx";
const EDGE = "edge:sources/entry.ts:import:0";

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

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function observationBinding() {
  return {
    edgeRef: EDGE,
    callSiteRef: null,
    fromNodeRef: `syntax:${EDGE}`,
    edgeKind: "import",
    sourceName: "forwarded",
    sourceModule: {
      state: "known",
      value: "mod:sources/util.ts",
      reason: null,
      evidenceRefs: [`ev:${EDGE}`],
    },
    targetName: "helper",
    targetModule: {
      state: "known",
      value: "mod:sources/entry.ts",
      reason: null,
      evidenceRefs: [`ev:${EDGE}`],
    },
    moduleSpecifierRaw: "./util",
    sourceContent: {
      state: "not_requested",
      resultRefs: [],
      reason: null,
      evidenceRefs: [`ev:${EDGE}`],
    },
    visibility: {
      state: "known",
      value: "reachable",
      reason: null,
      evidenceRefs: [`ev:${EDGE}`],
    },
    hopDepth: 0,
    evidenceRefs: [`ev:${EDGE}`],
  };
}

function stepZero() {
  return {
    stepId: "step-0",
    observedAt: "current-step",
    localSyntax: {
      observedBindings: [observationBinding()],
      observedDeclarations: [],
      observedLocalFacts: [],
      moduleSpecifierRaw: "./util",
      sourceContent: {
        state: "not_requested",
        resultRefs: [],
        reason: null,
        evidenceRefs: [`ev:${EDGE}`],
      },
      shadowFacts: [],
    },
    remainingObligations: [{
      kind: "advance",
      ref: EDGE,
      pendingRelationRef: PENDING,
      skillRef: "skill:relation.read",
      arguments: [{ name: "target", type: "binding_edge", valueRef: EDGE }],
      informationGain: {
        state: "known",
        value: "advances_chain",
        reason: null,
        evidenceRefs: [`ev:${EDGE}`],
      },
      evidenceRefs: [`ev:${EDGE}`],
    }],
    receipts: [],
    localCandidateCursor: {
      pendingRelationRef: PENDING,
      state: "closed",
      evidenceRefs: [`ev:${EDGE}`],
    },
    coverage: null,
    notReady: false,
  };
}

function stepOne() {
  const binding = {
    ...observationBinding(),
    sourceContent: {
      state: "observed",
      resultRefs: [],
      reason: null,
      evidenceRefs: [`ev:${EDGE}`],
    },
  };
  return {
    stepId: "step-1",
    observedAt: "current-step",
    localSyntax: {
      observedBindings: [binding],
      observedDeclarations: [],
      observedLocalFacts: [],
      moduleSpecifierRaw: "./util",
      sourceContent: {
        state: "observed",
        resultRefs: [],
        reason: null,
        evidenceRefs: [`ev:${EDGE}`],
      },
      shadowFacts: [],
    },
    remainingObligations: [],
    receipts: [],
    localCandidateCursor: {
      pendingRelationRef: PENDING,
      state: "closed",
      evidenceRefs: [`ev:${EDGE}`],
    },
    coverage: null,
    notReady: false,
  };
}

function studentRecord(sampleId) {
  const requestRef = `request:${sampleId}`;
  return {
    schemaVersion: "carol-tsjs-fixed-stepwise-student-v1",
    sampleId,
    family: "synthetic-retention-stepctx",
    sourceGroup: SOURCE_GROUP,
    partition: PARTITION,
    language: LANGUAGE,
    semanticStratum: "module_export",
    entryFile: "sources/entry.ts",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: {
          state: "known",
          value: "decl:sources/impl.ts#top:helper",
          reason: null,
          evidenceRefs: [],
        },
        moduleRef: {
          state: "known",
          value: "mod:sources/impl.ts",
          reason: null,
          evidenceRefs: [],
        },
        name: { state: "known", value: "helper", reason: null, evidenceRefs: [] },
        kind: { state: "known", value: "function", reason: null, evidenceRefs: [] },
        sourceTargetRef: "sources/impl.ts#top:helper",
      },
      relationObligation: {
        requestRef,
        callSiteRef: "call:sources/entry.ts:helper",
        calleeName: "helper",
        pendingRelationRef: PENDING,
      },
    },
    steps: [stepZero(), stepOne()],
  };
}

async function writeSyntheticFamily(root, sampleId) {
  const familyDir = join(root, "family");
  await mkdir(join(familyDir, "sources"), { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    sourceGroup: SOURCE_GROUP,
    language: LANGUAGE,
    semanticStratum: "module_export",
    partition: PARTITION,
    derivationFamily: { familyId: "tsjs-synthetic-retention-stepctx" },
  });
  await writeFile(
    join(familyDir, "student-observations.jsonl"),
    `${JSON.stringify(studentRecord(sampleId))}\n`,
    "utf8",
  );
  await writeFile(
    join(familyDir, "sources", "entry.ts"),
    'import { forwarded as helper } from "./util";\n'
    + 'export function main(): number {\n  return helper();\n}\n',
    "utf8",
  );
  await writeFile(
    join(familyDir, "sources", "util.ts"),
    'export { helper as forwarded } from "./impl";\n',
    "utf8",
  );
  await writeFile(
    join(familyDir, "sources", "impl.ts"),
    'export function helper(): number {\n  return 1;\n}\n',
    "utf8",
  );
  return familyDir;
}

function advancePackage() {
  const tensors = zeroTensors();
  // x[53] is the `candidateKind === "action"` slot, so the deterministic
  // synthetic package advances the chain at step-0 and falls back to a
  // zero-score tie (judge=false) at the terminal step-1.
  tensors.W1[53] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "synthetic-retention-stepctx",
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

async function writePackage(root) {
  const modelDir = join(root, "model");
  await mkdir(modelDir, { recursive: true });
  await writeJson(join(modelDir, RESOURCE_NAMES.thresholds), THRESHOLDS);
  await writeJson(join(modelDir, RESOURCE_NAMES.missingMode), MISSING_MODE);
  return saveUnifiedModelPackageAtomic(join(modelDir, "package.json"), advancePackage());
}

async function writeConfig(root, payload, name = "entry-config.json") {
  const path = join(root, name);
  await writeJson(path, payload);
  return path;
}

test("public capture records the real per-step context, candidate vectors, and receipt chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-step-context-capture-"));
  try {
    const sampleId = "synthetic-retention-sample";
    const familyPath = await writeSyntheticFamily(root, sampleId);
    const packagePath = await writePackage(root);
    const outputPath = join(root, "capture.json");
    const configPath = await writeConfig(root, {
      schema: CONFIG_SCHEMA,
      packagePath,
      familyPath,
      sampleId,
      outputPath,
    });

    const result = await runTsjsStepContextCaptureFromFile(configPath);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.sampleId, sampleId);
    assert.equal(result.captureCount >= 2, true, `expected >= 2 captures, got ${result.captureCount}`);
    assert.equal(result.stepCount >= 2, true);

    const receipt = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.captures.length, result.captureCount);
    assert.equal(receipt.schema, "nnanything.tsjs.step-context-capture-receipt.v1");

    for (const capture of receipt.captures) {
      assert.equal(capture.sampleId, sampleId);
      assert.equal(capture.requestId, `request:${sampleId}`);
      assert.equal(capture.package.packagePath, packagePath);
      assert.equal(typeof capture.context.stepId, "string");
      assert.equal(capture.context.candidateGroup.enumeration, "complete");
      assert.equal(capture.candidates.length, capture.context.candidateGroup.candidates.length);
      for (const candidate of capture.candidates) {
        assert.equal(candidate.vector.length, 64);
        assert.equal(candidate.vector.every(value => Number.isFinite(value)), true);
      }
      const chosen = capture.candidates.find(candidate =>
        candidate.candidateRef === capture.chosen.candidateRef);
      assert.ok(chosen, `chosen ${capture.chosen.candidateRef} must be a captured legal candidate`);
      assert.equal(chosen.skillRef, capture.chosen.skillRef);
      assert.equal(Number.isFinite(capture.chosen.score), true);
    }

    assert.equal(receipt.captures[0].priorStep, null);
    const stepZeroReceipt = receipt.steps[0].executionReceipt;
    const secondCapture = receipt.captures[1];
    assert.equal(secondCapture.stepId, "step-1");
    assert.equal(secondCapture.priorStep.stepId, "step-0");
    assert.equal(secondCapture.priorStep.receiptRef, stepZeroReceipt.receiptId);
    assert.equal(secondCapture.priorStep.actionRef, stepZeroReceipt.actionRef);
    assert.equal(secondCapture.priorStep.postStateRef, stepZeroReceipt.postStateRef);
    assert.equal(secondCapture.context.action.previousActionRef, stepZeroReceipt.actionRef);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline decision without the observer matches the observed capture run", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-step-context-capture-baseline-"));
  try {
    const sampleId = "synthetic-retention-baseline";
    const familyPath = await writeSyntheticFamily(root, sampleId);
    const packagePath = await writePackage(root);
    const outputPath = join(root, "capture.json");
    const configPath = await writeConfig(root, {
      schema: CONFIG_SCHEMA,
      packagePath,
      familyPath,
      sampleId,
      outputPath,
    });

    const observed = await runTsjsStepContextCaptureFromFile(configPath);
    assert.equal(observed.status, "completed", JSON.stringify(observed));
    const receipt = JSON.parse(await readFile(outputPath, "utf8"));

    const { loadStepwiseEpisodeFamily } = await import(
      "../dist/training/unified-student-converter.js"
    );
    const episodes = await loadStepwiseEpisodeFamily(familyPath);
    const baseline = await runTsJsUnifiedMultiStepDecision({
      requestId: `request:${sampleId}`,
      packagePath,
      episodes,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: familyPath }),
    });

    assert.equal(
      JSON.stringify(receipt.steps),
      JSON.stringify(baseline.steps),
      "the observer must not change the bounded decision result",
    );
    assert.equal(receipt.steps.length >= 2, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public capture returns a typed failure for an invalid config", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-step-context-capture-negative-"));
  try {
    const configPath = await writeConfig(root, {
      schema: "nnanything.tsjs.step-context-capture-config.invalid",
      packagePath: "missing-package.json",
      familyPath: "missing-family",
      sampleId: "missing-sample",
      outputPath: join(root, "out.json"),
    });
    const result = await runTsjsStepContextCaptureFromFile(configPath);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "CONFIG_INVALID");
    assert.equal(typeof result.error.message, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public consumer exits 0 on success and 1 on a typed failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-step-context-capture-consumer-"));
  try {
    const sampleId = "synthetic-retention-consumer";
    const familyPath = await writeSyntheticFamily(root, sampleId);
    const packagePath = await writePackage(root);
    const configPath = await writeConfig(root, {
      schema: CONFIG_SCHEMA,
      packagePath,
      familyPath,
      sampleId,
      outputPath: join(root, "capture.json"),
    });

    const success = spawnSync(process.execPath, [CONSUMER, configPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    const successResult = JSON.parse(success.stdout);
    assert.equal(successResult.status, "completed");
    assert.equal(successResult.captureCount >= 2, true);

    const invalidConfig = await writeConfig(root, {
      schema: "wrong-schema",
      packagePath,
      familyPath,
      sampleId,
      outputPath: join(root, "capture.json"),
    }, "invalid-config.json");
    const negative = spawnSync(process.execPath, [CONSUMER, invalidConfig], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(negative.status, 1, negative.stderr);
    const negativeResult = JSON.parse(negative.stdout);
    assert.equal(negativeResult.status, "failed");
    assert.equal(negativeResult.error.code, "CONFIG_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
