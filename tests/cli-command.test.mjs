import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('shared command profile expands named weights without reinterpreting old rows', async () => {
  const api = await import('nnanything/cli-goal');
  const pwd = api.zeroCliCommandProfile(['pwd']);
  const initial = api.validateCliCommandProfile({ ...pwd, weights: [[1, 2], [3, 4]] });
  const extended = api.expandCliCommandProfile(initial, ['pwd', 'cd', 'ls']);
  assert.deepEqual(extended.heads, ['unsupported', 'pwd', 'cd', 'ls']);
  assert.deepEqual(extended.weights, [[1, 2, 0, 0], [3, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(api.predictCliCommand({ kind: 'observe_cwd', session: 's' }, extended).selectedHead, 'pwd');
  assert.equal(api.predictCliCommand({ kind: 'observe_cwd', session: 's' }, api.zeroCliCommandProfile(['pwd'])).selectedHead, 'unsupported');
  assert.throws(() => api.expandCliCommandProfile(extended, ['pwd']));
});

test('one profile emits shell heads with typed positional parameters and real effects', async () => {
  const api = await import('nnanything/cli-goal');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-shared-command-')));
  let sandbox;
  try {
    sandbox = await api.createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'shared-command-contract', entries: [
        { path: 'start', kind: 'directory' }, { path: 'target with space', kind: 'directory' },
        { path: 'target with space/.hidden', kind: 'file', contents: 'opaque' },
      ], sessions: [{ id: 's', cwd: 'start', grantedEffects: ['filesystem.read', 'process.exec', 'session.write'] }],
    } });
    const session = sandbox.bindSession('s');
    const profile = api.validateCliCommandProfile({ ...api.zeroCliCommandProfile(['pwd', 'cd', 'ls']),
      weights: [[1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]] });
    const policy = api.createCliCommandPolicy({ profile, sandbox, session });
    const state = { session: 's', cwdObservation: null, directoryListing: null };
    const pwd = await policy.step({ goal: { kind: 'observe_cwd', session: 's' }, state });
    assert.deepEqual(pwd.invocation, ['pwd']);
    assert.equal(pwd.goal_result.status, 'achieved');
    assert.equal(pwd.goal_result.satisfaction, 100);
    const directory = await sandbox.bindDirectory(session, '../target with space');
    const target = join(sandbox.scenarioRoot, 'target with space');
    const cd = await policy.step({ goal: { kind: 'set_cwd', session: 's', target }, state, directory });
    assert.deepEqual(cd.invocation, ['cd', directory]);
    assert.equal(cd.goal_result.status, 'achieved');
    assert.equal(cd.goal_result.satisfaction, 100);
    assert.equal(cd.postcondition.receipt.execution.observation.physicalCwd, target);
    const rebound = await sandbox.bindDirectory(session, '.');
    const ls = await policy.step({ goal: { kind: 'list_directory', session: 's', target }, state, directory: rebound });
    assert.deepEqual(ls.invocation, ['ls', rebound]);
    assert.equal(ls.goal_result.status, 'achieved');
    assert.equal(ls.goal_result.satisfaction, 100);
    assert.deepEqual(ls.observed_state_after.directoryListing.entries.map(({ name, type }) => ({ name, type })), [{ name: '.hidden', type: 'file' }]);
    const unsupported = await policy.step({ goal: { kind: 'unknown_goal', session: 's' }, state });
    assert.equal(unsupported.invocation, null);
    assert.equal(unsupported.execution_result.status, 'unsupported');
    assert.equal(unsupported.execution_result.executorInvoked, false);
    assert.equal(unsupported.policy_error, null);
    assert.equal(unsupported.goal_result.status, 'unverified');
    assert.equal(unsupported.goal_result.satisfaction, null);
    const wrong = api.createCliCommandPolicy({ profile: { ...profile, weights: [[0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0]] }, sandbox, session });
    const blocked = await wrong.step({ goal: { kind: 'observe_cwd', session: 's' }, state });
    assert.equal(blocked.policy.selectedHead, 'cd');
    assert.ok(blocked.policy_error);
    assert.equal(blocked.execution_result.executorInvoked, false);
    assert.equal(blocked.goal_result.status, 'unmet');
    assert.equal(blocked.goal_result.satisfaction, 0);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('fixed command goal uses fresh execution and 100/0/null evidence boundaries', async () => {
  const api = await import('nnanything/cli-goal');
  assert.deepEqual(api.CLI_COMMAND_GOAL_CONFIG, { satisfactionThreshold: 100 });
  assert.ok(Object.isFrozen(api.CLI_COMMAND_GOAL_CONFIG));
  const profile = api.validateCliCommandProfile({ ...api.zeroCliCommandProfile(['pwd', 'cd', 'ls']),
    weights: [[1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]] });
  const state = { session: 's', cwdObservation: null, directoryListing: null };

  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-command-success-')));
  let sandbox;
  try {
    sandbox = await api.createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'command-success', entries: [
        { path: 'start', kind: 'directory' },
        { path: 'target', kind: 'directory' },
        { path: 'target/item', kind: 'file', contents: 'opaque' },
      ], sessions: [{ id: 's', cwd: 'start', grantedEffects: ['filesystem.read', 'process.exec', 'session.write'] }],
    } });
    const session = sandbox.bindSession('s'), target = join(sandbox.scenarioRoot, 'target');
    let directory = await sandbox.bindDirectory(session, '../target');
    const policy = api.createCliCommandPolicy({ profile, sandbox, session });
    const pwd = await policy.step({ goal: { kind: 'observe_cwd', session: 's' }, state });
    assert.deepEqual([pwd.goal_result.status, pwd.goal_result.satisfaction], ['achieved', 100]);
    const cd = await policy.step({ goal: { kind: 'set_cwd', session: 's', target }, state, directory });
    assert.deepEqual([cd.goal_result.status, cd.goal_result.satisfaction], ['achieved', 100]);
    const beforeSame = sandbox.getSession(session);
    directory = await sandbox.bindDirectory(session, '.');
    const sameTarget = await policy.step({ goal: { kind: 'set_cwd', session: 's', target }, state: cd.observed_state_after, directory });
    assert.deepEqual(sameTarget.invocation, ['cd', directory]);
    assert.equal(sameTarget.session_after.revision, beforeSame.revision + 1);
    assert.deepEqual([sameTarget.goal_result.status, sameTarget.goal_result.satisfaction], ['achieved', 100]);
    const ls = await policy.step({ goal: { kind: 'list_directory', session: 's', target }, state: sameTarget.observed_state_after, directory });
    assert.deepEqual([ls.goal_result.status, ls.goal_result.satisfaction], ['achieved', 100]);
    const unsupported = await policy.step({ goal: { kind: 'unknown_goal', session: 's' }, state });
    assert.deepEqual([unsupported.goal_result.status, unsupported.goal_result.satisfaction], ['unverified', null]);
    assert.equal(unsupported.execution_result.executorInvoked, false);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }

  const failedRoot = await realpath(await mkdtemp(join(tmpdir(), 'nn-command-failed-')));
  let failedSandbox;
  try {
    failedSandbox = await api.createCliFilesystemSandbox({ root: failedRoot, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'command-failed', entries: [{ path: 'start', kind: 'directory' }],
      sessions: [{ id: 's', cwd: 'start', grantedEffects: ['filesystem.read'] }],
    } });
    const session = failedSandbox.bindSession('s');
    const transition = await api.createCliCommandPolicy({ profile, sandbox: failedSandbox, session })
      .step({ goal: { kind: 'observe_cwd', session: 's' }, state: { session: 's', cwdObservation: null, directoryListing: null } });
    assert.equal(transition.execution_result.receipt.status, 'failed');
    assert.deepEqual([transition.goal_result.status, transition.goal_result.satisfaction], ['unmet', 0]);
  } finally { if (failedSandbox) await failedSandbox.cleanup(); await rm(failedRoot, { recursive: true, force: true }); }
});

