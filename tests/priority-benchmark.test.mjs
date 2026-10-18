import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_CONFIG } from '../dist/browser-classify.js';
import * as browser from '../dist/browser-classify.js';
import { pairOutcomes, summarizeOutcomes } from '../scripts/benchmark-priority-training.mjs';

test('comparison keeps arm-specific transitions and counts predictions by predicted class', () => {
  const row = { sampleId: 'one', expectedLabel: 'text' };
  const correct = { ...row, correct: true, judgment: { judgmentStatus: 'judged', basicKind: 'text' } };
  const wrong = { ...row, correct: false, judgment: { judgmentStatus: 'judged', basicKind: 'button' } };
  const paired = pairOutcomes([correct], [wrong], [correct], [row]);
  const legacy = summarizeOutcomes(paired.legacy, browser);
  const priority = summarizeOutcomes(paired.priority, browser);
  assert.equal(legacy.transitions.regressed, 1);
  assert.equal(priority.transitions.regressed, 0);
  assert.equal(priority.transitions.retained, 1);
  assert.equal(legacy.byClass.button.predicted, 1);
  assert.equal(legacy.byClass.text.predicted, 0);
  assert.equal(legacy.byClass.button.precision, 0);
});

test('benchmark CLI preserves backend failure and persists partial timing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nnanything-benchmark-'));
  try {
    const fixture = JSON.parse(await readFile(new URL('../playground/training/reviewed.fixture.json', import.meta.url), 'utf8'));
    const input = join(root, 'input.json');
    const reference = join(root, 'reference.json');
    const notes = join(root, 'notes.json');
    await writeFile(input, JSON.stringify(fixture));
    await writeFile(reference, JSON.stringify({ profile: DEFAULT_BASIC_KIND_PROFILE, config: DEFAULT_BASIC_KIND_CONFIG, groups: [] }));
    await writeFile(notes, JSON.stringify({ schemaVersion: 1, taskId: fixture.taskId, counts: {
      sourceUniqueRows: 6, processedTrainingRows: 6, augmentationRows: 0, uniqueSampleIds: 6, duplicateSampleIds: 0,
    } }));
    const out = join(root, 'reports');
    const result = spawnSync(process.execPath, ['scripts/benchmark-priority-training.mjs',
      '--input', input, '--reference-weight', reference, '--gold-reference', reference,
      '--dataset-notes', notes, '--handwired-root', join(root, 'missing-backend'),
      '--out-dir', out, '--weights-dir', join(root, 'weights')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Handwired core is missing/);
    const report = JSON.parse(await readFile(join(out, 'priority-benchmark-report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.fits.legacyRetrain.timing.completedEpochs, 0);
    assert.ok(report.fits.legacyRetrain.timing.fitTotalMs >= 0);
    assert.match(report.failure.message, /Handwired core is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
