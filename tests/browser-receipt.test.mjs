import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBrowserReceiptInput, validateBrowserReceiptProfile, predictBrowserReceipt, createZeroBrowserReceiptProfile, browserReceiptFeatures } from 'nnanything/browser-receipt';

const RECEIPT_RUN = '/Volumes/Intel/playground/nnanything-runs/atomic-refusal-20261021';

function validProfile() {
  return createZeroBrowserReceiptProfile();
}
function tmpDir() {
  return mkdtemp(join(tmpdir(), 'receipt-red-'));
}

test('readBrowserReceiptInput accepts the three legal projections and preserves extra fields', () => {
  assert.deepEqual(browserReceiptFeatures(readBrowserReceiptInput({ receipt: null })), [1, 0, 0]);
  assert.deepEqual(browserReceiptFeatures(readBrowserReceiptInput({ receipt: { ok: false, error: null } })), [1, 1, 0]);
  assert.deepEqual(browserReceiptFeatures(readBrowserReceiptInput({ receipt: { ok: true, source: 'native.input' } })), [1, 1, 1]);
  const input = readBrowserReceiptInput({ receipt: { ok: false, error: { code: 'x' }, effectKnowledge: 'unknown' } });
  assert.equal(input.receipt.ok, false);
  assert.equal(input.receipt.error.code, 'x');
});
test('readBrowserReceiptInput rejects missing field, undefined, array, and non-boolean ok', () => {
  for (const bad of [{}, { receipt: undefined }, { receipt: [] }, { receipt: { ok: 'yes' } }, { receipt: { ok: 1 } }]) {
    assert.throws(() => readBrowserReceiptInput(bad), /receipt/);
  }
});
test('predictBrowserReceipt with zero weights is undecided, not a guessed head', () => {
  const prediction = predictBrowserReceipt({ receipt: { ok: false } }, validProfile());
  assert.equal(prediction.status, 'undecided');
  assert.equal(prediction.head, null);
  assert.equal(prediction.satisfaction, null);
});
test('validateBrowserReceiptProfile rejects wrong schema, heads, wires, weights shape, non-finite weight, and wrong state', () => {
  const base = validProfile();
  assert.throws(() => validateBrowserReceiptProfile({ ...base, schema: 'other' }), /schema/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, heads: ['explicit_failure', 'explicit_success'] }), /heads/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, wires: ['bias', 'receipt.present'] }), /wires/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, weights: [[0, 0]] }), /weights/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, weights: base.weights.map(row => row.map(() => Number.NaN)) }), /weights/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, state: { calibration: 'calibrated', application: 'not_applied' } }), /state/);
  assert.throws(() => validateBrowserReceiptProfile({ ...base, state: { calibration: 'uncalibrated', application: 'applied' } }), /state/);
  assert.doesNotThrow(() => validateBrowserReceiptProfile(base));
});
test('loadBrowserReceiptProfile rejects missing file, bad JSON, directory, and non-contract content', async () => {
  const dir = await tmpDir();
  try {
    await assert.rejects(import('nnanything/browser-receipt').then(m => m.loadBrowserReceiptProfile('')), /profilePath|non-empty/);
    await assert.rejects(import('nnanything/browser-receipt').then(m => m.loadBrowserReceiptProfile(join(dir, 'missing.json'))), /ENOENT|no such file/);
    await writeFile(join(dir, 'bad.json'), '{not json');
    await assert.rejects(import('nnanything/browser-receipt').then(m => m.loadBrowserReceiptProfile(join(dir, 'bad.json'))), /JSON|parse/);
    await mkdir(join(dir, 'adir'));
    await assert.rejects(import('nnanything/browser-receipt').then(m => m.loadBrowserReceiptProfile(join(dir, 'adir'))), /not a regular file|EISDIR|directory/);
    await writeFile(join(dir, 'wrong.json'), JSON.stringify({ schema: 'nope' }));
    await assert.rejects(import('nnanything/browser-receipt').then(m => m.loadBrowserReceiptProfile(join(dir, 'wrong.json'))), /schema/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('explicit real candidate loads and predicts the three legal projections distinctly', async () => {
  const api = await import('nnanything/browser-receipt');
  const profile = await api.loadBrowserReceiptProfile(join(RECEIPT_RUN, 'candidate.json'));
  assert.equal(profile.state.calibration, 'uncalibrated');
  assert.equal(profile.state.application, 'not_applied');
  const failure = api.predictBrowserReceipt({ receipt: { ok: false, error: null } }, profile);
  const success = api.predictBrowserReceipt({ receipt: { ok: true } }, profile);
  const absent = api.predictBrowserReceipt({ receipt: null }, profile);
  assert.equal(failure.head, 'explicit_failure');
  assert.equal(success.head, 'explicit_success');
  assert.equal(absent.head, 'unknown');
  for (const p of [failure, success, absent]) assert.equal(p.satisfaction, null);
});
