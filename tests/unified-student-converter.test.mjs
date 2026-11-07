import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import { encodeUnifiedCandidateGroup } from "../dist/training/unified-encoder.js";
import {
  UNIFIED_STUDENT_GROUP_SCHEMA,
  convertEpisodeToStudentGroup,
  loadEpisodeFamily,
  partitionOf,
  studentGroupId,
} from "../dist/training/unified-student-converter.js";

function familyFixture() {
  return {
    sampleId: "sample-1",
    requestId: "request-1",
    sourceGroup: "source-group",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    entryFile: "sources/src/entry.ts",
    targetRef: "sources/src/impl.ts#top:helper",
    observedFacts: ["import forwarded as helper from ./util", "module file present"],
    evidenceRefs: ["evidence/pre-state.jsonl#sample-1"],
    failureMode: "reexport_alias_misdirection",
    derivationFamily: "family-1",
    adapterRef: "tsjs-unified-adapter:ts",
  };
}

test("builds complete typed judge S_g with one 64-slot row per candidate", () => {
  const group = convertEpisodeToStudentGroup(familyFixture());
  assert.equal(group.schema, UNIFIED_STUDENT_GROUP_SCHEMA);
  assert.equal(group.candidateEnumeration, "complete");
  assert.deepEqual(
    group.candidates.map(candidate => candidate.optionSemantics),
    ["judge=true", "judge=false", "judge=unknown", "RETURN"],
  );
  for (const candidate of group.candidates) {
    assert.equal(candidate.input.length, 64);
  }
  assert.ok(!("gold" in group));
  assert.ok(!("allowed" in group));
  assert.ok(!("goldAllowedCandidateRefs" in group));
});

test("student group id includes source, sample, context, and candidate group", () => {
  const groupId = studentGroupId({
    sourceGroup: "source-group",
    sampleId: "sample-1",
    stepContextRef: "ctx:sample-1:step:0",
    candidateGroupRef: "cg:sample-1:step:0:0",
  });
  assert.equal(groupId, "source-group|sample-1|ctx:sample-1:step:0|cg:sample-1:step:0:0");
  const episode = familyFixture();
  const group = convertEpisodeToStudentGroup(episode);
  assert.equal(group.group_id, groupId);
});

test("same episode converted twice produces identical rows", () => {
  const episode = familyFixture();
  assert.deepEqual(convertEpisodeToStudentGroup(episode), convertEpisodeToStudentGroup(episode));
});

test("typed observations produce dynamic candidates without reading correction text", () => {
  const requested = {
    declarationRef: "decl:closure.ts#top:base",
    moduleRef: "module:closure.ts",
    name: "base",
    role: "export",
    kind: "function",
    evidenceRefs: ["ev:decl"],
  };
  const base = {
    ...familyFixture(),
    targetRef: "decl:closure.ts#top:base",
    pendingRelationRef: "relation:closure.ts:makeShadow:addOffset",
    callSiteRef: "call:closure.ts:1",
    requestedDeclaration: requested,
    observedDeclarations: [{
      declarationRef: "decl:closure.ts:makeShadow:local:base",
      moduleRef: "module:closure.ts",
      name: "base",
      role: "shadow",
      kind: "function",
      evidenceRefs: ["ev:local"],
    }],
    observedBindings: [{
      edgeRef: "edge:closure.ts:import:1",
      callSiteRef: "call:closure.ts:1",
      fromNodeRef: "module:entry.ts",
      edgeKind: "import",
      sourceName: "base",
      sourceModule: { state: "known", value: "module:entry.ts", evidenceRefs: ["ev:edge"] },
      targetName: "base",
      targetModule: { state: "known", value: "module:closure.ts", evidenceRefs: ["ev:edge"] },
      moduleSpecifierRaw: "./closure",
      sourceContent: { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: ["ev:edge"] },
      visibility: { state: "known", value: "reachable", evidenceRefs: ["ev:edge"] },
      hopDepth: 1,
      evidenceRefs: ["ev:edge"],
    }],
    remainingObligations: [
      {
        kind: "advance",
        ref: "edge:closure.ts:import:1",
        pendingRelationRef: "relation:closure.ts:makeShadow:addOffset",
        arguments: [{ name: "target", type: "binding_edge", valueRef: "edge:closure.ts:import:1" }],
        informationGain: 1,
      },
      {
        kind: "observe",
        ref: "obligation:registry",
        pendingRelationRef: "relation:closure.ts:makeShadow:addOffset",
        arguments: [{ name: "target", type: "call_site", valueRef: "call:closure.ts:1" }],
        informationGain: 1,
      },
    ],
  };
  const withoutCorrection = convertEpisodeToStudentGroup(base);
  const withPostHocCorrection = convertEpisodeToStudentGroup({
    ...base,
    correctedBindingFact: {
      origin: "post_hoc_oracle",
      text: "computedName folds to base and registry maps base to closure.ts#top:base",
    },
  });
  assert.deepEqual(withPostHocCorrection, withoutCorrection);
  assert.deepEqual(
    withoutCorrection.candidates.map(candidate => candidate.optionSemantics),
    ["judge=true", "judge=false", "judge=unknown", "advance", "observe", "DEFER"],
  );
});

