import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {
  BROWSER_INPUT_POLICY_HEADS,
  BROWSER_QUERY_RELATION_HEADS,
  createBrowserInputPolicyProfile,
  createBrowserQueryRelationProfile,
  createBrowserStepPolicyProfile,
  isSameCheckedResultBatch,
  predictBrowserInputPolicy,
  predictBrowserQueryRelation,
  readBrowserSearchObservation,
  runBrowserSearchEpisode,
  runBrowserSearchGoal,
  searchPhaseFact,
} from 'nnanything/browser-search';
import {resolveBrowserSearchDecision} from '../dist/nodes/browser-search.js';
import {measureBrowserSearchProgress} from '../dist/adapters/browser/search-recursive.js';

const nativeCaseDir = await mkdtemp(join(tmpdir(), 'browser-stage1-semantics-'));
await writeFile(join(nativeCaseDir, 'case.json'), JSON.stringify({selectors: {}, bindings: {}}));
const previousCaseDir = process.env.BSEARCH_CASE_DIR;
process.env.BSEARCH_CASE_DIR = nativeCaseDir;
process.env.BSEARCH_READ_TIMEOUT_MS = '1000';
const {buildObservation, classifyRangeEffect} = await import('../playground/browser/search/native-io.mjs');
after(async () => {
  if (previousCaseDir === undefined) delete process.env.BSEARCH_CASE_DIR;
  else process.env.BSEARCH_CASE_DIR = previousCaseDir;
  await rm(nativeCaseDir, {recursive: true, force: true});
});

const bindings = {
  documentRef: 'search-doc',
  scopeRef: 'search-scope',
  inputRef: 'query',
  submitRef: 'submit',
  resultScopeRef: 'results',
  collectionRef: 'main',
};

const ALL_EFFECTS = [
  'browser.read',
  'browser.nativeInputText',
  'browser.nativeSubmit',
  'browser.nativeExpandRange',
  'filesystem.write',
];

const observed = (value, id) => ({status: 'observed', value, evidenceRefs: [id]});
const unknown = (reason) => ({status: 'unknown', reason});

function inputTarget(id) {
  return {
    ref: bindings.inputRef,
    connected: observed(true, id),
    currentRef: observed(bindings.inputRef, id),
    host: observed('input', id),
    contentEditable: observed(false, id),
    type: observed('text', id),
    value: observed('露营', id),
    placeholder: observed(null, id),
    nativeDisabled: observed(false, id),
    ariaDisabled: observed(false, id),
    nativeReadonly: observed(false, id),
    ariaReadonly: observed(null, id),
    readonlyState: observed('editable', id),
    editable: observed(true, id),
    activeElementRef: observed(bindings.inputRef, id),
    activeElementFocus: observed(true, id),
    executableHit: observed(true, id),
    point: observed({x: 10, y: 20}, id),
  };
}

function makeObservation(options = {}) {
  const observationId = options.observationId ?? 'observation-1';
  const id = `${observationId}:evidence`;
  const requestState = options.requestState ?? 'settled';
  const hasMore = options.hasMore ?? false;
  const inputValue = options.inputValue ?? '露营';
  const submittedQuery = options.submittedQuery ?? '露营';
  const submittedRequestRef = options.submittedRequestRef ?? 'request-new';
  const resultsRequestRef = options.resultsRequestRef ?? submittedRequestRef;
  const batch = options.batch ?? 'batch-1';
  const items = options.items ?? [{
    ref: 'item-1',
    collectionRef: bindings.collectionRef,
    role: 'main',
    text: observed(options.itemText ?? '露营装备清单', id),
  }];
  const rangeRequestState = requestState === 'unknown'
    ? unknown('no_positive_request_state_source')
    : observed(requestState, id);
  const rangeHasMore = hasMore === 'unknown'
    ? unknown('no_positive_terminal_control_source')
    : observed(hasMore, id);
  return {
    documentRef: bindings.documentRef,
    scopeRef: bindings.scopeRef,
    observationId,
    revision: options.revision ?? 2,
    ...(options.withTarget ? {target: inputTarget(id)} : {}),
    input: {
      ref: bindings.inputRef,
      tag: options.tag ?? 'input',
      type: options.type ?? 'text',
      value: options.inputValueUnknown
        ? unknown('not_observable')
        : observed(inputValue, id),
      editable: observed(true, id),
    },
    submitRef: bindings.submitRef,
    submittedQuery: options.submittedQueryUnknown
      ? unknown('not_observable')
      : observed(submittedQuery, id),
    resultsFor: observed(options.resultsFor ?? submittedQuery, id),
    submittedRequestRef: observed(submittedRequestRef, id),
    resultsRequestRef: observed(resultsRequestRef, id),
    request: requestState,
    display: options.display ?? 'current',
    access: options.access ?? 'available',
    collection: {
      ref: bindings.collectionRef,
      scopeRef: bindings.resultScopeRef,
      requestRef: observed(options.collectionRequestRef ?? submittedRequestRef, id),
      batch: observed(batch, id),
      items,
    },
    rangeExpansion: {
      actionMechanicalEffect: options.actionMechanicalEffect ?? 'not_attempted',
      atGeometryBoundary: options.geometry === undefined
        ? unknown('not_measured')
        : observed(options.geometry, id),
      requestState: rangeRequestState,
      hasMore: rangeHasMore,
      collectionTerminal: options.collectionTerminal
        ?? (requestState === 'settled' && hasMore === false),
    },
    evidence: [{id, source: 'browser-stage1-semantics-test', fact: {}}],
  };
}

