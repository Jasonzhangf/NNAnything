import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PATH_ACTIONS,
  PATH_WIRES,
  pathFeatures,
  rolloutPath,
  scorePathActions,
  validatePathProfile,
  validatePathRequest,
  zeroPathProfile,
} from '../dist/filters/cli-path-controller.js';

// Hand-coded separating witness. This is a test fixture only, never a trained
// default and never an initialization for real fitting.
function witnessProfile() {
  const profile = zeroPathProfile();
  const set = (action, wire, value) => {
    profile.weights[PATH_ACTIONS.indexOf(action)][PATH_WIRES.indexOf(wire)] = value;
  };
  set('START_FROM_ROOT', 'absoluteInput', 1);
  set('START_FROM_ROOT', 'phaseSegment', -10);
  set('START_FROM_CWD', 'bias', 1);
  set('START_FROM_CWD', 'absoluteInput', -1);
  set('START_FROM_CWD', 'phaseSegment', -10);
  set('PUSH_NAME', 'kindName', 2);
  set('POP_PARENT', 'kindParent', 2);
  set('POP_PARENT', 'parentEmpty', -2);
  set('STAY', 'kindCurrent', 1);
  set('STAY', 'parentEmpty', 2);
  return validatePathProfile(profile);
}

const actions = trace => trace.map(step => step.action);

test('fixed order of actions and wires', () => {
  assert.deepEqual(PATH_ACTIONS, [
    'START_FROM_ROOT',
    'START_FROM_CWD',
    'PUSH_NAME',
    'POP_PARENT',
    'STAY',
  ]);
  assert.deepEqual(PATH_WIRES, [
    'bias',
    'phaseStart',
    'phaseSegment',
    'absoluteInput',
    'kindCurrent',
    'kindParent',
    'kindName',
    'stackEmpty',
    'parentEmpty',
  ]);
  assert.equal(Object.isFrozen(PATH_ACTIONS), true);
  assert.equal(Object.isFrozen(PATH_WIRES), true);
});

test('zero profile is deep distinct zero 5x9 arrays with fixed contract', () => {
  const first = zeroPathProfile();
  const second = zeroPathProfile();
  assert.equal(first.contract, 'cli.path-controller.v1');
  assert.equal(first.calibration, 'uncalibrated');
  assert.equal(first.adoption, 'not_applied');
  assert.deepEqual(first.actions, [...PATH_ACTIONS]);
  assert.deepEqual(first.wires, [...PATH_WIRES]);
  assert.equal(first.weights.length, 5);
  for (const row of first.weights) {
    assert.equal(row.length, 9);
    assert.deepEqual(row, new Array(9).fill(0));
  }
  assert.notEqual(first.weights[0], first.weights[1]);
  assert.notEqual(first.weights[0], second.weights[0]);
  first.weights[0][0] = 99;
  assert.equal(second.weights[0][0], 0);
});

test('validatePathProfile enforces ordered strings, finite dimensions and literals', () => {
  const profile = zeroPathProfile();
  const validated = validatePathProfile(profile);
  assert.deepEqual(validated, profile);
  assert.notEqual(validated.weights, profile.weights);
  assert.notEqual(validated.weights[0], profile.weights[0]);

  const reversedWires = structuredClone(profile);
  reversedWires.wires.reverse();
  assert.throws(() => validatePathProfile(reversedWires), TypeError);

  const reversedActions = structuredClone(profile);
  reversedActions.actions.reverse();
  assert.throws(() => validatePathProfile(reversedActions), TypeError);

  const shortWeights = structuredClone(profile);
  shortWeights.weights.pop();
  assert.throws(() => validatePathProfile(shortWeights), TypeError);

  const shortRow = structuredClone(profile);
  shortRow.weights[2].pop();
  assert.throws(() => validatePathProfile(shortRow), TypeError);

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    const nonFinite = structuredClone(profile);
    nonFinite.weights[3][4] = bad;
    assert.throws(() => validatePathProfile(nonFinite), TypeError);
  }

  const wrongContract = structuredClone(profile);
  wrongContract.contract = 'cli.path-controller.v2';
  assert.throws(() => validatePathProfile(wrongContract), TypeError);

  const wrongCalibration = structuredClone(profile);
  wrongCalibration.calibration = 'calibrated';
  assert.throws(() => validatePathProfile(wrongCalibration), TypeError);

  const wrongAdoption = structuredClone(profile);
  wrongAdoption.adoption = 'applied';
  assert.throws(() => validatePathProfile(wrongAdoption), TypeError);
});

