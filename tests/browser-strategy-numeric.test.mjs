import assert from "node:assert/strict";
import { test } from "node:test";

const strategyModuleUrl = process.env.NN_BROWSER_STRATEGY_URL
  ?? new URL("../dist/filters/browser-strategy.js", import.meta.url).href;
const strategySamplesModuleUrl = process.env.NN_BROWSER_STRATEGY_SAMPLES_URL
  ?? new URL("../dist/training/browser-strategy-samples.js", import.meta.url).href;
const strategyNumericModuleUrl = process.env.NN_BROWSER_STRATEGY_NUMERIC_URL
  ?? new URL("../dist/training/browser-strategy-numeric.js", import.meta.url).href;
const strategyTrainableModuleUrl = process.env.NN_BROWSER_STRATEGY_TRAINABLE_URL
  ?? new URL("../dist/nodes/trainable/browser-strategy.js", import.meta.url).href;
const atomicPolicyModuleUrl = process.env.NN_BROWSER_STRATEGY_ATOMIC_POLICY_URL
  ?? new URL("../dist/filters/browser-single-action-policy.js", import.meta.url).href;
const feedbackModuleUrl = process.env.NN_BROWSER_STRATEGY_FEEDBACK_URL
  ?? new URL("../dist/filters/browser-feedback.js", import.meta.url).href;
const handwiredModuleUrl = process.env.NN_BROWSER_STRATEGY_HANDWIRED_URL
  ?? new URL("../dist/training/handwired.js", import.meta.url).href;

const loadStrategy = () => import(strategyModuleUrl);
const loadSamples = () => import(strategySamplesModuleUrl);
const loadNumeric = () => import(strategyNumericModuleUrl);
const loadTrainable = () => import(strategyTrainableModuleUrl);
const loadAtomicPolicy = () => import(atomicPolicyModuleUrl);
const loadFeedback = () => import(feedbackModuleUrl);
const loadHandwired = () => import(handwiredModuleUrl);

async function atomicProfile() {
  const policy = await loadAtomicPolicy();
  const zero = policy.createZeroBrowserSingleActionProfile();
  const relationWeights = zero.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  return policy.validateBrowserSingleActionProfile({ ...zero, relationWeights });
}

async function feedbackProfile() {
  const feedback = await loadFeedback();
  const zero = feedback.createZeroFeedbackProfile();
  const weights = zero.weights.map(row => [...row]);
  const wire = name => zero.wires.indexOf(name);
  weights[0][wire("post.currentValid")] = 3;
  weights[0][wire("regionExpanded.known")] = 1;
  weights[0][wire("regionRendered.known")] = 1;
  weights[0][wire("regionExpanded.value")] = -2;
  weights[0][wire("regionRendered.value")] = -1;
  weights[1][wire("dispatch.known")] = 5;
  weights[1][wire("dispatch.value")] = -5;
  weights[2][wire("bias")] = 1;
  return feedback.validateFeedbackProfile({ ...zero, weights });
}

function strategyProfile(strategy, weightsByHead) {
  const zero = strategy.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  for (const [headName, entries] of Object.entries(weightsByHead)) {
    const row = zero.heads.indexOf(headName);
    for (const [wireName, value] of Object.entries(entries)) {
      weights[row][zero.wires.indexOf(wireName)] = value;
    }
  }
  return strategy.validateBrowserStrategyProfile({ ...zero, weights });
}

function predictionFor(strategy, models, episode, profile) {
  return strategy.predictBrowserStrategy(episode.input, {
    ...models,
    profile,
    registry: episode.registry,
    selection: episode.selection,
  });
}

function squaredHingeLoss(margins, expectedIndex) {
  const competitors = expectedIndex < 0
    ? [...margins]
    : [0, ...margins.filter((_, index) => index !== expectedIndex)];
  const selected = expectedIndex < 0 ? 0 : margins[expectedIndex];
  const deficit = Math.max(0, 1 + Math.max(...competitors) - selected);
  return 0.5 * deficit * deficit;
}

