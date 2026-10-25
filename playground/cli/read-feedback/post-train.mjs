// Stage 3: sourced supervision and isolated post-use fit.
//
// Continued post-training warm-starts from the qualified initial profiles and
// mixes (a) a content-free replay of the pretraining train partition with (b)
// the new sourced usage supervision. A wrong sampled prediction is supervised
// from the oracle's allowed set, never replayed as an action; only a
// structurally unsourced sample (drifted recorded vector, or a recorded allowed
// set that is not the oracle's) is rejected, with its reason recorded.
//
// The zero-start fit is kept only as an explicitly labeled diagnostic control
// (`post-zero/`) so the old failure evidence stays reproducible. The delivery
// candidate is always warm-started and lands in `post/`.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_LABELS,
  BASE_WIRES,
  REASONING_LABELS,
  REASONING_WIRES,
  fitReadFeedbackProfile,
  fitReadReasoningProfile,
  loadReadProfile,
  measureBase,
  measureReasoning,
  mergeCoverage,
  readReadFeedbackUnit,
  superviseBase,
  superviseReasoning,
} from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
const postDir = join(outDir, "post");
const zeroDir = join(outDir, "post-zero");
await mkdir(postDir, { recursive: true });
await mkdir(zeroDir, { recursive: true });
assert.notEqual(postDir, outDir, "post-use output directory must be isolated from the in-flight profile directory");
assert.notEqual(zeroDir, outDir, "zero-start diagnostic directory must be isolated from the in-flight profile directory");

const samplePath = join(outDir, "usage-samples.json");
const pretrainPath = join(outDir, "pretrain-samples.json");
const samples = JSON.parse(await readFile(samplePath, "utf8"));
if (samples?.schema !== "nnanything.cli-read-feedback.usage-samples.v1") {
  throw new TypeError(`usage samples must use the read-feedback usage schema, received ${String(samples?.schema)}`);
}
if (!Array.isArray(samples.runs) || samples.runs.length === 0) throw new TypeError("usage samples must contain runs");
const pretrain = JSON.parse(await readFile(pretrainPath, "utf8"));
if (pretrain?.schema !== "nnanything.cli-read-feedback.pretrain-samples.v1") {
  throw new TypeError(`pretraining replay must use the pretrain-samples schema, received ${String(pretrain?.schema)}`);
}
if (!Array.isArray(pretrain.runs) || pretrain.runs.length === 0) throw new TypeError("pretraining replay must contain runs");

const initialTrainingReport = await readJsonIfPresent(join(outDir, "training-report.json"));
async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Provenance of the loaded initial candidate, read from its own recorded
// training report. A legacy fit consumed all 76 cases, so the old verification
// slice is in-sample for it and can only be a known-regression reference. A
// clean train-only fit has not seen that slice.
const initialFitScope = (() => {
  const scope = process.env.NN_INITIAL_FIT_SCOPE;
  if (scope === "legacy_all_cases" || scope === "clean_train_only") return scope;
  try {
    if (initialTrainingReport?.contamination?.fittedPartitions?.includes("verification")) return "legacy_all_cases";
    const verificationCount = initialTrainingReport?.fitted?.base?.partitionCounts?.verification;
    if (typeof verificationCount === "number" && verificationCount === 0) return "clean_train_only";
  } catch {
    // Fall through to the explicit requirement below.
  }
  throw new Error("NN_INITIAL_FIT_SCOPE must be legacy_all_cases or clean_train_only, or the initial training-report must record the fitted partitions");
})();

const PARTITIONS = ["train", "dev", "verification"];
const emptyPartition = () => Object.fromEntries(PARTITIONS.map(partition => [partition, 0]));
const emptyBaseLabelCounts = () => Object.fromEntries(
  BASE_LABELS.map(label => [label, { positive: emptyPartition(), negative: emptyPartition(), masked: emptyPartition() }]),
);
const emptyReasoningLabelCounts = () => Object.fromEntries(
  REASONING_LABELS.map(label => [label, { positive: emptyPartition(), negative: emptyPartition() }]),
);

