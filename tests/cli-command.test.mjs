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
    const directory = await sandbox.bindDirectory(session, '../target with space');
    const target = join(sandbox.scenarioRoot, 'target with space');
    const cd = await policy.step({ goal: { kind: 'set_cwd', session: 's', target }, state, directory });
    assert.deepEqual(cd.invocation, ['cd', directory]);
    assert.equal(cd.goal_result.status, 'achieved');
    assert.equal(cd.postcondition.receipt.execution.observation.physicalCwd, target);
    const rebound = await sandbox.bindDirectory(session, '.');
    const ls = await policy.step({ goal: { kind: 'list_directory', session: 's', target }, state, directory: rebound });
    assert.deepEqual(ls.invocation, ['ls', rebound]);
    assert.equal(ls.goal_result.status, 'achieved');
    assert.deepEqual(ls.observed_state_after.directoryListing.entries.map(({ name, type }) => ({ name, type })), [{ name: '.hidden', type: 'file' }]);
    const unsupported = await policy.step({ goal: { kind: 'unknown_goal', session: 's' }, state });
    assert.equal(unsupported.invocation, null);
    assert.equal(unsupported.execution_result.status, 'unsupported');
    assert.equal(unsupported.execution_result.executorInvoked, false);
    assert.equal(unsupported.policy_error, null);
    const wrong = api.createCliCommandPolicy({ profile: { ...profile, weights: [[0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0]] }, sandbox, session });
    const blocked = await wrong.step({ goal: { kind: 'observe_cwd', session: 's' }, state });
    assert.equal(blocked.policy.selectedHead, 'cd');
    assert.ok(blocked.policy_error);
    assert.equal(blocked.execution_result.executorInvoked, false);
    assert.equal(blocked.goal_result.status, 'unmet');
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});