function stateFor(observation, options = {}) {
  return {
    observation,
    checkedObservationId: options.checkedObservationId === undefined
      ? observation.observationId
      : options.checkedObservationId,
    submissionBaseline: options.submissionBaseline === undefined
      ? {
          submittedRequestRef: 'request-old',
          resultsRequestRef: 'request-old',
          batchRef: 'batch-old',
          observedSubmission: true,
        }
      : options.submissionBaseline,
  };
}

function goal(phase = 'results') {
  return {
    kind: 'BrowserSearch',
    query: '露营',
    collectionRef: 'main',
    containsText: '装备',
    minimumMatches: 1,
    coverage: 'visible_batch',
    phase,
  };
}

function zeros(rows, columns) {
  return Array.from({length: rows}, () => Array(columns).fill(0));
}

function forcedStepProfile(head) {
  const rows = zeros(6, 18);
  const index = ['input', 'submit', 'read_or_reobserve', 'expand_range', 'NOOP', 'DEFER'].indexOf(head);
  assert.notEqual(index, -1, `unknown step head ${head}`);
  rows[index][0] = 10;
  return createBrowserStepPolicyProfile(rows);
}

function decisionBinding(options = {}) {
  return {
    id: 'browser.search.test-model.v1',
    source: 'model',
    stepPolicyProfile: options.stepPolicyProfile ?? forcedStepProfile('NOOP'),
    ...(options.inputPolicyProfile === undefined ? {} : {inputPolicyProfile: options.inputPolicyProfile}),
    ...(options.queryRelationProfile === undefined ? {} : {queryRelationProfile: options.queryRelationProfile}),
    select: options.select ?? (() => {
      throw new Error('model decision must not call decision.select');
    }),
  };
}

function episodeResources(observation, options = {}) {
  const calls = {
    input: 0,
    submit: 0,
    expand: 0,
    read: 0,
    observe: 0,
    control: 0,
  };
  let control = observation;
  const resources = {
    grantedEffects: new Set(options.grantedEffects ?? ALL_EFFECTS),
    decision: options.decision ?? decisionBinding(),
    observe: async () => {
      calls.observe += 1;
      return observation;
    },
    readResults: async () => {
      calls.read += 1;
      return options.readObservation ?? observation;
    },
    currentControl: () => {
      calls.control += 1;
      if (options.controlSequence !== undefined) {
        const next = options.controlSequence[calls.control - 1];
        if (next !== undefined) control = next;
      }
      return control;
    },
    nativeInputText: async () => {
      calls.input += 1;
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    nativeSubmit: async () => {
      calls.submit += 1;
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    ...(options.nativeExpandRange === null ? {} : {
      nativeExpandRange: async () => {
        calls.expand += 1;
        return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
      },
    }),
    collect: async () => {},
  };
  return {resources, calls};
}

async function runEpisode(observation, options = {}) {
  const fixture = episodeResources(observation, options);
  const episode = await runBrowserSearchEpisode({
    goal: options.goal ?? goal(),
    bindings,
    maxResultReads: 2,
    submissionBaseline: options.submissionBaseline === undefined
      ? stateFor(observation, options).submissionBaseline
      : options.submissionBaseline,
    checkedObservationId: options.checkedObservationId === undefined
      ? observation.observationId
      : options.checkedObservationId,
    ...(options.checkedObservation === undefined ? {} : {checkedObservation: options.checkedObservation}),
    ...(options.grantedEffects === undefined ? {} : {grantedEffects: options.grantedEffects}),
    ...(options.expectedSkillAction === undefined ? {} : {expectedSkillAction: options.expectedSkillAction}),
  }, fixture.resources);
  return {episode, calls: fixture.calls};
}

test('model decision resolver is the exported single inference owner', () => {
  assert.equal(typeof resolveBrowserSearchDecision, 'function');
});

test('input and submitted NOOP preserve legitimate satisfaction and reject wrong states', async () => {
  for (const variant of [
    {phase: 'input', expected: 'satisfied', options: {inputValue: '露营', checkedObservationId: null}},
    {phase: 'input', expected: 'unsatisfied', options: {inputValue: '登山', checkedObservationId: null}},
    {phase: 'submitted', expected: 'satisfied', options: {submittedQuery: '露营', checkedObservationId: null}},
    {phase: 'submitted', expected: 'unsatisfied', options: {submittedQuery: '登山', checkedObservationId: null}},
  ]) {
    const observation = makeObservation({...variant.options, withTarget: variant.phase === 'input'});
    const result = await runEpisode(observation, {
      ...variant.options,
      goal: goal(variant.phase),
      expectedSkillAction: variant.phase === 'input' ? 'input' : 'submit',
    });
    assert.equal(result.episode.decision.step.head, 'NOOP');
    assert.equal(result.episode.dispatchState, 'not_dispatched');
    assert.equal(result.episode.effectKnowledge, 'none');
    assert.equal(result.calls.input + result.calls.submit + result.calls.expand + result.calls.read, 0);
    assert.ok(result.episode.state);
    assert.equal(
      searchPhaseFact(
        goal(variant.phase),
        result.episode.state.observation,
        result.episode.state.checkedObservationId,
        result.episode.submissionBaseline,
      ),
      variant.expected,
    );
  }
});

test('stale control, stale skill, wrong phase, denied grant, and missing capability never dispatch', async () => {
  const inputObservation = makeObservation({inputValue: '露营', withTarget: true});

  const staleControl = await runEpisode(inputObservation, {
    goal: goal('input'),
    expectedSkillAction: 'input',
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('input')}),
    controlSequence: [
      inputObservation,
      {...inputObservation, observationId: 'stale-control', revision: 3},
    ],
  });
  assert.equal(staleControl.episode.executionErrors.some(error => error.code === 'stale_reference'), true);
  assert.equal(staleControl.calls.input, 0);

  const staleSkill = await runEpisode(makeObservation({geometry: true}), {
    expectedSkillAction: 'expand_range',
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('NOOP')}),
  });
  assert.equal(staleSkill.episode.executionErrors.some(error => error.code === 'stale_skill_selection'), true);
  assert.equal(staleSkill.episode.dispatchState, 'not_dispatched');
  assert.equal(staleSkill.calls.expand + staleSkill.calls.read, 0);

  const wrongPhase = await runEpisode(inputObservation, {
    goal: goal('input'),
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('expand_range')}),
  });
  assert.equal(wrongPhase.episode.executionErrors.some(error => error.code === 'wrong_phase_action'), true);
  assert.equal(wrongPhase.episode.dispatchState, 'not_dispatched');
  assert.equal(wrongPhase.calls.input + wrongPhase.calls.expand, 0);

  const deniedGrant = await runEpisode(makeObservation({hasMore: true, geometry: false}), {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
    expectedSkillAction: 'expand_range',
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('expand_range')}),
  });
  assert.equal(deniedGrant.episode.executionErrors.some(error => error.code === 'permission_denied'), true);
  assert.equal(deniedGrant.episode.dispatchState, 'not_dispatched');
  assert.equal(deniedGrant.calls.expand, 0);

  const missingCapability = await runEpisode(makeObservation({hasMore: true, geometry: false}), {
    expectedSkillAction: 'expand_range',
    nativeExpandRange: null,
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('expand_range')}),
  });
  assert.equal(
    missingCapability.episode.executionErrors.some(error => error.code === 'capability_missing'),
    true,
  );
  assert.equal(missingCapability.episode.dispatchState, 'not_dispatched');
});