function reconstructRun(run) {
  const prior = [];
  const attempts = [];
  for (const record of run.attempts) {
    const attempt = Object.freeze({
      request: run.task.request,
      observation: record.observation === null
        ? null
        : Object.freeze({ ...record.observation, bytes: "" }),
      failure: record.failure,
      priorCoverage: Object.freeze(mergeCoverage([...prior])),
    });
    attempts.push({ record, attempt });
    prior.push(...record.coverage);
  }
  return attempts;
}

/** The same linear read as `train.mjs`; the load path applies sigmoid(z) >= 0.5. */
function predictBase(profile, vector) {
  const features = BASE_WIRES.map(wire => vector[wire]);
  const prediction = {};
  BASE_LABELS.forEach((label, head) => {
    const z = profile.weights[head].reduce((sum, weight, index) => sum + weight * features[index], 0);
    prediction[label] = z >= 0 ? 1 : 0;
  });
  return prediction;
}

/** Rebuild an attempt from a content-free pretraining receipt. */
function reconstructPretrainAttempt(run, record) {
  return Object.freeze({
    request: run.task.request,
    observation: record.observation === null ? null : Object.freeze({ ...record.observation, bytes: "" }),
    failure: record.failure,
    priorCoverage: Object.freeze([...record.priorCoverage]),
  });
}

// ---- Usage supervision (P1-1: wrong predictions are sourced, not fatal). ----
const baseEpisodes = [];
const reasoningSources = [];
const sampledErrors = [];
const rejectedSamples = [];
const taskIdsByBaseLabel = Object.fromEntries(
  BASE_LABELS.map(label => [label, { real: new Set(), injected: new Set() }]),
);
const taskIdsByReasoningLabel = Object.fromEntries(
  REASONING_LABELS.map(label => [label, { real: new Set(), injected: new Set() }]),
);
const attemptsMissingDecision = [];

for (const run of samples.runs) {
  assert.ok(PARTITIONS.includes(run.task.partition), `${run.task.id}: unknown partition`);
  const reconstructed = reconstructRun(run);
  const decisionByAttempt = new Map(run.decisions.map(decision => [decision.attemptId, decision]));
  for (const { record, attempt } of reconstructed) {
    const supervision = superviseBase(attempt);
    baseEpisodes.push(Object.freeze({
      partition: run.task.partition,
      input: measureBase(attempt),
      label: supervision.label,
      mask: supervision.mask,
      source: { taskId: run.task.id, attemptId: record.attemptId, provenance: run.task.provenance },
    }));
    for (const label of BASE_LABELS) {
      if (supervision.mask[label] === 0) continue;
      if (supervision.label[label] === 1) taskIdsByBaseLabel[label][run.task.provenance].add(run.task.id);
    }
    const decision = decisionByAttempt.get(record.attemptId);
    if (decision === undefined) {
      attemptsMissingDecision.push({ taskId: run.task.id, attemptId: record.attemptId });
      continue;
    }

    // A structurally unsourced sample is rejected with its reason; everything
    // else is supervised from the oracle, including a wrong sampled prediction.
    const recordedBase = measureBase(attempt);
    if (JSON.stringify(recordedBase) !== JSON.stringify(decision.baseVector)) {
      rejectedSamples.push({ taskId: run.task.id, attemptId: record.attemptId, reason: "recorded_base_vector_drifted" });
      continue;
    }
    const recordedReasoning = measureReasoning(decision.basePrediction, attempt, decision.context);
    if (JSON.stringify(recordedReasoning) !== JSON.stringify(decision.reasoningVector)) {
      rejectedSamples.push({ taskId: run.task.id, attemptId: record.attemptId, reason: "recorded_reasoning_vector_drifted" });
      continue;
    }
    const oracle = superviseReasoning(attempt, decision.context);
    if (JSON.stringify(oracle.allowed) !== JSON.stringify(decision.allowed)) {
      rejectedSamples.push({ taskId: run.task.id, attemptId: record.attemptId, reason: "recorded_allowed_set_is_not_oracle" });
      continue;
    }
    if (!decision.allowed.includes(decision.prediction)) {
      sampledErrors.push({
        taskId: run.task.id,
        attemptId: record.attemptId,
        prediction: decision.prediction,
        allowed: decision.allowed,
        source: { entry: run.source.entry, requestId: run.source.requestId },
      });
    }

    reasoningSources.push(Object.freeze({
      partition: run.task.partition,
      attemptId: record.attemptId,
      attempt,
      context: decision.context,
      allowed: decision.allowed,
      soft: oracle.soft,
      provenance: run.task.provenance,
      taskId: run.task.id,
    }));
    for (const label of decision.allowed) {
      taskIdsByReasoningLabel[label][run.task.provenance].add(run.task.id);
    }
  }
}

