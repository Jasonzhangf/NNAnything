import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveActual, checkRow } from '../playground/browser/search/b-a1/accept.mjs';
import { B_A1_CASE_ROWS, materializeConfig, materializeExpected } from '../playground/browser/search/b-a1/cases.mjs';

const spec = B_A1_CASE_ROWS.find((row) => row.id === 'B-A1-06');
const config = materializeConfig('B', spec);
const expected = materializeExpected('B', spec);

function syntheticParsed() {
  return {
    response: {
      report: {
        rootEvaluation: { result: 'unknown' },
        control: { outcome: 'error' },
        frames: [
          { depth: 1, goal: { phase: 'input' }, execution: 'completed', fact: 'unsatisfied' },
          { depth: 1, goal: { phase: 'submitted' }, execution: 'not_started' },
          { depth: 1, goal: { phase: 'results' }, execution: 'not_started' },
        ],
        atomicResults: [
          {
            sourceResult: {
              value: {
                action: 'input',
                state: null,
                checkedObservationId: null,
                effectKnowledge: 'unknown',
                executionErrors: [],
                observationFeedback: {
                  status: 'failed',
                  obligation: { freshness: 'after_action' },
                  unmetFacts: ['value', 'editable'],
                  errors: [{ code: 'post_observation_failed', message: 'injected post-action read failure' }],
                },
              },
            },
          },
        ],
      },
    },
    sideEffects: {
      finalObservation: { input: { value: { status: 'observed', value: '露营' } } },
      neighborValue: '保持原值',
      initialObservation: { input: { value: { status: 'observed', value: '' } } },
      mutationReceipts: [{ action: 'input', dispatchState: 'dispatched' }],
    },
    closeErrors: [],
  };
}

test('B-A1-06 original failed episode passes typed acceptance', () => {
  const actual = deriveActual(syntheticParsed(), config);
  assert.equal(actual.failureEpisode.state, null);
  assert.equal(actual.failureEpisode.checkedObservationId, null);
  assert.equal(actual.failureEpisode.effectKnowledge, 'unknown');
  assert.equal(actual.failureEpisode.observationStatus, 'failed');
  assert.deepEqual(actual.failureEpisode.unmetFacts, ['value', 'editable']);
  assert.equal(actual.failureEpisode.freshness, 'after_action');
  const checked = checkRow(actual, expected, config);
  assert.equal(checked.passed, true);
});

test('B-A1-06 injected known state fails acceptance while close value and error list are preserved', () => {
  const parsed = syntheticParsed();
  parsed.response.report.atomicResults[0].sourceResult.value.state = { input: { value: { status: 'observed', value: '露营' } } };
  const actual = deriveActual(parsed, config);
  assert.equal(actual.inputValue, '露营');
  assert.ok(actual.observationErrors.length > 0);
  const checked = checkRow(actual, expected, config);
  assert.equal(checked.passed, false);
  assert.ok(checked.failedChecks.includes('failureEpisode'));
});

test('B-A1-06 injected confirmed effect fails acceptance while close value and error list are preserved', () => {
  const parsed = syntheticParsed();
  parsed.response.report.atomicResults[0].sourceResult.value.effectKnowledge = 'verified';
  const actual = deriveActual(parsed, config);
  assert.equal(actual.inputValue, '露营');
  assert.ok(actual.observationErrors.length > 0);
  const checked = checkRow(actual, expected, config);
  assert.equal(checked.passed, false);
  assert.ok(checked.failedChecks.includes('failureEpisode'));
});
