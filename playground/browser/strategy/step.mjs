import { readFile } from 'node:fs/promises';
import {
  predictBrowserStrategy,
  readBrowserStrategyRequest,
  validateBrowserStrategyProfile,
} from 'nnanything/browser-strategy';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), [
  '--profile',
  '--atomic-profile',
  '--feedback-profile',
  '--request',
]);
for (const name of ['--profile', '--atomic-profile', '--feedback-profile', '--request']) {
  if (!args.get(name)) throw new Error(`Explicit ${name} required`);
}

const profile = validateBrowserStrategyProfile(JSON.parse(await readFile(args.get('--profile'), 'utf8')));
const atomicProfile = JSON.parse(await readFile(args.get('--atomic-profile'), 'utf8'));
const feedbackProfile = JSON.parse(await readFile(args.get('--feedback-profile'), 'utf8'));
const raw = JSON.parse(await readFile(args.get('--request'), 'utf8'));
const input = readBrowserStrategyRequest({ request: raw.request, history: raw.history });
const prediction = predictBrowserStrategy(input, {
  profile,
  atomicProfile,
  feedbackProfile,
  registry: raw.registry,
  selection: raw.selection,
});

console.log(JSON.stringify({
  executed: false,
  calibration: profile.calibration,
  adoption: profile.adoption,
  prediction,
}, null, 2));
