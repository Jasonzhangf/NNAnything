import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runTsJsSymbolTable,
} from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";
import { encodeUnifiedCandidateGroup } from "../dist/training/unified-encoder.js";
import {
  relationStepContext,
} from "../dist/training/unified-step-context-builder.js";
import {
  runTsJsRequestAwareAdmission,
  TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
} from "../dist/training/tsjs-request-aware-admission.js";

const WORKTREE = join(dirname(fileURLToPath(import.meta.url)), "..");

const FACTORY = [
  "export function createStepper(step: number) {",
  "  return (input: number) => input + step;",
  "}",
  "",
].join("\n");

const ALTERNATE = [
  "export function createStepper(step: number) {",
  "  return (input: number) => input - step;",
  "}",
  "",
].join("\n");

const ENTRY_DIRECT = [
  'import { createStepper } from "./factory";',
  "export const result = createStepper(2)(5);",
  "",
].join("\n");

const ENTRY_ALIAS = [
  'import { createStepper as makeStepper } from "./factory";',
  "export const result = makeStepper(2)(5);",
  "",
].join("\n");

const ENTRY_SHADOW = [
  'import { createStepper } from "./factory";',
  "export function useShadow() {",
  "  function createStepper(step: number) {",
  "    return (input: number) => input * step;",
  "  }",
  "  return createStepper(2)(5);",
  "}",
  "",
].join("\n");

const ENTRY_UNRESOLVED = [
  "export const result = unknownHelper(2);",
  "",
].join("\n");

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-lexical-projection-"));
  const sources = join(root, "sources");
  await mkdir(sources, { recursive: true });
  await writeFile(join(sources, "factory.ts"), FACTORY);
  await writeFile(join(sources, "alternate.ts"), ALTERNATE);
  await writeFile(join(sources, "entry-direct.ts"), ENTRY_DIRECT);
  await writeFile(join(sources, "entry-alias.ts"), ENTRY_ALIAS);
  await writeFile(join(sources, "entry-shadow.ts"), ENTRY_SHADOW);
  await writeFile(join(sources, "entry-unresolved.ts"), ENTRY_UNRESOLVED);
  return root;
}

function producerRequest(root, entryFile, files = [entryFile]) {
  return {
    repo: root,
    language: "typescript",
    scope: ["."],
    files,
  };
}

async function produce(root, entryFile, files) {
  const request = producerRequest(root, entryFile, files);
  const producer = await runTsJsSymbolTable(request);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") throw new Error("producer rejected fixture");
  return { request, producer };
}

function lexicalObservation(producer, calleeName) {
  const matches = producer.result.lexicalCallSiteBindings.filter(
    observation => observation.calleeName === calleeName,
  );
  assert.equal(matches.length, 1, `expected one lexical observation for ${calleeName}`);
  return matches[0];
}

function bridgeInput(request, callSiteRef, overrides = {}) {
  const requestRef = overrides.requestRef ?? "request:lexical-bridge";
  const pendingRelationRef = overrides.pendingRelationRef ?? "relation:lexical-bridge";
  return {
    sourceGroup: "tsjs-lexical-projection-bridge",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: "tsjs-lexical-projection-bridge-family",
    sampleId: overrides.sampleId ?? "lexical-bridge",
    entryFile: overrides.entryFile ?? "sources/entry-direct.ts",
    route: "lexical",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: "decl:sources/alternate.ts#top:createStepper",
        moduleRef: "module:sources/alternate.ts",
        name: "createStepper",
        role: "export",
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef,
        calleeName: overrides.calleeName ?? "createStepper",
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
  };
}

async function buildLexicalRecord(request, observation, entryFile, overrides = {}) {
  const bridge = await observeTsJsStepwiseRequest(
    bridgeInput(request, observation.callSiteRef, { entryFile, ...overrides }),
  );
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  return bridge.record;
}

async function loadRecord(record) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-lexical-family-"));
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

function judgeCandidates(episode) {
  return relationStepContext(episode).candidateGroup.candidates.filter(candidate =>
    candidate.optionSemantics.startsWith("judge=")
  );
}

