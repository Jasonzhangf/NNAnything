import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runTsJsSymbolTable,
} from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  assessTsJsObservedDynamicCompletion,
  assessTsJsObservedStaticSelectedRead,
  admitInitialEvidence,
} from "../dist/adapters/tsjs-unified-recursive.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
  selectTsJsObservationForCallSite,
} from "../dist/training/unified-student-converter.js";
import {
  encodeUnifiedCandidateGroup,
} from "../dist/training/unified-encoder.js";
import {
  relationStepContext,
} from "../dist/training/unified-step-context-builder.js";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "tsjs-static-selected-bridge",
);

function producerRequest(entryFile) {
  return {
    repo: ROOT,
    language: "typescript",
    scope: ["."],
    files: [entryFile, "helper.ts"],
  };
}

function minimalDynamicObservation(callSiteRef = "call:dynamic") {
  return {
    observationRef: `observation:${callSiteRef}`,
    callSiteRef,
    sourceReadRef: `source-read:${callSiteRef}`,
    binding: {
      symbolRef: "symbol:dynamic",
      callSiteRef,
      role: "member",
      bindingMode: "dynamic",
      resolution: {
        status: "dynamic",
        reason: "dynamic_undecidable",
        evidenceRefs: [`source-read:${callSiteRef}`],
      },
      declarationRefs: [],
      scopeRef: null,
      evidenceRefs: [`source-read:${callSiteRef}`],
    },
    facts: [],
    sourceReadReceipt: {
      receiptId: `source-read:${callSiteRef}`,
      actionRef: `source-read:${callSiteRef}:action`,
      action: "read_source",
      origin: "source_observation",
      outcome: "success",
      targetRef: "source:.",
      result: [],
      evidenceRefs: [],
      modules: [],
    },
  };
}

function minimalStaticObservation(callSiteRef = "call:static") {
  const sourceReadRef = `source-read:${callSiteRef}`;
  return {
    observationRef: `observation:${callSiteRef}`,
    callSiteRef,
    sourceReadRef,
    selection: {
      selectionKind: "static_selected",
      selectorLiteral: "right",
      selectedMemberName: "right",
      selectedMemberRef: "member:helper.ts@1",
      selectedDeclarationRef: "callable.arrow_function:helper.ts@1",
      selectedModuleRef: "helper.ts",
    },
    binding: {
      symbolRef: "symbol:static",
      callSiteRef,
      role: "member",
      bindingMode: "bound",
      resolution: {
        status: "resolved",
        declarationRef: "callable.arrow_function:helper.ts@1",
        moduleRef: "helper.ts",
        evidenceRefs: [sourceReadRef],
      },
      declarationRefs: ["callable.arrow_function:helper.ts@1"],
      scopeRef: null,
      evidenceRefs: [sourceReadRef],
    },
    facts: [],
    sourceReadReceipt: {
      receiptId: sourceReadRef,
      actionRef: `${sourceReadRef}:action`,
      action: "read_source",
      origin: "source_observation",
      outcome: "success",
      targetRef: "source:.",
      result: [],
      evidenceRefs: [sourceReadRef],
      modules: [],
    },
  };
}

async function staticProducer(entryFile) {
  const request = producerRequest(entryFile);
  const producer = await runTsJsSymbolTable(request);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return null;
  const observations = producer.result.staticSelectedSelectorObservations;
  if (!Array.isArray(observations) || observations.length === 0) return null;
  return { request, producer, observation: observations[0] };
}

function requestedDeclaration(observation, selection = observation.selection) {
  return {
    declarationRef: selection.selectedDeclarationRef,
    moduleRef: `module:${selection.selectedModuleRef}`,
    name: selection.selectedMemberName,
    role: "member",
    kind: "function",
    evidenceRefs: [],
  };
}

function declarationForMember(member) {
  assert.ok(member?.callableIdentity);
  return {
    declarationRef: member.callableIdentity.declarationRef,
    moduleRef: `module:${member.callableIdentity.moduleRef}`,
    name: member.name,
    role: "member",
    kind: "function",
    evidenceRefs: [],
  };
}