test('actual input and queryRelation predictions reach the step policy unchanged', async () => {
  const inputWeights = zeros(3, 13);
  inputWeights[0][0] = 4;
  inputWeights[1][0] = 0;
  inputWeights[2][0] = 1;
  const inputProfile = createBrowserInputPolicyProfile(inputWeights);
  const inputObservation = makeObservation({withTarget: true});
  const expectedInput = predictBrowserInputPolicy(inputObservation, '露营', false, inputProfile);
  const inputResult = await runEpisode(inputObservation, {
    goal: goal('input'),
    expectedSkillAction: 'input',
    decision: decisionBinding({
      inputPolicyProfile: inputProfile,
      stepPolicyProfile: forcedStepProfile('NOOP'),
    }),
  });
  assert.deepEqual(inputResult.episode.decision.input, expectedInput);
  assert.equal(
    inputResult.episode.decision.step.features[4 + BROWSER_INPUT_POLICY_HEADS.indexOf(expectedInput.head)],
    1,
  );

  const relationWeights = zeros(4, 14);
  relationWeights[2][0] = 6;
  const relationProfile = createBrowserQueryRelationProfile(relationWeights);
  const relationObservation = makeObservation({
    requestState: 'settled',
    rangeExpansion: {requestState: 'settled'},
  });
  const expectedRelation = predictBrowserQueryRelation(
    stateFor(relationObservation),
    goal('submitted'),
    relationProfile,
  );
  const relationResult = await runEpisode(relationObservation, {
    goal: goal('submitted'),
    expectedSkillAction: 'submit',
    checkedObservationId: null,
    decision: decisionBinding({
      queryRelationProfile: relationProfile,
      stepPolicyProfile: forcedStepProfile('NOOP'),
    }),
  });
  assert.deepEqual(relationResult.episode.decision.queryRelation, expectedRelation);
  assert.equal(
    relationResult.episode.decision.step.features[7 + BROWSER_QUERY_RELATION_HEADS.indexOf(expectedRelation.head)],
    1,
  );
});

test('checked terminal NOOP preserves state without readResults and unread NOOP cannot satisfy', async () => {
  const terminal = makeObservation({geometry: false, hasMore: false, itemText: '露营装备清单'});
  const checked = await runEpisode(terminal, {
    expectedSkillAction: 'noop',
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('NOOP')}),
  });
  assert.equal(checked.calls.read, 0);
  assert.equal(checked.episode.dispatchState, 'not_dispatched');
  assert.ok(checked.episode.state);
  assert.equal(checked.episode.state.checkedObservationId, terminal.observationId);
  assert.equal(
    searchPhaseFact(goal(), checked.episode.state.observation,
      checked.episode.state.checkedObservationId, checked.episode.submissionBaseline),
    'satisfied',
  );

  const unread = await runEpisode(terminal, {
    checkedObservationId: null,
    expectedSkillAction: 'noop',
    decision: decisionBinding({stepPolicyProfile: forcedStepProfile('NOOP')}),
  });
  assert.equal(unread.calls.read, 0);
  assert.ok(unread.episode.state);
  assert.equal(unread.episode.state.checkedObservationId, null);
  assert.equal(
    searchPhaseFact(goal(), unread.episode.state.observation,
      unread.episode.state.checkedObservationId, unread.episode.submissionBaseline),
    'unknown',
  );
});

test('terminal positive fact without geometric bottom predicts NOOP and does not expand', async () => {
  const terminal = makeObservation({geometry: false, hasMore: false, itemText: '露营装备清单'});
  const stepWeights = zeros(6, 18);
  stepWeights[3][3] = 1;
  stepWeights[3][14] = 1;
  stepWeights[3][16] = -1;
  stepWeights[4][3] = 1;
  stepWeights[4][16] = 1;
  stepWeights[5][0] = 1;
  const relationWeights = zeros(4, 14);
  relationWeights[2][0] = 10;
  const result = await runEpisode(terminal, {
    expectedSkillAction: 'noop',
    decision: decisionBinding({
      queryRelationProfile: createBrowserQueryRelationProfile(relationWeights),
      stepPolicyProfile: createBrowserStepPolicyProfile(stepWeights),
    }),
  });
  assert.equal(result.episode.decision.step.head, 'NOOP');
  assert.equal(result.calls.expand, 0);
});

