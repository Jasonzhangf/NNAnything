import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

const rawArgs = process.argv.slice(2);
const positional = [];
let stage = null;
for (let index = 0; index < rawArgs.length; index += 1) {
  if (rawArgs[index] === "--stage") {
    stage = rawArgs[index + 1] ?? null;
    index += 1;
  } else {
    positional.push(rawArgs[index]);
  }
}
if (stage !== "stage1-11x34") {
  throw new Error(`Explicit --stage stage1-11x34 required (received ${String(stage)})`);
}
if (positional.length !== 3) {
  throw new Error("Usage: node playground/cli/command-learning/reload.mjs --stage stage1-11x34 <profilePath> <datasetPath> <reportPath>");
}

const [profilePath, datasetPath, reportPath] = positional;
const profile = validateCliCommandProfile(JSON.parse(await readFile(profilePath, "utf8")), stage);
const dataset = prepareCliCommandDataset(JSON.parse(await readFile(datasetPath, "utf8")), ["train", "development"]);
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(profile.heads.length, 11);
assert.equal(profile.wires.length, 34);
assert.equal(profile.weights.length, 11);
assert.equal(profile.weights.every(row => row.length === 34), true);
assert.equal(profile.weights.flat().length, 374);
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
  const prediction = predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile);
  predictionChecks += 1;
  if (prediction.selectedHead !== sample.expectedHead) failed += 1;
  if (isBatch1CommandCase(sample.case)) executedBatch1 += 1;
  else executedLegacy += 1;

  try {
    const row = await executeCliCommandTrainingSample(
      sample,
      scene,
      profile,
      binding => createCliCommandPolicy(binding),
      evidencePath,
      { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
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

await writeFile(rowsPath, `${JSON.stringify({
  stage,
  profilePath,
  datasetPath,
  reportPath,
  checked,
  executed: checked,
  executedLegacy,
  executedBatch1,
  executorInvocations,
  predictionChecks,
  unverified,
  unverifiedRows,
  failed,
  failures,
  rows,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  stage,
  profilePath,
  checked,
  executed: checked,
  executedLegacy,
  executedBatch1,
  executorInvocations,
  predictionChecks,
  unverified,
  unverifiedRows,
  failed,
  failures,
  paths: {
    executions: evidencePath,
    rows: rowsPath,
  },
  fitted: false,
  processId: process.pid,
  schema: { heads: profile.heads.length, wires: profile.wires.length, parameters: profile.weights.flat().length },
  profileMatchesSavedFile: true,
}));
