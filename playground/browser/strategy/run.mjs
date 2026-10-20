import { pathToFileURL } from 'node:url';

import {
  BROWSER_STRATEGY_EVALUATOR_ID,
  BROWSER_STRATEGY_SELECTOR_ID,
  createBrowserStrategyInitialObservation,
  createZeroBrowserStrategyProfile,
  runBrowserStrategyGoal,
  validateBrowserStrategyProfile,
} from 'nnanything/browser-strategy';
import {
  createZeroBrowserSingleActionProfile,
  validateBrowserSingleActionProfile,
} from 'nnanything/browser-single-action';
import {
  createZeroFeedbackProfile,
  validateFeedbackProfile,
} from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';

const NATIVE_SKILL = 'browser.expand.native';
const ROLE_SKILL = 'browser.expand.role';
const REQUEST_SCHEMA = 'nnanything.recursive-goal.request.v1';
const args = parseArgs(process.argv.slice(2), ['--io']);

function observed(value, evidenceRef) {
  return { status: 'observed', value, evidenceRefs: [evidenceRef] };
}

function mockSnapshot({ observationId, revision, expanded = false }) {
  const evidence = [];
  const add = suffix => {
    const id = `${observationId}:${suffix}`;
    evidence.push({ id, observationId, source: 'synthetic.browser_strategy_fixture', fact: { suffix, expanded } });
    return id;
  };
  const scopeEvidence = add('scope');
  const nativeEvidence = add('native');
  const roleEvidence = add('role');
  const regionEvidence = add('region');
  const element = ({ ref, parentRef = 'scope', tag = 'div', role = null, controls, enabled, hit, evidenceRefs, basicKind = 'button' }) => ({
    ref,
    parentRef,
    tag,
    role,
    basicKind,
    judgmentStatus: 'judged',
    candidateStatus: 'ok',
    controls,
    enabled,
    hit,
    buttonSemantics: observed(true, evidenceRefs[0]),
    point: observed({ x: ref === 'native-target' ? 20 : 40, y: 30 }, evidenceRefs[0]),
    evidenceRefs,
  });
  return {
    documentRef: 'document-fixture',
    observationId,
    revision,
    scopeRef: 'scope',
    regions: [{
      ref: 'region-main',
      expanded: observed(expanded, regionEvidence),
      rendered: observed(expanded, regionEvidence),
    }],
    elements: [
      {
        ref: 'scope',
        parentRef: null,
        tag: 'main',
        role: null,
        basicKind: 'container',
        judgmentStatus: 'judged',
        candidateStatus: 'ok',
        controls: observed([], scopeEvidence),
        enabled: { status: 'unknown', reason: 'not_applicable' },
        hit: { status: 'unknown', reason: 'not_applicable' },
        buttonSemantics: observed(false, scopeEvidence),
        point: { status: 'unknown', reason: 'not_applicable' },
        evidenceRefs: [scopeEvidence],
      },
      element({
        ref: 'native-target',
        tag: 'button',
        controls: observed(['region-main'], nativeEvidence),
        enabled: observed(true, nativeEvidence),
        hit: observed(true, nativeEvidence),
        evidenceRefs: [nativeEvidence],
      }),
      element({
        ref: 'role-target',
        role: 'button',
        controls: observed(['region-main'], roleEvidence),
        enabled: observed(true, roleEvidence),
        hit: observed(true, roleEvidence),
        evidenceRefs: [roleEvidence],
      }),
      {
        ref: 'region-main',
        parentRef: 'scope',
        tag: 'section',
        role: 'region',
        basicKind: 'container',
        judgmentStatus: 'judged',
        candidateStatus: 'ok',
        controls: observed([], regionEvidence),
        enabled: { status: 'unknown', reason: 'not_applicable' },
        hit: { status: 'unknown', reason: 'not_applicable' },
        buttonSemantics: observed(false, regionEvidence),
        point: { status: 'unknown', reason: 'not_applicable' },
        evidenceRefs: [regionEvidence],
      },
    ],
    evidence,
  };
}

function registry() {
  return [
    {
      strategyRef: 'strategy-native',
      skillId: NATIVE_SKILL,
      targetRef: 'native-target',
      goalRegionRef: 'region-main',
      equivalenceSetRef: 'same-expansion-effect',
      documentRef: 'document-fixture',
      scopeRef: 'scope',
      operation: 'CLICK',
      evidenceRefs: ['proof:equivalence:native'],
    },
    {
      strategyRef: 'strategy-role',
      skillId: ROLE_SKILL,
      targetRef: 'role-target',
      goalRegionRef: 'region-main',
      equivalenceSetRef: 'same-expansion-effect',
      documentRef: 'document-fixture',
      scopeRef: 'scope',
      operation: 'CLICK',
      evidenceRefs: ['proof:equivalence:role'],
    },
  ];
}

