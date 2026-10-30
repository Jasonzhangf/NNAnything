import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createCliCommandPolicy,
  executeCliCommandTrainingSample,
  isBatch1CommandCase,
  predictCliCommand,
  prepareCliCommandDataset,
  sampleFacts,
  sampleGoal,
  validateCliCommandProfile,
} from "nnanything/cli-goal";
import { validateEntrySelectProfile } from "../../../dist/filters/cli-entry-select-relation.js";

const rawArgs = process.argv.slice(2);
const positional = [];
let stage = null;
let bDirectoryProfilePath = null;
let bFileProfilePath = null;
let outputRoot = null;
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === "--stage") {
    stage = rawArgs[index + 1] ?? null;
    index += 1;
  } else if (arg === "--b-directory-profile") {
    bDirectoryProfilePath = rawArgs[index + 1] ?? null;
    index += 1;
  } else if (arg === "--b-file-profile") {
    bFileProfilePath = rawArgs[index + 1] ?? null;
    index += 1;
  } else if (arg === "--output-root") {
    outputRoot = rawArgs[index + 1] ?? null;
    index += 1;
  } else {
    positional.push(arg);
  }
}
if (stage !== "stage1-11x34" && stage !== "stage2-13x38") {
  throw new TypeError(`Explicit --stage stage1-11x34 or stage2-13x38 required (received ${String(stage)})`);
}

let entrySelectProfiles = undefined;
if (stage === "stage2-13x38") {
  if (!bDirectoryProfilePath || !bFileProfilePath) {
    throw new TypeError("Stage 2 reload requires explicit --b-directory-profile and --b-file-profile disk paths");
  }
  const directoryProfile = validateEntrySelectProfile(JSON.parse(await readFile(bDirectoryProfilePath, "utf8")));
  const fileProfile = validateEntrySelectProfile(JSON.parse(await readFile(bFileProfilePath, "utf8")));
  if (directoryProfile.contract !== "cli.directory-select-relation.v1") {
    throw new TypeError(`Expected cli.directory-select-relation.v1 for --b-directory-profile, received ${directoryProfile.contract}`);
  }
  if (fileProfile.contract !== "cli.file-select-relation.v1") {
    throw new TypeError(`Expected cli.file-select-relation.v1 for --b-file-profile, received ${fileProfile.contract}`);
  }
  entrySelectProfiles = Object.freeze({
    directory: directoryProfile,
    regular: fileProfile,
  });
}

let profilePath;
let datasetPath;
let reportPath;
if (positional.length === 3) {
  [profilePath, datasetPath, reportPath] = positional;
} else if (positional.length === 0 && outputRoot !== null) {
  const weightsBase = join(outputRoot, "weights", "filesystem", "command");
  const runIds = (await readdir(weightsBase, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (runIds.length !== 1) {
    throw new TypeError(`Expected exactly 1 command training run under ${weightsBase}, found ${runIds.length}`);
  }
  const runId = runIds[0];
  profilePath = join(outputRoot, "weights", "filesystem", "command", runId, "candidate.json");
  datasetPath = join(outputRoot, "samples", "filesystem", "command", runId, "samples.json");
  reportPath = join(outputRoot, "results", "filesystem", "command", runId, "report.json");
} else {
  throw new TypeError("Usage: node playground/cli/command-learning/reload.mjs --stage <stage1-11x34|stage2-13x38> [--b-directory-profile <path> --b-file-profile <path>] (<profilePath> <datasetPath> <reportPath> | --output-root <outputRoot>)");
}

const profile = validateCliCommandProfile(JSON.parse(await readFile(profilePath, "utf8")), stage);
const dataset = prepareCliCommandDataset(JSON.parse(await readFile(datasetPath, "utf8")), ["train", "development"], stage);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const expectedHeads = stage === "stage2-13x38" ? 13 : 11;
const expectedWires = stage === "stage2-13x38" ? 38 : 34;
const expectedParameters = expectedHeads * expectedWires;
assert.equal(profile.heads.length, expectedHeads);
assert.equal(profile.wires.length, expectedWires);
assert.equal(profile.weights.length, expectedHeads);
assert.equal(profile.weights.every(row => row.length === expectedWires), true);
assert.equal(profile.weights.flat().length, expectedParameters);
assert.deepEqual(report.profile, profile);

const reportDir = resolve(dirname(reportPath));
await mkdir(reportDir, { recursive: true });
const evidencePath = join(reportDir, "reload-executions.jsonl");
const rowsPath = join(reportDir, "reload-rows.json");
await writeFile(evidencePath, "", "utf8");

let checked = 0, failed = 0, unverified = 0, executorInvocations = 0, predictionChecks = 0;
let executedLegacy = 0, executedBatch1 = 0;
const failures = [], unverifiedRows = [], rows = [];

function errorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function isEnvironmentUnavailable(error) {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error));
}

