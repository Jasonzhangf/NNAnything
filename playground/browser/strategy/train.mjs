import { readFile } from 'node:fs/promises';
import {
  createZeroBrowserStrategyProfile,
  makeStrategySamples,
  runBrowserStrategyTraining,
} from 'nnanything/browser-strategy';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), [
  '--atomic-profile',
  '--feedback-profile',
  '--handwired-root',
  '--samples',
  '--output',
]);
for (const name of ['--atomic-profile', '--feedback-profile', '--handwired-root', '--output']) {
  if (!args.get(name)) throw new Error(`Explicit ${name} required`);
}

const samplesPath = args.get('--samples');
const episodes = samplesPath
  ? JSON.parse(await readFile(samplesPath, 'utf8'))
  : makeStrategySamples();
const atomicProfile = JSON.parse(await readFile(args.get('--atomic-profile'), 'utf8'));
const feedbackProfile = JSON.parse(await readFile(args.get('--feedback-profile'), 'utf8'));
const receipt = await runBrowserStrategyTraining({
  initial: createZeroBrowserStrategyProfile(),
  episodes,
  epochs: 200,
  learningRate: 0.1,
}, {
  atomicProfile,
  feedbackProfile,
  handwiredRoot: args.get('--handwired-root'),
  outputDirectory: args.get('--output'),
});

console.log(JSON.stringify({
  accepted: receipt.accepted,
  error: receipt.error,
  candidatePath: receipt.candidatePath,
  reportPath: receipt.reportPath,
  calibration: receipt.profile.calibration,
  adoption: receipt.profile.adoption,
  samplesSource: samplesPath ? 'explicit_file' : 'built_in_synthetic_projection',
  timing: receipt.fit.timing,
  train: receipt.comparison.train,
  development: receipt.comparison.development,
}, null, 2));
if (!receipt.accepted) process.exitCode = 1;
