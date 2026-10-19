import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, symlink, rm, readFile, writeFile, access, readdir, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { VERIFICATION_RECIPES } from './cli-filesystem-independent-fixtures.mjs';

// Parent-authored scenarios and OS expectations. No fitting code or train generator is called.
const grants = ['filesystem.read', 'process.exec', 'session.write'];
const offset = process.env.NN_VERIFICATION_BATCH === 'fresh' ? 4 : 0;
const emptyState = session => ({ session: session.sessionId, cwdObservation: null, directoryListing: null });
const normalize = entries => entries.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function recipeFor(index, effects) {
  const spec = VERIFICATION_RECIPES[index], dirs = new Set();
  function add(path) { if (path === '.' || path === '') return; add(dirname(path)); dirs.add(path); }
  for (const path of [spec.start, spec.target, spec.second?.path ?? 'isolated/session/two']) add(path);
  for (const name of spec.directories) add(join(spec.target, name));
  if (spec.second) for (const name of spec.second.directories) add(join(spec.second.path, name));
  const entries = [...dirs].map(path => ({ path, kind: 'directory' }));
  for (const name of spec.files) entries.push({ path: join(spec.target, name), kind: 'file', contents: 'opaque fixture bytes' });
  for (const name of spec.directories) entries.push({ path: join(spec.target, name, 'not-a-direct-child'), kind: 'file', contents: 'descendant' });
  if (spec.second) for (const name of spec.second.files) entries.push({ path: join(spec.second.path, name), kind: 'file', contents: 'second scene bytes' });
  return { scenarioId: `independent-${spec.id}`, entries, sessions: [
    { id: 'query-session', cwd: spec.start, grantedEffects: effects },
    { id: 'foreign-session', cwd: spec.second?.path ?? 'isolated/session/two', grantedEffects: grants },
  ] };
}

