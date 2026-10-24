// New-process reload: read profiles from disk, rebuild the units, and score the
// held-out verification partition. No training happens here.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readReadFeedbackUnit, buildCases, measureCase, superviseBase, measureBase,
         buildReasoningEpisodes, superviseReasoning, measureReasoning } from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";

const unit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "base-profile.json"),
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});

const cases = buildCases().filter(spec => spec.partition === "verification");
const measurements = [];
for (const spec of cases) measurements.push(await measureCase(spec));

let baseHeads = 0, baseTotal = 0;
for (const measurement of measurements) {
  const gold = superviseBase(measurement.attempt);
  const predicted = unit.inferBase(measureBase(measurement.attempt));
  for (const label of ["data_obtained","end_observed","incomplete_observation","execution_error","target_changed","observation_unknown"]) {
    if (gold.mask[label] === 0) continue;
    baseTotal += 1;
    if (predicted[label] === gold.label[label]) baseHeads += 1;
  }
}
let reasoningHits = 0;
for (const measurement of measurements) {
  const predictedBase = unit.inferBase(measureBase(measurement.attempt));
  const vec = measureReasoning(predictedBase, measurement.attempt, measurement.spec.context);
  const next = unit.inferReasoning(vec);
  const gold = superviseReasoning(measurement.attempt, measurement.spec.context);
  if (gold.allowed.includes(next)) reasoningHits += 1;
}
console.log(JSON.stringify({
  verificationCases: measurements.length,
  baseHeadAccuracy: baseHeads / baseTotal,
  baseHeadCorrect: baseHeads,
  baseHeadScored: baseTotal,
  reasoningAllowedAccuracy: reasoningHits / measurements.length,
  reasoningCorrect: reasoningHits,
}, null, 2));
assert.ok(baseHeads / baseTotal >= 0.8, "base head accuracy on verification too low");
