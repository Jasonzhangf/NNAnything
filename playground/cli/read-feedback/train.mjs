// Pretraining entry: zero start, train partition only.
//
// Isolation: only the `train` partition may enter the gradient. The `dev` and
// `verification` partitions are measured (their real per-label coverage is
// reported) but they never reach a fit, a stop condition or a parameter
// choice. An earlier revision of this entry passed all 76 measured cases to the
// fit, so the old gold verification slice had already been learned; the fixed
// entry keeps that history as a known-regression diagnostic and no longer lets
// any non-train case influence the initial weights.
//
// Budget is declared here, before the run, and recorded in the report:
// epochs 200, learningRate 0.1, stop checkpoints {50,100,150,200}. The stop
// condition is "every active head correct on the train partition at a declared
// checkpoint" or "budget exhausted". An exhausted budget without that condition
// is reported as FAIL; no seed/objective/margin/wire change or extra epoch is
// allowed to chase a pass.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_LABELS,
  BASE_WIRES,
  buildCases, prepareSamples, buildReasoningEpisodes, measureBase,
  fitReadFeedbackProfile, fitReadReasoningProfile,
} from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
await mkdir(outDir, { recursive: true });

const BUDGET = Object.freeze({
  epochs: 200,
  learningRate: 0.1,
  stopCheckpoints: Object.freeze([50, 100, 150, 200]),
  stopRule: "satisfied when every active head is correct on the train partition at a declared checkpoint; otherwise epochs_exhausted = FAIL",
});

const prepared = await prepareSamples(buildCases());
assert.deepEqual(prepared.counts.perPartition, { train: 38, dev: 19, verification: 19 });

// ---- Partition isolation: only train episodes may be fitted. ----
const trainMeasurements = prepared.measurements.filter(measurement => measurement.spec.partition === "train");
const trainBase = prepared.base.filter(episode => episode.partition === "train");
assert.equal(trainBase.length, trainMeasurements.length, "one base episode per measured train case");
assert.equal(trainBase.length, prepared.counts.perPartition.train);
assert.ok(trainBase.every(episode => episode.partition === "train"), "a fit episode must belong to the train partition");

/** The runtime base-unit forward: same wires, same threshold, no other path. */
function predictBase(profile, vector) {
  const features = BASE_WIRES.map(wire => vector[wire]);
  const prediction = {};
  BASE_LABELS.forEach((label, head) => {
    const z = profile.weights[head].reduce((sum, weight, index) => sum + weight * features[index], 0);
    prediction[label] = z >= 0 ? 1 : 0;
  });
  return prediction;
}

const baseFit = await fitReadFeedbackProfile({
  handwiredRoot,
  epochs: BUDGET.epochs,
  learningRate: BUDGET.learningRate,
  episodes: trainBase,
  stopCheckpoints: BUDGET.stopCheckpoints,
});

// Reasoning samples are also train-only, and their inputs come from the fitted
// candidate base unit's real infer output, never from gold.
const reasoning = buildReasoningEpisodes(
  trainMeasurements,
  attempt => predictBase(baseFit.profile, measureBase(attempt)),
);
const reasoningEpisodes = reasoning.episodes;
assert.equal(reasoningEpisodes.length, trainMeasurements.length);
assert.ok(reasoningEpisodes.every(episode => episode.partition === "train"), "a reasoning episode must belong to the train partition");

const reasoningFit = await fitReadReasoningProfile({
  handwiredRoot,
  epochs: BUDGET.epochs,
  learningRate: BUDGET.learningRate,
  episodes: reasoningEpisodes,
  stopCheckpoints: BUDGET.stopCheckpoints,
});

const trainIds = trainMeasurements.map(measurement => measurement.spec.id);
const gate = {
  declared: BUDGET.stopRule,
  base: baseFit.stopped === "satisfied" ? "PASS" : "FAIL",
  reasoning: reasoningFit.stopped === "satisfied" ? "PASS" : "FAIL",
  passed: baseFit.stopped === "satisfied" && reasoningFit.stopped === "satisfied",
};

await writeFile(join(outDir, "base-profile.json"), JSON.stringify(baseFit.profile, null, 2));
await writeFile(join(outDir, "reasoning-profile.json"), JSON.stringify(reasoningFit.profile, null, 2));
await writeFile(join(outDir, "training-report.json"), JSON.stringify({
  schema: "nnanything.cli-read-feedback.pretraining-report.v1",
  generatedBy: "playground/cli/read-feedback/train.mjs",
  entry: "pretraining: zero start, train partition only",
  budget: BUDGET,
  corpus: {
    cases: prepared.measurements.length,
    perPartition: prepared.counts.perPartition,
    note: "measured coverage of the whole corpus; dev and verification are evaluation only",
  },
  fitted: {
    base: { partition: "train", episodeIds: trainIds, partitionCounts: { train: trainBase.length, dev: 0, verification: 0 } },
    reasoning: { partition: "train", episodeIds: trainIds, partitionCounts: { train: reasoningEpisodes.length, dev: 0, verification: 0 } },
  },
  evaluationOnly: {
    dev: prepared.counts.perPartition.dev,
    verification: prepared.counts.perPartition.verification,
    note: "these partitions never enter the gradient, a stop condition or a parameter choice",
  },
  gate,
  base: { stopped: baseFit.stopped, epochsCompleted: baseFit.epochsCompleted, probe: baseFit.probe, headReport: baseFit.headReport, trajectory: baseFit.trajectory, timing: baseFit.timing },
  reasoning: { stopped: reasoningFit.stopped, epochsCompleted: reasoningFit.epochsCompleted, probe: reasoningFit.probe, headReport: reasoningFit.headReport, trajectory: reasoningFit.trajectory, timing: reasoningFit.timing },
}, null, 2));
console.log(JSON.stringify({
  gate,
  base: { stopped: baseFit.stopped, epoch: baseFit.epochsCompleted, probe: baseFit.probe, heads: baseFit.headReport },
  reasoning: { stopped: reasoningFit.stopped, epoch: reasoningFit.epochsCompleted, probe: reasoningFit.probe, heads: reasoningFit.headReport },
  fitted: { base: trainBase.length, reasoning: reasoningEpisodes.length },
}, null, 2));
