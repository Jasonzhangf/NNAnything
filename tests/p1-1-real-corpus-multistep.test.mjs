import assert from "node:assert/strict";
import { cp, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
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

async function writeModel(root, { preferControlAtTerminal = false } = {}) {
  const tensors = zeroTensors();
  // x[53] is the candidateKind === "action" slot; the deterministic synthetic
  // package advances until the chain is exhausted.
  tensors.W1[53] = 1;
  if (preferControlAtTerminal) {
    // At a terminal step there is no action candidate, so this selects RETURN.
    // At an earlier step the lexicographically earlier advance candidate wins
    // the equal-score tie.
    tensors.W1[52] = 1;
  }
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
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  }));
}

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function positiveEpisodes() {
  const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
  return episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
}

async function runWithReplacedUtil(requestId, utilSource) {
  const work = await mkdtemp(join(tmpdir(), `p1-1-real-corpus-${requestId}-`));
  const sourceRoot = join(work, "source-root");
  await cp(join(CORPUS_ROOT, FAMILY, "sources"), join(sourceRoot, "sources"), {
    recursive: true,
  });
  await writeFile(join(sourceRoot, "sources/src/util.ts"), utilSource, "utf8");
  const modelPath = await writeModel(work, { preferControlAtTerminal: true });
  const result = await runTsJsUnifiedMultiStepDecision({
    requestId,
    packagePath: modelPath,
    episodes: await positiveEpisodes(),
    grantedEffects: ["read_only"],
    executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
  });
  await rm(work, { recursive: true, force: true });
  return result;
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
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
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
    assert.equal(
      report.control.outcome,
      "completed",
      JSON.stringify(report.errors),
    );
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
    assert.equal(result.sampleReceipt?.steps.at(-1)?.optionSemantics, "RETURN");
    const terminalState = report.states.at(-1)?.value;
    assert.ok(terminalState);
    const importVerification = terminalState.bindingVerifications.find(verification =>
      verification.edgeRef === "edge:sources/src/entry-pos.ts:import:0"
      && verification.phase === "executed");
    assert.ok(importVerification);
    assert.deepEqual(importVerification.expectedBinding, {
      edgeKind: "import",
      containingModuleRef: "mod:sources/src/entry-pos.ts",
      sourceModuleRef: "mod:sources/src/util.ts",
      sourceName: "forwarded",
      localName: "helper",
      exportedAlias: null,
      moduleSpecifierRaw: "./util",
      sourceTargetRef: "mod:sources/src/util.ts#top:forwarded",
    });
    assert.equal(
      importVerification.matchedModuleFacts.some(fact =>
        fact.kind === "re_export"
        && fact.moduleRef === "sources/src/util.ts"
        && fact.sourceName === "helper"
        && fact.localName === "forwarded"
        && fact.exportedAlias === "forwarded"
        && fact.moduleSpecifierRaw === "./impl"
        && fact.resolvedModuleRef === "sources/src/impl.ts"),
      true,
      "the import edge must be backed by the exact source-module re-export tuple",
    );
    const reexportVerification = terminalState.bindingVerifications.find(verification =>
      verification.edgeRef === "edge:sources/src/util.ts:reexport:0"
      && verification.phase === "executed");
    assert.ok(reexportVerification);
    assert.deepEqual(reexportVerification.expectedBinding, {
      edgeKind: "re_export",
      containingModuleRef: "mod:sources/src/util.ts",
      sourceModuleRef: "mod:sources/src/impl.ts",
      sourceName: "helper",
      localName: "forwarded",
      exportedAlias: "forwarded",
      moduleSpecifierRaw: "./impl",
      sourceTargetRef: "mod:sources/src/impl.ts#top:helper",
    });
    assert.equal(
      reexportVerification.matchedModuleFacts.some(fact =>
        fact.kind === "re_export"
        && fact.moduleRef === "sources/src/util.ts"
        && fact.sourceName === "helper"
        && fact.localName === "forwarded"
        && fact.exportedAlias === "forwarded"
        && fact.moduleSpecifierRaw === "./impl"
        && fact.resolvedModuleRef === "sources/src/impl.ts"),
      true,
      "the re-export edge must carry the exact containing/source tuple",
    );
    assert.equal(
      reexportVerification.matchedModuleFacts.some(fact =>
        fact.moduleRef === "sources/src/impl.ts" && fact.name === "helper"),
      true,
      "the verified re-export edge must reach the exact target declaration module",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("file-backed executor preserves the exact import statement tuple", async () => {
  const executor = createTsJsFileBackedStepExecutor({
    sourceRoot: join(CORPUS_ROOT, FAMILY),
  });
  const result = await executor.read({
    requestId: "real-corpus-import-tuple",
    stepId: "entry-observation",
    action: "observe",
    candidateRef: "c:observe:entry-pos",
    targetRef: null,
    edgeRef: null,
    pendingRelationRef: "pending:a-module-positive-alias",
    moduleRef: "mod:sources/src/entry-pos.ts",
    specifier: null,
    fromFile: null,
    fromStepId: null,
  });
  assert.equal(result.outcome, "success");
  const importFact = result.moduleFacts?.find(fact =>
    fact.kind === "import" && fact.localName === "helper");
  assert.ok(importFact);
  assert.deepEqual(importFact, {
    kind: "import",
    moduleRef: "sources/src/entry-pos.ts",
    name: "helper",
    sourceName: "forwarded",
    localName: "helper",
    exportedAlias: null,
    moduleSpecifierRaw: "./util",
    resolvedModuleRef: "sources/src/util.ts",
    sourceTargetRef: "mod:sources/src/util.ts#top:forwarded",
    legacyFacts: ["import:forwarded as helper<-./util"],
  });
});

test("a legal unrelated read followed by RETURN does not satisfy the relation root", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-unrelated-"));
  try {
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    const positive = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    const step0 = positive.find(episode => episode.stepId === "step-0");
    const terminal = positive.find(episode => episode.stepId === "step-2");
    assert.ok(step0);
    assert.ok(terminal);
    const unrelatedBinding = {
      ...step0.observedBindings[0],
      sourceName: "helper",
      sourceModule: {
        state: "known",
        value: "mod:sources/src/other-different.ts",
        reason: null,
        evidenceRefs: ["ev:sources/src/other-different.ts:import:0"],
      },
      moduleSpecifierRaw: "./other-different",
    };
    const unrelatedStep = {
      ...step0,
      observedBindings: [unrelatedBinding],
    };
    const returnStep = {
      ...terminal,
      observedBindings: [unrelatedBinding],
      remainingObligations: [],
      previousExecution: {
        state: "known",
        value: {
          actionRef: "action:unrelated-step-0",
          receiptRef: "receipt:unrelated-step-0",
          origin: "model_execution",
          fromStepId: "step-0",
          pendingRelationRef: "pending:a-module-positive-alias",
          optionSemantics: "advance",
          targetRef: "mod:sources/src/other-different.ts",
          outcome: "success",
        },
        evidenceRefs: ["ev:sources/src/other-different.ts:read"],
      },
    };
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-unrelated-return",
      packagePath: modelPath,
      episodes: [unrelatedStep, returnStep],
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({
        sourceRoot: join(CORPUS_ROOT, FAMILY),
      }),
    });
    assert.equal(result.sampleReceipt?.steps.at(-1)?.optionSemantics, "RETURN");
    assert.equal(result.steps[0]?.observedPostState.observedFacts.includes("decl:helper"), true);
    assert.notEqual(result.rootEvaluation.result, "satisfied");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("deleted reexport facts replace preset state and leave the relation unsatisfied", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-deleted-reexport-"));
  try {
    const sourceRoot = join(work, "source-root");
    await cp(join(CORPUS_ROOT, FAMILY, "sources"), join(sourceRoot, "sources"), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, "sources/src/util.ts"),
      "export const unrelated = 1;\n",
      "utf8",
    );
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    const positive = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-deleted-reexport",
      packagePath: modelPath,
      episodes: positive,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
    });
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(terminalState.terminal, true);
    assert.equal(terminalState.terminalKind, "binding_failed");
    const failedImport = terminalState.bindingVerifications.find(verification =>
      verification.edgeRef === "edge:sources/src/entry-pos.ts:import:0"
      && verification.phase === "executed");
    assert.ok(failedImport);
    assert.equal(failedImport.verified, false);
    assert.equal(failedImport.failureReason, "source_module_does_not_export_source_name");
    assert.equal(failedImport.expectedBinding.sourceModuleRef, "mod:sources/src/util.ts");
    assert.equal(failedImport.expectedBinding.sourceName, "forwarded");
    assert.equal(failedImport.expectedBinding.localName, "helper");
    assert.equal(failedImport.expectedBinding.moduleSpecifierRaw, "./util");
    assert.deepEqual(failedImport.matchedModuleFacts, []);
    assert.notEqual(result.rootEvaluation.result, "satisfied");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("deleted target declaration leaves the relation unsatisfied", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-deleted-declaration-"));
  try {
    const sourceRoot = join(work, "source-root");
    await cp(join(CORPUS_ROOT, FAMILY, "sources"), join(sourceRoot, "sources"), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, "sources/src/impl.ts"),
      "export const otherHelper = (n: number): number => n + 100;\n",
      "utf8",
    );
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    const positive = episodes.filter(episode => episode.sampleId === "a-module-positive-alias");
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-deleted-declaration",
      packagePath: modelPath,
      episodes: positive,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
    });
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(terminalState.terminal, true);
    assert.equal(terminalState.terminalKind, "binding_failed");
    const failedReexport = terminalState.bindingVerifications.find(verification =>
      verification.edgeRef === "edge:sources/src/util.ts:reexport:0"
      && verification.phase === "executed");
    assert.ok(failedReexport);
    assert.equal(failedReexport.verified, false);
    assert.equal(failedReexport.failureReason, "source_module_declaration_missing");
    assert.equal(failedReexport.expectedBinding.containingModuleRef, "mod:sources/src/util.ts");
    assert.equal(failedReexport.expectedBinding.sourceModuleRef, "mod:sources/src/impl.ts");
    assert.equal(failedReexport.expectedBinding.sourceName, "helper");
    assert.equal(failedReexport.expectedBinding.localName, "forwarded");
    assert.equal(failedReexport.expectedBinding.exportedAlias, "forwarded");
    assert.equal(failedReexport.expectedBinding.moduleSpecifierRaw, "./impl");
    assert.equal(
      result.steps.some(step => step.observedPostState.observedFacts.includes("decl:helper")),
      false,
    );
    assert.notEqual(result.rootEvaluation.result, "satisfied");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("RETURN without any valid read evidence does not satisfy the relation root", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-no-evidence-"));
  try {
    const episodes = await loadStudentFamily(join(STAGED_ROOT, FAMILY));
    const terminal = episodes.find(episode =>
      episode.sampleId === "a-module-positive-alias" && episode.stepId === "step-2");
    assert.ok(terminal);
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-no-evidence",
      packagePath: modelPath,
      episodes: [{ ...terminal, remainingObligations: [] }],
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({
        sourceRoot: join(CORPUS_ROOT, FAMILY),
      }),
    });
    assert.equal(result.sampleReceipt?.steps[0]?.optionSemantics, "RETURN");
    assert.notEqual(result.rootEvaluation.result, "satisfied");
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