function lexicalAdmissionConfig(root, callSiteRef, caseId = "lexical-admission") {
  return {
    schema: TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
    family: {
      familyRoot: root,
      derivedOutputDir: null,
      sourceGroup: "tsjs-lexical-projection-bridge",
      derivedSourceGroup: "tsjs-lexical-projection-bridge-derived",
      partition: "DEV",
      acceptedFamily: "lexical-fixture",
      acceptedRequestRefs: [`request:${caseId}`],
    },
    cases: [{
      caseId,
      route: "lexical",
      entryFile: "sources/entry-direct.ts",
      files: ["sources/entry-direct.ts", "sources/factory.ts"],
      requestRef: `request:${caseId}`,
      pendingRelationRef: `relation:${caseId}`,
      callSiteRef,
      sourceReadRef: "source-read:not-used-on-lexical-route",
      calleeName: "createStepper",
      requestedMemberName: "createStepper",
      requestedRole: "export",
      requestedDeclarationRef: "decl:sources/alternate.ts#top:createStepper",
      requestedModuleRef: "module:sources/alternate.ts",
      stepId: "step:0",
      coverageContract: "tsjs.lexical-call-site-binding.v1",
      workState: {
        basis: "closed lexical call-site fixture",
        remainingObligations: [],
        localCandidateCursor: {
          pendingRelationRef: `relation:${caseId}`,
          state: "closed",
          evidenceRefs: [],
        },
      },
    }],
  };
}

