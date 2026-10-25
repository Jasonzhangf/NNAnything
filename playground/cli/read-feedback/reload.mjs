// New-process reload: read profiles from disk, rebuild the units, and score the
// verification partition. No training happens here.
//
// Provenance matters for how this score may be read. The legacy initial
// candidate fitted all 76 cases, so the verification slice is in-sample and can
// only be a known-regression reference. A clean train-only initial has not seen
// it, so the score is held out relative to that initial, but the corpus is still
// one-author templates and no independent-source generalization follows from it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
// Determine the provenance of the loaded initial candidate from its own
// recorded training report, never from a hardcoded claim.
function readInitialFitScope() {
  const scope = process.env.NN_INITIAL_FIT_SCOPE;
  if (scope === "legacy_all_cases" || scope === "clean_train_only") return scope;
  try {
    const report = JSON.parse(readFileSync(join(outDir, "training-report.json"), "utf8"));
    if (report?.contamination?.fittedPartitions?.includes("verification")) return "legacy_all_cases";
    const verificationCount = report?.fitted?.base?.partitionCounts?.verification;
    if (typeof verificationCount === "number" && verificationCount === 0) return "clean_train_only";
  } catch {
    // The explicit environment scope below is then required.
  }
  throw new Error("NN_INITIAL_FIT_SCOPE must be legacy_all_cases or clean_train_only, or training-report.json must record the fitted partitions");
}
const initialFitScope = readInitialFitScope();

console.log(JSON.stringify({
  verificationCases: measurements.length,
  initialFitScope,
  verificationRole: "known-regression reference (old gold): the legacy initial candidate fitted this slice, so it is never claimed as unseen evidence",
  initialFitDetail: initialFitScope === "legacy_all_cases"
    ? "the loaded initial candidate fitted this slice, so these scores are in-sample coverage"
    : "the loaded clean initial candidate did not fit this slice, but it is still the same old gold and is not independent unseen evidence",
  independentSourceGeneralization: "not established",
  baseHeadAccuracy: baseHeads / baseTotal,
  baseHeadCorrect: baseHeads,
  baseHeadScored: baseTotal,
  reasoningAllowedAccuracy: reasoningHits / measurements.length,
  reasoningCorrect: reasoningHits,
}, null, 2));
assert.ok(baseHeads / baseTotal >= 0.8, "base head accuracy on verification too low");
