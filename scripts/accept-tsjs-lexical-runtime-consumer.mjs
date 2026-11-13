#!/usr/bin/env node

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  observeTsJsStepwiseRequest,
  loadStepwiseEpisodeFamily,
} from "../dist/training/unified-student-converter.js";
import {
  runTsJsUnifiedMultiStepDecision,
  createTsJsFileBackedStepExecutor,
} from "../dist/adapters/tsjs-unified-recursive.js";
import { loadUnifiedModelPackageFromFile } from "../dist/training/unified-model-package.js";
import { forwardUnifiedScore } from "../dist/training/unified-forward.js";

const SOURCE_GROUP = "tsjs-train-lexical-declaration-contrast-r1-20261113";
const DERIVATION_FAMILY = "tsjs-lexical-declaration-contrast-v1";
const PRODUCER_FILES = [
  "sources/caller.ts",
  "sources/primary.ts",
  "sources/secondary.ts",
];
const EXPECTED_SAMPLES = Object.freeze([
  Object.freeze({
    sampleId: "lp-r1-same-declaration",
    requestedDeclarationRef: "decl:sources/primary.ts#top:normalizeReading",
    requestedModuleRef: "module:sources/primary.ts",
    expectedJudgement: "true",
  }),
  Object.freeze({
    sampleId: "lp-r1-different-module",
    requestedDeclarationRef: "decl:sources/secondary.ts#top:normalizeReading",
    requestedModuleRef: "module:sources/secondary.ts",
    expectedJudgement: "false",
  }),
]);
const ENCODER_VERSION = "nnanything.unified-step.encoder.v2";
const SCORE_TOLERANCE = 1e-12;
const RUNTIME_EDGE_PATHS = Object.freeze({
  lexicalReceipt:
    "lib/training/unified-student-converter.ts#lexicalReceipt",
  initialEvidenceAdmission:
    "lib/adapters/tsjs-unified-recursive.ts#admittedReadRecords",
  rootCompletion:
    "lib/adapters/tsjs-unified-recursive.ts#rootCompletionOf",
});

