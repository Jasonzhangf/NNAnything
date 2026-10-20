import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const library = () => import('nnanything/browser-strategy');
const atomicPolicy = () => import('nnanything/browser-single-action');
const feedbackPolicy = () => import('nnanything/browser-feedback');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixtures() {
  const atomic = await atomicPolicy();
  const zeroAtomic = atomic.createZeroBrowserSingleActionProfile();
  const relationWeights = zeroAtomic.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  const feedback = await feedbackPolicy();
  const zeroFeedback = feedback.createZeroFeedbackProfile();
  const feedbackWeights = zeroFeedback.weights.map(row => [...row]);
  const feedbackWire = name => zeroFeedback.wires.indexOf(name);
  feedbackWeights[0][feedbackWire("post.currentValid")] = 3;
  feedbackWeights[0][feedbackWire("regionExpanded.known")] = 1;
  feedbackWeights[0][feedbackWire("regionRendered.known")] = 1;
  feedbackWeights[0][feedbackWire("regionExpanded.value")] = -2;
  feedbackWeights[0][feedbackWire("regionRendered.value")] = -1;
  feedbackWeights[1][feedbackWire("dispatch.known")] = 5;
  feedbackWeights[1][feedbackWire("dispatch.value")] = -5;
  feedbackWeights[2][feedbackWire("bias")] = 1;
  return {
    atomicProfile: atomic.validateBrowserSingleActionProfile({ ...zeroAtomic, relationWeights }),
    feedbackProfile: feedback.validateFeedbackProfile({ ...zeroFeedback, weights: feedbackWeights }),
  };
}

async function trainingRequest(epochs) {
  const api = await library();
  return {
    initial: api.createZeroBrowserStrategyProfile(),
    episodes: api.makeStrategySamples(),
    epochs,
    learningRate: 0.1,
  };
}

test('training feedback fixture distinguishes actual three feedback heads and rejects a zero-member conflict', async () => {
  const api = await library();
  const feedback = await feedbackPolicy();
  const models = await fixtures();
  const episodes = api.makeStrategySamples();
  for (const [mode, head] of [['locked-native-positive', 'completed_without_goal'], ['execution-rejected-defer', 'execution_rejected'], ['indeterminate-defer', 'indeterminate']]) {
    const row = episodes.find(row => row.id === `strategy-${mode}-00`);
    assert.equal(feedback.predictFeedback(row.input.history[0].input, models.feedbackProfile).head, head);
  }
  await assert.rejects(api.runBrowserStrategyTraining({
    initial: api.createZeroBrowserStrategyProfile(), episodes, epochs: 0, learningRate: 0.1,
  }, {
    ...models, feedbackProfile: feedback.createZeroFeedbackProfile(),
    handwiredRoot: '/nonexistent/nnanything-backend', outputDirectory: '/nonexistent/nnanything-output',
  }), /conflicting strategy supervision/);
});

