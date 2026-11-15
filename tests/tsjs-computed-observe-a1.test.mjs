import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, "fixtures", "tsjs-computed-observe-a1");
const CALL_SITE_REF = "call:entry.ts@6:23-6:48";
const PENDING_RELATION_REF = "pending:computed-observe-a1";
const CANDIDATE_PACKAGE =
  "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113/candidate-package.json";
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

function requestedDeclaration(overrides = {}) {
  return {
    declarationRef: "decl:factory.ts#top:createStepper",
    moduleRef: "module:factory.ts",
    name: "createStepper",
    role: "export",
    kind: "function",
    evidenceRefs: [],
    ...overrides,
  };
}

function startEpisode(overrides = {}) {
  return {
    sampleId: "computed-observe-a1",
    stepId: "step-observe",
    requestId: "request:computed-observe-a1",
    sourceGroup: "computed-observe-a1",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "DEV",
    entryFile: "entry.ts",
    targetRef: "pending:computed-observe-a1",
    observedFacts: [],
    pendingRelationRef: PENDING_RELATION_REF,
    callSiteRef: CALL_SITE_REF,
    calleeName: "createStepper",
    requestedDeclaration: requestedDeclaration(),
    observedBindings: [],
    observedDeclarations: [],
    evidenceRefs: [],
    failureMode: null,
    derivationFamily: "computed-observe-a1",
    adapterRef: "adapter:tsjs",
    remainingObligations: [{
      kind: "observe",
      ref: "obligation:observe:computed",
      pendingRelationRef: PENDING_RELATION_REF,
      arguments: [{
        name: "target",
        type: "call_site",
        valueRef: CALL_SITE_REF,
      }],
      informationGain: 1,
    }],
    localCandidateCursor: {
      pendingRelationRef: PENDING_RELATION_REF,
      state: "closed",
      evidenceRefs: [],
    },
    ...overrides,
  };
}

function judgeEpisode(overrides = {}) {
  return {
    ...startEpisode(),
    stepId: "step-judge",
    targetRef: "decl:factory.ts#top:createStepper",
    observedBindings: [{
      edgeRef: "edge:computed-observe-a1:next",
      callSiteRef: CALL_SITE_REF,
      fromNodeRef: "module:entry.ts",
      edgeKind: "import",
      sourceName: "createStepper",
      sourceModule: {
        state: "known",
        value: "module:factory.ts",
        reason: null,
        evidenceRefs: [],
      },
      targetName: "createStepper",
      targetModule: {
        state: "known",
        value: "module:factory.ts",
        reason: null,
        evidenceRefs: [],
      },
      moduleSpecifierRaw: "./factory",
      sourceContent: {
        state: "not_requested",
        resultRefs: [],
        reason: null,
        evidenceRefs: [],
      },
      visibility: {
        state: "known",
        value: "reachable",
        reason: null,
        evidenceRefs: [],
      },
      hopDepth: 0,
      evidenceRefs: [],
    }],
    remainingObligations: [],
    ...overrides,
  };
}

function chosenOf(capture) {
  const candidate = capture.context.candidateGroup.candidates.find(
    item => item.candidateRef === capture.chosen.candidateRef,
  );
  assert.ok(candidate);
  return candidate;
}

function cloneStepInput(input) {
  const observe = input.observe === undefined
    ? undefined
    : { ...input.observe, bridge: "[invocation-scoped-callback]" };
  return structuredClone({ ...input, observe });
}