async function makeScene(api, index, effects = grants, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-filesystem-independent-'))), recipe = recipeFor(index, effects);
  try {
    const sandbox = await api.createCliFilesystemSandbox({ root, recipe, ownerGrantedEffects: ['filesystem.read', 'filesystem.write'], ...extra });
    const spec = VERIFICATION_RECIPES[index], target = join(sandbox.scenarioRoot, spec.target);
    for (const [name, destination] of spec.links) await symlink(join(target, destination), join(target, name));
    if (spec.alias) await symlink(join(sandbox.scenarioRoot, spec.aliasTarget), join(sandbox.scenarioRoot, spec.alias));
    return { sandbox, spec, target, query: sandbox.bindSession('query-session'), foreign: sandbox.bindSession('foreign-session'),
      async cleanup() { await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

async function treeEvidence(root, prefix = '') {
  const rows = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = join(prefix, name), info = await lstat(join(root, path));
    if (info.isSymbolicLink()) rows.push({ path, type: 'symlink', target: await readlink(join(root, path)) });
    else if (info.isDirectory()) { rows.push({ path, type: 'directory' }); rows.push(...await treeEvidence(root, path)); }
    else rows.push({ path, type: 'file', content: await readFile(join(root, path), 'utf8') });
  }
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

test('saved shared CLI candidate passes independent command, state, naming and failure contracts', {
  skip: !process.env.NN_CLI_COMMAND_PROFILE && 'provide final saved shared command profile',
}, async () => {
  const api = await import('nnanything/cli-goal'), started = performance.now(), parentCwd = process.cwd();
  const profileText = await readFile(process.env.NN_CLI_COMMAND_PROFILE, 'utf8');
  const profile = JSON.parse(profileText), rows = [], failures = [], relationRows = [];
  const relation = process.env.NN_CWD_RELATION_PROFILE ? JSON.parse(await readFile(process.env.NN_CWD_RELATION_PROFILE, 'utf8')) : null;
  let supplementalPwdCalls = 0, additionalCdCommits = 0, secondarySessionLists = 0;
  const kinds = [['observe_cwd', 'pwd'], ['set_cwd', 'cd'], ['list_directory', 'ls'], ['independent_other', 'unsupported']];
  for (let index = offset; index < offset + 4; index++) for (const [kind, head] of kinds) {
    const scene = await makeScene(api, index);
    try {
      const before = scene.sandbox.getSession(scene.query), foreignBefore = scene.sandbox.getSession(scene.foreign);
      const treeBefore = await treeEvidence(scene.sandbox.scenarioRoot), physicalTarget = await realpath(scene.target);
      const configuredTarget = scene.spec.alias
        ? join(scene.sandbox.scenarioRoot, scene.spec.alias, relative(scene.spec.aliasTarget, scene.spec.target)) : scene.target;
      const directory = ['cd', 'ls'].includes(head) ? await scene.sandbox.bindDirectory(scene.query, relative(before.cwd, configuredTarget) || '.') : undefined;
      const goal = { kind, session: scene.query.sessionId, ...(['cd', 'ls'].includes(head) ? { target: configuredTarget } : {}) };
      const policy = api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session: scene.query });
      const transition = await policy.step({ goal, state: emptyState(scene.query), ...(directory ? { directory } : {}) });
      assert.equal(transition.policy.selectedHead, head); assert.equal(transition.policy_error, null);
      assert.equal(transition.goal_result.status, head === 'unsupported' ? 'unverified' : 'achieved');
      assert.equal(transition.goal_result.satisfaction, head === 'unsupported' ? null : 100);
      if (head === 'unsupported') {
        assert.equal(transition.invocation, null); assert.equal(transition.execution_result.executorInvoked, false);
      } else {
        assert.deepEqual(transition.invocation, head === 'pwd' ? ['pwd'] : [head, directory]);
        assert.equal(transition.execution_result.receipt.status, 'succeeded');
      }
      const native = transition.execution_result.receipt?.execution.observation;
      if (head === 'pwd') {
        assert.equal(native.executable, '/bin/pwd'); assert.deepEqual(native.argv, ['-P']);
        assert.equal(native.physicalCwd, await realpath(before.cwd));
        const repeated = await policy.step({ goal, state: transition.observed_state_after }); supplementalPwdCalls++;
        assert.equal(repeated.goal_result.status, 'achieved');
        assert.notEqual(repeated.observed_state_after.cwdObservation.sourceRun, transition.observed_state_after.cwdObservation.sourceRun);
        if (relation) for (const sameSession of [false, true]) for (const hasObservation of [false, true]) {
          const question = { kind: 'cwd.belongs_to', session: scene.query.sessionId, candidate: {
            session: sameSession ? scene.query.sessionId : scene.foreign.sessionId,
            observation: hasObservation ? transition.observed_state_after.cwdObservation : null } };
          const prediction = api.predictCwdRelation(question, relation), expected = sameSession && hasObservation ? 'MATCH' : 'NO_MATCH';
          assert.equal(prediction.selectedRelation, expected); relationRows.push({ question, prediction, expected });
        }
      }
      if (head === 'cd') {
        assert.equal(native.executable, '/bin/zsh');
        assert.deepEqual(native.argv, ['-f', '-c', 'builtin cd -- "$1" && /bin/pwd -P', 'nnanything-cd', directory.path]);
        assert.equal(transition.session_after.cwd, physicalTarget); assert.equal(transition.session_after.revision, before.revision + 1);
        assert.equal(transition.postcondition.receipt.execution.observation.physicalCwd, physicalTarget);
        await assert.rejects(access(join(before.cwd, 'injected-marker')));
        if (index === offset + 2) {
          const current = scene.sandbox.getSession(scene.query), back = await scene.sandbox.bindDirectory(scene.query, relative(current.cwd, before.cwd) || '.');
          const returned = await policy.step({ goal: { kind: 'set_cwd', session: scene.query.sessionId, target: before.cwd }, state: transition.observed_state_after, directory: back });
          additionalCdCommits++;
          assert.equal(returned.goal_result.status, 'achieved'); assert.equal(returned.session_after.revision, before.revision + 2);
          const later = await policy.step({ goal: { kind: 'observe_cwd', session: scene.query.sessionId }, state: returned.observed_state_after }); supplementalPwdCalls++;
          assert.equal(later.goal_result.status, 'achieved'); assert.equal(later.observed_state_after.cwdObservation.physicalCwd, await realpath(before.cwd));
        }
      }
      if (head === 'ls') {
        const expected = [...scene.spec.files.map(name => ({ name, type: 'file' })), ...scene.spec.directories.map(name => ({ name, type: 'directory' })), ...scene.spec.links.map(([name]) => ({ name, type: 'symlink' }))];
        assert.equal(native.coverage, 'complete'); assert.deepEqual(native.errors, []);
        assert.deepEqual(normalize(native.entries), normalize(expected));
        assert.deepEqual(native.argv, [api.directoryListHelperPath(), physicalTarget]); assert.equal(native.executable, process.execPath);
        for (const entry of native.entries) assert.equal(entry.path, join(physicalTarget, entry.name));
        if (scene.spec.second) {
          const foreign = scene.sandbox.getSession(scene.foreign), ownDirectory = await scene.sandbox.bindDirectory(scene.foreign, '.');
          const own = await api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session: scene.foreign }).step({
            goal: { kind: 'list_directory', session: scene.foreign.sessionId, target: foreign.cwd }, state: emptyState(scene.foreign), directory: ownDirectory });
          secondarySessionLists++;
          assert.equal(own.goal_result.status, 'achieved'); assert.deepEqual(normalize(own.observed_state_after.directoryListing.entries), normalize([
            ...scene.spec.second.files.map(name => ({ name, type: 'file' })), ...scene.spec.second.directories.map(name => ({ name, type: 'directory' }))]));
        }
      }
      if (head !== 'cd') assert.deepEqual(scene.sandbox.getSession(scene.query), before);
      assert.deepEqual(scene.sandbox.getSession(scene.foreign), foreignBefore);
      assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore); assert.equal(process.cwd(), parentCwd);
      rows.push({ family: scene.spec.id, head, goal, transition });
    } finally { await scene.cleanup(); }
  }
  const probes = [
    ...['missing-cwd', 'missing-exec'].map(probe => ['pwd', probe]),
    ...['missing', 'file', 'final-link', 'outside', 'physical-outside', 'missing-exec', 'missing-write', 'postcommit-observation'].map(probe => ['cd', probe]),
    ...['missing', 'file', 'final-link', 'outside', 'missing-read'].map(probe => ['ls', probe]),
  ];
  for (const [head, probe] of probes) {
    const effects = grants.filter(grant => !(probe === 'missing-exec' && grant === 'process.exec') && !(probe === 'missing-read' && grant === 'filesystem.read') && !(probe === 'missing-write' && grant === 'session.write'));
    const extra = probe === 'postcommit-observation' ? { observation: async () => ({ ok: false, error: { operation: 'pwd', stage: 'observe', code: 'INJECTED_OBSERVATION', message: 'controlled postcommit observation failure' } }) } : {};
    const scene = await makeScene(api, offset, effects, extra);
    try {
      const before = scene.sandbox.getSession(scene.query), foreignBefore = scene.sandbox.getSession(scene.foreign);
      let target = scene.target;
      if (probe === 'missing-cwd') await rm(before.cwd, { recursive: true });
      if (probe === 'missing') target = join(scene.sandbox.scenarioRoot, 'missing');
      if (probe === 'file') { target = join(scene.sandbox.scenarioRoot, 'plain-file'); await writeFile(target, 'opaque'); }
      if (probe === 'final-link') { target = join(scene.sandbox.scenarioRoot, 'direct-target-link'); await symlink(scene.target, target); }
      if (probe === 'outside') target = dirname(scene.sandbox.scenarioRoot);
      if (probe === 'physical-outside') {
        const outside = join(dirname(scene.sandbox.scenarioRoot), 'outside'); await mkdir(join(outside, 'nested'), { recursive: true });
        await symlink(outside, join(scene.sandbox.scenarioRoot, 'ancestor-link')); target = join(scene.sandbox.scenarioRoot, 'ancestor-link', 'nested');
      }
      const treeBefore = await treeEvidence(scene.sandbox.scenarioRoot);
      // Deliberately adverse typed reference: bindDirectory may refuse missing/outside
      // resources before a command exists. Here the call boundary itself must reject.
      const directory = head !== 'pwd' ? { kind: 'cli.directory', scenarioId: scene.query.scenarioId,
        sessionId: scene.query.sessionId, path: relative(before.cwd, target) || '.' } : undefined;
      const transition = await api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session: scene.query }).step({
        goal: { kind: head === 'pwd' ? 'observe_cwd' : head === 'cd' ? 'set_cwd' : 'list_directory', session: scene.query.sessionId, ...(head !== 'pwd' ? { target } : {}) },
        state: emptyState(scene.query), ...(directory ? { directory } : {}) });
      assert.equal(transition.policy.selectedHead, head); assert.equal(transition.policy_error, null);
      assert.notEqual(transition.goal_result.status, 'achieved');
      if (probe === 'postcommit-observation') {
        assert.equal(transition.goal_result.status, 'unverified'); assert.equal(transition.goal_result.satisfaction, null); assert.equal(transition.goal_result.changed, true);
        assert.equal(transition.session_after.cwd, await realpath(target)); assert.equal(transition.session_after.revision, before.revision + 1);
      } else {
        assert.equal(transition.goal_result.status, 'unmet'); assert.equal(transition.goal_result.satisfaction, 0);
        assert.equal(transition.execution_result.receipt.status, 'failed');
        assert.ok(transition.execution_result.receipt.execution.error.code); assert.deepEqual(scene.sandbox.getSession(scene.query), before);
      }
      assert.deepEqual(scene.sandbox.getSession(scene.foreign), foreignBefore);
      assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore);
      failures.push({ head, probe, source: probe === 'postcommit-observation' ? 'controlled observation injection' : 'native filesystem validation or explicit grant refusal', transition });
    } finally { await scene.cleanup(); }
  }
  let fault = false;
  const scene = await makeScene(api, offset, grants, { listingObserver: async input => {
    if (!fault) return api.runDirectoryListHelper(input);
    const listing = await api.collectDirectoryListing(input.physicalDirectory, { readdir, lstat: async path => {
      if (path === join(input.physicalDirectory, VERIFICATION_RECIPES[offset].files[0])) throw Object.assign(new Error('controlled lstat disappearance'), { code: 'ENOENT' });
      return lstat(path);
    } });
    return { ok: true, observation: { kind: 'directory.list', configuredDirectory: input.configuredDirectory, physicalDirectory: input.physicalDirectory,
      executable: 'controlled-collector', helperPath: 'injected:lstat', argv: [input.physicalDirectory], stdout: JSON.stringify(listing), stderr: '', exitCode: 0,
      entries: listing.entries, errors: listing.errors, coverage: listing.coverage } };
  } });
  try {
    const before = scene.sandbox.getSession(scene.query), treeBefore = await treeEvidence(scene.sandbox.scenarioRoot);
    const directory = await scene.sandbox.bindDirectory(scene.query, relative(before.cwd, scene.target) || '.'), goal = { kind: 'list_directory', session: scene.query.sessionId, target: scene.target };
    const policy = api.createCliCommandPolicy({ profile, sandbox: scene.sandbox, session: scene.query });
    const initial = await policy.step({ goal, state: emptyState(scene.query), directory }); assert.equal(initial.goal_result.status, 'achieved');
    fault = true;
    const partial = await policy.step({ goal, state: initial.observed_state_after, directory });
    assert.equal(partial.policy.selectedHead, 'ls'); assert.equal(partial.goal_result.status, 'unverified'); assert.equal(partial.goal_result.satisfaction, null); assert.equal(partial.goal_result.reason, 'partial_coverage');
    const observed = partial.execution_result.receipt.execution.observation;
    assert.equal(observed.coverage, 'partial'); assert.equal(observed.entries.find(entry => entry.name === scene.spec.files[0]).type, 'unknown');
    assert.deepEqual(observed.errors.map(({ name, code }) => ({ name, code })), [{ name: scene.spec.files[0], code: 'ENOENT' }]);
    assert.equal(observed.entries.length, scene.spec.files.length + scene.spec.directories.length + scene.spec.links.length);
    assert.deepEqual(partial.observed_state_after, initial.observed_state_after);
    assert.deepEqual(scene.sandbox.getSession(scene.query), before); assert.deepEqual(await treeEvidence(scene.sandbox.scenarioRoot), treeBefore);
    failures.push({ head: 'ls', probe: 'partial-lstat', source: 'controlled lstat fault; native readdir and native lstat for other entries; no helper process in injected call', transition: partial });
  } finally { await scene.cleanup(); }
  assert.equal(await readFile(process.env.NN_CLI_COMMAND_PROFILE, 'utf8'), profileText); assert.equal(process.cwd(), parentCwd);
  assert.equal(rows.length, 16); assert.equal(failures.length, 16);
  const report = { stage: 'shared-cli', profilePath: process.env.NN_CLI_COMMAND_PROFILE, batch: offset === 0 ? 'original' : 'fresh',
    actionCorrect: 16, actionCount: 16, normalByCommand: { pwd: 4, cd: 4, ls: 4, unsupported: 4 }, relationCorrect: relationRows.length,
    failureByCommand: { pwd: 2, cd: 8, ls: 6 }, controlledFailureProbes: 2, nativeOrGrantFailureProbes: 14,
    supplementalPwdCalls, additionalCdCommits, secondarySessionLists, elapsedMs: performance.now() - started, rows, failures, relationRows,
    limits: 'Four finite semantic vectors. Independently authored environment coverage does not establish unseen Goal semantics. Historical concept profile is not a command selector.' };
  if (process.env.NN_CLI_VERIFICATION_REPORT) await writeFile(process.env.NN_CLI_VERIFICATION_REPORT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ independentSharedCli: { ...report, rows: undefined, failures: undefined, relationRows: undefined } }));
});