test('validated profile is a defensive copy', () => {
  const input = zeroPathProfile();
  const validated = validatePathProfile(input);
  input.weights[0][0] = 42;
  input.wires.reverse();
  assert.equal(validated.weights[0][0], 0);
  assert.deepEqual(validated.wires, [...PATH_WIRES]);
});

test('validatePathRequest enforces canonical cwd, nonempty input and component cap', () => {
  assert.deepEqual(validatePathRequest({ cwd: '/a/b', input: 'c' }), { cwd: '/a/b', input: 'c' });
  assert.deepEqual(validatePathRequest({ cwd: '/', input: '///' }), { cwd: '/', input: '///' });

  const names = length => Array.from({ length }, (_, index) => `n${index}`).join('/');
  assert.doesNotThrow(() => validatePathRequest({ cwd: '/', input: names(256) }));
  assert.throws(() => validatePathRequest({ cwd: '/', input: names(257) }), TypeError);
  assert.throws(() => validatePathRequest({ cwd: `/a/b`, input: names(255) }), TypeError);
  assert.doesNotThrow(() => validatePathRequest({ cwd: `/a/b`, input: names(254) }));

  for (const cwd of ['relative', '/a/', '/a/..', '/a/.', '/a//b', '//', '/a/\0b', '']) {
    assert.throws(() => validatePathRequest({ cwd, input: 'a' }), TypeError, `cwd=${JSON.stringify(cwd)}`);
  }
  for (const input of ['', 'a\0b']) {
    assert.throws(() => validatePathRequest({ cwd: '/a', input }), TypeError);
  }
  for (const request of [
    null,
    [],
    { cwd: 1, input: 'a' },
    { cwd: '/a', input: 1 },
    { cwd: '/a' },
    { cwd: '/a', input: 'b', extra: true },
  ]) {
    assert.throws(() => validatePathRequest(request), TypeError);
  }
});

test('pathFeatures emits ordered wires with zero kinds at start', () => {
  assert.deepEqual(
    pathFeatures({ phase: 'start', absoluteInput: true, kind: 'name', stackEmpty: true }),
    [1, 1, 0, 1, 0, 0, 0, 1, 0],
  );
  assert.deepEqual(
    pathFeatures({ phase: 'segment', absoluteInput: false, kind: 'name', stackEmpty: true }),
    [1, 0, 1, 0, 0, 0, 1, 1, 0],
  );
  assert.deepEqual(
    pathFeatures({ phase: 'segment', absoluteInput: false, kind: 'parent', stackEmpty: false }),
    [1, 0, 1, 0, 0, 1, 0, 0, 0],
  );
  assert.deepEqual(
    pathFeatures({ phase: 'segment', absoluteInput: true, kind: 'parent', stackEmpty: true }),
    [1, 0, 1, 1, 0, 1, 0, 1, 1],
  );
  assert.deepEqual(
    pathFeatures({ phase: 'segment', absoluteInput: false, kind: 'current', stackEmpty: true }),
    [1, 0, 1, 0, 1, 0, 0, 1, 0],
  );
  assert.throws(() => pathFeatures({ phase: 'segment', absoluteInput: false, kind: null, stackEmpty: true }), TypeError);
  assert.throws(() => pathFeatures({ phase: 'middle', absoluteInput: false, kind: 'name', stackEmpty: true }), TypeError);
});

test('scorePathActions is a linear raw logit with a strict feature vector', () => {
  const profile = witnessProfile();
  const startAbsolute = pathFeatures({ phase: 'start', absoluteInput: true, kind: null, stackEmpty: true });
  assert.deepEqual(scorePathActions(startAbsolute, profile), [1, 0, 0, 0, 0]);
  const startRelative = pathFeatures({ phase: 'start', absoluteInput: false, kind: null, stackEmpty: true });
  assert.deepEqual(scorePathActions(startRelative, profile), [0, 1, 0, 0, 0]);
  assert.deepEqual(scorePathActions(startAbsolute, zeroPathProfile()), [0, 0, 0, 0, 0]);

  assert.throws(() => scorePathActions([1, 2, 3], profile), TypeError);
  assert.throws(() => scorePathActions([...startAbsolute, 0], profile), TypeError);
  assert.throws(() => scorePathActions(startAbsolute.map((_, index) => (index === 0 ? Number.NaN : 0)), profile), TypeError);
  assert.throws(() => scorePathActions(startAbsolute.map((_, index) => (index === 0 ? Number.POSITIVE_INFINITY : 0)), profile), TypeError);
});