test("partitionOf maps only explicit source partitions", () => {
  assert.equal(partitionOf("train"), "TRAIN");
  assert.equal(partitionOf("dev"), "DEV");
  assert.equal(partitionOf("verification"), "VERIFICATION");
  assert.throws(() => partitionOf("TRAIN"), TypeError);
});

test("open enumeration cursor stays unencodable before training", () => {
  const context = relationStepContext({
    ...familyFixture(),
    pendingRelationRef: "relation:closure.ts:makeAdder:addOffset",
    callSiteRef: "call:closure.ts:1",
    requestedDeclaration: {
      declarationRef: "decl:closure.ts#top:base",
      moduleRef: "module:closure.ts",
      name: "base",
      role: "export",
      kind: "function",
      evidenceRefs: ["ev:decl"],
    },
    observedBindings: [],
    observedDeclarations: [],
    remainingObligations: [{
      kind: "observe",
      ref: "obligation:registry",
      pendingRelationRef: "relation:closure.ts:makeAdder:addOffset",
      informationGain: 1,
    }],
    cursorOpen: true,
  });
  assert.equal(context.candidateGroup.enumeration, "truncated");
  assert.deepEqual(
    context.candidateGroup.candidates.map(candidate => candidate.optionSemantics),
    ["judge=true", "judge=false", "judge=unknown", "observe", "DEFER"],
  );
  assert.throws(
    () => encodeUnifiedCandidateGroup(context),
    /candidate group must be complete before encoding/,
  );
});

test("loader reads only episode and pre-state observation inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "student-converter-"));
  try {
    const evidence = join(root, "evidence");
    await mkdir(evidence, { recursive: true });
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      sourceGroup: "source-group",
      language: "ts",
      semanticStratum: "module_export",
      partition: "train",
      derivationFamily: { familyId: "family-1" },
    }));
    await writeFile(join(evidence, "pre-state.jsonl"), `${JSON.stringify({
      sampleId: "sample-1",
      observedFacts: ["fact-1"],
    })}\n`);
    await writeFile(join(root, "episode-sample-1.jsonl"), `${JSON.stringify({
      sampleId: "sample-1",
      requestId: "request-1",
      sourceGroup: "source-group",
      language: "ts",
      semanticStratum: "module_export",
      partition: "train",
      entryFile: "entry.ts",
      goal: { targetRef: "impl.ts#top:helper" },
      failureMode: null,
      evidenceRefs: [],
    })}\n`);
    const episodes = await loadEpisodeFamily(root);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].observedFacts[0], "fact-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
