import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  assessTsJsObservedStaticSelectedRead,
  admitInitialEvidence,
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "tsjs-static-selected-bridge",
);
const ENTRY_FILE = "entry-literal-request-right.ts";

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
const MISSING_MODE = {
  schema: "nnanything.unified.missing-mode.v1",
  entries: [],
};

async function producerObservation() {
  const request = {
    repo: FIXTURE_ROOT,
    language: "typescript",
    scope: ["."],
    files: [ENTRY_FILE, "helper.ts"],
  };
  const producer = await runTsJsSymbolTable(request);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  assert.ok(producer.status === "ok");
  const observation = producer.result.staticSelectedSelectorObservations[0];
  assert.ok(observation);
  return { request, result: producer.result, observation };
}

async function buildStaticRecord(requestedName = "left", requestedOverrides = {}) {
  const ready = await producerObservation();
  const requestedMember = ready.observation.callableTable.members.find(
    member => member.name === requestedName,
  );
  assert.ok(requestedMember?.callableIdentity);
  const requestRef = "request:static-selected-completion";
  const pendingRelationRef = "relation:static-selected-completion";
  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: "tsjs-static-selected-completion",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-static-selected-completion-family",
    sampleId: "static-selected-completion",
    entryFile: ENTRY_FILE,
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: requestedMember.callableIdentity.declarationRef,
        moduleRef: `module:${requestedMember.callableIdentity.moduleRef}`,
        name: requestedMember.name,
        role: "member",
        kind: "function",
        evidenceRefs: [],
        ...requestedOverrides,
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: ready.observation.callSiteRef,
        calleeName: "chooseAction",
      },
    },
    stepId: "step:0",
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest: ready.request,
  });
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  return { ...ready, record: bridge.record };
}

async function loadBuiltRecord(record) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-static-completion-"));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeFile(join(familyDir, "manifest.json"), JSON.stringify({
      sourceGroup: record.sourceGroup,
      language: record.language,
      semanticStratum: record.semanticStratum,
      partition: record.partition,
      derivationFamily: { familyId: record.family },
    }));
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
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

// x[37] is the judge=false feature slot in the unified R encoder. The fixed
// package only selects the terminal judgement; the source witness owns closure.
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
      modelId: "tsjs-static-selected-completion-test",
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

test("SC1 same-module distinct member completes controlled judge=false", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-static-completion-run-"));
  try {
    const built = await buildStaticRecord("left");
    const episodes = await loadBuiltRecord(built.record);
    assert.equal(episodes.length, 1);
    const admission = admitInitialEvidence(episodes[0].requestId, episodes);
    assert.deepEqual(admission.invalidReasons, []);
    const evidence = admission.initialObservation?.evidence ?? [];

    const assessment = assessTsJsObservedStaticSelectedRead(
      episodes,
      completionState(episodes[0]),
      evidence,
    );
    assert.equal(assessment.status, "supported");
    assert.equal(assessment.producer_backed, true);
    assert.deepEqual(assessment.gaps, []);
    assert.ok(assessment.evidenceRefs.includes(built.observation.sourceReadRef));
    assert.ok(assessment.evidenceRefs.includes(built.observation.callableTable.tableRef));

    const packagePath = await writeJudgeFalseModel(root);
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: episodes[0].requestId,
      packagePath,
      episodes,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: FIXTURE_ROOT }),
    });
    assert.deepEqual(result.initialEvidenceInvalidReasons, []);
    assert.equal(result.rootCompletion.predictedJudgement, "false");
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "complete_false");
    const gap = result.rootCompletion.positiveRootGaps.find(
      candidate => candidate.code === "POSITIVE_RELATION_NOT_ESTABLISHED",
    );
    assert.ok(gap);
    assert.ok(gap.refs.includes(built.observation.sourceReadRef));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SC2 selected and requested declarations are not distinct", async () => {
  const built = await buildStaticRecord("right");
  const episodes = await loadBuiltRecord(built.record);
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  const assessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap =>
    gap.code === "static_selected_relation_not_distinct"));
});

test("SC3 another-module requested member is not a static completion", async () => {
  const built = await buildStaticRecord("left");
  const episodes = await loadBuiltRecord(built.record);
  const episode = structuredClone(episodes[0]);
  episode.requestedDeclaration.moduleRef = `module:${ENTRY_FILE}`;
  episode.receipts[0].producerSource.requestedModuleRef = `module:${ENTRY_FILE}`;
  const admission = admitInitialEvidence(episode.requestId, [episode]);
  const assessment = assessTsJsObservedStaticSelectedRead(
    [episode],
    completionState(episode),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap =>
    gap.code === "requested_target_mapping_invalid"));
});

test("SC4 requested name has no same-table member", async () => {
  const built = await buildStaticRecord("left");
  const episodes = await loadBuiltRecord(built.record);
  const episode = structuredClone(episodes[0]);
  episode.requestedDeclaration.name = "missing";
  const admission = admitInitialEvidence(episode.requestId, [episode]);
  const assessment = assessTsJsObservedStaticSelectedRead(
    [episode],
    completionState(episode),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap =>
    gap.code === "requested_target_mapping_invalid"));
});

test("SC5 an admitted shared read is required", async () => {
  const built = await buildStaticRecord("left");
  const episodes = await loadBuiltRecord(built.record);
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  const evidence = admission.initialObservation?.evidence ?? [];
  const assessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    evidence.filter(record => record.id !== built.observation.sourceReadRef),
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap => gap.code === "read_record_missing"));

  const mismatched = structuredClone(evidence);
  const readRecord = mismatched.find(record => record.id === built.observation.sourceReadRef);
  assert.ok(readRecord);
  readRecord.payload.requestedModuleRef = "module:other.ts";
  const mismatchAssessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    mismatched,
  );
  assert.equal(mismatchAssessment.status, "incomplete");
  assert.ok(mismatchAssessment.gaps.some(gap => gap.code === "read_record_mismatch"));
});