function mockProfiles() {
  const atomicZero = createZeroBrowserSingleActionProfile();
  const relationWeights = atomicZero.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  const capabilityWeights = atomicZero.capabilityWeights.map(row => [...row]);
  const click = atomicZero.capabilityHeads.indexOf('CLICK');
  capabilityWeights[click][atomicZero.capabilityWires.indexOf('bias')] = 2;
  capabilityWeights[click][atomicZero.capabilityWires.indexOf('providers.zero')] = -4;
  capabilityWeights[click][atomicZero.capabilityWires.indexOf('providers.one')] = 4;
  const atomicProfile = validateBrowserSingleActionProfile({
    ...atomicZero,
    relationWeights,
    capabilityWeights,
  });

  const feedbackZero = createZeroFeedbackProfile();
  const feedbackWeights = feedbackZero.weights.map(row => [...row]);
  const feedbackWire = name => feedbackZero.wires.indexOf(name);
  feedbackWeights[0][feedbackWire('post.currentValid')] = 3;
  feedbackWeights[0][feedbackWire('regionExpanded.known')] = 1;
  feedbackWeights[0][feedbackWire('regionRendered.known')] = 1;
  feedbackWeights[0][feedbackWire('regionExpanded.value')] = -2;
  feedbackWeights[0][feedbackWire('regionRendered.value')] = -1;
  feedbackWeights[2][feedbackWire('bias')] = 1;
  const feedbackProfile = validateFeedbackProfile({ ...feedbackZero, weights: feedbackWeights });

  const strategyZero = createZeroBrowserStrategyProfile();
  const strategyWeights = strategyZero.weights.map(row => [...row]);
  const choose = strategyZero.heads.indexOf('choose');
  const strategyWire = name => strategyZero.wires.indexOf(name);
  strategyWeights[choose][strategyWire('nativeButton')] = 4;
  strategyWeights[choose][strategyWire('explicitRoleButton')] = 1;
  strategyWeights[choose][strategyWire('feedback.completedWithoutGoal')] = -1;
  const profile = validateBrowserStrategyProfile({ ...strategyZero, weights: strategyWeights });
  return { profile, atomicProfile, feedbackProfile };
}

function controlOf(snapshot) {
  return {
    documentRef: snapshot.documentRef,
    observationId: snapshot.observationId,
    revision: snapshot.revision,
  };
}

function mockRunInput() {
  const initial = mockSnapshot({ observationId: 'mock-initial', revision: 1 });
  const queue = [
    mockSnapshot({ observationId: 'mock-run1-preflight', revision: 2 }),
    mockSnapshot({ observationId: 'mock-run1-pre', revision: 3 }),
    mockSnapshot({ observationId: 'mock-run1-post', revision: 4 }),
    mockSnapshot({ observationId: 'mock-run2-preflight', revision: 5 }),
    mockSnapshot({ observationId: 'mock-run2-pre', revision: 6 }),
    mockSnapshot({ observationId: 'mock-run2-post', revision: 7 }),
    mockSnapshot({ observationId: 'mock-run3-preflight', revision: 8 }),
    mockSnapshot({ observationId: 'mock-run3-pre', revision: 9 }),
    mockSnapshot({ observationId: 'mock-run3-post', revision: 10, expanded: true }),
  ];
  const clicks = [];
  let current = controlOf(initial);
  const profiles = mockProfiles();
  const resources = {
    ...profiles,
    registry: registry(),
    grantedEffects: new Set(['browser.nativeClick', 'filesystem.write']),
    observe: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('mock observation queue exhausted');
      current = controlOf(next);
      return next;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push({ targetRef: invocation.targetRef, kind: 'synthetic' });
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'known',
        source: 'synthetic.browser_strategy_fixture',
        error: null,
      };
    },
    collectAtomic: async () => {},
    collectStep: async () => {},
    proveNoEffect: input => {
      const post = input.result.newState;
      return post === null ? null : {
        kind: 'controlled_fixture_no_effect',
        targetRef: input.result.invocation.targetRef,
        documentRef: input.request.state.documentRef,
        beforeObservationId: input.request.state.observationId,
        afterObservationId: post.observationId,
        evidenceRefs: [
          ...input.request.state.evidence.map(item => item.id),
          ...post.evidence.map(item => item.id),
        ],
      };
    },
    collectRoot: async () => ({ receiptId: 'mock-root-collection' }),
  };
  const policy = {
    kind: 'bounded_strategy_retry.v1',
    selectorId: BROWSER_STRATEGY_SELECTOR_ID,
    strategySkillIds: [NATIVE_SKILL, ROLE_SKILL],
    sameFailureLimit: 2,
    maxAtomicAttempts: 4,
  };
  return {
    mode: 'mock',
    nativeInput: false,
    source: 'synthetic.browser_strategy_fixture',
    request: {
      schema: REQUEST_SCHEMA,
      requestId: 'browser-strategy-mock-aab',
      rootGoal: { kind: 'SetExpanded', regionRef: 'region-main', desired: true },
      satisfactionThreshold: 100,
      rootBindings: {
        documentRef: 'document-fixture',
        scopeRef: 'scope',
        goalRegionRef: 'region-main',
        equivalenceSetRef: 'same-expansion-effect',
      },
      state: { browser: initial, history: [] },
      rootEvaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
      rootSelectorId: BROWSER_STRATEGY_SELECTOR_ID,
      limits: { maxTransitions: 32, maxDepth: 4, maxDerivedGoals: 4 },
      initialObservation: createBrowserStrategyInitialObservation(
        'mock-initial-state',
        { browser: initial, history: [] },
        'region-main',
      ),
      retryPolicy: policy,
      invocation: { maxAtomicDispatches: 1 },
    },
    resources,
    clicks,
  };
}