test('witness resolves relative and absolute inputs over the symbolic stack', () => {
  const profile = witnessProfile();
  const relative = rolloutPath({ cwd: '/a/b', input: '../c' }, profile);
  assert.equal(relative.ok, true);
  assert.equal(relative.absolute, '/a/c');
  assert.deepEqual(actions(relative.trace), ['START_FROM_CWD', 'POP_PARENT', 'PUSH_NAME']);
  assert.deepEqual(relative.trace.slice(0, 1).map(step => step.phase), ['start']);
  assert.deepEqual(relative.trace.slice(1).map(step => step.phase), ['segment', 'segment']);
  assert.deepEqual(relative.trace.map(step => step.index), [0, 1, 2]);
  assert.deepEqual(relative.trace[0].before, []);
  assert.deepEqual(relative.trace[0].after, ['a', 'b']);
  assert.deepEqual(relative.trace[1].before, ['a', 'b']);
  assert.deepEqual(relative.trace[1].after, ['a']);
  assert.deepEqual(relative.trace[2].after, ['a', 'c']);
  for (const step of relative.trace) {
    assert.deepEqual(Object.keys(step).sort(), ['action', 'after', 'before', 'features', 'index', 'phase', 'scores'].sort());
    assert.equal(step.features.length, 9);
    assert.equal(step.scores.length, 5);
    assert.equal(step.scores.every(Number.isFinite), true);
  }

  const absolute = rolloutPath({ cwd: '/a/b', input: '//x//./y/..//' }, profile);
  assert.equal(absolute.ok, true);
  assert.equal(absolute.absolute, '/x');
  assert.deepEqual(actions(absolute.trace), ['START_FROM_ROOT', 'PUSH_NAME', 'STAY', 'PUSH_NAME', 'POP_PARENT']);
});

test('empty input segments are ignored; slash-only input is absolute and runs the start step alone', () => {
  const profile = witnessProfile();
  const rootAbsolute = rolloutPath({ cwd: '/a', input: '///' }, profile);
  assert.equal(rootAbsolute.ok, true);
  assert.equal(rootAbsolute.absolute, '/');
  assert.deepEqual(actions(rootAbsolute.trace), ['START_FROM_ROOT']);
  const trailingSlashes = rolloutPath({ cwd: '/a', input: 'b///' }, profile);
  assert.equal(trailingSlashes.ok, true);
  assert.equal(trailingSlashes.absolute, '/a/b');
  assert.deepEqual(actions(trailingSlashes.trace), ['START_FROM_CWD', 'PUSH_NAME']);
  const rootAtRoot = rolloutPath({ cwd: '/', input: '//' }, profile);
  assert.equal(rootAtRoot.ok, true);
  assert.equal(rootAtRoot.absolute, '/');
  assert.deepEqual(actions(rootAtRoot.trace), ['START_FROM_ROOT']);
});

test('names stay symbolic, including spaces, unicode, backslashes and shell tokens', () => {
  const profile = witnessProfile();
  const result = rolloutPath({ cwd: '/base dir', input: '.../.hidden/子 目录/back\\slash/$HOME/*/a..b' }, profile);
  assert.equal(result.ok, true);
  assert.equal(result.absolute, '/base dir/.../.hidden/子 目录/back\\slash/$HOME/*/a..b');
});

test('root is / and cwd components are copied, not aliased', () => {
  const profile = witnessProfile();
  const root = rolloutPath({ cwd: '/a', input: '.' }, profile);
  assert.equal(root.ok, true);
  assert.equal(root.absolute, '/a');
  const atRoot = rolloutPath({ cwd: '/', input: '.' }, profile);
  assert.equal(atRoot.ok, true);
  assert.equal(atRoot.absolute, '/');
});

test('wrong but mechanically legal action flows to its actual result, not a teacher correction', () => {
  const poppedName = witnessProfile();
  poppedName.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('kindName')] = 3;
  const popped = rolloutPath({ cwd: '/a/b', input: 'x' }, poppedName);
  assert.equal(popped.ok, true);
  assert.equal(popped.absolute, '/a');
  assert.deepEqual(actions(popped.trace), ['START_FROM_CWD', 'POP_PARENT']);

  const stayedParent = witnessProfile();
  stayedParent.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('kindParent')] = 0;
  stayedParent.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('parentEmpty')] = 0;
  stayedParent.weights[PATH_ACTIONS.indexOf('STAY')][PATH_WIRES.indexOf('kindParent')] = 3;
  const stayed = rolloutPath({ cwd: '/a/b', input: '..' }, stayedParent);
  assert.equal(stayed.ok, true);
  assert.equal(stayed.absolute, '/a/b');
  assert.deepEqual(actions(stayed.trace), ['START_FROM_CWD', 'STAY']);
});

