import {createServer} from 'node:http';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {
  readBrowserInputObservation,
  runBrowserInputEpisode,
} from 'nnanything/browser-input';
import {
  handwiredBrowserSearchDecision,
  readBrowserSearchObservation,
  runBrowserSearchGoal,
  runBrowserSearchEpisode,
} from 'nnanything/browser-search';
import {
  family as f7Family,
  fixtureFor as f7FixtureFor,
} from '../search-fixture/verify-f7-table/data.mjs';
import {renderPage as renderF7Page} from '../search-fixture/verify-f7-table/page.mjs';
import {
  family as f8Family,
  fixtureFor as f8FixtureFor,
} from '../search-fixture/verify-f8-split/data.mjs';
import {renderPage as renderF8Page} from '../search-fixture/verify-f8-split/page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const f7Dir = resolve(here, '../search-fixture/verify-f7-table');
const f8Dir = resolve(here, '../search-fixture/verify-f8-split');
const familyA = resolve(here, '../search-fixture/page.mjs');
const familyB = resolve(here, '../search-fixture/family-b/page.mjs');
const familyCDev = resolve(here, '../search-fixture/family-c-dev/page.mjs');

const FAMILIES = {
  F7: {
    code: 'F7',
    family: f7Family,
    fixtureFor: f7FixtureFor,
    render: renderF7Page,
    path: '/verify-f7-table/',
    clientPath: '/verify-f7-table/client.js',
    clientFile: join(f7Dir, 'client.js'),
    pageFile: join(f7Dir, 'page.mjs'),
    dataFile: join(f7Dir, 'data.mjs'),
    selectors: {
      input: '#query',
      submit: '#submit',
      notes: '#notes',
      submitted: '#submission-state',
      request: '#request-state',
      collection: '#catalog-table',
      mainItems: '#catalog-table tbody tr',
      auxiliaryItems: 'aside li',
      scrollBox: '#result-scroll-box',
      loadMore: '#load-more',
      terminalBanner: '#collection-terminal-banner',
    },
  },
  F8: {
    code: 'F8',
    family: f8Family,
    fixtureFor: f8FixtureFor,
    render: renderF8Page,
    path: '/verify-f8-split/',
    clientPath: '/verify-f8-split/client.js',
    clientFile: join(f8Dir, 'client.js'),
    pageFile: join(f8Dir, 'page.mjs'),
    dataFile: join(f8Dir, 'data.mjs'),
    selectors: {
      input: '#query',
      submit: '#submit',
      notes: '#notes',
      submitted: '#submission-state',
      request: '#request-state',
      collection: '#split-main-list',
      mainItems: '#split-main-list > li',
      auxiliaryItems: '#split-aside li',
      scrollBox: '#result-scroll-box',
      loadMore: '#load-more',
      terminalBanner: '#collection-terminal-banner',
    },
  },
};

function episode(id, scenario, phase, expectedInput, expectedRelation, expectedStep, extra = {}) {
  return {id, scenario, phase, expectedInput, expectedRelation, expectedStep, ...extra};
}

