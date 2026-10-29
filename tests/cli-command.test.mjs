import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ELEVEN_HEADS = [
  'unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls',
  'path.resolve', 'path.relative', 'path.parts', 'path.realpath', 'entry.inspect',
];
const FIFTEEN_PROPERTIES = [
  'property.path.absolute', 'property.path.relative', 'property.path.parent', 'property.path.name',
  'property.path.physical',
  'property.exists', 'property.type', 'property.directory.entries', 'property.size',
  'property.mode', 'property.owner', 'property.times', 'property.link.target',
  'property.entry.identity', 'property.relation.sessionCwd',
];
const NINE_PREDICATES = [
  'predicate.observe.absolute', 'predicate.observe.relative', 'predicate.observe.parts',
  'predicate.observe.physical', 'predicate.observe.inspect', 'predicate.observe.resolvedTarget',
  'predicate.observe.sessionCwd', 'predicate.equals.sessionCwd', 'predicate.observe.entries',
];
const THIRTY_FOUR_WIRES = [
  'bias', 'goalObserveCwd', 'goalSetCwd', 'goalListDirectory',
  ...FIFTEEN_PROPERTIES,
  ...NINE_PREDICATES,
  'state.hasFreshEvidence', 'state.knownValue', 'state.requiredConditionHolds',
  'state.hasDestinationRef', 'search.nameNeedleSegment',
  'state.requiredConditionHolds*state.hasFreshEvidence',
];
const LEGACY_HEADS = ['unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls'];
const LEGACY_PROPERTIES = ['property.directory.entries', 'property.relation.sessionCwd'];
const LEGACY_PREDICATES = [
  'predicate.observe.sessionCwd', 'predicate.equals.sessionCwd', 'predicate.observe.entries',
];
const LEGACY_WIRES = [
  'bias', 'goalObserveCwd', 'goalSetCwd', 'goalListDirectory',
  ...LEGACY_PROPERTIES,
  ...LEGACY_PREDICATES,
  'state.hasFreshEvidence', 'state.knownValue', 'state.requiredConditionHolds',
  'state.hasDestinationRef', 'state.requiredConditionHolds*state.hasFreshEvidence',
];

function forceHead(profile, head) {
  const index = profile.heads.indexOf(head);
  assert.notEqual(index, -1);
  return { ...profile, weights: profile.weights.map((row, rowIndex) => row.map((weight, columnIndex) =>
    rowIndex === index && columnIndex === 0 ? 1 : weight)) };
}

function symbolicWireIndex(api, wire) {
  const index = api.CLI_COMMAND_WIRES.indexOf(wire);
  assert.notEqual(index, -1);
  return index;
}