// ---- Pretraining train-partition replay (content-free, oracle-supervised). ----
const pretrainTrainBase = [];
const pretrainTrainMeasurements = [];
for (const run of pretrain.runs) {
  if (run.task.partition !== "train") continue;
  for (const record of run.attempts) {
    const attempt = reconstructPretrainAttempt(run, record);
    const supervision = superviseBase(attempt);
    pretrainTrainBase.push(Object.freeze({
      partition: "train",
      input: measureBase(attempt),
      label: supervision.label,
      mask: supervision.mask,
      source: { taskId: run.task.id, attemptId: record.attemptId, provenance: run.task.provenance },
    }));
    pretrainTrainMeasurements.push({ attempt, context: run.task.context });
  }
}

const counts = {
  tasksByPartition: emptyPartition(),
  attemptsByPartition: emptyPartition(),
  decisionsByPartition: emptyPartition(),
  baseLabels: emptyBaseLabelCounts(),
  reasoningLabels: emptyReasoningLabelCounts(),
};
for (const run of samples.runs) counts.tasksByPartition[run.task.partition] += 1;
for (const episode of baseEpisodes) {
  const partition = episode.partition;
  counts.attemptsByPartition[partition] += 1;
  for (const label of BASE_LABELS) {
    if (episode.mask[label] === 0) counts.baseLabels[label].masked[partition] += 1;
    else if (episode.label[label] === 1) counts.baseLabels[label].positive[partition] += 1;
    else counts.baseLabels[label].negative[partition] += 1;
  }
}
for (const source of reasoningSources) {
  const partition = source.partition;
  counts.decisionsByPartition[partition] += 1;
  for (const label of REASONING_LABELS) {
    if (source.allowed.includes(label)) counts.reasoningLabels[label].positive[partition] += 1;
    else counts.reasoningLabels[label].negative[partition] += 1;
  }
}

const shortfalls = [];
for (const label of BASE_LABELS) {
  for (const partition of PARTITIONS) {
    if (counts.baseLabels[label].positive[partition] === 0) {
      shortfalls.push({ unit: "base", label, partition, kind: "no_positive" });
    }
  }
}
for (const label of REASONING_LABELS) {
  for (const partition of PARTITIONS) {
    if (counts.reasoningLabels[label].positive[partition] === 0) {
      shortfalls.push({ unit: "reasoning", label, partition, kind: "no_positive" });
    }
  }
}
if (attemptsMissingDecision.length > 0) {
  shortfalls.push({ unit: "reasoning", kind: "attempt_without_decision", count: attemptsMissingDecision.length });
}

