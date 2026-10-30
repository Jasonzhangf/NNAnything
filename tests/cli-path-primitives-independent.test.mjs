import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BASE_GRANTS,
  createIndependentScene,
  entryQuery,
  pathRef,
  treeSnapshot,
} from './cli-path-primitives-independent-fixtures.mjs';

const api = await import('nnanything/cli-goal');
const {
  entrySelectFeatures,
  predictEntrySelectRelation,
  resolveEntrySelectSet,
  validateEntrySelectProfile,
  zeroEntrySelectProfile,
} = await import('../dist/filters/cli-entry-select-relation.js');
const {
  validateEntrySelectionKnowledge,
} = await import('../dist/filters/cli-state.js');
const execFileAsync = promisify(execFile);
const stage = process.env.NN_CLI_COMMAND_STAGE ?? 'stage2-13x38';
if (stage !== 'stage1-11x34' && stage !== 'stage2-13x38') {
  throw new TypeError(`Unsupported NN_CLI_COMMAND_STAGE: ${String(stage)}`);
}
const profileRole = process.env.NN_CLI_PROFILE_ROLE ?? 'trained_candidate';
const profilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (!profilePath) throw new TypeError('NN_CLI_COMMAND_PROFILE is required; no candidate default is allowed');
const rawCandidate = JSON.parse(await readFile(profilePath, 'utf8'));
const candidate = api.validateCliCommandProfile(rawCandidate, stage);
const expectedHeads = stage === 'stage2-13x38'
  ? [
      'unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls',
      'path.resolve', 'path.relative', 'path.parts', 'path.realpath', 'entry.inspect',
      'directory.select', 'file.select',
    ]
  : [
      'unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls',
      'path.resolve', 'path.relative', 'path.parts', 'path.realpath', 'entry.inspect',
    ];
const expectedWires = stage === 'stage2-13x38' ? 38 : 34;
assert.deepEqual(candidate.heads, expectedHeads);
assert.equal(candidate.wires.length, expectedWires);
assert.equal(candidate.weights.length, expectedHeads.length);
assert.ok(candidate.weights.every(row => row.length === expectedWires));
assert.equal(candidate.calibration, 'uncalibrated');
assert.equal(candidate.adoption, 'not_applied');

let entrySelectProfiles = undefined;
const bDirectoryProfilePath = process.env.NN_CLI_B_DIRECTORY_PROFILE ?? null;
const bFileProfilePath = process.env.NN_CLI_B_FILE_PROFILE ?? null;
if (stage === 'stage2-13x38') {
  if (!bDirectoryProfilePath || !bFileProfilePath) {
    throw new TypeError('Stage 2 independent suite requires explicit NN_CLI_B_DIRECTORY_PROFILE and NN_CLI_B_FILE_PROFILE disk paths; embedded fallback weights are forbidden');
  }
  const directoryProfile = validateEntrySelectProfile(JSON.parse(await readFile(bDirectoryProfilePath, 'utf8')));
  const fileProfile = validateEntrySelectProfile(JSON.parse(await readFile(bFileProfilePath, 'utf8')));
  assert.equal(directoryProfile.contract, 'cli.directory-select-relation.v1');
  assert.equal(fileProfile.contract, 'cli.file-select-relation.v1');
  assert.equal(directoryProfile.calibration, 'uncalibrated');
  assert.equal(directoryProfile.adoption, 'not_applied');
  assert.equal(fileProfile.calibration, 'uncalibrated');
  assert.equal(fileProfile.adoption, 'not_applied');
  entrySelectProfiles = Object.freeze({
    directory: directoryProfile,
    regular: fileProfile,
  });
}

const startedAt = new Date().toISOString();
const reportPath = process.env.NN_I7_REPORT
  ?? fileURLToPath(new URL(
    `../artifacts/batch1/i7/new-suite-report-${startedAt.replace(/[:.]/g, '-')}.json`,
    import.meta.url,
  ));
const rows = [];
const unverified = [
  'character_device: macOS public sandbox cannot create a character device without elevated mknod privilege',
  'block_device: no non-privileged macOS block-device fixture is available inside the public sandbox',
  'other: no stable public fixture classifies as other on this macOS host',
  'synthetic dev/ino injection: no public inspection injection hook; real sparse-file size fidelity is verified instead',
  'syscall-level zero-I/O trace: public API evidence proves lexical execution and unchanged state, not kernel syscall absence',
];

const grants = BASE_GRANTS;
const emptyState = session => ({
  session: session.sessionId,
  cwdObservation: null,
  directoryListing: null,
});

function observationGoal(property, target) {
  return Object.freeze({
    kind: 'file.property',
    property,
    target,
    requirement: Object.freeze({ kind: 'observed', freshness: 'this_run' }),
  });
}

function inspectGoal(property, ref, followSymlinks) {
  return observationGoal(property, entryQuery(ref, followSymlinks));
}

function resolvedTargetGoal(ref, followSymlinks) {
  return Object.freeze({
    kind: 'file.property',
    property: 'file.property.link.target',
    target: entryQuery(ref, followSymlinks),
    requirement: Object.freeze({
      kind: 'matches',
      predicate: Object.freeze({ kind: 'resolvedTarget' }),
    }),
  });
}

function cwdObservedGoal(session) {
  return observationGoal('file.property.relation.sessionCwd', {
    kind: 'cli.file-query',
    relation: 'sessionCwd',
    session,
  });
}

function cwdEqualsGoal(session, directory) {
  return Object.freeze({
    kind: 'file.property',
    property: 'file.property.relation.sessionCwd',
    target: Object.freeze({
      kind: 'cli.file-query',
      relation: 'sessionCwd',
      session,
    }),
    requirement: Object.freeze({ kind: 'equals', expected: directory }),
  });
}

function policyFor(scene, profile = candidate, session = scene.primary, authority = undefined) {
  return api.createCliCommandPolicy({
    profile,
    stage,
    sandbox: scene.sandbox,
    session,
    ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
  }, authority);
}

function rawPathRef(scene, path, session = scene.primary) {
  return Object.freeze({
    kind: 'cli.path',
    scenarioId: scene.scenarioId,
    sessionId: session.sessionId,
    path,
  });
}

function forcedHeadProfile(head) {
  const profile = api.zeroCliCommandProfile();
  const selected = profile.heads.indexOf(head);
  assert.notEqual(selected, -1);
  return {
    ...profile,
    weights: profile.weights.map((row, index) =>
      index === selected ? [10, ...row.slice(1).map(() => 0)] : row.map(() => 0)),
  };
}

async function unchanged(scene, session, beforeSession, beforeTree) {
  assert.deepEqual(scene.sandbox.getSession(session), beforeSession);
  assert.deepEqual(await treeSnapshot(scene.root), beforeTree);
}

