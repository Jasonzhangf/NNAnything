import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as api from 'nnanything/browser-feedback';
test('feedback unit exposes a real workflow inference entry', async () => {
  const api = await import('nnanything/browser-feedback');
  const sample = api.makeFeedbackSamples()[0];
  const result = await api.browserFeedbackUnit.infer(sample.input, { profile: api.createZeroFeedbackProfile() });
  assert.equal(result.prediction.status, 'unknown');
  assert.equal(result.satisfaction, null);
  assert.deepEqual(result.input.result, sample.input.result);
});
test('feedback keeps missing observations distinct from observed false and retains execution errors', async () => {
  const samples = api.makeFeedbackSamples();
  const noEffect = samples.find(row => row.teacher.head === 'completed_without_goal');
  const unknown = samples.find(row => row.id.endsWith('-9'));
  assert.equal(api.feedbackFeatures(noEffect.input)[6], 1);
  assert.equal(api.feedbackFeatures(noEffect.input)[7], 1);
  assert.equal(api.feedbackFeatures(noEffect.input)[8], 0);
  assert.equal(api.feedbackFeatures(unknown.input)[6], 0);
  assert.equal(api.feedbackFeatures(unknown.input)[7], 0);
  const rejected = samples.find(row => row.teacher.head === 'execution_rejected');
  const result = await api.browserFeedbackUnit.infer(rejected.input, { profile: api.createZeroFeedbackProfile() });
  assert.deepEqual(result.input.result.receipt.error, rejected.input.result.receipt.error);
  assert.equal(result.input.result.effectKnowledge, 'none');
});
test('a learned diagnostic cannot declare the original Goal achieved', async () => {
  const input = structuredClone(api.makeFeedbackSamples()[0].input);
  input.result.achieved = true;
  input.result.satisfaction = 100;
  assert.notEqual(api.predictFeedback(input, api.createZeroFeedbackProfile()).status, 'goal_achieved');
  const region = input.result.newState.regions.find(row => row.ref === input.request.goal.regionRef);
  region.expanded.value = true;
  region.rendered.value = true;
  assert.equal(api.predictFeedback(input, api.createZeroFeedbackProfile()).status, 'goal_achieved');
  input.controlAtCompletion.revision += 1;
  assert.notEqual(api.predictFeedback(input, api.createZeroFeedbackProfile()).status, 'goal_achieved');
});
test('feedback schema rejects contradictory receipts and profiles without fallback', () => {
  const input = structuredClone(api.makeFeedbackSamples()[0].input);
  input.result.receipt.dispatched = false;
  assert.throws(() => api.readFeedbackInput(input), /receipt/i);
  const profile = api.createZeroFeedbackProfile();
  profile.wires.reverse();
  assert.throws(() => api.predictFeedback(api.makeFeedbackSamples()[0].input, profile), /profile/);
});
test('feedback training rejects verification and split family leakage', async () => {
  const episodes = structuredClone(api.makeFeedbackSamples());
  episodes[1].partition = 'development';
  assert.throws(() => api.partitionFeedbackEpisodes(episodes), /family/);
  const clean = structuredClone(api.makeFeedbackSamples());
  clean[0].family = 'separate-verification';
  clean[0].partition = 'verification';
  const outputDirectory = await mkdtemp(join(tmpdir(), 'nn-feedback-boundary-'));
  try {
    await assert.rejects(api.browserFeedbackUnit.train({ episodes: clean, initial: api.createZeroFeedbackProfile(), epochs: 200, learningRate: .1 }, {
      handwiredRoot: '/missing-feedback-backend', outputDirectory,
    }), /verification/);
  } finally { await rm(outputDirectory, { recursive: true, force: true }); }
});
test('feedback fitting requires the real numerical backend', async () => {
  await assert.rejects(api.fitFeedbackProfile({ initial: api.createZeroFeedbackProfile(), episodes: api.partitionFeedbackEpisodes(api.makeFeedbackSamples()).train,
    handwiredRoot: '/missing-feedback-backend', epochs: 200, learningRate: .1 }), /Handwired core is missing/);
});