for (const sample of dataset.samples) {
  const scene = dataset.scenes.get(sample.scenarioId);
  assert.ok(scene);
  const prediction = predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile, true, stage);
  predictionChecks += 1;
  if (prediction.selectedHead !== sample.expectedHead) failed += 1;
  if (isBatch1CommandCase(sample.case)) executedBatch1 += 1;
  else executedLegacy += 1;

  try {
    const row = await executeCliCommandTrainingSample(
      sample,
      scene,
      profile,
      (binding, authority) => createCliCommandPolicy({
        ...binding,
        stage: binding.stage ?? stage,
        ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
      }, authority),
      evidencePath,
      { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
      { stage, ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }) },
    );
    checked += 1;
    if (row.invocation !== null) executorInvocations += 1;
    const rowDetail = {
      id: sample.id,
      scenarioId: sample.scenarioId,
      sourceGroup: sample.sourceGroup,
      partition: sample.partition,
      case: sample.case,
      variant: sample.variant ?? null,
      expectedHead: sample.expectedHead,
      selectedHead: row.selectedHead,
      expectedStatus: sample.expectedStatus,
      status: row.status,
      expectedSatisfaction: sample.expectedSatisfaction,
      satisfaction: row.satisfaction,
      reason: row.reason,
      errorCode: row.errorCode,
      correct: row.correct,
      effectsOk: row.effectsOk,
      sideEffectsOk: row.sideEffectsOk,
      invocation: row.invocation,
      cleanup: row.cleanup,
      setupWallTimeMs: row.setupWallTimeMs,
      candidateStepWallTimeMs: row.candidateStepWallTimeMs,
      totalWallTimeMs: row.totalWallTimeMs,
    };
    rows.push(rowDetail);
    if (!row.correct || !row.effectsOk || !row.sideEffectsOk) {
      failed += 1;
      failures.push(rowDetail);
    }
  } catch (error) {
    checked += 1;
    const detail = {
      id: sample.id,
      scenarioId: sample.scenarioId,
      sourceGroup: sample.sourceGroup,
      partition: sample.partition,
      case: sample.case,
      variant: sample.variant ?? null,
      expectedHead: sample.expectedHead,
      expectedStatus: sample.expectedStatus,
      expectedSatisfaction: sample.expectedSatisfaction,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
    rows.push({ ...detail, threw: true });
    await appendFile(
      evidencePath,
      `${JSON.stringify({ kind: "execution_error", ...detail })}\n`,
      "utf8",
    );
    if (isEnvironmentUnavailable(error)) {
      unverified += 1;
      unverifiedRows.push(detail);
    } else {
      failed += 1;
      failures.push(detail);
    }
  }
}