test("SC6 malformed selected identity is rejected", async () => {
  const built = await buildStaticRecord("left");
  const episodes = await loadBuiltRecord(built.record);
  const episode = structuredClone(episodes[0]);
  const source = episode.receipts[0].producerSource;
  source.rawObservation.selection.selectedDeclarationRef =
    "callable.arrow_function:not-the-selected-declaration";
  const admission = admitInitialEvidence(episode.requestId, [episode]);
  const assessment = assessTsJsObservedStaticSelectedRead(
    [episode],
    completionState(episode),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap => gap.code === "callable_identity_invalid"));

  const badBinding = structuredClone(episodes[0]);
  badBinding.currentRelation.binding.value.resolution.declarationRef =
    "callable.arrow_function:not-the-selected-declaration";
  const bindingAssessment = assessTsJsObservedStaticSelectedRead(
    [badBinding],
    completionState(badBinding),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(bindingAssessment.status, "incomplete");
  assert.ok(bindingAssessment.gaps.some(gap => gap.code === "selector_scope_invalid"));
});

test("SC7 missing relation completion is rejected by the loader", async () => {
  const built = await buildStaticRecord("left");
  const record = structuredClone(built.record);
  const work = record.steps[0].receipts[0].producerSource.completionWork;
  work.items = work.items.filter(item => item.kind !== "relation_completion");
  await assert.rejects(loadBuiltRecord(record));

  const unexpected = structuredClone(built.record);
  const unexpectedWork = unexpected.steps[0].receipts[0].producerSource.completionWork;
  unexpectedWork.items.push({
    kind: "selector_scope",
    subjectRef: built.observation.callSiteRef,
    disposition: {
      state: "satisfied",
      evidenceRefs: [built.observation.sourceReadRef],
    },
  });
  await assert.rejects(loadBuiltRecord(unexpected));
});

test("SC8 satisfied relation completion requires exact evidence", async () => {
  const built = await buildStaticRecord("left");
  const record = structuredClone(built.record);
  const relationCompletion = record.steps[0].receipts[0]
    .producerSource.completionWork.items.find(item =>
      item.kind === "relation_completion");
  assert.ok(relationCompletion);
  relationCompletion.disposition.evidenceRefs =
    ["unrelated:evidence"].filter(ref => ref.length > 0);
  await assert.rejects(loadBuiltRecord(record));
});

test("SC9 legacy unsupported relation completion remains loadable but incomplete", async () => {
  const built = await buildStaticRecord("left");
  const record = structuredClone(built.record);
  const relationCompletion = record.steps[0].receipts[0]
    .producerSource.completionWork.items.find(item =>
      item.kind === "relation_completion");
  assert.ok(relationCompletion);
  relationCompletion.disposition = {
    state: "unsupported",
    reason: "static-selected completion witness is not yet reviewed",
    evidenceRefs: relationCompletion.disposition.evidenceRefs,
  };
  const episodes = await loadBuiltRecord(record);
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  assert.deepEqual(admission.invalidReasons, []);
  const assessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap =>
    gap.code === "completion_work_unsatisfied"));
});

test("SC10 open local cursor is not a completed witness", async () => {
  const built = await buildStaticRecord("left");
  const episodes = await loadBuiltRecord(built.record);
  const episode = structuredClone(episodes[0]);
  episode.localCandidateCursor.state = "open";
  const admission = admitInitialEvidence(episode.requestId, [episode]);
  const assessment = assessTsJsObservedStaticSelectedRead(
    [episode],
    completionState(episode),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "incomplete");
  assert.ok(assessment.gaps.some(gap => gap.code === "work_state_open"));
});

test("SC11 dynamic selector shape has no static selected admission", async () => {
  const request = {
    repo: FIXTURE_ROOT,
    language: "typescript",
    scope: ["."],
    files: ["entry-dynamic.ts", "helper.ts"],
  };
  const producer = await runTsJsSymbolTable(request);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  assert.ok(producer.status === "ok");
  assert.deepEqual(producer.result.staticSelectedSelectorObservations, []);

  const dynamicObservation = producer.result.runtimeSelectorObservations[0];
  assert.ok(dynamicObservation);
  const requested = dynamicObservation.callableTable.members.find(
    member => member.name === "right",
  );
  assert.ok(requested?.callableIdentity);
  const requestRef = "request:static-completion-dynamic-control";
  const pendingRelationRef = "relation:static-completion-dynamic-control";
  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: "tsjs-static-selected-completion-dynamic-control",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-static-selected-completion-dynamic-control-family",
    sampleId: "static-selected-completion-dynamic-control",
    entryFile: "entry-dynamic.ts",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: requested.callableIdentity.declarationRef,
        moduleRef: `module:${requested.callableIdentity.moduleRef}`,
        name: requested.name,
        role: "member",
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: dynamicObservation.callSiteRef,
        calleeName: "chooseAction",
      },
    },
    stepId: "step:0",
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest: request,
  });
  assert.deepEqual(bridge.reasons, []);
  const episodes = await loadBuiltRecord(bridge.record);
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  const assessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    admission.initialObservation?.evidence ?? [],
  );
  assert.equal(assessment.status, "not_applicable");
  assert.equal(assessment.producer_backed, false);
});
