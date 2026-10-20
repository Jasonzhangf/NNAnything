import { readFile } from 'node:fs/promises';
import { browserFeedbackUnit, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';
const args = parseArgs(process.argv.slice(2), ['--profile', '--input']);
if (!args.get('--profile') || !args.get('--input')) throw new Error('Explicit --profile and --input required');
const profile = validateFeedbackProfile(JSON.parse(await readFile(args.get('--profile'), 'utf8')));
console.log(JSON.stringify(await browserFeedbackUnit.infer(JSON.parse(await readFile(args.get('--input'), 'utf8')), { profile }), null, 2));
