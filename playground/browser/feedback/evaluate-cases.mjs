import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { predictFeedback, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), ['--profile', '--cases', '--out']);
if (!args.get('--profile') || !args.get('--cases')) throw new Error('Explicit --profile and --cases required');
const profile = validateFeedbackProfile(JSON.parse(await readFile(resolve(args.get('--profile')), 'utf8')));
const cases = JSON.parse(await readFile(resolve(args.get('--cases')), 'utf8'));
if (!Array.isArray(cases) || cases.length === 0) throw new Error('Cases must be a nonempty array');

const rows = cases.map(row => {
  const expected = row.expected ?? { status: 'predicted', head: row.teacher?.head ?? null };
  const prediction = predictFeedback(row.input, profile);
  const passed = prediction.status === expected.status && prediction.head === expected.head;
  return { id: row.id, source: row.family ?? null, expected, actual: { status: prediction.status, head: prediction.head },
    features: prediction.features, scores: prediction.scores, passed };
});
const evaluation = { fitted: false, processId: process.pid, calibration: profile.calibration, adoption: profile.adoption,
  cases: resolve(args.get('--cases')), count: rows.length, passed: rows.filter(row => row.passed).length,
  failed: rows.filter(row => !row.passed).length, rows };
if (args.get('--out')) {
  const out = resolve(args.get('--out'));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evaluation, null, 2)}\n`);
}
console.log(JSON.stringify({ processId: process.pid, count: evaluation.count, passed: evaluation.passed,
  failed: evaluation.failed, misses: rows.filter(row => !row.passed).map(row => row.id) }, null, 2));
if (evaluation.failed > 0) process.exitCode = 1;