test('checked-batch identity uses positive facts and never short-circuits on observationId', () => {
  const checked = makeObservation({observationId: 'checked'});
  const current = makeObservation({observationId: 'current', revision: 3});
  assert.equal(isSameCheckedResultBatch(checked, current, goal()), true);

  const sameIdChangedBatch = {
    ...checked,
    collection: {...checked.collection, batch: observed('batch-2', checked.evidence[0].id)},
  };
  assert.equal(isSameCheckedResultBatch(checked, sameIdChangedBatch, goal()), false);

  const unknownText = {
    ...current,
    collection: {
      ...current.collection,
      items: [{
        ...current.collection.items[0],
        text: unknown('not_read'),
      }],
    },
  };
  assert.equal(isSameCheckedResultBatch(checked, unknownText, goal()), false);
});

test('measureProgress counts only satisfaction or a newly checked batch', () => {
  const before = stateFor(makeObservation({observationId: 'batch-one'}), {
    checkedObservationId: 'batch-one',
  });
  const afterSameBatch = stateFor(makeObservation({
    observationId: 'batch-one-revision',
    revision: 9,
    batch: 'batch-1',
  }), {
    checkedObservationId: 'batch-one-revision',
  });
  const evaluation = {
    evaluatorId: 'browser.search.fact.v1',
    result: 'unsatisfied',
    satisfaction: 0,
    necessaryConditionsMet: true,
    evidenceRefs: [],
  };
  assert.deepEqual(measureBrowserSearchProgress({
    goal: goal(),
    before,
    after: afterSameBatch,
    previousEvaluation: evaluation,
    currentEvaluation: evaluation,
  }), {improved: false, reason: 'none', comparable: true});

  const afterChecked = stateFor(makeObservation({
    observationId: 'batch-one-read',
    revision: 3,
  }), {
    checkedObservationId: 'batch-one-read',
  });
  assert.equal(measureBrowserSearchProgress({
    goal: goal(),
    before: stateFor(before.observation, {checkedObservationId: null}),
    after: afterChecked,
    previousEvaluation: evaluation,
    currentEvaluation: evaluation,
  }).improved, true);
});

test('range effect classification keeps changed batches, missing post facts, and no-effect distinct', () => {
  assert.deepEqual(classifyRangeEffect(
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'settled'},
    {scrollTop: 0, batch: 'batch-2', requestStatus: 'loading'},
  ), {
    hasMechanicalEffect: true,
    factsComplete: true,
    rangeEffect: 'displaced_or_triggered',
    effectKnowledge: 'known',
  });

  assert.deepEqual(classifyRangeEffect(
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'settled'},
    {scrollTop: 0, batch: null, requestStatus: null},
  ), {
    hasMechanicalEffect: false,
    factsComplete: false,
    rangeEffect: 'not_attempted',
    effectKnowledge: 'unknown',
  });

  assert.deepEqual(classifyRangeEffect(
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'settled'},
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'settled'},
  ), {
    hasMechanicalEffect: false,
    factsComplete: true,
    rangeEffect: 'no_change',
    effectKnowledge: 'none',
  });

  assert.deepEqual(classifyRangeEffect(
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'loading'},
    {scrollTop: 0, batch: 'batch-1', requestStatus: 'loading'},
  ), {
    hasMechanicalEffect: false,
    factsComplete: true,
    rangeEffect: 'no_change',
    effectKnowledge: 'none',
  });
});

test('loading and unknown terminal evidence stay incomplete while positive terminal ignores geometry', () => {
  const loading = readBrowserSearchObservation(makeObservation({
    requestState: 'loading',
    display: 'partial',
    geometry: true,
    hasMore: false,
  }));
  assert.equal(loading.rangeExpansion.collectionTerminal, false);
  assert.equal(searchPhaseFact(goal(), loading, loading.observationId), 'unknown');

  const unknownTerminal = readBrowserSearchObservation(makeObservation({
    requestState: 'settled',
    geometry: true,
    hasMore: 'unknown',
  }));
  assert.equal(unknownTerminal.rangeExpansion.collectionTerminal, false);

  const positiveNonBottom = readBrowserSearchObservation(makeObservation({
    requestState: 'settled',
    geometry: false,
    hasMore: false,
    itemText: '露营装备清单',
  }));
  assert.equal(positiveNonBottom.rangeExpansion.collectionTerminal, true);
  assert.equal(searchPhaseFact(goal(), positiveNonBottom, positiveNonBottom.observationId, {
    submittedRequestRef: 'request-old',
    resultsRequestRef: 'request-old',
    batchRef: 'batch-old',
    observedSubmission: true,
  }), 'satisfied');
});