const EPISODES = {
  F7: [
    episode('F7-E01', 'input-normal', 'input', 'INPUT', null, 'input'),
    episode('F7-E02', 'input-equal', 'input', 'NOOP', null, 'NOOP', {preludeInput: true}),
    episode('F7-E03', 'input-placeholder', 'input', 'INPUT', null, 'input'),
    episode('F7-E04', 'input-readonly', 'input', 'DEFER', null, 'DEFER'),
    episode('F7-E05', 'flow-unsubmitted', 'submitted', 'NOOP', 'input_only_unsubmitted', 'submit'),
    episode('F7-E06', 'flow-submitted', 'submitted', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F7-E07', 'flow-old-results', 'submitted', 'NOOP', 'input_only_unsubmitted', 'submit'),
    episode('F7-E08', 'flow-aside-match', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F7-E09', 'flow-empty', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F7-E10', 'flow-blocked', 'results', 'NOOP', 'insufficient_or_conflict', 'DEFER'),
    episode('F7-E11', 'range-expand', 'results', 'NOOP', 'results_associated_active', 'expand_range'),
    episode('F7-E12', 'range-6a-loading', 'results', 'NOOP', 'submitted_pending_or_stale', 'read_or_reobserve'),
    episode('F7-E13', 'range-6a-hasmore', 'results', 'NOOP', 'results_associated_active', 'expand_range'),
    episode('F7-E14', 'range-6a-unknown', 'results', 'NOOP', 'insufficient_or_conflict', 'DEFER'),
    episode('F7-E15', 'range-6b-bottom', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F7-E16', 'range-6b-nonbottom', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
  ],
  F8: [
    episode('F8-E01', 'input-normal', 'input', 'INPUT', null, 'input'),
    episode('F8-E02', 'input-equal', 'input', 'NOOP', null, 'NOOP', {preludeInput: true}),
    episode('F8-E03', 'input-placeholder', 'input', 'INPUT', null, 'input'),
    episode('F8-E04', 'input-disabled', 'input', 'DEFER', null, 'DEFER'),
    episode('F8-E05', 'flow-unsubmitted', 'submitted', 'NOOP', 'input_only_unsubmitted', 'submit'),
    episode('F8-E06', 'flow-submitted', 'submitted', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F8-E07', 'flow-old-results', 'submitted', 'NOOP', 'input_only_unsubmitted', 'submit'),
    episode('F8-E08', 'flow-aside-match', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F8-E09', 'flow-empty', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F8-E10', 'flow-blocked', 'results', 'NOOP', 'insufficient_or_conflict', 'DEFER'),
    episode('F8-E11', 'range-expand', 'results', 'NOOP', 'results_associated_active', 'expand_range'),
    episode('F8-E12', 'range-6a-loading', 'results', 'NOOP', 'submitted_pending_or_stale', 'read_or_reobserve'),
    episode('F8-E13', 'range-6a-hasmore', 'results', 'NOOP', 'results_associated_active', 'expand_range'),
    episode('F8-E14', 'range-6a-unknown', 'results', 'NOOP', 'insufficient_or_conflict', 'DEFER'),
    episode('F8-E15', 'range-6b-bottom', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
    episode('F8-E16', 'range-6b-nonbottom', 'results', 'NOOP', 'results_associated_active', 'NOOP'),
  ],
};

const PROBES = [
  {
    id: 'BP01', family: 'F7', scenario: 'probe-bp01', phase: 'input',
    expectedInput: 'INPUT', expectedStep: 'input', checks: ['placeholder_not_value'],
  },
  {
    id: 'BP02', family: 'F7', scenario: 'probe-bp02', phase: 'input',
    expectedInput: 'INPUT', expectedStep: 'input', checks: ['neighbor_unchanged'],
  },
  {
    id: 'BP03', family: 'F7', scenario: 'probe-bp03', phase: 'input',
    expectedInput: 'INPUT', expectedStep: 'input', checks: ['input_reset_zero_submit'],
  },
  {
    id: 'BP04', family: 'F7', phase: 'input', checks: [],
    variants: [
      {scenario: 'probe-bp04a', expectedInput: 'NOOP', expectedStep: 'NOOP', checks: ['idempotent_noop']},
      {scenario: 'probe-bp04b', expectedInput: 'DEFER', expectedStep: 'DEFER', checks: ['blocked_defer']},
    ],
  },
  {
    id: 'BP05', family: 'F7', scenario: 'probe-bp05', phase: 'submitted',
    expectedInput: 'NOOP', expectedRelation: 'input_only_unsubmitted', expectedStep: 'submit',
    checks: ['old_results_not_current'],
  },
  {
    id: 'BP06', family: 'F7', scenario: 'probe-bp06', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'submitted_pending_or_stale', expectedStep: 'read_or_reobserve',
    checks: ['late_response_not_associated'],
  },
  {
    id: 'BP07', family: 'F7', scenario: 'probe-bp07', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'results_associated_active', expectedStep: 'NOOP',
    checks: ['aside_not_counted'],
  },
  {
    id: 'BP08', family: 'F7', scenario: 'probe-bp08', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'insufficient_or_conflict', expectedStep: 'DEFER',
    checks: ['login_conflict_not_not_found'],
  },
  {
    id: 'BP09', family: 'F7', scenario: 'probe-bp09', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'submitted_pending_or_stale', expectedStep: 'read_or_reobserve',
    checks: ['geometry_not_terminal'],
  },
  {
    id: 'BP10', family: 'F7', scenario: 'probe-bp10', phase: 'results',
    // The native page still exposes a settled request state, so the relation
    // may legitimately be associated while hasMore stays unknown. The probe
    // asserts the terminal/step boundary, not a fabricated relation head.
    expectedInput: 'NOOP', expectedStep: 'DEFER',
    checks: ['unknown_terminal_preserved'],
  },
  {
    id: 'BP11', family: 'F7', scenario: 'probe-bp11', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'results_associated_active', expectedStep: 'NOOP',
    checks: ['bottom_terminal_stopped'],
  },
  {
    id: 'BP11b', family: 'F7', scenario: 'probe-bp11b', phase: 'results',
    expectedInput: 'NOOP', expectedRelation: 'results_associated_active', expectedStep: 'NOOP',
    checks: ['nonbottom_terminal_stopped'],
  },
  {
    id: 'BP12', family: 'F7', scenario: 'probe-bp12', phase: 'input',
    expectedInput: 'INPUT', expectedStep: 'input',
    checks: ['execution_error_preserved', 'safe_post_observation', 'recursive_submission_path_exercised'],
  },
];

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function compare(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}

function familyFor(code) {
  const entry = FAMILIES[code];
  if (!entry) throw new TypeError(`Unknown verification family: ${code}`);
  return entry;
}

function goalFor(entry, phase) {
  return {
    kind: 'BrowserSearch',
    query: entry.family.query,
    collectionRef: entry.family.collectionRef,
    containsText: entry.family.containsText,
    minimumMatches: 1,
    coverage: 'visible_batch',
    phase,
  };
}

function bindingsFor(family) {
  return {
    documentRef: family.documentRef,
    scopeRef: family.scopeRef,
    inputRef: family.inputRef,
    submitRef: family.submitRef,
    resultScopeRef: family.resultScopeRef,
    collectionRef: family.collectionRef,
  };
}

// Build both public observation shapes from one explicit fact pack. Observed
// facts carry a local evidence id that resolves inside this same evidence
// table; both shapes are then checked by the real product readers.
function buildObservation(fx, family, phase, revision = 1) {
  const observationId = `${family.id}:${phase}:${revision}`;
  const evidence = [];
  const observed = (key, value, detail = {}) => {
    const id = `${observationId}:${key}`;
    evidence.push({id, source: 'verify-independent-fixture.observation', fact: {key, value, ...detail}});
    return {status: 'observed', value, evidenceRefs: [id]};
  };
  const unknown = (reason) => ({status: 'unknown', reason});
  const declared = (fact, key, fallbackReason, detail = {}) => {
    if (!fact || fact.status === 'unknown') return unknown(fact?.reason ?? fallbackReason);
    return observed(key, fact.value, detail);
  };

  const disabled = Boolean(fx.input.disabled);
  const readonly = Boolean(fx.input.readonly);
  const editable = !disabled && !readonly;
  const target = {
    ref: family.inputRef,
    connected: observed('target.connected', true),
    currentRef: observed('target.currentRef', family.inputRef),
    host: observed('target.host', 'input'),
    contentEditable: observed('target.contentEditable', false),
    type: observed('target.type', fx.input.type ?? 'text'),
    value: fx.input.valueUnknown ? unknown('value_not_observed') : observed('target.value', fx.input.value),
    placeholder: observed('target.placeholder', fx.input.placeholder ?? null),
    nativeDisabled: observed('target.nativeDisabled', disabled),
    ariaDisabled: observed('target.ariaDisabled', null),
    nativeReadonly: observed('target.nativeReadonly', readonly),
    ariaReadonly: observed('target.ariaReadonly', null),
    readonlyState: observed('target.readonlyState', readonly ? 'readonly' : 'editable'),
    editable: fx.input.editableUnprobed ? unknown('editable_not_probed') : observed('target.editable', editable),
    activeElementRef: observed('target.activeElementRef', null),
    activeElementFocus: observed('target.activeElementFocus', false),
    executableHit: observed('target.executableHit', !fx.input.occluded),
    point: observed('target.point', {x: 1, y: 1}),
  };
  const neighbors = [
    {ref: `${family.inputRef}-neighbor`, value: observed('neighbors.notes.value', '保持原值')},
  ];
  const inputValue = fx.input.valueUnknown
    ? unknown('value_not_observed')
    : observed('input.value', fx.input.value);
  const inputEditable = fx.input.editableUnprobed
    ? unknown('editable_not_probed')
    : observed('input.editable', editable);
  const inputFacts = {
    ref: family.inputRef,
    tag: 'input',
    type: fx.input.type ?? 'text',
    value: inputValue,
    editable: inputEditable,
  };
  const submittedQuery = fx.submitted.query
    ? observed('submittedQuery', fx.submitted.query) : unknown('submitted_query_not_observed');
  const submittedRequestRef = fx.submitted.requestRef
    ? observed('submittedRequestRef', fx.submitted.requestRef) : unknown('submitted_request_not_observed');
  const resultsFor = fx.request.resultsFor
    ? observed('resultsFor', fx.request.resultsFor) : unknown('results_query_not_observed');
  const resultsRequestRef = fx.request.resultsRef
    ? observed('resultsRequestRef', fx.request.resultsRef) : unknown('results_request_not_observed');
  const collectionRequestRef = fx.request.resultsRef
    ? observed('collection.requestRef', fx.request.resultsRef) : unknown('results_request_not_observed');
  const batch = fx.request.batchRef
    ? observed('collection.batch', fx.request.batchRef) : unknown('batch_not_observed');
  const mainItems = fx.items.main ?? [];
  const asideItems = fx.items.aside ?? fx.items.auxiliary ?? [];
  const items = [
    ...mainItems.map((text, index) => ({
      ref: `${family.collectionRef}-main-${index}`,
      collectionRef: family.collectionRef,
      role: 'main',
      text: observed(`collection.items.${index}.text`, text, {role: 'main', index}),
    })),
    ...asideItems.map((text, index) => ({
      ref: `${family.collectionRef}-aside-${index}`,
      collectionRef: family.collectionRef,
      role: 'auxiliary',
      text: observed(`collection.items.aside.${index}.text`, text, {role: 'auxiliary', index}),
    })),
  ];
  const geometry = declared(fx.request.range.atGeometryBoundary, 'rangeExpansion.atGeometryBoundary',
    'geometry_not_measured');
  const requestState = declared(fx.request.range.requestState, 'rangeExpansion.requestState',
    'no_positive_request_state_source');
  const hasMore = declared(fx.request.range.hasMore, 'rangeExpansion.hasMore',
    'no_positive_terminal_control_source');
  const identity = {
    documentRef: family.documentRef,
    scopeRef: family.scopeRef,
    observationId,
    revision,
  };
  const inputObservation = readBrowserInputObservation({
    ...identity,
    target,
    neighbors,
    evidence,
  });
  const searchObservation = readBrowserSearchObservation({
    ...identity,
    target,
    input: inputFacts,
    submitRef: family.submitRef,
    submittedQuery,
    resultsFor,
    submittedRequestRef,
    resultsRequestRef,
    request: fx.request.status,
    display: fx.request.display,
    access: fx.request.access,
    collection: {
      ref: family.collectionRef,
      scopeRef: family.resultScopeRef,
      requestRef: collectionRequestRef,
      items,
      batch,
    },
    rangeExpansion: {
      actionMechanicalEffect: fx.request.range.actionMechanicalEffect,
      atGeometryBoundary: geometry,
      requestState,
      hasMore,
    },
    evidence,
  });
  return {input: inputObservation, search: searchObservation, evidence};
}

function submissionBaselineFor(fx, family) {
  const hasSubmission = Boolean(fx.submitted.requestRef);
  const sameQuerySubmission = hasSubmission && fx.submitted.query === family.query;
  return {
    submittedRequestRef: hasSubmission
      ? (sameQuerySubmission ? 'fixture-baseline' : fx.submitted.requestRef) : null,
    resultsRequestRef: fx.request.resultsRef || null,
    batchRef: fx.request.batchRef
      ? (sameQuerySubmission ? 'fixture-baseline-batch' : fx.request.batchRef) : null,
    observedSubmission: hasSubmission,
  };
}

function buildState(fx, family, phase, revision = 1) {
  const observation = buildObservation(fx, family, phase, revision);
  return {
    observation: observation.search,
    inputObservation: observation.input,
    checkedObservationId: phase === 'results' ? observation.search.observationId : null,
    submissionBaseline: submissionBaselineFor(fx, family),
  };
}

// Hand-written deterministic gold for the fixture self-check. This never reads
// a candidate profile or weight file.
function predictInputPolicy(observation, targetText, sensitive = false) {
  const t = observation.target;
  const known = (fact) => fact?.status === 'observed';
  const textTypeKnown = known(t.host) && known(t.type);
  const textTypeValue = textTypeKnown && t.host.value === 'input' && t.type.value === 'text' && !sensitive;
  const enabledKnown = known(t.nativeDisabled) && known(t.ariaDisabled);
  const enabledValue = enabledKnown && t.nativeDisabled.value === false && t.ariaDisabled.value !== true;
  const editableKnown = known(t.editable);
  const editableValue = editableKnown && t.editable.value === true;
  const readonlyKnown = known(t.readonlyState);
  const readonlyValue = readonlyKnown && t.readonlyState.value === 'readonly';
  const valueKnown = known(t.value) && !sensitive;
  const valueEqual = valueKnown && t.value.value === targetText;
  const hitKnown = known(t.executableHit);
  const hitValue = hitKnown && t.executableHit.value === true;
  const wires = [
    1,
    textTypeKnown ? 1 : 0,
    textTypeValue ? 1 : 0,
    enabledKnown ? 1 : 0,
    enabledValue ? 1 : 0,
    editableKnown ? 1 : 0,
    editableValue ? 1 : 0,
    readonlyKnown ? 1 : 0,
    readonlyValue ? 1 : 0,
    valueKnown ? 1 : 0,
    valueEqual ? 1 : 0,
    hitKnown ? 1 : 0,
    hitValue ? 1 : 0,
  ];
  if (valueKnown && valueEqual) return {head: 'NOOP', wires};
  const canInput = valueKnown && !valueEqual && textTypeKnown && textTypeValue && enabledKnown && enabledValue
    && editableKnown && editableValue && readonlyKnown && !readonlyValue && hitKnown && hitValue;
  return {head: canInput ? 'INPUT' : 'DEFER', wires};
}

function predictQueryRelation(state, goal) {
  const o = state.observation;
  const baseline = state.submissionBaseline;
  const known = (fact) => fact?.status === 'observed';
  const eq = (fact, value) => known(fact) && fact.value === value;
  const w1 = known(o.input.value) ? 1 : 0;
  const w2 = w1 && eq(o.input.value, goal.query) ? 1 : 0;
  const w3 = baseline !== null && known(o.submittedQuery) && known(o.submittedRequestRef) ? 1 : 0;
  const w4 = w3 && eq(o.submittedQuery, goal.query) && known(o.submittedRequestRef)
    && o.submittedRequestRef.value !== baseline.submittedRequestRef ? 1 : 0;
  const w5 = w3 && known(o.resultsFor) && known(o.resultsRequestRef)
    && known(o.collection.requestRef) && known(o.collection.batch) ? 1 : 0;
  const w6 = w5 && w4 && eq(o.resultsFor, goal.query)
    && known(o.resultsRequestRef) && known(o.collection.requestRef)
    && o.resultsRequestRef.value === o.submittedRequestRef.value
    && o.collection.requestRef.value === o.submittedRequestRef.value
    && known(o.collection.batch) && o.collection.batch.value !== baseline.batchRef ? 1 : 0;
  const w7 = known(o.rangeExpansion.requestState) ? 1 : 0;
  const w8 = w7 && o.rangeExpansion.requestState.value === 'settled' ? 1 : 0;
  const w9 = w7 && o.rangeExpansion.requestState.value === 'loading' ? 1 : 0;
  const w10 = o.access !== 'unknown' ? 1 : 0;
  const w11 = w10 && o.access === 'available' ? 1 : 0;
  const w12 = w5 && o.display !== 'unknown' && (o.display === 'current' || o.display === 'empty') ? 1 : 0;
  const w13 = w4 && w6 && w8 && w11 && w12 ? 1 : 0;
  let head = 'insufficient_or_conflict';
  if (w13 === 1) head = 'results_associated_active';
  else if (w4 === 1 && w11 === 1 && ((w7 === 1 && w9 === 1) || (w7 === 1 && w8 === 1 && w5 === 1))) {
    head = 'submitted_pending_or_stale';
  } else if (w3 === 1 && w4 === 0 && w1 === 1 && w2 === 1 && w10 === 1 && w11 === 1) {
    head = 'input_only_unsubmitted';
  }
  return {head, wires: [1, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13]};
}

function goldContentFact(goal, observation) {
  const relevant = observation.collection.items.filter((item) => item.collectionRef === goal.collectionRef);
  const main = relevant.filter((item) => item.role === 'main');
  const unknownRole = relevant.some((item) => item.role === 'unknown');
  if (goal.coverage === 'visible_batch' && (unknownRole || main.some((item) => item.text.status !== 'observed'))) {
    return 'unknown';
  }
  const matches = main.filter((item) => item.text.status === 'observed' && item.text.value.includes(goal.containsText));
  if (matches.length >= goal.minimumMatches) return 'satisfied';
  return unknownRole || main.some((item) => item.text.status === 'unknown') ? 'unknown' : 'unsatisfied';
}

function predictStepPolicy(state, goal, inputHead, relationHead) {
  const o = state.observation;
  const phaseInput = goal.phase === 'input';
  const phaseSubmitted = goal.phase === 'submitted';
  const phaseResults = goal.phase === 'results';
  const w1 = phaseInput ? 1 : 0;
  const w2 = phaseSubmitted ? 1 : 0;
  const w3 = phaseResults ? 1 : 0;
  const w4 = w1 && inputHead === 'INPUT' ? 1 : 0;
  const w5 = w1 && inputHead === 'NOOP' ? 1 : 0;
  const w6 = w1 && inputHead === 'DEFER' ? 1 : 0;
  const relationScope = w2 || w3 ? 1 : 0;
  const w7 = relationScope && relationHead === 'input_only_unsubmitted' ? 1 : 0;
  const w8 = relationScope && relationHead === 'submitted_pending_or_stale' ? 1 : 0;
  const w9 = relationScope && relationHead === 'results_associated_active' ? 1 : 0;
  const w10 = relationScope && relationHead === 'insufficient_or_conflict' ? 1 : 0;
  const checkedCurrent = phaseResults && o.observationId === state.checkedObservationId;
  const contentFact = goldContentFact(goal, o);
  const contentKnown = contentFact !== 'unknown';
  const w11 = phaseResults && w9 === 1 && checkedCurrent ? 1 : 0;
  const w12 = w11 && contentKnown ? 1 : 0;
  const w13 = w12 && contentFact === 'satisfied' ? 1 : 0;
  const geometry = o.rangeExpansion.atGeometryBoundary;
  const hasMore = o.rangeExpansion.hasMore;
  const terminal = o.rangeExpansion.collectionTerminal === true;
  const canExpandKnown = w12 === 1 && (
    (geometry.status === 'observed' && geometry.value === false)
    || (hasMore.status === 'observed' && hasMore.value === true)
    || (geometry.status === 'observed' && geometry.value === true
      && hasMore.status === 'observed' && hasMore.value === false)
  );
  const w14 = canExpandKnown ? 1 : 0;
  const w15 = w14 === 1 && w13 === 0 && terminal === false
    && ((geometry.status === 'observed' && geometry.value === false)
      || (hasMore.status === 'observed' && hasMore.value === true)) ? 1 : 0;
  const w16 = w12 === 1 && terminal ? 1 : 0;
  const w17 = phaseResults && w9 === 1 && checkedCurrent === false ? 1 : 0;
  let head;
  if (phaseInput) {
    head = inputHead === 'INPUT' ? 'input' : inputHead === 'NOOP' ? 'NOOP' : 'DEFER';
  } else if (phaseSubmitted) {
    if (w7) head = 'submit';
    else if (w8 || w9) head = 'NOOP';
    else head = 'DEFER';
  } else {
    if (w8 || w17) head = 'read_or_reobserve';
    else if (w9 && w11 && w12 && w13) head = 'NOOP';
    else if (w9 && w11 && w12 && w13 === 0 && w16) head = 'NOOP';
    else if (w9 && w11 && w12 && w13 === 0 && w16 === 0 && w14 && w15) head = 'expand_range';
    else head = 'DEFER';
  }
  return {head, wires: [1, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15, w16, w17]};
}

function evaluateState(entry, state, phase) {
  const goal = goalFor(entry, phase);
  const input = predictInputPolicy(state.inputObservation, entry.family.query);
  const relation = phase === 'input' ? null : predictQueryRelation(state, goal);
  const step = predictStepPolicy(state, goal, input.head, relation?.head ?? null);
  return {state, input, relation, step, phase, goal};
}

function evaluateSyntheticRow(entry, row, phase = row.phase) {
  const fixture = entry.fixtureFor(row.scenario);
  if (row.preludeInput) fixture.input.value = entry.family.query;
  const state = buildState(fixture, entry.family, phase);
  return {...evaluateState(entry, state, phase), fixture};
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function runInputConsumerCase(entry, fixture, {failAfterAction = false} = {}) {
  const pack = clone(fixture);
  let revision = 0;
  let control = null;
  let nativeWrites = 0;
  let submitCount = 0;
  const observe = async (obligation) => {
    if (failAfterAction && obligation.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const observation = buildObservation(pack, entry.family, 'input', revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: observation.input.observationId,
      revision,
    };
    return observation.input;
  };
  const request = {
    requestId: `bp12-input-${failAfterAction ? 'observation-failure' : 'transport-error'}`,
    goal: {kind: 'BrowserInput', targetText: entry.family.query},
    satisfactionThreshold: 100,
    bindings: {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      targetRef: entry.family.inputRef,
    },
  };
  const episode = await runBrowserInputEpisode(request, {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText']),
    observe,
    currentControl: () => control,
    nativeInputText: async (invocation) => {
      nativeWrites += 1;
      pack.input.value = invocation.value;
      throw new Error('injected native transport error after dispatch');
    },
  });
  return {episode, pack, nativeWrites, submitCount};
}

async function runSearchConsumerCase(entry, fixture, {failAfterAction = false} = {}) {
  const pack = clone(fixture);
  let revision = 0;
  let control = null;
  let nativeWrites = 0;
  let submitCount = 0;
  const observe = async (obligation) => {
    if (failAfterAction && obligation.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const observation = buildObservation(pack, entry.family, 'input', revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: observation.search.observationId,
      revision,
    };
    return observation.search;
  };
  const episode = await runBrowserSearchEpisode({
    goal: goalFor(entry, 'input'),
    bindings: bindingsFor(entry.family),
    maxResultReads: 1,
    submissionBaseline: null,
    checkedObservationId: null,
  }, {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
    decision: handwiredBrowserSearchDecision,
    observe,
    readResults: observe,
    currentControl: () => control,
    nativeInputText: async (invocation) => {
      nativeWrites += 1;
      pack.input.value = invocation.value;
      throw new Error('injected native transport error after dispatch');
    },
    nativeSubmit: async () => {
      submitCount += 1;
      throw new Error('BP12 search must not submit after an input transport error');
    },
    collect: async () => {},
  });
  return {episode, pack, nativeWrites, submitCount};
}

async function runSearchSubmissionConsumerCase(entry, fixture) {
  const pack = clone(fixture);
  let revision = 0;
  let control = null;
  let nativeWrites = 0;
  let submitCount = 0;
  const episodes = [];
  const observe = async () => {
    revision += 1;
    const observation = buildObservation(pack, entry.family, 'input', revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: observation.search.observationId,
      revision,
    };
    return observation.search;
  };
  const response = await runBrowserSearchGoal({
    requestId: 'bp12-search-recursive-submission',
    goal: goalFor(entry, 'root'),
    satisfactionThreshold: 100,
    bindings: bindingsFor(entry.family),
    maxResultReads: 1,
  }, {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
    decision: handwiredBrowserSearchDecision,
    observe,
    readResults: observe,
    currentControl: () => control,
    nativeInputText: async (invocation) => {
      nativeWrites += 1;
      pack.input.value = invocation.value;
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'unknown',
        source: 'verify-independent-fixture.consumer-input',
        error: null,
      };
    },
    nativeSubmit: async () => {
      submitCount += 1;
      pack.submitted = {query: pack.input.value, requestRef: 'bp12-recursive-request'};
      pack.request = {
        ...pack.request,
        status: 'settled',
        display: 'current',
        access: 'available',
        resultsFor: pack.input.value,
        resultsRef: 'bp12-recursive-request',
        batchRef: 'bp12-recursive-request:batch-1',
        range: {
          actionMechanicalEffect: 'no_change',
          atGeometryBoundary: {status: 'observed', value: true},
          requestState: {status: 'observed', value: 'settled'},
          hasMore: {status: 'observed', value: false},
        },
      };
      pack.items = {main: ['珊瑚礁记录：包含珊瑚。'], auxiliary: []};
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'unknown',
        source: 'verify-independent-fixture.consumer-submit',
        error: null,
      };
    },
    collect: async (episode) => {
      episodes.push(episode);
    },
  });
  return {
    kind: response.kind ?? null,
    rootResult: response.report?.rootEvaluation?.result ?? null,
    nativeWrites,
    submitCount,
    actions: episodes.map((episode) => episode.action),
    episodes,
  };
}

function summarizeConsumerCase(consumerCase) {
  return {
    episode: consumerCase.episode,
    nativeWrites: consumerCase.nativeWrites ?? 0,
    submitCount: consumerCase.submitCount ?? 0,
    dispatchedValue: consumerCase.pack?.input?.value ?? null,
  };
}

async function runBp12ConsumerProbes(entry) {
  const fixture = entry.fixtureFor('probe-bp12');
  const input = await runInputConsumerCase(entry, fixture);
  const search = await runSearchConsumerCase(entry, fixture);
  const inputObservationFailure = await runInputConsumerCase(entry, fixture, {failAfterAction: true});
  const searchObservationFailure = await runSearchConsumerCase(entry, fixture, {failAfterAction: true});
  const submission = await runSearchSubmissionConsumerCase(entry, fixture);
  return {
    input: summarizeConsumerCase(input),
    search: summarizeConsumerCase(search),
    inputObservationFailure: summarizeConsumerCase(inputObservationFailure),
    searchObservationFailure: summarizeConsumerCase(searchObservationFailure),
    submission,
  };
}

function checkFact(fact, label) {
  assert(fact && fact.status === 'observed', `${label} must be observed, got ${fact?.status ?? 'missing'}`);
  return fact.value;
}

function relationHead(context) {
  return context.result.relation?.head ?? null;
}

function contentSatisfaction(context) {
  const observation = context.observation;
  if (observation.access !== 'available' || observation.request !== 'settled'
    || !['current', 'empty'].includes(observation.display)
    || observation.rangeExpansion.collectionTerminal !== true
    || context.result.relation?.head === 'insufficient_or_conflict') {
    return null;
  }
  const fact = goldContentFact(context.result.goal, context.observation);
  return fact === 'satisfied' ? 100 : fact === 'unsatisfied' ? 0 : null;
}

function expandRangeCount(context) {
  return context.sideEffects?.expandRangeCount ?? 0;
}

function textWriteCount(context) {
  return context.sideEffects?.textWriteCount ?? 0;
}

// The single source of probe assertions. Both validateIndependentFixture and
// runNativeSmoke execute every listed check through this table.
const VERIFY_PROBE_CHECKS = {
  placeholder_not_value(_episode, context) {
    const placeholder = checkFact(context.inputObservation.target.placeholder, 'placeholder');
    const value = checkFact(context.inputObservation.target.value, 'value');
    compare(placeholder, context.family.family.query, 'BP01 placeholder');
    compare(value, '', 'BP01 value');
    compare(context.result.input.head, 'INPUT', 'BP01 B-S1.1');
    compare(context.result.step.head, 'input', 'BP01 B-S1.3');
  },
  neighbor_unchanged(_episode, context) {
    compare(checkFact(context.inputObservation.target.value, 'BP02 target'),
      context.family.family.query, 'BP02 target value');
    const neighbor = context.inputObservation.neighbors[0];
    assert(neighbor, 'BP02 neighbor must exist');
    compare(checkFact(neighbor.value, 'BP02 neighbor'), '保持原值', 'BP02 neighbor');
  },
  input_reset_zero_submit(_episode, context) {
    compare(checkFact(context.inputObservation.target.value, 'BP03 value'), '', 'BP03 reset value');
    compare(context.observation.submittedRequestRef.status, 'unknown', 'BP03 submitted ref');
    compare(context.sideEffects?.submitCount ?? 0, 0, 'BP03 submit count');
  },
  idempotent_noop(_episode, context) {
    compare(checkFact(context.inputObservation.target.value, 'BP04a value'), context.family.family.query, 'BP04a value');
    compare(checkFact(context.inputObservation.target.executableHit, 'BP04a hit'), false, 'BP04a hit');
    compare(context.result.input.head, 'NOOP', 'BP04a B-S1.1');
    compare(context.result.step.head, 'NOOP', 'BP04a B-S1.3');
    compare(textWriteCount(context), 0, 'BP04a text writes');
  },
  blocked_defer(_episode, context) {
    assert(checkFact(context.inputObservation.target.value, 'BP04b value') !== context.family.family.query,
      'BP04b value must differ from query');
    compare(checkFact(context.inputObservation.target.executableHit, 'BP04b hit'), false, 'BP04b hit');
    compare(context.result.input.head, 'DEFER', 'BP04b B-S1.1');
    compare(context.result.step.head, 'DEFER', 'BP04b B-S1.3');
    compare(textWriteCount(context), 0, 'BP04b text writes');
  },
  old_results_not_current(_episode, context) {
    compare(checkFact(context.observation.input.value, 'BP05 input'), context.family.family.query, 'BP05 input value');
    const baseline = context.result.state.submissionBaseline;
    compare(checkFact(context.observation.submittedRequestRef, 'BP05 submitted ref'),
      baseline.submittedRequestRef, 'BP05 baseline ref');
    compare(relationHead(context), 'input_only_unsubmitted', 'BP05 B-S1.2');
    compare(context.result.step.head, 'submit', 'BP05 B-S1.3');
  },
  late_response_not_associated(_episode, context) {
    const submitted = checkFact(context.observation.submittedQuery, 'BP06 submitted query');
    const results = checkFact(context.observation.resultsFor, 'BP06 results query');
    compare(submitted, context.family.family.query, 'BP06 submitted query');
    assert(results !== submitted, 'BP06 results must not be associated with the submitted query');
    const submittedRef = checkFact(context.observation.submittedRequestRef, 'BP06 submitted ref');
    const resultsRef = checkFact(context.observation.resultsRequestRef, 'BP06 results ref');
    const collectionRef = checkFact(context.observation.collection.requestRef, 'BP06 collection ref');
    checkFact(context.observation.collection.batch, 'BP06 batch');
    assert(resultsRef !== submittedRef, 'BP06 results ref must differ from submitted ref');
    compare(collectionRef, resultsRef, 'BP06 collection ref');
    assert(['loading', 'settled'].includes(checkFact(context.observation.rangeExpansion.requestState,
      'BP06 request state')), 'BP06 request state must have a positive source');
    compare(relationHead(context), 'submitted_pending_or_stale', 'BP06 B-S1.2');
    compare(context.result.step.head, 'read_or_reobserve', 'BP06 B-S1.3');
  },
  aside_not_counted(_episode, context) {
    const content = goldContentFact(context.result.goal, context.observation);
    compare(content, 'unsatisfied', 'BP07 collection content');
    compare(context.observation.rangeExpansion.collectionTerminal, true, 'BP07 terminal');
    compare(context.result.step.head, 'NOOP', 'BP07 B-S1.3');
    compare(contentSatisfaction(context), 0, 'BP07 root satisfaction');
  },
  login_conflict_not_not_found(_episode, context) {
    compare(context.observation.access, 'login_required', 'BP08 access');
    compare(context.observation.display, 'empty', 'BP08 display');
    compare(relationHead(context), 'insufficient_or_conflict', 'BP08 B-S1.2');
    compare(context.result.step.head, 'DEFER', 'BP08 B-S1.3');
    compare(contentSatisfaction(context), null, 'BP08 satisfaction');
  },
  geometry_not_terminal(_episode, context) {
    compare(checkFact(context.observation.rangeExpansion.atGeometryBoundary, 'BP09 geometry'), true, 'BP09 geometry');
    compare(checkFact(context.observation.rangeExpansion.requestState, 'BP09 request state'), 'loading', 'BP09 state');
    compare(context.observation.rangeExpansion.collectionTerminal, false, 'BP09 terminal');
    compare(relationHead(context), 'submitted_pending_or_stale', 'BP09 B-S1.2');
    compare(context.result.step.head, 'read_or_reobserve', 'BP09 B-S1.3');
  },
  unknown_terminal_preserved(_episode, context) {
    compare(checkFact(context.observation.rangeExpansion.atGeometryBoundary, 'BP10 geometry'), true, 'BP10 geometry');
    compare(context.observation.rangeExpansion.hasMore.status, 'unknown', 'BP10 hasMore');
    compare(context.observation.rangeExpansion.collectionTerminal, false, 'BP10 terminal');
    compare(context.result.step.wires[14], 0, 'BP10 canExpandRange known');
    compare(context.result.step.head, 'DEFER', 'BP10 B-S1.3');
  },
  bottom_terminal_stopped(_episode, context) {
    compare(checkFact(context.observation.rangeExpansion.atGeometryBoundary, 'BP11 geometry'), true, 'BP11 geometry');
    compare(checkFact(context.observation.rangeExpansion.requestState, 'BP11 request state'), 'settled', 'BP11 state');
    compare(checkFact(context.observation.rangeExpansion.hasMore, 'BP11 hasMore'), false, 'BP11 hasMore');
    compare(context.observation.rangeExpansion.collectionTerminal, true, 'BP11 terminal');
    compare(context.result.step.head, 'NOOP', 'BP11 B-S1.3');
  },
  nonbottom_terminal_stopped(_episode, context) {
    compare(checkFact(context.observation.rangeExpansion.atGeometryBoundary, 'BP11b geometry'), false, 'BP11b geometry');
    compare(checkFact(context.observation.rangeExpansion.requestState, 'BP11b request state'), 'settled', 'BP11b state');
    compare(checkFact(context.observation.rangeExpansion.hasMore, 'BP11b hasMore'), false, 'BP11b hasMore');
    compare(context.observation.rangeExpansion.collectionTerminal, true, 'BP11b terminal');
    compare(context.result.step.head, 'NOOP', 'BP11b B-S1.3');
    compare(expandRangeCount(context), 0, 'BP11b expand_range actions');
  },
  execution_error_preserved(_episode, context) {
    const cases = [
      ['input', context.bp12.input],
      ['search', context.bp12.search],
    ];
    for (const [label, probe] of cases) {
      assert(probe.episode.executionErrors.length === 1,
        `BP12 ${label} executionErrors: ${JSON.stringify(probe.episode.executionErrors)}`);
      assert(probe.episode.executionErrors[0].message.includes('injected native transport error after dispatch'),
        `BP12 ${label} original error was not preserved`);
      compare(probe.nativeWrites, 1, `BP12 ${label} native dispatch count`);
      compare(probe.dispatchedValue, context.family.family.query, `BP12 ${label} dispatched value`);
    }
  },
  safe_post_observation(_episode, context) {
    const input = context.bp12.input;
    assert(input.episode.state !== null, 'BP12 input safe post observation state is null');
    compare(checkFact(input.episode.state.observation.target.value, 'BP12 input target value'),
      context.family.family.query, 'BP12 input target value');
    compare(input.episode.observationFeedback.status, 'satisfied', 'BP12 input observation feedback');
    compare(input.submitCount, 0, 'BP12 input safe post observation later submits');
    const search = context.bp12.search;
    assert(search.episode.state !== null, 'BP12 search safe post observation state is null');
    compare(checkFact(search.episode.state.observation.input.value, 'BP12 search input value'),
      context.family.family.query, 'BP12 search input value');
    compare(search.episode.observationFeedback.status, 'satisfied', 'BP12 search observation feedback');
    compare(search.submitCount, 0, 'BP12 search safe post observation later submits');
    for (const [label, probe] of [
      ['input', context.bp12.inputObservationFailure],
      ['search', context.bp12.searchObservationFailure],
    ]) {
      compare(probe.episode.state, null, `BP12 ${label} observation-failure state`);
      compare(probe.episode.observationFeedback.status, 'failed', `BP12 ${label} observation-failure feedback`);
      compare(probe.submitCount, 0, `BP12 ${label} observation-failure submits`);
    }
  },
  recursive_submission_path_exercised(_episode, context) {
    const submission = context.bp12.submission;
    assert(submission, 'BP12 recursive submission probe is missing');
    compare(submission.submitCount, 1, 'BP12 recursive submission dispatches exactly once');
    assert(submission.actions.includes('input'), 'BP12 recursive submission did not run input stage');
    assert(submission.actions.includes('submit'), 'BP12 recursive submission did not reach submit stage');
    assert(submission.episodes.some((episode) => episode.action === 'submit'
      && episode.observationFeedback.status === 'satisfied'),
    'BP12 recursive submission did not observe a satisfied submit stage');
  },
};

function probeContext(entry, probe, variant) {
  const hint = EPISODES[probe.family].find((row) => row.scenario === variant.scenario)
    ?? {id: probe.id, scenario: variant.scenario, phase: probe.phase};
  const synthetic = evaluateSyntheticRow(entry, {...hint, ...probe, ...variant, phase: probe.phase});
  let inputObservation = synthetic.state.inputObservation;
  if (probe.id === 'BP02') {
    const postAction = structuredClone(entry.fixtureFor(variant.scenario));
    postAction.input.value = entry.family.query;
    inputObservation = buildState(postAction, entry.family, probe.phase).inputObservation;
  }
  return {
    probe,
    variant,
    family: entry,
    result: synthetic,
    observation: synthetic.state.observation,
    inputObservation,
    sideEffects: {textWriteCount: 0, submitCount: 0, expandRangeCount: 0},
  };
}

async function validateProbes() {
  const results = [];
  for (const probe of PROBES) {
    const entry = familyFor(probe.family);
    for (const [index, variant] of (probe.variants ?? [probe]).entries()) {
      const variantId = `${probe.id}${probe.variants ? String.fromCharCode(97 + index) : ''}`;
      const context = probeContext(entry, probe, variant);
      compare(context.result.input.head, variant.expectedInput, `${variantId} B-S1.1`);
      if (variant.expectedRelation) {
        compare(relationHead(context), variant.expectedRelation, `${variantId} B-S1.2`);
      }
      compare(context.result.step.head, variant.expectedStep, `${variantId} B-S1.3`);
      if (probe.id === 'BP12') context.bp12 = await runBp12ConsumerProbes(entry);
      const checkNames = variant.checks ?? probe.checks;
      for (const checkName of checkNames) {
        const check = VERIFY_PROBE_CHECKS[checkName];
        assert(typeof check === 'function', `missing VERIFY_PROBE_CHECKS[${checkName}]`);
        check(context.result.step, context);
      }
      results.push({
        id: variantId,
        family: probe.family,
        scenario: variant.scenario,
        phase: probe.phase,
        checks: [...(variant.checks ?? probe.checks)],
        heads: {
          input: context.result.input.head,
          relation: relationHead(context),
          step: context.result.step.head,
        },
        status: 'PASS',
      });
    }
  }
  return results;
}

function validateFixtureShape(entry) {
  const html = entry.render(entry.fixtureFor('input-normal'));
  assert(html.includes('<!doctype html>'), `${entry.code} renderer missing doctype`);
  assert(html.includes('id="query"'), `${entry.code} renderer missing query input`);
  assert(html.includes('id="submit"'), `${entry.code} renderer missing submit control`);
  assert(html.includes('id="notes"'), `${entry.code} renderer missing neighbor notes`);
  assert(html.includes('id="request-state"'), `${entry.code} renderer missing request-state evidence node`);
  assert(html.includes('id="result-scroll-box"'), `${entry.code} renderer missing real scroll box`);
  assert(!html.includes('data-at-geometry-boundary'), `${entry.code} renderer still writes static geometry`);
  assert(!/\b(data-gold|data-oracle|data-teacher|expectedHead|gold policy)\b/i.test(html), `${entry.code} renderer leaks oracle vocabulary`);
  if (entry.code === 'F7') {
    assert(html.includes('<table'), 'F7 must use a table main collection');
    assert(html.includes('<tbody>'), 'F7 must use tbody rows');
  } else {
    assert(html.includes('<main'), 'F8 must use main');
    assert(html.includes('<aside'), 'F8 must use an aside when auxiliary content exists');
  }
  const terminating = entry.render(entry.fixtureFor('probe-bp11b'));
  assert(terminating.includes('id="long-footer-spacer"'), `${entry.code} BP11b missing long footer`);
  assert(!terminating.includes('id="load-more"'), `${entry.code} BP11b must not expose load-more`);
  const unknown = entry.render(entry.fixtureFor('probe-bp10'));
  assert(!unknown.includes('id="load-more"') && !unknown.includes('id="collection-terminal-banner"'),
    `${entry.code} BP10 must not fabricate hasMore sources`);
}

async function validateIndependentFixture() {
  const counts = {episodes: 0, inputRows: 0, relationRows: 0, stepRows: 0, probes: 0, probeVariants: 0, checks: 0};
  const seen = {input: new Map(), relation: new Map(), step: new Map(), probe: new Map()};
  const rows = [];
  for (const code of ['F7', 'F8']) {
    const entry = familyFor(code);
    validateFixtureShape(entry);
    const episodes = EPISODES[code];
    assert(episodes.length === 16, `${code} must define 16 episodes`);
    for (const row of episodes) {
      counts.episodes += 1;
      counts.inputRows += 1;
      const direct = evaluateSyntheticRow(entry, row);
      compare(direct.input.head, row.expectedInput, `${row.id} B-S1.1`);
      rows.push({type: 'input', id: `${row.id}:B-S1.1`, wires: direct.input.wires, head: direct.input.head});
      if (row.phase !== 'input') {
        const submitted = evaluateSyntheticRow(entry, row, 'submitted');
        const results = evaluateSyntheticRow(entry, row, 'results');
        counts.relationRows += 2;
        counts.stepRows += 2;
        compare(submitted.relation.head, row.expectedRelation, `${row.id} B-S1.2 submitted`);
        compare(results.relation.head, row.expectedRelation, `${row.id} B-S1.2 results`);
        const submittedStep = row.expectedStep === 'submit' || row.expectedStep === 'DEFER'
          ? row.expectedStep : 'NOOP';
        const resultsStep = row.expectedStep === 'submit' ? 'DEFER' : row.expectedStep;
        compare(submitted.step.head, submittedStep, `${row.id} B-S1.3 submitted`);
        compare(results.step.head, resultsStep, `${row.id} B-S1.3 results`);
        rows.push({type: 'relation', id: `${row.id}:B-S1.2:submitted`, wires: submitted.relation.wires, head: submitted.relation.head});
        rows.push({type: 'relation', id: `${row.id}:B-S1.2:results`, wires: results.relation.wires, head: results.relation.head});
        rows.push({type: 'step', id: `${row.id}:B-S1.3:submitted`, wires: submitted.step.wires, head: submitted.step.head});
        rows.push({type: 'step', id: `${row.id}:B-S1.3:results`, wires: results.step.wires, head: results.step.head});
      }
    }
  }
  const probeResults = await validateProbes();
  counts.probes = PROBES.length;
  counts.probeVariants = probeResults.length;
  counts.checks = probeResults.reduce((total, item) => total + item.checks.length, 0);
  for (const result of probeResults) {
    for (const [key, head] of [
      ['probe-input', result.heads.input],
      ...(result.heads.relation === null ? [] : [['probe-relation', result.heads.relation]]),
      ['probe-step', result.heads.step],
    ]) {
      const previous = seen.probe.get(`${result.id}:${key}`);
      if (previous && previous !== head) throw new TypeError(`label collision in ${result.id}:${key}`);
      seen.probe.set(`${result.id}:${key}`, head);
    }
    rows.push({type: 'probe', id: `${result.id}:B-S1.1`, wires: [], head: result.heads.input});
    if (result.heads.relation !== null) {
      rows.push({type: 'probe', id: `${result.id}:B-S1.2`, wires: [], head: result.heads.relation});
    }
    rows.push({type: 'probe', id: `${result.id}:B-S1.3`, wires: [], head: result.heads.step});
  }
  // BP06 positive control: B really associated in a separate scenario.
  const positiveEntry = familyFor('F7');
  const positive = evaluateSyntheticRow(positiveEntry, {
    id: 'BP06-positive',
    scenario: 'probe-bp06-positive',
    phase: 'results',
  });
  compare(positive.relation.head, 'results_associated_active', 'BP06-positive B-S1.2');
  compare(positive.step.head, 'NOOP', 'BP06-positive B-S1.3');
  assert(counts.episodes === 32, `episode count must be 32, got ${counts.episodes}`);
  assert(counts.inputRows === 32, `B-S1.1 row count must be 32, got ${counts.inputRows}`);
  assert(counts.relationRows === 48, `B-S1.2 row count must be 48, got ${counts.relationRows}`);
  assert(counts.stepRows === 48, `B-S1.3 row count must be 48, got ${counts.stepRows}`);
  assert(counts.probes === 13, `probe count must be 13, got ${counts.probes}`);
  assert(Object.keys(VERIFY_PROBE_CHECKS).length === 16,
    `VERIFY_PROBE_CHECKS must define 16 checks, got ${Object.keys(VERIFY_PROBE_CHECKS).length}`);
  for (const row of rows) {
    if (row.type === 'probe' || row.wires.length === 0) continue;
    const key = `${row.type}:${row.wires.join('')}`;
    const previous = seen[row.type].get(key);
    if (previous && previous.head !== row.head) {
      throw new TypeError(`label collision in ${row.type}: ${previous.id} and ${row.id}`);
    }
    seen[row.type].set(key, row);
  }
  const f7Source = `${await readFile(FAMILIES.F7.pageFile, 'utf8')}\n${await readFile(FAMILIES.F7.dataFile, 'utf8')}\n${await readFile(FAMILIES.F7.clientFile, 'utf8')}`;
  const f8Source = `${await readFile(FAMILIES.F8.pageFile, 'utf8')}\n${await readFile(FAMILIES.F8.dataFile, 'utf8')}\n${await readFile(FAMILIES.F8.clientFile, 'utf8')}`;
  for (const [code, source] of [['F7', f7Source], ['F8', f8Source]]) {
    assert(!source.includes('search-fixture/page.mjs'), `${code} imports family-A renderer`);
    assert(!source.includes('family-b/page.mjs') && !source.includes('family-c-dev'), `${code} imports development renderer`);
    assert(!source.includes('candidate') && !source.includes('weights') && !source.includes('profile'), `${code} references forbidden training artifacts`);
    assert(source.includes('result-scroll-box'), `${code} does not declare a real scroll container`);
    assert(source.includes('data-at-geometry-boundary') === false, `${code} still writes static geometry`);
  }
  assert(FAMILIES.F7.pageFile !== FAMILIES.F8.pageFile, 'verification renderer files must not be shared');
  assert(FAMILIES.F7.pageFile !== familyA && FAMILIES.F7.pageFile !== familyB && FAMILIES.F7.pageFile !== familyCDev,
    'F7 renderer overlaps a non-verification renderer');
  assert(FAMILIES.F8.pageFile !== familyA && FAMILIES.F8.pageFile !== familyB && FAMILIES.F8.pageFile !== familyCDev,
    'F8 renderer overlaps a non-verification renderer');
  return {
    mode: 'validate-independent-fixture',
    status: 'PASS',
    candidateEvaluated: false,
    fullyVerified: false,
    unseenFeatureCapabilityVerified: false,
    counts,
    families: ['BF_VERIFY_F7_table_catalog', 'BF_VERIFY_F8_split_panel'],
    probes: probeResults,
    bp06PositiveControl: {
      scenario: 'probe-bp06-positive',
      input: positive.input.head,
      relation: positive.relation.head,
      step: positive.step.head,
    },
    isolation: {
      verificationRendererFiles: [FAMILIES.F7.pageFile, FAMILIES.F8.pageFile],
      sharedVerificationRendererFile: false,
      trainRendererFiles: [familyA],
      developmentRendererFiles: [familyB, familyCDev],
      sourceImports: [],
    },
    rows,
  };
}

async function startFixtureServer() {
  const [f7Client, f8Client] = await Promise.all([
    readFile(FAMILIES.F7.clientFile, 'utf8'),
    readFile(FAMILIES.F8.clientFile, 'utf8'),
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, type, body) => {
      response.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
      response.end(body);
    };
    try {
      if (url.pathname === '/verify-f7-table/client.js') return send(200, 'text/javascript; charset=utf-8', f7Client);
      if (url.pathname === '/verify-f8-split/client.js') return send(200, 'text/javascript; charset=utf-8', f8Client);
      const entry = url.pathname === '/verify-f7-table/' || url.pathname === '/verify-f7-table'
        ? FAMILIES.F7
        : url.pathname === '/verify-f8-split/' || url.pathname === '/verify-f8-split'
          ? FAMILIES.F8 : null;
      if (!entry) return send(404, 'text/plain; charset=utf-8', 'Not found');
      const scenario = url.searchParams.get('scenario') ?? 'input-normal';
      return send(200, 'text/html; charset=utf-8', entry.render(entry.fixtureFor(scenario)));
    } catch (error) {
      return send(500, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolveListen());
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function stopChrome(browser) {
  if (browser.child) {
    const exited = new Promise((resolveExit) => browser.child.once('exit', resolveExit));
    browser.child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
  }
  if (browser.userDataDir) {
    await rm(browser.userDataDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
      .catch(() => undefined);
  }
}

async function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next declared browser path.
    }
  }
  return null;
}

async function launchChrome() {
  const binary = await chromeBinary();
  if (!binary) return {status: 'UNVERIFIED', reason: 'headless Chrome binary unavailable'};
  const userDataDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-verify-'));
  const stderr = [];
  // --remote-debugging-port=0 allocates a free ephemeral port. No fixed port is
  // borrowed from another task.
  const child = spawn(binary, [
    '--headless=new',
    '--window-size=1280,1000',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let activePort = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const raw = await readFile(portFile, 'utf8');
      const [port, path] = raw.trim().split('\n');
      if (port && path) {
        activePort = {port: Number(port), path};
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!activePort) {
    child.kill('SIGTERM');
    await rm(userDataDir, {recursive: true, force: true});
    return {
      status: 'UNVERIFIED',
      reason: `headless Chrome did not expose DevToolsActivePort: ${stderr.join('').trim() || 'no stderr'}`,
      stderr: stderr.join(''),
    };
  }
  return {
    status: 'READY',
    child,
    userDataDir,
    stderr,
    httpBase: `http://127.0.0.1:${activePort.port}`,
  };
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const opened = new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    const listener = eventWaiters.get(message.method);
    if (listener) {
      eventWaiters.delete(message.method);
      listener(message.params ?? {});
    }
  });
  const call = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, 15000);
      pending.set(id, {resolve: resolveCall, reject, timer, method});
      socket.send(JSON.stringify({id, method, params}));
    });
  };
  const once = (method) => new Promise((resolveOnce) => eventWaiters.set(method, resolveOnce));
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise});
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate failed: ${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  };
  return {socket, opened, call, once, evaluate, close: () => socket.close()};
}