// ---- Fit both candidates: delivery (warm start + replay) and diagnostic (zero start). ----
async function fitPair({ mode, baseInitialProfile, reasoningInitialProfile, mixedPretrainReplay, out }) {
  const trainBase = baseEpisodes.filter(episode => episode.partition === "train");
  const trainReasoning = reasoningSources.filter(source => source.partition === "train");
  assert.ok(trainBase.length > 0, "post-use base fit needs at least one train episode");
  assert.ok(trainReasoning.length > 0, "post-use reasoning fit needs at least one train decision");

  const baseFitInput = {
    handwiredRoot,
    epochs: 200,
    learningRate: 0.1,
    episodes: mixedPretrainReplay ? [...pretrainTrainBase, ...trainBase] : trainBase,
    stopCheckpoints: [50, 100, 150, 200],
  };
  if (baseInitialProfile !== undefined) baseFitInput.initialProfile = baseInitialProfile;
  const baseFit = await fitReadFeedbackProfile(baseFitInput);
  const baseProfilePath = join(out, "base-profile.json");
  await writeFile(baseProfilePath, JSON.stringify(baseFit.profile, null, 2));

  // Reasoning replay inputs are regenerated from the current candidate base
  // unit's real infer output, never from gold or from an old base prediction.
  const replayReasoningEpisodes = mixedPretrainReplay
    ? pretrainTrainMeasurements.map(({ attempt, context }) => {
      const basePrediction = predictBase(baseFit.profile, measureBase(attempt));
      const oracle = superviseReasoning(attempt, context);
      return {
        partition: "train",
        input: measureReasoning(basePrediction, attempt, context),
        allowed: oracle.allowed,
        soft: oracle.soft,
      };
    })
    : [];
  const usageReasoningEpisodes = trainReasoning.map(source => ({
    partition: source.partition,
    input: measureReasoning(
      predictBase(baseFit.profile, measureBase(source.attempt)),
      source.attempt,
      source.context,
    ),
    allowed: source.allowed,
    soft: source.soft,
  }));
  const reasoningFitInput = {
    handwiredRoot,
    epochs: 200,
    learningRate: 0.1,
    episodes: [...replayReasoningEpisodes, ...usageReasoningEpisodes],
    stopCheckpoints: [50, 100, 150, 200],
  };
  if (reasoningInitialProfile !== undefined) reasoningFitInput.initialProfile = reasoningInitialProfile;
  const reasoningFit = await fitReadReasoningProfile(reasoningFitInput);
  const reasoningProfilePath = join(out, "reasoning-profile.json");
  await writeFile(reasoningProfilePath, JSON.stringify(reasoningFit.profile, null, 2));

  return { baseFit, reasoningFit, baseProfilePath, reasoningProfilePath, replayReasoningEpisodes };
}

// Warm-start delivery.
const initialBaseProfile = await loadReadProfile(join(outDir, "base-profile.json"), "base");
const initialReasoningProfile = await loadReadProfile(join(outDir, "reasoning-profile.json"), "reasoning");
const delivery = await fitPair({
  mode: "warm",
  baseInitialProfile: initialBaseProfile,
  reasoningInitialProfile: initialReasoningProfile,
  mixedPretrainReplay: true,
  out: postDir,
});

// Zero-start diagnostic control: the old failure evidence, kept reproducible.
const diagnostic = await fitPair({
  mode: "zero",
  baseInitialProfile: undefined,
  reasoningInitialProfile: undefined,
  mixedPretrainReplay: false,
  out: zeroDir,
});

// Attribution control: warm start plus pretraining replay, without the new
// usage supervision. It separates "the replay re-anchored the weights" from
// "the new sourced feedback actually taught something".
const replayOnlyBaseFit = await fitReadFeedbackProfile({
  handwiredRoot,
  epochs: 200,
  learningRate: 0.1,
  episodes: pretrainTrainBase,
  stopCheckpoints: [50, 100, 150, 200],
  initialProfile: initialBaseProfile,
});

// ---- Evaluation helpers. ----
function scoreBase(unit, episodes) {
  let correct = 0;
  let scored = 0;
  for (const episode of episodes) {
    const predicted = unit.inferBase(episode.input);
    for (const label of BASE_LABELS) {
      if (episode.mask[label] === 0) continue;
      scored += 1;
      if (predicted[label] === episode.label[label]) correct += 1;
    }
  }
  return { correct, scored, accuracy: scored === 0 ? null : correct / scored };
}

function scoreReasoning(unit, sources) {
  let correct = 0;
  let scored = 0;
  for (const source of sources) {
    const basePrediction = unit.inferBase(measureBase(source.attempt));
    const prediction = unit.inferReasoning(measureReasoning(basePrediction, source.attempt, source.context));
    scored += 1;
    if (source.allowed.includes(prediction)) correct += 1;
  }
  return { correct, scored, accuracy: scored === 0 ? null : correct / scored };
}

const initialUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "base-profile.json"),
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});
const postUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: delivery.baseProfilePath,
  reasoningProfilePath: delivery.reasoningProfilePath,
});
const zeroUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: diagnostic.baseProfilePath,
  reasoningProfilePath: diagnostic.reasoningProfilePath,
});

