import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const backend = '/Volumes/extension/code/handwired';
const api = () => import('../dist/cli-goal.js');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnanything-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function prior(cwd, marker = 'prior') {
  return {
    physicalCwd: cwd,
    evidence: {
      kind: 'pwd',
      configuredCwd: cwd,
      physicalCwd: cwd,
      executable: '/bin/pwd',
      argv: ['-P'],
      stdout: `${cwd}\n`,
      stderr: '',
      exitCode: 0,
    },
    sourceRun: `${marker}-run`,
  };
}

function observeOnlyProfile() {
  return {
    contract: 'cli.goal-policy.v1',
    actions: ['REJECT', 'PWD'],
    wires: ['bias', 'goalObserveCwd', 'goalSetCwd'],
    weights: [[0, 0, 0], [0, 1, 0]],
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
}

test('zero profile has six parameters, ordered actions, three semantic vectors and REJECT tie', async () => {
  const { CLI_GOAL_ACTIONS, CLI_GOAL_WIRES, zeroCliGoalProfile, scoreCliGoalActions, validateCliGoalProfile } = await api();
  assert.deepEqual(CLI_GOAL_ACTIONS, ['REJECT', 'PWD']);
  assert.deepEqual(CLI_GOAL_WIRES, ['bias', 'goalObserveCwd', 'goalSetCwd']);
  const zero = zeroCliGoalProfile();
  assert.deepEqual(validateCliGoalProfile(zero), zero);
  assert.equal(zero.weights.flat().length, 6);
  for (const features of [[1, 1, 0], [1, 0, 1], [1, 0, 0]]) {
    const scores = scoreCliGoalActions(features, zero);
    assert.deepEqual(scores, [0, 0]);
    assert.equal(CLI_GOAL_ACTIONS[scores.indexOf(Math.max(...scores))], 'REJECT');
  }
});

test('fresh observe_cwd executes real pwd, binds exact evidence and leaves parent state unchanged', async t => {
  const { createCliGoalPolicy } = await api();
  const root = await fixture(t);
  const cwd = join(root, '目录 with space');
  await mkdir(cwd);
  const session = { id: 'observe-a', cwd, grantedEffects: ['filesystem.read', 'process.exec'] };
  const before = prior(cwd, 'old');
  const state = { session: session.id, cwdObservation: before };
  const policy = createCliGoalPolicy({ profile: observeOnlyProfile(), session });
  const parentCwd = process.cwd();
  const transition = await policy.step({ goal: { kind: 'observe_cwd', session: session.id }, state });
  assert.equal(transition.policy.selectedAction, 'PWD');
  assert.deepEqual(transition.policy.features, [1, 1, 0]);
  assert.deepEqual(transition.action, { kind: 'PWD', session: session.id });
  assert.equal(transition.execution_result.status, 'succeeded');
  assert.equal(transition.execution_result.executorInvoked, true);
  assert.equal(transition.execution_result.observation.physicalCwd, await realpath(cwd));
  assert.equal(transition.observed_state_after.cwdObservation.physicalCwd, await realpath(cwd));
  assert.equal(transition.observed_state_after.cwdObservation.sourceRun, transition.execution_result.runId);
  assert.deepEqual(transition.observed_state_after.cwdObservation.evidence, transition.execution_result.observation);
  assert.equal(transition.goal_result.status, 'achieved');
  assert.equal(transition.policy_error, null);
  assert.deepEqual(transition.state_before, state);
  assert.equal(process.cwd(), parentCwd);
});

test('set_cwd and other goals reject without invoking executor or changing prior knowledge', async t => {
  const { createCliGoalPolicy } = await api();
  const root = await fixture(t);
  const missing = join(root, 'not-created');
  const session = { id: 'contrast-a', cwd: missing, grantedEffects: [] };
  const state = { session: session.id, cwdObservation: prior('/known/prior') };
  const policy = createCliGoalPolicy({ profile: observeOnlyProfile(), session });
  for (const goal of [
    { kind: 'set_cwd', session: session.id, target: root },
    { kind: 'list_directory', session: session.id, path: root },
  ]) {
    const transition = await policy.step({ goal, state });
    assert.equal(transition.policy.selectedAction, 'REJECT');
    assert.deepEqual(transition.action, { kind: 'REJECT' });
    assert.equal(transition.execution_result.status, 'rejected');
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(transition.goal_result.status, 'unmet');
    assert.deepEqual(transition.observed_state_after, state);
  }
});

test('bad profile cannot bypass unsupported guard; wrong choice stays a visible policy error', async t => {
  const { createCliGoalPolicy, zeroCliGoalProfile } = await api();
  const root = await fixture(t);
  const missing = join(root, 'not-created');
  const profile = structuredClone(zeroCliGoalProfile());
  profile.weights[1] = [1, 1, 1];
  const session = { id: 'bad-profile', cwd: missing, grantedEffects: [] };
  const state = { session: session.id, cwdObservation: null };
  const transition = await createCliGoalPolicy({ profile, session }).step({
    goal: { kind: 'set_cwd', session: session.id, target: root },
    state,
  });
  assert.equal(transition.policy.selectedAction, 'PWD');
  assert.deepEqual(transition.action, { kind: 'PWD', session: session.id });
  assert.equal(transition.execution_result.status, 'rejected');
  assert.equal(transition.execution_result.executorInvoked, false);
  assert.equal(transition.execution_result.reason, 'unsupported_goal');
  assert.deepEqual(transition.policy_error, {
    code: 'UNEXPECTED_ACTION',
    expectedAction: 'REJECT',
    selectedAction: 'PWD',
  });
  assert.equal(transition.goal_result.status, 'unmet');
  assert.deepEqual(transition.observed_state_after, state);
});

test('grant and native execution failures preserve prior knowledge and never achieve the goal', async t => {
  const { createCliGoalPolicy } = await api();
  const root = await fixture(t);
  const cwd = join(root, 'real-cwd');
  await mkdir(cwd);
  const priorState = prior('/known/prior', 'stale');
  const cases = [
    { id: 'no-grants', cwd, grantedEffects: [], code: 'EFFECT_DENIED' },
    { id: 'missing-cwd', cwd: join(root, 'missing'), grantedEffects: ['filesystem.read', 'process.exec'], code: 'ENOENT' },
  ];
  for (const current of cases) {
    const state = { session: current.id, cwdObservation: priorState };
    const session = { id: current.id, cwd: current.cwd, grantedEffects: current.grantedEffects };
    const transition = await createCliGoalPolicy({ profile: observeOnlyProfile(), session }).step({
      goal: { kind: 'observe_cwd', session: session.id },
      state,
    });
    assert.equal(transition.execution_result.status, 'failed');
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(transition.execution_result.error.code, current.code);
    assert.equal(transition.goal_result.status, 'unmet');
    assert.equal(transition.goal_result.reason, 'execution_failed');
    assert.deepEqual(transition.observed_state_after, state);
  }
});

test('session mismatch is an explicit validation failure before execution', async t => {
  const { createCliGoalPolicy } = await api();
  const root = await fixture(t);
  const session = { id: 'bound-session', cwd: root, grantedEffects: ['filesystem.read', 'process.exec'] };
  const policy = createCliGoalPolicy({ profile: observeOnlyProfile(), session });
  await assert.rejects(policy.step({
    goal: { kind: 'observe_cwd', session: 'different-session' },
    state: { session: 'bound-session', cwdObservation: null },
  }), /session/i);
  await assert.rejects(policy.step({
    goal: { kind: 'observe_cwd', session: 'bound-session' },
    state: { session: 'different-session', cwdObservation: null },
  }), /session/i);
});

test('every step executes fresh pwd and binds physical cwd per session without cross-session state', async t => {
  const { createCliGoalPolicy } = await api();
  const root = await fixture(t);
  const target = join(root, 'physical-target');
  const link = join(root, 'session-link');
  await mkdir(target);
  await symlink(target, link);
  const grants = ['filesystem.read', 'process.exec'];
  const firstSession = { id: 'first', cwd: link, grantedEffects: grants };
  const secondSession = { id: 'second', cwd: root, grantedEffects: grants };
  const firstPolicy = createCliGoalPolicy({ profile: observeOnlyProfile(), session: firstSession });
  const secondPolicy = createCliGoalPolicy({ profile: observeOnlyProfile(), session: secondSession });
  const firstState = { session: 'first', cwdObservation: prior('/stale/first', 'stale') };
  const a = await firstPolicy.step({ goal: { kind: 'observe_cwd', session: 'first' }, state: firstState });
  const b = await firstPolicy.step({ goal: { kind: 'observe_cwd', session: 'first' }, state: firstState });
  const c = await secondPolicy.step({ goal: { kind: 'observe_cwd', session: 'second' }, state: { session: 'second', cwdObservation: null } });
  assert.equal(a.execution_result.status, 'succeeded');
  assert.equal(b.execution_result.status, 'succeeded');
  assert.notEqual(a.execution_result.runId, b.execution_result.runId);
  assert.equal(a.observed_state_after.cwdObservation.physicalCwd, await realpath(target));
  assert.equal(b.observed_state_after.cwdObservation.physicalCwd, await realpath(target));
  assert.equal(a.observed_state_after.cwdObservation.evidence.configuredCwd, link);
  assert.equal(c.observed_state_after.session, 'second');
  assert.equal(c.observed_state_after.cwdObservation.physicalCwd, await realpath(root));
  assert.equal(firstState.cwdObservation.physicalCwd, '/stale/first');
});

test('fixture has exact balanced counts, three vectors and no heldout or semantic leakage from names', async t => {
  const { makeCliGoalFixture, prepareCliGoalDataset } = await api();
  const root = await fixture(t);
  const dataset = makeCliGoalFixture({ cwd: root });
  const prepared = prepareCliGoalDataset(dataset);
  assert.equal(dataset.version, 1);
  assert.deepEqual([prepared.train.length, prepared.development.length], [12, 6]);
  assert.equal(prepared.train.filter(row => row.goal.kind === 'observe_cwd').length, 4);
  assert.equal(prepared.train.filter(row => row.goal.kind === 'set_cwd').length, 4);
  assert.equal(prepared.train.filter(row => row.goal.kind === 'other').length, 4);
  assert.equal(new Set(prepared.dataset.samples.map(row => row.session.id)).size, 18);
  assert.equal(new Set(prepared.rows.map(row => JSON.stringify(row.features))).size, 3);
  assert.equal(prepared.dataset.samples.some(row => row.partition === 'holdout'), false);
  for (const row of prepared.train) {
    assert.equal(row.goal.session, row.state.session);
    assert.equal(row.session.id, row.state.session);
  }
});

test('real Handwired fit changes six parameters, frozen control does not move and missing backend retains timing', async () => {
  const { fitCliGoalPolicy, makeCliGoalFixture, prepareCliGoalDataset, zeroCliGoalProfile } = await api();
  const prepared = prepareCliGoalDataset(makeCliGoalFixture({ cwd: process.cwd() }));
  const initial = zeroCliGoalProfile();
  const fit = await fitCliGoalPolicy({ rows: prepared.rows, initial, handwiredRoot: backend, epochs: 200, learningRate: 0.1 });
  assert.notDeepEqual(fit.profile.weights, initial.weights);
  assert.equal(fit.timing.completedEpochs, 200);
  assert.equal(fit.timing.processedRowCount, 12);
  assert.equal(fit.timing.gradientRowEpochs, 2400);
  assert.equal(fit.timing.trainableParamCount, 6);
  const frozen = await fitCliGoalPolicy({ rows: prepared.rows, initial, handwiredRoot: backend, epochs: 0, learningRate: 0.1 });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  await assert.rejects(fitCliGoalPolicy({
    rows: prepared.rows,
    initial,
    handwiredRoot: '/definitely/missing/handwired',
    epochs: 1,
    learningRate: 0.1,
  }), error => {
    assert.match(error.message, /missing/i);
    assert.equal(error.timing.completedEpochs, 0);
    assert.ok(error.timing.fitTotalMs >= 0);
    return true;
  });
});

test('public training saves a reloadable candidate/report and reports action accuracy separately from goal success', async t => {
  const { makeCliGoalFixture, prepareCliGoalDataset, runCliGoalTraining } = await api();
  const root = await fixture(t);
  const outputRoot = join(root, 'training');
  await mkdir(outputRoot);
  const dataset = makeCliGoalFixture({ cwd: root });
  const prepared = prepareCliGoalDataset(dataset);
  const receipt = await runCliGoalTraining(
    { dataset, epochs: 200, learningRate: 0.1 },
    { handwiredRoot: backend, outputRoot, grantedEffects: ['filesystem.read', 'filesystem.write'] },
  );
  assert.equal(receipt.accepted, true);
  for (const partition of ['train', 'development']) {
    const comparison = receipt.comparison[partition];
    assert.equal(comparison.zero.correctActions, prepared[partition].filter(row => row.expectedAction === 'REJECT').length);
    assert.equal(comparison.zero.executionCount, 0);
    assert.equal(comparison.frozen.executionCount, 0);
    assert.equal(comparison.trained.correctActions, prepared[partition].length);
    assert.equal(comparison.trained.policyAccuracy, 1);
    assert.equal(comparison.trained.achievedGoals, comparison.trained.expectedAchievedGoals);
    assert.equal(comparison.trained.executionCount, prepared[partition].filter(row => row.expectedAction === 'PWD').length);
    assert.equal(comparison.trained.uniqueFeatureVectors, 3);
    assert.equal(comparison.regressed, 0);
  }
  const profile = JSON.parse(await readFile(receipt.paths.profile, 'utf8'));
  assert.equal(profile.contract, 'cli.goal-policy.v1');
  assert.equal(profile.weights.flat().length, 6);
  assert.equal(profile.calibration, 'uncalibrated');
  assert.equal(profile.adoption, 'not_applied');
  const report = JSON.parse(await readFile(receipt.paths.report, 'utf8'));
  assert.equal(report.frozen.parametersUnchanged, true);
  assert.equal(report.limits.includes('only three semantic feature vectors'), true);

  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../playground/cli/observe-cwd/reload.mjs', import.meta.url)),
    receipt.paths.profile,
    receipt.paths.samples,
  ], { shell: false, maxBuffer: 16 * 1024 * 1024 });
  const reload = JSON.parse(stdout);
  assert.equal(reload.sampleCount, 18);
  assert.deepEqual(reload.rows, [
    ...receipt.comparison.train.trained.rows,
    ...receipt.comparison.development.trained.rows,
  ]);
});

test('training requires explicit storage grants before fitting or writing', async t => {
  const { makeCliGoalFixture, runCliGoalTraining } = await api();
  const root = await fixture(t), outputRoot = join(root, 'training');
  await mkdir(outputRoot);
  await assert.rejects(runCliGoalTraining(
    { dataset: makeCliGoalFixture({ cwd: root }), epochs: 1, learningRate: 0.1 },
    { handwiredRoot: backend, outputRoot, grantedEffects: ['filesystem.read'] },
  ), /Unauthorized effect/);
  assert.deepEqual(await readdir(outputRoot), []);
});
