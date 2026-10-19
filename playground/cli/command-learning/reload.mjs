import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createCliCommandPolicy, createCliFilesystemSandbox, predictCliCommand, validateCliCommandProfile } from 'nnanything/cli-goal';

const [profilePath, datasetPath, reportPath] = process.argv.slice(2);
const profile = validateCliCommandProfile(JSON.parse(await readFile(profilePath, 'utf8')));
const dataset = JSON.parse(await readFile(datasetPath, 'utf8')), report = JSON.parse(await readFile(reportPath, 'utf8'));
let executions = 0, checked = 0;
for (const recorded of [...report.comparison.train.rows, ...report.comparison.development.rows]) {
  const prediction = predictCliCommand(recorded.transition.goal, profile);
  assert.deepEqual(prediction, recorded.transition.policy);
  const sample = dataset.samples.find(row => row.id === recorded.id), scene = dataset.scenarios.find(row => row.id === sample.scenarioId);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nn-shared-reload-')));
  let sandbox;
  try {
    sandbox = await createCliFilesystemSandbox({ root, recipe: scene.recipe, ownerGrantedEffects: ['filesystem.write'] });
    const session = sandbox.bindSession('s'), before = sandbox.getSession(session), target = join(sandbox.scenarioRoot, scene.targetPath);
    const directory = ['cd', 'ls'].includes(sample.expectedHead) ? await sandbox.bindDirectory(session, relative(before.cwd, target) || '.') : undefined;
    const transition = await createCliCommandPolicy({ profile, sandbox, session }).step({
      goal: { kind: sample.goalKind, session: 's', ...(['cd', 'ls'].includes(sample.expectedHead) ? { target } : {}) },
      state: { session: 's', cwdObservation: null, directoryListing: null }, ...(directory ? { directory } : {}),
    });
    assert.equal(transition.policy.selectedHead, sample.expectedHead);
    assert.equal(transition.goal_result.status, sample.expectedHead === 'unsupported' ? 'unverified' : 'achieved');
    assert.equal(transition.goal_result.satisfaction, sample.expectedHead === 'unsupported' ? null : 100);
    if (sample.expectedHead !== 'unsupported') {
      executions++;
      assert.equal(transition.invocation[0], sample.expectedHead);
      if (sample.expectedHead === 'cd') assert.equal(transition.postcondition.matchedTarget, true);
      if (sample.expectedHead === 'ls') {
        const normalize = items => items.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        assert.deepEqual(normalize(transition.observed_state_after.directoryListing.entries), normalize(scene.expectedEntries));
      }
    } else assert.equal(transition.invocation, null);
    checked++;
  } finally { if (sandbox) await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ profilePath, checked, executions, fitted: false, processId: process.pid }));
