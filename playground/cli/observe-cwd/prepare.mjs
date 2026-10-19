import { writeFile } from 'node:fs/promises';
import { makeCliGoalFixture, prepareCliGoalDataset } from 'nnanything/cli-goal';

const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!['--cwd', '--output'].includes(flag) || value === undefined || values.has(flag)) {
    throw new Error('Usage: prepare.mjs --cwd ABSOLUTE_DIRECTORY [--output NEW_FILE]');
  }
  values.set(flag, value);
}
if (!values.has('--cwd')) throw new Error('--cwd ABSOLUTE_DIRECTORY is required');
const fixture = makeCliGoalFixture({ cwd: values.get('--cwd') });
const prepared = prepareCliGoalDataset(fixture);
const text = JSON.stringify(fixture, null, 2) + '\n';
if (values.has('--output')) {
  await writeFile(values.get('--output'), text, { flag: 'wx' });
  console.log(JSON.stringify({
    samplesFile: values.get('--output'),
    train: prepared.train.length,
    development: prepared.development.length,
    fitRows: prepared.rows.length,
    uniqueFeatureVectors: new Set(prepared.rows.map(row => JSON.stringify(row.features))).size,
  }));
} else process.stdout.write(text);