async function assertPathTransition(scene, session, goal, expected) {
  const beforeSession = scene.sandbox.getSession(session);
  const beforeTree = await treeSnapshot(scene.root);
  const transition = await policyFor(scene, candidate, session).step({
    goal,
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(transition.policy.selectedHead, expected.head);
  assert.equal(transition.policy_error, null);
  assert.equal(transition.status, 'achieved');
  assert.equal(transition.satisfaction, 100);
  assert.equal(transition.changed, false);
  assert.equal(transition.execution_result.executorInvoked, true);
  assert.deepEqual(transition.invocation, expected.invocation);
  await unchanged(scene, session, beforeSession, beforeTree);
  return transition;
}

async function assertInspectTransition(scene, session, property, ref, followSymlinks, expected = {}) {
  const beforeSession = scene.sandbox.getSession(session);
  const beforeTree = await treeSnapshot(scene.root);
  const transition = await policyFor(scene, candidate, session).step({
    goal: inspectGoal(property, ref, followSymlinks),
    satisfactionThreshold: expected.satisfactionThreshold ?? 100,
    state: emptyState(session),
  });
  assert.equal(transition.policy.selectedHead, 'entry.inspect');
  assert.equal(transition.policy_error, null);
  assert.equal(transition.status, expected.status ?? 'achieved');
  assert.equal(
    transition.satisfaction,
    Object.hasOwn(expected, 'satisfaction') ? expected.satisfaction : 100,
  );
  assert.equal(transition.invocation?.[0], 'entry.inspect');
  assert.deepEqual(transition.invocation?.[1], ref);
  assert.equal(transition.invocation?.[2], followSymlinks);
  assert.equal(transition.execution_result.executorInvoked, true);
  await unchanged(scene, session, beforeSession, beforeTree);
  return transition;
}

function entryKnowledge(transition) {
  const value = transition.observed_state_after.entryKnowledge;
  assert.ok(value, 'successful inspection must project entryKnowledge');
  assert.equal(value.kind, 'entry.inspect');
  return value;
}

function receiptErrorCode(transition) {
  return transition.execution_result.receipt?.execution?.error?.code ?? null;
}

function registerCase(category, id, title, run) {
  test(`${category} ${id} ${title}`, { timeout: 30000 }, async t => {
    const started = performance.now();
    const row = { category, id, title, result: 'FAIL', detail: null, error: null };
    try {
      row.detail = await run(t);
      row.result = 'PASS';
    } catch (error) {
      row.error = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally {
      row.durationMs = Number((performance.now() - started).toFixed(3));
      rows.push(row);
    }
  });
}

const resolveCases = [
  {
    id: 'S01', title: 'relative input overlays base',
    base: '/i7/base/child', input: '../sibling', absolute: '/i7/base/sibling',
  },
  {
    id: 'S02', title: 'absolute input overrides base',
    base: '/i7/base', input: '/other/../final', absolute: '/final',
  },
  {
    id: 'S03', title: 'dot component remains lexical',
    base: '/i7/base', input: './child', absolute: '/i7/base/child',
  },
  {
    id: 'S04', title: 'trailing slash is normalized lexically',
    base: '/i7/base', input: 'child/', absolute: '/i7/base/child',
  },
  {
    id: 'S05', title: 'parent traversal stops at root',
    base: '/i7/base', input: '../../../../outside', absolute: '/outside',
  },
  {
    id: 'S06', title: 'tilde, home token and glob stay literal',
    base: '/i7/base', input: '~/$HOME/*', absolute: '/i7/base/~/$HOME/*',
  },
  {
    id: 'S07', title: 'space and quote characters stay one path text',
    base: '/i7/base', input: 'with space/"quote"', absolute: '/i7/base/with space/"quote"',
  },
  {
    id: 'S08', title: 'single dot resolves to canonical base text',
    base: '/i7/base/.', input: '.', absolute: '/i7/base',
  },
];

for (const item of resolveCases) {
  registerCase('resolve', item.id, item.title, async () => {
    const scene = await createIndependentScene(api, (() => {
      const afterHooks = [];
      return { after: fn => afterHooks.push(fn), afterHooks };
    })());
    try {
      const base = pathRef(scene.sandbox, scene.primary, item.base);
      const transition = await assertPathTransition(scene, scene.primary, observationGoal(
        'file.property.path.absolute',
        { kind: 'cli.path-query', base, input: item.input },
      ), {
        head: 'path.resolve',
        invocation: ['path.resolve', base, item.input],
      });
      const knowledge = transition.observed_state_after.pathKnowledge;
      assert.equal(knowledge.kind, 'path.resolve');
      assert.equal(knowledge.absolutePath, item.absolute);
      assert.equal(knowledge.parent, posix.dirname(item.absolute));
      assert.equal(Object.hasOwn(knowledge, 'exists'), false);
      return { input: item.input, absolute: knowledge.absolutePath, executor: transition.execution_result.status };
    } finally {
      await scene.cleanup();
    }
  });
}

const relativeCases = [
  ['S09', 'sibling forward', '/i7/a/b', '/i7/a/c', '../c'],
  ['S10', 'sibling inverse', '/i7/a/c', '/i7/a/b', '../b'],
  ['S11', 'same path empty string', '/i7/a/b', '/i7/a/b', ''],
  ['S12', 'descendant to ancestor', '/i7/a/b/c', '/i7/a', '../..'],
  ['S13', 'ancestor to descendant', '/i7/a', '/i7/a/b/c', 'b/c'],
  ['S14', 'cross sibling trees', '/x/a/b', '/y/c/d', '../../../y/c/d'],
  ['S15', 'root to nested path', '/', '/a/b', 'a/b'],
  ['S16', 'nested path to root', '/a/b', '/', '../..'],
];

for (const [id, title, fromPath, toPath, expected] of relativeCases) {
  registerCase('relative', id, title, async () => {
    const scene = await createIndependentScene(api, { after: () => {} });
    try {
      const from = pathRef(scene.sandbox, scene.primary, fromPath);
      const to = pathRef(scene.sandbox, scene.primary, toPath);
      const transition = await assertPathTransition(scene, scene.primary, observationGoal(
        'file.property.path.relative',
        { kind: 'cli.path-query', from, to },
      ), {
        head: 'path.relative',
        invocation: ['path.relative', from, to],
      });
      const knowledge = transition.observed_state_after.pathKnowledge;
      assert.equal(knowledge.kind, 'path.relative');
      assert.equal(knowledge.relativePath, expected);
      return { from: fromPath, to: toPath, relative: knowledge.relativePath };
    } finally {
      await scene.cleanup();
    }
  });
}

const partsCases = [
  ['S17', 'root parts', '/', '/', '', true],
  ['S18', 'normal path parts', '/a/b', '/a', 'b', false],
  ['S19', 'trailing slash parts', '/a/b/', '/a', 'b', false],
  ['S20', 'single segment parts', '/name', '/', 'name', false],
  ['S21', 'nested path parts', '/a/b/c', '/a/b', 'c', false],
  ['S22', 'dotdot remains lexical', '/a/b/../c', '/a/b/..', 'c', false],
  ['S23', 'double slash lexical parts', '/a//b', '/a', 'b', false],
  ['S24', 'trailing single segment parts', '/name/', '/', 'name', false],
];

for (const [id, title, absolute, parent, name, isRoot] of partsCases) {
  registerCase('parts', id, title, async () => {
    const scene = await createIndependentScene(api, { after: () => {} });
    try {
      const ref = rawPathRef(scene, absolute);
      const transition = await assertPathTransition(scene, scene.primary, observationGoal(
        'file.property.path.name',
        ref,
      ), {
        head: 'path.parts',
        invocation: ['path.parts', ref],
      });
      const knowledge = transition.observed_state_after.pathKnowledge;
      assert.equal(knowledge.kind, 'path.parts');
      assert.deepEqual(knowledge.path, ref);
      assert.equal(knowledge.parent, parent);
      assert.equal(knowledge.name, name);
      assert.equal(knowledge.isRoot, isRoot);
      return { path: absolute, parent, name, isRoot };
    } finally {
      await scene.cleanup();
    }
  });
}

registerCase('inspect-reference', 'S25', 'E reference follow=false', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindEntry(scene.primary, scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, false);
    assert.equal(entryKnowledge(transition).type, 'regular');
    assert.equal(entryKnowledge(transition).observedWith, 'lstat');
    return { refKind: ref.kind, type: entryKnowledge(transition).type, followSymlinks: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S26', 'E reference follow=true', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindEntry(scene.primary, scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, true);
    assert.equal(entryKnowledge(transition).type, 'regular');
    assert.equal(entryKnowledge(transition).observedWith, 'stat');
    return { refKind: ref.kind, type: entryKnowledge(transition).type, followSymlinks: true };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S27', 'F reference follow=false', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.size', ref, false);
    assert.equal(entryKnowledge(transition).size, 7);
    return { refKind: ref.kind, size: entryKnowledge(transition).size, followSymlinks: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S28', 'F reference follow=true', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.mode', ref, true);
    assert.equal(entryKnowledge(transition).observedWith, 'stat');
    assert.equal(typeof entryKnowledge(transition).mode, 'number');
    return { refKind: ref.kind, mode: entryKnowledge(transition).mode, followSymlinks: true };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S29', 'D reference follow=false', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindDirectoryObject(scene.primary, scene.paths.directory);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, false);
    assert.equal(entryKnowledge(transition).type, 'directory');
    return { refKind: ref.kind, type: entryKnowledge(transition).type, followSymlinks: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S30', 'D reference follow=true', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindDirectoryObject(scene.primary, scene.paths.directory);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.owner', ref, true);
    const owner = entryKnowledge(transition).owner;
    assert.ok(owner);
    assert.ok(Object.hasOwn(owner, 'uid'));
    assert.ok(Object.hasOwn(owner, 'gid'));
    return { refKind: ref.kind, owner, followSymlinks: true };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S31', 'P reference follow=false symlink', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.link);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, false);
    assert.equal(entryKnowledge(transition).type, 'symlink');
    assert.equal(entryKnowledge(transition).linkTarget, 'file.txt');
    assert.equal(entryKnowledge(transition).observedWith, 'lstat');
    return { refKind: ref.kind, type: entryKnowledge(transition).type, followSymlinks: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-reference', 'S32', 'P reference follow=true resolves target', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.link);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, true);
    assert.equal(entryKnowledge(transition).type, 'regular');
    assert.equal(entryKnowledge(transition).observedWith, 'stat');
    return { refKind: ref.kind, type: entryKnowledge(transition).type, followSymlinks: true };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S33', 'exists is an observed boolean', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.missing);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.exists', ref, false);
    assert.equal(transition.evidence.value, false);
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.entryExists, false);
    assert.equal(knowledge.resolvedTargetExists, null);
    return { exists: false, entryExists: knowledge.entryExists };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S34', 'type covers available native classes', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const cases = [
      ['regular', scene.paths.file],
      ['directory', scene.paths.directory],
      ['symlink', scene.paths.link],
      ['fifo', scene.paths.fifo],
      ...(scene.socketAvailable ? [['socket', scene.paths.socket]] : []),
    ];
    if (!scene.socketAvailable) {
      unverified.push('socket: Unix-domain socket listen returned EPERM in this execution sandbox');
    }
    const observed = {};
    for (const [expected, absolute] of cases) {
      const ref = pathRef(scene.sandbox, scene.primary, absolute);
      const transition = await assertInspectTransition(scene, scene.primary, 'file.property.type', ref, false);
      assert.equal(transition.evidence.value, expected);
      assert.equal(entryKnowledge(transition).type, expected);
      observed[expected] = entryKnowledge(transition).type;
    }
    return observed;
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S35', 'size is exact OS length', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.size', ref, false);
    assert.equal(transition.evidence.value, 7);
    assert.equal(entryKnowledge(transition).size, 7);
    return { size: entryKnowledge(transition).size };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S36', 'mode preserves POSIX permission bits', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const expected = (await lstat(scene.paths.file)).mode;
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.mode', ref, false);
    assert.equal(entryKnowledge(transition).mode, expected);
    assert.equal(transition.evidence.value, expected);
    return { mode: entryKnowledge(transition).mode, permissions: expected & 0o7777 };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S37', 'owner returns uid and gid', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const expected = await lstat(scene.paths.file);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.owner', ref, false);
    assert.deepEqual(entryKnowledge(transition).owner, { uid: expected.uid, gid: expected.gid });
    assert.deepEqual(transition.evidence.value, { uid: expected.uid, gid: expected.gid });
    return entryKnowledge(transition).owner;
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S38', 'times preserve observed OS epochs', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const expected = await lstat(scene.paths.file, { bigint: true });
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.times', ref, false);
    const times = entryKnowledge(transition).times;
    assert.ok(times);
    assert.equal(times.atimeMs, Number(expected.atimeMs));
    assert.equal(times.mtimeMs, Number(expected.mtimeMs));
    assert.equal(times.ctimeMs, Number(expected.ctimeMs));
    assert.ok(times.birthtimeMs === null || times.birthtimeMs === Number(expected.birthtimeMs));
    return times;
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S39', 'link.target returns raw text only for links', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const linkRef = pathRef(scene.sandbox, scene.primary, scene.paths.link);
    const linked = await assertInspectTransition(scene, scene.primary, 'file.property.link.target', linkRef, false);
    assert.equal(linked.evidence.value, 'file.txt');
    assert.equal(entryKnowledge(linked).linkTarget, 'file.txt');

    const fileRef = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const regular = await assertInspectTransition(scene, scene.primary, 'file.property.link.target', fileRef, false, {
      status: 'unknown',
      satisfaction: null,
    });
    assert.equal(regular.reason, 'attribute_not_applicable');
    assert.equal(entryKnowledge(regular).linkTarget, null);
    return { link: 'file.txt', regular: null };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-property', 'S40', 'entry.identity keeps dev, ino, nlink and rdev', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const expected = await lstat(scene.paths.file, { bigint: true });
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.entry.identity', ref, false);
    const identity = entryKnowledge(transition).identity;
    const osInteger = value => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    assert.deepEqual(identity, {
      dev: osInteger(expected.dev),
      ino: osInteger(expected.ino),
      nlink: osInteger(expected.nlink),
      rdev: osInteger(expected.rdev),
    });
    assert.notEqual(identity.rdev, null);
    return identity;
  } finally {
    await scene.cleanup();
  }
});