test('CD unknown postcondition and LS partial evidence stay null while proven mismatch is zero', async () => {
  const api = await import('nnanything/cli-goal');
  const profile = api.validateCliCommandProfile({ ...api.zeroCliCommandProfile(['pwd', 'cd', 'ls']),
    weights: [[1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]] });
  const state = { session: 's', cwdObservation: null, directoryListing: null };
  const recipe = entries => ({ scenarioId: `command-${entries.length}`, entries, sessions: [
    { id: 's', cwd: 'start', grantedEffects: ['filesystem.read', 'process.exec', 'session.write'] },
  ] });

  const unknownRoot = await realpath(await mkdtemp(join(tmpdir(), 'nn-command-unknown-')));
  let unknownSandbox;
  try {
    unknownSandbox = await api.createCliFilesystemSandbox({ root: unknownRoot, ownerGrantedEffects: ['filesystem.write'],
      observation: async () => ({ ok: false, error: { operation: 'pwd', stage: 'observe', code: 'INJECTED_OBSERVATION', message: 'controlled postcommit failure' } }),
      recipe: recipe([{ path: 'start', kind: 'directory' }, { path: 'target', kind: 'directory' }]),
    });
    const session = unknownSandbox.bindSession('s'), before = unknownSandbox.getSession(session);
    const target = join(unknownSandbox.scenarioRoot, 'target'), directory = await unknownSandbox.bindDirectory(session, '../target');
    const transition = await api.createCliCommandPolicy({ profile, sandbox: unknownSandbox, session })
      .step({ goal: { kind: 'set_cwd', session: 's', target }, state, directory });
    assert.deepEqual([transition.goal_result.status, transition.goal_result.satisfaction], ['unverified', null]);
    assert.equal(transition.goal_result.reason, 'postcommit_observation_failed');
    assert.equal(transition.goal_result.changed, true);
    assert.equal(transition.session_after.revision, before.revision + 1);
    assert.equal(transition.postcondition.receipt.execution.status, 'failed');
  } finally { if (unknownSandbox) await unknownSandbox.cleanup(); await rm(unknownRoot, { recursive: true, force: true }); }

  const mismatchRoot = await realpath(await mkdtemp(join(tmpdir(), 'nn-command-mismatch-')));
  let mismatchSandbox;
  try {
    mismatchSandbox = await api.createCliFilesystemSandbox({ root: mismatchRoot, ownerGrantedEffects: ['filesystem.write'],
      observation: async ({ cwd }) => {
        const physicalCwd = join(cwd, 'different');
        return { ok: true, observation: { kind: 'pwd', configuredCwd: cwd, physicalCwd, executable: '/bin/pwd',
          argv: ['-P'], stdout: `${physicalCwd}\n`, stderr: '', exitCode: 0 } };
      },
      recipe: recipe([{ path: 'start', kind: 'directory' }, { path: 'target', kind: 'directory' }]),
    });
    const session = mismatchSandbox.bindSession('s'), before = mismatchSandbox.getSession(session);
    const target = join(mismatchSandbox.scenarioRoot, 'target'), directory = await mismatchSandbox.bindDirectory(session, '../target');
    const transition = await api.createCliCommandPolicy({ profile, sandbox: mismatchSandbox, session })
      .step({ goal: { kind: 'set_cwd', session: 's', target }, state, directory });
    assert.deepEqual([transition.goal_result.status, transition.goal_result.satisfaction], ['unmet', 0]);
    assert.equal(transition.goal_result.reason, 'postcommit_target_mismatch');
    assert.equal(transition.goal_result.changed, true);
    assert.equal(transition.postcondition.matchedTarget, false);
    assert.equal(transition.session_after.revision, before.revision + 1);
  } finally { if (mismatchSandbox) await mismatchSandbox.cleanup(); await rm(mismatchRoot, { recursive: true, force: true }); }

  const partialRoot = await realpath(await mkdtemp(join(tmpdir(), 'nn-command-partial-')));
  let partialSandbox;
  try {
    partialSandbox = await api.createCliFilesystemSandbox({ root: partialRoot, ownerGrantedEffects: ['filesystem.write'],
      listingObserver: async input => {
        const result = await api.runDirectoryListHelper(input);
        if (!result.ok) return result;
        const first = result.observation.entries[0];
        return { ok: true, observation: { ...result.observation, coverage: 'partial',
          entries: [{ ...first, type: 'unknown' }, ...result.observation.entries.slice(1)],
          errors: [{ name: first.name, code: 'INJECTED_UNKNOWN', message: 'controlled unknown type' }] } };
      },
      recipe: recipe([{ path: 'start', kind: 'directory' }, { path: 'target', kind: 'directory' },
        { path: 'target/item', kind: 'file', contents: 'opaque' }]),
    });
    const session = partialSandbox.bindSession('s'), target = join(partialSandbox.scenarioRoot, 'target');
    const directory = await partialSandbox.bindDirectory(session, '../target');
    const transition = await api.createCliCommandPolicy({ profile, sandbox: partialSandbox, session })
      .step({ goal: { kind: 'list_directory', session: 's', target }, state, directory });
    assert.deepEqual([transition.goal_result.status, transition.goal_result.satisfaction], ['unverified', null]);
    assert.equal(transition.goal_result.reason, 'partial_coverage');
    assert.equal(transition.execution_result.receipt.execution.observation.coverage, 'partial');
    assert.equal(transition.execution_result.receipt.execution.observation.entries[0].type, 'unknown');
    assert.deepEqual(transition.observed_state_after, state);
  } finally { if (partialSandbox) await partialSandbox.cleanup(); await rm(partialRoot, { recursive: true, force: true }); }
});