// New usage partitions: initial vs post (and zero diagnostic), evaluate only.
const replayOnlyUnit = Object.freeze({
  inferBase(vector) { return predictBase(replayOnlyBaseFit.profile, vector); },
});
const usageEvaluation = { train: null, dev: null, verification: null };
for (const partition of PARTITIONS) {
  const base = baseEpisodes.filter(item => item.partition === partition);
  const reasoning = reasoningSources.filter(item => item.partition === partition);
  usageEvaluation[partition] = {
    initial: { base: scoreBase(initialUnit, base), reasoning: scoreReasoning(initialUnit, reasoning) },
    post: { base: scoreBase(postUnit, base), reasoning: scoreReasoning(postUnit, reasoning) },
    zero: { base: scoreBase(zeroUnit, base), reasoning: scoreReasoning(zeroUnit, reasoning) },
    replayOnlyBase: scoreBase(replayOnlyUnit, base),
  };
}

// Pretraining sufficiency on the old gold: the pretraining verification partition
// is evaluation only and is never mixed into any fit above.
const pretrainVerification = [];
for (const run of pretrain.runs) {
  if (run.task.partition !== "verification") continue;
  for (const record of run.attempts) {
    pretrainVerification.push({ attempt: reconstructPretrainAttempt(run, record), context: run.task.context });
  }
}
const pretrainVerificationBase = pretrainVerification.map(({ attempt }) => {
  const supervision = superviseBase(attempt);
  return { input: measureBase(attempt), label: supervision.label, mask: supervision.mask };
});
const initialOnOldGold = {
  base: scoreBase(initialUnit, pretrainVerificationBase),
  reasoning: scoreReasoning(initialUnit, pretrainVerification.map(({ attempt, context }) => ({
    attempt, context, allowed: superviseReasoning(attempt, context).allowed,
  }))),
};
const postOnOldGold = {
  base: scoreBase(postUnit, pretrainVerificationBase),
  reasoning: scoreReasoning(postUnit, pretrainVerification.map(({ attempt, context }) => ({
    attempt, context, allowed: superviseReasoning(attempt, context).allowed,
  }))),
};
const zeroOnOldGold = {
  base: scoreBase(zeroUnit, pretrainVerificationBase),
  reasoning: scoreReasoning(zeroUnit, pretrainVerification.map(({ attempt, context }) => ({
    attempt, context, allowed: superviseReasoning(attempt, context).allowed,
  }))),
};

// Epoch-0 reproduction: the fit's epoch-0 head report (at the supplied weights,
// before any gradient step) must equal an independent forward through the
// public loader on the same training episodes.
function perHeadAccuracy(unit, episodes) {
  const per = Object.fromEntries(BASE_LABELS.map(label => [label, { correct: 0, total: 0 }]));
  for (const episode of episodes) {
    const predicted = unit.inferBase(episode.input);
    for (const label of BASE_LABELS) {
      if (episode.mask[label] === 0) continue;
      per[label].total += 1;
      if (predicted[label] === episode.label[label]) per[label].correct += 1;
    }
  }
  return Object.fromEntries(BASE_LABELS.map(label => [
    label,
    per[label].total === 0 ? 1 : per[label].correct / per[label].total,
  ]));
}
const deliveryBaseTrain = [...pretrainTrainBase, ...baseEpisodes.filter(item => item.partition === "train")];
const deliveryReasoningTrain = [
  ...pretrainTrainMeasurements,
  ...reasoningSources.filter(source => source.partition === "train").map(source => ({
    attempt: source.attempt,
    context: source.context,
  })),
];
const epochZeroBaseObserved = perHeadAccuracy(initialUnit, deliveryBaseTrain);
const baseEpochZero = delivery.baseFit.epochZero === null ? { present: false } : {
  present: true,
  reported: Object.fromEntries(delivery.baseFit.epochZero.map(entry => [entry.label, entry.trainAccuracy])),
  observed: epochZeroBaseObserved,
  allEqual: delivery.baseFit.epochZero.every(entry => entry.trainAccuracy === epochZeroBaseObserved[entry.label]),
};
// The reasoning rows carry the fitted base's `fb_*` wires, so the epoch-0
// reproduction check loads exactly that pair: fitted base + initial reasoning.
const epochZeroReasoningUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: delivery.baseProfilePath,
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});
const reasoningEpochZeroObserved = scoreReasoning(
  epochZeroReasoningUnit,
  deliveryReasoningTrain.map(({ attempt, context }) => ({
    attempt,
    context,
    allowed: superviseReasoning(attempt, context).allowed,
  })),
);
const reasoningEpochZero = delivery.reasoningFit.epochZero === null ? { present: false } : {
  present: true,
  reported: delivery.reasoningFit.epochZero[0].trainAccuracy,
  observed: reasoningEpochZeroObserved.accuracy,
  allEqual: delivery.reasoningFit.epochZero.every(entry => entry.trainAccuracy === reasoningEpochZeroObserved.accuracy),
};
const epochZeroEvidence = { base: baseEpochZero, reasoning: reasoningEpochZero };
assert.equal(baseEpochZero.present, true, "the continued base fit must report an epoch-0 forward");
assert.equal(reasoningEpochZero.present, true, "the continued reasoning fit must report an epoch-0 forward");
assert.equal(baseEpochZero.allEqual, true, "epoch-0 base forward must reproduce the loaded initial base profile");
assert.equal(reasoningEpochZero.allEqual, true, "epoch-0 reasoning forward must reproduce the loaded initial reasoning profile");

