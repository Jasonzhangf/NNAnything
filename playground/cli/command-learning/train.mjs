import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeCliCommandFixture, runCliCommandTraining, zeroCliCommandProfile } from 'nnanything/cli-goal';

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--handwired-root', '--output-root', '--epochs', '--learning-rate'].includes(args[index]) || args[index + 1] === undefined || options.has(args[index])) throw new Error('Expected --handwired-root PATH [--output-root PATH] [--epochs N] [--learning-rate N]');
  options.set(args[index], args[index + 1]);
}
if (!options.has('--handwired-root')) throw new Error('Explicit --handwired-root required');
const outputRoot = options.get('--output-root') ?? fileURLToPath(new URL('../../../training/', import.meta.url));
const ownerRoot = await mkdtemp(join(tmpdir(), 'nn-shared-training-owner-'));
const stages = [], started = performance.now();
try {
  await mkdir(outputRoot, { recursive: true });
  const { dataset } = await makeCliCommandFixture({ root: ownerRoot });
  let initial = zeroCliCommandProfile([]), initialSource = null;
  const names = [];
  for (const name of ['pwd', 'cd', 'ls']) {
    names.push(name);
    // Read the previous saved candidate; no independent command profile or zero restart.
    if (initialSource !== null) initial = JSON.parse(await readFile(initialSource, 'utf8'));
    const receipt = await runCliCommandTraining({ dataset, commands: [...names], initial, initialSource,
      epochs: Number(options.get('--epochs') ?? 200), learningRate: Number(options.get('--learning-rate') ?? 0.1) },
    { handwiredRoot: options.get('--handwired-root'), outputRoot, grantedEffects: ['filesystem.read', 'filesystem.write'] });
    assert.equal(receipt.accepted, true, `${name} stage did not meet train/dev and historical gates`);
    assert.equal(receipt.fullyVerified, false);
    assert.equal(receipt.verification.status, 'not_provided');
    assert.equal(receipt.comparison.train.count, (names.length + 1) * 4);
    assert.equal(receipt.comparison.development.count, (names.length + 1) * 2);
    assert.equal(receipt.timing.gradientRowEpochs, receipt.comparison.train.count * Number(options.get('--epochs') ?? 200));
    for (const command of names) {
      assert.equal(receipt.comparison.train.byCommand[command].effectsCorrect, 4);
      assert.equal(receipt.comparison.development.byCommand[command].effectsCorrect, 2);
    }
    assert.equal(receipt.controls.zero.correct, 4);
    const reloadStarted = performance.now();
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./reload.mjs', import.meta.url)), receipt.paths.profile, receipt.paths.samples, receipt.paths.report], { encoding: 'utf8' });
    const reload = JSON.parse(stdout);
    assert.equal(reload.checked, receipt.comparison.train.count + receipt.comparison.development.count);
    stages.push({ name, runId: receipt.runId, paths: receipt.paths, initialSource, parameterCount: receipt.profile.weights.flat().length,
      train: receipt.comparison.train.byCommand, development: receipt.comparison.development.byCommand,
      controls: { zeroCorrect: receipt.controls.zero.correct, frozenCorrect: receipt.controls.frozen.correct },
      regression: receipt.regression, timing: receipt.timing, reload, reloadMs: performance.now() - reloadStarted });
    initialSource = receipt.paths.profile;
  }
  const summary = { stages, finalProfile: initialSource, consumerMs: performance.now() - started,
    calibration: 'uncalibrated', adoption: 'not_applied', independentVerification: 'separate; not part of this training consumer' };
  const reportDirectory = stages.at(-1).paths.report.slice(0, stages.at(-1).paths.report.lastIndexOf('/'));
  await writeFile(join(reportDirectory, 'consumer-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
} finally { await rm(ownerRoot, { recursive: true, force: true }); }