function bridgeInput(request, observation, overrides = {}) {
  const requestRef = overrides.requestRef ?? "request:static-bridge";
  const pendingRelationRef = overrides.pendingRelationRef ?? "relation:static-bridge";
  return {
    sourceGroup: "tsjs-static-selected-bridge",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-static-selected-bridge-family",
    sampleId: overrides.sampleId ?? "static-bridge",
    entryFile: overrides.entryFile ?? "entry-literal-request-right.ts",
    request: {
      requestRef,
      requestedDeclaration: overrides.requestedDeclaration
        ?? requestedDeclaration(observation),
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "chooseAction",
        ...(overrides.relationObligation ?? {}),
      },
    },
    stepId: overrides.stepId ?? "step:0",
    fromStepId: overrides.fromStepId ?? null,
    remainingObligations: overrides.remainingObligations ?? [],
    localCandidateCursor: overrides.localCandidateCursor ?? {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest: request,
  };
}

async function buildStaticRecord(entryFile = "entry-literal-request-right.ts", overrides = {}) {
  const ready = await staticProducer(entryFile);
  if (ready === null) return null;
  const bridge = await observeTsJsStepwiseRequest(
    bridgeInput(ready.request, ready.observation, overrides),
  );
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  return { ...ready, bridge };
}

async function loadRecord(record) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-static-bridge-"));
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
    terminalJudgement: "judge=unknown",
    ...overrides,
  };
}

function judgeVector(episode) {
  const context = relationStepContext(episode);
  const candidates = encodeUnifiedCandidateGroup(context);
  const judgeIndexes = context.candidateGroup.candidates.flatMap((candidate, index) =>
    candidate.optionSemantics.startsWith("judge=") ? [index] : []);
  assert.ok(judgeIndexes.length > 0);
  return judgeIndexes.map(index => candidates[index].vector);
}

test("B1-B3 selection boundary is pure and rejects ambiguity", () => {
  const dynamic = minimalDynamicObservation();
  const staticSelected = minimalStaticObservation();

  assert.equal(
    selectTsJsObservationForCallSite({
      dynamic: [dynamic],
      staticSelected: [],
      callSiteRef: dynamic.callSiteRef,
    }).kind,
    "dynamic",
  );
  assert.equal(
    selectTsJsObservationForCallSite({
      dynamic: [],
      staticSelected: [staticSelected],
      callSiteRef: staticSelected.callSiteRef,
    }).kind,
    "static_selected",
  );
  assert.equal(
    selectTsJsObservationForCallSite({
      dynamic: [],
      staticSelected: [],
      callSiteRef: "call:none",
    }).kind,
    "none",
  );
  assert.equal(
    selectTsJsObservationForCallSite({
      dynamic: [minimalDynamicObservation("call:both")],
      staticSelected: [minimalStaticObservation("call:both")],
      callSiteRef: "call:both",
    }).kind,
    "ambiguous",
  );
});

test("B4-B7 static projection, loader round trip, and producerSource contract", async (t) => {
  const built = await buildStaticRecord();
  if (built === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }

  const record = built.bridge.record;
  const step = record.steps[0];
  assert.equal(step.currentRelation.binding.state, "known");
  assert.equal(step.currentRelation.binding.value.resolution.status, "resolved");
  assert.equal(
    step.currentRelation.binding.value.resolution.declarationRef,
    built.observation.selection.selectedDeclarationRef,
  );
  assert.equal(step.currentRelation.binding.value.declarationRefs.length, 1);
  assert.equal(step.localSyntax.observedDeclarations.length, 1);
  assert.equal(
    step.localSyntax.observedDeclarations[0].moduleRef,
    `module:${built.observation.selection.selectedModuleRef}`,
  );
  assert.equal(
    step.receipts[0].producerSource.kind,
    "nnanything.tsjs.producer-source.static-selected.v1",
  );
  assert.equal(
    step.receipts[0].producerSource.completionWork.contract,
    "tsjs.observed-static-selected-read.v1",
  );
  const relationCompletion = step.receipts[0].producerSource.completionWork.items.find(
    item => item.kind === "relation_completion",
  );
  assert.equal(relationCompletion.disposition.state, "unresolved");
  assert.equal(
    relationCompletion.disposition.reason,
    "selected and requested declarations are not distinct",
  );
  assert.equal(
    step.receipts[0].producerSource.completionWork.items.some(
      item => item.kind === "selector_scope" && item.disposition.state === "satisfied",
    ),
    false,
  );
  assert.equal(JSON.stringify(record).includes("judge=false"), false);

  const episodes = await loadRecord(record);
  assert.equal(episodes.length, 1);
  assert.equal(
    episodes[0].currentRelation.binding.value.resolution.declarationRef,
    built.observation.selection.selectedDeclarationRef,
  );

  const dynamicRequest = producerRequest("entry-dynamic.ts");
  const dynamicProducer = await runTsJsSymbolTable(dynamicRequest);
  assert.equal(dynamicProducer.status, "ok", JSON.stringify(dynamicProducer));
  if (dynamicProducer.status !== "ok") return;
  const dynamicObservation = dynamicProducer.result.runtimeSelectorObservations[0];
  assert.ok(dynamicObservation);
  const dynamicRequested = dynamicObservation.callableTable.members.find(
    member => member.name === "right",
  );
  assert.ok(dynamicRequested);
  const dynamicBridge = await observeTsJsStepwiseRequest(bridgeInput(
    dynamicRequest,
    dynamicObservation,
    {
      sampleId: "dynamic-bridge-producer-source",
      entryFile: "entry-dynamic.ts",
      requestedDeclaration: declarationForMember(dynamicRequested),
    },
  ));
  assert.deepEqual(dynamicBridge.reasons, []);
  assert.equal(
    dynamicBridge.record.steps[0].receipts[0].producerSource.kind,
    "nnanything.tsjs.producer-source.v1",
  );
});