function usage() {
  return [
    "Usage:",
    "  node scripts/accept-tsjs-lexical-runtime-consumer.mjs \\",
    "    --source-root <lexical TRAIN source root> \\",
    "    --old-package <inherited model package> \\",
    "    --new-package <candidate or baseline model package> \\",
    "    --out <evidence directory>",
  ].join("\n");
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(["--source-root", "--old-package", "--new-package", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name)) throw new TypeError(`unknown argument: ${name}`);
    if (values.has(name)) throw new TypeError(`duplicate argument: ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`missing value for ${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new TypeError(`missing required argument: ${name}`);
  }
  const parsed = Object.freeze({
    sourceRoot: resolve(values.get("--source-root")),
    oldPackage: resolve(values.get("--old-package")),
    newPackage: resolve(values.get("--new-package")),
    out: resolve(values.get("--out")),
  });
  return {
    ...parsed,
    baselineOnly: parsed.oldPackage === parsed.newPackage,
  };
}

async function assertReadableDirectory(path, label) {
  await access(path, fsConstants.R_OK);
  const fileStat = await stat(path);
  if (!fileStat.isDirectory()) throw new TypeError(`${label} is not a directory: ${path}`);
}

async function assertReadableFile(path, label) {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${path}`, { cause: error });
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function assertNoVerdict(record, label) {
  const text = JSON.stringify(record);
  for (const forbidden of [
    "c:judge:true",
    "c:judge:false",
    "c:judge:unknown",
    "\"verdict\"",
  ]) {
    if (text.includes(forbidden)) {
      throw new Error(`${label} injects forbidden verdict token ${forbidden}`);
    }
  }
}

function producerRequest(sourceRoot) {
  return {
    repo: sourceRoot,
    language: "typescript",
    scope: ["."],
    files: [...PRODUCER_FILES],
  };
}

function lexicalObservation(producer) {
  if (producer.status !== "ok") {
    throw new Error(
      `lexical producer failed: ${producer.reasonCode ?? "unknown"} ${producer.message ?? ""}`.trim(),
    );
  }
  const matches = producer.result.lexicalCallSiteBindings.filter(
    observation => observation.calleeName === "normalize",
  );
  if (matches.length !== 1) {
    throw new Error(`expected one lexical observation for normalize, found ${matches.length}`);
  }
  const observation = matches[0];
  if (
    observation.bindingKind !== "import"
    || observation.sourceName !== "normalizeReading"
    || observation.targetName !== "normalize"
    || observation.sourceModuleFile !== "sources/primary.ts"
    || observation.sourceModuleReadReceipt === null
  ) {
    throw new Error(`unexpected lexical binding: ${JSON.stringify(observation)}`);
  }
  if (
    observation.calleeSpan.startLine !== 2
    || observation.calleeSpan.startCol !== 23
    || observation.calleeSpan.endLine !== 2
    || observation.calleeSpan.endCol !== 35
  ) {
    throw new Error(
      `observed call span ${JSON.stringify(observation.calleeSpan)} != 2:23-2:35`,
    );
  }
  return observation;
}

function bridgeInput({ sample, callSiteRef, request }) {
  const requestRef = `request:${sample.sampleId}`;
  const pendingRelationRef = `relation:${sample.sampleId}`;
  return {
    sourceGroup: SOURCE_GROUP,
    language: "typescript",
    semanticStratum: "module_export",
    partition: "TRAIN",
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
        callSiteRef,
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

async function discoverFreshObservations(args) {
  const request = producerRequest(args.sourceRoot);
  const producer = await runTsJsSymbolTable(request);
  await writeJson(join(args.out, "producer-discovery.json"), {
    sourceRoot: args.sourceRoot,
    request,
    producer,
  });
  const observation = lexicalObservation(producer);
  const bridges = [];
  const records = [];
  for (const sample of EXPECTED_SAMPLES) {
    const input = bridgeInput({
      sample,
      callSiteRef: observation.callSiteRef,
      request,
    });
    const bridge = await observeTsJsStepwiseRequest(input);
    bridges.push({ sampleId: sample.sampleId, input, outcome: bridge });
    if (bridge.record === null || bridge.reasons.length > 0) {
      throw new Error(
        `${sample.sampleId} lexical bridge failed: ${JSON.stringify(bridge.reasons)}`,
      );
    }
    assertNoVerdict(bridge.record, sample.sampleId);
    records.push(bridge.record);
  }
  await writeJson(join(args.out, "bridge-results.json"), bridges);

  const familyDir = join(args.out, "fresh-family");
  await writeJson(join(familyDir, "manifest.json"), {
    sourceGroup: records[0].sourceGroup,
    language: records[0].language,
    semanticStratum: records[0].semanticStratum,
    partition: records[0].partition,
    derivationFamily: {
      familyId: records[0].family,
      independentVerificationEligible: false,
    },
  });
  await writeJsonl(join(familyDir, "student-observations.jsonl"), records);
  const episodes = await loadStepwiseEpisodeFamily(familyDir);
  const bySample = new Map();
  for (const sample of EXPECTED_SAMPLES) {
    const sampleEpisodes = episodes.filter(episode => episode.sampleId === sample.sampleId);
    if (sampleEpisodes.length !== 1) {
      throw new Error(
        `expected one loaded episode for ${sample.sampleId}, found ${sampleEpisodes.length}`,
      );
    }
    bySample.set(sample.sampleId, sampleEpisodes);
  }
  return { episodes, bySample, familyDir };
}

async function loadPackage(packagePath, label) {
  const loaded = await loadUnifiedModelPackageFromFile(packagePath);
  const { package: packageValue } = loaded;
  if (
    packageValue.route.domain !== "tsjs"
    || packageValue.route.decisionKind !== "R"
  ) {
    throw new Error(
      `${label} package route must be tsjs/R, got ${JSON.stringify(packageValue.route)}`,
    );
  }
  if (packageValue.encoderVersion !== ENCODER_VERSION) {
    throw new Error(
      `${label} package encoderVersion must be ${ENCODER_VERSION}, got ${String(packageValue.encoderVersion)}`,
    );
  }
  return loaded;
}

function errorRecord(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return {
    name: "NonErrorThrown",
    message: String(error),
    stack: null,
  };
}

function scoreCapture(capture, loaded) {
  const candidates = capture.candidates.map(candidate => {
    const recomputedScore = forwardUnifiedScore(candidate.vector, loaded.package.tensors);
    const isChosen = candidate.candidateRef === capture.chosen.candidateRef;
    return {
      candidateRef: candidate.candidateRef,
      goalRef: candidate.goalRef,
      skillRef: candidate.skillRef,
      candidateKind: candidate.candidateKind,
      optionSemantics: candidate.optionSemantics,
      targetRef: candidate.targetRef,
      edgeRef: candidate.edgeRef,
      missingMode: candidate.missingMode,
      vectorLength: candidate.vector.length,
      recomputedScore,
      ...(isChosen
        ? {
            isChosen: true,
            captureScore: capture.chosen.score,
            scoreDelta: recomputedScore - capture.chosen.score,
            scoreConsistent:
              Math.abs(recomputedScore - capture.chosen.score) <= SCORE_TOLERANCE,
          }
        : { isChosen: false }),
    };
  });
  return {
    requestId: capture.requestId,
    sampleId: capture.sampleId,
    stepId: capture.stepId,
    stateRef: capture.stateRef,
    contextId: capture.contextId,
    chosen: capture.chosen,
    package: capture.package,
    candidates,
  };
}

function multiStepSummary(result, captures) {
  const recursiveGoal = result.recursiveGoal;
  const report = recursiveGoal.kind === "run_result" ? recursiveGoal.report : null;
  const lastState = report?.states?.at(-1)?.value ?? null;
  const rootCompletion = result.rootCompletion ?? null;
  return {
    recursiveGoalKind: recursiveGoal.kind,
    recursiveGoalControl: report?.control ?? null,
    recursiveGoalRootEvaluation: report?.rootEvaluation ?? null,
    recursiveGoalErrors: report?.errors ?? [],
    recursiveGoalPrimaryErrorId: report?.primaryErrorId ?? null,
    terminal: lastState?.terminal ?? null,
    terminalKind: lastState?.terminalKind ?? null,
    terminalJudgement: lastState?.terminalJudgement ?? null,
    predictedJudgement: rootCompletion?.predictedJudgement ?? null,
    positiveRootSatisfied: rootCompletion?.positiveRootSatisfied ?? null,
    queryCompletion: rootCompletion?.queryCompletion ?? null,
    initialEvidenceInvalidReasons: result.initialEvidenceInvalidReasons ?? [],
    admittedInitialEvidenceCount: result.admittedInitialEvidence?.length ?? 0,
    sampleStepCount: result.sampleReceipt?.steps?.length ?? 0,
    executionStepCount: result.steps?.length ?? 0,
    captureCount: captures.length,
  };
}

async function runPackageSample({
  packageLabel,
  packagePath,
  loaded,
  sample,
  sampleEpisodes,
  sourceRoot,
  out,
}) {
  const captures = [];
  let result = null;
  let executionError = null;
  try {
    result = await runTsJsUnifiedMultiStepDecision({
      requestId: sampleEpisodes[0].requestId,
      packagePath,
      episodes: structuredClone(sampleEpisodes),
      grantedEffects: ["read_only"],
      executor: createTsJsFileBackedStepExecutor({ sourceRoot }),
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
      limits: {
        maxTransitions: 8,
        maxDepth: 4,
        maxDerivedGoals: 8,
      },
    });
  } catch (error) {
    executionError = errorRecord(error);
  }

  const packageDir = join(out, packageLabel);
  await writeJson(join(packageDir, `${sample.sampleId}.selection.json`), {
    packageLabel,
    packagePath,
    sampleId: sample.sampleId,
    captures,
  });

  let forwardScores = null;
  let scoringError = null;
  try {
    forwardScores = captures.map(capture => scoreCapture(capture, loaded));
  } catch (error) {
    scoringError = errorRecord(error);
  }
  await writeJson(join(packageDir, `${sample.sampleId}.forward-scores.json`), {
    packageLabel,
    packagePath,
    sampleId: sample.sampleId,
    scores: forwardScores,
    error: scoringError,
  });

  const summary = result === null ? null : multiStepSummary(result, captures);
  await writeJson(join(packageDir, `${sample.sampleId}.result.json`), {
    packageLabel,
    packagePath,
    sampleId: sample.sampleId,
    result,
    summary,
    captureCount: captures.length,
    executionError,
    scoringError,
  });

  return {
    packageLabel,
    packagePath,
    sampleId: sample.sampleId,
    result,
    summary,
    captures,
    forwardScores,
    executionError,
    scoringError,
  };
}

function comparableFirstCapture(run) {
  return run.captures[0] ?? null;
}

function firstInputComparison(oldRun, newRun) {
  const oldCapture = comparableFirstCapture(oldRun);
  const newCapture = comparableFirstCapture(newRun);
  if (oldCapture === null || newCapture === null) {
    return {
      available: false,
      equal: null,
      reason: "both packages must reach the selection boundary to compare the first input",
    };
  }
  const oldCandidates = oldCapture.candidates.map(candidate => ({
    candidateRef: candidate.candidateRef,
    vector: candidate.vector,
    missingMode: candidate.missingMode,
  }));
  const newCandidates = newCapture.candidates.map(candidate => ({
    candidateRef: candidate.candidateRef,
    vector: candidate.vector,
    missingMode: candidate.missingMode,
  }));
  const equal = JSON.stringify({
    contextId: oldCapture.contextId,
    stepId: oldCapture.stepId,
    candidates: oldCandidates,
  }) === JSON.stringify({
    contextId: newCapture.contextId,
    stepId: newCapture.stepId,
    candidates: newCandidates,
  });
  return {
    available: true,
    equal,
    oldContextId: oldCapture.contextId,
    newContextId: newCapture.contextId,
    oldStepId: oldCapture.stepId,
    newStepId: newCapture.stepId,
    oldCandidateCount: oldCandidates.length,
    newCandidateCount: newCandidates.length,
  };
}

function scoreConsistencyPassed(run) {
  if (run.forwardScores === null) return false;
  return run.forwardScores.every(step =>
    step.candidates.some(candidate => candidate.isChosen && candidate.scoreConsistent === true));
}

function behaviorPassed(run, sample) {
  const summary = run.summary;
  if (
    run.executionError !== null
    || run.scoringError !== null
    || summary === null
    || summary.captureCount === 0
    || summary.recursiveGoalKind !== "run_result"
    || summary.terminal !== true
    || summary.terminalKind !== "judge"
    || summary.recursiveGoalControl?.stopReason === "budget"
  ) {
    return false;
  }
  if (summary.predictedJudgement !== sample.expectedJudgement) return false;
  if (summary.terminalJudgement !== `judge=${sample.expectedJudgement}`) return false;
  return scoreConsistencyPassed(run);
}

function queryCompletionPassed(run, sample) {
  if (run.summary === null) return false;
  const expected = sample.expectedJudgement === "true" ? "complete_true" : "complete_false";
  return run.summary.queryCompletion === expected;
}

function firstMissingEdge(runs) {
  for (const run of runs) {
    if (run.executionError !== null) {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "real recursive consumer call",
        reason: run.executionError.message,
        paths: [
          "lib/adapters/tsjs-unified-recursive.ts:runTsJsUnifiedMultiStepDecision",
        ],
      };
    }
    if (run.scoringError !== null) {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "captured candidate vector -> saved package forward score",
        reason: run.scoringError.message,
        paths: ["lib/training/unified-forward.ts:forwardUnifiedScore"],
      };
    }
    if (run.summary === null) continue;
    if (
      run.summary.initialEvidenceInvalidReasons.includes(
        "source read receipt requires typed previous execution identity",
      )
    ) {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "lexical producer read/binding evidence -> consumer initial evidence admission",
        reason: "source read receipt requires typed previous execution identity",
        paths: [
          RUNTIME_EDGE_PATHS.lexicalReceipt,
          RUNTIME_EDGE_PATHS.initialEvidenceAdmission,
        ],
      };
    }
    if (run.summary.recursiveGoalKind !== "run_result") {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "recursive consumer execution",
        reason: `recursiveGoal kind ${run.summary.recursiveGoalKind}`,
        paths: ["lib/adapters/tsjs-unified-recursive.ts:runTsJsUnifiedMultiStepDecision"],
      };
    }
    if (run.summary.recursiveGoalControl?.stopReason === "budget") {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "runtime diagnostic budget",
        reason: JSON.stringify(run.summary.recursiveGoalControl.budget ?? null),
        paths: ["scripts/accept-tsjs-lexical-runtime-consumer.mjs:limits"],
      };
    }
    if (run.summary.queryCompletion === "incomplete") {
      return {
        scope: `${run.packageLabel}/${run.sampleId}`,
        edge: "terminal judgement -> root query-completion evidence",
        reason: `predicted ${String(run.summary.predictedJudgement)} but queryCompletion is incomplete`,
        paths: [RUNTIME_EDGE_PATHS.rootCompletion],
      };
    }
  }
  return null;
}

function reportText(comparison, args) {
  const lines = [];
  lines.push("# TSJS lexical runtime consumer");
  lines.push("");
  if (args.baselineOnly) {
    lines.push("Status: BASELINE-ONLY ENGINEERING EVIDENCE");
    lines.push("");
    lines.push(
      "The same OLD package path was supplied as `--old-package` and `--new-package`.",
    );
    lines.push("This run does not contain or claim a new fit result.");
  } else {
    lines.push("Status: CANDIDATE DIAGNOSTIC");
    lines.push("");
    lines.push("The old and new package paths differ.");
  }
  lines.push("");
  lines.push(`Training behavior diagnostic: ${comparison.trainingBehaviorDiagnosticPassed ? "PASS" : "FAIL"}`);
  lines.push(`Query completion diagnostic: ${comparison.queryCompletionPassed ? "PASS" : "FAIL"}`);
  lines.push("");
  if (comparison.firstMissingEdge !== null) {
    lines.push("First actual missing edge:");
    lines.push("");
    lines.push(`- Scope: ${comparison.firstMissingEdge.scope}`);
    lines.push(`- Edge: ${comparison.firstMissingEdge.edge}`);
    lines.push(`- Reason: ${comparison.firstMissingEdge.reason}`);
    for (const path of comparison.firstMissingEdge.paths) lines.push(`- Path: ${path}`);
  } else {
    lines.push("First actual missing edge: none detected by the diagnostic.");
  }
  lines.push("");
  lines.push("Per-sample runtime results:");
  lines.push("");
  for (const [sampleId, sampleComparison] of Object.entries(comparison.samples)) {
    lines.push(`## ${sampleId}`);
    lines.push("");
    lines.push(`Expected judgement: ${sampleComparison.expectedJudgement}`);
    lines.push(
      `OLD predicted/queryCompletion: ${String(sampleComparison.old.predictedJudgement)} / ${String(sampleComparison.old.queryCompletion)}`,
    );
    lines.push(
      `NEW predicted/queryCompletion: ${String(sampleComparison.new.predictedJudgement)} / ${String(sampleComparison.new.queryCompletion)}`,
    );
    lines.push(
      `OLD initialEvidenceInvalidReasons: ${JSON.stringify(sampleComparison.old.initialEvidenceInvalidReasons)}`,
    );
    lines.push(
      `NEW initialEvidenceInvalidReasons: ${JSON.stringify(sampleComparison.new.initialEvidenceInvalidReasons)}`,
    );
    lines.push("");
  }
  lines.push("Files:");
  lines.push("");
  for (const path of [
    "producer-discovery.json",
    "bridge-results.json",
    "fresh-family/manifest.json",
    "fresh-family/student-observations.jsonl",
    "comparison.json",
    "report.md",
  ]) {
    lines.push(`- ${path}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertReadableDirectory(args.sourceRoot, "source root");
  await assertReadableFile(args.oldPackage, "old package");
  await assertReadableFile(args.newPackage, "new package");
  await mkdir(args.out, { recursive: true });

  const sourceGroup = await discoverFreshObservations(args);
  const oldLoaded = await loadPackage(args.oldPackage, "old");
  const newLoaded = await loadPackage(args.newPackage, "new");

  const runs = new Map();
  for (const sample of EXPECTED_SAMPLES) {
    const sampleEpisodes = sourceGroup.bySample.get(sample.sampleId);
    const oldRun = await runPackageSample({
      packageLabel: "old",
      packagePath: args.oldPackage,
      loaded: oldLoaded,
      sample,
      sampleEpisodes,
      sourceRoot: args.sourceRoot,
      out: args.out,
    });
    const newRun = await runPackageSample({
      packageLabel: "new",
      packagePath: args.newPackage,
      loaded: newLoaded,
      sample,
      sampleEpisodes,
      sourceRoot: args.sourceRoot,
      out: args.out,
    });
    runs.set(sample.sampleId, { old: oldRun, new: newRun });
  }

  const samples = {};
  let trainingBehaviorDiagnosticPassed = true;
  let queryCompletionDiagnosticPassed = true;
  let firstInputsEqual = true;
  for (const sample of EXPECTED_SAMPLES) {
    const { old: oldRun, new: newRun } = runs.get(sample.sampleId);
    const inputComparison = firstInputComparison(oldRun, newRun);
    if (inputComparison.available !== true || inputComparison.equal !== true) {
      firstInputsEqual = false;
    }
    const newBehaviorPassed = behaviorPassed(newRun, sample);
    const newQueryCompletionPassed = queryCompletionPassed(newRun, sample);
    if (!newBehaviorPassed) trainingBehaviorDiagnosticPassed = false;
    if (!newQueryCompletionPassed) queryCompletionDiagnosticPassed = false;
    samples[sample.sampleId] = {
      expectedJudgement: sample.expectedJudgement,
      firstInputComparison: inputComparison,
      old: oldRun.summary ?? {
        executionError: oldRun.executionError,
        scoringError: oldRun.scoringError,
      },
      new: newRun.summary ?? {
        executionError: newRun.executionError,
        scoringError: newRun.scoringError,
      },
      trainingBehaviorDiagnosticPassed: newBehaviorPassed,
      queryCompletionPassed: newQueryCompletionPassed,
    };
  }
  if (!firstInputsEqual) trainingBehaviorDiagnosticPassed = false;

  const allRuns = [...runs.values()].flatMap(value => [value.new, value.old]);
  const comparison = {
    schema: "nnanything.tsjs.lexical-runtime-consumer-comparison.v1",
    baselineOnly: args.baselineOnly,
    sourceRoot: args.sourceRoot,
    oldPackage: args.oldPackage,
    newPackage: args.newPackage,
    freshFamilyDir: sourceGroup.familyDir,
    firstInputsEqual,
    trainingBehaviorDiagnosticPassed,
    queryCompletionPassed: queryCompletionDiagnosticPassed,
    firstMissingEdge: firstMissingEdge(allRuns),
    samples,
  };
  await writeJson(join(args.out, "comparison.json"), comparison);
  await writeFile(join(args.out, "report.md"), reportText(comparison, args), "utf8");
  console.log(JSON.stringify({
    out: args.out,
    baselineOnly: args.baselineOnly,
    trainingBehaviorDiagnosticPassed,
    queryCompletionPassed: queryCompletionDiagnosticPassed,
    firstMissingEdge: comparison.firstMissingEdge,
  }, null, 2));
  if (!trainingBehaviorDiagnosticPassed || !queryCompletionDiagnosticPassed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
