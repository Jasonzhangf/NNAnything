import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { VERIFICATION_RECIPES } from './cli-filesystem-independent-fixtures.mjs';

// This suite consumes a saved candidate only. It does not import fitting code,
// training generators, or prepare train/development samples.
const grants = ['filesystem.read', 'process.exec', 'session.write'];
const offset = process.env.NN_VERIFICATION_BATCH === 'fresh' ? 4 : 0;
const emptyState = session => ({ session: session.sessionId, cwdObservation: null, directoryListing: null });
const normalize = entries => entries
  .map(({ name, type }) => ({ name, type }))
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function cwdQuery(session) {
  return { kind: 'cli.file-query', relation: 'sessionCwd', session };
}

function cwdObservedGoal(session) {
  return {
    kind: 'file.property',
    property: 'file.property.relation.sessionCwd',
    target: cwdQuery(session),
    requirement: { kind: 'observed', freshness: 'this_run' },
  };
}

function cwdEqualsGoal(session, directory) {
  return {
    kind: 'file.property',
    property: 'file.property.relation.sessionCwd',
    target: cwdQuery(session),
    requirement: { kind: 'equals', expected: directory },
  };
}

function entriesObservedGoal(directory) {
  return {
    kind: 'file.property',
    property: 'file.property.directory.entries',
    target: directory,
    requirement: { kind: 'observed', freshness: 'this_run' },
  };
}

function unsupportedGoal(directory) {
  return {
    kind: 'file.property',
    property: 'file.property.content.bytes',
    target: directory,
    requirement: { kind: 'equals', expected: 'opaque' },
  };
}

function recipeFor(index, effects) {
  const spec = VERIFICATION_RECIPES[index], dirs = new Set();
  function add(path) {
    if (path === '.' || path === '') return;
    add(dirname(path));
    dirs.add(path);
  }
  for (const path of [spec.start, spec.target, spec.second?.path ?? 'isolated/session/two']) add(path);
  for (const name of spec.directories) add(join(spec.target, name));
  if (spec.second) for (const name of spec.second.directories) add(join(spec.second.path, name));
  const entries = [...dirs].map(path => ({ path, kind: 'directory' }));
  for (const name of spec.files) {
    entries.push({ path: join(spec.target, name), kind: 'file', contents: 'opaque fixture bytes' });
  }
  for (const name of spec.directories) {
    entries.push({ path: join(spec.target, name, 'not-a-direct-child'), kind: 'file', contents: 'descendant' });
  }
  if (spec.second) {
    for (const name of spec.second.files) {
      entries.push({ path: join(spec.second.path, name), kind: 'file', contents: 'second scene bytes' });
    }
  }
  return {
    scenarioId: `independent-${spec.id}`,
    entries,
    sessions: [
      { id: 'query-session', cwd: spec.start, grantedEffects: effects },
      { id: 'foreign-session', cwd: spec.second?.path ?? 'isolated/session/two', grantedEffects: grants },
    ],
  };
}

