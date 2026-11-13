import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  admitInitialEvidence,
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";
import { encodeUnifiedCandidateGroup } from "../dist/training/unified-encoder.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";

const SOURCE_GROUP = "tsjs-lexical-completion-test";
const DERIVATION_FAMILY = "tsjs-lexical-completion-family";
const PRIMARY_DECLARATION = "decl:sources/primary.ts#top:normalizeReading";
const SECONDARY_DECLARATION = "decl:sources/secondary.ts#top:normalizeReading";
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

async function makeSourceRoot() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-lexical-completion-source-"));
  await mkdir(join(root, "sources"), { recursive: true });
  await writeFile(
    join(root, "sources/caller.ts"),
    'import { normalizeReading as normalize } from "./primary";\nexport function run() {\n  return normalize("hello");\n}\n',
  );
  await writeFile(
    join(root, "sources/primary.ts"),
    "export function normalizeReading(value: string) {\n  return value.trim();\n}\n",
  );
  await writeFile(
    join(root, "sources/secondary.ts"),
    "export function normalizeReading(value: string) {\n  return value.trim().toLowerCase();\n}\n",
  );
  return root;
}

function producerRequest(sourceRoot) {
  return {
    repo: sourceRoot,
    language: "typescript",
    scope: ["."],
    files: [
      "sources/caller.ts",
      "sources/primary.ts",
      "sources/secondary.ts",
    ],
  };
}

function lexicalObservation(producer) {
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") throw new Error("producer rejected fixture");
  const matches = producer.result.lexicalCallSiteBindings.filter(
    observation => observation.calleeName === "normalize",
  );
  assert.equal(matches.length, 1);
  return matches[0];
}