test("same-name local definition does not replace the re-export binding", async () => {
  const result = await runWithReplacedUtil(
    "real-corpus-same-name-local-replaces-reexport",
    "export function forwarded() { return 0; }\n",
  );
  assert.notEqual(result.rootEvaluation.result, "satisfied");
  const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
  assert.ok(terminalState);
  assert.equal(
    terminalState.bindingVerifications.some(verification =>
      verification.edgeRef === "edge:sources/src/util.ts:reexport:0"
      && !verification.verified),
    true,
    "the failed re-export edge identity must be recorded",
  );
});

test("wrong exported alias does not satisfy the re-export binding", async () => {
  const result = await runWithReplacedUtil(
    "real-corpus-wrong-reexport-alias",
    [
      "export function forwarded() { return 0; }",
      'export { helper as renamed } from "./impl";',
      "",
    ].join("\n"),
  );
  assert.notEqual(result.rootEvaluation.result, "satisfied");
  const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
  assert.ok(terminalState);
  assert.equal(
    terminalState.bindingVerifications.some(verification =>
      verification.edgeRef === "edge:sources/src/util.ts:reexport:0"
      && !verification.verified),
    true,
    "the wrong-alias re-export edge must remain identifiable",
  );
});

test("wrong module specifier does not satisfy the re-export binding", async () => {
  const result = await runWithReplacedUtil(
    "real-corpus-wrong-reexport-module",
    'export { helper as forwarded } from "./other-different";\n',
  );
  assert.notEqual(result.rootEvaluation.result, "satisfied");
  const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
  assert.ok(terminalState);
  assert.equal(
    terminalState.bindingVerifications.some(verification =>
      verification.edgeRef === "edge:sources/src/util.ts:reexport:0"
      && !verification.verified),
    true,
    "the wrong-module re-export edge must remain identifiable",
  );
});

