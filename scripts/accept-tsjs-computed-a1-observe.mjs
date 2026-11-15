#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { forwardUnifiedScore } from "../dist/training/unified-forward.js";
import { loadUnifiedModelPackageFromFile } from "../dist/training/unified-model-package.js";

const ALLOWED_ARGS = new Set(["--case", "--package", "--out"]);
const A1_WORKTREE = "/Volumes/Intel/playground/nnanything/tsjs-computed-observe-a1-20261115";
const CASE_SCHEMA = "nnanything.tsjs.computed-a1-acceptance-case.v1";
const ACCEPTED_PARTITIONS = new Set(["DEV", "VERIFICATION"]);

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : "NonErrorThrown",
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.code === "string" ? error.code : null,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!ALLOWED_ARGS.has(name) || values.has(name)) {
      throw new TypeError(`invalid harness arguments: ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`invalid harness arguments: missing value for ${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of ALLOWED_ARGS) {
    if (!values.has(name)) throw new TypeError(`invalid harness arguments: missing ${name}`);
  }
  return {
    casePath: resolve(values.get("--case")),
    packagePath: resolve(values.get("--package")),
    out: resolve(values.get("--out")),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertReadableFile(path, label) {
  await access(path, fsConstants.R_OK).catch(error => {
    throw new Error(`${label} is missing or unreadable: ${path}`, { cause: error });
  });
}

function validateCase(value, cliPackagePath) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("case schema requires an object");
  }
  if (value.schema !== CASE_SCHEMA) {
    throw new TypeError(`case schema must be ${CASE_SCHEMA}`);
  }
  if (typeof value.caseId !== "string" || value.caseId.length === 0) {
    throw new TypeError("case caseId must be a nonempty string");
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw new TypeError("case requestId must be a nonempty string");
  }
  if (typeof value.sourceRoot !== "string" || value.sourceRoot.length === 0) {
    throw new TypeError("case sourceRoot must be a nonempty path");
  }
  if (!Array.isArray(value.episodes)
    || value.episodes.length < 1
    || value.episodes.length > 2) {
    throw new TypeError(
      "case episodes must contain one control step or an explicit start and next judge episode",
    );
  }
  if (value.observe !== undefined) {
    if (value.observe?.kind !== "constant_computed_property_v1") {
      throw new TypeError("case observe.kind must be constant_computed_property_v1");
    }
    const readSet = value.observe.readSet;
    if (readSet === null || typeof readSet !== "object") {
      throw new TypeError("case observe.readSet must be an object");
    }
    if (readSet.repoRoot !== value.sourceRoot
      || typeof readSet.callerFile !== "string"
      || !["typescript", "javascript"].includes(readSet.language)
      || !Array.isArray(readSet.files)
      || !readSet.files.includes(readSet.callerFile)
      || JSON.stringify(readSet.grantedEffects) !== JSON.stringify(["read_only"])) {
      throw new TypeError("case observe.readSet is not an explicit read-only file set");
    }
  }
  const [start, next] = value.episodes;
  if (start?.requestId !== value.requestId
    || value.episodes.some(episode =>
      episode?.requestId !== value.requestId
      || episode?.sampleId !== start?.sampleId
      || typeof episode?.stepId !== "string")
    || new Set(value.episodes.map(episode => episode.stepId)).size
      !== value.episodes.length) {
    throw new TypeError(
      "case episodes must be linked to one request/sample with distinct step IDs",
    );
  }
  if (value.episodes.some(episode => !ACCEPTED_PARTITIONS.has(episode.partition))) {
    throw new TypeError(
      "case episodes must remain in the declared DEV or VERIFICATION partition",
    );
  }
  if (new Set(value.episodes.map(episode => episode.partition)).size !== 1) {
    throw new TypeError("case episodes must preserve one partition");
  }
  if (value.packagePath !== undefined && resolve(value.packagePath) !== cliPackagePath) {
    throw new TypeError("case packagePath does not match --package");
  }
  return {
    ...value,
    packagePath: cliPackagePath,
    sourceRoot: resolve(value.sourceRoot),
    episodes: structuredClone(value.episodes),
  };
}

function propertyOf(typeNode, name) {
  if (typeNode === undefined) return undefined;
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return propertyOf(typeNode.type, name);
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    for (const argument of typeNode.typeArguments ?? []) {
      const found = propertyOf(argument, name);
      if (found !== undefined) return found;
    }
  }
  if (!ts.isTypeLiteralNode(typeNode)) return undefined;
  return typeNode.members.find(member =>
    ts.isPropertySignature(member)
    && member.name !== undefined
    && member.name.getText() === name);
}