async function createTarget(httpBase) {
  const response = await fetch(`${httpBase}/json/new?about:blank`, {method: 'PUT'});
  if (!response.ok) throw new Error(`create target failed: HTTP ${response.status}`);
  return response.json();
}

async function closeTarget(httpBase, targetId) {
  try {
    await fetch(`${httpBase}/json/close/${encodeURIComponent(targetId)}`, {method: 'PUT'});
  } catch {
    // The target may already be closed after a failed navigation.
  }
}

async function navigate(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.call('Page.navigate', {url});
  await Promise.race([loaded, delay(5000)]);
  await delay(250);
}

async function clickSelector(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  })()`);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`native click target missing: ${selector}`);
  }
  for (const event of [
    {type: 'mouseMoved', button: 'none', buttons: 0},
    {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1},
    {type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1},
  ]) {
    await cdp.call('Input.dispatchMouseEvent', {...event, x: point.x, y: point.y});
  }
  await delay(30);
}

async function nativeInput(cdp, selector, value) {
  await clickSelector(cdp, selector);
  await delay(50);
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    commands: ['selectAll'],
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.call('Input.insertText', {text: value});
  await delay(180);
}

async function nativeSubmit(cdp) {
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
    unmodifiedText: '\r',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await delay(250);
}

async function scrollGeometry(cdp, selector) {
  return cdp.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    if (!box) return null;
    return {scrollTop: box.scrollTop, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight};
  })()`);
}