// Real update evidence: the continued fit must actually move weights.
function weightDelta(initialProfile, fittedProfile) {
  let changed = 0;
  let total = 0;
  let maxAbs = 0;
  for (let head = 0; head < fittedProfile.weights.length; head += 1) {
    for (let wire = 0; wire < fittedProfile.weights[head].length; wire += 1) {
      const delta = Math.abs(fittedProfile.weights[head][wire] - initialProfile.weights[head][wire]);
      if (delta > maxAbs) maxAbs = delta;
      if (delta > 0) changed += 1;
      total += 1;
    }
  }
  return { changedWeights: changed, totalWeights: total, maxAbsDelta: maxAbs };
}
const updateEvidence = {
  base: weightDelta(initialBaseProfile, delivery.baseFit.profile),
  reasoning: weightDelta(initialReasoningProfile, delivery.reasoningFit.profile),
};

const perLabelSources = {
  base: Object.fromEntries(BASE_LABELS.map(label => [label, {
    real: [...taskIdsByBaseLabel[label].real].sort(),
    injected: [...taskIdsByBaseLabel[label].injected].sort(),
  }])),
  reasoning: Object.fromEntries(REASONING_LABELS.map(label => [label, {
    real: [...taskIdsByReasoningLabel[label].real].sort(),
    injected: [...taskIdsByReasoningLabel[label].injected].sort(),
  }])),
};

