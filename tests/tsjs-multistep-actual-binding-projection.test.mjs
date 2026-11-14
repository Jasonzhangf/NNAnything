import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../dist/adapters/tsjs-unified-recursive.js";
import {
  generateOldDevStepwise,
} from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";
import {
  loadStepwiseEpisodeFamily,
} from "../dist/training/unified-student-converter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAMILY_ROOT = join(HERE, "../training/samples/neural-cli/tsjs/dev-closure-shadow-b");
const CANDIDATE_PACKAGE =
  "/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/tsjs-post-projection-training-r1-20261113/candidate-package.json";
const MISMATCH_ID = "c-dev-negative-same-name-other";
const POSITIVE_ID = "c-dev-positive-factory-call";
const ALIAS_STAGED_ROOT =
  "/Volumes/Intel/playground/nnanything-runs/p1-1-typed-dynamic-recursive-20261107/staged/train-module-export-alias-a";
const ALIAS_SOURCE_ROOT = join(
  HERE,
  "../training/samples/neural-cli/tsjs/train-module-export-alias-a",
);

async function buildFamily() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-multistep-actual-binding-"));
  const familyRoot = join(root, "dev-closure-shadow-b");
  const derivedDir = join(root, "derived");
  await cp(FAMILY_ROOT, familyRoot, { recursive: true });
  await mkdir(derivedDir, { recursive: true });
  await generateOldDevStepwise({
    familyRoot,
    outDir: derivedDir,
    receiptPath: join(derivedDir, "control-receipts.json"),
    derivedSourceGroup: "tsjs-multistep-actual-binding-red",
  });
  return { root, familyRoot, episodes: await loadStepwiseEpisodeFamily(derivedDir) };
}

function sample(episodes, sampleId) {
  const selected = episodes.filter(episode => episode.sampleId === sampleId);
  assert.ok(selected.length > 0, `missing sample ${sampleId}`);
  return selected;
}

function bindingOf(episode) {
  const value = episode.currentRelation?.binding;
  assert.ok(value, "missing current relation binding");
  if (value.state !== "known") return null;
  return value.value;
}

function judgeCandidates(capture) {
  return capture.candidates.filter(candidate => candidate.optionSemantics.startsWith("judge="));
}

function judgeRelationsOf(capture) {
  const requested = capture.context.goal.requestedDeclaration?.declarationRef ?? null;
  return capture.context.candidateGroup.candidates
    .filter(candidate => candidate.optionSemantics.startsWith("judge="))
    .map(candidate => ({
      candidateRef: candidate.candidateRef,
      actualDeclarationRef:
        candidate.bindingProjection?.resolution.status === "resolved"
          ? candidate.bindingProjection.resolution.declarationRef
          : null,
      requestedDeclarationRef: requested,
    }));
}

function comparisonSlots(capture) {
  return judgeCandidates(capture).map(candidate => [candidate.vector[61], candidate.vector[62]]);
}

async function run(sourceRoot, episodes, requestId) {
  const captures = [];
  const result = await runTsJsUnifiedMultiStepDecision({
    requestId,
    packagePath: CANDIDATE_PACKAGE,
    episodes,
    grantedEffects: ["read_only"],
    executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
    onStepSelection(capture) {
      captures.push(structuredClone(capture));
    },
  });
  return { result, captures };
}