async function writeObserveThenTrueModel(root) {
  const tensors = zeroTensors();
  tensors.W1[24] = 2;
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  await writeFile(join(root, "feature-thresholds.json"), JSON.stringify(THRESHOLDS));
  await writeFile(join(root, "missing-mode.json"), JSON.stringify(MISSING_MODE));
  return saveUnifiedModelPackageAtomic(
    join(root, "package.json"),
    createUnifiedModelPackage({
      modelId: "tsjs-computed-observe-a1-engineering",
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

test("A1 producer observes a top-level computed import member from an explicit read set", async () => {
  const result = await runTsJsSymbolTable({
    repo: SOURCE_ROOT,
    language: "typescript",
    scope: ["."],
    files: ["entry.ts", "factory.ts"],
  });

  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status !== "ok") return;

  const observations = result.result.constantComputedPropertyObservations;
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.ok(observation);
  assert.equal(observation.selection.selectorValue, "createStepper");
  assert.equal(observation.selection.selectedMemberName, "createStepper");
  assert.equal(
    observation.selection.selectedDeclarationRef,
    "decl:factory.ts#top:createStepper",
  );
  assert.equal(observation.selection.selectedModuleRef, "module:factory.ts");
  assert.equal(observation.callableTable.members[0].callableIdentity, null);
  assert.deepEqual(
    observation.sourceReadReceipt.modules.map(module => module.file).sort(),
    ["entry.ts", "factory.ts"],
  );
});

test("A1 relation.observe accepts only a call-site target", () => {
  const context = relationStepContext({
    sampleId: "computed-observe-a1",
    stepId: "observe",
    requestId: "request:computed-observe-a1",
    sourceGroup: "computed-observe-a1",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "DEV",
    entryFile: "entry.ts",
    targetRef: "pending:computed-observe-a1",
    observedFacts: [],
    pendingRelationRef: "pending:computed-observe-a1",
    callSiteRef: "call:entry.ts:computed",
    requestedDeclaration: {
      declarationRef: "decl:factory.ts#top:createStepper",
      moduleRef: "module:factory.ts",
      name: "createStepper",
      role: "export",
      kind: "function",
      evidenceRefs: [],
    },
    remainingObligations: [{
      kind: "observe",
      ref: "obligation:observe",
      pendingRelationRef: "pending:computed-observe-a1",
      arguments: [{
        name: "target",
        type: "call_site",
        valueRef: "call:entry.ts:computed",
      }],
      informationGain: 1,
    }],
    localCandidateCursor: {
      pendingRelationRef: "pending:computed-observe-a1",
      state: "closed",
      evidenceRefs: [],
    },
    evidenceRefs: [],
    failureMode: null,
    derivationFamily: "computed-observe-a1",
    adapterRef: "adapter:tsjs",
  });

  const observe = context.skills.find(skill => skill.skillKey === "relation.observe");
  assert.ok(observe);
  assert.deepEqual(
    observe.parameterSchema.parameters[0].allowedTargetKinds,
    ["call_site"],
  );
});

test("A1 legacy source-module observe target emits no observe candidate", async () => {
  const captures = [];
  const observeCalls = [];
  const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
  const executor = {
    async read(input) {
      return fileExecutor.read(input);
    },
    async observe(input) {
      observeCalls.push(cloneStepInput(input));
      return fileExecutor.observe(input);
    },
  };
  const invalidTarget = startEpisode({
    remainingObligations: [{
      kind: "observe",
      ref: "obligation:observe:computed",
      pendingRelationRef: PENDING_RELATION_REF,
      arguments: [{
        name: "target",
        type: "source_module",
        valueRef: CALL_SITE_REF,
      }],
      informationGain: 1,
    }],
  });
  const startContext = relationStepContext(invalidTarget);
  assert.equal(
    startContext.candidateGroup.candidates.some(
      candidate => candidate.optionSemantics === "observe",
    ),
    false,
  );

  const result = await runTsJsUnifiedMultiStepDecision({
    requestId: "computed-observe-a1-source-module",
    packagePath: CANDIDATE_PACKAGE,
    episodes: [invalidTarget, judgeEpisode()],
    grantedEffects: ["read_only"],
    observe: {
      kind: "constant_computed_property_v1",
      readSet: {
        repoRoot: SOURCE_ROOT,
        callerFile: "entry.ts",
        language: "typescript",
        files: ["entry.ts", "factory.ts"],
        grantedEffects: ["read_only"],
      },
    },
    executor,
    onStepSelection(capture) {
      captures.push(structuredClone(capture));
    },
  });

  assert.equal(captures.length, 0);
  assert.equal(observeCalls.length, 0);
  assert.equal(result.recursiveGoal.report.control.outcome, "error");
  assert.equal(result.rootCompletion.queryCompletion, "incomplete");
});

test("A1 saved candidate records its real judge=unknown selection without fabricating observe", async () => {
  const captures = [];
  const observeCalls = [];
  const readCalls = [];
  const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
  const executor = {
    async read(input) {
      readCalls.push(cloneStepInput(input));
      return fileExecutor.read(input);
    },
    async observe(input) {
      observeCalls.push(cloneStepInput(input));
      return fileExecutor.observe(input);
    },
  };

  const result = await runTsJsUnifiedMultiStepDecision({
    requestId: "computed-observe-a1",
    packagePath: CANDIDATE_PACKAGE,
    episodes: [startEpisode(), judgeEpisode()],
    grantedEffects: ["read_only"],
    observe: {
      kind: "constant_computed_property_v1",
      readSet: {
        repoRoot: SOURCE_ROOT,
        callerFile: "entry.ts",
        language: "typescript",
        files: ["entry.ts", "factory.ts"],
        grantedEffects: ["read_only"],
      },
    },
    executor,
    onStepSelection(capture) {
      captures.push(structuredClone(capture));
    },
  });

  assert.deepEqual(
    captures.map(capture => chosenOf(capture).optionSemantics),
    ["judge=unknown"],
  );
  assert.equal(observeCalls.length, 0);
  assert.equal(readCalls.length, 0);
  assert.equal(result.rootCompletion.positiveRootSatisfied, false);
  assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  assert.ok(result.rootCompletion.positiveRootGaps.some(
    gap => gap.code === "A2_COMPLETION_WITNESS_NOT_IMPLEMENTED",
  ));
});

test("A1 selected observe carries four admission records into the next judge", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-model-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const observeCalls = [];
    const readCalls = [];
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        readCalls.push(cloneStepInput(input));
        return fileExecutor.read(input);
      },
      async observe(input) {
        observeCalls.push(cloneStepInput(input));
        return fileExecutor.observe(input);
      },
    };

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-engineering",
      packagePath,
      episodes: [startEpisode(), judgeEpisode()],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(
      captures.map(capture => chosenOf(capture).optionSemantics),
      ["observe", "judge=true"],
      JSON.stringify(result.recursiveGoal.report, null, 2),
    );
    assert.equal(observeCalls.length, 1);
    assert.equal(readCalls.length, 0);
    assert.equal(observeCalls[0].observe.kind, "constant_computed_property_v1");
    assert.equal(observeCalls[0].observe.previousExecutionStepId, null);

    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(terminalState.observeAdmissions.length, 4);
    assert.deepEqual(
      terminalState.observeAdmissions.map(record => record.payload.kind).sort(),
      [
        "declaration_identity_observation",
        "import_binding_observation",
        "source_read_receipt",
        "source_read_receipt",
      ],
    );
    assert.deepEqual(
      terminalState.observeAdmissions
        .filter(record => record.payload.kind === "source_read_receipt")
        .flatMap(record => record.payload.modules?.map(module => module.file) ?? [])
        .sort(),
      ["entry.ts", "factory.ts"],
    );
    assert.equal(terminalState.ledger[0].executionReceipt.outcome, "success");
    assert.equal(terminalState.ledger[0].action, "submit_observe");

    const judge = captures[1];
    assert.ok(judge);
    assert.equal(judge.stepId, "step-judge");
    assert.equal(
      judge.context.candidateGroup.candidateGroupRef,
      "cg:computed-observe-a1:step-judge:0",
    );
    assert.deepEqual(judge.context.remainingObligations, []);
    assert.deepEqual(judge.context.localCandidateCursor, {
      pendingRelationRef: PENDING_RELATION_REF,
      state: "closed",
      evidenceRefs: [],
    });
    assert.equal(judge.context.goal.targetRef, "decl:factory.ts#top:createStepper");
    assert.equal(judge.context.currentRelation.binding.state, "known");
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.declarationRef,
      "decl:factory.ts#top:createStepper",
    );
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.moduleRef,
      "module:factory.ts",
    );
    assert.equal(judge.context.bindingEdges.length, 1);
    assert.equal(
      judge.context.bindingEdges[0].sourceModule.value,
      "module:factory.ts",
    );
    assert.equal(
      judge.context.bindingEdges[0].targetModule.value,
      "module:entry.ts",
    );
    assert.equal(
      judge.context.goal.requestedDeclaration.declarationRef,
      "decl:factory.ts#top:createStepper",
    );
    const observeReceipt = result.steps[0]?.executionReceipt;
    assert.ok(observeReceipt);
    assert.equal(judge.context.action.previousActionRef, observeReceipt.actionRef);
    assert.deepEqual(judge.context.previousExecution, {
      state: "known",
      value: {
        actionRef: observeReceipt.actionRef,
        receiptRef: observeReceipt.receiptId,
        origin: "model_execution",
        fromStepId: "step-observe",
        pendingRelationRef: PENDING_RELATION_REF,
        optionSemantics: "observe",
        targetRef: "module:factory.ts",
        outcome: "success",
      },
      evidenceRefs: observeReceipt.evidenceRefs,
    });
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
    assert.ok(result.rootCompletion.positiveRootGaps.some(
      gap => gap.code === "A2_COMPLETION_WITNESS_NOT_IMPLEMENTED",
    ));
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 keeps predecessor identity separate from the executed observe step", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-predecessor-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    let admittedProjection = null;
    let admittedEvidence = null;
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        return fileExecutor.read(input);
      },
      async observe(input) {
        assert.equal(input.observe.kind, "constant_computed_property_v1");
        const bridge = async bridgeInput => {
          const outcome = await input.observe.bridge(bridgeInput);
          if (outcome.kind === "admitted") {
            admittedProjection = outcome.projection;
            admittedEvidence = outcome.admittedEvidence;
          }
          return outcome;
        };
        return fileExecutor.observe({
          ...input,
          observe: { ...input.observe, bridge },
        });
      },
    };

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-predecessor",
      packagePath,
      episodes: [
        startEpisode({
          previousExecution: {
            state: "known",
            value: {
              actionRef: "action:step-prior",
              receiptRef: "receipt:step-prior",
              origin: "model_execution",
              fromStepId: "step-prior",
              pendingRelationRef: PENDING_RELATION_REF,
              optionSemantics: "advance",
              targetRef: "module:prior.ts",
              outcome: "success",
            },
            evidenceRefs: [],
          },
        }),
        judgeEpisode(),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
    });

    assert.ok(admittedProjection);
    assert.ok(admittedEvidence);
    assert.equal(admittedProjection.previousExecutionStepId, "step-prior");
    assert.equal(admittedProjection.executedStepId, "step-observe");
    assert.equal(admittedProjection.producerSource.previousExecutionStepId, "step-prior");
    assert.equal(admittedProjection.producerSource.executedStepId, "step-observe");
    assert.equal(admittedProjection.receipt.fromStepId, "step-observe");
    assert.deepEqual(
      admittedEvidence
        .filter(record => record.payload.kind === "source_read_receipt")
        .map(record => [record.payload.stepId, record.payload.fromStepId]),
      [
        ["step-observe", "step-prior"],
        ["step-observe", "step-prior"],
      ],
    );
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(terminalState.context.previousExecution.value.fromStepId, "step-observe");
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 producer observation stays independent of the requested declaration", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-request-blind-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const requested = requestedDeclaration({
      declarationRef: "decl:factory.ts#top:createShadowedStepper",
      name: "createShadowedStepper",
    });
    const captures = [];
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-request-blind",
      packagePath,
      episodes: [
        startEpisode({ requestedDeclaration: requested }),
        judgeEpisode({ requestedDeclaration: requested }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: fileExecutor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(
      captures.map(capture => chosenOf(capture).optionSemantics),
      ["observe", "judge=true"],
      JSON.stringify(result.recursiveGoal.report, null, 2),
    );
    const judge = captures[1];
    assert.ok(judge);
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.declarationRef,
      "decl:factory.ts#top:createStepper",
    );
    assert.equal(
      judge.context.goal.requestedDeclaration.declarationRef,
      "decl:factory.ts#top:createShadowedStepper",
    );
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 missing source fails observe without legacy fallback", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-missing-source-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const observeCalls = [];
    const readCalls = [];
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        readCalls.push(cloneStepInput(input));
        return fileExecutor.read(input);
      },
      async observe(input) {
        observeCalls.push(cloneStepInput(input));
        return fileExecutor.observe(input);
      },
    };

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-missing-source",
      packagePath,
      episodes: [startEpisode(), judgeEpisode()],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(captures.map(capture => chosenOf(capture).optionSemantics), ["observe"]);
    assert.equal(observeCalls.length, 1);
    assert.equal(readCalls.length, 0);
    assert.equal(result.steps[0].executionReceipt.outcome, "failed");
    assert.equal(
      result.recursiveGoal.report.errors[0].source.nativeCode,
      "PRODUCER_OBSERVATION_MISSING",
    );
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 selected observe without a linked next judge is an explicit failure", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-missing-next-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-missing-next",
      packagePath,
      episodes: [startEpisode()],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
    });

    assert.equal(result.steps[0]?.executionReceipt.outcome, "success");
    assert.equal(
      result.recursiveGoal.report.errors[0]?.source.nativeCode,
      "NEXT_EPISODE_MISSING",
    );
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 rejects a substituted computed observe execution tuple", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-tuple-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const readCalls = [];
    let tampered = false;
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        readCalls.push(cloneStepInput(input));
        return fileExecutor.read(input);
      },
      async observe(input) {
        const execution = await fileExecutor.observe(input);
        if (execution.outcome !== "success" || execution.observeProjection === undefined) {
          return execution;
        }
        const substituted = structuredClone(execution);
        substituted.observeProjection.producerSource.executedStepId = "step:substituted";
        tampered = true;
        return substituted;
      },
    };

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "computed-observe-a1-tuple",
      packagePath,
      episodes: [startEpisode(), judgeEpisode()],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.equal(tampered, true);
    assert.deepEqual(captures.map(capture => chosenOf(capture).optionSemantics), ["observe"]);
    assert.equal(readCalls.length, 0);
    assert.equal(
      result.recursiveGoal.report.errors[0].source.nativeCode,
      "BRIDGE_ADMISSION_REJECTED",
    );
    assert.match(
      result.recursiveGoal.report.errors[0].diagnosticMessage,
      /computed observe projection tuple mismatch/,
    );
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 rejects projection identity fields from another request or candidate", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-computed-observe-a1-identity-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const mutations = [
      [
        "request",
        execution => {
          execution.observeProjection.producerSource.requestRef = "request:foreign";
        },
      ],
      [
        "sample",
        execution => {
          execution.observeProjection.producerSource.sampleId = "sample:foreign";
        },
      ],
      [
        "candidate",
        execution => {
          execution.observeProjection.candidateRef = "candidate:foreign";
        },
      ],
      [
        "producer candidate",
        execution => {
          execution.observeProjection.producerSource.candidateRef = "candidate:foreign";
        },
      ],
      [
        "pending relation",
        execution => {
          execution.observeProjection.producerSource.pendingRelationRef = "pending:foreign";
        },
      ],
      [
        "requested declaration",
        execution => {
          execution.observeProjection.producerSource.requestedDeclarationRef = "decl:foreign";
        },
      ],
      [
        "admission record",
        execution => {
          execution.observeEvidence[0].payload.requestRef = "request:foreign";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const captures = [];
      const readCalls = [];
      let tampered = false;
      const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
      const executor = {
        async read(input) {
          readCalls.push(cloneStepInput(input));
          return fileExecutor.read(input);
        },
        async observe(input) {
          const execution = await fileExecutor.observe(input);
          if (execution.outcome !== "success" || execution.observeProjection === undefined) {
            return execution;
          }
          const substituted = structuredClone(execution);
          mutate(substituted);
          tampered = true;
          return substituted;
        },
      };

      const result = await runTsJsUnifiedMultiStepDecision({
        requestId: `computed-observe-a1-${label}`,
        packagePath,
        episodes: [startEpisode(), judgeEpisode()],
        grantedEffects: ["read_only"],
        observe: {
          kind: "constant_computed_property_v1",
          readSet: {
            repoRoot: SOURCE_ROOT,
            callerFile: "entry.ts",
            language: "typescript",
            files: ["entry.ts", "factory.ts"],
            grantedEffects: ["read_only"],
          },
        },
        executor,
        onStepSelection(capture) {
          captures.push(structuredClone(capture));
        },
      });

      assert.equal(tampered, true, label);
      assert.deepEqual(captures.map(capture => chosenOf(capture).optionSemantics), ["observe"], label);
      assert.equal(readCalls.length, 0, label);
      assert.equal(
        result.recursiveGoal.report.errors[0].source.nativeCode,
        "BRIDGE_ADMISSION_REJECTED",
        label,
      );
      assert.match(
        result.recursiveGoal.report.errors[0].diagnosticMessage,
        /computed observe (?:projection tuple mismatch|admission records do not match the projection)/,
        label,
      );
      assert.equal(result.rootCompletion.queryCompletion, "incomplete", label);
    }
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: clean topology-only skeleton reaches the next judge", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-clean-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const observeCalls = [];
    const readCalls = [];
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        readCalls.push(cloneStepInput(input));
        return fileExecutor.read(input);
      },
      async observe(input) {
        observeCalls.push(cloneStepInput(input));
        return fileExecutor.observe(input);
      },
    };

    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-clean",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-clean",
          sampleId: "a1-continuation-clean",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-clean",
          sampleId: "a1-continuation-clean",
          observedBindings: [],
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: PENDING_RELATION_REF,
            callSiteRef: CALL_SITE_REF,
          },
        }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(
      captures.map(capture => chosenOf(capture).optionSemantics),
      ["observe", "judge=true"],
      JSON.stringify(result.recursiveGoal.report, null, 2),
    );
    assert.equal(observeCalls.length, 1);
    assert.equal(readCalls.length, 0);
    assert.equal(result.steps[0].nextStepId, "step-judge");

    const judge = captures[1];
    assert.ok(judge);
    assert.equal(judge.stepId, "step-judge");
    assert.equal(
      judge.context.candidateGroup.candidateGroupRef,
      "cg:a1-continuation-clean:step-judge:0",
    );
    assert.equal(judge.context.currentRelation.binding.state, "known");
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.declarationRef,
      "decl:factory.ts#top:createStepper",
    );
    assert.equal(judge.context.bindingEdges.length, 1);
    assert.equal(judge.context.bindingEdges[0].sourceModule.value, "module:factory.ts");
    assert.equal(judge.context.previousExecution.state, "known");
    assert.equal(judge.context.previousExecution.value.fromStepId, "step-observe");
    assert.equal(judge.context.previousExecution.value.targetRef, CALL_SITE_REF);
    assert.notEqual(judge.context.previousExecution.value.targetRef, "module:factory.ts");
    assert.equal(
      judge.context.previousExecution.value.receiptRef,
      result.steps[0].executionReceipt.receiptId,
    );
    assert.deepEqual(
      judge.context.previousExecution.evidenceRefs,
      result.steps[0].executionReceipt.evidenceRefs,
    );
    assert.equal(result.steps[0].executionReceipt.outcome, "success");
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);

    const finalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(finalState);
    const clonedState = structuredClone(finalState);
    structuredClone(result.recursiveGoal.report);
    structuredClone(result.steps);
    assert.ok(clonedState);
    assert.ok(!JSON.stringify(clonedState).includes("bridge"));
    assert.ok(!JSON.stringify(clonedState).includes("producerRequest"));
    assert.ok(!JSON.stringify(clonedState).includes("producerResult"));
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: explicit typed not_observed inputs stay truthful", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-not-observed-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-not-observed",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-not-observed",
          sampleId: "a1-continuation-not-observed",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-not-observed",
          sampleId: "a1-continuation-not-observed",
          observedBindings: [],
          previousExecution: {
            state: "not_observed",
            reason: "not_requested",
            evidenceRefs: [],
          },
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: PENDING_RELATION_REF,
            callSiteRef: CALL_SITE_REF,
          },
        }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.equal(captures.length, 2);
    const judge = captures[1];
    assert.ok(judge);
    assert.equal(judge.context.previousExecution.state, "known");
    assert.equal(judge.context.previousExecution.value.fromStepId, "step-observe");
    assert.equal(judge.context.previousExecution.value.targetRef, CALL_SITE_REF);
    assert.equal(judge.context.previousExecution.value.outcome, "success");
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: missing topology link keeps observe and fails normally", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-missing-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const observeCalls = [];
    const readCalls = [];
    const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
    const executor = {
      async read(input) {
        readCalls.push(cloneStepInput(input));
        return fileExecutor.read(input);
      },
      async observe(input) {
        observeCalls.push(cloneStepInput(input));
        return fileExecutor.observe(input);
      },
    };
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-missing",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-missing",
          sampleId: "a1-continuation-missing",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-missing",
          sampleId: "a1-continuation-missing",
          observedBindings: [],
        }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor,
    });

    assert.equal(observeCalls.length, 1);
    assert.equal(readCalls.length, 0);
    assert.equal(result.steps[0].executionReceipt.outcome, "success");
    assert.equal(result.steps[0].nextStepId, null);
    assert.equal(
      result.recursiveGoal.report.errors[0]?.source?.nativeCode,
      "NEXT_EPISODE_MISSING",
    );
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: self-link is not a next episode", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-self-link-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const selfLink = {
      fromStepId: "step-observe",
      optionSemantics: "observe",
      pendingRelationRef: PENDING_RELATION_REF,
      callSiteRef: CALL_SITE_REF,
    };
    const episodesFor = (reversed) => {
      const observe = startEpisode({
        requestId: "request:a1-continuation-self-link",
        sampleId: "a1-continuation-self-link",
        continuation: selfLink,
      });
      const judge = judgeEpisode({
        requestId: "request:a1-continuation-self-link",
        sampleId: "a1-continuation-self-link",
        observedBindings: [],
        continuation: {
          fromStepId: "step-observe",
          optionSemantics: "observe",
          pendingRelationRef: "pending:unrelated",
        },
      });
      return reversed ? [judge, observe] : [observe, judge];
    };
    for (const reversed of [false, true]) {
      const captures = [];
      const result = await runTsJsUnifiedMultiStepDecision({
        requestId: "request:a1-continuation-self-link",
        packagePath,
        episodes: episodesFor(reversed),
        grantedEffects: ["read_only"],
        observe: {
          kind: "constant_computed_property_v1",
          readSet: {
            repoRoot: SOURCE_ROOT,
            callerFile: "entry.ts",
            language: "typescript",
            files: ["entry.ts", "factory.ts"],
            grantedEffects: ["read_only"],
          },
        },
        executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
        onStepSelection(capture) {
          captures.push(structuredClone(capture));
        },
      });

      assert.equal(
        result.recursiveGoal.report.errors[0]?.source?.nativeCode,
        "NEXT_EPISODE_MISSING",
      );
      assert.equal(result.steps[0].nextStepId, null);
      assert.ok(result.steps.every(step => step.nextStepId !== step.stepId));
      assert.ok(captures.every(capture => capture.stepId !== "step-judge"));
    }
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: identical topology keys are ambiguous", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-ambiguous-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const continuation = {
      fromStepId: "step-observe",
      optionSemantics: "observe",
      pendingRelationRef: PENDING_RELATION_REF,
      callSiteRef: CALL_SITE_REF,
    };
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-ambiguous",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-ambiguous",
          sampleId: "a1-continuation-ambiguous",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-ambiguous",
          sampleId: "a1-continuation-ambiguous",
          stepId: "step-judge-a",
          observedBindings: [],
          continuation,
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-ambiguous",
          sampleId: "a1-continuation-ambiguous",
          stepId: "step-judge-b",
          observedBindings: [],
          continuation,
        }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
    });

    const error = result.recursiveGoal.report.errors[0];
    assert.ok(error);
    assert.match(JSON.stringify(error), /AMBIGUOUS_NEXT_EPISODE/);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: pending relation selects exactly one successor", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-pending-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-pending",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-pending",
          sampleId: "a1-continuation-pending",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-pending",
          sampleId: "a1-continuation-pending",
          stepId: "step-judge-match",
          observedBindings: [],
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: PENDING_RELATION_REF,
            callSiteRef: CALL_SITE_REF,
          },
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-pending",
          sampleId: "a1-continuation-pending",
          stepId: "step-judge-other",
          observedBindings: [],
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: "pending:other",
            callSiteRef: CALL_SITE_REF,
          },
        }),
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(
      captures.map(capture => capture.stepId),
      ["step-observe", "step-judge-match"],
    );
    assert.equal(result.steps[0].nextStepId, "step-judge-match");
    assert.ok(captures.every(capture => capture.stepId !== "step-judge-other"));
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: omitted call-site keeps a matching successor ambiguous", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-call-site-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const run = (successors) => runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-call-site",
      packagePath,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-call-site",
          sampleId: "a1-continuation-call-site",
        }),
        ...successors,
      ],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
    });
    const successor = (stepId, callSiteRef) => judgeEpisode({
      requestId: "request:a1-continuation-call-site",
      sampleId: "a1-continuation-call-site",
      stepId,
      observedBindings: [],
      continuation: {
        fromStepId: "step-observe",
        optionSemantics: "observe",
        pendingRelationRef: PENDING_RELATION_REF,
        ...(callSiteRef === undefined ? {} : { callSiteRef }),
      },
    });

    const ambiguous = await run([
      successor("step-judge-site", CALL_SITE_REF),
      successor("step-judge-optional"),
    ]);
    assert.match(
      JSON.stringify(ambiguous.recursiveGoal.report.errors[0]),
      /AMBIGUOUS_NEXT_EPISODE/,
    );
    const noMatch = await run([
      successor("step-judge-other", "call:other.ts@1:1-1:2"),
    ]);
    assert.equal(
      noMatch.recursiveGoal.report.errors[0]?.source?.nativeCode,
      "NEXT_EPISODE_MISSING",
    );
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});

