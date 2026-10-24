import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCases, prepareSamples, buildReasoningEpisodes, superviseBase, measureBase,
  fitReadFeedbackProfile, fitReadReasoningProfile,
} from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
await mkdir(outDir, { recursive: true });

const prepared = await prepareSamples(buildCases());
assert.deepEqual(prepared.counts.perPartition, { train: 38, dev: 19, verification: 19 });

const baseFit = await fitReadFeedbackProfile({
  handwiredRoot, epochs: 200, learningRate: 0.1,
  episodes: prepared.base,
  stopCheckpoints: [0, 50, 100, 150, 200].filter(value => value > 0),
});
const basePrediction = (attempt) => {
  const vec = measureBase(attempt);
  const out = {};
  for (const [index, label] of ["data_obtained","end_observed","incomplete_observation","execution_error","target_changed","observation_unknown"].entries()) {
    let z = 0;
    // trained weights live on the circuit; use the profile through a tiny local dot product
    z = baseFit.profile.weights[index].reduce((sum, w, wi) => sum + w * Object.values(vec)[wi], 0);
    out[label] = z >= 0 ? 1 : 0;
  }
  return out;
};
const reasoning = buildReasoningEpisodes(prepared.measurements, basePrediction);
const reasoningFit = await fitReadReasoningProfile({
  handwiredRoot, epochs: 200, learningRate: 0.1,
  episodes: reasoning.episodes,
  stopCheckpoints: [50, 100, 150, 200],
});

await writeFile(join(outDir, "base-profile.json"), JSON.stringify(baseFit.profile, null, 2));
await writeFile(join(outDir, "reasoning-profile.json"), JSON.stringify(reasoningFit.profile, null, 2));
await writeFile(join(outDir, "training-report.json"), JSON.stringify({
  counts: prepared.counts,
  reasoningCounts: reasoning.counts,
  base: { stopped: baseFit.stopped, epochsCompleted: baseFit.epochsCompleted, probe: baseFit.probe, headReport: baseFit.headReport, trajectory: baseFit.trajectory, timing: baseFit.timing },
  reasoning: { stopped: reasoningFit.stopped, epochsCompleted: reasoningFit.epochsCompleted, probe: reasoningFit.probe, headReport: reasoningFit.headReport, trajectory: reasoningFit.trajectory, timing: reasoningFit.timing },
}, null, 2));
console.log(JSON.stringify({ base: baseFit.stopped, epoch: baseFit.epochsCompleted, probe: baseFit.probe, heads: baseFit.headReport, reasoning: reasoningFit.stopped, reprobe: reasoningFit.probe, rheads: reasoningFit.headReport }, null, 2));
