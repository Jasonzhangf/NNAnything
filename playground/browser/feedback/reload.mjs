import { readFile } from 'node:fs/promises';
import { evaluateFeedbackCases, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';
const args = parseArgs(process.argv.slice(2), ['--profile', '--cases']);
if (!args.get('--profile') || !args.get('--cases')) throw new Error('Explicit --profile and --cases required');
const profile = validateFeedbackProfile(JSON.parse(await readFile(args.get('--profile'), 'utf8')));
const result = evaluateFeedbackCases(profile, JSON.parse(await readFile(args.get('--cases'), 'utf8')));
console.log(JSON.stringify({ fitted: false, processId: process.pid, calibration: profile.calibration, adoption: profile.adoption, ...result }, null, 2));
if (result.failed) process.exitCode = 1;
