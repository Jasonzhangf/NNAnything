import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
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
const execFileAsync = promisify(execFile);
const profilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (!profilePath) throw new Error('NN_CLI_COMMAND_PROFILE is required; no candidate default is allowed');
const candidate = JSON.parse(await readFile(profilePath, 'utf8'));
assert.deepEqual(candidate.heads, [
  'unsupported', 'DEFER', 'NOOP', 'pwd', 'cd', 'ls',
  'path.resolve', 'path.relative', 'path.parts', 'entry.inspect',
]);
assert.equal(candidate.wires.length, 30);
assert.equal(candidate.weights.length, 10);
assert.ok(candidate.weights.every(row => row.length === 30));
assert.equal(candidate.calibration, 'uncalibrated');
assert.equal(candidate.adoption, 'not_applied');

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

function policyFor(scene, profile = candidate, session = scene.primary) {
  return api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session });
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
    assert.deepEqual(transition.policy.scores, new Array(10).fill(0));
    assert.deepEqual(transition.policy.probabilities, new Array(10).fill(0));
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

registerCase('probe', 'P11', 'unregistered physical property is unsupported', async () => {
  const scene = await createIndependentScene(api, { after: () => {} });
  try {
    const ref = pathRef(scene.sandbox, scene.primary, scene.paths.file);
    const transition = await policyFor(scene).step({
      goal: observationGoal('file.property.path.physical', ref),
      satisfactionThreshold: 100,
      state: emptyState(scene.primary),
    });
    assert.equal(transition.policy.selectedHead, 'unsupported');
    assert.equal(transition.status, 'unknown');
    assert.equal(transition.satisfaction, null);
    assert.equal(transition.invocation, null);
    assert.equal(transition.execution_result.executorInvoked, false);
    return { head: 'unsupported', property: 'file.property.path.physical' };
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

after(async () => {
  const passed = rows.filter(row => row.result === 'PASS').length;
  const failed = rows.filter(row => row.result === 'FAIL').length;
  const summary = {
    suite: 'batch1-i7-independent-verification',
    profilePath,
    profile: {
      contract: candidate.contract,
      calibration: candidate.calibration,
      adoption: candidate.adoption,
      heads: candidate.heads.length,
      wires: candidate.wires.length,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarioCount: rows.filter(row => row.category !== 'probe').length,
    probeCount: rows.filter(row => row.category === 'probe').length,
    passed,
    failed,
    skipped: 0,
    unverified,
    rows: [...rows].sort((left, right) => left.id.localeCompare(right.id)),
  };
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(`I7_SUITE_REPORT ${JSON.stringify({
    scenarioCount: summary.scenarioCount,
    probeCount: summary.probeCount,
    passed,
    failed,
    reportPath,
  })}`);
  assert.equal(summary.scenarioCount, 40);
  assert.equal(summary.probeCount, 16);
  assert.equal(rows.length, 56);
});