function hasStringLiteralProperty(typeNode, name, expected) {
  const property = propertyOf(typeNode, name);
  return property !== undefined
    && property.type !== undefined
    && ts.isLiteralTypeNode(property.type)
    && ts.isStringLiteral(property.type.literal)
    && property.type.literal.text === expected;
}

async function publicRequestSupportsA1(moduleNamespace) {
  if (typeof moduleNamespace.runTsJsUnifiedMultiStepDecision !== "function"
    || typeof moduleNamespace.createTsJsFileBackedStepExecutor !== "function") {
    return false;
  }
  const declarationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../dist/adapters/tsjs-unified-recursive.d.ts",
  );
  let declarationText;
  try {
    declarationText = await readFile(declarationPath, "utf8");
  } catch {
    return false;
  }
  const declaration = ts.createSourceFile(
    declarationPath,
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const interfaceNamed = name => declaration.statements.find(statement =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === name);
  const request = interfaceNamed("TsJsUnifiedMultiStepDecisionRequest");
  const execution = interfaceNamed("TsJsUnifiedStepExecution");
  const observe = request?.members.find(member =>
    ts.isPropertySignature(member)
    && member.name !== undefined
    && member.name.getText(declaration) === "observe");
  if (observe?.type === undefined) return false;
  return hasStringLiteralProperty(observe.type, "kind", "constant_computed_property_v1")
    && execution?.members.some(member =>
      ts.isPropertySignature(member)
      && member.name !== undefined
      && member.name.getText(declaration) === "observeProjection")
    && execution.members.some(member =>
      ts.isPropertySignature(member)
      && member.name !== undefined
      && member.name.getText(declaration) === "observeEvidence");
}

function runtimeErrors(result) {
  if (result.recursiveGoal?.kind !== "run_result") {
    return result.recursiveGoal?.error === undefined ? [] : [result.recursiveGoal.error];
  }
  return result.recursiveGoal.report?.errors ?? [];
}

function finalRuntimeState(result) {
  const report = result.recursiveGoal?.kind === "run_result"
    ? result.recursiveGoal.report
    : null;
  return report?.states?.at(-1)?.value;
}

function scoreCaptures(captures, loadedPackage) {
  return captures.map(capture => ({
    requestId: capture.requestId,
    sampleId: capture.sampleId,
    stepId: capture.stepId,
    candidateScores: capture.candidates.map(candidate => ({
      candidateRef: candidate.candidateRef,
      score: forwardUnifiedScore(
        candidate.vector,
        loadedPackage.package.tensors,
      ),
      missingMode: candidate.missingMode,
    })),
  }));
}

function validCaptures(captures, value, candidateScores) {
  return captures.length > 0 && captures.every((capture, index) => {
    if (capture.schema !== "nnanything.tsjs.step-selection-capture.v1"
      || capture.requestId !== value.requestId
      || capture.sampleId !== value.episodes[0].sampleId
      || !Array.isArray(capture.candidates)
      || capture.candidates.length === 0
      || !Number.isFinite(capture.chosen?.score)
      || capture.stepId !== capture.context?.stepId
      || capture.context?.candidateGroup?.enumeration !== "complete"
      || capture.context.candidateGroup.count !== capture.candidates.length) return false;
    const candidateRefs = capture.candidates.map(candidate => candidate.candidateRef);
    const contextRefs = capture.context.candidateGroup.candidates
      .map(candidate => candidate.candidateRef);
    const scoreRecord = candidateScores[index];
    const chosenScore = scoreRecord?.candidateScores.find(candidate =>
      candidate.candidateRef === capture.chosen.candidateRef);
    return JSON.stringify(candidateRefs) === JSON.stringify(contextRefs)
      && new Set(candidateRefs).size === candidateRefs.length
      && candidateRefs.includes(capture.chosen.candidateRef)
      && capture.candidates.every(candidate =>
        Array.isArray(candidate.vector)
        && Object.hasOwn(candidate, "missingMode")
        && candidate.missingMode.every(mode => mode.fill === -1))
      && scoreRecord?.stepId === capture.stepId
      && scoreRecord.candidateScores.length === capture.candidates.length
      && scoreRecord.candidateScores.every(candidate => Number.isFinite(candidate.score))
      && chosenScore !== undefined
      && Math.abs(chosenScore.score - capture.chosen.score) <= 1e-12;
  });
}

