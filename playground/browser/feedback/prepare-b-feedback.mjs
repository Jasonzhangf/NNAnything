import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  auditFeedbackProjections,
  predictFeedback,
  readFeedbackEpisodes,
  validateFeedbackProfile,
} from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';
import { buildPartitionRecord } from './data-usage.mjs';

const args = parseArgs(process.argv.slice(2), ['--run', '--initial', '--training', '--r5']);
const run = args.get('--run');
const initialPath = args.get('--initial');
if (!run || !initialPath) throw new Error('Explicit --run and --initial required');

const trainingPath = args.get('--training')
  ?? '/Volumes/Intel/playground/nnanything-runs/f1-robustness-20261021/training-episodes.json';
const r5Path = args.get('--r5')
  ?? '/Volumes/Intel/playground/nnanything-runs/f1-robustness-20261021/holdout/r5-corrected-cases.json';

const initial = validateFeedbackProfile(JSON.parse(await readFile(resolve(initialPath), 'utf8')));
const historical = readFeedbackEpisodes(JSON.parse(await readFile(resolve(trainingPath), 'utf8')));
const r5Cases = JSON.parse(await readFile(resolve(r5Path), 'utf8'));
if (!Array.isArray(r5Cases) || r5Cases.length !== 4) throw new Error('R5 regression family must hold exactly four rows');

const evidenceRef = input => {
  const ids = [
    ...(input.request?.state?.evidence ?? []),
    ...(input.result?.newState?.evidence ?? []),
  ].map(fact => fact.id).filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) throw new Error('R5 row has no evidence reference');
  return ids[0];
};

const r5Episodes = r5Cases.map(row => ({
  id: `r5-known-regression:${row.id}`,
  family: 'r5-known-regression',
  partition: 'train',
  input: row.input,
  teacher: {
    head: row.expected.head,
    source: 'observed_episode',
    evidenceRefs: [evidenceRef(row.input)],
    note: `Known R5 regression from ${row.author ?? 'independent author'}; ${row.goldReason}. Corrected effects receipt; gold unchanged.`,
  },
}));

const merged = readFeedbackEpisodes([...historical, ...r5Episodes]);
const audit = auditFeedbackProjections(merged);
const initialRows = merged.filter(row => row.partition !== 'verification').map(row => {
  const prediction = predictFeedback(row.input, initial);
  return { id: row.id, expected: row.teacher.head, actual: prediction.status === 'predicted' ? prediction.head : null };
});
const r5Baseline = initialRows.filter(row => row.id.startsWith('r5-known-regression:'));
if (r5Baseline.some(row => row.actual === row.expected)) {
  throw new Error('R5 baseline already passes the initial candidate; do not treat it as a reproduced regression');
}

const data = resolve(run, 'data');
await mkdir(data, { recursive: true });
await writeFile(resolve(data, 'train-development.json'), `${JSON.stringify(merged, null, 2)}\n`);
await writeFile(resolve(data, 'r5-regression.json'), `${JSON.stringify(r5Cases, null, 2)}\n`);

const train = merged.filter(row => row.partition === 'train');
const development = merged.filter(row => row.partition === 'development');
const partition = {
  ...buildPartitionRecord({
    total: merged.length,
    train: train.length,
    development: development.length,
    projections: audit.projectionCount,
    r5Rows: r5Episodes.length,
    historicalSource: resolve(trainingPath),
    r5Source: resolve(r5Path),
  }),
  initialProfile: resolve(initialPath),
  families: [...new Set(merged.map(row => `${row.family}/${row.partition}`))],
  r5Baseline,
};
await writeFile(resolve(data, 'partition-record.json'), `${JSON.stringify(partition, null, 2)}\n`);
await writeFile(resolve(data, 'README.md'), `# F1 material

- \`train-development.json\`: ${merged.length} episodes (${train.length} train, ${development.length} development), ${audit.projectionCount} distinct 12-wire projections.
- \`r5-regression.json\`: the four corrected R5 rows, unchanged.
- R5 is folded into train as a known regression (\`r5-known-regression\`). It is not a fresh holdout and must not be scored as one.
- Historical source: \`${resolve(trainingPath)}\`.
- R5 source: \`${resolve(r5Path)}\`.
- Fresh independent 24-case material and the 72 transformations stay outside this file and outside the fitter.
- The initial candidate fails all four R5 rows: ${JSON.stringify(r5Baseline)}.
- Candidate adoption stays \`not_applied\`.
`);

console.log(JSON.stringify({ data, total: merged.length, train: train.length, development: development.length,
  projections: audit.projectionCount, r5Baseline }, null, 2));