function assertCloseArray(actual, expected, tolerance, message) {
  assert.equal(actual.length, expected.length, message);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance,
      `${message} at ${index}: expected ${expected[index]}, received ${actual[index]}`);
  }
}

async function oneBatchGradient(numeric, models, episode, profile) {
  return numeric.fitBrowserStrategyProfile({
    ...models,
    profile,
    episodes: [episode],
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    epochs: 1,
    learningRate: 0.1,
  });
}

async function modelsAndSamples() {
  const samples = await loadSamples();
  return {
    samples: samples.makeStrategySamples(),
    models: {
      atomicProfile: await atomicProfile(),
      feedbackProfile: await feedbackProfile(),
    },
  };
}

test("samples are exactly 36 train and 12 development synthetic decision sets", async () => {
  const { samples, models } = await modelsAndSamples();
  const samplesModule = await loadSamples();
  const strategy = await loadStrategy();
  const partitions = samplesModule.partitionStrategyEpisodes(samples);
  assert.equal(samples.length, 48);
  assert.equal(partitions.train.length, 36);
  assert.equal(partitions.development.length, 12);
  assert.equal(partitions.verification.length, 0);
  assert.ok(samples.every(episode => episode.teacher.source === "synthetic_projection"));
  assert.ok(samples.every(episode => episode.teacher.evidenceRefs.length > 0));
  const evaluated = samplesModule.evaluateStrategyCases(
    strategy.createZeroBrowserStrategyProfile(),
    samples,
    models,
  );
  assert.equal(evaluated.count, 48);
  assert.equal(evaluated.rows.length, 48);
});

test("synthetic feedback fixture projects three distinct actual F1 heads", async () => {
  const strategy = await loadStrategy();
  const feedback = await loadFeedback();
  const { samples, models } = await modelsAndSamples();
  const cases = [
    ["strategy-locked-native-positive-00", "completed_without_goal", [1, 0, 0]],
    ["strategy-execution-rejected-defer-00", "execution_rejected", [0, 1, 0]],
    ["strategy-indeterminate-defer-00", "indeterminate", [0, 0, 1]],
  ];
  for (const [id, expectedHead, expectedFeedbackWires] of cases) {
    const episode = samples.find(row => row.id === id);
    assert.ok(episode);
    const predicted = feedback.predictFeedback(episode.input.history[0].input, models.feedbackProfile);
    assert.equal(predicted.status, "predicted");
    assert.equal(predicted.head, expectedHead);
    const projected = predictionFor(
      strategy,
      models,
      episode,
      strategy.createZeroBrowserStrategyProfile(),
    );
    for (const candidate of projected.candidates) {
      assert.deepEqual(candidate.features.slice(5, 8), expectedFeedbackWires);
    }
  }
});

test("fitter rejects non-train and indistinguishable teacher conflicts before backend load", async () => {
  const numeric = await loadNumeric();
  const strategy = await loadStrategy();
  const { samples, models } = await modelsAndSamples();
  const first = samples.find(episode => episode.partition === "train");
  assert.ok(first);
  await assert.rejects(numeric.fitBrowserStrategyProfile({
    ...models,
    profile: strategy.createZeroBrowserStrategyProfile(),
    episodes: [{ ...first, partition: "development" }],
    handwiredRoot: "/backend/not-loaded",
    epochs: 1,
    learningRate: 0.1,
  }), /only train episodes/);

  const conflict = {
    ...structuredClone(first),
    id: `${first.id}:conflict`,
    family: `${first.family}:conflict`,
    teacher: {
      selectedSkillId: null,
      source: "synthetic_projection",
      evidenceRefs: [...first.teacher.evidenceRefs],
      note: "explicit conflicting fixture",
    },
  };
  await assert.rejects(numeric.fitBrowserStrategyProfile({
    ...models,
    profile: strategy.createZeroBrowserStrategyProfile(),
    episodes: [first, conflict],
    handwiredRoot: "/backend/not-loaded",
    epochs: 1,
    learningRate: 0.1,
  }), /conflicting strategy decision sets/i);
});