async function loadRunInput() {
  const modulePath = args.get('--io');
  if (modulePath === undefined) return mockRunInput();
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createBrowserStrategyRun !== 'function') {
    throw new Error('external IO module must export createBrowserStrategyRun()');
  }
  const input = await module.createBrowserStrategyRun();
  if (input === null || typeof input !== 'object'
    || input.request === undefined || input.resources === undefined) {
    throw new Error('createBrowserStrategyRun() must return { request, resources, mode?, source? }');
  }
  return {
    ...input,
    mode: input.mode ?? 'external',
    source: input.source ?? 'external_io_adapter',
  };
}

function continuationRequest(base, response) {
  const lastState = response.report.states.at(-1);
  if (lastState === undefined || response.report.continuation === null) {
    throw new Error('yielded response is missing continuation data');
  }
  const { initialObservation: _initialObservation, ...rest } = base;
  return {
    ...rest,
    state: lastState.value,
    continuation: response.report.continuation,
  };
}

const run = await loadRunInput();
const maxRuns = run.maxRuns ?? 8;
let request = run.request;
const responses = [];
for (let index = 0; index < maxRuns; index += 1) {
  const response = await runBrowserStrategyGoal(request, run.resources);
  responses.push(response);
  if (response.kind !== 'run_result'
    || response.report.control.outcome !== 'yielded'
    || response.report.continuation === null) {
    break;
  }
  request = continuationRequest(request, response);
}

const summary = responses.map(response => response.kind === 'run_result'
  ? {
      kind: response.kind,
      outcome: response.report.control.outcome,
      stopReason: response.report.control.stopReason,
      rootEvaluation: response.report.rootEvaluation,
      atomicCount: response.report.atomicResults.length,
      effectKnowledge: response.report.effects.map(effect => effect.knowledge),
      errors: response.report.errors.map(error => ({
        code: error.code,
        stage: error.stage,
        message: error.diagnosticMessage,
      })),
      history: response.report.states.at(-1)?.value.history.map(item => item.skillId) ?? [],
      continued: response.report.continuation !== null,
    }
  : {
      kind: response.kind,
      error: response.kind === 'request_rejected' ? response.error : response.fault,
    });

console.log(JSON.stringify({
  consumer: 'browser-strategy-run',
  mode: run.mode,
  nativeInput: run.nativeInput ?? null,
  source: run.source,
  runs: summary,
  clicks: run.clicks?.map(item => item.targetRef) ?? null,
}, null, 2));

const completed = responses.at(-1)?.kind === 'run_result'
  && responses.at(-1).report.control.outcome === 'completed'
  && responses.at(-1).report.rootEvaluation.state === 'evaluated'
  && responses.at(-1).report.rootEvaluation.result === 'satisfied';
if (!completed) process.exitCode = 1;