test('public recursive search runs submit, read, expand, second read, then terminal NOOP', async () => {
  const modelInput = zeros(3, 13);
  modelInput[1][0] = 1;
  const inputProfile = createBrowserInputPolicyProfile(modelInput);
  const relationWeights = [
    [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const stepWeights = [
    [-5, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-5, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-5, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 4],
    [-5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, -4, 0, 4, -4, 0],
    [-5, 4, 4, -2, 0, 4, 0, 0, 4, 4, 0, 0, 0, 6, 0, 0, 6, 0],
    [1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0],
  ];
  const decision = decisionBinding({
    inputPolicyProfile: inputProfile,
    queryRelationProfile: createBrowserQueryRelationProfile(relationWeights),
    stepPolicyProfile: createBrowserStepPolicyProfile(stepWeights),
  });

  let revision = 0;
  let stage = 'initial';
  let latest = null;
  let readResultsCalls = 0;
  let expandCalls = 0;
  let submitCalls = 0;
  const observations = [];
  const trajectoryObservation = () => {
    revision += 1;
    const afterSubmit = stage === 'after-submit';
    const afterExpand = stage === 'after-expand';
    const observation = makeObservation({
      observationId: `trajectory-${revision}`,
      revision,
      inputValue: '露营',
      submittedQuery: stage === 'initial' ? '旧查询' : '露营',
      submittedRequestRef: stage === 'initial' ? 'request-old' : 'request-new',
      resultsRequestRef: stage === 'initial' ? 'request-old' : 'request-new',
      batch: stage === 'initial' ? 'batch-old' : afterExpand ? 'batch-2' : 'batch-1',
      requestState: stage === 'initial' ? 'unknown' : 'settled',
      display: stage === 'initial' ? 'old' : 'current',
      geometry: afterExpand,
      hasMore: afterSubmit,
      itemText: afterExpand ? '无关第二批' : '无关第一批',
    });
    latest = observation;
    observations.push(observation);
    return observation;
  };
  const resources = {
    grantedEffects: new Set(ALL_EFFECTS),
    decision,
    observe: async () => trajectoryObservation(),
    readResults: async () => {
      readResultsCalls += 1;
      return trajectoryObservation();
    },
    currentControl: () => latest,
    nativeInputText: async () => {
      throw new Error('input already satisfied');
    },
    nativeSubmit: async () => {
      submitCalls += 1;
      stage = 'after-submit';
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    nativeExpandRange: async () => {
      expandCalls += 1;
      stage = 'after-expand';
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    collect: async () => {},
    collectRoot: async () => {},
  };
  const response = await runBrowserSearchGoal({
    requestId: 'browser-stage1-trajectory',
    goal: {
      kind: 'BrowserSearch',
      query: '露营',
      collectionRef: 'main',
      containsText: '装备',
      minimumMatches: 1,
      coverage: 'visible_batch',
    },
    satisfactionThreshold: 100,
    bindings,
    maxResultReads: 2,
  }, resources);
  assert.equal(response.kind, 'run_result');
  const episodes = response.report.atomicResults
    .map(result => result.sourceResult?.value)
    .filter(Boolean);
  assert.deepEqual(
    episodes.map(episode => episode.decision?.step?.head ?? episode.action),
    ['submit', 'read_or_reobserve', 'expand_range', 'read_or_reobserve', 'NOOP'],
  );
  assert.equal(submitCalls, 1);
  assert.equal(expandCalls, 1);
  assert.equal(readResultsCalls, 2);
  assert.equal(response.report.rootEvaluation.result, 'unsatisfied');
  assert.equal(episodes.at(-1).dispatchState, 'not_dispatched');
  assert.equal(episodes.at(-1).state.checkedObservationId, episodes.at(-1).state.observation.observationId);
});

test('recursive condition scope denial stops the expand skill at dispatch', async () => {
  const modelInput = zeros(3, 13);
  modelInput[1][0] = 1;
  const relationWeights = [
    [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const stepWeights = [
    [-5, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-5, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-5, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 4],
    [-5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, -4, 0, 4, -4, 0],
    [-5, 4, 4, -2, 0, 4, 0, 0, 4, 4, 0, 0, 0, 6, 0, 0, 6, 0],
    [1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0],
  ];
  const decision = decisionBinding({
    inputPolicyProfile: createBrowserInputPolicyProfile(modelInput),
    queryRelationProfile: createBrowserQueryRelationProfile(relationWeights),
    stepPolicyProfile: createBrowserStepPolicyProfile(stepWeights),
  });
  let revision = 0;
  let stage = 'initial';
  let latest = null;
  let expandCalls = 0;
  const trajectoryObservation = () => {
    revision += 1;
    const afterSubmit = stage === 'after-submit';
    const observation = makeObservation({
      observationId: `denied-${revision}`,
      revision,
      inputValue: '露营',
      submittedQuery: stage === 'initial' ? '旧查询' : '露营',
      submittedRequestRef: stage === 'initial' ? 'request-old' : 'request-new',
      resultsRequestRef: stage === 'initial' ? 'request-old' : 'request-new',
      batch: stage === 'initial' ? 'batch-old' : 'batch-1',
      requestState: stage === 'initial' ? 'unknown' : 'settled',
      display: stage === 'initial' ? 'old' : 'current',
      geometry: false,
      hasMore: afterSubmit,
      itemText: '无关内容',
    });
    latest = observation;
    return observation;
  };
  const resources = {
    grantedEffects: new Set([
      'browser.read',
      'browser.nativeInputText',
      'browser.nativeSubmit',
      'filesystem.write',
    ]),
    decision,
    observe: async () => trajectoryObservation(),
    readResults: async () => trajectoryObservation(),
    currentControl: () => latest,
    nativeInputText: async () => {
      throw new Error('input already satisfied');
    },
    nativeSubmit: async () => {
      stage = 'after-submit';
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    nativeExpandRange: async () => {
      expandCalls += 1;
      return {dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null};
    },
    collect: async () => {},
    collectRoot: async () => {},
  };
  const response = await runBrowserSearchGoal({
    requestId: 'browser-stage1-denied-expand',
    goal: {
      kind: 'BrowserSearch',
      query: '露营',
      collectionRef: 'main',
      containsText: '装备',
      minimumMatches: 1,
      coverage: 'visible_batch',
    },
    satisfactionThreshold: 100,
    bindings,
    maxResultReads: 2,
  }, resources);
  assert.equal(response.kind, 'run_result');
  const denied = response.report.errors.find(error => error.code === 'effect_denied');
  assert.ok(denied, JSON.stringify(response.report.errors.map(error => ({
    code: error.code,
    stage: error.stage,
    origin: error.origin,
  }))));
  assert.equal(denied.stage, 'dispatch');
  assert.equal(denied.origin.skillId, 'browser.search.results.expand');
  assert.equal(expandCalls, 0);
});

test('native expansion reads the scroll box and request-state element instead of collection identity', async () => {
  const source = await readFile(
    new URL('../playground/browser/search/native-io.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /querySelector\('#result-scroll-box'\)/);
  assert.match(source, /config\.selectors\?\.requestState \?\? '#request-state'/);
  assert.match(source, /config\.selectors\?\.collection \?\? '#catalog-table, #split-main-list'/);
  const observation = buildObservation({
    documentRef: bindings.documentRef,
    scopeRef: bindings.scopeRef,
    inputRef: bindings.inputRef,
    submitRef: bindings.submitRef,
    collectionRef: bindings.collectionRef,
    resultScopeRef: bindings.resultScopeRef,
    inputTag: 'input',
    inputType: 'text',
    inputValue: '露营',
    editable: true,
    submittedQuery: '露营',
    resultsQuery: '露营',
    submittedRequestRef: 'request-new',
    resultsRequestRef: 'request-new',
    collectionRequestRef: 'request-new',
    batch: 'batch-2',
    request: 'settled',
    display: 'current',
    access: 'available',
    atGeometryBoundary: false,
    hasMore: false,
    items: [{text: '露营装备清单'}],
    target: null,
  }, 7, 'displaced_or_triggered');
  const parsed = readBrowserSearchObservation(observation);
  assert.equal(parsed.collection.ref, 'main');
  assert.equal(parsed.collection.batch.value, 'batch-2');
  assert.equal(parsed.rangeExpansion.collectionTerminal, true);
});

test('Phase A research-prep dataset builder validates 80 train + 32 dev episodes with zero renderer overlap and zero feature-label collisions', async () => {
  const {
    buildBrowserStage1Dataset,
    validateBrowserStage1Dataset,
  } = await import('../dist/training/browser-stage1-samples.js');
  const dataset = buildBrowserStage1Dataset();
  const report = validateBrowserStage1Dataset(dataset);
  assert.equal(report.ok, true);
  assert.equal(report.counts.trainEpisodes, 80);
  assert.equal(report.counts.developmentEpisodes, 32);
  assert.equal(report.counts.totalEpisodes, 112);
  assert.equal(report.counts.inputPolicy.train, 80);
  assert.equal(report.counts.inputPolicy.development, 32);
  assert.equal(report.counts.queryRelation.train, 120);
  assert.equal(report.counts.queryRelation.development, 48);
  assert.equal(report.counts.stepPolicy.train, 120);
  assert.equal(report.counts.stepPolicy.development, 48);
  assert.equal(report.rendererIsolation.ok, true);
  assert.equal(report.collisions.inputPolicy.length, 0);
  assert.equal(report.collisions.queryRelation.length, 0);
  assert.equal(report.collisions.stepPolicy.length, 0);
});

test('Phase A 6N6E training workflow executes epochs=0 probe without loading Handwired and preserves fitted=false', async () => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {runBrowserStage1TrainingWorkflow} = await import('../dist/nodes/browser-stage1-training.js');
  const outDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-6n6e-zero-'));
  try {
    const result = await runBrowserStage1TrainingWorkflow({
      outputRoot: outDir,
      epochs: 0,
      learningRate: 0.1,
    });
    assert.equal(result.report.workflowId, 'browser_single_action_training');
    assert.equal(result.report.workflowVersion, '0.1.0.0000');
    assert.equal(result.report.epochs, 0);
    assert.equal(result.report.units['B-S1.1'].fitted, false);
    assert.equal(result.report.units['B-S1.2'].fitted, false);
    assert.equal(result.report.units['B-S1.3'].fitted, false);
    assert.equal(result.report.timing.units['B-S1.1'].completedEpochs, 0);
    assert.equal(result.report.timing.units['B-S1.1'].handwiredLoaded, false);
    assert.equal(result.report.timing.units['B-S1.2'].completedEpochs, 0);
    assert.equal(result.report.timing.units['B-S1.2'].handwiredLoaded, false);
    assert.equal(result.report.timing.units['B-S1.3'].completedEpochs, 0);
    assert.equal(result.report.timing.units['B-S1.3'].handwiredLoaded, false);
  } finally {
    await rm(outDir, {recursive: true, force: true}).catch(() => undefined);
  }
});

test('Phase A F3 independent evaluator dry-run wiring verifies fail-closed loading and r5 expansion evidence rules without consuming F7/F8', async () => {
  const {
    evaluateIndependentCandidate,
    computeIndependentEvaluationOutcome,
  } = await import(
    '../playground/browser/stage1-learning/evaluate-independent-candidate.mjs'
  );
  const dryRun = await evaluateIndependentCandidate({dryRunWiring: true});
  assert.equal(dryRun.mode, 'evaluate-candidate-dry-run-wiring');
  assert.equal(dryRun.status, 'PASS');
  assert.equal(dryRun.candidateEvaluated, false);
  assert.equal(dryRun.oneShotHoldoutConsumed, false);
  assert.equal(dryRun.checks.failClosedLoader, 'PASS');
  assert.equal(dryRun.checks.selectGuardThrowsOnModelMode, 'PASS');
  assert.equal(dryRun.checks.cascadeUsesPredictedHeadsWithoutTeacher, 'PASS');
  assert.equal(dryRun.checks.r5ExpandEvidenceRules, 'PASS');
  assert.equal(dryRun.checks.localSuitePassKeepsFullyVerifiedFalse, 'PASS');

  const passOutcome = computeIndependentEvaluationOutcome({
    hasAnyFailure: false,
    allSyntheticAndConsumerPass: true,
    nativeCdpStatus: 'READY',
    nativeE2eStatus: 'PASS',
  });
  assert.equal(passOutcome.localSuiteStatus, 'PASS');
  assert.equal(passOutcome.localSuitePassed, true);
  assert.equal(passOutcome.overallStatus, 'PASS');
  assert.equal(passOutcome.fullyVerified, false);
  assert.equal(passOutcome.unseenFeatureCapabilityVerified, false);
});

test('Phase A r2 audit fixes: no shuffledLabels in compare, real handwired baseline in priorHandwired, and zero-epoch prep non-acceptance', async () => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {runBrowserStage1TrainingWorkflow} = await import('../dist/nodes/browser-stage1-training.js');
  const outDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-r2-controls-'));
  try {
    const result = await runBrowserStage1TrainingWorkflow({
      outputRoot: outDir,
      epochs: 0,
      learningRate: 0.1,
    });
    assert.equal('shuffledLabels' in result.report.controls, false);
    assert.deepEqual(
      Object.keys(result.report.controls).sort(),
      [
        'B-S1.3_goldUpstreamOracle',
        'B-S1.3_predictedUpstreamCascade',
        'candidateModel',
        'priorHandwired',
        'zeroWeightInit',
      ],
    );
    assert.equal(result.report.controls.priorHandwired.source, 'handwired');
    assert.deepEqual(result.report.controls.priorHandwired.decisionIds, {
      'B-S1.1': 'browser.input.handwired.v1',
      'B-S1.2': 'browser.search.query-relation.handwired.v1',
      'B-S1.3': 'browser.search.step.handwired.v1',
    });
    assert.equal(result.report.controls.priorHandwired.train.inputPolicy.correct, 80);
    assert.equal(result.report.controls.priorHandwired.train.inputPolicy.total, 80);
    assert.equal(result.report.controls.priorHandwired.development.inputPolicy.correct, 32);
    assert.equal(result.report.controls.priorHandwired.development.inputPolicy.total, 32);
    assert.equal(result.report.controls.priorHandwired.train.queryRelation.correct, 120);
    assert.equal(result.report.controls.priorHandwired.development.queryRelation.correct, 48);
    assert.equal(result.report.controls.priorHandwired.train.stepPolicyCascade.correct, 120);
    assert.equal(result.report.controls.priorHandwired.development.stepPolicyCascade.correct, 48);
    assert.equal(result.report.controls.zeroWeightInit.source, 'zero_weights');
    assert.equal(result.report.controls.candidateModel.source, 'learned_candidate');
    assert.notDeepEqual(
      result.report.controls.priorHandwired.train.inputPolicy.correct,
      result.report.controls.zeroWeightInit.train.inputPolicy.correct,
    );
    assert.equal(result.report.assessment.acceptanceStatus, 'NON_ACCEPTANCE_ZERO_EPOCH_PREP');
    assert.equal(result.report.assessment.acceptedForDownstreamEvaluation, false);
    assert.equal(result.report.assessment.downstreamStatus.reloadVerification, 'pending_zero_epoch_probe');
    assert.equal(result.report.assessment.downstreamStatus.independentEvaluation, 'not_run');
    assert.equal(result.report.assessment.downstreamStatus.nativeAcceptance, 'not_run');
  } finally {
    await rm(outDir, {recursive: true, force: true}).catch(() => undefined);
  }
});

test('Phase A r2 audit fixes: 100% train/dev gate and per-row reload parity reject failed candidates while preserving candidate and report on disk', async () => {
  const {mkdtemp, readFile: readFsFile, rm, stat, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {assessBrowserStage1TrainingReport, runBrowserStage1TrainingWorkflow} = await import(
    '../dist/nodes/browser-stage1-training.js'
  );
  const {comparePerRowPredictions} = await import('../playground/browser/stage1-learning/reload.mjs');
  const {finalizeFormalStage1TrainingRun} = await import('../playground/browser/stage1-learning/train.mjs');

  const outDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-r2-gates-'));
  try {
    const baseResult = await runBrowserStage1TrainingWorkflow({
      outputRoot: outDir,
      epochs: 0,
      learningRate: 0.1,
    });

    const swappedPredictions = baseResult.report.units['B-S1.1'].train.predictions.map(row => ({...row}));
    const actualPredictions = baseResult.report.units['B-S1.1'].train.predictions.map(row => ({...row}));
    swappedPredictions[0].predictedHead = 'input';
    swappedPredictions[0].correct = swappedPredictions[0].predictedHead === swappedPredictions[0].goldHead;
    swappedPredictions[1].predictedHead = 'DEFER';
    swappedPredictions[1].correct = swappedPredictions[1].predictedHead === swappedPredictions[1].goldHead;
    assert.equal(comparePerRowPredictions(actualPredictions, actualPredictions), true);
    assert.equal(comparePerRowPredictions(actualPredictions, swappedPredictions), false);

    const syntheticFailedReport = structuredClone(baseResult.report);
    syntheticFailedReport.epochs = 200;
    for (const unitId of ['B-S1.1', 'B-S1.2', 'B-S1.3']) {
      syntheticFailedReport.units[unitId].fitted = true;
      syntheticFailedReport.units[unitId].train.correct = syntheticFailedReport.units[unitId].train.total;
      syntheticFailedReport.units[unitId].train.accuracy = 1;
      syntheticFailedReport.units[unitId].development.correct = syntheticFailedReport.units[unitId].development.total;
      syntheticFailedReport.units[unitId].development.accuracy = 1;
    }
    syntheticFailedReport.units['B-S1.3'].development.correct = 47;
    syntheticFailedReport.units['B-S1.3'].development.accuracy = 47 / 48;
    syntheticFailedReport.assessment = assessBrowserStage1TrainingReport(syntheticFailedReport);
    assert.equal(syntheticFailedReport.assessment.trainDev100PercentPassed, false);
    assert.equal(syntheticFailedReport.assessment.acceptanceStatus, 'REJECTED_TRAIN_DEV_GATE_FAILED');
    assert.deepEqual(syntheticFailedReport.assessment.failedUnits, ['B-S1.3']);

    await assert.rejects(
      () => finalizeFormalStage1TrainingRun({
        outputRoot: outDir,
        bundle: {
          ...baseResult,
          report: syntheticFailedReport,
        },
      }),
      error => error?.code === 'STAGE1_TRAIN_DEV_GATE_FAILED',
    );
    const preservedReport = JSON.parse(await readFsFile(baseResult.artifactPaths.reportPath, 'utf8'));
    assert.equal(preservedReport.assessment.acceptanceStatus, 'REJECTED_TRAIN_DEV_GATE_FAILED');
    assert.equal(preservedReport.assessment.downstreamStatus.reloadVerification, 'not_run');
    assert.equal(preservedReport.assessment.downstreamStatus.independentEvaluation, 'not_run');
    assert.equal(preservedReport.assessment.downstreamStatus.nativeAcceptance, 'not_run');
    for (const filePath of Object.values(baseResult.artifactPaths)) {
      const fileStat = await stat(filePath);
      assert.ok(fileStat.size > 0);
    }

    const syntheticPassTrainDevReport = structuredClone(baseResult.report);
    syntheticPassTrainDevReport.epochs = 200;
    for (const unitId of ['B-S1.1', 'B-S1.2', 'B-S1.3']) {
      syntheticPassTrainDevReport.units[unitId].fitted = true;
      syntheticPassTrainDevReport.units[unitId].train.correct =
        syntheticPassTrainDevReport.units[unitId].train.total;
      syntheticPassTrainDevReport.units[unitId].train.accuracy = 1;
      syntheticPassTrainDevReport.units[unitId].development.correct =
        syntheticPassTrainDevReport.units[unitId].development.total;
      syntheticPassTrainDevReport.units[unitId].development.accuracy = 1;
    }
    syntheticPassTrainDevReport.units['B-S1.1'].train.predictions[0].predictedHead = 'DEFER';
    syntheticPassTrainDevReport.assessment = assessBrowserStage1TrainingReport(syntheticPassTrainDevReport);
    await writeFile(baseResult.artifactPaths.reportPath, `${JSON.stringify(syntheticPassTrainDevReport, null, 2)}\n`, 'utf8');

    await assert.rejects(
      () => finalizeFormalStage1TrainingRun({
        outputRoot: outDir,
        bundle: {
          ...baseResult,
          report: syntheticPassTrainDevReport,
        },
      }),
      error => error?.code === 'STAGE1_RELOAD_PARITY_GATE_FAILED',
    );
    const parityRejectedReport = JSON.parse(await readFsFile(baseResult.artifactPaths.reportPath, 'utf8'));
    assert.equal(parityRejectedReport.assessment.acceptanceStatus, 'REJECTED_RELOAD_PARITY_FAILED');
    assert.equal(parityRejectedReport.assessment.downstreamStatus.reloadVerification, 'failed');
    assert.equal(parityRejectedReport.assessment.downstreamStatus.independentEvaluation, 'not_run');
    assert.equal(parityRejectedReport.assessment.downstreamStatus.nativeAcceptance, 'not_run');
  } finally {
    await rm(outDir, {recursive: true, force: true}).catch(() => undefined);
  }
});

test('Phase A r2 audit fixes: parseTrainCliArgs enforces explicit formal recipe without defaults', async () => {
  const {parseTrainCliArgs} = await import('../playground/browser/stage1-learning/train.mjs');

  assert.deepEqual(
    parseTrainCliArgs(['--mode', 'validate-only', '--output-root', '/tmp/stage1-validate']),
    {
      mode: 'validate-only',
      handwiredRoot: '',
      epochs: 0,
      learningRate: 0,
      outputRoot: '/tmp/stage1-validate',
    },
  );
  assert.deepEqual(
    parseTrainCliArgs([
      '--mode', 'train',
      '--handwired-root', '/Volumes/extension/code/handwired',
      '--epochs', '200',
      '--learning-rate', '0.1',
      '--output-root', '/tmp/stage1-train',
    ]),
    {
      mode: 'train',
      handwiredRoot: '/Volumes/extension/code/handwired',
      epochs: 200,
      learningRate: 0.1,
      outputRoot: '/tmp/stage1-train',
    },
  );

  for (const invalidArgv of [
    [],
    ['--mode', 'validate-only'],
    ['--mode', 'validate-only', '--output-root', '/tmp/out', '--handwired-root', '/Volumes/extension/code/handwired'],
    ['--mode', 'validate-only', '--output-root', '/tmp/out', '--epochs', '200'],
    ['--mode', 'train', '--output-root', '/tmp/out'],
    ['--mode', 'train', '--handwired-root', '/Volumes/extension/code/handwired', '--output-root', '/tmp/out'],
    ['--mode', 'train', '--handwired-root', '/Volumes/extension/code/handwired', '--epochs', '40', '--learning-rate', '0.1', '--output-root', '/tmp/out'],
    ['--mode', 'train', '--handwired-root', '/Volumes/extension/code/handwired', '--epochs', '200', '--learning-rate', '0.05', '--output-root', '/tmp/out'],
    ['--mode', 'train', '--handwired-root', '/Volumes/extension/code/handwired', '--epochs', '200', '--learning-rate', '0.1', '--output-root', '/tmp/out', '--unknown-flag', '1'],
  ]) {
    assert.throws(() => parseTrainCliArgs(invalidArgv), TypeError);
  }
});