function capturedRun(result, executionError, captures, value, candidateScores) {
  return executionError === null
    && result !== null
    && result.recursiveGoal?.kind === "run_result"
    && validCaptures(captures, value, candidateScores);
}

function makeReceipt({
  args,
  value,
  captures,
  candidateScores,
  dispatches,
  result,
  executionError,
}) {
  const finalState = result === null ? null : finalRuntimeState(result);
  const observeExecutions = dispatches.filter(item => item.action === "observe");
  const firstCapture = captures[0] ?? null;
  const firstObservationCandidates = firstCapture?.candidates ?? [];
  const hasObserveCandidate = firstObservationCandidates.some(candidate =>
    candidate.optionSemantics === "observe"
    || (typeof candidate.candidateRef === "string"
      && candidate.candidateRef.startsWith("c:observe:")));
  const selectedObserve = firstCapture?.chosen?.candidateRef !== undefined
    && firstObservationCandidates.some(candidate =>
      candidate.candidateRef === firstCapture.chosen.candidateRef
      && candidate.optionSemantics === "observe");
  const firstObserveExecution = observeExecutions[0]?.result;
  const projection = firstObserveExecution?.observeProjection;
  const admittedObservationRecords = firstObserveExecution?.observeEvidence;
  const producerObservation = projection?.producerSource?.rawObservation;
  const sourceReadReceipt = producerObservation?.sourceReadReceipt;
  const rootCompletion = result?.rootCompletion ?? null;
  const captured = capturedRun(result, executionError, captures, value, candidateScores);
  const finalStateValue = result?.recursiveGoal?.report?.states?.at(-1)?.value;
  const controlExecution = result?.steps?.length === 1
    ? result.steps[0]?.executionReceipt
    : null;
  const selectedObserveAcceptance = selectedObserve
    && observeExecutions.length > 0
    && firstObserveExecution?.outcome === "success"
    && projection !== undefined
    && Array.isArray(admittedObservationRecords)
    && admittedObservationRecords.length > 0
    && result.steps?.some(step =>
      step.executionReceipt?.action === "submit_observe"
      && step.executionReceipt?.outcome === "success")
    && result.steps?.every(step =>
      step.executionReceipt?.action !== "submit_read")
    && result.recursiveGoal?.report?.states?.at(-1)?.value
      ?.observeAdmissions?.every?.(record => record?.validity === "valid")
    && captures.some(capture =>
      capture.stepId !== value.episodes[0].stepId
      && capture.context.previousExecution?.state === "known"
      && capture.context.previousExecution.value?.optionSemantics === "observe")
    && rootCompletion?.queryCompletion === "incomplete"
    && rootCompletion?.positiveRootSatisfied === false
      ? "PASS"
      : "FAIL";
  const noObserveControlAcceptance = captured
    && !hasObserveCandidate
    && firstCapture?.chosen?.candidateRef === "c:judge:unknown"
    && captures.length === 1
    && observeExecutions.length === 0
    && dispatches.every(item => item.action !== "read")
    && controlExecution?.action === "submit_terminal_judgement"
    && controlExecution?.terminalJudgement === "judge=unknown"
    && controlExecution?.outcome === "success"
    && finalStateValue?.terminal === true
    && finalStateValue?.terminalKind === "judge"
    && finalStateValue?.terminalJudgement === "judge=unknown"
      ? "PASS"
      : "FAIL";
  const acceptanceKind = captured
    ? hasObserveCandidate
      ? "positive_observe"
      : "no_observe_control"
    : "UNVERIFIED";
  const caseAcceptance = captured
    ? acceptanceKind === "positive_observe"
      ? selectedObserveAcceptance
      : noObserveControlAcceptance
    : "UNVERIFIED";

  const receipt = {
    schema: "nnanything.tsjs.computed-a1-acceptance-result.v1",
    status: captured ? "CAPTURED" : "INVALID",
    caseId: value.caseId,
    requestId: value.requestId,
    sampleId: value.episodes[0].sampleId,
    stepIds: value.episodes.map(episode => episode.stepId),
    partition: value.episodes[0].partition,
    partitions: value.episodes.map(episode => episode.partition),
    modelBinding: {
      packagePath: args.packagePath,
      ...(result?.modelBinding ?? captures[0]?.package ?? {}),
    },
    selectionCaptures: captures,
    candidateScores,
    dispatchCounts: {
      readDispatches: dispatches.filter(item => item.action === "read").length,
      observeDispatches: observeExecutions.length,
    },
    dispatches,
    ...(observeExecutions.length > 0
      ? {
          observe: {
            producerObservation: producerObservation ?? null,
            sourceReadReceipt: sourceReadReceipt ?? null,
            admittedObservationRecords: admittedObservationRecords ?? null,
            actualObserveReceipts: result?.steps
              ?.filter(step => step.executionReceipt?.action === "submit_observe")
              .map(step => step.executionReceipt) ?? [],
            execution: firstObserveExecution,
          },
        }
      : {}),
    nextJudge: result?.steps
      ?.filter(step => step.nextStepId !== null)
      .map(step => ({
        executedStepId: step.stepId,
        nextStepId: step.nextStepId,
        previousActionRef: step.executionReceipt?.actionRef ?? null,
        receiptId: step.executionReceipt?.receiptId ?? null,
        capture: captures.find(capture => capture.stepId === step.nextStepId) ?? null,
      })) ?? [],
    rootEvaluation: result?.rootEvaluation ?? null,
    rootCompletion,
    finalRuntimeState: finalState,
    runtimeErrors: result === null ? [] : runtimeErrors(result),
    executionError,
    acceptanceKind,
    caseAcceptance,
    selectedObserveAcceptance: captured
      ? acceptanceKind === "positive_observe"
        ? selectedObserveAcceptance
        : "NOT_APPLICABLE"
      : "UNVERIFIED",
    noObserveControlAcceptance: captured
      ? acceptanceKind === "no_observe_control"
        ? noObserveControlAcceptance
        : "NOT_APPLICABLE"
      : "UNVERIFIED",
    selectedObserveFailure: captured && selectedObserveAcceptance === "FAIL"
      && acceptanceKind === "positive_observe"
      ? {
          chosen: captures.map(capture => ({
            stepId: capture.stepId,
            candidateRef: capture.chosen.candidateRef,
            score: capture.chosen.score,
          })),
          observeDispatches: observeExecutions.length,
          readDispatches: dispatches.filter(item => item.action === "read").length,
          queryCompletion: rootCompletion?.queryCompletion ?? null,
        }
      : null,
    noObserveControlFailure: captured
      && acceptanceKind === "no_observe_control"
      && noObserveControlAcceptance === "FAIL"
      ? {
          chosenCandidateRef: firstCapture?.chosen?.candidateRef ?? null,
          candidateRefs: firstObservationCandidates.map(candidate =>
            candidate.candidateRef),
          observeDispatches: observeExecutions.length,
          readDispatches: dispatches.filter(item => item.action === "read").length,
          executionAction: controlExecution?.action ?? null,
          terminalJudgement: controlExecution?.terminalJudgement ?? null,
        }
      : null,
    packagePath: args.packagePath,
  };
  return { receipt, caseAcceptance };
}