function summarizeExecutionTiming(executedRows, headNames) {
  const perHeadSetup = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  const perHeadCandidate = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  const perHeadTotal = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  let setupTotalMs = 0;
  let candidateStepTotalMs = 0;
  let evaluationTotalMs = 0;
  for (const row of executedRows) {
    if (row.threw) continue;
    const head = row.expectedHead ?? row.selectedHead;
    const setupMs = row.setupWallTimeMs ?? 0;
    const candidateMs = row.candidateStepWallTimeMs ?? 0;
    const totalMs = row.totalWallTimeMs ?? (setupMs + candidateMs);
    setupTotalMs += setupMs;
    candidateStepTotalMs += candidateMs;
    evaluationTotalMs += totalMs;
    if (perHeadSetup[head]) {
      perHeadSetup[head].count += 1;
      perHeadSetup[head].totalMs += setupMs;
      perHeadCandidate[head].count += 1;
      perHeadCandidate[head].totalMs += candidateMs;
      perHeadTotal[head].count += 1;
      perHeadTotal[head].totalMs += totalMs;
    }
  }
  for (const head of headNames) {
    if (perHeadSetup[head].count > 0) {
      perHeadSetup[head].meanMs = perHeadSetup[head].totalMs / perHeadSetup[head].count;
      perHeadCandidate[head].meanMs = perHeadCandidate[head].totalMs / perHeadCandidate[head].count;
      perHeadTotal[head].meanMs = perHeadTotal[head].totalMs / perHeadTotal[head].count;
    }
  }
  return {
    includesPreStepSetupInTotal: true,
    setupTotalMs,
    candidateStepTotalMs,
    evaluationTotalMs,
    perHeadSetupWallTimeMs: perHeadSetup,
    perHeadCandidateStepWallTimeMs: perHeadCandidate,
    perHeadEvalWallTimeMs: perHeadTotal,
  };
}

const timing = summarizeExecutionTiming(rows, profile.heads);

function isAppendedStage2Row(row) {
  return (
    row.variant === "select-entry-dir-unobserved-stale"
    || row.variant === "select-entry-file-unobserved-stale"
    || (typeof row.id === "string" && row.id.endsWith("-unobserved-stale"))
  );
}

function summarizeReloadSubset(subsetRows) {
  const trainRows = subsetRows.filter(row => row.partition === "train");
  const devRows = subsetRows.filter(row => row.partition === "development");
  const count = subsetRows.length;
  const failedCount = subsetRows.filter(row => row.threw || !row.correct || !row.effectsOk || !row.sideEffectsOk).length;
  return {
    checked: count,
    train: {
      count: trainRows.length,
      correct: trainRows.filter(row => !row.threw && row.correct).length,
      effectsCorrect: trainRows.filter(row => !row.threw && row.effectsOk && row.sideEffectsOk).length,
      passed: trainRows.length > 0 && trainRows.every(row => !row.threw && row.correct && row.effectsOk && row.sideEffectsOk),
    },
    development: {
      count: devRows.length,
      correct: devRows.filter(row => !row.threw && row.correct).length,
      effectsCorrect: devRows.filter(row => !row.threw && row.effectsOk && row.sideEffectsOk).length,
      passed: devRows.length > 0 && devRows.every(row => !row.threw && row.correct && row.effectsOk && row.sideEffectsOk),
    },
    failed: failedCount,
    passed: count > 0 && failedCount === 0,
  };
}

const original358 = summarizeReloadSubset(rows.filter(row => !isAppendedStage2Row(row)));
const appended12 = summarizeReloadSubset(rows.filter(row => isAppendedStage2Row(row)));

await writeFile(rowsPath, `${JSON.stringify({
  stage,
  profilePath,
  datasetPath,
  reportPath,
  checked,
  executed: checked,
  executedLegacy,
  executedBatch1,
  original358,
  appended12,
  executorInvocations,
  predictionChecks,
  unverified,
  unverifiedRows,
  failed,
  failures,
  timing,
  rows,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  stage,
  profilePath,
  checked,
  executed: checked,
  executedLegacy,
  executedBatch1,
  original358,
  appended12,
  executorInvocations,
  predictionChecks,
  unverified,
  unverifiedRows,
  failed,
  failures,
  timing,
  paths: {
    executions: evidencePath,
    rows: rowsPath,
  },
  fitted: false,
  processId: process.pid,
  schema: { heads: profile.heads.length, wires: profile.wires.length, parameters: profile.weights.flat().length },
  profileMatchesSavedFile: true,
}));