test('shared command profile expands named weights without reinterpreting old rows', async () => {
  const api = await import('nnanything/cli-goal');
  const legacy = {
    contract: 'cli.command-policy.v1',
    heads: LEGACY_HEADS,
    properties: LEGACY_PROPERTIES,
    predicates: LEGACY_PREDICATES,
    wires: LEGACY_WIRES,
    weights: Array.from({ length: LEGACY_HEADS.length }, (_, row) =>
      Array.from({ length: LEGACY_WIRES.length }, (_, column) => row * LEGACY_WIRES.length + column + 1)),
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
  const extended = api.migrateCliCommandProfileV6(legacy);
  assert.deepEqual(extended.heads, ELEVEN_HEADS);
  assert.deepEqual(extended.properties, FIFTEEN_PROPERTIES);
  assert.deepEqual(extended.predicates, NINE_PREDICATES);
  assert.deepEqual(extended.wires, THIRTY_FOUR_WIRES);
  assert.equal(extended.weights.length, 11);
  assert.equal(extended.weights.every(row => row.length === 34), true);
  assert.equal(extended.weights.flat().length, 374);
  for (const [rowIndex, head] of ELEVEN_HEADS.entries()) {
    for (const [columnIndex, wire] of THIRTY_FOUR_WIRES.entries()) {
      const legacyRow = LEGACY_HEADS.indexOf(head);
      const legacyColumn = LEGACY_WIRES.indexOf(wire);
      const expected = legacyRow < 0 || legacyColumn < 0 ? 0 : legacy.weights[legacyRow][legacyColumn];
      assert.equal(extended.weights[rowIndex][columnIndex], expected, `${head}/${wire} must be copied or zero-filled by name`);
    }
  }
  assert.throws(() => api.validateCliCommandProfile({ ...extended, weights: [[1, 2], [3, 4]] }));
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
    const profile = api.zeroCliCommandProfile();
    const policy = api.createCliCommandPolicy({ profile: forceHead(profile, 'pwd'), sandbox, session });
    const state = { session: 's', cwdObservation: null, directoryListing: null };
    const pwd = await policy.step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state });
    assert.deepEqual(pwd.invocation, ['pwd']);
    assert.equal(pwd.status, 'achieved');
    assert.equal(pwd.satisfaction, 100);
    const directory = await sandbox.bindDirectory(session, '../target with space');
    const target = join(sandbox.scenarioRoot, 'target with space');
    const equalProfile = { ...profile, weights: profile.weights.map(row => [...row]) };
    equalProfile.weights[profile.heads.indexOf('cd')][symbolicWireIndex(api, 'goalSetCwd')] = 10;
    equalProfile.weights[profile.heads.indexOf('NOOP')][symbolicWireIndex(api, 'state.requiredConditionHolds*state.hasFreshEvidence')] = 20;
    const equalPolicy = api.createCliCommandPolicy({ profile: equalProfile, sandbox, session });
    const cd = await equalPolicy
      .step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'equals', expected: directory } }, satisfactionThreshold: 100, state });
    assert.deepEqual(cd.invocation, ['cd', directory]);
    assert.equal(cd.status, 'achieved');
    assert.equal(cd.satisfaction, 100);
    assert.equal(cd.postcondition.receipt.execution.observation.physicalCwd, target);
    const rebound = await sandbox.bindDirectory(session, '.');
    const ls = await api.createCliCommandPolicy({ profile: forceHead(profile, 'ls'), sandbox, session })
      .step({ goal: { kind: 'file.property', property: 'file.property.directory.entries',
      target: rebound, requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state });
    assert.deepEqual(ls.invocation, ['ls', rebound]);
    assert.equal(ls.status, 'achieved');
    assert.equal(ls.satisfaction, 100);
    assert.deepEqual(ls.observed_state_after.directoryListing.entries.map(({ name, type }) => ({ name, type })), [{ name: '.hidden', type: 'file' }]);
    const unsupportedPolicy = api.createCliCommandPolicy({ profile: forceHead(profile, 'unsupported'), sandbox, session });
    const unsupported = await unsupportedPolicy
      .step({ goal: { kind: 'file.property', property: 'file.property.links',
      target: directory, requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state });
    assert.equal(unsupported.invocation, null);
    assert.equal(unsupported.execution_result.status, 'unsupported');
    assert.equal(unsupported.execution_result.executorInvoked, false);
    assert.equal(unsupported.policy_error, null);
    assert.equal(unsupported.status, 'unknown');
    assert.equal(unsupported.satisfaction, null);
    await assert.rejects(
      unsupportedPolicy.step({ goal: { kind: 'file.property', property: 'file.property.exists',
        target: directory, requirement: { kind: 'observed', freshness: 'this_run' } },
        satisfactionThreshold: 100, state }),
      error => error instanceof TypeError && /entry inspection query/.test(error.message),
    );
    const wrong = api.createCliCommandPolicy({ profile: forceHead(profile, 'cd'), sandbox, session });
    const blocked = await wrong.step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'observed', freshness: 'this_run' } }, satisfactionThreshold: 100, state });
    assert.equal(blocked.policy.selectedHead, 'cd');
    assert.ok(blocked.policy_error);
    assert.equal(blocked.execution_result.executorInvoked, false);
    assert.equal(blocked.status, 'rejected');
    assert.equal(blocked.satisfaction, 0);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('fixed command goal uses fresh execution and 100/0/null evidence boundaries', async () => {
  const api = await import('nnanything/cli-goal');
  const profile = api.zeroCliCommandProfile();
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
    const policy = api.createCliCommandPolicy({ profile: forceHead(profile, 'pwd'), sandbox, session });
    const pwd = await policy.step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'observed', freshness: 'this_run' } }, satisfactionThreshold: 100, state });
    assert.deepEqual([pwd.status, pwd.satisfaction], ['achieved', 100]);
    const equalProfile = { ...profile, weights: profile.weights.map(row => [...row]) };
    equalProfile.weights[profile.heads.indexOf('cd')][symbolicWireIndex(api, 'goalSetCwd')] = 10;
    equalProfile.weights[profile.heads.indexOf('NOOP')][symbolicWireIndex(api, 'state.requiredConditionHolds*state.hasFreshEvidence')] = 20;
    const equalPolicy = api.createCliCommandPolicy({ profile: equalProfile, sandbox, session });
    const cd = await equalPolicy
      .step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'equals', expected: directory } }, satisfactionThreshold: 100, state });
    assert.deepEqual([cd.status, cd.satisfaction], ['achieved', 100]);
    const beforeSame = sandbox.getSession(session);
    directory = await sandbox.bindDirectory(session, '.');
    const sameTarget = await equalPolicy
      .step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'equals', expected: directory } }, satisfactionThreshold: 100, state: cd.observed_state_after });
    assert.equal(sameTarget.invocation, null);
    assert.equal(sameTarget.session_after.revision, beforeSame.revision);
    assert.equal(sameTarget.execution_result.executorInvoked, false);
    assert.deepEqual([sameTarget.status, sameTarget.satisfaction], ['achieved', 100]);
    const ls = await api.createCliCommandPolicy({ profile: forceHead(profile, 'ls'), sandbox, session })
      .step({ goal: { kind: 'file.property', property: 'file.property.directory.entries',
      target: directory, requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state: sameTarget.observed_state_after });
    assert.deepEqual([ls.status, ls.satisfaction], ['achieved', 100]);
    const unsupported = await api.createCliCommandPolicy({ profile: forceHead(profile, 'unsupported'), sandbox, session })
      .step({ goal: { kind: 'file.property', property: 'file.property.links',
      target: directory, requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state });
    assert.deepEqual([unsupported.status, unsupported.satisfaction], ['unknown', null]);
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
    const transition = await api.createCliCommandPolicy({ profile: forceHead(profile, 'pwd'), sandbox: failedSandbox, session })
      .step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
        target: { kind: 'cli.file-query', relation: 'sessionCwd', session: failedSandbox.bindSession('s') },
        requirement: { kind: 'observed', freshness: 'this_run' } },
        satisfactionThreshold: 100, state: { session: 's', cwdObservation: null, directoryListing: null } });
    assert.equal(transition.execution_result.receipt.status, 'failed');
    assert.equal(transition.execution_result.receipt.execution.error.code, 'EFFECT_DENIED');
    assert.equal(transition.reason, 'execution_rejected');
    assert.deepEqual([transition.status, transition.satisfaction], ['rejected', 0]);
  } finally { if (failedSandbox) await failedSandbox.cleanup(); await rm(failedRoot, { recursive: true, force: true }); }
});