test("B5 different requested member keeps the selected identity", async (t) => {
  const ready = await staticProducer("entry-literal-request-right.ts");
  if (ready === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }
  const selected = ready.observation.selection;
  const leftMember = ready.observation.callableTable.members.find(member => member.name === "left");
  assert.ok(leftMember?.callableIdentity);
  const bridge = await observeTsJsStepwiseRequest(bridgeInput(
    ready.request,
    ready.observation,
    {
      sampleId: "static-bridge-different",
      requestedDeclaration: {
        declarationRef: leftMember.callableIdentity.declarationRef,
        moduleRef: `module:${leftMember.callableIdentity.moduleRef}`,
        name: leftMember.name,
        role: "member",
        kind: "function",
        evidenceRefs: [],
      },
    },
  ));
  assert.deepEqual(bridge.reasons, []);
  const step = bridge.record.steps[0];
  assert.equal(
    step.currentRelation.binding.value.resolution.declarationRef,
    selected.selectedDeclarationRef,
  );
  assert.equal(step.localSyntax.observedDeclarations.length, 1);
  assert.equal(
    step.localSyntax.observedDeclarations[0].declarationRef,
    selected.selectedDeclarationRef,
  );
  assert.notEqual(
    step.localSyntax.observedDeclarations[0].declarationRef,
    leftMember.callableIdentity.declarationRef,
  );
  assert.equal(JSON.stringify(bridge.record).includes("judge=false"), false);
});

test("B8 malformed static producerSource bindings are rejected", async (t) => {
  const built = await buildStaticRecord();
  if (built === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }

  const mutations = [
    record => {
      record.steps[0].receipts[0].producerSource.rawObservation.binding.bindingMode = "dynamic";
    },
    record => {
      record.steps[0].receipts[0].producerSource.rawObservation.binding.resolution.status = "dynamic";
    },
    record => {
      record.steps[0].receipts[0].producerSource.rawObservation.facts =
        structuredClone(minimalDynamicObservation().facts);
    },
  ];
  for (const mutate of mutations) {
    const record = structuredClone(built.bridge.record);
    mutate(record);
    await assert.rejects(loadRecord(record));
  }
});

test("E1-E2 fixed encoder compares selected and requested identities", async (t) => {
  const same = await buildStaticRecord();
  if (same === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }
  const sameEpisodes = await loadRecord(same.bridge.record);
  const sameVectors = judgeVector(sameEpisodes[0]);
  assert.deepEqual(sameVectors[0].slice(44, 48), [1, 1, 1, 0]);
  assert.deepEqual(sameVectors[0].slice(60, 64), [1, 1, 1, 0]);

  const leftMember = same.observation.callableTable.members.find(member => member.name === "left");
  assert.ok(leftMember?.callableIdentity);
  const different = await buildStaticRecord("entry-literal-request-right.ts", {
    sampleId: "static-bridge-encoder-different",
    requestedDeclaration: {
      declarationRef: leftMember.callableIdentity.declarationRef,
      moduleRef: `module:${leftMember.callableIdentity.moduleRef}`,
      name: leftMember.name,
      role: "member",
      kind: "function",
      evidenceRefs: [],
    },
  });
  const differentEpisodes = await loadRecord(different.bridge.record);
  const differentVectors = judgeVector(differentEpisodes[0]);
  assert.deepEqual(differentVectors[0].slice(44, 48), [1, 0, 1, 0]);
  assert.deepEqual(differentVectors[0].slice(60, 64), [1, 1, 0, 0]);

  for (const slots of [45, 62]) {
    assert.notEqual(sameVectors[0][slots], differentVectors[0][slots]);
  }
});