test("mismatch preserves actual factory declaration separately from requested alternate", async () => {
  const built = await buildFamily();
  try {
    const episodes = sample(built.episodes, MISMATCH_ID);
    const { result, captures } = await run(built.familyRoot, episodes, "actual-binding-mismatch");
    assert.ok(captures.length >= 2, JSON.stringify(captures.map(capture => capture.stepId)));
    const judge = captures.at(-1);
    assert.ok(judge, "missing judge selection capture");
    assert.equal(judgeCandidates(judge).length, 3);
    assert.deepEqual(judgeRelationsOf(judge), [
      {
        candidateRef: "c:judge:true",
        actualDeclarationRef: "decl:sources/src/factory.ts#top:createStepper",
        requestedDeclarationRef: "decl:sources/src/alternate.ts#top:createStepper",
      },
      {
        candidateRef: "c:judge:false",
        actualDeclarationRef: "decl:sources/src/factory.ts#top:createStepper",
        requestedDeclarationRef: "decl:sources/src/alternate.ts#top:createStepper",
      },
      {
        candidateRef: "c:judge:unknown",
        actualDeclarationRef: "decl:sources/src/factory.ts#top:createStepper",
        requestedDeclarationRef: "decl:sources/src/alternate.ts#top:createStepper",
      },
    ]);
    assert.deepEqual(comparisonSlots(judge), Array(3).fill([0, 0]));
    assert.equal(
      judge.context.goal.requestedDeclaration.declarationRef,
      "decl:sources/src/alternate.ts#top:createStepper",
    );
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.declarationRef,
      "decl:sources/src/factory.ts#top:createStepper",
    );
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    const factoryDeclarations = terminalState.realModuleFacts.filter(fact =>
      fact.kind === "declaration"
      && fact.moduleRef === "sources/src/factory.ts"
      && fact.name === "createStepper");
    assert.equal(factoryDeclarations.length, 1);
    assert.ok(terminalState.readObservations.some(observation =>
      observation.stepId === "step-0"
      && observation.moduleRefs.includes("sources/src/factory.ts")
      && observation.moduleFacts.some(fact =>
        fact.kind === "declaration"
        && fact.moduleRef === "sources/src/factory.ts"
        && fact.name === "createStepper")));
    assert.equal(
      judge.context.goal.requestedDeclaration.declarationRef,
      "decl:sources/src/alternate.ts#top:createStepper",
    );
    assert.ok(["true", "false", "unknown"].includes(result.rootCompletion.predictedJudgement));
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
    assert.ok(result.rootCompletion.evidenceRefs.includes("ev:step-0:sources/src/factory.ts:read"));
    if (process.env.TSJS_CAPTURE_RESULT === "1") {
      console.log(JSON.stringify({
        case: MISMATCH_ID,
        modelChoice: result.sampleReceipt?.steps.at(-1)?.optionSemantics ?? null,
        predictedJudgement: result.rootCompletion.predictedJudgement,
        positiveRootSatisfied: result.rootCompletion.positiveRootSatisfied,
        queryCompletion: result.rootCompletion.queryCompletion,
        actualDeclarationRefs: judgeRelationsOf(judge).map(item => item.actualDeclarationRef),
        requestedDeclarationRef: judge.context.goal.requestedDeclaration.declarationRef,
        comparisonSlots: comparisonSlots(judge),
      }));
    }
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("positive multi-step control keeps the requested declaration comparison", async () => {
  const built = await buildFamily();
  try {
    const episodes = sample(built.episodes, POSITIVE_ID);
    const { result, captures } = await run(built.familyRoot, episodes, "actual-binding-positive");
    assert.ok(captures.length >= 2);
    const judge = captures.at(-1);
    assert.ok(judge);
    assert.equal(judgeCandidates(judge).length, 3);
    assert.deepEqual(
      judgeRelationsOf(judge).map(item => item.actualDeclarationRef),
      Array(3).fill("decl:sources/src/factory.ts#top:createStepper"),
    );
    assert.deepEqual(comparisonSlots(judge), Array(3).fill([1, 1]));
    assert.equal(result.rootCompletion.positiveRootSatisfied, true);
    assert.equal(result.rootCompletion.queryCompletion, "complete_true");
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("re-export transition preserves the existing supported relation projection", async () => {
  const work = await mkdtemp(join(tmpdir(), "tsjs-multistep-reexport-control-"));
  try {
    const episodes = (await loadStepwiseEpisodeFamily(ALIAS_STAGED_ROOT))
      .filter(episode => episode.sampleId === "a-module-positive-alias");
    const captures = [];
    const result = await runTsJsUnifiedMultiStepDecision({
      requestId: "actual-binding-reexport-control",
      packagePath: CANDIDATE_PACKAGE,
      episodes,
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot: ALIAS_SOURCE_ROOT }),
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });
    assert.deepEqual(captures.map(capture => capture.stepId), ["step-0", "step-1", "step-2"]);
    const judge = captures[2];
    assert.equal(
      judge.context.currentRelation.binding.value.resolution.declarationRef,
      "decl:sources/src/impl.ts#top:helper",
    );
    assert.deepEqual(judgeRelationsOf(judge), [
      {
        candidateRef: "c:judge:true",
        actualDeclarationRef: "decl:sources/src/impl.ts#top:helper",
        requestedDeclarationRef: "decl:sources/src/impl.ts#top:helper",
      },
      {
        candidateRef: "c:judge:false",
        actualDeclarationRef: "decl:sources/src/impl.ts#top:helper",
        requestedDeclarationRef: "decl:sources/src/impl.ts#top:helper",
      },
      {
        candidateRef: "c:judge:unknown",
        actualDeclarationRef: "decl:sources/src/impl.ts#top:helper",
        requestedDeclarationRef: "decl:sources/src/impl.ts#top:helper",
      },
    ]);
    assert.deepEqual(comparisonSlots(judge), Array(3).fill([1, 1]));
    assert.equal(result.rootCompletion.positiveRootSatisfied, true);
    assert.equal(result.rootCompletion.queryCompletion, "complete_true");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("unrelated previous execution cannot enter the next judge projection", async () => {
  const built = await buildFamily();
  try {
    const positive = sample(built.episodes, POSITIVE_ID);
    const step0 = positive.find(episode => episode.stepId === "step-0");
    const step1 = positive.find(episode => episode.stepId === "step-1");
    assert.ok(step0);
    assert.ok(step1);
    const unrelated = {
      ...step1,
      previousExecution: {
        state: "known",
        value: {
          ...step1.previousExecution.value,
          fromStepId: "step-unrelated",
        },
        evidenceRefs: step1.previousExecution.evidenceRefs,
      },
    };
    const { result, captures } = await run(
      built.familyRoot,
      [step0, unrelated],
      "actual-binding-unrelated-step",
    );
    assert.deepEqual(captures.map(capture => capture.stepId), ["step-0"]);
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("exact import tuple mismatch keeps the projection unavailable", async () => {
  const built = await buildFamily();
  try {
    await writeFile(
      join(built.familyRoot, "sources/src/entry-known.ts"),
      'import { createStepper } from "./alternate";\n\nexport const result = createStepper(2)(5);\n',
      "utf8",
    );
    const episodes = sample(built.episodes, MISMATCH_ID);
    const { result, captures } = await run(
      built.familyRoot,
      episodes,
      "actual-binding-tuple-mismatch",
    );
    assert.deepEqual(captures.map(capture => capture.stepId), ["step-0"]);
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    const failedImport = terminalState.bindingVerifications.find(verification =>
      verification.edgeKind === "import"
      && verification.phase === "executed"
      && verification.verified === false);
    assert.ok(failedImport);
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("contradictory observed declarations stay an explicit projection gap", async () => {
  const built = await buildFamily();
  try {
    await writeFile(
      join(built.familyRoot, "sources/src/factory.ts"),
      [
        "export type Stepper = (value: number) => number;",
        "export function createStepper(delta: number): Stepper { return (value) => value + delta; }",
        "export function createStepper(delta: number): Stepper { return (value) => value - delta; }",
        "",
      ].join("\n"),
      "utf8",
    );
    const episodes = sample(built.episodes, MISMATCH_ID).map(episode => {
      if (episode.stepId !== "step-1") return episode;
      const declaration = episode.observedDeclarations?.[0];
      assert.ok(declaration);
      return {
        ...episode,
        // The current parser does not preserve duplicate physical declaration
        // cardinality. Conflicting observed declaration evidence is an existing
        // public input, so this checks the projection join without adding a
        // parser capability outside the R2 slice.
        observedDeclarations: [
          declaration,
          { ...declaration, kind: "interface" },
        ],
      };
    });
    const { result, captures } = await run(
      built.familyRoot,
      episodes,
      "actual-binding-multiple-declarations",
    );
    const judge = captures.at(-1);
    assert.ok(judge);
    assert.equal(judge.stepId, "step-1");
    const terminalState = result.recursiveGoal.report.states.at(-1)?.value;
    assert.ok(terminalState);
    assert.equal(terminalState.realModuleFacts.filter(fact =>
      fact.kind === "declaration"
      && fact.moduleRef === "sources/src/factory.ts"
      && fact.name === "createStepper").length, 1);
    assert.equal(judge.context.currentRelation.binding.state, "not_observed");
    assert.deepEqual(
      judgeRelationsOf(judge).map(item => item.actualDeclarationRef),
      [null, null, null],
    );
    assert.deepEqual(comparisonSlots(judge), Array(3).fill([-1, -1]));
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("missing source read keeps the projection unavailable", async () => {
  const built = await buildFamily();
  try {
    await rm(join(built.familyRoot, "sources/src/factory.ts"));
    const episodes = sample(built.episodes, MISMATCH_ID);
    const { result, captures } = await run(built.familyRoot, episodes, "actual-binding-missing-source");
    assert.deepEqual(captures.map(capture => capture.stepId), ["step-0"]);
    assert.equal(captures[0].context.currentRelation.binding.value.resolution.status, "unresolved");
    assert.equal(result.rootCompletion.positiveRootSatisfied, false);
    assert.equal(result.rootCompletion.queryCompletion, "incomplete");
    assert.equal(result.sampleReceipt?.steps[0]?.outcome, "failed");
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test("focused fixture and saved candidate inputs are present", async () => {
  const manifest = JSON.parse(await readFile(join(FAMILY_ROOT, "manifest.json"), "utf8"));
  assert.equal(typeof manifest.sourceGroup, "string");
  await readFile(CANDIDATE_PACKAGE, "utf8");
});