async function makeScene(api, index, effects = grants, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-filesystem-independent-')));
  const recipe = recipeFor(index, effects);
  try {
    const sandbox = await api.createCliFilesystemSandbox({
      root,
      recipe,
      ownerGrantedEffects: ['filesystem.read', 'filesystem.write'],
      ...extra,
    });
    const spec = VERIFICATION_RECIPES[index];
    const target = join(sandbox.scenarioRoot, spec.target);
    for (const [name, destination] of spec.links) {
      await symlink(join(target, destination), join(target, name));
    }
    if (spec.alias) {
      await symlink(join(sandbox.scenarioRoot, spec.aliasTarget), join(sandbox.scenarioRoot, spec.alias));
    }
    return {
      sandbox,
      spec,
      target,
      query: sandbox.bindSession('query-session'),
      foreign: sandbox.bindSession('foreign-session'),
      async cleanup() {
        await sandbox.cleanup();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function treeEvidence(root, prefix = '') {
  const rows = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = join(prefix, name), info = await lstat(join(root, path));
    if (info.isSymbolicLink()) {
      rows.push({ path, type: 'symlink', target: await readlink(join(root, path)) });
    } else if (info.isDirectory()) {
      rows.push({ path, type: 'directory' });
      rows.push(...await treeEvidence(root, path));
    } else {
      rows.push({ path, type: 'file', content: await readFile(join(root, path), 'utf8') });
    }
  }
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function manualDirectoryRef(session, target, currentCwd) {
  return {
    kind: 'cli.directory',
    scenarioId: session.scenarioId,
    sessionId: session.sessionId,
    path: relative(currentCwd, target) || '.',
  };
}

function failureText(transition) {
  return JSON.stringify({
    error: transition.execution_result.error,
    receiptError: transition.execution_result.receipt?.execution.status === 'failed'
      ? transition.execution_result.receipt.execution.error
      : null,
    postconditionError: transition.postcondition?.receipt?.execution.status === 'failed'
      ? transition.postcondition.receipt.execution.error
      : null,
    bindingError: transition.evidence.bindingError,
    transitionError: transition.reason,
  });
}

test('saved shared CLI candidate passes independent command, state, naming and failure contracts', {
  skip: !process.env.NN_CLI_COMMAND_PROFILE && 'provide final saved shared command profile',
}, async () => {
  const api = await import('nnanything/cli-goal');
  const started = performance.now(), parentCwd = process.cwd();
  const profileText = await readFile(process.env.NN_CLI_COMMAND_PROFILE, 'utf8');
  const rawProfile = JSON.parse(profileText);
  const profile = rawProfile.wires?.length === 30
    ? api.migrateCliCommandProfileV10x30(rawProfile)
    : rawProfile;
  const relation = process.env.NN_CWD_RELATION_PROFILE
    ? JSON.parse(await readFile(process.env.NN_CWD_RELATION_PROFILE, 'utf8'))
    : null;
  const rows = [], failures = [], relationRows = [];
  let supplementalPwdCalls = 0, additionalCdCommits = 0, secondarySessionLists = 0;

  for (let index = offset; index < offset + 4; index++) {
    for (const head of ['pwd', 'cd', 'ls', 'unsupported']) {
      const scene = await makeScene(api, index);
      try {
        const session = scene.query;
        const before = scene.sandbox.getSession(session);
        const foreignBefore = scene.sandbox.getSession(scene.foreign);
        const treeBefore = await treeEvidence(scene.sandbox.scenarioRoot);
        const physicalTarget = await realpath(scene.target);
        const configuredTarget = scene.spec.alias
          ? join(scene.sandbox.scenarioRoot, scene.spec.alias, relative(scene.spec.aliasTarget, scene.spec.target))
          : scene.target;
        const directory = head !== 'pwd'
          ? await scene.sandbox.bindDirectory(session, relative(before.cwd, configuredTarget) || '.')
          : undefined;
        const policy = api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session });
        let transition;

        if (head === 'pwd') {
          transition = await policy.step({
            goal: cwdObservedGoal(session),
            satisfactionThreshold: 100,
            state: emptyState(session),
          });
          assert.equal(transition.policy.selectedHead, 'pwd');
          assert.equal(transition.policy_error, null);
          assert.equal(transition.status, 'achieved');
          assert.equal(transition.satisfaction, 100);
          assert.deepEqual(transition.invocation, ['pwd']);
          assert.equal(transition.execution_result.executorInvoked, true);
          const native = transition.execution_result.receipt.execution.observation;
          assert.equal(native.executable, '/bin/pwd');
          assert.deepEqual(native.argv, ['-P']);
          assert.equal(native.physicalCwd, await realpath(before.cwd));
          const repeated = await policy.step({
            goal: cwdObservedGoal(session),
            satisfactionThreshold: 100,
            state: transition.observed_state_after,
          });
          supplementalPwdCalls++;
          assert.equal(repeated.policy.selectedHead, 'pwd');
          assert.equal(repeated.status, 'achieved');
          assert.notEqual(
            repeated.observed_state_after.cwdObservation.sourceRun,
            transition.observed_state_after.cwdObservation.sourceRun,
          );
          if (relation) {
            for (const sameSession of [false, true]) {
              for (const hasObservation of [false, true]) {
                const question = {
                  kind: 'cwd.belongs_to',
                  session: session.sessionId,
                  candidate: {
                    session: sameSession ? session.sessionId : scene.foreign.sessionId,
                    observation: hasObservation ? transition.observed_state_after.cwdObservation : null,
                  },
                };
                const prediction = api.predictCwdRelation(question, relation);
                const expected = sameSession && hasObservation ? 'MATCH' : 'NO_MATCH';
                assert.equal(prediction.selectedRelation, expected);
                relationRows.push({ question, prediction, expected });
              }
            }
          }
        } else if (head === 'cd') {
          const observed = await policy.step({
            goal: cwdObservedGoal(session),
            satisfactionThreshold: 100,
            state: emptyState(session),
          });
          assert.equal(observed.status, 'achieved');
          transition = await policy.step({
            goal: cwdEqualsGoal(session, directory),
            satisfactionThreshold: 100,
            state: observed.observed_state_after,
          });
          assert.equal(transition.policy.selectedHead, 'cd');
          assert.equal(transition.policy_error, null);
          assert.equal(transition.status, 'achieved');
          assert.equal(transition.satisfaction, 100);
          assert.deepEqual(transition.invocation, ['cd', directory]);
          assert.equal(transition.execution_result.executorInvoked, true);
          const native = transition.execution_result.receipt.execution.observation;
          assert.equal(native.executable, '/bin/zsh');
          assert.deepEqual(native.argv, [
            '-f',
            '-c',
            'builtin cd -- "$1" && /bin/pwd -P',
            'nnanything-cd',
            directory.path,
          ]);
          assert.equal(transition.session_after.cwd, physicalTarget);
          assert.equal(transition.session_after.revision, before.revision + 1);
          assert.equal(transition.postcondition.receipt.execution.observation.physicalCwd, physicalTarget);
          await assert.rejects(access(join(before.cwd, 'injected-marker')));
          if (index === offset + 2) {
            const current = scene.sandbox.getSession(session);
            const back = await scene.sandbox.bindDirectory(session, relative(current.cwd, before.cwd) || '.');
            const returned = await policy.step({
              goal: cwdEqualsGoal(session, back),
              satisfactionThreshold: 100,
              state: transition.observed_state_after,
            });
            additionalCdCommits++;
            assert.equal(returned.status, 'achieved');
            assert.equal(returned.session_after.revision, before.revision + 2);
            const later = await policy.step({
              goal: cwdObservedGoal(session),
              satisfactionThreshold: 100,
              state: returned.observed_state_after,
            });
            supplementalPwdCalls++;
            assert.equal(later.status, 'achieved');
            assert.equal(later.observed_state_after.cwdObservation.physicalCwd, await realpath(before.cwd));
          }
        } else if (head === 'ls') {
          transition = await policy.step({
            goal: entriesObservedGoal(directory),
            satisfactionThreshold: 100,
            state: emptyState(session),
          });
          assert.equal(transition.policy.selectedHead, 'ls');
          assert.equal(transition.policy_error, null);
          assert.equal(transition.status, 'achieved');
          assert.equal(transition.satisfaction, 100);
          assert.deepEqual(transition.invocation, ['ls', directory]);
          assert.equal(transition.execution_result.executorInvoked, true);
          const native = transition.execution_result.receipt.execution.observation;
          const expected = [
            ...scene.spec.files.map(name => ({ name, type: 'file' })),
            ...scene.spec.directories.map(name => ({ name, type: 'directory' })),
            ...scene.spec.links.map(([name]) => ({ name, type: 'symlink' })),
          ];
          assert.equal(native.coverage, 'complete');
          assert.deepEqual(native.errors, []);
          assert.deepEqual(normalize(native.entries), normalize(expected));
          assert.deepEqual(native.argv, [api.directoryListHelperPath(), physicalTarget]);
          assert.equal(native.executable, process.execPath);
          for (const entry of native.entries) assert.equal(entry.path, join(physicalTarget, entry.name));

          const repeated = await policy.step({
            goal: entriesObservedGoal(directory),
            satisfactionThreshold: 100,
            state: transition.observed_state_after,
          });
          assert.equal(repeated.policy.selectedHead, 'ls');
          assert.equal(repeated.status, 'achieved');
          assert.notEqual(
            repeated.observed_state_after.directoryListing.sourceRun,
            transition.observed_state_after.directoryListing.sourceRun,
          );
          if (scene.spec.second) {
            const foreign = scene.sandbox.getSession(scene.foreign);
            const ownDirectory = await scene.sandbox.bindDirectory(scene.foreign, '.');
            const own = await api.createCliCommandPolicy({
              profile,
              sandbox: scene.sandbox,
              session: scene.foreign,
            }).step({
              goal: entriesObservedGoal(ownDirectory),
              satisfactionThreshold: 100,
              state: emptyState(scene.foreign),
            });
            secondarySessionLists++;
            assert.equal(own.status, 'achieved');
            assert.deepEqual(normalize(own.observed_state_after.directoryListing.entries), normalize([
              ...scene.spec.second.files.map(name => ({ name, type: 'file' })),
              ...scene.spec.second.directories.map(name => ({ name, type: 'directory' })),
            ]));
            assert.deepEqual(scene.sandbox.getSession(scene.foreign), foreign);
          }
        } else {
          transition = await policy.step({
            goal: unsupportedGoal(directory),
            satisfactionThreshold: 100,
            state: emptyState(session),
          });
          assert.equal(transition.policy.selectedHead, 'unsupported');
          assert.equal(transition.policy_error, null);
          assert.equal(transition.status, 'unknown');
          assert.equal(transition.satisfaction, null);
          assert.equal(transition.invocation, null);
          assert.equal(transition.execution_result.status, 'unsupported');
          assert.equal(transition.execution_result.executorInvoked, false);
        }

        if (head !== 'cd') assert.deepEqual(scene.sandbox.getSession(session), before);
        assert.deepEqual(scene.sandbox.getSession(scene.foreign), foreignBefore);
        assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore);
        assert.equal(process.cwd(), parentCwd);
        rows.push({ family: scene.spec.id, head, transition });
      } finally {
        await scene.cleanup();
      }
    }
  }

  const probes = [
    { head: 'pwd', probe: 'missing-cwd', source: 'native', executorInvoked: false, error: /ENOENT|no such file/i },
    { head: 'pwd', probe: 'missing-exec', source: 'grant', executorInvoked: true, error: /process\.exec|EFFECT_DENIED/i },
    { head: 'cd', probe: 'missing', source: 'native', executorInvoked: false, error: /ENOENT|no such file/i },
    { head: 'cd', probe: 'file', source: 'native', executorInvoked: false, error: /ENOTDIR|not a directory/i },
    { head: 'cd', probe: 'final-link', source: 'native', executorInvoked: false, error: /FINAL_SYMLINK|symlink/i },
    { head: 'cd', probe: 'outside', source: 'native', executorInvoked: false, error: /SANDBOX_ESCAPE|escape/i },
    { head: 'cd', probe: 'physical-outside', source: 'native', executorInvoked: false, error: /SANDBOX_ESCAPE|escape/i },
    { head: 'cd', probe: 'missing-exec', source: 'grant', executorInvoked: false, error: /process\.exec|EFFECT_DENIED/i },
    { head: 'cd', probe: 'missing-write', source: 'grant', executorInvoked: false, error: /session\.write|EFFECT_DENIED/i },
    {
      head: 'cd',
      probe: 'postcommit-observation',
      source: 'injected',
      executorInvoked: true,
      error: /INJECTED_OBSERVATION|controlled postcommit/i,
      injected: true,
    },
    { head: 'ls', probe: 'missing', source: 'native', executorInvoked: false, error: /ENOENT|no such file/i },
    { head: 'ls', probe: 'file', source: 'native', executorInvoked: false, error: /ENOTDIR|not a directory/i },
    { head: 'ls', probe: 'final-link', source: 'native', executorInvoked: false, error: /FINAL_SYMLINK|symlink/i },
    { head: 'ls', probe: 'outside', source: 'native', executorInvoked: false, error: /SANDBOX_ESCAPE|escape/i },
    { head: 'ls', probe: 'missing-read', source: 'grant', executorInvoked: false, error: /filesystem\.read|EFFECT_DENIED/i },
  ];

  for (const probe of probes) {
    const effects = grants.filter(grant =>
      !(probe.probe === 'missing-exec' && grant === 'process.exec')
      && !(probe.probe === 'missing-read' && grant === 'filesystem.read')
      && !(probe.probe === 'missing-write' && grant === 'session.write'));
    const extra = probe.injected
      ? {
        observation: async () => ({
          ok: false,
          error: {
            operation: 'pwd',
            stage: 'observe',
            code: 'INJECTED_OBSERVATION',
            message: 'controlled postcommit observation failure',
          },
        }),
      }
      : {};
    const scene = await makeScene(api, offset, effects, extra);
    try {
      const session = scene.query;
      const before = scene.sandbox.getSession(session);
      const foreignBefore = scene.sandbox.getSession(scene.foreign);
      let target = scene.target;
      if (probe.probe === 'missing-cwd') await rm(before.cwd, { recursive: true });
      if (probe.probe === 'missing') target = join(scene.sandbox.scenarioRoot, 'missing');
      if (probe.probe === 'file') {
        target = join(scene.sandbox.scenarioRoot, 'plain-file');
        await writeFile(target, 'opaque');
      }
      if (probe.probe === 'final-link') {
        target = join(scene.sandbox.scenarioRoot, 'direct-target-link');
        await symlink(scene.target, target).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      if (probe.probe === 'outside') target = dirname(scene.sandbox.scenarioRoot);
      if (probe.probe === 'physical-outside') {
        const outside = join(dirname(scene.sandbox.scenarioRoot), 'outside');
        await mkdir(join(outside, 'nested'), { recursive: true });
        await symlink(outside, join(scene.sandbox.scenarioRoot, 'ancestor-link'));
        target = join(scene.sandbox.scenarioRoot, 'ancestor-link', 'nested');
      }

      const treeBefore = await treeEvidence(scene.sandbox.scenarioRoot);
      let directory;
      if (probe.head !== 'pwd') {
        directory = ['missing', 'file', 'final-link', 'outside', 'physical-outside'].includes(probe.probe)
          ? manualDirectoryRef(session, target, before.cwd)
          : await scene.sandbox.bindDirectory(session, relative(before.cwd, target) || '.');
      }
      const goal = probe.head === 'pwd'
        ? cwdObservedGoal(session)
        : probe.head === 'cd'
          ? cwdEqualsGoal(session, directory)
          : entriesObservedGoal(directory);
      const transition = await api.createCliCommandPolicy({
        profile,
        sandbox: scene.sandbox,
        session,
      }).step({ goal, satisfactionThreshold: 100, state: emptyState(session) });

      assert.equal(transition.policy.selectedHead, probe.head);
      assert.equal(transition.policy_error, null);
      assert.notEqual(transition.status, 'achieved');
      assert.equal(transition.execution_result.executorInvoked, probe.executorInvoked);
      assert.match(failureText(transition), probe.error);
      if (probe.injected) {
        assert.equal(transition.status, 'unknown');
        assert.equal(transition.satisfaction, null);
        assert.equal(transition.changed, true);
        assert.equal(transition.session_after.cwd, await realpath(target));
        assert.equal(transition.session_after.revision, before.revision + 1);
      } else {
        assert.equal(transition.satisfaction, 0);
        assert.equal(transition.changed, false);
        assert.deepEqual(scene.sandbox.getSession(session), before);
      }
      assert.deepEqual(scene.sandbox.getSession(scene.foreign), foreignBefore);
      assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore);
      failures.push({ ...probe, transition });
    } finally {
      await scene.cleanup();
    }
  }

  let fault = false;
  const scene = await makeScene(api, offset, grants, {
    listingObserver: async input => {
      if (!fault) return api.runDirectoryListHelper(input);
      const listing = await api.collectDirectoryListing(input.physicalDirectory, {
        readdir,
        lstat: async path => {
          if (path === join(input.physicalDirectory, VERIFICATION_RECIPES[offset].files[0])) {
            throw Object.assign(new Error('controlled lstat disappearance'), { code: 'ENOENT' });
          }
          return lstat(path);
        },
      });
      return {
        ok: true,
        observation: {
          kind: 'directory.list',
          configuredDirectory: input.configuredDirectory,
          physicalDirectory: input.physicalDirectory,
          executable: 'controlled-collector',
          helperPath: 'injected:lstat',
          argv: [input.physicalDirectory],
          stdout: JSON.stringify(listing),
          stderr: '',
          exitCode: 0,
          entries: listing.entries,
          errors: listing.errors,
          coverage: listing.coverage,
        },
      };
    },
  });
  try {
    const session = scene.query;
    const before = scene.sandbox.getSession(session);
    const treeBefore = await treeEvidence(scene.sandbox.scenarioRoot);
    const directory = await scene.sandbox.bindDirectory(session, relative(before.cwd, scene.target) || '.');
    const goal = entriesObservedGoal(directory);
    const policy = api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session });
    const initial = await policy.step({ goal, satisfactionThreshold: 100, state: emptyState(session) });
    assert.equal(initial.status, 'achieved');
    fault = true;
    const partial = await policy.step({
      goal,
      satisfactionThreshold: 100,
      state: initial.observed_state_after,
    });
    assert.equal(partial.policy.selectedHead, 'ls');
    assert.equal(partial.status, 'unknown');
    assert.equal(partial.satisfaction, null);
    assert.equal(partial.reason, 'partial_coverage');
    const observed = partial.execution_result.receipt.execution.observation;
    assert.equal(observed.coverage, 'partial');
    assert.equal(observed.entries.find(entry => entry.name === scene.spec.files[0]).type, 'unknown');
    assert.deepEqual(
      observed.errors.map(({ name, code }) => ({ name, code })),
      [{ name: scene.spec.files[0], code: 'ENOENT' }],
    );
    assert.equal(
      observed.entries.length,
      scene.spec.files.length + scene.spec.directories.length + scene.spec.links.length,
    );
    assert.deepEqual(partial.observed_state_after, initial.observed_state_after);
    assert.deepEqual(scene.sandbox.getSession(session), before);
    assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore);
    failures.push({
      head: 'ls',
      probe: 'partial-lstat',
      source: 'injected',
      transition: partial,
    });
  } finally {
    await scene.cleanup();
  }

  assert.equal(await readFile(process.env.NN_CLI_COMMAND_PROFILE, 'utf8'), profileText);
  assert.equal(process.cwd(), parentCwd);
  assert.equal(rows.length, 16);
  assert.equal(failures.length, 16);
  if (relation) assert.equal(relationRows.length, 16);

  const report = {
    stage: 'shared-cli-property-independent',
    profilePath: process.env.NN_CLI_COMMAND_PROFILE,
    batch: offset === 0 ? 'original' : 'fresh',
    actionCorrect: 16,
    actionCount: 16,
    normalByCommand: { pwd: 4, cd: 4, ls: 4, unsupported: 4 },
    relationCorrect: relationRows.length,
    relationCount: relation ? 16 : 0,
    failureByCommand: { pwd: 2, cd: 8, ls: 6 },
    controlledFailureProbes: 2,
    nativeFailureProbes: 10,
    grantFailureProbes: 4,
    nativeOrGrantFailureProbes: 14,
    supplementalPwdCalls,
    additionalCdCommits,
    secondarySessionLists,
    elapsedMs: performance.now() - started,
    rows,
    failures,
    relationRows,
    limits: 'Independent fixtures and OS coverage only. Historical CWD relation evidence is not a command selector.',
  };
  if (process.env.NN_CLI_VERIFICATION_REPORT) {
    await writeFile(process.env.NN_CLI_VERIFICATION_REPORT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({
    independentSharedCliProperty: {
      ...report,
      rows: undefined,
      failures: undefined,
      relationRows: undefined,
    },
  }));
});
