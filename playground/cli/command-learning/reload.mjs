import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const [profilePath, datasetPath, reportPath] = process.argv.slice(2);
const profile = validateCliCommandProfile(JSON.parse(await readFile(profilePath, "utf8")));
const dataset = prepareCliCommandDataset(JSON.parse(await readFile(datasetPath, "utf8")), ["train", "development"]);
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(profile.heads.length, 10);
assert.equal(profile.wires.length, 30);
assert.equal(profile.weights.length, 10);
assert.equal(profile.weights.every(row => row.length === 30), true);
assert.equal(profile.weights.flat().length, 300);
assert.deepEqual(report.profile, profile);

const evidenceRoot = await mkdtemp(join(tmpdir(), "nn-shared-reload-evidence-"));
const evidencePath = join(evidenceRoot, "executions.jsonl");
let checked = 0, failed = 0, unverified = 0, executorInvocations = 0, predictionChecks = 0;
let executedLegacy = 0, executedBatch1 = 0;
const failures = [], unverifiedRows = [];

function errorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function isEnvironmentUnavailable(error) {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error));
}

try {
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
      if (!row.correct || !row.effectsOk || !row.sideEffectsOk) {
        failed += 1;
        failures.push({
          id: sample.id,
          case: sample.case,
          expectedHead: sample.expectedHead,
          selectedHead: row.selectedHead,
          status: row.status,
          satisfaction: row.satisfaction,
          effectsOk: row.effectsOk,
          sideEffectsOk: row.sideEffectsOk,
        });
      }
    } catch (error) {
      checked += 1;
      const detail = {
        id: sample.id,
        case: sample.case,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
      if (isEnvironmentUnavailable(error)) {
        unverified += 1;
        unverifiedRows.push(detail);
      } else {
        failed += 1;
        failures.push(detail);
      }
    }
  }

  console.log(JSON.stringify({
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
    fitted: false,
    processId: process.pid,
    schema: { heads: profile.heads.length, wires: profile.wires.length, parameters: profile.weights.flat().length },
    profileMatchesSavedFile: true,
  }));
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}