test("real Handwired shared 20-parameter gradient matches finite difference and has preference direction", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const strategy = await loadStrategy();
  const samplesModule = await loadSamples();
  const numeric = await loadNumeric();
  const trainable = await loadTrainable();
  const { loadHandwired: loadHandwiredModule } = await loadHandwired();
  const { samples, models } = await modelsAndSamples();
  const episode = samples.find(row =>
    row.partition === "train" && row.teacher.selectedSkillId !== null);
  assert.ok(episode);
  const initial = strategy.createZeroBrowserStrategyProfile();
  const fit = await numeric.fitBrowserStrategyProfile({
    ...models,
    profile: initial,
    episodes: [episode],
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    epochs: 1,
    learningRate: 0.1,
  });
  assert.equal(fit.profile.weights.flat().length, 20);
  assert.equal(fit.trajectory.length, 1);
  assert.equal(fit.timing.decisionSets, 1);
  assert.ok(fit.timing.candidateRows >= 1);
  assert.ok(fit.timing.gradientCandidateEpochs >= 1);

  const resources = {
    ...models,
    profile: initial,
    registry: episode.registry,
    selection: episode.selection,
  };
  const prediction = strategy.predictBrowserStrategy(
    strategy.readBrowserStrategyRequest(episode.input),
    resources,
  );
  const selected = prediction.candidates.find(candidate =>
    candidate.skillId === episode.teacher.selectedSkillId);
  assert.ok(selected);
  const gradient = fit.trajectory[0].gradient;
  assert.ok(Math.abs(fit.trajectory[0].loss - 0.5) < 1e-7);
  assert.ok(gradient[1] < -1e-8);
  assert.ok(gradient[11] > 1e-8);

  const handwiredModule = await loadHandwiredModule(process.env.NN_HANDWIRED_ROOT);
  const circuit = trainable.buildBrowserStrategyCircuit(handwiredModule);
  const expectedIndex = prediction.candidates.findIndex(candidate =>
    candidate.skillId === episode.teacher.selectedSkillId);
  function lossFor(weights) {
    const margins = prediction.candidates.map(candidate => {
      const source = new Float32Array(circuit.circuit.sourceSize);
      circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]); });
      circuit.features.forEach((wire, index) => { source[wire] = Math.fround(candidate.features[index]); });
      const values = circuit.circuit.evaluateReference(source);
      return values[circuit.logits[0]] - values[circuit.logits[1]];
    });
    return squaredHingeLoss(margins, expectedIndex);
  }
  const epsilon = 0.01;
  const plus = initial.weights.flat();
  const minus = initial.weights.flat();
  plus[1] = epsilon;
  minus[1] = -epsilon;
  const numericGradient = (lossFor(plus) - lossFor(minus)) / (plus[1] - minus[1]);
  assert.ok(Number.isFinite(numericGradient));
  assert.ok(Math.abs(gradient[1] - numericGradient) < 3e-3);
});

test("squared hinge has zero gradient when the selected candidate clears the fixed margin", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const strategy = await loadStrategy();
  const numeric = await loadNumeric();
  const { samples, models } = await modelsAndSamples();
  const episode = samples.find(row => row.id === "strategy-native-preference-00");
  assert.ok(episode);
  const scale = 5;
  const marginWeights = {
    bias: 1,
    nativeButton: 0.3,
    explicitRoleButton: 0,
    "relation.providerMargin": 0,
    "feedback.present": -1,
    "feedback.completedWithoutGoal": 0.5,
    "feedback.executionRejected": -2,
    "feedback.indeterminate": -2,
    "verifiedSuccess.known": 0,
    "verifiedSuccess.value": 2,
  };
  const profile = strategyProfile(strategy, {
    choose: Object.fromEntries(Object.entries(marginWeights).map(([name, value]) => [name, value * scale])),
    defer: Object.fromEntries(Object.entries(marginWeights).map(([name, value]) => [name, -value * scale])),
  });
  const projected = predictionFor(strategy, models, episode, profile);
  const expectedIndex = projected.candidates.findIndex(candidate =>
    candidate.skillId === episode.teacher.selectedSkillId);
  assert.ok(expectedIndex >= 0);
  const selectedMargin = projected.candidates[expectedIndex].margin;
  const rivalMargin = Math.max(
    0,
    ...projected.candidates
      .filter((_, index) => index !== expectedIndex)
      .map(candidate => candidate.margin),
  );
  assert.ok(selectedMargin >= rivalMargin + 1);

  const fit = await oneBatchGradient(numeric, models, episode, profile);
  assert.equal(fit.trajectory[0].loss, 0);
  assert.ok(fit.trajectory[0].gradient.every(value => Math.abs(value) <= 1e-12));
});