test("A1 safe continuation: prefilled known execution is rejected before execution", async () => {
  const observeCalls = [];
  const readCalls = [];
  const fileExecutor = createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT });
  const executor = {
    async read(input) {
      readCalls.push(cloneStepInput(input));
      return fileExecutor.read(input);
    },
    async observe(input) {
      observeCalls.push(cloneStepInput(input));
      return fileExecutor.observe(input);
    },
  };
  await assert.rejects(
    () => runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-prefilled",
      packagePath: CANDIDATE_PACKAGE,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-prefilled",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-prefilled",
          observedBindings: [],
          previousExecution: {
            state: "known",
            value: {
              actionRef: "action:future",
              receiptRef: "receipt:future",
              origin: "model_execution",
              fromStepId: "step-observe",
              pendingRelationRef: PENDING_RELATION_REF,
              optionSemantics: "observe",
              targetRef: CALL_SITE_REF,
              outcome: "success",
            },
            evidenceRefs: [],
          },
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: PENDING_RELATION_REF,
            callSiteRef: CALL_SITE_REF,
          },
        }),
      ],
      grantedEffects: ["read_only"],
      executor,
    }),
    /PREFILLED_PREVIOUS_EXECUTION/,
  );
  assert.equal(observeCalls.length, 0);
  assert.equal(readCalls.length, 0);
});