registerCase('realpath', 'S41', 'path.realpath on P reference with symlinked ancestor and dotdot', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, join(scene.paths.dirLink, '..', 'nested', 'deep.txt'));
    const transition = await assertPathTransition(
      scene,
      scene.primary,
      observationGoal('file.property.path.physical', ref),
      { head: 'path.realpath', invocation: ['path.realpath', ref] },
    );
    const knowledge = transition.observed_state_after.pathKnowledge;
    assert.equal(knowledge.kind, 'path.realpath');
    assert.equal(knowledge.physicalPath, scene.paths.deepFile);
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, true);
    assert.equal(knowledge.errno, null);
    assert.notEqual(knowledge.resolvedIdentity.dev, null);
    assert.notEqual(knowledge.resolvedIdentity.ino, null);
    assert.equal(transition.evidence.value, scene.paths.deepFile);
    return { refKind: ref.kind, physicalPath: knowledge.physicalPath };
  } finally {
    await scene.cleanup();
  }
});

registerCase('realpath', 'S42', 'path.realpath on E reference for 2-hop symlink resolves final file', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindEntry(scene.primary, scene.paths.hopLink);
    const transition = await assertPathTransition(
      scene,
      scene.primary,
      observationGoal('file.property.path.physical', ref),
      { head: 'path.realpath', invocation: ['path.realpath', ref] },
    );
    const knowledge = transition.observed_state_after.pathKnowledge;
    assert.equal(knowledge.kind, 'path.realpath');
    assert.equal(knowledge.physicalPath, scene.paths.file);
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, true);
    assert.equal(knowledge.errno, null);
    assert.equal(transition.evidence.value, scene.paths.file);
    return { refKind: ref.kind, physicalPath: knowledge.physicalPath };
  } finally {
    await scene.cleanup();
  }
});

registerCase('realpath', 'S43', 'path.realpath on observed D reference resolves physical directory', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindDirectoryObject(scene.primary, scene.paths.nested);
    const transition = await assertPathTransition(
      scene,
      scene.primary,
      observationGoal('file.property.path.physical', ref),
      { head: 'path.realpath', invocation: ['path.realpath', ref] },
    );
    const knowledge = transition.observed_state_after.pathKnowledge;
    assert.equal(knowledge.kind, 'path.realpath');
    assert.equal(knowledge.physicalPath, scene.paths.nested);
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, true);
    assert.equal(knowledge.errno, null);
    assert.equal(transition.evidence.value, scene.paths.nested);
    return { refKind: ref.kind, physicalPath: knowledge.physicalPath };
  } finally {
    await scene.cleanup();
  }
});

registerCase('realpath', 'S44', 'path.realpath on F reference resolves physical regular file', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.deepFile);
    const transition = await assertPathTransition(
      scene,
      scene.primary,
      observationGoal('file.property.path.physical', ref),
      { head: 'path.realpath', invocation: ['path.realpath', ref] },
    );
    const knowledge = transition.observed_state_after.pathKnowledge;
    assert.equal(knowledge.kind, 'path.realpath');
    assert.equal(knowledge.physicalPath, scene.paths.deepFile);
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, true);
    assert.equal(knowledge.errno, null);
    assert.equal(transition.evidence.value, scene.paths.deepFile);
    return { refKind: ref.kind, physicalPath: knowledge.physicalPath };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-resolved-target', 'S45', 'resolvedTarget follow=true on valid file symlink achieves targetType regular', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.link);
    const transition = await policyFor(scene).step({
      goal: resolvedTargetGoal(ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'achieved');
    assert.equal(transition.satisfaction, 100);
    assert.equal(transition.reason, 'resolved_target_observed');
    assert.deepEqual(transition.invocation, ['entry.inspect', ref, true]);
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(transition.evidence.value?.resolvedTargetExists, true);
    assert.equal(transition.evidence.value?.targetType, 'regular');
    assert.notEqual(transition.evidence.value?.targetIdentity?.dev, null);
    assert.notEqual(transition.evidence.value?.targetIdentity?.ino, null);
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.type, 'regular');
    assert.equal(knowledge.observedWith, 'stat');
    assert.equal(knowledge.resolvedTargetExists, true);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return transition.evidence.value;
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-resolved-target', 'S46', 'resolvedTarget follow=true on directory symlink E reference achieves targetType directory', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = await scene.sandbox.bindEntry(scene.primary, scene.paths.dirLink);
    const transition = await policyFor(scene).step({
      goal: resolvedTargetGoal(ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'achieved');
    assert.equal(transition.satisfaction, 100);
    assert.equal(transition.reason, 'resolved_target_observed');
    assert.deepEqual(transition.invocation, ['entry.inspect', ref, true]);
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(transition.evidence.value?.resolvedTargetExists, true);
    assert.equal(transition.evidence.value?.targetType, 'directory');
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.type, 'directory');
    assert.equal(knowledge.observedWith, 'stat');
    assert.equal(knowledge.resolvedTargetExists, true);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return transition.evidence.value;
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-resolved-target', 'S47', 'resolvedTarget follow=true on broken symlink returns unmet/0 after real execution', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.brokenLink);
    const transition = await policyFor(scene).step({
      goal: resolvedTargetGoal(ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'unmet');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.reason, 'resolved_target_missing');
    assert.deepEqual(transition.invocation, ['entry.inspect', ref, true]);
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(transition.evidence.errno, 'ENOENT');
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, false);
    assert.equal(knowledge.type, null);
    assert.equal(knowledge.errno, 'ENOENT');
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return { status: transition.status, satisfaction: transition.satisfaction, errno: knowledge.errno };
  } finally {
    await scene.cleanup();
  }
});