test("E3 dynamic missing declaration keeps its existing judge slots", async () => {
  const request = producerRequest("entry-dynamic.ts");
  const producer = await runTsJsSymbolTable(request);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return;
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);
  const requested = observation.callableTable.members.find(member => member.name === "right");
  assert.ok(requested);
  const bridge = await observeTsJsStepwiseRequest(bridgeInput(request, observation, {
    sampleId: "dynamic-bridge-encoder",
    entryFile: "entry-dynamic.ts",
    requestedDeclaration: declarationForMember(requested),
  }));
  assert.deepEqual(bridge.reasons, []);
  const episodes = await loadRecord(bridge.record);
  const vectors = judgeVector(episodes[0]);
  assert.deepEqual(vectors[0].slice(44, 48), [0, -1, -1, 0.5]);
  assert.deepEqual(vectors[0].slice(60, 64), [0, -1, -1, 0.5]);
});

test("E4 actual static and dynamic vectors differ only through factual identity slots", async (t) => {
  const built = await buildStaticRecord();
  if (built === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }
  const staticEpisodes = await loadRecord(built.bridge.record);
  const staticVector = judgeVector(staticEpisodes[0])[0];

  const dynamicRequest = producerRequest("entry-dynamic.ts");
  const dynamicProducer = await runTsJsSymbolTable(dynamicRequest);
  assert.equal(dynamicProducer.status, "ok", JSON.stringify(dynamicProducer));
  if (dynamicProducer.status !== "ok") return;
  const dynamicObservation = dynamicProducer.result.runtimeSelectorObservations[0];
  assert.ok(dynamicObservation);
  const requested = dynamicObservation.callableTable.members.find(
    member => member.name === "right",
  );
  assert.ok(requested);
  const dynamicBridge = await observeTsJsStepwiseRequest(bridgeInput(
    dynamicRequest,
    dynamicObservation,
    {
      sampleId: "dynamic-bridge-separation",
      entryFile: "entry-dynamic.ts",
      requestedDeclaration: declarationForMember(requested),
    },
  ));
  assert.deepEqual(dynamicBridge.reasons, []);
  const dynamicEpisodes = await loadRecord(dynamicBridge.record);
  const dynamicVector = judgeVector(dynamicEpisodes[0])[0];

  for (const slot of [44, 47, 60, 63]) {
    assert.notEqual(staticVector[slot], dynamicVector[slot], `slot ${slot}`);
  }
});

test("A1-A3 static read is admitted while a same-member request stays incomplete", async (t) => {
  const built = await buildStaticRecord();
  if (built === null) {
    t.skip("separate static producer slice is not present in this worktree");
    return;
  }
  const episodes = await loadRecord(built.bridge.record);
  const admission = admitInitialEvidence(episodes[0].requestId, episodes);
  assert.deepEqual(admission.invalidReasons, []);
  assert.ok(admission.initialObservation);
  assert.equal(admission.initialObservation.evidence.length, 1);
  assert.equal(admission.initialObservation.evidence[0].payload.kind, "source_read_receipt");
  assert.equal(
    admission.initialObservation.evidence[0].id,
    built.observation.sourceReadRef,
  );

  const assessment = assessTsJsObservedStaticSelectedRead(
    episodes,
    completionState(episodes[0]),
    admission.initialObservation.evidence,
  );
  assert.equal(assessment.status, "incomplete");
  assert.equal(assessment.producer_backed, true);
  assert.ok(
    assessment.gaps.some(gap => gap.code === "static_selected_relation_not_distinct"),
  );
  assert.equal(
    assessment.gaps.some(gap => gap.code === "static_completion_witness_unreviewed"),
    false,
  );
  assert.equal(
    assessment.gaps.some(gap => gap.code === "producer_branch_ambiguous"),
    false,
  );

  const dynamicAssessment = assessTsJsObservedDynamicCompletion(
    episodes,
    completionState(episodes[0]),
    admission.initialObservation.evidence,
  );
  assert.equal(dynamicAssessment.status, "not_applicable");
  assert.equal(dynamicAssessment.producer_backed, false);
  assert.equal(episodes[0].currentRelation.binding.value.role, "member");
});