test('learned absolute input can start from cwd without correction', () => {
  const profile = witnessProfile();
  profile.weights[PATH_ACTIONS.indexOf('START_FROM_CWD')][PATH_WIRES.indexOf('absoluteInput')] = 3;
  const result = rolloutPath({ cwd: '/a/b', input: '/x' }, profile);
  assert.equal(result.ok, true);
  assert.equal(result.absolute, '/a/b/x');
  assert.deepEqual(actions(result.trace), ['START_FROM_CWD', 'PUSH_NAME']);
});

test('zero profile visibly fails a relative rollout instead of applying a teacher', () => {
  const zero = zeroPathProfile();
  const baseline = rolloutPath({ cwd: '/a/b', input: '../c' }, zero);
  assert.equal(baseline.ok, false);
  assert.equal(baseline.code, 'INVALID_ACTION');
  assert.deepEqual(actions(baseline.trace), ['START_FROM_ROOT', 'START_FROM_ROOT']);
});

test('tampered start action is rejected and retained, never reselected', () => {
  const profile = zeroPathProfile();
  profile.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('bias')] = 10;
  const result = rolloutPath({ cwd: '/a', input: 'b' }, profile);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ACTION');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].action, 'POP_PARENT');
  assert.deepEqual(result.trace[0].before, []);
  assert.deepEqual(result.trace[0].after, []);
});

test('illegal segment actions are rejected with before equal to after', () => {
  const rootAtSegment = witnessProfile();
  rootAtSegment.weights[PATH_ACTIONS.indexOf('START_FROM_ROOT')][PATH_WIRES.indexOf('phaseSegment')] = 5;
  const wrongPhase = rolloutPath({ cwd: '/a', input: 'b' }, rootAtSegment);
  assert.equal(wrongPhase.ok, false);
  assert.equal(wrongPhase.code, 'INVALID_ACTION');
  assert.equal(wrongPhase.trace.at(-1).action, 'START_FROM_ROOT');
  assert.deepEqual(wrongPhase.trace.at(-1).before, ['a']);
  assert.deepEqual(wrongPhase.trace.at(-1).after, ['a']);

  const pushOnCurrent = witnessProfile();
  pushOnCurrent.weights[PATH_ACTIONS.indexOf('PUSH_NAME')][PATH_WIRES.indexOf('kindCurrent')] = 4;
  const noName = rolloutPath({ cwd: '/a', input: '.' }, pushOnCurrent);
  assert.equal(noName.ok, false);
  assert.equal(noName.code, 'INVALID_ACTION');
  assert.equal(noName.trace.at(-1).action, 'PUSH_NAME');
  assert.deepEqual(noName.trace.at(-1).before, ['a']);
  assert.deepEqual(noName.trace.at(-1).after, ['a']);

  const popAtRoot = witnessProfile();
  popAtRoot.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('parentEmpty')] = 0;
  const emptyPop = rolloutPath({ cwd: '/', input: '..' }, popAtRoot);
  assert.equal(emptyPop.ok, false);
  assert.equal(emptyPop.code, 'INVALID_ACTION');
  assert.equal(emptyPop.trace.at(-1).action, 'POP_PARENT');
  assert.deepEqual(emptyPop.trace.at(-1).before, []);
  assert.deepEqual(emptyPop.trace.at(-1).after, []);

  const stayAtStart = zeroPathProfile();
  stayAtStart.weights[PATH_ACTIONS.indexOf('STAY')][PATH_WIRES.indexOf('bias')] = 10;
  const uninitialized = rolloutPath({ cwd: '/a', input: 'b' }, stayAtStart);
  assert.equal(uninitialized.ok, false);
  assert.equal(uninitialized.code, 'INVALID_ACTION');
  assert.equal(uninitialized.trace.length, 1);
  assert.equal(uninitialized.trace[0].action, 'STAY');
});

test('rolloutPath rejects requests and profiles at the contract boundary', () => {
  const profile = witnessProfile();
  assert.throws(() => rolloutPath({ cwd: 'relative', input: 'a' }, profile), TypeError);
  assert.throws(() => rolloutPath({ cwd: '/a/..', input: 'a' }, profile), TypeError);
  assert.throws(() => rolloutPath({ cwd: '/a', input: '' }, profile), TypeError);
  const badProfile = zeroPathProfile();
  badProfile.wires.reverse();
  assert.throws(() => rolloutPath({ cwd: '/a', input: 'b' }, badProfile), TypeError);
});