registerCase('inspect-resolved-target', 'S48', 'paired same-link observe.inspect follow=false achieves raw linkTarget', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindEntry(scene.primary, scene.paths.dirLink);
    const transition = await assertInspectTransition(scene, scene.primary, 'file.property.link.target', ref, false);
    assert.equal(transition.evidence.value, 'nested');
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.type, 'symlink');
    assert.equal(knowledge.linkTarget, 'nested');
    assert.equal(knowledge.observedWith, 'lstat');
    return { linkTarget: knowledge.linkTarget, observedWith: knowledge.observedWith };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P01', 'broken target keeps ENOENT and no pseudo type', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.brokenLink);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.errno, 'ENOENT');
    assert.equal(knowledge.entryExists, true);
    assert.equal(knowledge.resolvedTargetExists, false);
    assert.equal(knowledge.type, null);
    return { errno: knowledge.errno, entryExists: true, resolvedTargetExists: false, type: null };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P02', 'symlink loop fails ELOOP without fake type', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.loopA);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    assert.equal(receiptErrorCode(transition), 'ELOOP');
    assert.equal(transition.observed_state_after.entryKnowledge ?? null, null);
    return { errno: 'ELOOP', type: null };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P03', 'ENOTDIR stays distinct from ENOENT', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const notDirectoryRef = pathRef(scene.sandbox, scene.primary, join(scene.paths.file, 'child'));
    const notDirectory = await policyFor(scene).step({
      goal: inspectGoal('file.property.exists', notDirectoryRef, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(notDirectory.status, 'failed');
    assert.equal(notDirectory.satisfaction, 0);
    assert.equal(receiptErrorCode(notDirectory), 'ENOTDIR');
    assert.equal(notDirectory.observed_state_after.entryKnowledge ?? null, null);

    const missingRef = pathRef(scene.sandbox, scene.primary, scene.paths.missing);
    const missing = await policyFor(scene).step({
      goal: inspectGoal('file.property.exists', missingRef, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(missing.status, 'achieved');
    assert.equal(missing.satisfaction, 100);
    assert.equal(missing.evidence.value, false);
    assert.equal(receiptErrorCode(missing), null);
    return { notDirectory: 'ENOTDIR', missing: 'known false exists' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P04', 'missing filesystem.read denies before observation', async () => {
  const scene = await createIndependentScene(api, { after: () => {} }, {
    grants: ['process.exec', 'session.write'],
  });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', ref, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(receiptErrorCode(transition), 'EFFECT_DENIED');
    assert.equal(transition.execution_result.receipt?.execution?.error?.stage, 'authorize');
    assert.equal(transition.execution_result.receipt?.execution?.observation, undefined);
    return { error: 'EFFECT_DENIED', stage: 'authorize', executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P05', 'cross-session reference rejects as TypeError', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    const beforeSecondary = scene.sandbox.getSession(scene.secondary);
    const beforeTree = await treeSnapshot(scene.root);
    await assert.rejects(
      policyFor(scene, candidate, scene.secondary).step({
        goal: inspectGoal('file.property.type', ref, false),
        satisfactionThreshold: 100,
        state: emptyState(scene.secondary),
      }),
      TypeError,
    );
    await unchanged(scene, scene.secondary, beforeSecondary, beforeTree);
    return { boundary: 'TypeError before execution' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P06', 'older session revision is rejected', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    const destination = await scene.sandbox.bindDirectory(scene.primary, 'dir');
    const moved = await scene.sandbox.execute({
      operation: 'cwd.set',
      parameters: { session: scene.primary, directory: destination },
    });
    assert.equal(moved.execution.status, 'succeeded');
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', ref, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(receiptErrorCode(transition), 'STALE_REFERENCE');
    return { error: 'STALE_REFERENCE', revision: scene.sandbox.getSession(scene.primary).revision };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P07', 'forged sourceRun is rejected', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    const forged = { ...ref, sourceRun: 'forged-source-run' };
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', forged, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.ok(transition.status === 'failed' || transition.status === 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(receiptErrorCode(transition), 'binding_identity_missing');
    return { status: transition.status, error: 'binding_identity_missing' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P08', 'non-absolute path and NUL text reject as TypeError', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const policy = policyFor(scene);
    await assert.rejects(policy.step({
      goal: observationGoal('file.property.path.absolute', {
        kind: 'cli.path-query',
        base: { kind: 'cli.path', scenarioId: scene.scenarioId, sessionId: scene.primary.sessionId, path: 'relative' },
        input: 'child',
      }),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    }), TypeError);
    const base = pathRef(scene.sandbox, scene.primary, '/i7/base');
    await assert.rejects(policy.step({
      goal: observationGoal('file.property.path.absolute', {
        kind: 'cli.path-query',
        base,
        input: 'bad\0input',
      }),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    }), TypeError);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { nonAbsolute: 'TypeError', nul: 'TypeError' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P09', 'big OS integer size keeps decimal digits', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const size = 9007199254740993n;
    await scene.makeSparseFile(size);
    const actual = await lstat(scene.paths.bigFile, { bigint: true });
    assert.equal(actual.size, size);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.bigFile);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.size', ref, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'achieved');
    assert.equal(transition.satisfaction, 100);
    assert.equal(transition.evidence.value, '9007199254740993');
    assert.equal(entryKnowledge(transition).size, '9007199254740993');
    return {
      size: entryKnowledge(transition).size,
      unverified: 'synthetic dev/ino injection has no public hook',
    };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P10', 'unregistered property and predicate pair is unsupported', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const from = pathRef(scene.sandbox, scene.primary, '/a');
    const to = pathRef(scene.sandbox, scene.primary, '/b');
    const transition = await policyFor(scene).step({
      goal: {
        kind: 'file.property',
        property: 'file.property.path.relative',
        target: { kind: 'cli.path-query', from, to },
        requirement: { kind: 'equals', expected: '../b' },
      },
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'unsupported');
    assert.deepEqual(transition.policy.scores, new Array(candidate.heads.length).fill(0));
    assert.deepEqual(transition.policy.probabilities, new Array(candidate.heads.length).fill(0));
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'unknown');
    assert.equal(transition.satisfaction, null);
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.status, 'unsupported');
    assert.equal(transition.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { head: 'unsupported', satisfaction: null, executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P11', 'read-only physical path applies to special entry types', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    for (const type of ['fifo', 'socket', 'character_device', 'block_device', 'other']) {
      assert.equal(api.evaluateOperationApplicability(type, 'path.realpath'), 'appropriate');
    }
    return { operation: 'path.realpath', types: 'read-only-special' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P12', 'registered property with wrong target shape rejects', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    await assert.rejects(policyFor(scene).step({
      goal: observationGoal('file.property.exists', ref),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    }), TypeError);
    await assert.rejects(policyFor(scene).step({
      goal: observationGoal('file.property.path.absolute', entryQuery(ref, false)),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    }), TypeError);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { existsTarget: 'TypeError', absoluteTarget: 'TypeError' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P13', 'zero threshold does not skip missing facts', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.missing);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.type', ref, false),
      satisfactionThreshold: 0,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(entryKnowledge(transition).type, null);
    return { threshold: 0, status: 'failed', satisfaction: 0, executorInvoked: true };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P14', 'forged old knowledge is not fresh and re-executes', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const base = pathRef(scene.sandbox, scene.primary, '/i7/base');
    const goal = observationGoal('file.property.path.absolute', {
      kind: 'cli.path-query',
      base,
      input: '../truth',
    });
    const policy = policyFor(scene);
    const first = await policy.step({
      goal,
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(first.status, 'achieved');
    const forged = structuredClone(first.observed_state_after);
    forged.pathKnowledge.absolutePath = '/forged';
    forged.pathKnowledge.sourceRun = 'forged-source-run';
    const repeated = await policy.step({
      goal,
      satisfactionThreshold: 100,
      state: forged,
    });
    assert.equal(repeated.policy.selectedHead, 'path.resolve');
    assert.equal(repeated.execution_result.executorInvoked, true);
    assert.equal(repeated.observed_state_after.pathKnowledge.absolutePath, '/i7/truth');
    assert.notEqual(repeated.observed_state_after.pathKnowledge.sourceRun, first.observed_state_after.pathKnowledge.sourceRun);
    return {
      absolute: repeated.observed_state_after.pathKnowledge.absolutePath,
      executorInvoked: repeated.execution_result.executorInvoked,
    };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P15', 'fresh satisfied goal is NOOP with no side effect', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const policy = policyFor(scene);
    const observed = await policy.step({
      goal: cwdObservedGoal(scene.primary),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(observed.policy.selectedHead, 'pwd');
    assert.equal(observed.status, 'achieved');
    const directory = await scene.sandbox.bindDirectory(scene.primary, '.');
    const transition = await policy.step({
      goal: cwdEqualsGoal(scene.primary, directory),
      satisfactionThreshold: 100,
      state: observed.observed_state_after,
    });
    assert.equal(transition.policy.selectedHead, 'NOOP');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'achieved');
    assert.equal(transition.satisfaction, 100);
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.status, 'noop');
    assert.equal(transition.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { head: 'NOOP', satisfaction: 100, executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P16', 'guard preserves unexpected_head and policy_error', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const base = pathRef(scene.sandbox, scene.primary, '/i7/base');
    const wrong = forcedHeadProfile('cd');
    const transition = await policyFor(scene, wrong).step({
      goal: observationGoal('file.property.path.absolute', {
        kind: 'cli.path-query',
        base,
        input: '../x',
      }),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'cd');
    assert.deepEqual(transition.policy_error, { expectedHead: 'path.resolve', selectedHead: 'cd' });
    assert.equal(transition.status, 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.reason, 'unexpected_head');
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.status, 'rejected');
    assert.equal(transition.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { selected: 'cd', expected: 'path.resolve', reason: 'unexpected_head' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P17', 'path.realpath on circular symlink fails with ELOOP and no fake physicalPath', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.loopA);
    const transition = await policyFor(scene).step({
      goal: observationGoal('file.property.path.physical', ref),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'path.realpath');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.reason, 'physical_path_unavailable');
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(receiptErrorCode(transition), 'ELOOP');
    assert.equal(transition.observed_state_after.pathKnowledge ?? null, null);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { errno: 'ELOOP', status: transition.status, satisfaction: transition.satisfaction };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P18', 'path.realpath on dangling symlink fails with ENOENT and no fake physicalPath', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.brokenLink);
    const transition = await policyFor(scene).step({
      goal: observationGoal('file.property.path.physical', ref),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'path.realpath');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.reason, 'physical_path_unavailable');
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(receiptErrorCode(transition), 'ENOENT');
    assert.equal(transition.observed_state_after.pathKnowledge ?? null, null);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { errno: 'ENOENT', status: transition.status, satisfaction: transition.satisfaction };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P19', 'path.realpath on replaced inode rejects as STALE_REFERENCE before helper execution', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = await scene.sandbox.bindFile(scene.primary, scene.paths.file);
    await rm(scene.paths.file);
    await writeFile(scene.paths.file, 'replaced-payload');
    const transition = await policyFor(scene).step({
      goal: observationGoal('file.property.path.physical', ref),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'path.realpath');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(receiptErrorCode(transition), 'STALE_REFERENCE');
    return { error: 'STALE_REFERENCE', status: transition.status, executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P20', 'resolvedTarget follow=true on missing path fails with ENOENT vs broken symlink unmet/0', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const missingRef = pathRef(scene.sandbox, scene.primary, scene.paths.missing);
    const missingTransition = await policyFor(scene).step({
      goal: resolvedTargetGoal(missingRef, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(missingTransition.policy.selectedHead, 'entry.inspect');
    assert.equal(missingTransition.status, 'unmet');
    assert.equal(missingTransition.satisfaction, 0);
    assert.equal(missingTransition.reason, 'resolved_target_missing');
    assert.equal(missingTransition.execution_result.executorInvoked, true);
    assert.equal(entryKnowledge(missingTransition).entryExists, false);
    assert.equal(entryKnowledge(missingTransition).errno, 'ENOENT');

    const brokenRef = pathRef(scene.sandbox, scene.primary, scene.paths.brokenLink);
    const brokenTransition = await policyFor(scene).step({
      goal: resolvedTargetGoal(brokenRef, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(brokenTransition.policy.selectedHead, 'entry.inspect');
    assert.equal(brokenTransition.status, 'unmet');
    assert.equal(brokenTransition.satisfaction, 0);
    assert.equal(brokenTransition.reason, 'resolved_target_missing');
    assert.equal(brokenTransition.execution_result.executorInvoked, true);
    assert.equal(entryKnowledge(brokenTransition).entryExists, true);
    assert.equal(entryKnowledge(brokenTransition).resolvedTargetExists, false);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { missingEntryExists: false, brokenEntryExists: true, status: 'unmet' };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P21', 'resolvedTarget with illegal followSymlinks=false rejects at bind without invoking executor', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.link);
    const transition = await policyFor(scene).step({
      goal: resolvedTargetGoal(ref, false),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'rejected');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.reason, 'resolved_target_requires_follow_symlinks');
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.status, 'rejected');
    assert.equal(transition.execution_result.executorInvoked, false);
    assert.equal(transition.observed_state_after.entryKnowledge ?? null, null);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { status: transition.status, reason: transition.reason, executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P22', 'resolvedTarget follow=true on regular file executes and evaluates to unknown/null attribute_not_applicable', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const transition = await policyFor(scene).step({
      goal: resolvedTargetGoal(ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'unknown');
    assert.equal(transition.satisfaction, null);
    assert.equal(transition.reason, 'attribute_not_applicable');
    assert.deepEqual(transition.invocation, ['entry.inspect', ref, true]);
    assert.equal(transition.execution_result.executorInvoked, true);
    const knowledge = entryKnowledge(transition);
    assert.equal(knowledge.type, 'regular');
    assert.equal(knowledge.observedWith, 'stat');
    await unchanged(scene, scene.primary, before, beforeTree);
    return { status: transition.status, satisfaction: transition.satisfaction, reason: transition.reason };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P23', 'entry.inspect exists follow=true on circular symlink fails with ELOOP and does not fabricate exists=false', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const before = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.loopA);
    const transition = await policyFor(scene).step({
      goal: inspectGoal('file.property.exists', ref, true),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'entry.inspect');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'failed');
    assert.equal(transition.satisfaction, 0);
    assert.equal(transition.execution_result.executorInvoked, true);
    assert.equal(receiptErrorCode(transition), 'ELOOP');
    assert.equal(transition.evidence.value, undefined);
    assert.equal(transition.observed_state_after.entryKnowledge ?? null, null);
    await unchanged(scene, scene.primary, before, beforeTree);
    return { errno: 'ELOOP', status: transition.status, satisfaction: transition.satisfaction };
  } finally {
    await scene.cleanup();
  }
});

function entrySelectGoal(target, name, type, parent, cardinality = 'one') {
  return Object.freeze({
    kind: 'file.property',
    property: 'file.property.directory.entries',
    target,
    requirement: Object.freeze({
      kind: 'matches',
      predicate: Object.freeze({
        kind: 'entrySelector',
        selector: Object.freeze({
          name,
          parent,
          ...(type === undefined ? {} : { type }),
        }),
        cardinality,
      }),
    }),
  });
}

async function setupSelectSandbox(scene, session = scene.primary) {
  const authority = api.createEvidenceAuthority();
  const targetRef = await scene.sandbox.bindDirectory(session, '../sibling/select-sandbox');
  const parentPhysical = scene.paths.selectSandbox;
  const lsPolicy = policyFor(scene, forcedHeadProfile('ls'), session, authority);
  const lsStep = await lsPolicy.step({
    goal: observationGoal('file.property.directory.entries', targetRef),
    satisfactionThreshold: 100,
    state: emptyState(session),
  });
  assert.equal(lsStep.status, 'achieved');
  assert.equal(lsStep.satisfaction, 100);
  return {
    authority,
    targetRef,
    parentPhysical,
    listingState: lsStep.observed_state_after,
  };
}

const stage2PositiveScenarios = [
  ['S49', 'directory.select unique match on humanagent', 'directory', 'humanagent', 'directory.select'],
  ['S50', 'directory.select unique match on directory with spaces', 'directory', 'with space dir', 'directory.select'],
  ['S51', 'directory.select unique match on directory with single quote', 'directory', "quote'dir", 'directory.select'],
  ['S52', 'directory.select unique match on dot-prefixed directory', 'directory', '.hidden-dir', 'directory.select'],
  ['S53', 'file.select unique match on notes.txt', 'regular', 'notes.txt', 'file.select'],
  ['S54', 'file.select unique match on empty regular file', 'regular', 'empty.bin', 'file.select'],
  ['S55', 'file.select unique match on regular file with spaces', 'regular', 'with space.txt', 'file.select'],
  ['S56', 'file.select unique match on dot-prefixed regular file', 'regular', '.hidden-file', 'file.select'],
];

for (const [id, title, targetType, selectorName, expectedHead] of stage2PositiveScenarios) {
  registerCase('entry-select', id, title, async () => {
    const scene = await createIndependentScene(api, { after: () => {} });
    try {
      const beforeSession = scene.sandbox.getSession(scene.primary);
      const beforeTree = await treeSnapshot(scene.root);
      const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
      const transition = await policyFor(scene, candidate, scene.primary, authority).step({
        goal: entrySelectGoal(targetRef, selectorName, targetType, parentPhysical),
        satisfactionThreshold: 100,
        state: listingState,
      });
      assert.equal(transition.policy.selectedHead, expectedHead);
      assert.equal(transition.policy_error, null);
      assert.equal(transition.status, 'achieved');
      assert.equal(transition.satisfaction, 100);
      assert.equal(transition.reason, 'entry_selected');
      assert.equal(transition.execution_result.executorInvoked, true);
      assert.equal(transition.observed_state_after.entrySelection?.outcome, 'selected');
      assert.equal(transition.observed_state_after.entrySelection?.ref, join(parentPhysical, selectorName));
      await unchanged(scene, scene.primary, beforeSession, beforeTree);
      return {
        head: transition.policy.selectedHead,
        status: transition.status,
        ref: transition.observed_state_after.entrySelection?.ref,
      };
    } finally {
      await scene.cleanup();
    }
  });
}

const stage2NotFoundScenarios = [
  ['S57', 'directory.select when target name is absent', 'directory', 'absent-dir', 'directory.select'],
  ['S58', 'file.select when target name is absent', 'regular', 'absent-file.txt', 'file.select'],
  ['S59', 'directory.select when matching name is a regular file', 'directory', 'notes.txt', 'directory.select'],
  ['S60', 'file.select when matching name is a directory', 'regular', 'humanagent', 'file.select'],
  ['S61', 'directory.select when matching name is a symlink', 'directory', 'link-to-dir', 'directory.select'],
  ['S62', 'file.select when matching name is a symlink or FIFO', 'regular', 'link-to-file', 'file.select'],
];

for (const [id, title, targetType, selectorName, expectedHead] of stage2NotFoundScenarios) {
  registerCase('entry-select', id, title, async () => {
    const scene = await createIndependentScene(api, { after: () => {} });
    try {
      const beforeSession = scene.sandbox.getSession(scene.primary);
      const beforeTree = await treeSnapshot(scene.root);
      const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
      const transition = await policyFor(scene, candidate, scene.primary, authority).step({
        goal: entrySelectGoal(targetRef, selectorName, targetType, parentPhysical),
        satisfactionThreshold: 100,
        state: listingState,
      });
      assert.equal(transition.policy.selectedHead, expectedHead);
      assert.equal(transition.policy_error, null);
      assert.equal(transition.status, 'unmet');
      assert.equal(transition.satisfaction, 0);
      assert.equal(transition.reason, 'entry_not_found');
      assert.equal(transition.execution_result.executorInvoked, true);
      assert.equal(transition.observed_state_after.entrySelection?.outcome, 'not_found');
      assert.equal(transition.observed_state_after.entrySelection?.ref, null);
      if (id === 'S62') {
        const fifoTransition = await policyFor(scene, candidate, scene.primary, authority).step({
          goal: entrySelectGoal(targetRef, 'select-fifo', 'regular', parentPhysical),
          satisfactionThreshold: 100,
          state: listingState,
        });
        assert.equal(fifoTransition.policy.selectedHead, 'file.select');
        assert.equal(fifoTransition.status, 'unmet');
        assert.equal(fifoTransition.satisfaction, 0);
        assert.equal(fifoTransition.reason, 'entry_not_found');
      }
      await unchanged(scene, scene.primary, beforeSession, beforeTree);
      return {
        head: transition.policy.selectedHead,
        status: transition.status,
        reason: transition.reason,
      };
    } finally {
      await scene.cleanup();
    }
  });
}

const stage2NoopScenarios = [
  ['S63', 'directory.select repeated on already-satisfied entrySelection state at same session revision', 'directory', 'humanagent', 'directory.select'],
  ['S64', 'file.select repeated on already-satisfied entrySelection state at same session revision', 'regular', 'notes.txt', 'file.select'],
];

for (const [id, title, targetType, selectorName, firstHead] of stage2NoopScenarios) {
  registerCase('entry-select', id, title, async () => {
    const scene = await createIndependentScene(api, { after: () => {} });
    try {
      const beforeSession = scene.sandbox.getSession(scene.primary);
      const beforeTree = await treeSnapshot(scene.root);
      const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
      const policy = policyFor(scene, candidate, scene.primary, authority);
      const goal = entrySelectGoal(targetRef, selectorName, targetType, parentPhysical);
      const first = await policy.step({
        goal,
        satisfactionThreshold: 100,
        state: listingState,
      });
      assert.equal(first.policy.selectedHead, firstHead);
      assert.equal(first.status, 'achieved');
      assert.equal(first.satisfaction, 100);

      const repeated = await policy.step({
        goal,
        satisfactionThreshold: 100,
        state: first.observed_state_after,
      });
      assert.equal(repeated.policy.selectedHead, 'NOOP');
      assert.equal(repeated.policy_error, null);
      assert.equal(repeated.status, 'achieved');
      assert.equal(repeated.satisfaction, 100);
      assert.equal(repeated.reason, 'already_satisfied');
      assert.equal(repeated.invocation, null);
      assert.equal(repeated.execution_result.status, 'noop');
      assert.equal(repeated.execution_result.executorInvoked, false);
      await unchanged(scene, scene.primary, beforeSession, beforeTree);
      return {
        firstHead: first.policy.selectedHead,
        repeatedHead: repeated.policy.selectedHead,
        reason: repeated.reason,
      };
    } finally {
      await scene.cleanup();
    }
  });
}

registerCase('probe', 'P24', 'P3-PROBE-INVALID-NAME rejects invalid selector.name or non-absolute selector.parent at bind', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const policy = policyFor(scene, candidate, scene.primary, authority);
    for (const badName of ['', '.', '..', 'a/b', 'a\0b']) {
      const res = await policy.step({
        goal: entrySelectGoal(targetRef, badName, 'directory', parentPhysical),
        satisfactionThreshold: 100,
        state: listingState,
      });
      assert.equal(res.status, 'rejected');
      assert.equal(res.satisfaction, 0);
      assert.equal(res.reason, 'invalid_entry_selector');
      assert.equal(res.invocation, null);
      assert.equal(res.execution_result.executorInvoked, false);
    }
    const nonAbsoluteParent = await policy.step({
      goal: entrySelectGoal(targetRef, 'humanagent', 'directory', 'relative/parent'),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(nonAbsoluteParent.status, 'rejected');
    assert.equal(nonAbsoluteParent.satisfaction, 0);
    assert.equal(nonAbsoluteParent.reason, 'invalid_entry_selector');
    assert.equal(nonAbsoluteParent.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return { status: 'rejected', reason: 'invalid_entry_selector', executorInvoked: false };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P25', 'P3-PROBE-INVALID-CARDINALITY and selector_parent_mismatch reject at bind', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const policy = policyFor(scene, candidate, scene.primary, authority);
    const badCardinality = await policy.step({
      goal: entrySelectGoal(targetRef, 'humanagent', 'directory', parentPhysical, 'all'),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(badCardinality.status, 'rejected');
    assert.equal(badCardinality.satisfaction, 0);
    assert.equal(badCardinality.reason, 'invalid_selector_cardinality');
    assert.equal(badCardinality.execution_result.executorInvoked, false);

    const parentMismatch = await policy.step({
      goal: entrySelectGoal(targetRef, 'humanagent', 'directory', scene.paths.start),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(parentMismatch.status, 'rejected');
    assert.equal(parentMismatch.satisfaction, 0);
    assert.equal(parentMismatch.reason, 'selector_parent_mismatch');
    assert.equal(parentMismatch.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return { cardinality: badCardinality.reason, mismatch: parentMismatch.reason };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P26', 'P3-PROBE-UNSUPPORTED-SYMLINK-TYPE routes selector.type symlink to unsupported', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const transition = await policyFor(scene, candidate, scene.primary, authority).step({
      goal: entrySelectGoal(targetRef, 'link-to-dir', 'symlink', parentPhysical),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(transition.policy.selectedHead, 'unsupported');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'unknown');
    assert.equal(transition.satisfaction, null);
    assert.equal(transition.reason, 'unsupported_property');
    assert.equal(transition.evidence.selectorTargetType, 'unsupported_selector_target_type');
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return { head: transition.policy.selectedHead, detail: transition.evidence.selectorTargetType };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P27', 'P3-PROBE-UNSPECIFIED-TYPE routes omitted selector.type to unsupported', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const beforeSession = scene.sandbox.getSession(scene.primary);
    const beforeTree = await treeSnapshot(scene.root);
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const transition = await policyFor(scene, candidate, scene.primary, authority).step({
      goal: entrySelectGoal(targetRef, 'humanagent', undefined, parentPhysical),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(transition.policy.selectedHead, 'unsupported');
    assert.equal(transition.policy_error, null);
    assert.equal(transition.status, 'unknown');
    assert.equal(transition.satisfaction, null);
    assert.equal(transition.reason, 'unsupported_property');
    assert.equal(transition.evidence.selectorTargetType, 'selector_target_type_unspecified');
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.executorInvoked, false);
    await unchanged(scene, scene.primary, beforeSession, beforeTree);
    return { head: transition.policy.selectedHead, detail: transition.evidence.selectorTargetType };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P28', 'P3-PROBE-PARTIAL-COVERAGE verifies direct B partial precedence and outer complete->select->partial->defer invalidation', async () => {
  // (a) Direct unit B with coverage === 'partial' across |M| === 0, |M| === 1, and |M| > 1
  const selector = { name: 'humanagent', type: 'directory', parent: '/p' };
  const zeroMatch = resolveEntrySelectSet(
    selector,
    [{ ref: '/p/alpha', path: '/p/alpha', name: 'alpha', type: 'directory', parent: '/p' }],
    'partial',
    entrySelectProfiles.directory,
  );
  const oneMatch = resolveEntrySelectSet(
    selector,
    [{ ref: '/p/humanagent', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' }],
    'partial',
    entrySelectProfiles.directory,
  );
  const multiMatch = resolveEntrySelectSet(
    selector,
    [
      { ref: '/p/alpha', path: '/p/alpha', name: 'alpha', type: 'directory', parent: '/p' },
      { ref: '/p/humanagent', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' },
    ],
    'partial',
    zeroEntrySelectProfile('directory'),
  );
  for (const res of [zeroMatch, oneMatch, multiMatch]) {
    assert.equal(res.outcome, 'insufficient_evidence');
    assert.equal(res.reason, 'coverage_partial');
    assert.equal(res.ref, null);
  }

  // (b) Outer cli-file-property workflow: complete ls -> select.entry (achieved/100) -> same-directory partial ls -> select.entry (DEFER)
  let returnPartial = false;
  const scene = await createIndependentScene(api, { after: () => {} }, {
    listingObserver: async input => {
      const result = await api.runDirectoryListHelper(input);
      if (!result.ok || !returnPartial) return result;
      const physicalDirectory = result.observation.physicalDirectory;
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: 'partial',
          entries: [
            ...result.observation.entries,
            { name: 'flaky', path: join(physicalDirectory, 'flaky'), type: 'unknown' },
          ],
          errors: [{ name: 'flaky', code: 'EIO', message: 'synthetic partial probe' }],
        },
      };
    },
  });
  try {
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const policy = policyFor(scene, candidate, scene.primary, authority);
    const selectGoal = entrySelectGoal(targetRef, 'humanagent', 'directory', parentPhysical);
    const selectedStep = await policy.step({
      goal: selectGoal,
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(selectedStep.policy.selectedHead, 'directory.select');
    assert.equal(selectedStep.status, 'achieved');
    assert.equal(selectedStep.satisfaction, 100);
    assert.equal(selectedStep.observed_state_after.entrySelection?.outcome, 'selected');

    returnPartial = true;
    const lsPolicy = policyFor(scene, forcedHeadProfile('ls'), scene.primary, authority);
    const partialLsStep = await lsPolicy.step({
      goal: observationGoal('file.property.directory.entries', targetRef),
      satisfactionThreshold: 100,
      state: selectedStep.observed_state_after,
    });
    assert.equal(partialLsStep.status, 'unknown');
    assert.equal(partialLsStep.satisfaction, null);
    assert.equal(partialLsStep.reason, 'partial_coverage');
    assert.equal(partialLsStep.observed_state_after.directoryListing, null);
    assert.equal(partialLsStep.observed_state_after.entrySelection, null);

    const afterPartialSelect = await policy.step({
      goal: selectGoal,
      satisfactionThreshold: 100,
      state: partialLsStep.observed_state_after,
    });
    assert.equal(afterPartialSelect.policy.selectedHead, 'DEFER');
    assert.equal(afterPartialSelect.status, 'unknown');
    assert.equal(afterPartialSelect.satisfaction, null);
    assert.equal(afterPartialSelect.reason, 'listing_unobserved');
    assert.equal(afterPartialSelect.execution_result.executorInvoked, false);
    assert.deepEqual(afterPartialSelect.evidence.facts, {
      hasFreshEvidence: 0,
      knownValue: 0,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });
    return {
      directPartialReasons: [zeroMatch.reason, oneMatch.reason, multiMatch.reason],
      outerAfterPartialHead: afterPartialSelect.policy.selectedHead,
    };
  } finally {
    await scene.cleanup();
  }
});

registerCase('probe', 'P29', 'P3-PROBE-UNKNOWN-CANDIDATE-TYPE returns insufficient_evidence unknown/null without coercing missing wire to 0', async () => {
  const selector = { name: 'notes.txt', type: 'regular', parent: '/p' };
  const unknownCandidate = { ref: '/p/notes.txt', path: '/p/notes.txt', name: 'notes.txt', type: 'unknown', parent: '/p' };
  assert.equal(entrySelectFeatures(selector, unknownCandidate), null);
  const predictedUnknown = predictEntrySelectRelation(selector, unknownCandidate, entrySelectProfiles.regular);
  assert.equal(predictedUnknown.status, 'unknown');
  assert.equal(predictedUnknown.features, null);
  assert.equal(predictedUnknown.logit, null);
  assert.equal(predictedUnknown.score, null);
  assert.equal(predictedUnknown.relation, null);

  const directUnknown = resolveEntrySelectSet(
    selector,
    [unknownCandidate],
    'complete',
    entrySelectProfiles.regular,
  );
  assert.equal(directUnknown.outcome, 'insufficient_evidence');
  assert.equal(directUnknown.status, 'unknown');
  assert.equal(directUnknown.satisfaction, null);
  assert.equal(directUnknown.reason, 'unknown_comparison');
  assert.equal(directUnknown.ref, null);

  const knowledge = validateEntrySelectionKnowledge({
    parentPath: '/p',
    name: 'notes.txt',
    targetType: 'regular',
    outcome: directUnknown.outcome,
    ref: directUnknown.ref,
    reason: directUnknown.reason,
    sessionRevision: 0,
    sourceRun: 'probe-p29',
  });
  assert.equal(knowledge.outcome, 'insufficient_evidence');
  assert.equal(knowledge.ref, null);
  assert.equal(knowledge.reason, 'unknown_comparison');
  return {
    features: predictedUnknown.features,
    directStatus: directUnknown.status,
    directReason: directUnknown.reason,
    projectedOutcome: knowledge.outcome,
    projectedRef: knowledge.ref,
  };
});

registerCase('probe', 'P30', 'P3-PROBE-DUPLICATE-ENTITY verifies multiple_matches_in_single_parent conflict and duplicate ref invalid_input rejection', async () => {
  const selector = { name: 'humanagent', type: 'directory', parent: '/p' };
  const duplicateEntityRes = resolveEntrySelectSet(
    selector,
    [
      { ref: '/p/h1', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' },
      { ref: '/p/h2', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' },
    ],
    'complete',
    entrySelectProfiles.directory,
  );
  assert.equal(duplicateEntityRes.outcome, 'invalid_input');
  assert.equal(duplicateEntityRes.reason, 'duplicate_entity');

  const duplicateRefRes = resolveEntrySelectSet(
    selector,
    [
      { ref: '/p/humanagent', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' },
      { ref: '/p/humanagent', path: '/p/humanagent', name: 'humanagent', type: 'directory', parent: '/p' },
    ],
    'complete',
    entrySelectProfiles.directory,
  );
  assert.equal(duplicateRefRes.outcome, 'invalid_input');
  assert.equal(duplicateRefRes.reason, 'duplicate_ref');

  const conflictScene = await createIndependentScene(api, { after: () => {} });
  const duplicateScene = await createIndependentScene(api, { after: () => {} }, {
    listingObserver: async input => {
      const result = await api.runDirectoryListHelper(input);
      if (!result.ok) return result;
      const first = result.observation.entries[0];
      return {
        ok: true,
        observation: {
          ...result.observation,
          entries: [first, ...result.observation.entries],
        },
      };
    },
  });
  try {
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(conflictScene);
    const conflictPolicy = api.createCliCommandPolicy(
      {
        profile: candidate,
        sandbox: conflictScene.sandbox,
        session: conflictScene.primary,
        entrySelectProfiles: {
          directory: zeroEntrySelectProfile('directory'),
          regular: zeroEntrySelectProfile('regular'),
        },
      },
      authority,
    );
    const conflictStep = await conflictPolicy.step({
      goal: entrySelectGoal(targetRef, 'humanagent', 'directory', parentPhysical),
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(conflictStep.policy.selectedHead, 'directory.select');
    assert.equal(conflictStep.status, 'unknown');
    assert.equal(conflictStep.satisfaction, null);
    assert.equal(conflictStep.reason, 'multiple_matches_in_single_parent');
    assert.equal(conflictStep.evidence.selection, 'conflict');
    assert.equal(conflictStep.observed_state_after.entrySelection?.outcome, 'conflict');
    assert.equal(conflictStep.observed_state_after.entrySelection?.ref, null);

    const dupCtx = await setupSelectSandbox(duplicateScene);
    const invalidStep = await policyFor(
      duplicateScene,
      candidate,
      duplicateScene.primary,
      dupCtx.authority,
    ).step({
      goal: entrySelectGoal(dupCtx.targetRef, 'humanagent', 'directory', dupCtx.parentPhysical),
      satisfactionThreshold: 100,
      state: dupCtx.listingState,
    });
    assert.equal(invalidStep.policy.selectedHead, 'directory.select');
    assert.equal(invalidStep.status, 'rejected');
    assert.equal(invalidStep.satisfaction, 0);
    assert.equal(invalidStep.reason, 'invalid_candidate_set');
    assert.equal(invalidStep.observed_state_after.entrySelection?.outcome, 'rejected');
    assert.equal(invalidStep.observed_state_after.entrySelection?.reason, 'duplicate_ref');
    return {
      conflictReason: conflictStep.reason,
      duplicateEntityReason: duplicateEntityRes.reason,
      duplicateRefReason: invalidStep.reason,
    };
  } finally {
    await conflictScene.cleanup();
    await duplicateScene.cleanup();
  }
});

registerCase('probe', 'P31', 'P3-PROBE-STALE-LISTING verifies unobserved, untampered/tampered stale listing, Stale Combination A [0,1,1,1]->DEFER, and Stale Combination B [1,1,0,1]->select', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const { authority, targetRef, parentPhysical, listingState } = await setupSelectSandbox(scene);
    const policy = policyFor(scene, candidate, scene.primary, authority);
    const goalAtR0 = entrySelectGoal(targetRef, 'humanagent', 'directory', parentPhysical);

    // (a) Unobserved listing [0,0,0,1] -> DEFER
    const unobservedStep = await policy.step({
      goal: goalAtR0,
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(unobservedStep.policy.selectedHead, 'DEFER');
    assert.equal(unobservedStep.status, 'unknown');
    assert.equal(unobservedStep.satisfaction, null);
    assert.equal(unobservedStep.reason, 'listing_unobserved');
    assert.equal(unobservedStep.execution_result.executorInvoked, false);
    assert.deepEqual(unobservedStep.evidence.facts, {
      hasFreshEvidence: 0,
      knownValue: 0,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });

    // Execute first selection at revision r_0 so we have both listingState (r_0) and selectedState (r_0)
    const selectedAtR0 = await policy.step({
      goal: goalAtR0,
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(selectedAtR0.policy.selectedHead, 'directory.select');
    assert.equal(selectedAtR0.status, 'achieved');

    // Advance session revision to r_1 via cd
    const startDirRef = await scene.sandbox.bindDirectory(scene.primary, '.');
    const moved = await scene.sandbox.execute({
      operation: 'cwd.set',
      parameters: { session: scene.primary, directory: startDirRef },
    });
    assert.equal(moved.execution.status, 'succeeded');
    const targetRefAtR1 = await scene.sandbox.bindDirectory(scene.primary, '../sibling/select-sandbox');
    const goalAtR1 = entrySelectGoal(targetRefAtR1, 'humanagent', 'directory', parentPhysical);
    const r1 = scene.sandbox.getSession(scene.primary).revision;
    assert.ok(r1 > listingState.directoryListing.revision);

    // (b) Untampered stale listing [0,1,0,1] -> DEFER, and tampered directoryListing.revision -> [0,0,0,1] -> DEFER
    const staleListingStep = await policy.step({
      goal: goalAtR1,
      satisfactionThreshold: 100,
      state: listingState,
    });
    assert.equal(staleListingStep.policy.selectedHead, 'DEFER');
    assert.equal(staleListingStep.status, 'unknown');
    assert.equal(staleListingStep.reason, 'listing_unobserved');
    assert.equal(staleListingStep.execution_result.executorInvoked, false);
    assert.deepEqual(staleListingStep.evidence.facts, {
      hasFreshEvidence: 0,
      knownValue: 1,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });

    const tamperedListingState = {
      ...listingState,
      directoryListing: {
        ...listingState.directoryListing,
        revision: r1,
      },
    };
    const tamperedListingStep = await policy.step({
      goal: goalAtR1,
      satisfactionThreshold: 100,
      state: tamperedListingState,
    });
    assert.equal(tamperedListingStep.policy.selectedHead, 'DEFER');
    assert.equal(tamperedListingStep.status, 'unknown');
    assert.equal(tamperedListingStep.execution_result.executorInvoked, false);
    assert.deepEqual(tamperedListingStep.evidence.facts, {
      hasFreshEvidence: 0,
      knownValue: 0,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });

    // (c) Stale Combination A: old listing + old selected entry both at r_0 < r_1 -> [0,1,1,1] -> DEFER
    const staleComboAStep = await policy.step({
      goal: goalAtR1,
      satisfactionThreshold: 100,
      state: selectedAtR0.observed_state_after,
    });
    assert.equal(staleComboAStep.policy.selectedHead, 'DEFER');
    assert.equal(staleComboAStep.status, 'unknown');
    assert.equal(staleComboAStep.satisfaction, null);
    assert.equal(staleComboAStep.reason, 'listing_unobserved');
    assert.equal(staleComboAStep.defer?.code, 'binding_unresolved');
    assert.equal(staleComboAStep.execution_result.executorInvoked, false);
    assert.deepEqual(staleComboAStep.evidence.facts, {
      hasFreshEvidence: 0,
      knownValue: 1,
      requiredConditionHolds: 1,
      hasDestinationRef: 1,
    });

    // (d) Stale Combination B: fresh listing at r_1 + old selected entry from r_0 -> activeSelection normalized to null -> [1,1,0,1] -> directory.select
    const lsPolicy = policyFor(scene, forcedHeadProfile('ls'), scene.primary, authority);
    const freshLsAtR1 = await lsPolicy.step({
      goal: observationGoal('file.property.directory.entries', targetRefAtR1),
      satisfactionThreshold: 100,
      state: selectedAtR0.observed_state_after,
    });
    assert.equal(freshLsAtR1.status, 'achieved');
    assert.equal(freshLsAtR1.observed_state_after.entrySelection, null);

    const splicedStaleComboB = {
      ...freshLsAtR1.observed_state_after,
      entrySelection: selectedAtR0.observed_state_after.entrySelection,
    };
    const comboBStep = await policy.step({
      goal: goalAtR1,
      satisfactionThreshold: 100,
      state: splicedStaleComboB,
    });
    assert.equal(comboBStep.policy.selectedHead, 'directory.select');
    assert.equal(comboBStep.status, 'achieved');
    assert.equal(comboBStep.satisfaction, 100);
    assert.equal(comboBStep.execution_result.executorInvoked, true);
    assert.deepEqual(comboBStep.evidence.facts, {
      hasFreshEvidence: 1,
      knownValue: 1,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });

    const tamperedComboB = {
      ...freshLsAtR1.observed_state_after,
      entrySelection: {
        ...selectedAtR0.observed_state_after.entrySelection,
        sessionRevision: r1,
      },
    };
    const tamperedComboBStep = await policy.step({
      goal: goalAtR1,
      satisfactionThreshold: 100,
      state: tamperedComboB,
    });
    assert.equal(tamperedComboBStep.policy.selectedHead, 'directory.select');
    assert.equal(tamperedComboBStep.status, 'achieved');
    assert.equal(tamperedComboBStep.satisfaction, 100);
    assert.equal(tamperedComboBStep.execution_result.executorInvoked, true);
    assert.deepEqual(tamperedComboBStep.evidence.facts, {
      hasFreshEvidence: 1,
      knownValue: 1,
      requiredConditionHolds: 0,
      hasDestinationRef: 1,
    });

    return {
      unobserved: unobservedStep.policy.selectedHead,
      staleListing: staleListingStep.policy.selectedHead,
      staleComboA: staleComboAStep.policy.selectedHead,
      staleComboB: comboBStep.policy.selectedHead,
    };
  } finally {
    await scene.cleanup();
  }
});

const STAGE2_SCENARIO_IDS = new Set([
  'S49', 'S50', 'S51', 'S52', 'S53', 'S54', 'S55', 'S56',
  'S57', 'S58', 'S59', 'S60', 'S61', 'S62', 'S63', 'S64',
]);
const STAGE2_PROBE_IDS = new Set([
  'P24', 'P25', 'P26', 'P27', 'P28', 'P29', 'P30', 'P31',
]);

after(async () => {
  const passed = rows.filter(row => row.result === 'PASS').length;
  const failed = rows.filter(row => row.result === 'FAIL').length;
  const historicalRows = rows.filter(row => !STAGE2_SCENARIO_IDS.has(row.id) && !STAGE2_PROBE_IDS.has(row.id));
  const stage2Rows = rows.filter(row => STAGE2_SCENARIO_IDS.has(row.id) || STAGE2_PROBE_IDS.has(row.id));
  const summary = {
    suite: 'batch1-i7-and-stage2-independent-verification',
    stage,
    profilePath,
    profileProvenance: {
      fitted: profileRole === 'trained_candidate',
      role: profileRole,
      notATrainedCapabilityResult: profileRole !== 'trained_candidate',
    },
    profile: {
      contract: candidate.contract,
      calibration: candidate.calibration,
      adoption: candidate.adoption,
      heads: candidate.heads.length,
      wires: candidate.wires.length,
      parameters: candidate.heads.length * candidate.wires.length,
    },
    trackBProfiles: stage === 'stage2-13x38'
      ? {
          directoryProfilePath: bDirectoryProfilePath,
          fileProfilePath: bFileProfilePath,
          directoryContract: entrySelectProfiles.directory.contract,
          fileContract: entrySelectProfiles.regular.contract,
        }
      : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarioCount: rows.filter(row => row.category !== 'probe').length,
    probeCount: rows.filter(row => row.category === 'probe').length,
    passed,
    failed,
    skipped: 0,
    fullyVerified: false,
    unseenFeatureCapabilityVerified: false,
    historicalKnownRegression: {
      total: historicalRows.length,
      passed: historicalRows.filter(row => row.result === 'PASS').length,
      failed: historicalRows.filter(row => row.result === 'FAIL').length,
      stage0: 56,
      stage1: 15,
    },
    stage2NewExternal: {
      total: stage2Rows.length,
      passed: stage2Rows.filter(row => row.result === 'PASS').length,
      failed: stage2Rows.filter(row => row.result === 'FAIL').length,
      scenarios: rows.filter(row => STAGE2_SCENARIO_IDS.has(row.id)).length,
      probes: rows.filter(row => STAGE2_PROBE_IDS.has(row.id)).length,
    },
    unverified,
    rows: [...rows].sort((left, right) => left.id.localeCompare(right.id)),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(`I7_SUITE_REPORT ${JSON.stringify({
    stage,
    profileRole,
    scenarioCount: summary.scenarioCount,
    probeCount: summary.probeCount,
    passed,
    failed,
    reportPath,
  })}`);
  assert.equal(summary.scenarioCount, 64);
  assert.equal(summary.probeCount, 31);
  assert.equal(rows.length, 95);
  assert.equal(summary.historicalKnownRegression.total, 71);
  assert.equal(summary.stage2NewExternal.total, 24);
  assert.equal(unverified.length, 5);
});