test('strategy training rejects verification leakage and family partition leakage before fit', async () => {
  const api = await library();
  const root = await mkdtemp(join(tmpdir(), 'nn-strategy-boundary-'));
  try {
    const models = await fixtures();
    const verification = structuredClone(api.makeStrategySamples());
    const family = verification.find(episode => episode.partition === 'train').family;
    for (const episode of verification.filter(row => row.family === family)) {
      episode.partition = 'verification';
    }
    await assert.rejects(api.runBrowserStrategyTraining({
      initial: api.createZeroBrowserStrategyProfile(),
      episodes: verification,
      epochs: 1,
      learningRate: 0.1,
    }, {
      ...models,
      handwiredRoot: join(root, 'missing'),
      outputDirectory: join(root, 'output'),
    }), /rejects verification episodes/);

    const leakedFamily = structuredClone(api.makeStrategySamples());
    leakedFamily[0].partition = 'development';
    await assert.rejects(api.runBrowserStrategyTraining({
      initial: api.createZeroBrowserStrategyProfile(),
      episodes: leakedFamily,
      epochs: 1,
      learningRate: 0.1,
    }, {
      ...models,
      handwiredRoot: join(root, 'missing'),
      outputDirectory: join(root, 'output'),
    }), /crosses partitions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('strategy training rejects a bad profile and a missing backend without fallback', async () => {
  const api = await library();
  const root = await mkdtemp(join(tmpdir(), 'nn-strategy-profile-'));
  try {
    const models = await fixtures();
    const request = await trainingRequest(1);
    request.initial = {
      ...request.initial,
      weights: request.initial.weights.map((row, index) => index === 0 ? row.slice(1) : row),
    };
    await assert.rejects(api.runBrowserStrategyTraining(request, {
      ...models,
      handwiredRoot: join(root, 'missing'),
      outputDirectory: join(root, 'bad-profile'),
    }), /weights row 0/);

    const valid = await trainingRequest(1);
    await assert.rejects(api.runBrowserStrategyTraining(valid, {
      ...models,
      handwiredRoot: join(root, 'missing-backend'),
      outputDirectory: join(root, 'missing-backend-output'),
    }), /Handwired core is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compare rejects an invalid candidate instead of carrying a usable partition substitute', async () => {
  const api = await library();
  const root = await mkdtemp(join(tmpdir(), 'nn-strategy-candidate-'));
  try {
    const models = await fixtures();
    const request = await trainingRequest(0);
    const nodes = api.createBrowserStrategyTrainingNodes({
      ...models,
      handwiredRoot: join(root, 'missing'),
      outputDirectory: join(root, 'output'),
    });
    const compare = nodes.find(node => node.operator === 'browser.strategy.training.compare');
    assert.ok(compare);
    const candidateProfile = {
      ...request.initial,
      wires: [...request.initial.wires].reverse(),
    };
    assert.throws(() => compare.execute({
      inputs: [
        { payload: { request, partitions: api.partitionStrategyEpisodes(request.episodes) } },
        {
          payload: {
            request,
            fit: {
              profile: candidateProfile,
              trajectory: [],
              timing: {
                backendLoadMs: 0,
                circuitBuildMs: 0,
                fitMs: 0,
                totalMs: 0,
                epochs: 0,
                decisionSets: 0,
                candidateRows: 0,
                gradientCandidateEpochs: 0,
                trainableParamCount: 20,
              },
            },
          },
        },
      ],
      emit: payload => ({ payload }),
    }), /wires/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('zero improvement is not accepted but still writes an unapplied candidate and full report', async () => {
  const api = await library();
  const root = await mkdtemp(join(tmpdir(), 'nn-strategy-report-'));
  try {
    const models = await fixtures();
    const receipt = await api.runBrowserStrategyTraining(await trainingRequest(0), {
      ...models,
      handwiredRoot: join(root, 'not-loaded-for-zero-epochs'),
      outputDirectory: join(root, 'output'),
    });
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.profile.calibration, 'uncalibrated');
    assert.equal(receipt.profile.adoption, 'not_applied');
    assert.equal(receipt.fit.timing.epochs, 0);
    assert.deepEqual(receipt.fit.trajectory, []);
    assert.equal(receipt.comparison.train.trained.passed, receipt.comparison.train.zero.passed);
    assert.equal(receipt.comparison.development.trained.passed, receipt.comparison.development.zero.passed);
    assert.match(receipt.error, /did not improve/);

    const savedProfile = JSON.parse(await readFile(receipt.candidatePath, 'utf8'));
    assert.deepEqual(savedProfile, receipt.profile);
    const report = JSON.parse(await readFile(receipt.reportPath, 'utf8'));
    assert.equal(report.accepted, false);
    assert.deepEqual(report.fit.trajectory, receipt.fit.trajectory);
    assert.deepEqual(report.fit.timing, receipt.fit.timing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public reload and step consumers read explicit files, use a new process, and never fit or execute', async () => {
  const api = await library();
  const root = await mkdtemp(join(tmpdir(), 'nn-strategy-consumer-'));
  try {
    const models = await fixtures();
    const samples = api.makeStrategySamples();
    const development = samples.filter(episode => episode.partition === 'development');
    const atomicPath = join(root, 'atomic.json');
    const feedbackPath = join(root, 'feedback.json');
    const casesPath = join(root, 'development.json');
    const requestPath = join(root, 'step-request.json');
    await writeFile(atomicPath, `${JSON.stringify(models.atomicProfile, null, 2)}\n`);
    await writeFile(feedbackPath, `${JSON.stringify(models.feedbackProfile, null, 2)}\n`);
    await writeFile(casesPath, `${JSON.stringify(development, null, 2)}\n`);
    const first = development[0];
    await writeFile(requestPath, `${JSON.stringify({
      request: first.input.request,
      history: first.input.history,
      registry: first.registry,
      selection: first.selection,
    }, null, 2)}\n`);

    const receipt = await api.runBrowserStrategyTraining(await trainingRequest(0), {
      ...models,
      handwiredRoot: join(root, 'not-loaded-for-zero-epochs'),
      outputDirectory: join(root, 'output'),
    });
    const reload = spawnSync(process.execPath, [
      fileURLToPath(new URL('../playground/browser/strategy/reload.mjs', import.meta.url)),
      '--profile', receipt.candidatePath,
      '--atomic-profile', atomicPath,
      '--feedback-profile', feedbackPath,
      '--cases', casesPath,
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(reload.status, 1, reload.stderr);
    const reloaded = JSON.parse(reload.stdout);
    assert.equal(reloaded.fitted, false);
    assert.notEqual(reloaded.processId, process.pid);
    assert.equal(reloaded.calibration, 'uncalibrated');
    assert.equal(reloaded.adoption, 'not_applied');
    assert.equal(reloaded.count, development.length);
    assert.equal(reloaded.failed, development.length);

    const step = spawnSync(process.execPath, [
      fileURLToPath(new URL('../playground/browser/strategy/step.mjs', import.meta.url)),
      '--profile', receipt.candidatePath,
      '--atomic-profile', atomicPath,
      '--feedback-profile', feedbackPath,
      '--request', requestPath,
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(step.status, 0, step.stderr);
    const stepped = JSON.parse(step.stdout);
    assert.equal(stepped.executed, false);
    assert.equal(stepped.prediction.kind, 'DEFER');
    assert.equal(stepped.calibration, 'uncalibrated');
    assert.equal(stepped.adoption, 'not_applied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