function bridgeInput(request, observation, sample) {
  const requestRef = `request:${sample.sampleId}`;
  const pendingRelationRef = `relation:${sample.sampleId}`;
  return {
    sourceGroup: SOURCE_GROUP,
    language: "typescript",
    semanticStratum: "module_export",
    partition: "DEV",
    derivationFamily: DERIVATION_FAMILY,
    sampleId: sample.sampleId,
    entryFile: "sources/caller.ts",
    route: "lexical",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: sample.requestedDeclarationRef,
        moduleRef: sample.requestedModuleRef,
        name: "normalizeReading",
        role: "export",
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "normalize",
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

async function buildLexicalRecords() {
  const sourceRoot = await makeSourceRoot();
  const request = producerRequest(sourceRoot);
  const producer = await runTsJsSymbolTable(request);
  const observation = lexicalObservation(producer);
  const samples = [
    {
      sampleId: "lexical-same-declaration",
      requestedDeclarationRef: PRIMARY_DECLARATION,
      requestedModuleRef: "module:sources/primary.ts",
      expectedJudgement: "true",
    },
    {
      sampleId: "lexical-different-module",
      requestedDeclarationRef: SECONDARY_DECLARATION,
      requestedModuleRef: "module:sources/secondary.ts",
      expectedJudgement: "false",
    },
  ];
  const records = [];
  for (const sample of samples) {
    const bridge = await observeTsJsStepwiseRequest(
      bridgeInput(request, observation, sample),
    );
    assert.deepEqual(bridge.reasons, []);
    assert.ok(bridge.record);
    records.push(bridge.record);
  }
  return { sourceRoot, producer, observation, samples, records };
}

async function loadRecords(records, label) {
  const familyDir = await mkdtemp(join(tmpdir(), `tsjs-lexical-completion-${label}-`));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeFile(join(familyDir, "manifest.json"), JSON.stringify({
      sourceGroup: SOURCE_GROUP,
      language: "typescript",
      semanticStratum: "module_export",
      partition: "DEV",
      derivationFamily: { familyId: DERIVATION_FAMILY },
    }));
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${records.map(record => JSON.stringify(record)).join("\n")}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
}

async function writeJudgeModel(root, option) {
  const tensors = zeroTensors();
  tensors.W1[option === "true" ? 36 : 37] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  await writeFile(join(root, "feature-thresholds.json"), JSON.stringify(THRESHOLDS));
  await writeFile(join(root, "missing-mode.json"), JSON.stringify(MISSING_MODE));
  return saveUnifiedModelPackageAtomic(
    join(root, `package-${option}.json`),
    createUnifiedModelPackage({
      modelId: `tsjs-lexical-completion-${option}`,
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

async function runSample(sourceRoot, episodes, packagePath) {
  return runTsJsUnifiedMultiStepDecision({
    requestId: episodes[0].requestId,
    packagePath,
    episodes,
    grantedEffects: ["read_only"],
    executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
  });
}

test("lexical provenance admits real reads and binding without changing the student projection", async () => {
  const built = await buildLexicalRecords();
  try {
    const episodes = await loadRecords(built.records, "current");
    assert.equal(episodes.length, 2);

    const withoutProvenance = structuredClone(built.records);
    for (const record of withoutProvenance) {
      for (const receipt of record.steps[0].receipts) delete receipt.producerSource;
    }
    const preProvenance = await loadRecords(withoutProvenance, "pre");
    assert.equal(preProvenance.length, 2);

    for (const [index, episode] of episodes.entries()) {
      const admission = admitInitialEvidence(episode.requestId, [episode]);
      assert.deepEqual(admission.invalidReasons, []);
      const evidence = admission.initialObservation?.evidence ?? [];
      assert.equal(evidence.length, 3);
      assert.equal(
        evidence.filter(record => record.payload.kind === "source_read_receipt").length,
        2,
      );
      assert.equal(
        evidence.filter(record => record.payload.kind === "import_binding_observation").length,
        1,
      );
      const provenance = episode.receipts[0].producerSource;
      assert.equal(provenance.kind, "nnanything.tsjs.producer-source.lexical.v1");
      assert.equal(provenance.sourceSymbols.length, 1);
      assert.equal(
        provenance.sourceSymbols[0].symbolId,
        "sources/primary.ts#normalizeReading@1:1-3:2",
      );

      const before = encodeUnifiedCandidateGroup(
        relationStepContext(preProvenance[index]),
      );
      const after = encodeUnifiedCandidateGroup(relationStepContext(episode));
      assert.deepEqual(
        after.map(item => item.candidateRef),
        before.map(item => item.candidateRef),
      );
      for (let candidateIndex = 0; candidateIndex < after.length; candidateIndex += 1) {
        assert.deepEqual(after[candidateIndex].vector, before[candidateIndex].vector);
        assert.deepEqual(after[candidateIndex].missingMode, before[candidateIndex].missingMode);
      }
    }
  } finally {
    await rm(built.sourceRoot, { recursive: true, force: true });
  }
});

test("lexical completion requires model judgement and exact source evidence to agree", async () => {
  const built = await buildLexicalRecords();
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-lexical-completion-model-"));
  try {
    const episodes = await loadRecords(built.records, "consumer");
    const bySample = new Map(episodes.map(episode => [episode.sampleId, [episode]]));
    const truePackage = await writeJudgeModel(modelRoot, "true");
    const falsePackage = await writeJudgeModel(modelRoot, "false");

    const trueResult = await runSample(
      built.sourceRoot,
      bySample.get("lexical-same-declaration"),
      truePackage,
    );
    assert.deepEqual(trueResult.initialEvidenceInvalidReasons, []);
    assert.equal(trueResult.rootCompletion.predictedJudgement, "true");
    assert.equal(trueResult.rootCompletion.positiveRootSatisfied, true);
    assert.equal(trueResult.rootCompletion.queryCompletion, "complete_true");

    const falseResult = await runSample(
      built.sourceRoot,
      bySample.get("lexical-different-module"),
      falsePackage,
    );
    assert.deepEqual(falseResult.initialEvidenceInvalidReasons, []);
    assert.equal(falseResult.rootCompletion.predictedJudgement, "false");
    assert.equal(falseResult.rootCompletion.positiveRootSatisfied, false);
    assert.equal(falseResult.rootCompletion.queryCompletion, "complete_false");

    const falseAgainstPositive = await runSample(
      built.sourceRoot,
      bySample.get("lexical-same-declaration"),
      falsePackage,
    );
    assert.equal(falseAgainstPositive.rootCompletion.predictedJudgement, "false");
    assert.equal(falseAgainstPositive.rootCompletion.queryCompletion, "incomplete");

    const trueAgainstNegative = await runSample(
      built.sourceRoot,
      bySample.get("lexical-different-module"),
      truePackage,
    );
    assert.equal(trueAgainstNegative.rootCompletion.predictedJudgement, "true");
    assert.equal(trueAgainstNegative.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
    await rm(built.sourceRoot, { recursive: true, force: true });
  }
});

test("lexical loader rejects tampered receipts and substituted declaration projections", async () => {
  const built = await buildLexicalRecords();
  try {
    const receiptTamper = structuredClone(built.records[0]);
    receiptTamper.steps[0].receipts[0].target = "module:sources/secondary.ts";
    await assert.rejects(loadRecords([receiptTamper], "receipt-tamper"));

    const requestTamper = structuredClone(built.records[0]);
    requestTamper.steps[0].receipts[0].producerSource.requestRef = "request:other";
    await assert.rejects(loadRecords([requestTamper], "request-tamper"));

    const callSiteTamper = structuredClone(built.records[0]);
    callSiteTamper.steps[0].receipts[0].producerSource.rawObservation.callSiteRef =
      "call:sources/caller.ts@9:1-9:9";
    await assert.rejects(loadRecords([callSiteTamper], "call-site-tamper"));

    const sourceReceiptTamper = structuredClone(built.records[0]);
    sourceReceiptTamper.steps[0].receipts[0].producerSource.rawObservation
      .sourceModuleReadReceipt.targetRef = "module:sources/secondary.ts";
    await assert.rejects(loadRecords([sourceReceiptTamper], "source-receipt-tamper"));

    const receiptResultTamper = structuredClone(built.records[0]);
    receiptResultTamper.steps[0].receipts[0].result = ["source-read:sources/caller.ts:wrong"];
    await assert.rejects(loadRecords([receiptResultTamper], "receipt-result-tamper"));

    const symbolTamper = structuredClone(built.records[0]);
    symbolTamper.steps[0].receipts[0].producerSource.sourceSymbols[0].symbolId =
      "sources/secondary.ts#normalizeReading@1:1-3:2";
    await assert.rejects(loadRecords([symbolTamper], "symbol-tamper"));

    const projectionTamper = structuredClone(built.records[0]);
    projectionTamper.steps[0].localSyntax.observedDeclarations[0].declarationRef =
      SECONDARY_DECLARATION;
    projectionTamper.steps[0].localSyntax.observedDeclarations[0].moduleRef =
      "module:sources/secondary.ts";
    await assert.rejects(loadRecords([projectionTamper], "projection-tamper"));
  } finally {
    await rm(built.sourceRoot, { recursive: true, force: true });
  }
});

test("lexical completion stays incomplete when source reads or current work are not closed", async () => {
  const built = await buildLexicalRecords();
  const modelRoot = await mkdtemp(join(tmpdir(), "tsjs-lexical-incomplete-model-"));
  try {
    const truePackage = await writeJudgeModel(modelRoot, "true");
    const sourceFailed = await loadRecords(built.records, "source-failed");
    sourceFailed[0].receipts[0].producerSource.rawObservation
      .sourceModuleReadReceipt.outcome = "failed";
    const sourceFailedResult = await runSample(
      built.sourceRoot,
      [sourceFailed[0]],
      truePackage,
    );
    assert.notDeepEqual(sourceFailedResult.initialEvidenceInvalidReasons, []);
    assert.equal(sourceFailedResult.rootCompletion.queryCompletion, "incomplete");

    const truncated = await loadRecords(built.records, "truncated");
    truncated[0].receipts[0].producerSource.coverage.truncated = true;
    const truncatedResult = await runSample(
      built.sourceRoot,
      [truncated[0]],
      truePackage,
    );
    assert.notDeepEqual(truncatedResult.initialEvidenceInvalidReasons, []);
    assert.equal(truncatedResult.rootCompletion.queryCompletion, "incomplete");

    const openCursor = await loadRecords(built.records, "open-cursor");
    openCursor[0].localCandidateCursor.state = "open";
    const openCursorResult = await runSample(
      built.sourceRoot,
      [openCursor[0]],
      truePackage,
    );
    assert.deepEqual(openCursorResult.initialEvidenceInvalidReasons, []);
    assert.equal(openCursorResult.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(modelRoot, { recursive: true, force: true });
    await rm(built.sourceRoot, { recursive: true, force: true });
  }
});
