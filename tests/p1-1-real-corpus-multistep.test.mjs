import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  loadStepwiseEpisodeFamily as loadStudentFamily,
} from "../dist/training/unified-student-converter.js";
import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";

const here = new URL(".", import.meta.url);
const RUN_ROOT = "/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031";
const CORPUS_ROOT = join(
  RUN_ROOT,
  ".worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/corpus",
);
const FAMILY = "train-module-export-alias-a";
const STAGED_ROOT = "/Volumes/Intel/playground/nnanything-runs/p1-1-typed-dynamic-recursive-20261107/staged";

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

async function writeModel(root) {
  const tensors = zeroTensors();
  // x[53] is the candidateKind === "action" slot; the deterministic synthetic
  // package advances until the chain is exhausted.
  tensors.W1[53] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  await writeFile(join(root, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`, "utf8");
  await writeFile(join(root, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`, "utf8");
  return saveUnifiedModelPackageAtomic(join(root, "package.json"), createUnifiedModelPackage({
    modelId: "real-corpus-multistep-probe",
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
  }));
}

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("real corpus advance reads the actual module files and feeds previous execution", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-"));
  try {
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    assert.equal(episodes.length > 0, true, "the staged family must contain at least one episode");
    const positive = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    assert.equal(positive.length >= 3, true, "the positive chain must have three episodes");
    const target = positive.find(episode => episode.stepId === "step-0");
    assert.ok(target);
    assert.equal(target.sampleId, "a-module-positive-alias");
    const stagedEpisode = positive.find(episode => episode.stepId === "step-1");
    const terminalEpisode = positive.find(episode => episode.stepId === "step-2");
    assert.ok(stagedEpisode);
    assert.ok(terminalEpisode);
    assert.equal(stagedEpisode.previousExecution?.value?.fromStepId, "step-0");
    const modelPath = await writeModel(work);
    const executor = createTsJsFileBackedStepExecutor({
      sourceRoot: join(CORPUS_ROOT, FAMILY),
    });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-multistep-advance",
      packagePath: modelPath,
      episodes: [target, stagedEpisode, terminalEpisode],
      grantedEffects: ["read_only"],
      executor,
    });
    assert.equal(result.recursiveGoal.kind, "run_result");
    const report = result.recursiveGoal.report;
    assert.equal(report.control.outcome, "completed");
    const executedSteps = result.sampleReceipt?.steps ?? [];
    assert.equal(executedSteps.length >= 3, true, "the real chain must execute the full positive sample");
    assert.equal(executedSteps[0]?.receipt?.receiptId, executedSteps[1]?.previousExecutionReceiptId);
    assert.equal(result.steps[1]?.previousActionRef, result.steps[0]?.executionReceipt?.actionRef);
    const firstReadFacts = result.steps[0]?.observedPostState.observedFacts ?? [];
    const secondReadFacts = result.steps[1]?.observedPostState.observedFacts ?? [];
    assert.equal(firstReadFacts.includes("file:sources/src/util.ts"), true);
    assert.equal(firstReadFacts.some(fact => fact.startsWith("reexport:forwarded<-")), true);
    assert.equal(secondReadFacts.includes("file:sources/src/impl.ts"), true);
    assert.equal(secondReadFacts.includes("decl:helper"), true);
    assert.equal(report.rootEvaluation.evaluatorId, "tsjs.unified.multistep.root.evaluator");
    assert.equal(report.rootEvaluation.result, "satisfied");
    assert.equal(report.rootEvaluation.evidenceRefs.length >= 2, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a missing module read fails with a real error receipt", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-missing-"));
  try {
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    const positive = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    const target = positive.find(episode => episode.stepId === "step-0");
    const next = positive.find(episode => episode.stepId === "step-1");
    assert.ok(target);
    assert.ok(next);
    const modelPath = await writeModel(work);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-multistep-missing",
      packagePath: modelPath,
      episodes: [target, next],
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({
        sourceRoot: join(work, "missing-sources"),
      }),
    });
    assert.equal(result.recursiveGoal.report.control.outcome, "error");
    const failed = (result.sampleReceipt?.steps ?? []).find(step => step.outcome === "failed");
    assert.ok(failed, "the failed real read must surface");
    assert.equal(
      result.recursiveGoal.report.errors.some(item =>
        ["ENOENT", "MODULE_UNRESOLVED", "READ_FAILED"].some(code =>
          String(item.diagnosticMessage).includes(code),
        ),
      ),
      true,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
