import assert from 'node:assert/strict';
import {test} from 'node:test';
import {searchPhaseFact} from 'nnanything/browser-search';
import {createBrowserQueryRelationProfile, predictBrowserQueryRelation} from 'nnanything/browser-search';

const QUERY_RELATION_WEIGHTS = [
  [-5.0, 0, 2, 2, -6, 0, 0, 0, 0, 0, 0, 2, 0, 0],
  [-9.5, 0, 0, 0, 4, 1, 0, 0, 1, 2, 0, 4, 0, -10],
  [-2.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];

const queryGoal = {
  kind: 'BrowserSearch',
  query: '露营',
  collectionRef: 'main',
  containsText: '装备',
  minimumMatches: 1,
  coverage: 'visible_batch',
  phase: 'submitted',
};

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
    rangeExpansion: {
      actionMechanicalEffect: 'not_attempted',
      atGeometryBoundary: {status: 'unknown', reason: 'not_attempted'},
      requestState: {status: 'unknown', reason: 'no_positive_request_state_source'},
      hasMore: {status: 'unknown', reason: 'no_positive_terminal_control_source'},
      collectionTerminal: false,
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

function rangeFacts(overrides = {}) {
  return {
    actionMechanicalEffect: 'not_attempted',
    atGeometryBoundary: {status: 'unknown', reason: 'not_attempted'},
    requestState: {status: 'unknown', reason: 'no_positive_request_state_source'},
    hasMore: {status: 'unknown', reason: 'no_positive_terminal_control_source'},
    collectionTerminal: false,
    ...overrides,
  };
}

function relationState(value, baselineValue, beforeBaseline, override = {}) {
  const base = observation({
    submittedQuery: observed('露营', 'relation-state:evidence'),
    submittedRequestRef: observed(value, 'relation-state:evidence'),
    resultsRequestRef: observed(value, 'relation-state:evidence'),
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed(value, 'relation-state:evidence'),
      batch: observed('batch-new', 'relation-state:evidence'),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', 'relation-state:evidence')}],
    },
    ...(override.access === undefined ? {} : {access: override.access}),
    ...(override.display === undefined ? {} : {display: override.display}),
  });
  const created = override.requestState === undefined
    ? base
    : {...base, rangeExpansion: {...base.rangeExpansion,
      requestState: {status: 'observed', value: override.requestState, evidenceRefs: ['relation-state:evidence']}}};
  return {
    observation: created,
    checkedObservationId: created.observationId,
    submissionBaseline: {
      submittedRequestRef: beforeBaseline,
      resultsRequestRef: beforeBaseline,
      batchRef: 'batch-old',
      observedSubmission: true,
    },
  };
}

function predictRelation(state) {
  return predictBrowserQueryRelation(state, queryGoal, createBrowserQueryRelationProfile(QUERY_RELATION_WEIGHTS));
}

test('B-S1.2 relation: strict current association needs new instance and new batch', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {
    requestState: 'settled',
  });
  assert.equal(predictRelation(state).head, 'results_associated_active');
});

test('B-S1.2 relation: old response reference cannot be satisfied', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {
    requestState: 'settled',
  });
  const value = {...state.observation, resultsRequestRef: observed('request-other', 'relation-other:evidence'),
    collection: {...state.observation.collection, requestRef: observed('request-other', 'relation-other:evidence')}};
  assert.equal(predictRelation({...state, observation: value}).head, 'submitted_pending_or_stale');
});

test('B-S1.2 relation: old batch cannot be satisfied', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {
    requestState: 'settled',
  });
  const value = {...state.observation, collection: {...state.observation.collection,
    batch: observed('batch-old', 'relation-old-batch:evidence')}};
  assert.equal(predictRelation({...state, observation: value}).head, 'submitted_pending_or_stale');
});

test('B-S1.2 relation: missing reference stays insufficient_or_conflict', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {});
  const value = {...state.observation,
    submittedRequestRef: {status: 'unknown', reason: 'request_instance_not_observable'},
    resultsRequestRef: {status: 'unknown', reason: 'request_instance_not_observable'},
    collection: {...state.observation.collection,
      requestRef: {status: 'unknown', reason: 'request_instance_not_observable'}}};
  assert.equal(predictRelation({...state, observation: value}).head, 'insufficient_or_conflict');
});

test('B-S1.2 relation: empty with login_required is insufficient_or_conflict, never satisfied', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {
    requestState: 'settled',
    access: 'login_required',
    display: 'empty',
  });
  assert.equal(predictRelation(state).head, 'insufficient_or_conflict');
});

test('B-S1.2 relation: unknown request state without loading stays insufficient_or_conflict', () => {
  const state = relationState('request-new', 'request-new', 'request-old', {});
  assert.equal(predictRelation(state).head, 'insufficient_or_conflict');
});

test('range expansion collectionTerminal never requires geometry boundary', () => {
  const observationId = 'observation-nonbottom-term:evidence';
  const value = observation({
    observationId: 'observation-nonbottom-term',
    request: 'settled',
    display: 'current',
    collection: {
      ref: 'main',
      scopeRef: 'results',
      requestRef: observed('request-new', observationId),
      batch: observed('batch-new', observationId),
      items: [{ref: 'item-1', collectionRef: 'main', role: 'main', text: observed('露营装备清单', observationId)}],
    },
    rangeExpansion: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(false, observationId),
      requestState: {status: 'observed', value: 'settled', evidenceRefs: [observationId]},
      hasMore: {status: 'observed', value: false, evidenceRefs: [observationId]},
      collectionTerminal: true,
    },
  });
  assert.equal(value.rangeExpansion.collectionTerminal, true);
  assert.equal(value.rangeExpansion.atGeometryBoundary.value, false);
});