async function run() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "INVALID", error: errorRecord(error) })}\n`);
    process.exitCode = 2;
    return;
  }

  let caseValue;
  let entry;
  try {
    await assertReadableFile(args.casePath, "case");
    await assertReadableFile(args.packagePath, "package");
    caseValue = validateCase(JSON.parse(await readFile(args.casePath, "utf8")), args.packagePath);
    entry = await import("../dist/adapters/tsjs-unified-recursive.js");
  } catch (error) {
    const receipt = {
      schema: "nnanything.tsjs.computed-a1-acceptance-result.v1",
      status: "INVALID",
      casePath: args.casePath,
      packagePath: args.packagePath,
      error: errorRecord(error),
    };
    await writeJson(join(args.out, "result.json"), receipt);
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 2;
    return;
  }

  const supportsA1 = await publicRequestSupportsA1(entry);
  if (!supportsA1) {
    const unavailable = {
      schema: "nnanything.tsjs.computed-a1-acceptance-result.v1",
      status: "UNAVAILABLE",
      dependency: "A1_RUNTIME_NOT_INTEGRATED",
      missingField: "request.observe",
      missingKind: "constant_computed_property_v1",
      dependencySource: A1_WORKTREE,
      dependencyStatus: "read_only_accepted_evidence_not_integrated",
      caseId: caseValue.caseId,
      requestId: caseValue.requestId,
      sampleId: caseValue.episodes[0].sampleId,
      stepIds: caseValue.episodes.map(episode => episode.stepId),
      partition: caseValue.episodes[0].partition,
      partitions: caseValue.episodes.map(episode => episode.partition),
      packagePath: args.packagePath,
      receipt: [{
        stage: "consumer_surface_check",
        status: "not_executed",
        reason: "this worktree's public request has no accepted A1 observe configuration",
      }],
      executionError: {
        name: "A1RuntimeUnavailable",
        message: "request.observe.kind=constant_computed_property_v1 is not supported by the integrated public consumer",
        code: "A1_RUNTIME_NOT_INTEGRATED",
      },
    };
    await writeJson(join(args.out, "result.json"), unavailable);
    process.stderr.write(`${JSON.stringify(unavailable)}\n`);
    process.exitCode = 2;
    return;
  }

  const captures = [];
  const dispatches = [];
  let candidateScores = [];
  let loadedPackage = null;
  let result = null;
  let executionError = null;
  try {
    loadedPackage = await loadUnifiedModelPackageFromFile(args.packagePath);
    const fileExecutor = entry.createTsJsFileBackedStepExecutor({
      sourceRoot: caseValue.sourceRoot,
    });
    const executor = {
      async read(input) {
        const execution = structuredClone(await fileExecutor.read(input));
        dispatches.push({ action: "read", input, result: execution });
        return structuredClone(execution);
      },
      async observe(input) {
        const execution = structuredClone(await fileExecutor.observe(input));
        dispatches.push({ action: "observe", input, result: execution });
        return structuredClone(execution);
      },
    };
    result = await entry.runTsJsUnifiedMultiStepDecision({
      requestId: caseValue.requestId,
      packagePath: args.packagePath,
      episodes: caseValue.episodes,
      grantedEffects: ["read_only"],
      observe: caseValue.observe,
      executor,
      onStepSelection(capture) {
        captures.push(structuredClone(capture));
      },
    });
  } catch (error) {
    executionError = errorRecord(error);
  }

  if (loadedPackage !== null) {
    candidateScores = scoreCaptures(captures, loadedPackage);
  }
  const runCaptured = capturedRun(
    result,
    executionError,
    captures,
    caseValue,
    candidateScores,
  );
  await writeJson(join(args.out, "selection-captures.json"), structuredClone(captures));
  await writeJson(join(args.out, "candidate-scores.json"), structuredClone(candidateScores));
  await writeJson(join(args.out, "run-result.json"), {
    schema: "nnanything.tsjs.computed-a1-runtime-capture.v1",
    status: runCaptured ? "CAPTURED" : "INVALID",
    dispatches,
    dispatchCounts: {
      readDispatches: dispatches.filter(item => item.action === "read").length,
      observeDispatches: dispatches.filter(item => item.action === "observe").length,
    },
    executionError,
    result,
  });
  const { receipt, caseAcceptance } = makeReceipt({
    args,
    value: caseValue,
    captures,
    candidateScores,
    dispatches,
    result,
    executionError,
  });
  await writeJson(join(args.out, "result.json"), structuredClone(receipt));
  if (receipt.status !== "CAPTURED") process.exitCode = 2;
  else if (caseAcceptance !== "PASS") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch(async error => {
    const failure = { status: "INVALID", error: errorRecord(error) };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 2;
  });
}
