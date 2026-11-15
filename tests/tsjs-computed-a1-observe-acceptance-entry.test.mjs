import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = join(HERE, "../scripts/accept-tsjs-computed-a1-observe.mjs");
const HARNESS_ENTRY = HARNESS_PATH;
const CANDIDATE_PACKAGE =
  "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113/candidate-package.json";

async function writeCase(root, value) {
  const casePath = join(root, "case.json");
  await writeFile(casePath, JSON.stringify(value), "utf8");
  return casePath;
}

function known01CaseFixture(repoRoot) {
  const callerSource = [
    'import { createStepper } from "./factory";',
    "",
    'const table: Record<string, typeof createStepper> = { createStepper };',
    'const computedName = "create" + "Stepper";',
    "",
    "export const result = table[computedName](1)(2);",
    "",
  ].join("\n");
  const factorySource = [
    "export function createStepper(delta: number) {",
    "  return (value: number) => value + delta;",
    "}",
    "",
    "export function createShadowedStepper(delta: number) {",
    "  return (value: number) => value - delta;",
    "}",
    "",
  ].join("\n");
  return {
    schema: "nnanything.tsjs.computed-a1-acceptance-case.v1",
    caseId: "tsjs-computed-a1-known-01",
    requestId: "request:tsjs-computed-a1-known-01",
    sourceRoot: repoRoot,
    packagePath: CANDIDATE_PACKAGE,
    observe: {
      kind: "constant_computed_property_v1",
      readSet: {
        repoRoot,
        callerFile: "entry.ts",
        language: "typescript",
        files: ["entry.ts", "factory.ts"],
        grantedEffects: ["read_only"],
      },
    },
    episodes: [
      {
        schema: "nnanything.tsjs.stepwise-episode.v1",
        sampleId: "tsjs-computed-a1-known-01",
        stepId: "step-observe",
        requestId: "request:tsjs-computed-a1-known-01",
        sourceGroup: "tsjs-computed-a1-known-01",
        language: "typescript",
        semanticStratum: "module_export",
        partition: "DEV",
        entryFile: "entry.ts",
        targetRef: "pending:computed-observe-a1",
        observedFacts: [],
        pendingRelationRef: "pending:computed-observe-a1",
        callSiteRef: "call:entry.ts@6:23-6:48",
        calleeName: "createStepper",
        requestedDeclaration: {
          declarationRef: "decl:factory.ts#top:createStepper",
          moduleRef: "module:factory.ts",
          name: "createStepper",
          role: "export",
          kind: "function",
          evidenceRefs: [],
        },
        observedBindings: [],
        observedDeclarations: [],
        evidenceRefs: [],
        failureMode: null,
        derivationFamily: "tsjs-computed-a1-known-01",
        adapterRef: "adapter:tsjs",
        remainingObligations: [{
          kind: "observe",
          ref: "obligation:observe:computed",
          pendingRelationRef: "pending:computed-observe-a1",
          arguments: [{
            name: "target",
            type: "call_site",
            valueRef: "call:entry.ts@6:23-6:48",
          }],
          informationGain: 1,
        }],
        localCandidateCursor: {
          pendingRelationRef: "pending:computed-observe-a1",
          state: "closed",
          evidenceRefs: [],
        },
      },
      {
        schema: "nnanything.tsjs.stepwise-episode.v1",
        sampleId: "tsjs-computed-a1-known-01",
        stepId: "step-judge",
        requestId: "request:tsjs-computed-a1-known-01",
        sourceGroup: "tsjs-computed-a1-known-01",
        language: "typescript",
        semanticStratum: "module_export",
        partition: "DEV",
        entryFile: "entry.ts",
        targetRef: "decl:factory.ts#top:createStepper",
        observedFacts: [],
        pendingRelationRef: "pending:computed-observe-a1",
        callSiteRef: "call:entry.ts@6:23-6:48",
        calleeName: "createStepper",
        requestedDeclaration: {
          declarationRef: "decl:factory.ts#top:createStepper",
          moduleRef: "module:factory.ts",
          name: "createStepper",
          role: "export",
          kind: "function",
          evidenceRefs: [],
        },
        observedBindings: [{
          edgeRef: "edge:tsjs-computed-a1-known-01:next",
          callSiteRef: "call:entry.ts@6:23-6:48",
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
            value: "module:entry.ts",
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
        observedDeclarations: [],
        evidenceRefs: [],
        failureMode: null,
        derivationFamily: "tsjs-computed-a1-known-01",
        adapterRef: "adapter:tsjs",
        remainingObligations: [],
        localCandidateCursor: {
          pendingRelationRef: "pending:computed-observe-a1",
          state: "closed",
          evidenceRefs: [],
        },
      },
    ],
    _callerSource: callerSource,
    _factorySource: factorySource,
  };
}

async function writeKnown01Fixture(root) {
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  const fixture = known01CaseFixture(sourceRoot);
  const callerPath = join(sourceRoot, "entry.ts");
  const factoryPath = join(sourceRoot, "factory.ts");
  await writeFile(callerPath, fixture._callerSource, "utf8");
  await writeFile(factoryPath, fixture._factorySource, "utf8");
  const { _callerSource, _factorySource, ...caseValue } = fixture;
  const casePath = await writeCase(root, caseValue);
  return { casePath, caseValue, sourceRoot };
}

function findCapture(captures, candidateRef) {
  return captures.find(capture =>
    capture.candidates.some(candidate => candidate.candidateRef === candidateRef));
}

function chosenSemantics(capture) {
  const candidate = capture.candidates.find(
    item => item.candidateRef === capture.chosen.candidateRef);
  assert.ok(candidate, "chosen candidate is missing from its own capture");
  return candidate.optionSemantics;
}

function realCaptureFields(capture) {
  return {
    schema: capture.schema,
    stepId: capture.stepId,
    candidateCount: capture.candidates.length,
    candidateRefs: capture.candidates.map(candidate => candidate.candidateRef),
    chosen: capture.chosen,
    candidateVectorLengths: capture.candidates.map(candidate => candidate.vector.length),
    missingModeCount: capture.candidates.filter(candidate =>
      Object.hasOwn(candidate, "missingMode")).length,
  };
}

test("harness rejects unknown or duplicate CLI arguments before reading files", async () => {
  const cases = [
    ["--case", "one", "--package", "two", "--out", "three", "--extra", "four"],
    ["--case", "one", "--case", "two", "--package", "three", "--out", "four"],
    ["--case", "one", "--package", "three"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [HARNESS_ENTRY, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    const error = JSON.parse(result.stderr.trim());
    assert.equal(error.status, "INVALID");
    assert.match(error.error.message, /invalid harness arguments/);
  }
});

test("harness rejects structurally invalid case input without calling the runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-a1-acceptance-invalid-"));
  try {
    const casePath = await writeCase(root, {
      schema: "nnanything.tsjs.computed-a1-acceptance-case.v1",
      caseId: "invalid-case",
      requestId: "request:invalid-case",
      sourceRoot: root,
      packagePath: CANDIDATE_PACKAGE,
      observe: {
        kind: "unsupported_kind",
        readSet: {
          repoRoot: root,
          callerFile: "entry.ts",
          language: "typescript",
          files: ["entry.ts"],
          grantedEffects: ["read_only"],
        },
      },
      episodes: [],
    });
    const out = join(root, "result");
    const run = spawnSync(process.execPath, [
      HARNESS_ENTRY, "--case", casePath, "--package", CANDIDATE_PACKAGE, "--out", out,
    ], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    const receipt = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.equal(receipt.status, "INVALID");
    assert.match(receipt.error.message, /case episodes|case schema/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("harness fails closed as UNAVAILABLE before the accepted A1 runtime is integrated", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-a1-acceptance-unavailable-"));
  try {
    const { casePath } = await writeKnown01Fixture(root);
    const out = join(root, "result");
    const run = spawnSync(process.execPath, [
      HARNESS_ENTRY, "--case", casePath, "--package", CANDIDATE_PACKAGE, "--out", out,
    ], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    const receipt = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.equal(receipt.status, "UNAVAILABLE");
    assert.equal(receipt.dependency, "A1_RUNTIME_NOT_INTEGRATED");
    assert.equal(receipt.missingField, "request.observe");
    assert.equal(receipt.missingKind, "constant_computed_property_v1");
    assert.equal(receipt.dependencySource, "/Volumes/Intel/playground/nnanything/tsjs-computed-observe-a1-20261115");
    assert.equal(receipt.dependencyStatus, "read_only_accepted_evidence_not_integrated");
    assert.deepEqual(receipt.stepIds, ["step-observe", "step-judge"]);
    assert.ok(receipt.receipt.at(-1));
    await assert.rejects(() => readFile(join(out, "run-result.json")));
    await assert.rejects(() => readFile(join(out, "selection-captures.json")));
    await assert.rejects(() => readFile(join(out, "candidate-scores.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-integration KNOWN-01 keeps the saved judge=unknown failure and rejects fabricated progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsjs-a1-acceptance-known01-"));
  try {
    const { casePath } = await writeKnown01Fixture(root);
    const out = join(root, "result");
    const run = spawnSync(process.execPath, [
      HARNESS_ENTRY, "--case", casePath, "--package", CANDIDATE_PACKAGE, "--out", out,
    ], { encoding: "utf8" });
    const runtimeText = await readFile(
      new URL("../dist/adapters/tsjs-unified-recursive.js", `file://${HERE}/`),
      "utf8");
    if (!runtimeText.includes("constant_computed_property_v1")) {
      assert.notEqual(run.status, 0);
      const receipt = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
      assert.equal(receipt.status, "UNAVAILABLE");
      return;
    }
    assert.equal(run.status, 1);
    const receipt = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.equal(receipt.status, "CAPTURED");
    assert.equal(receipt.selectedObserveAcceptance, "FAIL");
    assert.equal(receipt.caseId, "tsjs-computed-a1-known-01");
    assert.equal(receipt.modelBinding.packagePath, CANDIDATE_PACKAGE);
    assert.equal(receipt.dispatchCounts.observeDispatches, 0);
    assert.equal(receipt.dispatchCounts.readDispatches, 0);
    assert.equal(receipt.observe, undefined);
    assert.deepEqual(receipt.nextJudge, []);
    const captures = JSON.parse(
      await readFile(join(out, "selection-captures.json"), "utf8"));
    assert.equal(receipt.rootCompletion.queryCompletion, "incomplete");
    assert.equal(receipt.rootCompletion.positiveRootSatisfied, false);
    assert.deepEqual(receipt.selectedObserveFailure.chosen, [{
      stepId: "step-observe",
      candidateRef: "c:judge:unknown",
      score: captures[0].chosen.score,
    }]);
    assert.ok(Array.isArray(receipt.rootCompletion.positiveRootGaps));
    assert.ok(receipt.rootCompletion.positiveRootGaps.some(
      gap => gap.code === "A2_COMPLETION_WITNESS_NOT_IMPLEMENTED",
    ));
    assert.equal(captures.length, 1);
    assert.deepEqual(realCaptureFields(captures[0]), {
      schema: "nnanything.tsjs.step-selection-capture.v1",
      stepId: "step-observe",
      candidateCount: 5,
      candidateRefs: [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        "c:observe:obligation:observe:computed",
        "c:defer",
      ],
      chosen: {
        candidateRef: "c:judge:unknown",
        skillRef: "skill:relation.judge",
        score: captures[0].chosen.score,
      },
      candidateVectorLengths: [64, 64, 64, 64, 64],
      missingModeCount: 5,
    });
    for (const candidate of captures[0].candidates) {
      assert.ok(Array.isArray(candidate.missingMode));
    }
    const scores = JSON.parse(
      await readFile(join(out, "candidate-scores.json"), "utf8"));
    assert.equal(scores.length, 1);
    assert.equal(scores[0].stepId, "step-observe");
    assert.deepEqual(
      scores[0].candidateScores.map(candidate => candidate.candidateRef),
      [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        "c:observe:obligation:observe:computed",
        "c:defer",
      ],
    );
    for (const candidate of scores[0].candidateScores) {
      assert.ok(Number.isFinite(candidate.score));
    }
    const chosenScore = scores[0].candidateScores.find(candidate =>
      candidate.candidateRef === "c:judge:unknown");
    assert.ok(chosenScore);
    assert.ok(
      Math.abs(chosenScore.score - captures[0].chosen.score) <= 1e-12,
      "recomputed chosen score must match the runtime capture",
    );
    const unknownCapture = findCapture(captures, "c:judge:unknown");
    assert.ok(unknownCapture);
    assert.equal(chosenSemantics(unknownCapture), "judge=unknown");
    assert.ok(findCapture(captures, "c:observe:obligation:observe:computed"));
    assert.deepEqual(
      captures.map(capture => capture.chosen.candidateRef),
      ["c:judge:unknown"],
    );
    const runResult = JSON.parse(await readFile(join(out, "run-result.json"), "utf8"));
    assert.equal(runResult.status, "CAPTURED");
    assert.equal(runResult.dispatchCounts.observeDispatches, 0);
    assert.equal(runResult.dispatchCounts.readDispatches, 0);
    const runtimeFacts = JSON.stringify({
      result: runResult.result,
      dispatches: runResult.dispatches,
    });
    assert.ok(!runtimeFacts.includes("producerRequest"));
    assert.ok(!runtimeFacts.includes("producerResult"));
    assert.ok(!runtimeFacts.includes("observeAdmissions"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
