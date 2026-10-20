import { readFile } from 'node:fs/promises';
import { browserFeedbackUnit, createZeroFeedbackProfile, makeFeedbackSamples } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';
const args = parseArgs(process.argv.slice(2), ['--handwired-root', '--samples', '--output']);
if (!args.get('--handwired-root') || !args.get('--output')) throw new Error('Explicit --handwired-root and --output required');
const episodes = args.has('--samples') ? JSON.parse(await readFile(args.get('--samples'), 'utf8')) : makeFeedbackSamples();
const result = await browserFeedbackUnit.train({ episodes, initial: createZeroFeedbackProfile(), epochs: 200, learningRate: 0.1 }, {
  handwiredRoot: args.get('--handwired-root'), outputDirectory: args.get('--output'),
});
console.log(JSON.stringify({ accepted: result.accepted, error: result.error, candidatePath: result.candidatePath, reportPath: result.reportPath,
  timing: result.fit.timing, train: result.comparison.train, development: result.comparison.development }, null, 2));
if (!result.accepted) process.exitCode = 1;