test('CD unknown postcondition and LS partial evidence stay null while proven mismatch is zero', async () => {
  const api = await import('nnanything/cli-goal');
  const profile = api.zeroCliCommandProfile();
  const state = { session: 's', cwdObservation: null, directoryListing: null };
  const cwdQuery = session => ({ kind: 'cli.file-query', relation: 'sessionCwd', session });
  const equalsGoal = (session, expected) => ({ kind: 'file.property', property: 'file.property.relation.sessionCwd',
    target: cwdQuery(session), requirement: { kind: 'equals', expected } });
  const entriesGoal = target => ({ kind: 'file.property', property: 'file.property.directory.entries',
    target, requirement: { kind: 'observed', freshness: 'this_run' } });
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
    const transition = await api.createCliCommandPolicy({ profile: forceHead(profile, 'cd'), sandbox: unknownSandbox, session })
      .step({ goal: equalsGoal(session, directory), satisfactionThreshold: 100, state });
    assert.deepEqual([transition.status, transition.satisfaction], ['unknown', null]);
    assert.equal(transition.reason, 'postcommit_observation_failed');
    assert.equal(transition.changed, true);
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
    const transition = await api.createCliCommandPolicy({ profile: forceHead(profile, 'cd'), sandbox: mismatchSandbox, session })
      .step({ goal: equalsGoal(session, directory), satisfactionThreshold: 100, state });
    assert.deepEqual([transition.status, transition.satisfaction], ['unmet', 0]);
    assert.equal(transition.reason, 'postcommit_target_mismatch');
    assert.equal(transition.changed, true);
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
    const transition = await api.createCliCommandPolicy({ profile: forceHead(profile, 'ls'), sandbox: partialSandbox, session })
      .step({ goal: entriesGoal(directory), satisfactionThreshold: 100, state });
    assert.deepEqual([transition.status, transition.satisfaction], ['unknown', null]);
    assert.equal(transition.reason, 'partial_coverage');
    assert.equal(transition.execution_result.receipt.execution.observation.coverage, 'partial');
    assert.equal(transition.execution_result.receipt.execution.observation.entries[0].type, 'unknown');
    assert.deepEqual(transition.observed_state_after, { ...state, pathKnowledge: null, entryKnowledge: null });
  } finally { if (partialSandbox) await partialSandbox.cleanup(); await rm(partialRoot, { recursive: true, force: true }); }
});