test("lexical producer keys the inner callee span and reports alias/shadow/refusal", async () => {
  const root = await fixtureRepo();
  try {
    const direct = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
      "sources/factory.ts",
    ]);
    const importBinding = lexicalObservation(
      direct.producer,
      "createStepper",
    );
    assert.equal(importBinding.bindingKind, "import");
    assert.equal(importBinding.sourceName, "createStepper");
    assert.equal(importBinding.targetName, "createStepper");
    assert.equal(importBinding.sourceModuleFile, "sources/factory.ts");
    assert.equal(importBinding.moduleSpecifierRaw, "./factory");
    assert.ok(importBinding.sourceModuleReadReceipt);
    assert.ok(importBinding.outerCallSiteRef);
    assert.notEqual(importBinding.outerCallSiteRef, importBinding.callSiteRef);

    const alias = await produce(root, "sources/entry-alias.ts", [
      "sources/entry-alias.ts",
      "sources/factory.ts",
    ]);
    const aliasBinding = lexicalObservation(alias.producer, "makeStepper");
    assert.equal(aliasBinding.bindingKind, "import");
    assert.equal(aliasBinding.sourceName, "createStepper");
    assert.equal(aliasBinding.targetName, "makeStepper");

    const shadow = await produce(root, "sources/entry-shadow.ts", [
      "sources/entry-shadow.ts",
      "sources/factory.ts",
    ]);
    const shadowBinding = lexicalObservation(shadow.producer, "createStepper");
    assert.equal(shadowBinding.bindingKind, "shadow");
    assert.equal(shadowBinding.sourceModuleFile, null);
    assert.ok(shadowBinding.evidenceRefs.includes(shadowBinding.callerReadReceipt.receiptId));

    const unresolved = await produce(root, "sources/entry-unresolved.ts", [
      "sources/entry-unresolved.ts",
    ]);
    const unresolvedBinding = lexicalObservation(unresolved.producer, "unknownHelper");
    assert.equal(unresolvedBinding.bindingKind, "unresolved");
    assert.equal(unresolvedBinding.unresolvedReason, "no_import_binding");
    assert.ok(unresolvedBinding.evidenceRefs.includes(unresolvedBinding.callerReadReceipt.receiptId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unread source module is refused with no edge; read source resolves the declaration", async () => {
  const root = await fixtureRepo();
  try {
    const absent = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
    ]);
    const absentObservation = lexicalObservation(absent.producer, "createStepper");
    assert.equal(absentObservation.bindingKind, "unresolved");
    assert.equal(absentObservation.unresolvedReason, "module_not_in_read_set");
    assert.equal(absentObservation.sourceModuleReadReceipt, null);
    const absentRecord = await buildLexicalRecord(
      absent.request,
      absentObservation,
      "sources/entry-direct.ts",
    );
    const absentStep = absentRecord.steps[0];
    assert.equal(absentStep.localSyntax.observedBindings.length, 0);
    assert.equal(absentStep.localSyntax.observedDeclarations.length, 0);
    const absentEpisodes = await loadRecord(absentRecord);
    assert.equal(absentEpisodes.length, 1);
    assert.equal(absentEpisodes[0].currentRelation.binding.state, "not_observed");
    assert.equal(absentEpisodes[0].currentRelation.binding.reason, "not_requested");
    for (const judge of judgeCandidates(absentEpisodes[0])) {
      assert.equal(judge.bindingProjection, null);
    }

    const present = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
      "sources/factory.ts",
    ]);
    const presentObservation = lexicalObservation(present.producer, "createStepper");
    assert.ok(presentObservation.sourceModuleReadReceipt);
    const presentRecord = await buildLexicalRecord(
      present.request,
      presentObservation,
      "sources/entry-direct.ts",
    );
    const presentStep = presentRecord.steps[0];
    const edge = presentStep.localSyntax.observedBindings[0];
    assert.equal(edge.sourceContent.state, "observed");
    assert.deepEqual(
      edge.sourceContent.resultRefs,
      [presentObservation.sourceModuleReadReceipt.receiptId],
    );
    assert.equal(presentStep.localSyntax.observedDeclarations.length, 1);
    assert.equal(edge.visibility.value, "reachable");
    assert.equal(edge.hopDepth, 1);

    const factorySymbol = present.producer.result.symbols.find(
      symbol => symbol.file === "sources/factory.ts" && symbol.name === "createStepper",
    );
    assert.ok(factorySymbol);
    const episodes = await loadRecord(presentRecord);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].currentRelation.binding.state, "not_observed");
    assert.equal(episodes[0].currentRelation.binding.reason, "not_requested");
    const context = relationStepContext(episodes[0]);
    const judges = context.candidateGroup.candidates.filter(candidate =>
      candidate.optionSemantics.startsWith("judge=")
    );
    assert.deepEqual(
      judges.map(judge => judge.optionSemantics),
      ["judge=true", "judge=false", "judge=unknown"],
    );
    for (const judge of judges) {
      assert.equal(judge.bindingProjection?.resolution.status, "resolved");
      assert.equal(
        judge.bindingProjection?.resolution.declarationRef,
        factorySymbol.symbolId,
      );
    }
    for (const candidate of context.candidateGroup.candidates) {
      if (candidate.optionSemantics.startsWith("judge=")) continue;
      assert.equal(candidate.bindingProjection, null);
    }
    // The harness supplies the selected identity only. No verdict is injected.
    assert.equal(JSON.stringify(presentRecord).includes("judge=false"), false);
    assert.equal(JSON.stringify(presentRecord).includes("\"verdict\""), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy symbolic handle does not match a span-derived call site", async () => {
  const root = await fixtureRepo();
  try {
    const built = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
      "sources/factory.ts",
    ]);
    const observation = lexicalObservation(built.producer, "createStepper");
    const bridge = await observeTsJsStepwiseRequest(bridgeInput(
      built.request,
      "call:sources/entry-direct.ts:createStepper",
      { entryFile: "sources/entry-direct.ts" },
    ));
    assert.equal(bridge.record, null);
    assert.deepEqual(bridge.reasons, ["lexical call-site binding observation not found"]);
    assert.notEqual("call:sources/entry-direct.ts:createStepper", observation.callSiteRef);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lexical admission consumes the observed call location and rejects the legacy handle", async () => {
  const root = await fixtureRepo();
  try {
    const built = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
      "sources/factory.ts",
    ]);
    const observation = lexicalObservation(built.producer, "createStepper");

    const admitted = await runTsJsRequestAwareAdmission(
      lexicalAdmissionConfig(root, observation.callSiteRef),
    );
    assert.equal(admitted.admitted, true);
    assert.equal(admitted.cases[0].admitted, true);
    assert.equal(admitted.cases[0].rejection, null);
    assert.equal(admitted.cases[0].callSiteRef, observation.callSiteRef);

    const rejected = await runTsJsRequestAwareAdmission(
      lexicalAdmissionConfig(
        root,
        "call:sources/entry-direct.ts:createStepper",
        "lexical-admission-legacy",
      ),
    );
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.cases[0].admitted, false);
    assert.equal(rejected.cases[0].rejection.code, "call_site_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadow keeps a shadowed edge and unresolved emits no fabricated edge", async () => {
  const root = await fixtureRepo();
  try {
    const shadow = await produce(root, "sources/entry-shadow.ts", [
      "sources/entry-shadow.ts",
      "sources/factory.ts",
    ]);
    const shadowObservation = lexicalObservation(shadow.producer, "createStepper");
    const shadowRecord = await buildLexicalRecord(
      shadow.request,
      shadowObservation,
      "sources/entry-shadow.ts",
    );
    const shadowEpisodes = await loadRecord(shadowRecord);
    const shadowEdge = shadowEpisodes[0].observedBindings[0];
    assert.equal(shadowEdge.edgeKind, "shadow");
    assert.equal(shadowEdge.visibility.value, "shadowed");
    assert.equal(shadowEdge.sourceContent.state, "not_requested");
    for (const judge of judgeCandidates(shadowEpisodes[0])) {
      assert.equal(judge.bindingProjection, null);
    }

    const unresolved = await produce(root, "sources/entry-unresolved.ts", [
      "sources/entry-unresolved.ts",
    ]);
    const unresolvedObservation = lexicalObservation(unresolved.producer, "unknownHelper");
    const unresolvedRecord = await buildLexicalRecord(
      unresolved.request,
      unresolvedObservation,
      "sources/entry-unresolved.ts",
      { calleeName: "unknownHelper" },
    );
    const unresolvedStep = unresolvedRecord.steps[0];
    assert.equal(unresolvedStep.localSyntax.observedBindings.length, 0);
    assert.equal(unresolvedStep.localSyntax.observedDeclarations.length, 0);
    const unresolvedEpisodes = await loadRecord(unresolvedRecord);
    assert.deepEqual(unresolvedEpisodes[0].observedBindings, []);
    for (const judge of judgeCandidates(unresolvedEpisodes[0])) {
      assert.equal(judge.bindingProjection, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a copied direct call-site string without the source receipt is not projection proof", () => {
  const callSiteRef = "call:sources/entry-direct.ts@2:23-2:42";
  const sourceReceiptId = `source-read:${callSiteRef}:source`;
  const declaration = {
    declarationRef: "decl:sources/factory.ts#top:createStepper",
    moduleRef: "module:sources/factory.ts",
    name: "createStepper",
    role: "import",
    kind: "function",
    evidenceRefs: [sourceReceiptId],
  };
  const edge = {
    edgeRef: `edge:${callSiteRef}:import`,
    callSiteRef,
    fromNodeRef: "module:sources/entry-direct.ts",
    edgeKind: "import",
    sourceName: "createStepper",
    sourceModule: {
      state: "known",
      value: "module:sources/factory.ts",
      evidenceRefs: [sourceReceiptId],
    },
    targetName: "createStepper",
    targetModule: {
      state: "known",
      value: "module:sources/entry-direct.ts",
      evidenceRefs: [sourceReceiptId],
    },
    moduleSpecifierRaw: "./factory",
    sourceContent: {
      state: "observed",
      resultRefs: [sourceReceiptId],
      reason: null,
      evidenceRefs: [sourceReceiptId],
    },
    visibility: { state: "known", value: "reachable", evidenceRefs: [sourceReceiptId] },
    hopDepth: 1,
    evidenceRefs: [callSiteRef, sourceReceiptId],
  };
  const direct = {
    symbolRef: declaration.declarationRef,
    callSiteRef,
    role: "import",
    bindingMode: "bound",
    resolution: {
      status: "resolved",
      declarationRef: declaration.declarationRef,
      moduleRef: declaration.moduleRef,
      evidenceRefs: [sourceReceiptId],
    },
    declarationRefs: [declaration],
    scopeRef: null,
    evidenceRefs: ["copied:call-site-only"],
  };
  const episode = {
    sampleId: "copied-direct-proof",
    stepId: "step:0",
    requestId: "request:copied-direct-proof",
    sourceGroup: "tsjs-lexical-projection-bridge",
    language: "typescript",
    semanticStratum: "module_export",
    partition: "dev",
    entryFile: "sources/entry-direct.ts",
    targetRef: "decl:sources/alternate.ts#top:createStepper",
    observedFacts: [],
    pendingRelationRef: "relation:copied-direct-proof",
    callSiteRef,
    requestedDeclaration: {
      declarationRef: "decl:sources/alternate.ts#top:createStepper",
      moduleRef: "module:sources/alternate.ts",
      name: "createStepper",
      role: "export",
      kind: "function",
      evidenceRefs: [],
    },
    observedBindings: [edge],
    observedDeclarations: [declaration],
    currentRelation: {
      pendingRelationRef: "relation:copied-direct-proof",
      callSiteRef,
      binding: { state: "known", value: direct, evidenceRefs: direct.evidenceRefs },
    },
    evidenceRefs: ["evidence:copied-direct-proof"],
    failureMode: null,
    derivationFamily: "tsjs-lexical-projection-bridge-family",
    adapterRef: "test:copied-direct-proof",
  };

  for (const judge of judgeCandidates(episode)) {
    assert.equal(judge.bindingProjection, null);
  }

  const withReceipt = structuredClone(episode);
  withReceipt.currentRelation.binding.value.evidenceRefs = [sourceReceiptId];
  withReceipt.currentRelation.binding.evidenceRefs = [sourceReceiptId];
  for (const judge of judgeCandidates(withReceipt)) {
    assert.equal(
      judge.bindingProjection?.resolution.declarationRef,
      declaration.declarationRef,
    );
  }

  const mismatched = structuredClone(withReceipt);
  mismatched.currentRelation.binding.value.callSiteRef = "call:sources/entry-direct.ts@9:1-9:2";
  for (const judge of judgeCandidates(mismatched)) {
    assert.equal(judge.bindingProjection, null);
  }

  for (const corrupt of [
    binding => { binding.callSiteRef = null; },
    binding => { binding.resolution.declarationRef = "decl:sources/alternate.ts#top:createStepper"; },
    binding => { binding.resolution.moduleRef = "mod:sources/alternate.ts"; },
    binding => { binding.declarationRefs[0].name = "anotherFunction"; },
  ]) {
    const copied = structuredClone(withReceipt);
    corrupt(copied.currentRelation.binding.value);
    for (const judge of judgeCandidates(copied)) assert.equal(judge.bindingProjection, null);
  }
  const canonical = structuredClone(withReceipt);
  canonical.currentRelation.binding.value.resolution.moduleRef = "mod:sources/factory.ts";
  for (const judge of judgeCandidates(canonical)) {
    assert.equal(judge.bindingProjection?.resolution.declarationRef, declaration.declarationRef);
  }
});

test("retained dynamic TRAIN row tr-h01 keeps its dynamic projection", async () => {
  const rowPath = join(
    WORKTREE,
    "training",
    "samples",
    "neural-cli",
    "tsjs",
    "train-runtime-helper-selector-r1",
    "student-observations.jsonl",
  );
  const raw = await readFile(rowPath, "utf8");
  const record = JSON.parse(raw.trim().split("\n").find(line => line.includes("\"tr-h01\"")));
  assert.equal(record.sampleId, "tr-h01");
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-lexical-trh01-"));
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
    const episodes = await loadStepwiseEpisodeFamily(familyDir);
    assert.equal(episodes.length, 1);
    const episode = episodes[0];
    assert.equal(
      episode.callSiteRef,
      "call:sources/tr-h01-import-direct/entry.ts@4:10-4:39",
    );
    assert.equal(episode.currentRelation.binding.state, "known");
    assert.equal(episode.currentRelation.binding.value.bindingMode, "dynamic");
    assert.equal(episode.currentRelation.binding.value.resolution.status, "dynamic");
    assert.equal(
      episode.currentRelation.binding.value.resolution.reason,
      "dynamic_undecidable",
    );
    assert.deepEqual(episode.currentRelation.binding.value.declarationRefs, []);
    for (const judge of judgeCandidates(episode)) {
      assert.equal(judge.bindingProjection?.bindingMode, "dynamic");
      assert.equal(judge.bindingProjection?.resolution.status, "dynamic");
      assert.equal(judge.bindingProjection?.resolution.reason, "dynamic_undecidable");
      assert.deepEqual(judge.bindingProjection?.declarationRefs, []);
    }
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
});

test("training conversion and runtime entry share the same unscored context projection", async () => {
  const root = await fixtureRepo();
  try {
    const built = await produce(root, "sources/entry-direct.ts", [
      "sources/entry-direct.ts",
      "sources/factory.ts",
    ]);
    const observation = lexicalObservation(built.producer, "createStepper");
    const record = await buildLexicalRecord(
      built.request,
      observation,
      "sources/entry-direct.ts",
    );
    const episode = (await loadRecord(record))[0];

    const context = relationStepContext(episode);
    const encoded = encodeUnifiedCandidateGroup(context);
    const group = convertEpisodeToStudentGroup(episode);
    assert.deepEqual(
      group.candidates.map(candidate => candidate.optionSemantics),
      context.candidateGroup.candidates.map(candidate => candidate.optionSemantics),
    );
    for (let index = 0; index < context.candidateGroup.candidates.length; index += 1) {
      assert.deepEqual(group.candidates[index].input, encoded[index].vector);
    }

    // Both production consumers call relationStepContext directly. Verify the
    // runtime owner still imports and invokes this same projection function;
    // do not call the runtime decision API here because it scores candidates.
    const runtimeSource = await readFile(
      join(WORKTREE, "lib", "adapters", "tsjs-unified-recursive.ts"),
      "utf8",
    );
    assert.match(runtimeSource, /import\s*\{\s*[^}]*relationStepContext[^}]*\}\s*from\s*["']\.\.\/training\/unified-step-context-builder\.js["']/s);
    assert.match(runtimeSource, /const stepContext = relationStepContext\(request\.episode\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