const report = {
  schema: "nnanything.cli-read-feedback.post-training-report.v1",
  generatedBy: "playground/cli/read-feedback/post-train.mjs",
  sources: [samplePath, pretrainPath],
  outputDir: postDir,
  zeroStartDiagnosticDir: zeroDir,
  applied: false,
  isolation: {
    warmStartInputs: [join(outDir, "base-profile.json"), join(outDir, "reasoning-profile.json")],
    wroteWarmStartInputs: false,
    wroteOnlyUnder: [postDir, zeroDir],
    outputBaseProfile: delivery.baseProfilePath,
    outputReasoningProfile: delivery.reasoningProfilePath,
  },
  fitOrder: ["base", "reasoning"],
  initialization: {
    weights: "initial_profile",
    reasoningInput: "current_candidate_base_infer_output",
    epochZero: epochZeroEvidence,
  },
  trainingPolicy: {
    executesReads: false,
    replayIllegalActions: false,
    note: "the entry only loads content-free samples and fits; it never runs the read goal or replays a sampled decision",
  },
  sampledErrors,
  rejectedSamples,
  update: updateEvidence,
  counts,
  partitions: {
    tasks: counts.tasksByPartition,
    baseEpisodes: counts.attemptsByPartition,
    reasoningEpisodes: counts.decisionsByPartition,
  },
  pretrainingReplay: {
    partition: "train",
    cases: pretrainTrainBase.length,
    reasoningEpisodes: delivery.replayReasoningEpisodes.length,
    note: "pretraining train partition replayed content-free; reasoning inputs regenerated from the current candidate base infer output",
  },
  shortfalls,
  attemptsMissingDecision,
  perLabelSources,
  pretrainingSufficiency: {
    oldGoldVerificationCases: pretrainVerification.length,
    initial: initialOnOldGold,
    initialFitScope,
    oldGoldRole: "known-regression reference (old gold): the legacy initial candidate was fitted on all 76 cases, so this slice is never claimed as unseen evidence",
    oldGoldDetail: initialFitScope === "legacy_all_cases"
      ? "the loaded initial candidate fitted all 76 cases, so 94/94 and 19/19 are in-sample coverage"
      : "the loaded clean initial candidate did not fit this slice; it is still the same old gold, so evaluation here is a regression reference, not independent unseen evidence",
    independentSourceGeneralization: "not established",
    conclusion: initialFitScope === "legacy_all_cases"
      ? "the recorded 94/94 and 19/19 are in-sample coverage of a same-source corpus that the legacy initial candidate already learned; they are kept as a known-regression reference only. A clean train-only initial evaluates this slice as held out relative to itself, but independent-source generalization remains unestablished and is not claimed"
      : "the clean initial candidate was fitted on the train partition only, so this verification slice is held out relative to it; the 12 families are still one-author deterministic templates, so independent-source generalization remains unestablished and is not claimed",
  },
  evaluation: {
    usage: usageEvaluation,
    oldGold: { initial: initialOnOldGold, post: postOnOldGold, zero: zeroOnOldGold },
  },
  ablation: {
    label: "warm start + pretraining replay only, without the new usage supervision",
    base: Object.fromEntries(PARTITIONS.map(partition => [partition, {
      initial: usageEvaluation[partition].initial.base,
      replayOnly: usageEvaluation[partition].replayOnlyBase,
      post: usageEvaluation[partition].post.base,
    }])),
    fit: {
      stopped: replayOnlyBaseFit.stopped,
      epochsCompleted: replayOnlyBaseFit.epochsCompleted,
      headReport: replayOnlyBaseFit.headReport,
    },
  },
  base: {
    stopped: delivery.baseFit.stopped,
    epochsCompleted: delivery.baseFit.epochsCompleted,
    probe: delivery.baseFit.probe,
    headReport: delivery.baseFit.headReport,
    epochZero: delivery.baseFit.epochZero,
    trajectory: delivery.baseFit.trajectory,
    timing: delivery.baseFit.timing,
  },
  reasoning: {
    stopped: delivery.reasoningFit.stopped,
    epochsCompleted: delivery.reasoningFit.epochsCompleted,
    probe: delivery.reasoningFit.probe,
    headReport: delivery.reasoningFit.headReport,
    epochZero: delivery.reasoningFit.epochZero,
    trajectory: delivery.reasoningFit.trajectory,
    timing: delivery.reasoningFit.timing,
  },
  zeroStartDiagnostic: {
    note: "all-zero start kept only as a labeled diagnostic control; it is not the continued post-training deliverable",
    base: {
      stopped: diagnostic.baseFit.stopped,
      epochsCompleted: diagnostic.baseFit.epochsCompleted,
      headReport: diagnostic.baseFit.headReport,
    },
    reasoning: {
      stopped: diagnostic.reasoningFit.stopped,
      epochsCompleted: diagnostic.reasoningFit.epochsCompleted,
      headReport: diagnostic.reasoningFit.headReport,
    },
    oldGold: zeroOnOldGold,
  },
  unknowns: [
    "condition_met, need_current_target and need_observation have no sampled decision positives when the run stops directly at root evaluation or cannot reach a no-receipt state",
    "independent-source generalization is not delivered this round; the replay and usage corpora are same-author cross-family instances",
  ],
};
await writeFile(join(postDir, "training-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  out: postDir,
  zeroDiagnostic: zeroDir,
  sampledErrors,
  rejectedSamples,
  shortfalls,
  pretrainingSufficiency: report.pretrainingSufficiency,
  update: updateEvidence,
  evaluation: report.evaluation,
  ablation: report.ablation.base,
  base: { stopped: delivery.baseFit.stopped, epochs: delivery.baseFit.epochsCompleted, probe: delivery.baseFit.probe, headReport: delivery.baseFit.headReport },
  reasoning: { stopped: delivery.reasoningFit.stopped, epochs: delivery.reasoningFit.epochsCompleted, probe: delivery.reasoningFit.probe, headReport: delivery.reasoningFit.headReport },
}, null, 2));