test("A1 safe continuation: prefilled observation is rejected before execution", async () => {
  await assert.rejects(
    () => runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-prefilled-observation",
      packagePath: CANDIDATE_PACKAGE,
      episodes: [
        startEpisode({
          requestId: "request:a1-continuation-prefilled-observation",
        }),
        judgeEpisode({
          requestId: "request:a1-continuation-prefilled-observation",
          continuation: {
            fromStepId: "step-observe",
            optionSemantics: "observe",
            pendingRelationRef: PENDING_RELATION_REF,
            callSiteRef: CALL_SITE_REF,
          },
        }),
      ],
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
    }),
    /PREFILLED_OBSERVATION/,
  );
});

test("A1 safe continuation: entry order follows the declared predecessor", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-a1-continuation-entry-"));
  try {
    const packagePath = await writeObserveThenTrueModel(modelRoot);
    const captures = [];
    const observe = startEpisode({
      requestId: "request:a1-continuation-entry-order",
      sampleId: "a1-continuation-entry-order",
      stepId: "z-step-observe",
    });
    const judge = judgeEpisode({
      requestId: "request:a1-continuation-entry-order",
      sampleId: "a1-continuation-entry-order",
      stepId: "a-step-judge",
      observedBindings: [],
      continuation: {
        fromStepId: "z-step-observe",
        optionSemantics: "observe",
        pendingRelationRef: PENDING_RELATION_REF,
        callSiteRef: CALL_SITE_REF,
      },
    });
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "request:a1-continuation-entry-order",
      packagePath,
      episodes: [judge, observe],
      grantedEffects: ["read_only"],
      observe: {
        kind: "constant_computed_property_v1",
        readSet: {
          repoRoot: SOURCE_ROOT,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts", "factory.ts"],
          grantedEffects: ["read_only"],
        },
      },
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: SOURCE_ROOT }),
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });

    assert.deepEqual(
      captures.map(capture => capture.stepId),
      ["z-step-observe", "a-step-judge"],
    );
    assert.equal(captures[0].chosen.optionSemantics ?? chosenOf(captures[0]).optionSemantics, "observe");
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
  }
});
