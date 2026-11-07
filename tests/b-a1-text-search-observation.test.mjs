import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function loadBuilder() {
  const caseDir = await mkdtemp(join(tmpdir(), 'b-a1-observation-'));
  await writeFile(join(caseDir, 'case.json'), '{}\n');
  process.env.BSEARCH_CASE_DIR = caseDir;
  const module = await import(`../playground/browser/search/native-io.mjs?b-a1=${Date.now()}-${Math.random()}`);
  return module.buildObservation;
}

function rawObservation(overrides = {}) {
  return {
    documentRef: 'doc',
    scopeRef: 'scope',
    inputRef: 'query',
    submitRef: 'submit',
    collectionRef: 'main',
    resultScopeRef: 'results',
    inputTag: 'input',
    inputType: 'text',
    inputValue: '',
    editable: true,
    readonly: false,
    submittedQuery: null,
    submittedRequestRef: null,
    resultsQuery: null,
    resultsRequestRef: null,
    collectionRequestRef: null,
    batch: null,
    request: 'unknown',
    display: 'none',
    access: 'available',
    atGeometryBoundary: null,
    geometryReason: 'not_measured',
    hasMore: null,
    items: [],
    ...overrides,
  };
}

test('B-A1 empty input value is an observed empty value, not unknown', async () => {
  const buildObservation = await loadBuilder();
  const observation = buildObservation(rawObservation(), 1);
  assert.equal(observation.input.value.status, 'observed');
  assert.equal(observation.input.value.value, '');
  assert.ok(observation.input.value.evidenceRefs.length > 0);
});

test('B-A1 read-only state is carried as an observed boolean', async () => {
  const buildObservation = await loadBuilder();
  const observation = buildObservation(rawObservation({ readonly: true }), 2);
  assert.equal(observation.input.readonly.status, 'observed');
  assert.equal(observation.input.readonly.value, true);
});
