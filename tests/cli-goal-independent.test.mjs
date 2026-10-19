import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This suite consumes a saved candidate. It never constructs training data or fits.
// CLI_GOAL_INDEPENDENT_REPORT saves complete observed transitions for inspection.
test('saved candidate: independent semantic and real macOS fixture evaluation', {
  skip: !process.env.CLI_GOAL_PROFILE && 'set CLI_GOAL_PROFILE to the trained candidate',
}, async () => {
  const { createCliGoalPolicy, zeroCliGoalProfile } = await import('nnanything/cli-goal');
  const profile = JSON.parse(await readFile(process.env.CLI_GOAL_PROFILE, 'utf8'));
  const untouched = JSON.stringify(profile);
  const root = await mkdtemp(join(tmpdir(), 'cwd-independent-'));
  const originalCwd = process.cwd();
  const grants = ['filesystem.read', 'process.exec'];
  const rows = [], probes = [];
  const start = performance.now();
  const knowledge = path => ({ physicalCwd: path, sourceRun: 'independent-old-observation', evidence: {
    kind: 'pwd', configuredCwd: path, physicalCwd: path, executable: '/bin/pwd', argv: ['-P'],
    stdout: `${path}\n`, stderr: '', exitCode: 0,
  } });
  try {
    const names = ['plain', 'two words', 'trailing space ', '中文目录', 'second'];
    const dirs = {};
    for (const name of names) { dirs[name] = join(root, name); await mkdir(dirs[name]); }
    const link = join(root, 'alias');
    await symlink(dirs.plain, link);
    const file = join(root, 'a-file');
    await writeFile(file, 'retained fixture');
    const missing = join(root, 'not-created');
    const cases = [
      ...['plain', 'two words', 'trailing space ', '中文目录'].map(name => ({ id: name, cwd: dirs[name] })),
      { id: 'link', cwd: link },
      { id: 'stale', cwd: dirs.plain, prior: knowledge('/independent/stale') },
      { id: 'repeat', cwd: dirs.plain, repeat: true },
      { id: 'isolated-second', cwd: dirs.second },
      { id: 'missing', cwd: missing, code: 'ENOENT' },
      { id: 'file', cwd: file, code: 'ENOTDIR' },
      { id: 'no-read', cwd: dirs.plain, grants: ['process.exec'], code: 'EFFECT_DENIED' },
      { id: 'no-exec', cwd: dirs.plain, grants: ['filesystem.read'], code: 'EFFECT_DENIED' },
      { id: 'neither', cwd: dirs.plain, grants: [], code: 'EFFECT_DENIED' },
      { id: 'set', cwd: dirs.plain, kind: 'set_cwd' },
      { id: 'set-missing', cwd: missing, kind: 'set_cwd', grants: [] },
      { id: 'read', cwd: missing, kind: 'read_file', grants: [] },
      { id: 'search', cwd: dirs.plain, kind: 'search_symbol' },
      { id: 'opaque', cwd: dirs.second, kind: 'opaque_kind_529' },
    ];
    for (const item of cases) {
      const session = { id: `independent:${item.id}`, cwd: item.cwd, grantedEffects: item.grants ?? grants };
      const goal = { kind: item.kind ?? 'observe_cwd', session: session.id,
        ...(item.kind === 'set_cwd' ? { target: dirs.second } : {}) };
      const policy = createCliGoalPolicy({ profile, session });
      let state = { session: session.id, cwdObservation: item.prior ?? (item.code ? knowledge('/old/not-current') : null) };
      let previousRun;
      if (item.repeat) {
        const first = await policy.step({ goal, state });
        assert.equal(first.goal_result.status, 'achieved');
        state = first.observed_state_after;
        previousRun = first.execution_result.runId;
        probes.push({ id: 'repeat-first', transition: first });
      }
      const snapshot = structuredClone(state);
      const transition = await policy.step({ goal, state });
      assert.deepEqual(state, snapshot, `${item.id}: input state mutated`);
      assert.deepEqual(transition.state_before, snapshot);
      assert.deepEqual(transition.goal, goal);
      assert.equal(session.cwd, item.cwd);
      assert.equal(process.cwd(), originalCwd);
      const expectedAction = item.kind ? 'REJECT' : 'PWD';
      assert.equal(transition.policy.selectedAction, expectedAction, item.id);
      assert.equal(transition.policy_error, null, item.id);
      if (item.kind) {
        assert.equal(transition.execution_result.status, 'rejected');
        assert.equal(transition.execution_result.executorInvoked, false);
        assert.equal(transition.goal_result.status, 'unmet');
        assert.deepEqual(transition.observed_state_after, snapshot);
      } else if (item.code) {
        assert.equal(transition.execution_result.status, 'failed');
        assert.equal(transition.execution_result.error.code, item.code);
        assert.equal(transition.goal_result.status, 'unmet');
        assert.deepEqual(transition.observed_state_after, snapshot);
      } else {
        const expectedPhysical = await realpath(item.cwd);
        assert.equal(transition.execution_result.status, 'succeeded');
        const observed = transition.execution_result.observation;
        assert.equal(observed.executable, '/bin/pwd');
        assert.deepEqual(observed.argv, ['-P']);
        assert.equal(observed.exitCode, 0);
        assert.equal(observed.configuredCwd, item.cwd);
        assert.equal(observed.physicalCwd, expectedPhysical);
        assert.equal(observed.stdout, `${expectedPhysical}\n`);
        assert.equal(transition.goal_result.status, 'achieved');
        assert.equal(transition.observed_state_after.session, session.id);
        assert.deepEqual(transition.observed_state_after.cwdObservation.evidence, observed);
        assert.equal(transition.observed_state_after.cwdObservation.physicalCwd, expectedPhysical);
        assert.equal(transition.observed_state_after.cwdObservation.sourceRun, transition.execution_result.runId);
        assert.notEqual(transition.execution_result.runId, previousRun);
      }
      rows.push({ id: item.id, expectedAction, transition });
    }
    const session = { id: 'independent:probe', cwd: dirs.plain, grantedEffects: grants };
    const state = { session: session.id, cwdObservation: knowledge('/old/stale') };
    const zero = await createCliGoalPolicy({ profile: zeroCliGoalProfile(), session }).step({
      goal: { kind: 'observe_cwd', session: session.id }, state,
    });
    assert.equal(zero.policy.selectedAction, 'REJECT');
    assert.equal(zero.goal_result.status, 'unmet');
    assert.equal(zero.execution_result.executorInvoked, false);
    assert.deepEqual(zero.observed_state_after, state);
    probes.push({ id: 'zero-cannot-use-stale-evidence', transition: zero });
    const hostile = structuredClone(zeroCliGoalProfile()); hostile.weights[1] = [10, 0, 0];
    const refused = await createCliGoalPolicy({ profile: hostile, session }).step({
      goal: { kind: 'set_cwd', session: session.id, target: dirs.second }, state,
    });
    assert.equal(refused.policy.selectedAction, 'PWD');
    assert.equal(refused.policy_error.code, 'UNEXPECTED_ACTION');
    assert.equal(refused.execution_result.executorInvoked, false);
    assert.equal(refused.goal_result.status, 'unmet');
    probes.push({ id: 'hostile-guard-not-policy-success', transition: refused });
    await assert.rejects(createCliGoalPolicy({ profile, session }).step({
      goal: { kind: 'observe_cwd', session: 'different-session' }, state,
    }), /session/i);
    assert.equal(JSON.stringify(profile), untouched);
    assert.equal(await readFile(file, 'utf8'), 'retained fixture');
    assert.equal(rows.length, 18);
    assert.equal(rows.filter(row => row.transition.goal_result.status === 'achieved').length, 8);
    const report = {
      sampleCount: rows.length, correctActions: 18, eligibleSuccesses: 8, achievedGoals: 8,
      expectedUnmet: 10, expectedUnmetVerified: 10, uniqueFeatureVectors: 3,
      extraProbeCount: probes.length + 1, elapsedMs: performance.now() - start,
      limits: 'Independent fixtures and OS coverage; no unseen semantic feature vectors.', rows, probes,
    };
    if (process.env.CLI_GOAL_INDEPENDENT_REPORT) {
      await writeFile(process.env.CLI_GOAL_INDEPENDENT_REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    console.log(JSON.stringify({ independent: { ...report, rows: undefined, probes: undefined } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