test("fixed zero DEFER shares a maximum tie without backpropagating its share", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const strategy = await loadStrategy();
  const numeric = await loadNumeric();
  const { samples, models } = await modelsAndSamples();
  const episode = samples.find(row => row.id === "strategy-native-preference-00");
  assert.ok(episode);
  const profile = strategy.createZeroBrowserStrategyProfile();
  const projected = predictionFor(strategy, models, episode, profile);
  const selectedIndex = projected.candidates.findIndex(candidate =>
    candidate.skillId === episode.teacher.selectedSkillId);
  const rivalIndex = projected.candidates.findIndex((_, index) => index !== selectedIndex);
  assert.ok(selectedIndex >= 0);
  assert.ok(rivalIndex >= 0);
  const selectedFeatures = projected.candidates[selectedIndex].features;
  const rivalFeatures = projected.candidates[rivalIndex].features;
  const expectedChoose = selectedFeatures.map((value, index) =>
    -value + 0.5 * rivalFeatures[index]);
  const expectedGradient = [...expectedChoose, ...expectedChoose.map(value => -value)];

  const fit = await oneBatchGradient(numeric, models, episode, profile);
  assert.ok(Math.abs(fit.trajectory[0].loss - 0.5) < 1e-7);
  assertCloseArray(fit.trajectory[0].gradient, expectedGradient, 2e-6, "fixed DEFER tie gradient");
});

test("fixed DEFER teacher raises every maximum candidate once and is order invariant", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const strategy = await loadStrategy();
  const numeric = await loadNumeric();
  const { samples, models } = await modelsAndSamples();
  const episode = samples.find(row => row.id === "strategy-indeterminate-defer-00");
  assert.ok(episode);
  const profile = strategy.createZeroBrowserStrategyProfile();
  const projected = predictionFor(strategy, models, episode, profile);
  assert.equal(projected.kind, "DEFER");
  assert.equal(projected.candidates.length, 2);
  const summedFeatures = projected.candidates[0].features.map(
    (value, index) => 0.5 * (value + projected.candidates[1].features[index]),
  );
  const expectedGradient = [...summedFeatures, ...summedFeatures.map(value => -value)];

  const fit = await oneBatchGradient(numeric, models, episode, profile);
  assert.ok(Math.abs(fit.trajectory[0].loss - 0.5) < 1e-7);
  assertCloseArray(fit.trajectory[0].gradient, expectedGradient, 2e-6, "DEFER gradient");

  const reversed = structuredClone(episode);
  reversed.id = `${episode.id}:reversed`;
  reversed.family = `${episode.family}:reversed`;
  reversed.selection.eligibleSkillIds = [...reversed.selection.eligibleSkillIds].reverse();
  const reversedProjected = predictionFor(strategy, models, reversed, profile);
  assert.deepEqual(
    reversedProjected.candidates.map(candidate => candidate.skillId),
    [...projected.candidates].reverse().map(candidate => candidate.skillId),
  );
  const reversedFit = await oneBatchGradient(numeric, models, reversed, profile);
  assertCloseArray(reversedFit.trajectory[0].gradient, fit.trajectory[0].gradient, 1e-7,
    "candidate order invariant gradient");
});
