import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserFeedbackUnit, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), ['--initial', '--samples', '--handwired-root', '--objective', '--epochs', '--learning-rate', '--output']);
if (!args.get('--initial') || !args.get('--samples') || !args.get('--handwired-root') || !args.get('--output')) {
  throw new Error('Explicit --initial, --samples, --handwired-root and --output required');
}
const objective = args.get('--objective') ?? 'class_balanced_projection_coverage';
if (objective !== 'class_balanced_projection_coverage') throw new Error('Only class_balanced_projection_coverage is authorized');
const epochs = Number(args.get('--epochs') ?? 2700);
const learningRate = Number(args.get('--learning-rate') ?? 0.1);
if (!Number.isInteger(epochs) || epochs <= 0) throw new Error('--epochs must be a positive integer');
if (!Number.isFinite(learningRate) || learningRate <= 0) throw new Error('--learning-rate must be a positive number');

const initial = validateFeedbackProfile(JSON.parse(await readFile(resolve(args.get('--initial')), 'utf8')));
if (initial.adoption !== 'not_applied') throw new Error('Initial profile must stay not_applied');
const episodes = JSON.parse(await readFile(resolve(args.get('--samples')), 'utf8'));

const result = await browserFeedbackUnit.train(
  { episodes, initial, epochs, learningRate, objective },
  { handwiredRoot: args.get('--handwired-root'), outputDirectory: resolve(args.get('--output')) },
);

console.log(JSON.stringify({
  accepted: result.accepted,
  error: result.error,
  candidatePath: result.candidatePath,
  reportPath: result.reportPath,
  calibration: result.profile.calibration,
  adoption: result.profile.adoption,
  objective: result.fit.objective,
  timing: result.fit.timing,
  train: result.comparison.train.trained,
  development: result.comparison.development.trained,
  zeroTrain: result.comparison.train.zero,
  zeroDevelopment: result.comparison.development.zero,
}, null, 2));
if (!result.accepted) process.exitCode = 1;
