import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ELEVEN_HEADS = [
  'unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls',
  'path.resolve', 'path.relative', 'path.parts', 'path.realpath', 'entry.inspect',
];
const THIRTEEN_HEADS = [...ELEVEN_HEADS, 'directory.select', 'file.select'];
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
const TEN_PREDICATES = [...NINE_PREDICATES, 'predicate.select.entry'];
const THIRTY_FOUR_WIRES = [
  'bias', 'goalObserveCwd', 'goalSetCwd', 'goalListDirectory',
  ...FIFTEEN_PROPERTIES,
  ...NINE_PREDICATES,
  'state.hasFreshEvidence', 'state.knownValue', 'state.requiredConditionHolds',
  'state.hasDestinationRef', 'search.nameNeedleSegment',
  'state.requiredConditionHolds*state.hasFreshEvidence',
];
const STAGE2_SELECTOR_WIRES = ['selectorTargetType.unspecified', 'selectorTargetType.regular', 'selectorTargetType.directory'];
const THIRTY_EIGHT_WIRES = [
  'bias', 'goalObserveCwd', 'goalSetCwd', 'goalListDirectory',
  ...FIFTEEN_PROPERTIES,
  ...TEN_PREDICATES,
  ...STAGE2_SELECTOR_WIRES,
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
  assert.deepEqual(extended.heads, THIRTEEN_HEADS);
  assert.deepEqual(extended.properties, FIFTEEN_PROPERTIES);
  assert.deepEqual(extended.predicates, TEN_PREDICATES);
  assert.deepEqual(extended.wires, THIRTY_EIGHT_WIRES);
  assert.equal(extended.weights.length, 13);
  assert.equal(extended.weights.every(row => row.length === 38), true);
  assert.equal(extended.weights.flat().length, 494);
  for (const [rowIndex, head] of THIRTEEN_HEADS.entries()) {
    for (const [columnIndex, wire] of THIRTY_EIGHT_WIRES.entries()) {
      const legacyRow = LEGACY_HEADS.indexOf(head);
      const legacyColumn = LEGACY_WIRES.indexOf(wire);
      const expected = legacyRow < 0 || legacyColumn < 0 ? 0 : legacy.weights[legacyRow][legacyColumn];
      assert.equal(extended.weights[rowIndex][columnIndex], expected, `${head}/${wire} must be copied or zero-filled by name`);
    }
  }
  assert.throws(() => api.validateCliCommandProfile({ ...extended, weights: [[1, 2], [3, 4]] }));
});