// Native scrolling only: real CDP mouse wheel events, with a native End key as
// a fallback if the wheel does not move the container. No scrollTop assignment
// is ever used as a substitute for an action.
async function nativeScrollToBottom(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  })()`);
  if (!point) throw new Error(`native scroll container missing: ${selector}`);
  let geometry = await scrollGeometry(cdp, selector);
  let steps = 0;
  let method = 'wheel';
  let stagnant = 0;
  while (geometry && geometry.scrollTop + geometry.clientHeight < geometry.scrollHeight - 2 && steps < 40) {
    const before = geometry.scrollTop;
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: 240,
    });
    await delay(60);
    geometry = await scrollGeometry(cdp, selector);
    steps += 1;
    if (geometry && geometry.scrollTop === before) {
      stagnant += 1;
      if (stagnant >= 2) {
        method = 'wheel+end-key';
        await clickSelector(cdp, selector);
        for (const type of ['rawKeyDown', 'keyUp']) {
          await cdp.call('Input.dispatchKeyEvent', {
            type,
            key: 'End',
            code: 'End',
            windowsVirtualKeyCode: 35,
            nativeVirtualKeyCode: 35,
          });
        }
        await delay(120);
        geometry = await scrollGeometry(cdp, selector);
      }
    } else {
      stagnant = 0;
    }
  }
  if (!geometry || geometry.clientHeight <= 0
    || geometry.scrollTop + geometry.clientHeight < geometry.scrollHeight - 2) {
    throw new Error(`native scroll did not reach the bottom: ${JSON.stringify(geometry)}`);
  }
  return {geometry, steps, method};
}

function browserObservationFn(config) {
  const q = (selector) => document.querySelector(selector);
  const input = q(config.selectors.input);
  const notes = q(config.selectors.notes);
  const submitted = q(config.selectors.submitted);
  const request = q(config.selectors.request);
  const collection = q(config.selectors.collection);
  const scrollBox = q(config.selectors.scrollBox);
  const banner = q(config.selectors.terminalBanner);
  const loadMore = q(config.selectors.loadMore);
  const attr = (element, name) => element?.getAttribute(name) ?? null;
  const ariaBoolean = (element, name) => {
    const value = attr(element, name);
    return value === 'true' ? true : value === 'false' ? false : null;
  };
  const inputRect = input?.getBoundingClientRect();
  const inputPoint = inputRect ? {
    x: inputRect.x + inputRect.width / 2,
    y: inputRect.y + inputRect.height / 2,
  } : null;
  const points = inputRect ? [
    [0.5, 0.5], [0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5],
  ] : [];
  let hit = false;
  for (const [fx, fy] of points) {
    const top = document.elementFromPoint(
      inputRect.x + inputRect.width * fx,
      inputRect.y + inputRect.height * fy,
    );
    if (top === input || (top instanceof Node && input instanceof Node && input.contains(top))) {
      hit = true;
      break;
    }
  }
  const mainItems = collection
    ? Array.from(collection.querySelectorAll(config.selectors.mainItems)).map((element) => element.textContent.trim())
    : [];
  const auxiliaryCollection = q(config.selectors.auxiliaryItems);
  const auxiliaryItems = auxiliaryCollection
    ? Array.from(document.querySelectorAll(config.selectors.auxiliaryItems))
      .map((element) => element.textContent.trim())
    : [];
  return {
    inputConnected: Boolean(input),
    inputValue: input?.value ?? null,
    inputTag: input?.tagName?.toLowerCase() ?? null,
    inputType: input ? input.getAttribute('type') ?? 'text' : null,
    inputPlaceholder: input?.getAttribute('placeholder') ?? null,
    inputDisabled: input ? input.hasAttribute('disabled') : null,
    inputReadonly: input ? input.hasAttribute('readonly') : null,
    inputAriaDisabled: input ? ariaBoolean(input, 'aria-disabled') : null,
    inputAriaReadonly: input ? ariaBoolean(input, 'aria-readonly') : null,
    inputContentEditable: input ? input.isContentEditable : null,
    inputEditable: input ? !input.hasAttribute('disabled') && !input.hasAttribute('readonly') : null,
    inputActiveElementFocus: input ? document.activeElement === input : null,
    inputActiveElementRef: input && document.activeElement === input ? config.inputRef : null,
    inputPoint,
    executableHit: hit,
    notesValue: notes?.value ?? null,
    submittedQuery: attr(submitted, 'data-submitted-query'),
    submittedRequestRef: attr(submitted, 'data-submitted-request-ref'),
    requestStatus: attr(request, 'data-request-status'),
    display: attr(request, 'data-display'),
    access: attr(request, 'data-access'),
    resultsFor: attr(request, 'data-results-query'),
    resultsRequestRef: attr(request, 'data-results-request-ref'),
    batchRef: attr(request, 'data-batch-ref'),
    mechanicalEffect: attr(request, 'data-mechanical-effect'),
    bannerStatus: attr(banner, 'data-request-status'),
    bannerHasMore: attr(banner, 'data-has-more'),
    loadMoreHasMore: attr(loadMore, 'data-has-more'),
    loadMorePresent: Boolean(loadMore),
    bannerPresent: Boolean(banner),
    scroll: scrollBox
      ? {scrollTop: scrollBox.scrollTop, clientHeight: scrollBox.clientHeight, scrollHeight: scrollBox.scrollHeight}
      : null,
    mainItems,
    auxiliaryItems,
  };
}

async function observeNative(cdp, selectors, inputRef) {
  return cdp.evaluate(`(${browserObservationFn.toString()})(${JSON.stringify({selectors, inputRef})})`);
}

function isKnownRequestState(value) {
  return value === 'loading' || value === 'settled' || value === 'error';
}

function nativeObservationPair(raw, family, revision) {
  const observationId = `${family.id}:native:${revision}`;
  const evidence = [];
  const observed = (key, value) => {
    const id = `${observationId}:${key}`;
    evidence.push({id, source: 'verify-independent-fixture.native-observation', fact: {key, value}});
    return {status: 'observed', value, evidenceRefs: [id]};
  };
  const unknown = (reason) => ({status: 'unknown', reason});
  const geometry = raw.scroll && raw.scroll.clientHeight > 0
    ? raw.scroll.scrollTop + raw.scroll.clientHeight >= raw.scroll.scrollHeight - 2
    : null;
  const requestStateSource = raw.bannerStatus ?? raw.requestStatus;
  const hasMoreSource = raw.bannerHasMore ?? raw.loadMoreHasMore;
  const connected = raw.inputConnected === true;
  const inputHost = raw.inputTag === 'input' || raw.inputTag === 'textarea'
    ? raw.inputTag
    : raw.inputContentEditable === true ? 'contenteditable' : 'unknown';
  const activeElementFocus = typeof raw.inputActiveElementFocus === 'boolean'
    ? observed('target.activeElementFocus', raw.inputActiveElementFocus)
    : unknown('active_element_focus_not_measured');
  const activeElementRef = raw.inputActiveElementFocus === true && raw.inputActiveElementRef
    ? observed('target.activeElementRef', raw.inputActiveElementRef)
    : unknown('active_element_ref_not_mapped');
  const target = {
    ref: family.inputRef,
    connected: typeof raw.inputConnected === 'boolean'
      ? observed('target.connected', raw.inputConnected) : unknown('connectedness_not_measured'),
    currentRef: connected ? observed('target.currentRef', family.inputRef) : unknown('target_not_connected'),
    host: connected ? observed('target.host', inputHost) : unknown('target_not_connected'),
    contentEditable: typeof raw.inputContentEditable === 'boolean'
      ? observed('target.contentEditable', raw.inputContentEditable)
      : unknown('content_editable_not_measured'),
    type: typeof raw.inputType === 'string'
      ? observed('target.type', raw.inputType)
      : unknown('target_type_not_measured'),
    value: typeof raw.inputValue === 'string'
      ? observed('target.value', raw.inputValue) : unknown('value_not_observed'),
    placeholder: connected && raw.inputPlaceholder !== undefined
      ? observed('target.placeholder', raw.inputPlaceholder) : unknown('placeholder_not_measured'),
    nativeDisabled: typeof raw.inputDisabled === 'boolean'
      ? observed('target.nativeDisabled', raw.inputDisabled) : unknown('native_disabled_not_measured'),
    ariaDisabled: connected
      ? observed('target.ariaDisabled', raw.inputAriaDisabled ?? null) : unknown('aria_disabled_not_measured'),
    nativeReadonly: typeof raw.inputReadonly === 'boolean'
      ? observed('target.nativeReadonly', raw.inputReadonly) : unknown('native_readonly_not_measured'),
    ariaReadonly: connected
      ? observed('target.ariaReadonly', raw.inputAriaReadonly ?? null) : unknown('aria_readonly_not_measured'),
    readonlyState: connected && typeof raw.inputReadonly === 'boolean'
      ? observed('target.readonlyState',
        raw.inputReadonly || raw.inputAriaReadonly === true ? 'readonly' : 'editable')
      : unknown('readonly_state_not_measured'),
    editable: typeof raw.inputEditable === 'boolean'
      ? observed('target.editable', raw.inputEditable) : unknown('editable_not_measured'),
    activeElementRef,
    activeElementFocus,
    executableHit: typeof raw.executableHit === 'boolean'
      ? observed('target.executableHit', raw.executableHit) : unknown('executable_hit_not_measured'),
    point: raw.inputPoint && Number.isFinite(raw.inputPoint.x) && Number.isFinite(raw.inputPoint.y)
      ? observed('target.point', raw.inputPoint) : unknown('point_not_measured'),
  };
  const neighbors = [
    {
      ref: `${family.inputRef}-neighbor`,
      value: typeof raw.notesValue === 'string'
        ? observed('neighbors.notes.value', raw.notesValue)
        : unknown('neighbor_value_not_observed'),
    },
  ];
  const input = {
    ref: family.inputRef,
    tag: inputHost,
    type: raw.inputType ?? 'unknown',
    value: typeof raw.inputValue === 'string'
      ? observed('input.value', raw.inputValue) : unknown('value_not_observed'),
    editable: typeof raw.inputEditable === 'boolean'
      ? observed('input.editable', raw.inputEditable) : unknown('editable_not_measured'),
  };
  const itemRef = (key, value) => observed(`collection.items.${key}.text`, value);
  const items = [
    ...raw.mainItems.map((text, index) => ({
      ref: `${family.collectionRef}-main-${index}`,
      collectionRef: family.collectionRef,
      role: 'main',
      text: itemRef(index, text),
    })),
    ...(raw.auxiliaryItems ?? []).map((text, index) => ({
      ref: `${family.collectionRef}-auxiliary-${index}`,
      collectionRef: family.collectionRef,
      role: 'auxiliary',
      text: itemRef(`auxiliary.${index}`, text),
    })),
  ];
  const display = ['none', 'old', 'current', 'empty', 'partial', 'unknown'].includes(raw.display)
    ? raw.display : 'unknown';
  const access = ['available', 'login_required', 'challenge', 'unknown'].includes(raw.access)
    ? raw.access : 'unknown';
  const request = ['loading', 'settled', 'error', 'unknown'].includes(raw.requestStatus)
    ? raw.requestStatus : 'unknown';
  const identity = {
    documentRef: family.documentRef,
    scopeRef: family.scopeRef,
    observationId,
    revision,
  };
  const inputObservation = readBrowserInputObservation({...identity, target, neighbors, evidence});
  const searchObservation = readBrowserSearchObservation({
    ...identity,
    input,
    submitRef: family.submitRef,
    submittedQuery: raw.submittedQuery ? observed('submittedQuery', raw.submittedQuery) : unknown('submitted_query_not_observed'),
    resultsFor: raw.resultsFor ? observed('resultsFor', raw.resultsFor) : unknown('results_query_not_observed'),
    submittedRequestRef: raw.submittedRequestRef
      ? observed('submittedRequestRef', raw.submittedRequestRef) : unknown('submitted_request_not_observed'),
    resultsRequestRef: raw.resultsRequestRef
      ? observed('resultsRequestRef', raw.resultsRequestRef) : unknown('results_request_not_observed'),
    request,
    display,
    access,
    collection: {
      ref: family.collectionRef,
      scopeRef: family.resultScopeRef,
      requestRef: raw.resultsRequestRef
        ? observed('collection.requestRef', raw.resultsRequestRef) : unknown('results_request_not_observed'),
      items,
      batch: raw.batchRef ? observed('collection.batch', raw.batchRef) : unknown('batch_not_observed'),
    },
    rangeExpansion: {
      actionMechanicalEffect: ['displaced_or_triggered', 'no_change', 'not_attempted'].includes(raw.mechanicalEffect)
        ? raw.mechanicalEffect : 'not_attempted',
      atGeometryBoundary: geometry === null
        ? unknown('geometry_not_measured') : observed('rangeExpansion.atGeometryBoundary', geometry),
      requestState: isKnownRequestState(requestStateSource)
        ? observed('rangeExpansion.requestState', requestStateSource)
        : unknown('no_positive_request_state_source'),
      hasMore: hasMoreSource === 'true' || hasMoreSource === 'false'
        ? observed('rangeExpansion.hasMore', hasMoreSource === 'true')
        : unknown('no_positive_terminal_control_source'),
    },
    evidence,
  });
  return {input: inputObservation, search: searchObservation, evidence, geometry};
}

function evaluateNative(entry, pair, phase, scenario) {
  const fixture = entry.fixtureFor(scenario);
  const baseline = submissionBaselineFor(fixture, entry.family);
  const state = {
    observation: pair.search,
    inputObservation: pair.input,
    checkedObservationId: phase === 'results' ? pair.search.observationId : null,
    submissionBaseline: baseline,
  };
  return {...evaluateState(entry, state, phase), fixture};
}

async function createNativeInputResources(cdp, entry, {failAfterAction = false} = {}) {
  let revision = 0;
  let control = null;
  let nativeWrites = 0;
  let submitCount = 0;
  const observe = async (obligation) => {
    if (failAfterAction && obligation.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
    const pair = nativeObservationPair(raw, entry.family, revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: pair.input.observationId,
      revision,
    };
    return pair.input;
  };
  return {
    resources: {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText']),
      observe,
      currentControl: () => control,
      nativeInputText: async (invocation) => {
        nativeWrites += 1;
        await nativeInput(cdp, entry.selectors.input, invocation.value);
        throw new Error('injected native transport error after dispatch');
      },
    },
    counters: () => ({nativeWrites, submitCount}),
  };
}

async function createNativeSearchResources(cdp, entry, {
  failAfterAction = false,
  failAfterInput = true,
  episodes = null,
} = {}) {
  let revision = 0;
  let control = null;
  let nativeWrites = 0;
  let submitCount = 0;
  const observe = async (obligation) => {
    if (failAfterAction && obligation.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
    const pair = nativeObservationPair(raw, entry.family, revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: pair.search.observationId,
      revision,
    };
    return pair.search;
  };
  return {
    resources: {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
      decision: handwiredBrowserSearchDecision,
      observe,
      readResults: observe,
      currentControl: () => control,
      nativeInputText: async (invocation) => {
        nativeWrites += 1;
        await nativeInput(cdp, entry.selectors.input, invocation.value);
        if (failAfterInput) throw new Error('injected native transport error after dispatch');
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: 'unknown',
          source: 'verify-independent-fixture.native-input',
          error: null,
        };
      },
      nativeSubmit: async () => {
        submitCount += 1;
        if (failAfterInput) throw new Error('BP12 search must not submit after an input transport error');
        await nativeSubmit(cdp);
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: 'unknown',
          source: 'verify-independent-fixture.native-submit',
          error: null,
        };
      },
      collect: async (episode) => {
        episodes?.push(episode);
      },
    },
    counters: () => ({nativeWrites, submitCount}),
  };
}

async function runNativeSearchSubmission(cdp, server, entry) {
  const episodes = [];
  await navigate(cdp, `${server.origin}${entry.path}?scenario=input-normal`);
  const searchCase = await createNativeSearchResources(cdp, entry, {
    failAfterInput: false,
    episodes,
  });
  const response = await runBrowserSearchGoal({
    requestId: 'bp12-native-recursive-submission',
    goal: goalFor(entry, 'root'),
    satisfactionThreshold: 100,
    bindings: bindingsFor(entry.family),
    maxResultReads: 1,
  }, searchCase.resources);
  return {
    kind: response.kind ?? null,
    rootResult: response.report?.rootEvaluation?.result ?? null,
    nativeWrites: searchCase.counters().nativeWrites,
    submitCount: searchCase.counters().submitCount,
    actions: episodes.map((episode) => episode.action),
    episodes,
  };
}

async function runNativeBp12(cdp, server, entry) {
  const url = (scenario) => `${server.origin}${entry.path}?scenario=${encodeURIComponent(scenario)}`;
  const request = {
    requestId: 'bp12-native-input',
    goal: {kind: 'BrowserInput', targetText: entry.family.query},
    satisfactionThreshold: 100,
    bindings: {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      targetRef: entry.family.inputRef,
    },
  };
  await navigate(cdp, url('probe-bp12'));
  const inputCase = await createNativeInputResources(cdp, entry);
  const inputEpisode = await runBrowserInputEpisode(request, inputCase.resources);
  await navigate(cdp, url('probe-bp12'));
  const searchCase = await createNativeSearchResources(cdp, entry);
  const searchEpisode = await runBrowserSearchEpisode({
    goal: goalFor(entry, 'input'),
    bindings: bindingsFor(entry.family),
    maxResultReads: 1,
    submissionBaseline: null,
    checkedObservationId: null,
  }, searchCase.resources);
  await navigate(cdp, url('probe-bp12'));
  const inputFailureCase = await createNativeInputResources(cdp, entry, {failAfterAction: true});
  const inputFailure = await runBrowserInputEpisode(request, inputFailureCase.resources);
  await navigate(cdp, url('probe-bp12'));
  const searchFailureCase = await createNativeSearchResources(cdp, entry, {failAfterAction: true});
  const searchFailure = await runBrowserSearchEpisode({
    goal: goalFor(entry, 'input'),
    bindings: bindingsFor(entry.family),
    maxResultReads: 1,
    submissionBaseline: null,
    checkedObservationId: null,
  }, searchFailureCase.resources);
  const submission = await runNativeSearchSubmission(cdp, server, entry);
  const summarizeNative = (episode, counters, observedValue) => ({
    episode,
    nativeWrites: counters.nativeWrites,
    submitCount: counters.submitCount,
    dispatchedValue: observedValue,
  });
  return {
    input: summarizeNative(inputEpisode, inputCase.counters(),
      inputEpisode.state?.observation?.target?.value?.value ?? null),
    search: summarizeNative(searchEpisode, searchCase.counters(),
      searchEpisode.state?.observation?.input?.value?.value ?? null),
    inputObservationFailure: summarizeNative(inputFailure, inputFailureCase.counters(), null),
    searchObservationFailure: summarizeNative(searchFailure, searchFailureCase.counters(), null),
    submission,
  };
}

async function runNativeSmoke() {
  const server = await startFixtureServer();
  const browser = await launchChrome();
  if (browser.status !== 'READY') {
    await server.close();
    return {
      mode: 'native-cdp-fixture-smoke',
      status: 'UNVERIFIED',
      candidateEvaluated: false,
      fullyVerified: false,
      unseenFeatureCapabilityVerified: false,
      reason: browser.reason,
      rawStderr: browser.stderr ?? null,
    };
  }
  const checks = [];
  let target = null;
  let cdp = null;
  try {
    target = await createTarget(browser.httpBase);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    let revision = 0;
    const visit = async (entry, scenario) => {
      await navigate(cdp, `${server.origin}${entry.path}?scenario=${encodeURIComponent(scenario)}`);
    };
    const observePair = async (entry) => {
      revision += 1;
      const raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
      return {raw, pair: nativeObservationPair(raw, entry.family, revision)};
    };
    const record = (id, entry, scenario, capture, heads, sideEffects = {}, details = {}) => {
      const observation = capture.pair.search;
      process.stderr.write(`[native] ${id} PASS\n`);
      checks.push({
        id,
        family: entry.code,
        scenario,
        status: 'PASS',
        heads,
        observation: {
          observationId: observation.observationId,
          request: observation.request,
          display: observation.display,
          access: observation.access,
          submittedRequestRef: observation.submittedRequestRef,
          resultsRequestRef: observation.resultsRequestRef,
          batch: observation.collection.batch,
          atGeometryBoundary: observation.rangeExpansion.atGeometryBoundary,
          requestState: observation.rangeExpansion.requestState,
          hasMore: observation.rangeExpansion.hasMore,
          collectionTerminal: observation.rangeExpansion.collectionTerminal,
          itemCount: observation.collection.items.length,
        },
        observationRecord: {
          search: observation,
          input: capture.pair.input,
          raw: capture.raw,
        },
        sideEffects,
        ...details,
      });
    };

    for (const familyCode of ['F7', 'F8']) {
      const entry = familyFor(familyCode);
      // Live input and submit.
      await visit(entry, 'input-normal');
      const preInput = await observePair(entry);
      const preInputEval = evaluateNative(entry, preInput.pair, 'input', 'input-normal');
      compare(preInputEval.input.head, 'INPUT', `${familyCode} native pre-input B-S1.1`);
      await nativeInput(cdp, entry.selectors.input, entry.family.query);
      let {raw, pair} = await observePair(entry);
      assert(raw.inputValue === entry.family.query, `${familyCode} native input value mismatch`);
      assert(raw.notesValue === '保持原值', `${familyCode} native input changed neighbor`);
      compare(pair.input.target.activeElementFocus.status, 'observed',
        `${familyCode} native active element focus measured`);
      compare(pair.input.target.activeElementFocus.value, true,
        `${familyCode} native input remains focused`);
      compare(pair.input.target.activeElementRef.status, 'observed',
        `${familyCode} native active element ref measured`);
      compare(pair.input.target.activeElementRef.value, entry.family.inputRef,
        `${familyCode} native active element ref`);
      compare(pair.input.target.point.status, 'observed', `${familyCode} native input point measured`);
      assert(Number.isFinite(pair.input.target.point.value.x)
        && Number.isFinite(pair.input.target.point.value.y),
      `${familyCode} native input point is not finite`);
      let evaluated = evaluateNative(entry, pair, 'input', 'input-normal');
      record(`${familyCode}-native-input`, entry, 'input-normal', {raw, pair},
        {inputBefore: preInputEval.input.head, inputAfter: evaluated.input.head, relation: null,
          stepBefore: preInputEval.step.head, stepAfter: evaluated.step.head},
        {textWriteCount: 1, submitCount: 0});

      revision += 1;
      const missingRaw = await observeNative(cdp,
        {...entry.selectors, input: '#missing-query'}, entry.family.inputRef);
      const missingPair = nativeObservationPair(missingRaw, entry.family, revision);
      compare(missingPair.input.target.connected.status, 'observed',
        `${familyCode} unavailable target connected measured`);
      compare(missingPair.input.target.connected.value, false,
        `${familyCode} unavailable target connected`);
      for (const [key, fact] of [
        ['disabled', missingPair.input.target.nativeDisabled],
        ['readonly', missingPair.input.target.nativeReadonly],
        ['focus', missingPair.input.target.activeElementFocus],
        ['point', missingPair.input.target.point],
      ]) {
        compare(fact.status, 'unknown', `${familyCode} unavailable ${key} remains unknown`);
      }
      record(`${familyCode}-native-unavailable-facts`, entry, 'input-normal',
        {raw: missingRaw, pair: missingPair}, {input: null, relation: null, step: null}, {},
        {assertions: ['connected=false observed', 'disabled/readonly/focus/point unknown']});

      await visit(entry, 'input-normal');
      await nativeInput(cdp, entry.selectors.input, entry.family.query);
      await nativeSubmit(cdp);
      ({raw, pair} = await observePair(entry));
      assert(raw.submittedRequestRef, `${familyCode} native submit missing request ref`);
      assert(raw.resultsRequestRef === raw.submittedRequestRef, `${familyCode} native result request mismatch`);
      assert(raw.batchRef, `${familyCode} native submit missing batch`);
      assert(raw.mainItems.length === 6, `${familyCode} native submit produced ${raw.mainItems.length} rows`);
      evaluated = evaluateNative(entry, pair, 'results', 'input-normal');
      record(`${familyCode}-native-submit`, entry, 'input-normal', {raw, pair},
        {input: evaluated.input.head, relation: evaluated.relation.head, step: evaluated.step.head},
        {textWriteCount: 1, submitCount: 1});

      // Scroll geometry at the top of a six-row batch and long-footer terminal.
      await visit(entry, 'flow-submitted');
      ({raw, pair} = await observePair(entry));
      assert(raw.scroll.scrollTop === 0 && raw.scroll.scrollHeight > raw.scroll.clientHeight,
        `${familyCode} top geometry is not a real scrollable batch: ${JSON.stringify(raw.scroll)}`);
      assert(pair.geometry === false, `${familyCode} top atGeometryBoundary must be false`);
      assert(pair.search.rangeExpansion.collectionTerminal === true,
        `${familyCode} flow-submitted terminal must derive from settled+hasMore false: ${
          JSON.stringify({raw, range: pair.search.rangeExpansion,
            batch: pair.search.collection.batch, items: pair.search.collection.items.length})}`);
      evaluated = evaluateNative(entry, pair, 'results', 'flow-submitted');
      compare(evaluated.relation.head, 'results_associated_active', `${familyCode} native flow-submitted relation`);
      compare(evaluated.step.head, 'NOOP', `${familyCode} native flow-submitted step`);

      await visit(entry, 'probe-bp11b');
      ({raw, pair} = await observePair(entry));
      assert(raw.scroll.scrollTop === 0, `${familyCode} BP11b must start at scrollTop 0`);
      assert(pair.geometry === false, `${familyCode} BP11b long footer must keep geometry false`);
      assert(pair.search.rangeExpansion.collectionTerminal === true, `${familyCode} BP11b terminal`);
      assert(!raw.loadMorePresent, `${familyCode} BP11b must not expose load-more`);
      evaluated = evaluateNative(entry, pair, 'results', 'probe-bp11b');
      compare(evaluated.step.head, 'NOOP', `${familyCode} BP11b step`);

      // Batch progression through #load-more click.
      await visit(entry, 'range-expand');
      const loadMoreHit = await cdp.evaluate(`(() => {
        const button = document.getElementById('load-more');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {topId: top?.id ?? top?.tagName ?? null, rect: {x: rect.x, y: rect.y, w: rect.width, h: rect.height}};
      })()`);
      assert(loadMoreHit?.topId === 'load-more', `${familyCode} load-more is not the top hit target: ${JSON.stringify(loadMoreHit)}`);
      await clickSelector(cdp, entry.selectors.loadMore);
      await delay(260);
      ({raw, pair} = await observePair(entry));
      assert(raw.mainItems.length === 12, `${familyCode} load-more batch size ${raw.mainItems.length}: ${
        JSON.stringify({status: raw.requestStatus, batch: raw.batchRef, loadMore: raw.loadMorePresent, banner: raw.bannerPresent})}`);
      assert(raw.batchRef.endsWith(':batch-2'), `${familyCode} load-more batch ref ${raw.batchRef}`);
      assert(pair.search.rangeExpansion.collectionTerminal === true, `${familyCode} load-more terminal`);
      const afterLoadMore = evaluateNative(entry, pair, 'results', 'range-expand');
      compare(afterLoadMore.step.head, 'NOOP', `${familyCode} load-more expanded terminal step`);
      record(`${familyCode}-native-load-more`, entry, 'range-expand', {raw, pair},
        {relation: afterLoadMore.relation.head, step: afterLoadMore.step.head},
        {expandRangeCount: 1});

      // Real scroll-driven batch progression.
      await visit(entry, 'range-6a-hasmore');
      const scrollResult = await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
      await delay(260);
      ({raw, pair} = await observePair(entry));
      assert(scrollResult.method !== 'js', `${familyCode} batch progression must not use JS assignment`);
      assert(raw.mainItems.length === 12, `${familyCode} scroll batch size ${raw.mainItems.length}`);
      assert(raw.batchRef.endsWith(':batch-2'), `${familyCode} scroll batch ref ${raw.batchRef}`);
      assert(scrollResult.geometry.scrollTop + scrollResult.geometry.clientHeight
        >= scrollResult.geometry.scrollHeight - 2,
      `${familyCode} native scroll did not reach the pre-expansion bottom`);
      const afterScrollBatch = evaluateNative(entry, pair, 'results', 'range-6a-hasmore');
      record(`${familyCode}-native-scroll-batch`, entry, 'range-6a-hasmore', {raw, pair},
        {relation: afterScrollBatch.relation.head, step: afterScrollBatch.step.head},
        {expandRangeCount: 1, scrollMethod: scrollResult.method, steps: scrollResult.steps});

      // Async bottom loading: observe while loading, then settled batch 2.
      await visit(entry, 'range-6a-loading');
      const loadingScroll = await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
      ({raw, pair} = await observePair(entry));
      assert(raw.requestStatus === 'loading', `${familyCode} 6A loading status ${raw.requestStatus}`);
      assert(pair.geometry === true, `${familyCode} 6A loading geometry`);
      assert(pair.search.rangeExpansion.collectionTerminal === false, `${familyCode} 6A loading terminal`);
      evaluated = evaluateNative(entry, pair, 'results', 'range-6a-loading');
      compare(evaluated.relation.head, 'submitted_pending_or_stale', `${familyCode} 6A loading relation`);
      compare(evaluated.step.head, 'read_or_reobserve', `${familyCode} 6A loading step`);
      await delay(300);
      ({raw, pair} = await observePair(entry));
      assert(raw.mainItems.length === 12, `${familyCode} 6A settled batch size ${raw.mainItems.length}`);
      assert(pair.search.rangeExpansion.collectionTerminal === true, `${familyCode} 6A settled terminal`);
      record(`${familyCode}-native-6a-loading`, entry, 'range-6a-loading', {raw, pair},
        {relation: evaluated.relation.head, step: evaluated.step.head},
        {scrollMethod: loadingScroll.method, steps: loadingScroll.steps});

      // Unknown hasMore must stay unknown after real scrolling.
      await visit(entry, 'range-6a-unknown');
      await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
      ({raw, pair} = await observePair(entry));
      assert(!raw.loadMorePresent && !raw.bannerPresent, `${familyCode} unknown source must be absent`);
      assert(pair.geometry === true, `${familyCode} unknown geometry`);
      assert(pair.search.rangeExpansion.hasMore.status === 'unknown', `${familyCode} unknown hasMore`);
      assert(pair.search.rangeExpansion.collectionTerminal === false, `${familyCode} unknown terminal`);
      evaluated = evaluateNative(entry, pair, 'results', 'range-6a-unknown');
      // The page still exposes a settled request state, so the relation head is
      // not forced; the unknown terminal boundary is asserted below.
      compare(evaluated.step.head, 'DEFER', `${familyCode} unknown step`);
      record(`${familyCode}-native-6a-unknown`, entry, 'range-6a-unknown', {raw, pair},
        {relation: evaluated.relation.head, step: evaluated.step.head});

      // Bottom terminal after real scrolling.
      await visit(entry, 'range-6b-bottom');
      await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
      ({raw, pair} = await observePair(entry));
      assert(pair.geometry === true, `${familyCode} bottom geometry`);
      assert(pair.search.rangeExpansion.collectionTerminal === true, `${familyCode} bottom terminal`);
      evaluated = evaluateNative(entry, pair, 'results', 'range-6b-bottom');
      compare(evaluated.step.head, 'NOOP', `${familyCode} bottom step`);
      record(`${familyCode}-native-6b-bottom`, entry, 'range-6b-bottom', {raw, pair},
        {relation: evaluated.relation.head, step: evaluated.step.head});
    }

    // Every probe check is executed against native observations.
    for (const probe of PROBES) {
      const entry = familyFor(probe.family);
      for (const [index, variant] of (probe.variants ?? [probe]).entries()) {
        const variantId = `${probe.id}${probe.variants ? String.fromCharCode(97 + index) : ''}`;
        process.stderr.write(`[native] ${variantId} start\n`);
        await visit(entry, variant.scenario);
        const sideEffects = {textWriteCount: 0, submitCount: 0, expandRangeCount: 0, scrollMethod: null};
        let actionPolicy = null;
        if (probe.id === 'BP02' || probe.id === 'BP03') {
          if (probe.id === 'BP02') {
            const preAction = await observePair(entry);
            actionPolicy = evaluateNative(entry, preAction.pair, 'input', variant.scenario);
          }
          await nativeInput(cdp, entry.selectors.input, entry.family.query);
          sideEffects.textWriteCount = 1;
        } else if (probe.id === 'BP06') {
          await nativeInput(cdp, entry.selectors.input, '近岸旧查询A');
          await nativeSubmit(cdp);
          await delay(120);
          await nativeInput(cdp, entry.selectors.input, entry.family.query);
          await nativeSubmit(cdp);
          await delay(60);
          sideEffects.textWriteCount = 2;
          sideEffects.submitCount = 2;
        } else if (probe.id === 'BP09' || probe.id === 'BP10' || probe.id === 'BP11') {
          const scrolled = await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
          sideEffects.scrollMethod = scrolled.method;
          sideEffects.expandRangeCount = probe.id === 'BP09' ? 1 : 0;
        }
        let raw;
        let pair;
        let nativeBp12 = null;
        if (probe.id === 'BP12') {
          nativeBp12 = await runNativeBp12(cdp, server, entry);
          const cases = ['input', 'search', 'inputObservationFailure', 'searchObservationFailure'];
          sideEffects.textWriteCount = cases.reduce(
            (sum, key) => sum + nativeBp12[key].nativeWrites, nativeBp12.submission.nativeWrites,
          );
          sideEffects.submitCount = cases.reduce(
            (sum, key) => sum + nativeBp12[key].submitCount, nativeBp12.submission.submitCount,
          );
          sideEffects.expandRangeCount = 0;
          sideEffects.bp12 = {
            input: nativeBp12.input.nativeWrites,
            search: nativeBp12.search.nativeWrites,
            inputObservationFailure: nativeBp12.inputObservationFailure.nativeWrites,
            searchObservationFailure: nativeBp12.searchObservationFailure.nativeWrites,
            submission: nativeBp12.submission.submitCount,
          };
          await visit(entry, 'probe-bp12');
          raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
          pair = nativeObservationPair(raw, entry.family, ++revision);
        } else {
          ({raw, pair} = await observePair(entry));
        }
        const evaluated = actionPolicy ?? evaluateNative(entry, pair, probe.phase, variant.scenario);
        assert(evaluated.input.head === variant.expectedInput,
          `${variantId} native B-S1.1: ${evaluated.input.head}`);
        if (variant.expectedRelation) {
          assert(evaluated.relation.head === variant.expectedRelation,
            `${variantId} native B-S1.2: ${evaluated.relation.head}`);
        }
        assert(evaluated.step.head === variant.expectedStep,
          `${variantId} native B-S1.3: ${evaluated.step.head}`);
        const context = {
          probe,
          variant,
          family: entry,
          result: evaluated,
          observation: pair.search,
          inputObservation: pair.input,
          sideEffects,
          bp12: nativeBp12,
        };
        const checkNames = variant.checks ?? probe.checks;
        for (const checkName of checkNames) {
          const check = VERIFY_PROBE_CHECKS[checkName];
          assert(typeof check === 'function', `missing VERIFY_PROBE_CHECKS[${checkName}]`);
          check(evaluated.step, context);
        }
        record(`${variantId}-native`, entry, variant.scenario, {raw, pair},
          {input: evaluated.input.head, relation: evaluated.relation?.head ?? null, step: evaluated.step.head},
          sideEffects, nativeBp12 ? {bp12: nativeBp12} : {});
      }
    }

    // BP06 positive control on real native actions: B associated after it settles.
    const entry = familyFor('F7');
    await visit(entry, 'probe-bp06');
    await nativeInput(cdp, entry.selectors.input, '近岸旧查询A');
    await nativeSubmit(cdp);
    await delay(120);
    await nativeInput(cdp, entry.selectors.input, entry.family.query);
    await nativeSubmit(cdp);
    await delay(1000);
    const {raw, pair} = await observePair(entry);
    assert(raw.submittedRequestRef === raw.resultsRequestRef,
      `BP06 positive control not associated: ${raw.submittedRequestRef} vs ${raw.resultsRequestRef}`);
    const positive = evaluateNative(entry, pair, 'results', 'probe-bp06');
    compare(positive.relation.head, 'results_associated_active', 'BP06-positive native relation');
    compare(positive.step.head, 'NOOP', 'BP06-positive native step');
    record('BP06-positive-native', entry, 'probe-bp06', {raw, pair},
      {relation: positive.relation.head, step: positive.step.head}, {submitCount: 2, textWriteCount: 2});

    return {
      mode: 'native-cdp-fixture-smoke',
      status: 'PASS',
      candidateEvaluated: false,
      fullyVerified: false,
      unseenFeatureCapabilityVerified: false,
      browser: {binary: await chromeBinary(), protocol: 'CDP Input.* + read-only DOM'},
      checks,
      rawStderr: browser.stderr.join(''),
    };
  } finally {
    if (cdp) cdp.close();
    if (target) await closeTarget(browser.httpBase, target.id);
    await stopChrome(browser);
    await server.close();
  }
}

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

async function main() {
  const mode = argAfter('--mode', 'validate-independent-fixture');
  if (mode === 'validate-independent-fixture') {
    const result = await validateIndependentFixture();
    const output = JSON.stringify(result, null, 2);
    const outPath = argAfter('--out', null);
    if (outPath) await writeFile(outPath, `${output}\n`);
    console.log(output);
    return;
  }
  if (mode === 'native-cdp-fixture-smoke') {
    const result = await runNativeSmoke();
    const output = JSON.stringify(result, null, 2);
    const outPath = argAfter('--out', null);
    if (outPath) await writeFile(outPath, `${output}\n`);
    console.log(output);
    return;
  }
  if (mode === 'evaluate-candidate') {
    const {evaluateIndependentCandidate} = await import('./evaluate-independent-candidate.mjs');
    const candidateDir = argAfter(
      '--candidate-dir',
      argAfter('--candidate', process.env.BSEARCH_DECISION_PROFILE_DIR ?? null),
    );
    const outPath = argAfter('--out', null);
    const cdpUrl = argAfter('--cdp-url', process.env.BSEARCH_CDP_URL ?? null);
    const cdpPort = argAfter('--cdp-port', process.env.BSEARCH_CDP_PORT ?? null);
    const dryRunWiring = process.argv.includes('--dry-run-wiring');
    const result = await evaluateIndependentCandidate({
      candidateDir,
      outPath,
      cdpUrl,
      cdpPort,
      dryRunWiring,
    });
    const output = JSON.stringify(result, null, 2);
    if (outPath) await writeFile(outPath, `${output}\n`);
    console.log(output);
    if (result.status === 'FAIL') {
      process.exitCode = 1;
    }
    return;
  }
  throw new TypeError(`Unknown --mode: ${mode}`);
}

export {
  FAMILIES,
  EPISODES,
  PROBES,
  VERIFY_PROBE_CHECKS,
  buildObservation,
  buildState,
  startFixtureServer,
  validateIndependentFixture,
  runNativeSmoke,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