test("root coverage rejects an unexecuted relation edge after the executed subset passes", async () => {
  const work = await mkdtemp(join(tmpdir(), "p1-1-real-corpus-unexecuted-edge-"));
  try {
    const positive = await positiveEpisodes();
    const step0 = positive.find(episode => episode.stepId === "step-0");
    const step1 = positive.find(episode => episode.stepId === "step-1");
    const terminal = positive.find(episode => episode.stepId === "step-2");
    assert.ok(step0);
    assert.ok(step1);
    assert.ok(terminal);
    const extraEdge = {
      ...step1.observedBindings[1],
      edgeRef: "edge:sources/src/util.ts:reexport:unexecuted",
      fromNodeRef: "syntax:sources/src/util.ts:reexport:unexecuted",
    };
    const unexecuted = {
      ...step1,
      stepId: "step-unexecuted",
      observedBindings: [extraEdge],
      remainingObligations: [{
        ...step1.remainingObligations[0],
        ref: extraEdge.edgeRef,
      }],
      previousExecution: {
        ...step1.previousExecution,
        value: {
          ...step1.previousExecution.value,
          fromStepId: "step-not-selected",
        },
      },
    };
    const modelPath = await writeModel(work, { preferControlAtTerminal: true });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "real-corpus-unexecuted-relation-edge",
      packagePath: modelPath,
      episodes: [step0, step1, terminal, unexecuted],
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({
        sourceRoot: join(CORPUS_ROOT, FAMILY),
      }),
    });
    const executedEdges = result.steps
      .map(step => step.executionReceipt?.actionRef)
      .filter(Boolean);
    assert.equal(executedEdges.length >= 3, true, "the legal executed subset must pass");
    assert.equal(result.rootEvaluation.result, "unsatisfied");
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(
      terminalState.bindingVerifications.some(verification =>
        verification.edgeRef === extraEdge.edgeRef
        && verification.phase === "executed"
        && verification.verified),
      false,
      "the unexecuted required relation edge must remain without verified coverage",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
