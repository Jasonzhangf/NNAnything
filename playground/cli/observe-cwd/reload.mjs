import { readFile } from 'node:fs/promises';
import {
  createCliGoalPolicy,
  evaluateCliGoalSamples,
  prepareCliGoalDataset,
  validateCliGoalProfile,
} from 'nnanything/cli-goal';

if (process.argv.length !== 4) throw new Error('Usage: reload.mjs PROFILE_FILE SAMPLES_FILE');
const profile = validateCliGoalProfile(JSON.parse(await readFile(process.argv[2], 'utf8')));
const prepared = prepareCliGoalDataset(JSON.parse(await readFile(process.argv[3], 'utf8')));
const samples = [...prepared.train, ...prepared.development];
const evaluation = await evaluateCliGoalSamples(samples, profile, (current, session) => createCliGoalPolicy({ profile: current, session }));
process.stdout.write(JSON.stringify(evaluation));
