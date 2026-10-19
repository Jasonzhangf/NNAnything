import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import {
  createCliGoalPolicy,
  makeCliGoalFixture,
  prepareCliGoalDataset,
  runCliGoalTraining,
} from 'nnanything/cli-goal';

const args = process.argv.slice(2), values = new Map();
const allowed = ['--handwired-root', '--output-root', '--samples', '--epochs', '--learning-rate'];
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!allowed.includes(flag) || value === undefined || values.has(flag)) {
    throw new Error('Usage: train.mjs --handwired-root PATH [--output-root PATH] [--samples FILE] [--epochs N] [--learning-rate N]');
  }
  values.set(flag, value);
}
if (!values.has('--handwired-root')) throw new Error('--handwired-root is required; no implicit or copied backend');

const started = performance.now();
try {
  const dataset = values.has('--samples')
    ? JSON.parse(await readFile(values.get('--samples'), 'utf8'))
    : makeCliGoalFixture({ cwd: process.cwd() });
  const prepared = prepareCliGoalDataset(dataset);
  const outputRoot = values.get('--output-root') ?? fileURLToPath(new URL('../../../training/', import.meta.url));
  const receipt = await runCliGoalTraining(
    { dataset, epochs: Number(values.get('--epochs') ?? 200), learningRate: Number(values.get('--learning-rate') ?? 0.1) },
    { handwiredRoot: values.get('--handwired-root'), outputRoot, grantedEffects: ['filesystem.read', 'filesystem.write'] },
  );
  const trainingWorkflowMs = performance.now() - started;
  const reloadStarted = performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./reload.mjs', import.meta.url)),
    receipt.paths.profile,
    receipt.paths.samples,
  ], { shell: false, maxBuffer: 16 * 1024 * 1024 });
  const reloaded = JSON.parse(stdout), reloadMs = performance.now() - reloadStarted;
  const actualRows = [...receipt.comparison.train.trained.rows, ...receipt.comparison.development.trained.rows];
  assert.deepEqual(reloaded.rows, actualRows, 'Fresh-process scores, actions and observations must match saved candidate');
  assert.equal(reloaded.sampleCount, prepared.dataset.samples.length);

  const profile = JSON.parse(await readFile(receipt.paths.profile, 'utf8'));
  const missing = await createCliGoalPolicy({
    profile,
    session: { id: 'fresh-failure', cwd: join(process.cwd(), 'missing-goal-cwd'), grantedEffects: ['filesystem.read', 'process.exec'] },
  }).step({
    goal: { kind: 'observe_cwd', session: 'fresh-failure' },
    state: { session: 'fresh-failure', cwdObservation: null },
  });
  assert.equal(missing.goal_result.status, 'unmet');
  assert.equal(missing.execution_result.status, 'failed');

  const partitions = Object.fromEntries(Object.entries(receipt.comparison).map(([name, value]) => [name, {
    samples: value.trained.sampleCount,
    uniqueFeatureVectors: value.trained.uniqueFeatureVectors,
    zeroCorrectActions: value.zero.correctActions,
    frozenCorrectActions: value.frozen.correctActions,
    trainedCorrectActions: value.trained.correctActions,
    trainedPolicyAccuracy: value.trained.policyAccuracy,
    achievedGoals: value.trained.achievedGoals,
    expectedAchievedGoals: value.trained.expectedAchievedGoals,
    executionCount: value.trained.executionCount,
    guardRejections: value.trained.guardRejections,
    policyErrorCount: value.trained.policyErrorCount,
    fixed: value.fixed,
    regressed: value.regressed,
    retained: value.retained,
    unresolved: value.unresolved,
  }]));
  const summary = {
    status: receipt.accepted ? 'passed' : 'learning_incomplete',
    paths: receipt.paths,
    partitions,
    counts: {
      train: prepared.train.length,
      development: prepared.development.length,
      fitRows: prepared.rows.length,
      uniqueFeatureVectors: new Set(prepared.rows.map(row => JSON.stringify(row.features))).size,
    },
    timing: {
      ...receipt.timing,
      evaluationMs: receipt.evaluationMs,
      saveMs: receipt.saveMs,
      workflowMs: receipt.workflowMs,
      trainingWorkflowMs,
      reloadMs,
      totalConsumerMs: performance.now() - started,
    },
    gradientRowsPerSecond: receipt.timing.trainEpochGradMs > 0
      ? receipt.timing.gradientRowEpochs / (receipt.timing.trainEpochGradMs / 1000)
      : null,
    freshProcessReloadIdentical: true,
    freshFailureExplicit: true,
    calibration: 'uncalibrated',
    adoption: 'not_applied',
    limits: ['three semantic vectors only', 'no holdout in training', 'observe_cwd to pwd only', 'no cd, NLP, help or search'],
  };
  const summaryPath = receipt.paths.report.replace(/report\.json$/, 'consumer-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  if (!receipt.accepted) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    message: error.message,
    partialReceipt: error.partialReceipt ?? null,
    timing: error.timing ?? null,
    consumerMs: performance.now() - started,
  }, null, 2));
  process.exitCode = 1;
} finally {}