test('Stage 1 11x34 migrates to Stage 2 13x38 by name with named-slot rejections', async () => {
  const api = await import('nnanything/cli-goal');
  const stage1Wires = THIRTY_EIGHT_WIRES.filter(wire =>
    wire !== 'predicate.select.entry' && !STAGE2_SELECTOR_WIRES.includes(wire));
  assert.equal(stage1Wires.length, 34);
  const stage1 = {
    contract: 'cli.command-policy.v1',
    heads: ELEVEN_HEADS,
    properties: FIFTEEN_PROPERTIES,
    predicates: NINE_PREDICATES,
    wires: stage1Wires,
    weights: Array.from({ length: ELEVEN_HEADS.length }, (_, row) =>
      Array.from({ length: stage1Wires.length }, (_, column) => row * 100 + column + 1)),
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
  assert.equal(api.detectCliCommandProfileSchema(stage1), 'current-11x34');
  assert.throws(() => api.validateCliCommandProfile(stage1), /11x34|migrat/i);
  const migrated = api.migrateCliCommandProfileStage1ToStage2(stage1);
  assert.equal(api.detectCliCommandProfileSchema(migrated), 'current-13x38');
  assert.deepEqual(migrated.heads, THIRTEEN_HEADS);
  assert.deepEqual(migrated.predicates, TEN_PREDICATES);
  assert.deepEqual(migrated.wires, THIRTY_EIGHT_WIRES);
  assert.equal(migrated.weights.length, 13);
  assert.equal(migrated.weights.every(row => row.length === 38), true);
  assert.equal(migrated.weights.flat().length, 494);
  let copied = 0, zeroFilled = 0;
  for (const [row, head] of THIRTEEN_HEADS.entries()) {
    for (const [column, wire] of THIRTY_EIGHT_WIRES.entries()) {
      const sourceRow = ELEVEN_HEADS.indexOf(head);
      const sourceColumn = stage1Wires.indexOf(wire);
      if (sourceRow >= 0 && sourceColumn >= 0) {
        copied += 1;
        assert.equal(migrated.weights[row][column], stage1.weights[sourceRow][sourceColumn], `${head}/${wire} must copy by name`);
      } else {
        zeroFilled += 1;
        assert.equal(migrated.weights[row][column], 0, `${head}/${wire} must be zero-filled`);
      }
    }
  }
  assert.equal(copied, 374);
  assert.equal(zeroFilled, 120);
  const stage1Profile = api.validateCliCommandProfile(stage1, 'stage1-11x34');
  assert.deepEqual(stage1Profile.heads, ELEVEN_HEADS);
  assert.deepEqual(stage1Profile.wires, stage1Wires);
  assert.equal(stage1Profile.weights.length, 11);
  assert.equal(stage1Profile.weights.every(row => row.length === 34), true);
  assert.equal(stage1Profile.weights.flat().length, 374);
  assert.throws(() => api.validateCliCommandProfile(stage1, 'stage2-13x38'), /11x34|migrat/i);
  assert.throws(() => api.validateCliCommandProfile(migrated, 'stage1-11x34'), /stage1-11x34/);
  assert.throws(() => api.validateCliCommandProfile(stage1, 'stage3'), /stage/i);
  assert.deepEqual(api.migrateCliCommandProfileToCurrent(stage1), migrated);
  assert.deepEqual(api.migrateCliCommandProfileToCurrent(migrated), migrated);
  assert.deepEqual(api.STAGE2_PROFILE_DIMENSIONS, { heads: 13, wires: 38, parameters: 494 });
});

test('named migration preserves every old slot when heads and weights are permuted together', async () => {
  const api = await import('nnanything/cli-goal');
  const stage1Wires = THIRTY_EIGHT_WIRES.filter(wire =>
    wire !== 'predicate.select.entry' && !STAGE2_SELECTOR_WIRES.includes(wire));
  const base = {
    contract: 'cli.command-policy.v1',
    heads: ELEVEN_HEADS,
    properties: FIFTEEN_PROPERTIES,
    predicates: NINE_PREDICATES,
    wires: stage1Wires,
    weights: Array.from({ length: ELEVEN_HEADS.length }, (_, row) =>
      Array.from({ length: stage1Wires.length }, (_, column) => row * 100 + column + 1)),
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
  const permuted = {
    ...base,
    heads: [...base.heads].reverse(),
    weights: [...base.weights].reverse(),
  };
  const migrated = api.migrateCliCommandProfileStage1ToStage2(permuted);
  let changed = 0;
  for (let row = 0; row < base.heads.length; row += 1) {
    for (let column = 0; column < base.wires.length; column += 1) {
      const targetHead = base.heads[row];
      const targetWire = base.wires[column];
      const migratedRow = THIRTEEN_HEADS.indexOf(targetHead);
      const migratedColumn = THIRTY_EIGHT_WIRES.indexOf(targetWire);
      if (migrated.weights[migratedRow][migratedColumn] !== base.weights[row][column]) changed += 1;
    }
  }
  assert.equal(changed, 0, 'permuting heads and weights together must not move any copied value');
  assert.equal(api.detectCliCommandProfileSchema(migrated), 'current-13x38');
});

test('Stage 1 11x34 binding runs inference on its own heads and wires', async () => {
  const api = await import('nnanything/cli-goal');
  const stage1Wires = THIRTY_EIGHT_WIRES.filter(wire =>
    wire !== 'predicate.select.entry' && !STAGE2_SELECTOR_WIRES.includes(wire));
  const stage1 = {
    contract: 'cli.command-policy.v1',
    heads: ELEVEN_HEADS,
    properties: FIFTEEN_PROPERTIES,
    predicates: NINE_PREDICATES,
    wires: stage1Wires,
    weights: Array.from({ length: ELEVEN_HEADS.length }, () => Array(stage1Wires.length).fill(0)),
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
  assert.equal(api.validateCliCommandProfile(stage1, 'stage1-11x34').weights.flat().length, 374);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-stage1-binding-')));
  let sandbox;
  try {
    sandbox = await api.createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'stage1-binding', entries: [
        { path: 'start', kind: 'directory' },
        { path: 'target', kind: 'directory' },
      ], sessions: [{ id: 's', cwd: 'start', grantedEffects: ['filesystem.read', 'process.exec', 'session.write'] }],
    } });
    const session = sandbox.bindSession('s');
    const policy = api.createCliCommandPolicy({ profile: forceHead(stage1, 'pwd'), stage: 'stage1-11x34', sandbox, session });
    const result = await policy.step({ goal: { kind: 'file.property', property: 'file.property.relation.sessionCwd',
      target: { kind: 'cli.file-query', relation: 'sessionCwd', session },
      requirement: { kind: 'observed', freshness: 'this_run' } },
      satisfactionThreshold: 100, state: { session: 's', cwdObservation: null, directoryListing: null } });
    assert.deepEqual(result.invocation, ['pwd']);
    assert.equal(result.status, 'achieved');
    assert.equal(result.policy.selectedHead, 'pwd');
    assert.equal(result.policy.features.length, 34);
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('default Stage 2 binding still rejects an unmigrated Stage 1 profile', async () => {
  const api = await import('nnanything/cli-goal');
  const stage1Wires = THIRTY_EIGHT_WIRES.filter(wire =>
    wire !== 'predicate.select.entry' && !STAGE2_SELECTOR_WIRES.includes(wire));
  const stage1 = {
    contract: 'cli.command-policy.v1',
    heads: ELEVEN_HEADS,
    properties: FIFTEEN_PROPERTIES,
    predicates: NINE_PREDICATES,
    wires: stage1Wires,
    weights: Array.from({ length: ELEVEN_HEADS.length }, () => Array(stage1Wires.length).fill(0)),
    calibration: 'uncalibrated',
    adoption: 'not_applied',
  };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-stage1-default-')));
  let sandbox;
  try {
    sandbox = await api.createCliFilesystemSandbox({ root, ownerGrantedEffects: ['filesystem.write'], recipe: {
      scenarioId: 'stage1-default', entries: [
        { path: 'start', kind: 'directory' },
      ], sessions: [{ id: 's', cwd: 'start', grantedEffects: ['filesystem.read', 'process.exec', 'session.write'] }],
    } });
    const session = sandbox.bindSession('s');
    assert.throws(
      () => api.createCliCommandPolicy({ profile: stage1, sandbox, session }),
      /11x34|migrat/i,
    );
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
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
