import { readFile } from 'node:fs/promises';
import {
  evaluateStrategyCases,
  readStrategyEpisodes,
  validateBrowserStrategyProfile,
} from 'nnanything/browser-strategy';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), [
  '--profile',
  '--atomic-profile',
  '--feedback-profile',
  '--cases',
]);
for (const name of ['--profile', '--atomic-profile', '--feedback-profile', '--cases']) {
  if (!args.get(name)) throw new Error(`Explicit ${name} required`);
}

const profile = validateBrowserStrategyProfile(JSON.parse(await readFile(args.get('--profile'), 'utf8')));
const atomicProfile = JSON.parse(await readFile(args.get('--atomic-profile'), 'utf8'));
const feedbackProfile = JSON.parse(await readFile(args.get('--feedback-profile'), 'utf8'));
const episodes = readStrategyEpisodes(JSON.parse(await readFile(args.get('--cases'), 'utf8')));
const evaluation = evaluateStrategyCases(profile, episodes, { atomicProfile, feedbackProfile });

console.log(JSON.stringify({
  fitted: false,
  processId: process.pid,
  calibration: profile.calibration,
  adoption: profile.adoption,
  ...evaluation,
}, null, 2));
if (evaluation.failed > 0) process.exitCode = 1;
