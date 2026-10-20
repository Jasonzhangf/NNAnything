import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function forceHead(profile, head) {
  const index = profile.heads.indexOf(head);
  assert.notEqual(index, -1);
  return { ...profile, weights: profile.weights.map((row, rowIndex) => row.map((weight, columnIndex) =>
    rowIndex === index && columnIndex === 0 ? 1 : weight)) };
}

test('CD rejects a directory reference owned by a different session before process execution', async () => {
  const { createCliFilesystemSandbox } = await import('nnanything/cli-goal');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-directory-binding-')));
  let sandbox;
  try {
    const grants = ['filesystem.read', 'process.exec', 'session.write'];
    sandbox = await createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'directory-session-identity', entries: [{ path: 'a', kind: 'directory' }, { path: 'b', kind: 'directory' }],
      sessions: [{ id: 'one', cwd: 'a', grantedEffects: grants }, { id: 'two', cwd: 'b', grantedEffects: grants }],
    } });
    const one = sandbox.bindSession('one'), two = sandbox.bindSession('two');
    const before = sandbox.getSession(one), otherBefore = sandbox.getSession(two);
    const directory = await sandbox.bindDirectory(two, '.');
    let receipt, rejection;
    try { receipt = await sandbox.execute({ operation: 'cwd.set', parameters: { session: one, directory } }); }
    catch (error) { rejection = error; }
    if (rejection) assert.ok(rejection instanceof TypeError);
    else {
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.execution.executorInvoked, false, 'mismatched references must be refused before launching zsh');
    }
    assert.deepEqual(sandbox.getSession(one), before);
    assert.deepEqual(sandbox.getSession(two), otherBefore);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('LIST receipt records the complete native argv and refuses a cross-session Goal target', async () => {
  const api = await import('nnanything/cli-goal');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-list-call-boundary-')));
  let sandbox;
  try {
    sandbox = await api.createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'native-list-call', entries: [{ path: 'one', kind: 'directory' }, { path: 'two', kind: 'directory' }],
      sessions: [
        { id: 's', cwd: 'one', grantedEffects: ['filesystem.read', 'process.exec'] },
        { id: 'other', cwd: 'two', grantedEffects: ['filesystem.read', 'process.exec'] },
      ],
    } });
    const session = sandbox.bindSession('s'), directory = await sandbox.bindDirectory(session, '.');
    const before = sandbox.getSession(session);
    const receipt = await sandbox.execute({ operation: 'directory.list', parameters: { session, directory } });
    assert.equal(receipt.status, 'succeeded');
    const observation = receipt.execution.observation;
    assert.equal(observation.executable, process.execPath);
    assert.deepEqual(observation.argv, [api.directoryListHelperPath(), before.cwd]);
    assert.deepEqual(observation.entries, []);
    assert.equal(observation.coverage, 'complete');
    const profile = forceHead(api.zeroCliCommandProfile(), 'ls');
    const policy = api.createCliCommandPolicy({ profile, sandbox, session });
    const foreign = sandbox.bindSession('other'), foreignDirectory = await sandbox.bindDirectory(foreign, '.');
    await assert.rejects(policy.step({
      goal: { kind: 'file.property', property: 'file.property.directory.entries', target: foreignDirectory,
        requirement: { kind: 'observed', freshness: 'this_run' } },
      state: { session: 's', cwdObservation: null, directoryListing: null },
      satisfactionThreshold: 100,
    }), /bound session|Directory reference|target/i);
    assert.deepEqual(sandbox.getSession(session), before);
    const wrongUnsupported = await api.createCliCommandPolicy({ profile: api.zeroCliCommandProfile(), sandbox, session }).step({
      goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
        target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
        requirement: { kind: 'observed', freshness: 'this_run' } },
      state: { session: 's', cwdObservation: null, directoryListing: null },
      satisfactionThreshold: 100,
    });
    assert.deepEqual(wrongUnsupported.policy_error, { expectedHead: 'pwd', selectedHead: 'unsupported' });
    assert.equal(wrongUnsupported.execution_result.status, 'rejected');
    assert.equal(wrongUnsupported.execution_result.executorInvoked, false);
    assert.deepEqual([wrongUnsupported.status, wrongUnsupported.satisfaction, wrongUnsupported.changed], ['rejected', 0, false]);
    assert.deepEqual(sandbox.getSession(session), before);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('filesystem cleanup waits for every owned scene and exposes failures', async () => {
  const { cleanupCliFilesystemSandboxes } = await import('nnanything/cli-goal');
  const visited = [];
  const original = new Error('cleanup denied');
  await assert.rejects(cleanupCliFilesystemSandboxes([
    { async cleanup() { visited.push('first'); throw original; } },
    { async cleanup() { await new Promise(resolve => setTimeout(resolve, 5)); visited.push('second'); } },
  ]), error => error instanceof AggregateError && error.errors.includes(original));
  assert.deepEqual(visited, ['first', 'second']);
});
