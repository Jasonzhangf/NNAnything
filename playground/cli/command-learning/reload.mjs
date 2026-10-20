import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliCommandPolicy,
  executeCliCommandTrainingSample,
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
assert.equal(report.profile.weights.length, 6);
assert.equal(report.profile.weights[0].length, 14);
const evidenceRoot = await mkdtemp(join(tmpdir(), "nn-shared-reload-evidence-"));
const evidencePath = join(evidenceRoot, "executions.jsonl");
let checked = 0, failed = 0, executions = 0;
try {
  for (const sample of dataset.samples) {
    const scene = dataset.scenes.get(sample.scenarioId);
    assert.ok(scene);
    const prediction = predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile);
    assert.equal(prediction.selectedHead, sample.expectedHead);
    const row = await executeCliCommandTrainingSample(sample, scene, profile, binding => createCliCommandPolicy(binding), evidencePath,
      { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction });
    checked += 1;
    if (!row.correct || !row.effectsOk || !row.sideEffectsOk) failed += 1;
    if (row.invocation !== null) executions += 1;
  }
  console.log(JSON.stringify({ profilePath, checked, failed, executions, fitted: false, processId: process.pid }));
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}
