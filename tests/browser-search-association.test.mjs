import assert from 'node:assert/strict';
import {test} from 'node:test';
import {searchPhaseFact} from 'nnanything/browser-search';

const bindings = {
  documentRef: 'search-doc',
  scopeRef: 'search-scope',
  inputRef: 'query',
  submitRef: 'submit',
  resultScopeRef: 'results',
  collectionRef: 'main',
};

const goal = {
  kind: 'BrowserSearch',
  query: '露营',
  collectionRef: 'main',
  containsText: '装备',
  minimumMatches: 1,
  coverage: 'visible_batch',
  phase: 'root',
};

const observed = (value, id) => ({status: 'observed', value, evidenceRefs: [id]});

function observation(overrides = {}) {
  const observationId = overrides.observationId ?? 'observation-2';
  const id = `${observationId}:evidence`;
  const merged = {
    documentRef: bindings.documentRef,
    scopeRef: bindings.scopeRef,
    observationId,
    revision: 2,
    input: {
      ref: bindings.inputRef,
      tag: 'input',
      type: 'text',
      value: observed('露营', id),
      editable: observed(true, id),
    },
    submitRef: bindings.submitRef,
    submittedQuery: observed('露营', id),
    resultsFor: observed('露营', id),
    submittedRequestRef: observed('request-new', id),
    resultsRequestRef: observed('request-new', id),
    request: 'settled',
    display: 'current',
    access: 'available',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-new', id),
      batch: observed('batch-new', id),
      items: [
        {ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)},
      ],
    },
    evidence: [{id, source: 'association-test', fact: {}}],
    ...overrides,
  };
  return merged;
}

const baseline = {
  submittedRequestRef: 'request-old',
  resultsRequestRef: 'request-old',
  batchRef: 'batch-old',
  observedSubmission: true,
};

test('same-word old results do not satisfy the new submission', () => {
  const value = observation({
    observationId: 'observation-old-results',
    resultsRequestRef: observed('request-old', 'observation-old-results:evidence'),
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-old', 'observation-old-results:evidence'),
      batch: observed('batch-old', 'observation-old-results:evidence'),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', 'observation-old-results:evidence')}],
    },
  });
  assert.notEqual(searchPhaseFact(goal, value, value.observationId, baseline), 'satisfied');
});

test('same-word results satisfy when every response and collection ref is the new submission', () => {
  const value = observation();
  assert.equal(searchPhaseFact(goal, value, value.observationId, baseline), 'satisfied');
});

test('missing submission baseline cannot fall back to equal query text', () => {
  const value = observation();
  assert.equal(searchPhaseFact(goal, value, value.observationId, null), 'unknown');
});

test('unknown submission or response instance is unknown even when query text matches', () => {
  const id = 'observation-unknown-ref:evidence';
  const value = observation({
    observationId: 'observation-unknown-ref',
    submittedRequestRef: {status: 'unknown', reason: 'request_instance_not_observable'},
    resultsRequestRef: {status: 'unknown', reason: 'request_instance_not_observable'},
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: {status: 'unknown', reason: 'request_instance_not_observable'},
      batch: observed('batch-new', id),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)}],
    },
  });
  assert.equal(searchPhaseFact(goal, value, value.observationId, baseline), 'unknown');
});

test('a settled response from another request cannot satisfy current results', () => {
  const id = 'observation-foreign-response:evidence';
  const value = observation({
    observationId: 'observation-foreign-response',
    resultsRequestRef: observed('request-other', id),
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-other', id),
      batch: observed('batch-other', id),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)}],
    },
  });
  assert.equal(searchPhaseFact(goal, value, value.observationId, baseline), 'unsatisfied');
});

test('a reused baseline batch cannot satisfy a new submission', () => {
  const id = 'observation-old-batch:evidence';
  const value = observation({
    observationId: 'observation-old-batch',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-new', id),
      batch: observed('batch-old', id),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)}],
    },
  });
  assert.equal(searchPhaseFact(goal, value, value.observationId, baseline), 'unsatisfied');
});

test('aside or AI members never count toward the main collection threshold', () => {
  const id = 'observation-mixed-ownership:evidence';
  const value = observation({
    observationId: 'observation-mixed-ownership',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-new', id),
      batch: observed('batch-new', id),
      items: [
        {ref: 'main-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)},
        {ref: 'aside-1', collectionRef: 'aside', role: 'auxiliary', text: observed('露营装备推荐', id)},
      ],
    },
  });
  assert.equal(searchPhaseFact({...goal, minimumMatches: 2}, value, value.observationId, baseline), 'unsatisfied');
});

test('auxiliary role does not count even when it points at the main collection ref', () => {
  const id = 'observation-aux-role:evidence';
  const value = observation({
    observationId: 'observation-aux-role',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-new', id),
      batch: observed('batch-new', id),
      items: [
        {ref: 'main-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', id)},
        {ref: 'aside-1', collectionRef: 'main', role: 'auxiliary', text: observed('露营装备推荐', id)},
      ],
    },
  });
  assert.equal(searchPhaseFact({...goal, minimumMatches: 2}, value, value.observationId, baseline), 'unsatisfied');
});
