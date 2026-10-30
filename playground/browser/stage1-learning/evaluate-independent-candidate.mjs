import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {
  readBrowserInputObservation,
  runBrowserInputEpisode,
} from 'nnanything/browser-input';
import {
  createBrowserInputPolicyProfile,
  createBrowserQueryRelationProfile,
  createBrowserStepPolicyProfile,
  predictBrowserInputPolicy,
  predictBrowserQueryRelation,
  predictBrowserSearchStepPolicy as predictBrowserStepPolicy,
  readBrowserInputPolicyProfile,
  readBrowserQueryRelationProfile,
  readBrowserSearchObservation,
  readBrowserStepPolicyProfile,
  runBrowserSearchEpisode,
  runBrowserSearchGoal,
} from 'nnanything/browser-search';
import {
  EPISODES,
  FAMILIES,
  PROBES,
  VERIFY_PROBE_CHECKS,
  buildObservation,
  buildState,
  startFixtureServer,
} from './verify-independent-cases.mjs';

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function throwingSelectGuard() {
  throw new TypeError('handwired select must not be called when source === "model"');
}

async function readJsonFileFailClosed(filePath, label) {
  let rawText;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new TypeError(
      `Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new TypeError(
      `Invalid JSON in ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadStage1CandidateFromDisk(candidateDir) {
  if (typeof candidateDir !== 'string' || candidateDir.trim().length === 0) {
    throw new TypeError('candidateDir must be a non-empty directory path');
  }
  const resolvedDir = resolve(candidateDir);
  const inputPath = join(resolvedDir, 'input-policy.json');
  const relationPath = join(resolvedDir, 'query-relation.json');
  const stepPath = join(resolvedDir, 'step-policy.json');

  const [rawInput, rawRelation, rawStep] = await Promise.all([
    readJsonFileFailClosed(inputPath, 'input-policy.json'),
    readJsonFileFailClosed(relationPath, 'query-relation.json'),
    readJsonFileFailClosed(stepPath, 'step-policy.json'),
  ]);

  const inputPolicyProfile = readBrowserInputPolicyProfile(rawInput);
  const queryRelationProfile = readBrowserQueryRelationProfile(rawRelation);
  const stepPolicyProfile = readBrowserStepPolicyProfile(rawStep);

  const inputDecision = {
    id: 'browser.input.model.v1',
    source: 'model',
    profile: inputPolicyProfile,
    select: throwingSelectGuard,
  };

  const decision = {
    id: 'browser.search.model.v1',
    source: 'model',
    inputPolicyProfile,
    queryRelationProfile,
    stepPolicyProfile,
    select: throwingSelectGuard,
  };

  return {
    candidateDir: resolvedDir,
    files: {
      inputPolicy: inputPath,
      queryRelation: relationPath,
      stepPolicy: stepPath,
    },
    inputPolicyProfile,
    queryRelationProfile,
    stepPolicyProfile,
    inputDecision,
    decision,
  };
}

function validScrollSnapshot(scroll) {
  return Boolean(
    scroll
      && typeof scroll === 'object'
      && Number.isFinite(scroll.scrollTop)
      && Number.isFinite(scroll.clientHeight)
      && Number.isFinite(scroll.scrollHeight),
  );
}

export function classifyNativeExpandRange(before, after) {
  const factsComplete = Boolean(
    before
      && after
      && validScrollSnapshot(before.scroll)
      && validScrollSnapshot(after.scroll)
      && typeof before.batchRef === 'string'
      && before.batchRef.length > 0
      && typeof after.batchRef === 'string'
      && after.batchRef.length > 0
      && typeof before.requestStatus === 'string'
      && before.requestStatus.length > 0
      && typeof after.requestStatus === 'string'
      && after.requestStatus.length > 0
      && typeof before.collectionId === 'string'
      && before.collectionId.length > 0
      && typeof after.collectionId === 'string'
      && after.collectionId.length > 0,
  );
  if (!factsComplete) {
    return {
      actionMechanicalEffect: null,
      effectKnowledge: 'unknown',
      displaced: false,
      triggeredRequest: false,
      batchAdvanced: false,
      itemCountAdvanced: false,
      factsComplete: false,
    };
  }
  const displaced = after.scroll.scrollTop > before.scroll.scrollTop;
  const triggeredRequest = before.requestStatus !== 'loading' && after.requestStatus === 'loading';
  const batchAdvanced = Boolean(after.batchRef && after.batchRef !== before.batchRef);
  const itemCountAdvanced = Number.isFinite(after.mainItemCount)
    && Number.isFinite(before.mainItemCount)
    && after.mainItemCount > before.mainItemCount;
  const progressed = displaced || triggeredRequest || batchAdvanced || itemCountAdvanced;
  return {
    actionMechanicalEffect: progressed ? 'displaced_or_triggered' : 'no_change',
    effectKnowledge: progressed ? 'known' : 'none',
    displaced,
    triggeredRequest,
    batchAdvanced,
    itemCountAdvanced,
    factsComplete: true,
  };
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

function evaluateCandidateOnState(entry, state, phase, candidate) {
  const goal = goalFor(entry, phase);
  const inputPred = predictBrowserInputPolicy(
    state.inputObservation,
    entry.family.query,
    false,
    candidate.inputPolicyProfile,
  );
  const relationPred = phase === 'input'
    ? null
    : predictBrowserQueryRelation(state, goal, candidate.queryRelationProfile);
  const stepPred = predictBrowserStepPolicy(
    state,
    goal,
    inputPred.head,
    relationPred ? relationPred.head : null,
    candidate.stepPolicyProfile,
  );
  return {
    state,
    goal,
    phase,
    input: {head: inputPred.head, wires: inputPred.features, scores: inputPred.scores},
    relation: relationPred
      ? {head: relationPred.head, wires: relationPred.features, scores: relationPred.scores}
      : null,
    step: {head: stepPred.head, wires: stepPred.features, scores: stepPred.scores},
  };
}

function evaluateCandidateSyntheticRow(entry, row, candidate, phase = row.phase) {
  const fixture = entry.fixtureFor(row.scenario);
  if (row.preludeInput) fixture.input.value = entry.family.query;
  const state = buildState(fixture, entry.family, phase);
  return {...evaluateCandidateOnState(entry, state, phase, candidate), fixture};
}

function collectUnknownFactsFromState(state) {
  const unknowns = [];
  const checkMap = (prefix, record) => {
    if (!record || typeof record !== 'object') return;
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === 'object' && 'status' in value) {
        if (value.status === 'unknown') {
          unknowns.push({fact: `${prefix}.${key}`, reason: value.reason ?? 'unknown'});
        }
      }
    }
  };
  checkMap('inputObservation.target', state.inputObservation?.target);
  checkMap('observation.input', state.observation?.input);
  checkMap('observation', {
    submittedQuery: state.observation?.submittedQuery,
    resultsFor: state.observation?.resultsFor,
    submittedRequestRef: state.observation?.submittedRequestRef,
    resultsRequestRef: state.observation?.resultsRequestRef,
  });
  checkMap('observation.collection', {
    requestRef: state.observation?.collection?.requestRef,
    batch: state.observation?.collection?.batch,
  });
  checkMap('observation.rangeExpansion', {
    atGeometryBoundary: state.observation?.rangeExpansion?.atGeometryBoundary,
    requestState: state.observation?.rangeExpansion?.requestState,
    hasMore: state.observation?.rangeExpansion?.hasMore,
  });
  return unknowns;
}

export function deriveInputConsumerContractOutcome(episode) {
  if (!episode || episode.decisionSource?.source !== 'model') return null;
  if (
    episode.dispatchState === 'dispatched'
    && episode.textWriteCount === 1
    && episode.invocation?.kind === 'input'
    && episode.refusal === null
    && episode.executionErrors.length === 0
    && episode.goalFact === 'satisfied'
    && episode.canContinue === true
  ) {
    return 'INPUT';
  }
  if (
    episode.dispatchState === 'not_dispatched'
    && episode.textWriteCount === 0
    && episode.invocation === null
    && episode.refusal === null
    && episode.executionErrors.length === 0
    && episode.goalFact === 'satisfied'
    && episode.canContinue === true
  ) {
    return 'NOOP';
  }
  if (
    episode.dispatchState === 'not_dispatched'
    && episode.textWriteCount === 0
    && episode.invocation === null
    && episode.refusal !== null
    && episode.canContinue === false
  ) {
    return 'DEFER';
  }
  return null;
}

async function runPublicConsumerEpisodeForRow(entry, row, phase, candidate) {
  const fixture = structuredClone(entry.fixtureFor(row.scenario));
  if (row.preludeInput) fixture.input.value = entry.family.query;
  let revision = 0;
  let control = null;
  let textWrites = 0;
  let submits = 0;
  let expands = 0;
  let reads = 0;

  const observeSearch = async () => {
    revision += 1;
    const built = buildObservation(fixture, entry.family, phase, revision);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: built.search.observationId,
      revision,
    };
    return built.search;
  };

  const initialBuilt = buildObservation(fixture, entry.family, phase, 1);
  const checkedObservationId = phase === 'results' ? initialBuilt.search.observationId : null;
  const submissionBaseline = submissionBaselineFor(fixture, entry.family);

  let inputConsumerEpisode = null;
  if (phase === 'input') {
    let inputRev = 0;
    let inputControl = null;
    inputConsumerEpisode = await runBrowserInputEpisode({
      requestId: `${row.id}:input-consumer`,
      goal: {kind: 'BrowserInput', targetText: entry.family.query},
      satisfactionThreshold: 100,
      bindings: {
        documentRef: entry.family.documentRef,
        scopeRef: entry.family.scopeRef,
        targetRef: entry.family.inputRef,
      },
    }, {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText']),
      decision: candidate.inputDecision,
      observe: async () => {
        inputRev += 1;
        const built = buildObservation(
           structuredClone(entry.fixtureFor(row.scenario)),
          entry.family,
          'input',
          inputRev,
        );
        if (row.preludeInput || textWrites > 0) {
          const updated = structuredClone(entry.fixtureFor(row.scenario));
          updated.input.value = entry.family.query;
          const updatedBuilt = buildObservation(updated, entry.family, 'input', inputRev);
          inputControl = {
            documentRef: entry.family.documentRef,
            scopeRef: entry.family.scopeRef,
            observationId: updatedBuilt.input.observationId,
            revision: inputRev,
          };
          return updatedBuilt.input;
        }
        inputControl = {
          documentRef: entry.family.documentRef,
          scopeRef: entry.family.scopeRef,
          observationId: built.input.observationId,
          revision: inputRev,
        };
        return built.input;
      },
      currentControl: () => inputControl,
      nativeInputText: async (invocation) => {
        textWrites += 1;
        const syntheticFocus = fixture.input.activeElementFocus === true
          ? 'target'
          : fixture.input.activeElementFocus === false
            ? 'other'
            : 'unknown';
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: 'known',
          source: 'evaluate-independent-candidate.synthetic-consumer-input',
          error: null,
          events: [{type: 'insertText', targetRef: entry.family.inputRef, detail: invocation.value}],
          textWriteCount: 1,
          focus: syntheticFocus,
        };
      },
    });
  }

  let searchWrites = 0;
  const searchEpisode = await runBrowserSearchEpisode({
    goal: goalFor(entry, phase),
    bindings: bindingsFor(entry.family),
    maxResultReads: 2,
    submissionBaseline,
    checkedObservationId,
  }, {
    grantedEffects: new Set([
      'browser.read',
      'browser.nativeInputText',
      'browser.nativeSubmit',
      'browser.nativeExpandRange',
      'filesystem.write',
    ]),
    decision: candidate.decision,
    observe: observeSearch,
    readResults: async () => {
      reads += 1;
      return observeSearch();
    },
    currentControl: () => control,
    nativeInputText: async (invocation) => {
      searchWrites += 1;
      fixture.input.value = invocation.value;
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'known',
        source: 'evaluate-independent-candidate.synthetic-search-input',
        error: null,
      };
    },
    nativeSubmit: async () => {
      submits += 1;
      fixture.submitted = {
        query: fixture.input.value,
        requestRef: `${entry.family.id}:synthetic-submitted`,
      };
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'known',
        source: 'evaluate-independent-candidate.synthetic-submit',
        error: null,
      };
    },
    nativeExpandRange: async () => {
      expands += 1;
      fixture.request.range.actionMechanicalEffect = 'displaced_or_triggered';
      fixture.request.batchRef = `${fixture.request.batchRef ?? 'batch-1'}:expanded`;
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: 'known',
        source: 'evaluate-independent-candidate.synthetic-expand',
        error: null,
      };
    },
    collect: async () => {},
  });

  return {
    inputConsumerEpisode,
    searchEpisode,
    counters: {
      inputConsumerWrites: textWrites,
      searchWrites,
      submits,
      expands,
      reads,
    },
  };
}

async function runCandidateBp12ConsumerProbes(entry, candidate) {
  const runInputCase = async ({failAfterAction = false} = {}) => {
    const pack = structuredClone(entry.fixtureFor('probe-bp12'));
    let revision = 0;
    let control = null;
    let nativeWrites = 0;
    const submitCount = 0;
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
    const episode = await runBrowserInputEpisode({
      requestId: `bp12-candidate-input-${failAfterAction ? 'obs-fail' : 'transport'}`,
      goal: {kind: 'BrowserInput', targetText: entry.family.query},
      satisfactionThreshold: 100,
      bindings: {
        documentRef: entry.family.documentRef,
        scopeRef: entry.family.scopeRef,
        targetRef: entry.family.inputRef,
      },
    }, {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText']),
      decision: candidate.inputDecision,
      observe,
      currentControl: () => control,
      nativeInputText: async (invocation) => {
        nativeWrites += 1;
        pack.input.value = invocation.value;
        throw new Error('injected native transport error after dispatch');
      },
    });
    return {
      episode,
      nativeWrites,
      submitCount,
      dispatchedValue: pack.input?.value ?? null,
    };
  };

  const runSearchCase = async ({failAfterAction = false} = {}) => {
    const pack = structuredClone(entry.fixtureFor('probe-bp12'));
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
      decision: candidate.decision,
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
    return {
      episode,
      nativeWrites,
      submitCount,
      dispatchedValue: pack.input?.value ?? null,
    };
  };

  const runSubmissionCase = async () => {
    const pack = structuredClone(entry.fixtureFor('probe-bp12'));
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
      requestId: 'bp12-candidate-recursive-submission',
      goal: goalFor(entry, 'root'),
      satisfactionThreshold: 100,
      bindings: bindingsFor(entry.family),
      maxResultReads: 1,
    }, {
      grantedEffects: new Set([
        'browser.read',
        'browser.nativeInputText',
        'browser.nativeSubmit',
        'filesystem.write',
      ]),
      decision: candidate.decision,
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
          source: 'evaluate-independent-candidate.consumer-input',
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
        pack.items = {main: [`${entry.family.containsText}记录`], auxiliary: []};
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: 'unknown',
          source: 'evaluate-independent-candidate.consumer-submit',
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
  };

  return {
    input: await runInputCase({failAfterAction: false}),
    search: await runSearchCase({failAfterAction: false}),
    inputObservationFailure: await runInputCase({failAfterAction: true}),
    searchObservationFailure: await runSearchCase({failAfterAction: true}),
    submission: await runSubmissionCase(),
  };
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

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
    collectionId: collection?.id ?? null,
    scroll: scrollBox
      ? {scrollTop: scrollBox.scrollTop, clientHeight: scrollBox.clientHeight, scrollHeight: scrollBox.scrollHeight}
      : null,
    mainItems,
    auxiliaryItems,
  };
}

function captureExpandEvidenceFn(selectors) {
  const scrollBox = document.querySelector(selectors.scrollBox ?? '#result-scroll-box');
  const requestEl = document.querySelector(selectors.request ?? '#request-state');
  const collectionEl = document.querySelector(selectors.collection ?? '#catalog-table, #split-main-list');
  const loadMoreEl = document.querySelector(selectors.loadMore ?? '#load-more');
  const bannerEl = document.querySelector(selectors.terminalBanner ?? '#collection-terminal-banner');
  const mainItems = collectionEl && selectors.mainItems
    ? Array.from(collectionEl.querySelectorAll(selectors.mainItems)).map((el) => el.textContent.trim())
    : [];
  return {
    scroll: scrollBox
      ? {
        scrollTop: scrollBox.scrollTop,
        clientHeight: scrollBox.clientHeight,
        scrollHeight: scrollBox.scrollHeight,
      }
      : null,
    requestStatus: requestEl?.getAttribute('data-request-status') ?? null,
    batchRef: requestEl?.getAttribute('data-batch-ref') ?? null,
    resultsRequestRef: requestEl?.getAttribute('data-results-request-ref') ?? null,
    collectionId: collectionEl?.id ?? null,
    mainItemCount: mainItems.length,
    loadMorePresent: Boolean(loadMoreEl),
    loadMoreHasMore: loadMoreEl?.getAttribute('data-has-more') ?? null,
    bannerPresent: Boolean(bannerEl),
    bannerHasMore: bannerEl?.getAttribute('data-has-more') ?? null,
  };
}

async function captureExpandEvidence(cdp, selectors) {
  return cdp.evaluate(`(${captureExpandEvidenceFn.toString()})(${JSON.stringify(selectors)})`);
}

async function observeNative(cdp, selectors, inputRef) {
  return cdp.evaluate(`(${browserObservationFn.toString()})(${JSON.stringify({selectors, inputRef})})`);
}

function isKnownRequestState(value) {
  return value === 'loading' || value === 'settled' || value === 'error';
}

function nativeObservationPair(raw, family, revision, mechanicalEffectOverride = null) {
  const observationId = `${family.id}:native:${revision}`;
  const evidence = [];
  const observed = (key, value) => {
    const id = `${observationId}:${key}`;
    evidence.push({id, source: 'evaluate-independent-candidate.native-observation', fact: {key, value}});
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
  const effectiveMechanical = mechanicalEffectOverride ?? raw.mechanicalEffect;
  const inputObservation = readBrowserInputObservation({...identity, target, neighbors, evidence});
  const searchObservation = readBrowserSearchObservation({
    ...identity,
    target,
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
      actionMechanicalEffect: ['displaced_or_triggered', 'no_change', 'not_attempted'].includes(effectiveMechanical)
        ? effectiveMechanical : 'not_attempted',
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

async function inspectActiveFocusForSelector(cdp, selector) {
  try {
    const focusState = await cdp.evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof Element)) return 'unknown';
      const active = document.activeElement;
      if (!(active instanceof Element)) return 'unknown';
      if (active === target || target.contains(active)) return 'target';
      return 'other';
    })()`);
    return focusState === 'target' || focusState === 'other' ? focusState : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function nativeInput(cdp, selector, value) {
  await clickSelector(cdp, selector);
  await delay(50);
  const focusBeforeInsert = await inspectActiveFocusForSelector(cdp, selector);
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
  const focusAfterInsert = await inspectActiveFocusForSelector(cdp, selector);
  const focus = focusBeforeInsert === 'other' || focusAfterInsert === 'other'
    ? 'other'
    : focusBeforeInsert === 'target' && focusAfterInsert === 'target'
      ? 'target'
      : 'unknown';
  return {
    focusBeforeInsert,
    focusAfterInsert,
    focus,
  };
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

export function createIndependentNativeResources(cdp, entry, {
  candidate,
  failAfterAction = false,
  failAfterInput = false,
  preferLoadMoreButton = false,
  waitAfterExpandMs = 260,
  episodes = null,
  rootOutcomes = null,
} = {}) {
  let revision = 0;
  let control = null;
  let lastMechanicalEffect = null;
  let textWriteCount = 0;
  let submitCount = 0;
  let expandRangeCount = 0;
  let readResultsCount = 0;
  const expandEvidenceLog = [];

  const observeSearch = async (obligation) => {
    if (failAfterAction && obligation?.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
    const pair = nativeObservationPair(raw, entry.family, revision, lastMechanicalEffect);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: pair.search.observationId,
      revision,
    };
    return pair.search;
  };

  const observeInput = async (obligation) => {
    if (failAfterAction && obligation?.freshness === 'after_action') {
      throw new Error('injected post-action observation failure');
    }
    revision += 1;
    const raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
    const pair = nativeObservationPair(raw, entry.family, revision, lastMechanicalEffect);
    control = {
      documentRef: entry.family.documentRef,
      scopeRef: entry.family.scopeRef,
      observationId: pair.input.observationId,
      revision,
    };
    return pair.input;
  };

  const nativeInputText = async (invocation) => {
    textWriteCount += 1;
    const focusMeasurement = await nativeInput(cdp, entry.selectors.input, invocation.value);
    if (failAfterInput) {
      throw new Error('injected native transport error after dispatch');
    }
    return {
      dispatched: true,
      ok: true,
      effectKnowledge: 'unknown',
      source: 'evaluate-independent-candidate.native-input',
      error: null,
      events: [
        {
          type: 'insertText',
          targetRef: entry.family.inputRef,
          detail: `${invocation.value}|focus:${focusMeasurement.focusBeforeInsert}->${focusMeasurement.focusAfterInsert}`,
        },
      ],
      textWriteCount: 1,
      focus: focusMeasurement.focus,
    };
  };

  const nativeSubmitFn = async () => {
    submitCount += 1;
    if (failAfterInput) {
      throw new Error('BP12 search must not submit after an input transport error');
    }
    await nativeSubmit(cdp);
    return {
      dispatched: true,
      ok: true,
      effectKnowledge: 'unknown',
      source: 'evaluate-independent-candidate.native-submit',
      error: null,
    };
  };

  const nativeExpandRange = async () => {
    expandRangeCount += 1;
    const before = await captureExpandEvidence(cdp, entry.selectors);
    let method = 'wheel';
    if (preferLoadMoreButton && before?.loadMorePresent) {
      method = 'click-load-more';
      await clickSelector(cdp, entry.selectors.loadMore);
    } else {
      const scrolled = await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
      method = scrolled.method;
    }
    if (waitAfterExpandMs > 0) {
      await delay(waitAfterExpandMs);
    }
    let after = await captureExpandEvidence(cdp, entry.selectors);
    if (
      !preferLoadMoreButton
      && after
      && before
      && after.batchRef === before.batchRef
      && after.requestStatus !== 'loading'
      && after.loadMorePresent
      && after.loadMoreHasMore === 'true'
    ) {
      await clickSelector(cdp, entry.selectors.loadMore);
      method = `${method}+click-load-more`;
      if (waitAfterExpandMs > 0) {
        await delay(waitAfterExpandMs);
      }
      after = await captureExpandEvidence(cdp, entry.selectors);
    }
    const classified = classifyNativeExpandRange(before, after);
    lastMechanicalEffect = classified.actionMechanicalEffect;
    expandEvidenceLog.push({before, after, classified, method});
    return {
      dispatched: true,
      ok: true,
      effectKnowledge: classified.effectKnowledge,
      source: 'evaluate-independent-candidate.native-expand-range',
      error: null,
    };
  };

  return {
    inputResources: {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText']),
      decision: candidate.inputDecision,
      observe: observeInput,
      currentControl: () => control,
      nativeInputText,
    },
    searchResources: {
      grantedEffects: new Set([
        'browser.read',
        'browser.nativeInputText',
        'browser.nativeSubmit',
        'browser.nativeExpandRange',
        'filesystem.write',
      ]),
      decision: candidate.decision,
      observe: observeSearch,
      readResults: async (obligation) => {
        readResultsCount += 1;
        return observeSearch(obligation);
      },
      currentControl: () => control,
      nativeInputText,
      nativeSubmit: nativeSubmitFn,
      nativeExpandRange,
      collect: async (episode) => {
        episodes?.push(episode);
      },
      collectRoot: async (outcome) => {
        rootOutcomes?.push(outcome);
      },
    },
    counters: () => ({
      textWriteCount,
      submitCount,
      expandRangeCount,
      readResultsCount,
      expandEvidenceLog,
    }),
  };
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
      // Try next declared binary path.
    }
  }
  return null;
}

async function stopChrome(browser) {
  if (browser?.child) {
    const exited = new Promise((resolveExit) => browser.child.once('exit', resolveExit));
    browser.child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
  }
  if (browser?.userDataDir) {
    await rm(browser.userDataDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
      .catch(() => undefined);
  }
}

async function launchOrAttachChrome({cdpUrl, cdpPort} = {}) {
  if (cdpUrl || cdpPort) {
    const httpBase = cdpUrl
      ? cdpUrl.replace(/\/$/, '')
      : `http://127.0.0.1:${Number(cdpPort)}`;
    try {
      const res = await fetch(`${httpBase}/json/version`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {status: 'READY', attached: true, httpBase, stderr: []};
    } catch (error) {
      return {
        status: 'UNVERIFIED',
        reason: `CDP endpoint ${httpBase} unreachable: ${error instanceof Error ? error.message : String(error)}`,
        stderr: '',
      };
    }
  }
  const binary = await chromeBinary();
  if (!binary) return {status: 'UNVERIFIED', reason: 'headless Chrome binary unavailable', stderr: ''};
  const userDataDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-eval-'));
  const stderr = [];
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
      const [port, wsPath] = raw.trim().split('\n');
      if (port && wsPath) {
        activePort = {port: Number(port), path: wsPath};
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!activePort) {
    child.kill('SIGTERM');
    await rm(userDataDir, {recursive: true, force: true}).catch(() => undefined);
    return {
      status: 'UNVERIFIED',
      reason: `headless Chrome did not expose DevToolsActivePort: ${stderr.join('').trim() || 'no stderr'}`,
      stderr: stderr.join(''),
    };
  }
  return {
    status: 'READY',
    attached: false,
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
      if (message.error) {
        waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        waiter.resolve(message.result ?? {});
      }
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
      throw new Error(
        `Runtime.evaluate failed: ${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`,
      );
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
    // Ignore already-closed target.
  }
}

async function navigate(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.call('Page.navigate', {url});
  await Promise.race([loaded, delay(5000)]);
  await delay(250);
}

async function runDryRunWiringCheck({candidateDir} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-dryrun-'));
  try {
    const validInput = createBrowserInputPolicyProfile([
      [-3, 1, 1, 1, 1, 1, 1, 1, -4, 1, -6, 1, 1],
      [-2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 0, 0],
      [1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, -2],
    ]);
    const validRelation = createBrowserQueryRelationProfile([
      [-3, 1, 2, 1, -4, 0, 0, 0, 0, 0, 1, 2, 0, 0],
      [-2, 0, 0, 1, 3, 0, -4, 1, 0, 2, 0, 2, 0, -5],
      [-2, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 8],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -3, 0, -4],
    ]);
    const validStep = createBrowserStepPolicyProfile([
      [-4, 3, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [-4, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [-4, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 4],
      [-4, 0, 0, 3, 0, 0, 0, 0, 0, 1, 0, 1, 1, -5, 1, 4, -5, 0],
      [-4, 2, 2, 1, 0, 4, 0, 0, 4, 4, 0, 0, 0, 5, 0, 0, 5, 0],
      [1, 0, 0, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, -2, 0, 0, 0],
    ]);
    await writeFile(join(tempDir, 'input-policy.json'), `${JSON.stringify(validInput, null, 2)}\n`);
    await writeFile(join(tempDir, 'query-relation.json'), `${JSON.stringify(validRelation, null, 2)}\n`);
    await writeFile(join(tempDir, 'step-policy.json'), `${JSON.stringify(validStep, null, 2)}\n`);

    const loaded = await loadStage1CandidateFromDisk(candidateDir ?? tempDir);
    assert(loaded.decision.source === 'model', 'decision.source must be model');
    let guardThrew = false;
    try {
      loaded.decision.select();
    } catch (error) {
      guardThrew = error instanceof TypeError;
    }
    assert(guardThrew, 'decision.select guard must throw TypeError if invoked');

    // Fail-closed negative checks: missing file & wrong matrix dimensions.
    const missingDir = join(tempDir, 'missing-sub');
    let missingThrew = false;
    try {
      await loadStage1CandidateFromDisk(missingDir);
    } catch (error) {
      missingThrew = error instanceof TypeError;
    }
    assert(missingThrew, 'missing candidate directory must throw TypeError');

    const badDimDir = await mkdtemp(join(tmpdir(), 'nnanything-stage1-baddim-'));
    let badDimThrew = false;
    try {
      await writeFile(join(badDimDir, 'input-policy.json'), JSON.stringify({...validInput, weights: [[1, 2]]}));
      await writeFile(join(badDimDir, 'query-relation.json'), JSON.stringify(validRelation));
      await writeFile(join(badDimDir, 'step-policy.json'), JSON.stringify(validStep));
      await loadStage1CandidateFromDisk(badDimDir);
    } catch (error) {
      badDimThrew = error instanceof TypeError;
    } finally {
      await rm(badDimDir, {recursive: true, force: true}).catch(() => undefined);
    }
    assert(badDimThrew, 'corrupt weight dimension must throw TypeError');

    // Non-holdout synthetic train-family descriptor (never touches FAMILIES.F7 or FAMILIES.F8).
    const nonHoldoutEntry = {
      code: 'A-DRYRUN',
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
      family: {
        id: 'BF_A_dryrun_nonholdout',
        documentRef: 'doc-a-dryrun',
        scopeRef: 'scope-a-dryrun',
        inputRef: 'input-a-dryrun',
        submitRef: 'submit-a-dryrun',
        resultScopeRef: 'results-a-dryrun',
        collectionRef: 'collection-a-dryrun',
        query: '珊瑚礁',
        containsText: '珊瑚',
      },
      fixtureFor(scenario) {
        return {
          input: {
            type: 'text',
            value: scenario === 'equal' || scenario === 'submitted' ? '珊瑚礁' : '',
            placeholder: '搜索关键词',
            disabled: false,
            readonly: scenario === 'readonly',
            occluded: false,
          },
          submitted: {
            query: scenario === 'submitted' ? '珊瑚礁' : null,
            requestRef: scenario === 'submitted' ? 'req-a-1' : null,
          },
          request: {
            status: 'settled',
            display: scenario === 'submitted' ? 'current' : 'none',
            access: 'available',
            resultsFor: scenario === 'submitted' ? '珊瑚礁' : null,
            resultsRef: scenario === 'submitted' ? 'req-a-1' : null,
            batchRef: scenario === 'submitted' ? 'req-a-1:batch-1' : null,
            range: {
              actionMechanicalEffect: 'not_attempted',
              atGeometryBoundary: {status: 'observed', value: true},
              requestState: {status: 'observed', value: 'settled'},
              hasMore: {status: 'observed', value: false},
            },
          },
          items: {main: scenario === 'submitted' ? ['珊瑚礁保护区记录'] : [], auxiliary: []},
        };
      },
    };

    // Verify B-S1.1 + B-S1.2 -> B-S1.3 cascade uses predicted upstream heads (no teacher substitution) on nonHoldoutEntry.
    const syntheticEntry = nonHoldoutEntry;
    const syntheticState = buildState(syntheticEntry.fixtureFor('normal'), syntheticEntry.family, 'input');
    const stepFromInput = predictBrowserStepPolicy(
      syntheticState,
      goalFor(syntheticEntry, 'input'),
      'INPUT',
      null,
      loaded.stepPolicyProfile,
    );
    const stepFromDefer = predictBrowserStepPolicy(
      syntheticState,
      goalFor(syntheticEntry, 'input'),
      'DEFER',
      null,
      loaded.stepPolicyProfile,
    );
    assert(
      stepFromInput.features[4] === 1 && stepFromInput.features[6] === 0,
      'B-S1.3 wires must reflect predicted B-S1.1 head INPUT',
    );
    assert(
      stepFromDefer.features[4] === 0 && stepFromDefer.features[6] === 1,
      'B-S1.3 wires must reflect predicted B-S1.1 head DEFER without teacher override',
    );

    // Verify r5 native expansion evidence classification rules (4 checks).
    const baseEvidence = {
      scroll: {scrollTop: 0, clientHeight: 180, scrollHeight: 360},
      requestStatus: 'settled',
      batchRef: 'req-1:batch-1',
      collectionId: 'catalog-table',
      mainItemCount: 6,
    };
    const nullBefore = classifyNativeExpandRange(null, baseEvidence);
    const nullAfter = classifyNativeExpandRange(baseEvidence, null);
    const nullChannelBefore = classifyNativeExpandRange({...baseEvidence, batchRef: null}, baseEvidence);
    const nullChannelAfter = classifyNativeExpandRange(baseEvidence, {...baseEvidence, requestStatus: null});
    assert(
      nullBefore.factsComplete === false
        && nullBefore.effectKnowledge === 'unknown'
        && nullBefore.actionMechanicalEffect === null
        && nullAfter.factsComplete === false
        && nullAfter.effectKnowledge === 'unknown'
        && nullAfter.actionMechanicalEffect === null
        && nullChannelBefore.factsComplete === false
        && nullChannelBefore.effectKnowledge === 'unknown'
        && nullChannelAfter.factsComplete === false
        && nullChannelAfter.effectKnowledge === 'unknown',
      'r5 check 2: null before/after or null channel must report factsComplete=false and effectKnowledge=unknown',
    );
    const loadingUnchanged = classifyNativeExpandRange(
      {...baseEvidence, requestStatus: 'loading'},
      {...baseEvidence, requestStatus: 'loading'},
    );
    assert(
      loadingUnchanged.triggeredRequest === false
        && loadingUnchanged.actionMechanicalEffect === 'no_change'
        && loadingUnchanged.effectKnowledge === 'none',
      'r5 check 3: loading -> loading with unchanged scrollTop/batchRef must be no_change / none',
    );
    const settledToLoading = classifyNativeExpandRange(
      baseEvidence,
      {...baseEvidence, requestStatus: 'loading'},
    );
    const batchAdvanced = classifyNativeExpandRange(
      baseEvidence,
      {...baseEvidence, batchRef: 'req-1:batch-2', mainItemCount: 12},
    );
    const scrollAdvanced = classifyNativeExpandRange(
      baseEvidence,
      {...baseEvidence, scroll: {scrollTop: 180, clientHeight: 180, scrollHeight: 360}},
    );
    assert(
      settledToLoading.actionMechanicalEffect === 'displaced_or_triggered'
        && settledToLoading.effectKnowledge === 'known'
        && batchAdvanced.actionMechanicalEffect === 'displaced_or_triggered'
        && batchAdvanced.effectKnowledge === 'known'
        && scrollAdvanced.actionMechanicalEffect === 'displaced_or_triggered'
        && scrollAdvanced.effectKnowledge === 'known',
      'r5 check 4: settled->loading, batch-1->batch-2, or scrollTop increase must be displaced_or_triggered / known',
    );

    const fnSource = captureExpandEvidenceFn.toString();
    assert(
      fnSource.includes('#result-scroll-box')
        && fnSource.includes('#request-state')
        && fnSource.includes('#catalog-table, #split-main-list'),
      'r5 check 1: captureExpandEvidenceFn must read #result-scroll-box, #request-state, and collection selector',
    );

    const localPassGlobalFalseProbe = computeIndependentEvaluationOutcome({
      hasAnyFailure: false,
      allSyntheticAndConsumerPass: true,
      nativeCdpStatus: 'READY',
      nativeE2eStatus: 'PASS',
    });
    assert(
      localPassGlobalFalseProbe.localSuitePassed === true
        && localPassGlobalFalseProbe.localSuiteStatus === 'PASS'
        && localPassGlobalFalseProbe.overallStatus === 'PASS'
        && localPassGlobalFalseProbe.fullyVerified === false
        && localPassGlobalFalseProbe.unseenFeatureCapabilityVerified === false,
      'Contract §3.1.4 & Gap 6: local suite PASS must keep global fullyVerified=false and unseenFeatureCapabilityVerified=false',
    );

    const nonHoldoutInputRun = await runPublicConsumerEpisodeForRow(
      nonHoldoutEntry,
      {id: 'A-DRYRUN-INPUT', scenario: 'normal', phase: 'input'},
      'input',
      loaded,
    );
    const nonHoldoutNoopRun = await runPublicConsumerEpisodeForRow(
      nonHoldoutEntry,
      {id: 'A-DRYRUN-NOOP', scenario: 'equal', phase: 'input'},
      'input',
      loaded,
    );
    const nonHoldoutDeferRun = await runPublicConsumerEpisodeForRow(
      nonHoldoutEntry,
      {id: 'A-DRYRUN-DEFER', scenario: 'readonly', phase: 'input'},
      'input',
      loaded,
    );
    const nonHoldoutResultsRun = await runPublicConsumerEpisodeForRow(
      nonHoldoutEntry,
      {id: 'A-DRYRUN-RESULTS', scenario: 'submitted', phase: 'results'},
      'results',
      loaded,
    );
    assert(
      deriveInputConsumerContractOutcome(nonHoldoutInputRun.inputConsumerEpisode) === 'INPUT'
        && nonHoldoutInputRun.searchEpisode.decision?.input?.head === 'INPUT'
        && nonHoldoutInputRun.searchEpisode.decision?.step?.head === 'input',
      'non-holdout INPUT consumer contract and searchEpisode.decision.input.head must resolve to INPUT/input',
    );
    assert(
      deriveInputConsumerContractOutcome(nonHoldoutNoopRun.inputConsumerEpisode) === 'NOOP'
        && nonHoldoutNoopRun.searchEpisode.decision?.input?.head === 'NOOP'
        && nonHoldoutNoopRun.searchEpisode.decision?.step?.head === 'NOOP',
      'non-holdout NOOP consumer contract and searchEpisode.decision.input.head must resolve to NOOP/NOOP',
    );
    assert(
      deriveInputConsumerContractOutcome(nonHoldoutDeferRun.inputConsumerEpisode) === 'DEFER'
        && nonHoldoutDeferRun.searchEpisode.decision?.input?.head === 'DEFER'
        && nonHoldoutDeferRun.searchEpisode.decision?.step?.head === 'DEFER',
      'non-holdout DEFER consumer contract and searchEpisode.decision.input.head must resolve to DEFER/DEFER',
    );
    assert(
      nonHoldoutResultsRun.searchEpisode.decision?.queryRelation?.head === 'results_associated_active'
        && nonHoldoutResultsRun.searchEpisode.decision?.step?.head === 'NOOP',
      'non-holdout results consumer must expose searchEpisode.decision.queryRelation.head',
    );

    // Verify nativeInputText focus truth measurement vs synthetic consumer receipt distinction.
    assert(
      nonHoldoutInputRun.inputConsumerEpisode?.receipt?.source === 'evaluate-independent-candidate.synthetic-consumer-input'
        && nonHoldoutInputRun.inputConsumerEpisode?.receipt?.focus === 'unknown',
      'synthetic consumer input receipt must report source=evaluate-independent-candidate.synthetic-consumer-input and focus=unknown when activeElementFocus is unmeasured',
    );
    const makeMockFocusCdp = (focusReturn) => ({
      call: async () => ({}),
      evaluate: async (expr) => {
        if (expr.includes('getBoundingClientRect')) return {x: 10, y: 10};
        if (typeof focusReturn === 'function') return focusReturn();
        return focusReturn;
      },
    });
    const nativeTargetFocusReceipt = await createIndependentNativeResources(
      makeMockFocusCdp('target'),
      nonHoldoutEntry,
      {candidate: loaded},
    ).inputResources.nativeInputText({value: '珊瑚礁'});
    const nativeOtherFocusReceipt = await createIndependentNativeResources(
      makeMockFocusCdp('other'),
      nonHoldoutEntry,
      {candidate: loaded},
    ).inputResources.nativeInputText({value: '珊瑚礁'});
    const nativeUnknownFocusReceipt = await createIndependentNativeResources(
      makeMockFocusCdp(() => {
        throw new Error('cdp focus evaluation unavailable');
      }),
      nonHoldoutEntry,
      {candidate: loaded},
    ).inputResources.nativeInputText({value: '珊瑚礁'});
    assert(
      nativeTargetFocusReceipt.source === 'evaluate-independent-candidate.native-input'
        && nativeTargetFocusReceipt.focus === 'target'
        && nativeOtherFocusReceipt.focus === 'other'
        && nativeUnknownFocusReceipt.focus === 'unknown',
      'nativeInputText must report real measured CDP focus (target / other / unknown) rather than hardcoded target',
    );

    const rawNativeSample = {
      inputConnected: true,
      inputValue: '',
      inputTag: 'input',
      inputType: 'text',
      inputPlaceholder: '搜索关键词',
      inputDisabled: false,
      inputReadonly: false,
      inputAriaDisabled: null,
      inputAriaReadonly: null,
      inputContentEditable: false,
      inputEditable: true,
      inputActiveElementFocus: false,
      inputActiveElementRef: null,
      inputPoint: {x: 20, y: 20},
      executableHit: true,
      notesValue: '保持原值',
      submittedQuery: null,
      submittedRequestRef: null,
      requestStatus: 'settled',
      display: 'none',
      access: 'available',
      resultsFor: null,
      resultsRequestRef: null,
      batchRef: null,
      mechanicalEffect: 'not_attempted',
      bannerStatus: null,
      bannerHasMore: null,
      loadMoreHasMore: null,
      loadMorePresent: false,
      bannerPresent: false,
      scroll: {scrollTop: 0, clientHeight: 180, scrollHeight: 180},
      mainItems: [],
      auxiliaryItems: [],
    };
    const nonHoldoutNativePair = nativeObservationPair(rawNativeSample, nonHoldoutEntry.family, 1);
    assert(
      nonHoldoutNativePair.search.target !== undefined
        && nonHoldoutNativePair.search.target.ref === nonHoldoutEntry.family.inputRef,
      'nativeObservationPair must attach target onto searchObservation so model-mode B-S1.1 is not skipped',
    );

    // Positive/negative real runBrowserSearchEpisode + runBrowserSearchGoal (decision.source === 'model') contrast on nonHoldoutEntry
    // demonstrating the exact failure when target is omitted from BrowserSearchObservation vs restored.
    const runTargetWiringContrastCase = async ({omitTarget}) => {
      let singleRev = 0;
      let singleCtrl = null;
      let singleWrites = 0;
      const singleObserve = async () => {
        singleRev += 1;
        const pair = nativeObservationPair({
          ...rawNativeSample,
          inputValue: singleWrites > 0 ? nonHoldoutEntry.family.query : '',
        }, nonHoldoutEntry.family, singleRev);
        singleCtrl = {
          documentRef: nonHoldoutEntry.family.documentRef,
          scopeRef: nonHoldoutEntry.family.scopeRef,
          observationId: pair.search.observationId,
          revision: singleRev,
        };
        if (omitTarget) {
          const {target: _omittedTarget, ...searchWithoutTarget} = pair.search;
          return readBrowserSearchObservation(searchWithoutTarget);
        }
        return pair.search;
      };
      const singleEpisode = await runBrowserSearchEpisode({
        goal: goalFor(nonHoldoutEntry, 'input'),
        bindings: bindingsFor(nonHoldoutEntry.family),
        maxResultReads: 1,
        submissionBaseline: null,
        checkedObservationId: null,
      }, {
        grantedEffects: new Set([
          'browser.read',
          'browser.nativeInputText',
          'browser.nativeSubmit',
          'filesystem.write',
        ]),
        decision: loaded.decision,
        observe: singleObserve,
        readResults: singleObserve,
        currentControl: () => singleCtrl,
        nativeInputText: async () => {
          singleWrites += 1;
          return {
            dispatched: true,
            ok: true,
            effectKnowledge: 'known',
            source: 'evaluate-independent-candidate.dryrun-contrast-single-input',
            error: null,
          };
        },
        collect: async () => {},
      });

      const stateSim = {
        inputValue: '',
        submittedQuery: null,
        submittedRequestRef: null,
        requestStatus: 'settled',
        display: 'none',
        resultsFor: null,
        resultsRequestRef: null,
        batchRef: null,
        mainItems: [],
      };
      let rev = 0;
      let ctrl = null;
      let inputDispatchCount = 0;
      let submitDispatchCount = 0;
      const episodes = [];
      const observeFn = async () => {
        rev += 1;
        const pair = nativeObservationPair({
          ...rawNativeSample,
          inputValue: stateSim.inputValue,
          submittedQuery: stateSim.submittedQuery,
          submittedRequestRef: stateSim.submittedRequestRef,
          requestStatus: stateSim.requestStatus,
          display: stateSim.display,
          resultsFor: stateSim.resultsFor,
          resultsRequestRef: stateSim.resultsRequestRef,
          batchRef: stateSim.batchRef,
          mainItems: stateSim.mainItems,
        }, nonHoldoutEntry.family, rev);
        ctrl = {
          documentRef: nonHoldoutEntry.family.documentRef,
          scopeRef: nonHoldoutEntry.family.scopeRef,
          observationId: pair.search.observationId,
          revision: rev,
        };
        if (omitTarget) {
          const {target: _omittedTarget, ...searchWithoutTarget} = pair.search;
          return readBrowserSearchObservation(searchWithoutTarget);
        }
        return pair.search;
      };
      const response = await runBrowserSearchGoal({
        requestId: omitTarget ? 'dryrun-contrast-target-omitted' : 'dryrun-contrast-target-restored',
        goal: goalFor(nonHoldoutEntry, 'root'),
        satisfactionThreshold: 100,
        bindings: bindingsFor(nonHoldoutEntry.family),
        maxResultReads: 2,
      }, {
        grantedEffects: new Set([
          'browser.read',
          'browser.nativeInputText',
          'browser.nativeSubmit',
          'filesystem.write',
        ]),
        decision: loaded.decision,
        observe: observeFn,
        readResults: observeFn,
        currentControl: () => ctrl,
        nativeInputText: async (invocation) => {
          inputDispatchCount += 1;
          stateSim.inputValue = invocation.value;
          return {
            dispatched: true,
            ok: true,
            effectKnowledge: 'known',
            source: 'evaluate-independent-candidate.dryrun-contrast-input',
            error: null,
          };
        },
        nativeSubmit: async () => {
          submitDispatchCount += 1;
          stateSim.submittedQuery = stateSim.inputValue;
          stateSim.submittedRequestRef = 'req-a-contrast-1';
          stateSim.requestStatus = 'settled';
          stateSim.display = 'current';
          stateSim.resultsFor = stateSim.inputValue;
          stateSim.resultsRequestRef = 'req-a-contrast-1';
          stateSim.batchRef = 'req-a-contrast-1:batch-1';
          stateSim.mainItems = ['珊瑚礁保护区记录'];
          return {
            dispatched: true,
            ok: true,
            effectKnowledge: 'known',
            source: 'evaluate-independent-candidate.dryrun-contrast-submit',
            error: null,
          };
        },
        collect: async (ep) => {
          episodes.push(ep);
        },
      });
      return {
        omitTarget,
        singleInputEpisode: {
          decisionInputPresent: singleEpisode.decision?.input !== undefined,
          decisionInputHead: singleEpisode.decision?.input?.head ?? null,
          decisionStepHead: singleEpisode.decision?.step?.head ?? null,
          action: singleEpisode.action,
          dispatchState: singleEpisode.dispatchState,
          singleWrites,
        },
        recursiveRootGoal: {
          kind: response.kind ?? null,
          controlOutcome: response.report?.control?.outcome ?? null,
          rootResult: response.report?.rootEvaluation?.result ?? null,
          inputDispatchCount,
          submitDispatchCount,
          episodeCount: episodes.length,
          firstEpisodeInputPredictionPresent: episodes[0]?.decision?.input !== undefined,
          firstEpisodeInputHead: episodes[0]?.decision?.input?.head ?? null,
          firstEpisodeStepHead: episodes[0]?.decision?.step?.head ?? null,
          secondEpisodeStepHead: episodes[1]?.decision?.step?.head ?? null,
          stepTrajectory: episodes.map((ep) => ep.decision?.step?.head ?? ep.action),
        },
      };
    };

    const targetOmittedNegativeControl = await runTargetWiringContrastCase({omitTarget: true});
    const targetRestoredPositiveControl = await runTargetWiringContrastCase({omitTarget: false});
    assert(
      targetOmittedNegativeControl.singleInputEpisode.decisionInputPresent === false
        && targetOmittedNegativeControl.singleInputEpisode.decisionInputHead === null
        && targetOmittedNegativeControl.singleInputEpisode.decisionStepHead === 'DEFER'
        && targetOmittedNegativeControl.singleInputEpisode.singleWrites === 0
        && targetOmittedNegativeControl.recursiveRootGoal.inputDispatchCount === 0
        && targetOmittedNegativeControl.recursiveRootGoal.submitDispatchCount === 0
        && targetOmittedNegativeControl.recursiveRootGoal.episodeCount === 0
        && targetOmittedNegativeControl.recursiveRootGoal.controlOutcome === 'stalled'
        && targetOmittedNegativeControl.recursiveRootGoal.rootResult === 'unknown',
      `targetOmittedNegativeControl must reproduce pre-fix model-mode stall: ${JSON.stringify(targetOmittedNegativeControl)}`,
    );
    assert(
      targetRestoredPositiveControl.singleInputEpisode.decisionInputPresent === true
        && targetRestoredPositiveControl.singleInputEpisode.decisionInputHead === 'INPUT'
        && targetRestoredPositiveControl.singleInputEpisode.decisionStepHead === 'input'
        && targetRestoredPositiveControl.singleInputEpisode.singleWrites === 1
        && targetRestoredPositiveControl.recursiveRootGoal.inputDispatchCount === 1
        && targetRestoredPositiveControl.recursiveRootGoal.submitDispatchCount === 1
        && targetRestoredPositiveControl.recursiveRootGoal.firstEpisodeInputPredictionPresent === true
        && targetRestoredPositiveControl.recursiveRootGoal.firstEpisodeInputHead === 'INPUT'
        && targetRestoredPositiveControl.recursiveRootGoal.firstEpisodeStepHead === 'input'
        && targetRestoredPositiveControl.recursiveRootGoal.secondEpisodeStepHead === 'submit'
        && targetRestoredPositiveControl.recursiveRootGoal.controlOutcome === 'completed'
        && targetRestoredPositiveControl.recursiveRootGoal.rootResult === 'satisfied',
      `targetRestoredPositiveControl must complete input->submit->read trajectory: ${JSON.stringify(targetRestoredPositiveControl)}`,
    );

    return {
      mode: 'evaluate-candidate-dry-run-wiring',
      status: 'PASS',
      localSuiteStatus: 'NOT_RUN',
      candidateEvaluated: false,
      fullIndependentSuiteExecuted: false,
      candidateForwardPassUsedInDryRun: Boolean(candidateDir),
      historicalPreR2DryRunTouchedF7InputNormal: true,
      r2DryRunUsesOnlyNonHoldoutEntry: nonHoldoutEntry.family.id,
      oneShotHoldoutConsumed: false,
      fullyVerified: false,
      unseenFeatureCapabilityVerified: false,
      checks: {
        failClosedLoader: 'PASS',
        selectGuardThrowsOnModelMode: 'PASS',
        cascadeUsesPredictedHeadsWithoutTeacher: 'PASS',
        r5ExpandEvidenceRules: 'PASS',
        localSuitePassKeepsFullyVerifiedFalse: 'PASS',
        nonHoldoutConsumerAndNativeTargetWiring: 'PASS',
        nativeFocusTruthAndSyntheticReceiptSeparation: 'PASS',
        targetOmittedVsRestoredConsumerContrast: 'PASS',
      },
      focusMeasurementChecks: {
        syntheticConsumerReceiptSource: nonHoldoutInputRun.inputConsumerEpisode?.receipt?.source ?? null,
        syntheticConsumerUnmeasuredFocus: nonHoldoutInputRun.inputConsumerEpisode?.receipt?.focus ?? null,
        nativeCdpTargetFocus: nativeTargetFocusReceipt.focus,
        nativeCdpOtherFocus: nativeOtherFocusReceipt.focus,
        nativeCdpUnknownFocus: nativeUnknownFocusReceipt.focus,
      },
      targetWiringContrast: {
        targetOmittedNegativeControl,
        targetRestoredPositiveControl,
      },
    };
  } finally {
    await rm(tempDir, {recursive: true, force: true}).catch(() => undefined);
  }
}

export function computeIndependentEvaluationOutcome({
  hasAnyFailure,
  allSyntheticAndConsumerPass,
  nativeCdpStatus,
  nativeE2eStatus,
}) {
  const localSuitePassed = !hasAnyFailure
    && Boolean(allSyntheticAndConsumerPass)
    && nativeCdpStatus === 'READY'
    && nativeE2eStatus === 'PASS';
  const localSuiteStatus = hasAnyFailure
    ? 'FAIL'
    : (nativeCdpStatus !== 'READY' ? 'UNVERIFIED' : (localSuitePassed ? 'PASS' : 'FAIL'));
  return Object.freeze({
    localSuitePassed,
    localSuiteStatus,
    overallStatus: localSuiteStatus,
    // Per gcm-f3-research-prep-task.md §3.1.4 and plan.md Gap 6:
    // External online sites and unseen continuous feature generalization remain unverified,
    // so global fullyVerified and unseenFeatureCapabilityVerified must ALWAYS be false.
    fullyVerified: false,
    unseenFeatureCapabilityVerified: false,
  });
}

export async function evaluateIndependentCandidate({
  candidateDir,
  outPath = null,
  cdpUrl = null,
  cdpPort = null,
  dryRunWiring = false,
} = {}) {
  if (dryRunWiring) {
    return runDryRunWiringCheck({candidateDir});
  }

  const candidate = await loadStage1CandidateFromDisk(candidateDir);

  const failedCases = [];
  const unknownFactCases = [];
  const recordFailure = (ledger, caseId, unit, expected, predicted, details = {}) => {
    failedCases.push({
      ledger,
      caseId,
      unit,
      expected,
      predicted,
      ...details,
    });
  };

  // Ledger A & Ledger B across F7 and F8 episodes
  const ledgerARows = [];
  const ledgerBRows = [];
  let inputPolicyPassed = 0;
  let inputPolicyTotal = 0;
  let queryRelationPassed = 0;
  let queryRelationTotal = 0;
  let stepPolicyPassed = 0;
  let stepPolicyTotal = 0;

  const rangeBoundaryCounts = {
    passed: 0,
    total: 0,
    '6A_loading_wait': {passed: 0, total: 0},
    '6A_unknown_terminal_preserved': {passed: 0, total: 0},
    '6B_bottom_terminal_stopped': {passed: 0, total: 0},
    'BP11b_non_bottom_terminal_stopped': {passed: 0, total: 0},
  };
  const rangeEpisodeSubBucket = {
    'range-6a-loading': '6A_loading_wait',
    'range-6a-unknown': '6A_unknown_terminal_preserved',
    'range-6b-bottom': '6B_bottom_terminal_stopped',
    'range-6b-nonbottom': 'BP11b_non_bottom_terminal_stopped',
  };
  const rangeEpisodeScenarios = new Set([
    'range-6a-loading',
    'range-6a-hasmore',
    'range-6a-unknown',
    'range-6b-bottom',
    'range-6b-nonbottom',
  ]);

  for (const code of ['F7', 'F8']) {
    const entry = FAMILIES[code];
    for (const row of EPISODES[code]) {
      const direct = evaluateCandidateSyntheticRow(entry, row, candidate, row.phase);
      const unknowns = collectUnknownFactsFromState(direct.state);
      if (unknowns.length > 0) {
        unknownFactCases.push({caseId: `${row.id}:${row.phase}`, unknowns});
      }

      inputPolicyTotal += 1;
      const inputOk = direct.input.head === row.expectedInput;
      if (inputOk) inputPolicyPassed += 1;
      else {
        recordFailure('syntheticProjectionCascade', `${row.id}:B-S1.1`, 'B-S1.1', row.expectedInput, direct.input.head, {
          wires: direct.input.wires,
          scores: direct.input.scores,
        });
      }

      if (row.phase === 'input') {
        stepPolicyTotal += 1;
        const consumerRun = await runPublicConsumerEpisodeForRow(entry, row, 'input', candidate);
        const consumerStepHead = consumerRun.searchEpisode.decision?.step?.head ?? null;
        const consumerSearchInputHead = consumerRun.searchEpisode.decision?.input?.head ?? null;
        const consumerInputContractOutcome = deriveInputConsumerContractOutcome(consumerRun.inputConsumerEpisode);
        const consumerInputHead = consumerInputContractOutcome !== null
          && consumerInputContractOutcome === consumerSearchInputHead
          ? consumerInputContractOutcome
          : null;
        const stepOk = direct.step.head === row.expectedStep
          && consumerStepHead === row.expectedStep
          && consumerInputHead === row.expectedInput;
        if (stepOk) stepPolicyPassed += 1;
        else {
          recordFailure(
            direct.step.head !== row.expectedStep ? 'syntheticProjectionCascade' : 'publicConsumerEpisodeEvaluation',
            `${row.id}:B-S1.3:input`,
            'B-S1.3',
            row.expectedStep,
            direct.step.head,
            {
              consumerStepHead,
              consumerInputHead,
              consumerSearchInputHead,
              consumerInputContractOutcome,
              wires: direct.step.wires,
              scores: direct.step.scores,
            },
          );
        }
        ledgerARows.push({
          id: `${row.id}:input`,
          family: code,
          scenario: row.scenario,
          phase: 'input',
          expected: {input: row.expectedInput, relation: null, step: row.expectedStep},
          predicted: {input: direct.input.head, relation: null, step: direct.step.head},
          status: inputOk && stepOk ? 'PASS' : 'FAIL',
        });
        ledgerBRows.push({
          id: `${row.id}:input`,
          family: code,
          scenario: row.scenario,
          phase: 'input',
          consumerInputHead,
          consumerStepHead,
          action: consumerRun.searchEpisode.action,
          dispatchState: consumerRun.searchEpisode.dispatchState,
          status: stepOk ? 'PASS' : 'FAIL',
        });
      } else {
        for (const phase of ['submitted', 'results']) {
          const evalPhase = evaluateCandidateSyntheticRow(entry, row, candidate, phase);
          const expectedRelation = row.expectedRelation;
          const expectedStep = phase === 'submitted'
            ? (row.expectedStep === 'submit' || row.expectedStep === 'DEFER' ? row.expectedStep : 'NOOP')
            : (row.expectedStep === 'submit' ? 'DEFER' : row.expectedStep);

          queryRelationTotal += 1;
          const relOk = evalPhase.relation?.head === expectedRelation;
          if (relOk) queryRelationPassed += 1;
          else {
            recordFailure(
              'syntheticProjectionCascade',
              `${row.id}:B-S1.2:${phase}`,
              'B-S1.2',
              expectedRelation,
              evalPhase.relation?.head ?? null,
              {
                wires: evalPhase.relation?.wires ?? [],
                scores: evalPhase.relation?.scores ?? [],
              },
            );
          }

          stepPolicyTotal += 1;
          const consumerRun = await runPublicConsumerEpisodeForRow(entry, row, phase, candidate);
          const consumerStepHead = consumerRun.searchEpisode.decision?.step?.head ?? null;
          const consumerRelHead = consumerRun.searchEpisode.decision?.queryRelation?.head ?? null;
          const stepOk = evalPhase.step.head === expectedStep
            && consumerStepHead === expectedStep
            && consumerRelHead === expectedRelation;
          if (stepOk) stepPolicyPassed += 1;
          else {
            recordFailure(
              evalPhase.step.head !== expectedStep ? 'syntheticProjectionCascade' : 'publicConsumerEpisodeEvaluation',
              `${row.id}:B-S1.3:${phase}`,
              'B-S1.3',
              expectedStep,
              evalPhase.step.head,
              {
                consumerStepHead,
                consumerRelHead,
                predictedInputHead: evalPhase.input.head,
                predictedRelationHead: evalPhase.relation?.head ?? null,
                wires: evalPhase.step.wires,
                scores: evalPhase.step.scores,
              },
            );
          }

          if (phase === 'results' && rangeEpisodeScenarios.has(row.scenario)) {
            rangeBoundaryCounts.total += 1;
            const rangeOk = relOk && stepOk;
            if (rangeOk) rangeBoundaryCounts.passed += 1;
            const subKey = rangeEpisodeSubBucket[row.scenario];
            if (subKey) {
              rangeBoundaryCounts[subKey].total += 1;
              if (rangeOk) rangeBoundaryCounts[subKey].passed += 1;
            }
          }

          ledgerARows.push({
            id: `${row.id}:${phase}`,
            family: code,
            scenario: row.scenario,
            phase,
            expected: {input: row.expectedInput, relation: expectedRelation, step: expectedStep},
            predicted: {
              input: evalPhase.input.head,
              relation: evalPhase.relation?.head ?? null,
              step: evalPhase.step.head,
            },
            status: inputOk && relOk && stepOk ? 'PASS' : 'FAIL',
          });
          ledgerBRows.push({
            id: `${row.id}:${phase}`,
            family: code,
            scenario: row.scenario,
            phase,
            consumerRelationHead: consumerRelHead,
            consumerStepHead,
            action: consumerRun.searchEpisode.action,
            dispatchState: consumerRun.searchEpisode.dispatchState,
            status: relOk && stepOk ? 'PASS' : 'FAIL',
          });
        }
      }
    }
  }

  // Counterexample probes (16 VERIFY_PROBE_CHECKS across BP01..BP12 + BP06 positive control)
  let probeChecksPassed = 0;
  let probeChecksTotal = 0;
  const syntheticProbeResults = [];

  for (const probe of PROBES) {
    const entry = FAMILIES[probe.family];
    for (const [index, variant] of (probe.variants ?? [probe]).entries()) {
      const variantId = `${probe.id}${probe.variants ? String.fromCharCode(97 + index) : ''}`;
      const hint = EPISODES[probe.family].find((item) => item.scenario === variant.scenario)
        ?? {id: probe.id, scenario: variant.scenario, phase: probe.phase};
      const evaluated = evaluateCandidateSyntheticRow(
        entry,
        {...hint, ...probe, ...variant, phase: probe.phase},
        candidate,
        probe.phase,
      );
      let inputObservation = evaluated.state.inputObservation;
      if (probe.id === 'BP02') {
        const postAction = structuredClone(entry.fixtureFor(variant.scenario));
        postAction.input.value = entry.family.query;
        inputObservation = buildState(postAction, entry.family, probe.phase).inputObservation;
      }
      const context = {
        probe,
        variant,
        family: entry,
        result: evaluated,
        observation: evaluated.state.observation,
        inputObservation,
        sideEffects: {textWriteCount: 0, submitCount: 0, expandRangeCount: 0},
      };
      if (probe.id === 'BP12') {
        context.bp12 = await runCandidateBp12ConsumerProbes(entry, candidate);
      }
      const checkNames = variant.checks ?? probe.checks;
      for (const checkName of checkNames) {
        probeChecksTotal += 1;
        const checkFn = VERIFY_PROBE_CHECKS[checkName];
        try {
          assert(typeof checkFn === 'function', `missing VERIFY_PROBE_CHECKS[${checkName}]`);
          assert(
            evaluated.input.head === variant.expectedInput,
            `${variantId} B-S1.1: expected ${variant.expectedInput}, got ${evaluated.input.head}`,
          );
          if (variant.expectedRelation) {
            assert(
              evaluated.relation?.head === variant.expectedRelation,
              `${variantId} B-S1.2: expected ${variant.expectedRelation}, got ${evaluated.relation?.head ?? null}`,
            );
          }
          assert(
            evaluated.step.head === variant.expectedStep,
            `${variantId} B-S1.3: expected ${variant.expectedStep}, got ${evaluated.step.head}`,
          );
          checkFn(evaluated.step, context);
          probeChecksPassed += 1;
          syntheticProbeResults.push({id: variantId, check: checkName, status: 'PASS'});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordFailure('publicConsumerEpisodeEvaluation', `${variantId}:${checkName}`, 'probe', 'PASS', 'FAIL', {
            error: message,
            heads: {
              input: evaluated.input.head,
              relation: evaluated.relation?.head ?? null,
              step: evaluated.step.head,
            },
          });
          syntheticProbeResults.push({id: variantId, check: checkName, status: 'FAIL', error: message});
        }
      }
    }
  }

  // BP06 positive control check on candidate
  {
    const posEntry = FAMILIES.F7;
    const posEval = evaluateCandidateSyntheticRow(posEntry, {
      id: 'BP06-positive',
      scenario: 'probe-bp06-positive',
      phase: 'results',
    }, candidate, 'results');
    const posOk = posEval.relation?.head === 'results_associated_active' && posEval.step.head === 'NOOP';
    if (!posOk) {
      recordFailure(
        'syntheticProjectionCascade',
        'BP06-positive',
        'B-S1.2+B-S1.3',
        'results_associated_active/NOOP',
        `${posEval.relation?.head ?? null}/${posEval.step.head}`,
      );
    }
  }

  // Ledger C: Native CDP Candidate Trajectory on F7 and F8
  const server = await startFixtureServer();
  const browser = await launchOrAttachChrome({cdpUrl, cdpPort});
  let nativeCdpStatus = browser.status === 'READY' ? 'READY' : 'UNVERIFIED';
  let unverifiedReason = browser.status === 'READY' ? null : browser.reason;
  const nativeTrajectories = [];
  const nativeProbeChecks = [];
  let nativeE2ePassed = 0;
  const nativeE2eTotal = 8;

  if (browser.status === 'READY') {
    let target = null;
    let cdp = null;
    try {
      target = await createTarget(browser.httpBase);
      cdp = connectCdp(target.webSocketDebuggerUrl);
      await cdp.opened;
      await cdp.call('Page.enable');
      await cdp.call('Runtime.enable');

      const visit = async (entry, scenario) => {
        await navigate(cdp, `${server.origin}${entry.path}?scenario=${encodeURIComponent(scenario)}`);
      };

      for (const familyCode of ['F7', 'F8']) {
        const entry = FAMILIES[familyCode];

        // Trajectory 1: Live input + submit through runBrowserSearchGoal with model decision
        {
          const caseId = `${familyCode}-native-e2e-input-submit`;
          try {
            await visit(entry, 'input-normal');
            const episodes = [];
            const rootOutcomes = [];
            const nativeRes = createIndependentNativeResources(cdp, entry, {
              candidate,
              episodes,
              rootOutcomes,
            });
            const response = await runBrowserSearchGoal({
              requestId: caseId,
              goal: goalFor(entry, 'root'),
              satisfactionThreshold: 100,
              bindings: bindingsFor(entry.family),
              maxResultReads: 2,
            }, nativeRes.searchResources);
            const counters = nativeRes.counters();
            const actions = episodes.map((ep) => ep.decision?.step?.head ?? ep.action);
            const ok = response.kind === 'run_result'
              && counters.textWriteCount === 1
              && counters.submitCount === 1
              && actions.includes('input')
              && actions.includes('submit');
            if (!ok) {
              throw new TypeError(
                `${caseId} trajectory mismatch: kind=${response.kind}, writes=${counters.textWriteCount}, submits=${counters.submitCount}, actions=${JSON.stringify(actions)}`,
              );
            }
            nativeE2ePassed += 1;
            nativeTrajectories.push({
              id: caseId,
              family: familyCode,
              status: 'PASS',
              actions,
              counters: {
                textWriteCount: counters.textWriteCount,
                submitCount: counters.submitCount,
                expandRangeCount: counters.expandRangeCount,
                readResultsCount: counters.readResultsCount,
              },
              rootResult: response.report?.rootEvaluation?.result ?? null,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordFailure('nativeCdpCandidateTrajectory', caseId, 'native-e2e', 'PASS', 'FAIL', {error: message});
            nativeTrajectories.push({id: caseId, family: familyCode, status: 'FAIL', error: message});
          }
        }

        // Trajectory 2: Range expansion via #load-more through runBrowserSearchEpisode with model decision
        {
          const caseId = `${familyCode}-native-e2e-load-more-expand`;
          try {
            await visit(entry, 'range-expand');
            const nativeRes = createIndependentNativeResources(cdp, entry, {
              candidate,
              preferLoadMoreButton: true,
              waitAfterExpandMs: 260,
            });
            const rawBefore = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairBefore = nativeObservationPair(rawBefore, entry.family, 1);
            const baseline = submissionBaselineFor(entry.fixtureFor('range-expand'), entry.family);
            const episode = await runBrowserSearchEpisode({
              goal: goalFor(entry, 'results'),
              bindings: bindingsFor(entry.family),
              maxResultReads: 2,
              submissionBaseline: baseline,
              checkedObservationId: pairBefore.search.observationId,
            }, nativeRes.searchResources);
            const counters = nativeRes.counters();
            const expandEvidence = counters.expandEvidenceLog.at(-1);
            const rawAfter = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairAfter = nativeObservationPair(
              rawAfter,
              entry.family,
              2,
              expandEvidence?.classified?.actionMechanicalEffect ?? null,
            );
            const afterEval = evaluateCandidateOnState(entry, {
              observation: pairAfter.search,
              inputObservation: pairAfter.input,
              checkedObservationId: pairAfter.search.observationId,
              submissionBaseline: baseline,
            }, 'results', candidate);
            const ok = episode.decision?.step?.head === 'expand_range'
              && counters.expandRangeCount === 1
              && expandEvidence?.classified?.factsComplete === true
              && expandEvidence?.classified?.actionMechanicalEffect === 'displaced_or_triggered'
              && rawAfter.mainItems.length === 12
              && rawAfter.batchRef?.endsWith(':batch-2')
              && afterEval.step.head === 'NOOP';
            if (!ok) {
              throw new TypeError(
                `${caseId} mismatch: step=${episode.decision?.step?.head}, afterStep=${afterEval.step.head}, items=${rawAfter.mainItems.length}, batch=${rawAfter.batchRef}`,
              );
            }
            nativeE2ePassed += 1;
            nativeTrajectories.push({
              id: caseId,
              family: familyCode,
              status: 'PASS',
              stepBefore: episode.decision?.step?.head,
              stepAfter: afterEval.step.head,
              expandEvidence: expandEvidence?.classified ?? null,
              batchRefAfter: rawAfter.batchRef,
              itemCountAfter: rawAfter.mainItems.length,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordFailure('nativeCdpCandidateTrajectory', caseId, 'native-e2e', 'PASS', 'FAIL', {error: message});
            nativeTrajectories.push({id: caseId, family: familyCode, status: 'FAIL', error: message});
          }
        }

        // Trajectory 3: Real scroll-driven batch progression on range-6a-hasmore with model decision
        {
          const caseId = `${familyCode}-native-e2e-scroll-batch`;
          try {
            await visit(entry, 'range-6a-hasmore');
            const nativeRes = createIndependentNativeResources(cdp, entry, {
              candidate,
              preferLoadMoreButton: false,
              waitAfterExpandMs: 260,
            });
            const rawBefore = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairBefore = nativeObservationPair(rawBefore, entry.family, 1);
            const baseline = submissionBaselineFor(entry.fixtureFor('range-6a-hasmore'), entry.family);
            const episode = await runBrowserSearchEpisode({
              goal: goalFor(entry, 'results'),
              bindings: bindingsFor(entry.family),
              maxResultReads: 2,
              submissionBaseline: baseline,
              checkedObservationId: pairBefore.search.observationId,
            }, nativeRes.searchResources);
            const counters = nativeRes.counters();
            const expandEvidence = counters.expandEvidenceLog.at(-1);
            const rawAfter = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const ok = episode.decision?.step?.head === 'expand_range'
              && counters.expandRangeCount === 1
              && expandEvidence?.classified?.factsComplete === true
              && expandEvidence?.classified?.actionMechanicalEffect === 'displaced_or_triggered'
              && expandEvidence?.method !== 'js'
              && rawAfter.mainItems.length === 12
              && rawAfter.batchRef?.endsWith(':batch-2');
            if (!ok) {
              throw new TypeError(
                `${caseId} mismatch: step=${episode.decision?.step?.head}, items=${rawAfter.mainItems.length}, batch=${rawAfter.batchRef}`,
              );
            }
            nativeE2ePassed += 1;
            nativeTrajectories.push({
              id: caseId,
              family: familyCode,
              status: 'PASS',
              stepBefore: episode.decision?.step?.head,
              scrollMethod: expandEvidence?.method ?? null,
              expandEvidence: expandEvidence?.classified ?? null,
              batchRefAfter: rawAfter.batchRef,
              itemCountAfter: rawAfter.mainItems.length,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordFailure('nativeCdpCandidateTrajectory', caseId, 'native-e2e', 'PASS', 'FAIL', {error: message});
            nativeTrajectories.push({id: caseId, family: familyCode, status: 'FAIL', error: message});
          }
        }

        // Trajectory 4: 6A async loading wait + 6A unknown DEFER + 6B bottom NOOP + BP11b non-bottom NOOP
        {
          const caseId = `${familyCode}-native-e2e-6a-6b-boundaries`;
          try {
            // 6A loading
            await visit(entry, 'range-6a-loading');
            await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
            const rawLoading = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairLoading = nativeObservationPair(rawLoading, entry.family, 1, 'displaced_or_triggered');
            const loadingEval = evaluateCandidateOnState(entry, {
              observation: pairLoading.search,
              inputObservation: pairLoading.input,
              checkedObservationId: pairLoading.search.observationId,
              submissionBaseline: submissionBaselineFor(entry.fixtureFor('range-6a-loading'), entry.family),
            }, 'results', candidate);
            assert(
              loadingEval.relation?.head === 'submitted_pending_or_stale'
                && loadingEval.step.head === 'read_or_reobserve',
              `${familyCode} 6A loading expected submitted_pending_or_stale/read_or_reobserve, got ${loadingEval.relation?.head}/${loadingEval.step.head}`,
            );
            await delay(300);

            // 6A unknown hasMore -> DEFER
            await visit(entry, 'range-6a-unknown');
            await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
            const rawUnknown = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairUnknown = nativeObservationPair(rawUnknown, entry.family, 2, 'displaced_or_triggered');
            const unknownEval = evaluateCandidateOnState(entry, {
              observation: pairUnknown.search,
              inputObservation: pairUnknown.input,
              checkedObservationId: pairUnknown.search.observationId,
              submissionBaseline: submissionBaselineFor(entry.fixtureFor('range-6a-unknown'), entry.family),
            }, 'results', candidate);
            assert(
              unknownEval.step.head === 'DEFER',
              `${familyCode} 6A unknown expected DEFER, got ${unknownEval.step.head}`,
            );

            // 6B bottom terminal -> NOOP
            await visit(entry, 'range-6b-bottom');
            await nativeScrollToBottom(cdp, entry.selectors.scrollBox);
            const rawBottom = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairBottom = nativeObservationPair(rawBottom, entry.family, 3, 'displaced_or_triggered');
            const bottomEval = evaluateCandidateOnState(entry, {
              observation: pairBottom.search,
              inputObservation: pairBottom.input,
              checkedObservationId: pairBottom.search.observationId,
              submissionBaseline: submissionBaselineFor(entry.fixtureFor('range-6b-bottom'), entry.family),
            }, 'results', candidate);
            assert(
              bottomEval.step.head === 'NOOP',
              `${familyCode} 6B bottom expected NOOP, got ${bottomEval.step.head}`,
            );

            // BP11b non-bottom terminal -> NOOP at scrollTop=0
            await visit(entry, 'probe-bp11b');
            const rawNonBottom = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            const pairNonBottom = nativeObservationPair(rawNonBottom, entry.family, 4);
            const nonBottomEval = evaluateCandidateOnState(entry, {
              observation: pairNonBottom.search,
              inputObservation: pairNonBottom.input,
              checkedObservationId: pairNonBottom.search.observationId,
              submissionBaseline: submissionBaselineFor(entry.fixtureFor('probe-bp11b'), entry.family),
            }, 'results', candidate);
            assert(
              rawNonBottom.scroll?.scrollTop === 0
                && pairNonBottom.geometry === false
                && pairNonBottom.search.rangeExpansion.collectionTerminal === true
                && nonBottomEval.step.head === 'NOOP',
              `${familyCode} BP11b non-bottom expected NOOP at scrollTop=0, got ${nonBottomEval.step.head}`,
            );

            nativeE2ePassed += 1;
            nativeTrajectories.push({
              id: caseId,
              family: familyCode,
              status: 'PASS',
              boundaries: {
                loadingStep: loadingEval.step.head,
                unknownStep: unknownEval.step.head,
                bottomStep: bottomEval.step.head,
                nonBottomStep: nonBottomEval.step.head,
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordFailure('nativeCdpCandidateTrajectory', caseId, 'native-e2e', 'PASS', 'FAIL', {error: message});
            nativeTrajectories.push({id: caseId, family: familyCode, status: 'FAIL', error: message});
          }
        }
      }

      // Also run all native counterexample probes against candidate under real CDP
      let nativeRev = 100;
      const runNativeCandidateBp12 = async (entry) => {
        const url = (scenario) => `${server.origin}${entry.path}?scenario=${encodeURIComponent(scenario)}`;
        const req = {
          requestId: 'bp12-native-candidate-input',
          goal: {kind: 'BrowserInput', targetText: entry.family.query},
          satisfactionThreshold: 100,
          bindings: {
            documentRef: entry.family.documentRef,
            scopeRef: entry.family.scopeRef,
            targetRef: entry.family.inputRef,
          },
        };
        await navigate(cdp, url('probe-bp12'));
        const inputCase = createIndependentNativeResources(cdp, entry, {candidate, failAfterInput: true});
        const inputEpisode = await runBrowserInputEpisode(req, inputCase.inputResources);

        await navigate(cdp, url('probe-bp12'));
        const searchCase = createIndependentNativeResources(cdp, entry, {candidate, failAfterInput: true});
        const searchEpisode = await runBrowserSearchEpisode({
          goal: goalFor(entry, 'input'),
          bindings: bindingsFor(entry.family),
          maxResultReads: 1,
          submissionBaseline: null,
          checkedObservationId: null,
        }, searchCase.searchResources);

        await navigate(cdp, url('probe-bp12'));
        const inputFailCase = createIndependentNativeResources(cdp, entry, {
          candidate,
          failAfterInput: true,
          failAfterAction: true,
        });
        const inputFailEpisode = await runBrowserInputEpisode(req, inputFailCase.inputResources);

        await navigate(cdp, url('probe-bp12'));
        const searchFailCase = createIndependentNativeResources(cdp, entry, {
          candidate,
          failAfterInput: true,
          failAfterAction: true,
        });
        const searchFailEpisode = await runBrowserSearchEpisode({
          goal: goalFor(entry, 'input'),
          bindings: bindingsFor(entry.family),
          maxResultReads: 1,
          submissionBaseline: null,
          checkedObservationId: null,
        }, searchFailCase.searchResources);

        const subEpisodes = [];
        await navigate(cdp, url('input-normal'));
        const subCase = createIndependentNativeResources(cdp, entry, {
          candidate,
          failAfterInput: false,
          episodes: subEpisodes,
        });
        const subResponse = await runBrowserSearchGoal({
          requestId: 'bp12-native-candidate-recursive-submission',
          goal: goalFor(entry, 'root'),
          satisfactionThreshold: 100,
          bindings: bindingsFor(entry.family),
          maxResultReads: 1,
        }, subCase.searchResources);

        const summarize = (episode, counters, observedValue) => ({
          episode,
          nativeWrites: counters.textWriteCount,
          submitCount: counters.submitCount,
          dispatchedValue: observedValue,
        });
        return {
          input: summarize(
            inputEpisode,
            inputCase.counters(),
            inputEpisode.state?.observation?.target?.value?.value ?? null,
          ),
          search: summarize(
            searchEpisode,
            searchCase.counters(),
            searchEpisode.state?.observation?.input?.value?.value ?? null,
          ),
          inputObservationFailure: summarize(inputFailEpisode, inputFailCase.counters(), null),
          searchObservationFailure: summarize(searchFailEpisode, searchFailCase.counters(), null),
          submission: {
            kind: subResponse.kind ?? null,
            rootResult: subResponse.report?.rootEvaluation?.result ?? null,
            nativeWrites: subCase.counters().textWriteCount,
            submitCount: subCase.counters().submitCount,
            actions: subEpisodes.map((ep) => ep.action),
            episodes: subEpisodes,
          },
        };
      };

      for (const probe of PROBES) {
        const entry = FAMILIES[probe.family];
        for (const [index, variant] of (probe.variants ?? [probe]).entries()) {
          const variantId = `${probe.id}${probe.variants ? String.fromCharCode(97 + index) : ''}`;
          await visit(entry, variant.scenario);
          const sideEffects = {textWriteCount: 0, submitCount: 0, expandRangeCount: 0, scrollMethod: null};
          let actionPolicy = null;
          if (probe.id === 'BP02' || probe.id === 'BP03') {
            if (probe.id === 'BP02') {
              const preRaw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
              const prePair = nativeObservationPair(preRaw, entry.family, ++nativeRev);
              actionPolicy = evaluateCandidateOnState(entry, {
                observation: prePair.search,
                inputObservation: prePair.input,
                checkedObservationId: null,
                submissionBaseline: submissionBaselineFor(entry.fixtureFor(variant.scenario), entry.family),
              }, 'input', candidate);
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
            nativeBp12 = await runNativeCandidateBp12(entry);
            const cases = ['input', 'search', 'inputObservationFailure', 'searchObservationFailure'];
            sideEffects.textWriteCount = cases.reduce(
              (sum, key) => sum + nativeBp12[key].nativeWrites,
              nativeBp12.submission.nativeWrites,
            );
            sideEffects.submitCount = cases.reduce(
              (sum, key) => sum + nativeBp12[key].submitCount,
              nativeBp12.submission.submitCount,
            );
            await visit(entry, 'probe-bp12');
            raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            pair = nativeObservationPair(raw, entry.family, ++nativeRev);
          } else {
            raw = await observeNative(cdp, entry.selectors, entry.family.inputRef);
            pair = nativeObservationPair(raw, entry.family, ++nativeRev);
          }
          const state = {
            observation: pair.search,
            inputObservation: pair.input,
            checkedObservationId: probe.phase === 'results' ? pair.search.observationId : null,
            submissionBaseline: submissionBaselineFor(entry.fixtureFor(variant.scenario), entry.family),
          };
          const evaluated = actionPolicy ?? evaluateCandidateOnState(entry, state, probe.phase, candidate);
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
            const checkFn = VERIFY_PROBE_CHECKS[checkName];
            try {
              assert(evaluated.input.head === variant.expectedInput, `${variantId} native B-S1.1: ${evaluated.input.head}`);
              if (variant.expectedRelation) {
                assert(
                  evaluated.relation?.head === variant.expectedRelation,
                  `${variantId} native B-S1.2: ${evaluated.relation?.head ?? null}`,
                );
              }
              assert(evaluated.step.head === variant.expectedStep, `${variantId} native B-S1.3: ${evaluated.step.head}`);
              checkFn(evaluated.step, context);
              nativeProbeChecks.push({id: `${variantId}-native`, check: checkName, status: 'PASS'});
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              recordFailure(
                'nativeCdpCandidateTrajectory',
                `${variantId}-native:${checkName}`,
                'native-probe',
                'PASS',
                'FAIL',
                {error: message},
              );
              nativeProbeChecks.push({id: `${variantId}-native`, check: checkName, status: 'FAIL', error: message});
            }
          }
        }
      }
    } catch (error) {
      nativeCdpStatus = 'UNVERIFIED';
      unverifiedReason = error instanceof Error ? error.message : String(error);
    } finally {
      if (cdp) cdp.close();
      if (target) await closeTarget(browser.httpBase, target.id);
      await stopChrome(browser);
      await server.close();
    }
  } else {
    await server.close();
  }

  const denominators = {
    N_B_S1_input_policy: {
      passed: inputPolicyPassed,
      total: inputPolicyTotal,
      status: inputPolicyPassed === inputPolicyTotal ? 'PASS' : 'FAIL',
    },
    N_B_S1_query_relation: {
      passed: queryRelationPassed,
      total: queryRelationTotal,
      status: queryRelationPassed === queryRelationTotal ? 'PASS' : 'FAIL',
    },
    N_B_S1_step_policy: {
      passed: stepPolicyPassed,
      total: stepPolicyTotal,
      status: stepPolicyPassed === stepPolicyTotal ? 'PASS' : 'FAIL',
    },
    N_B_S1_range_boundary_6A_6B: {
      passed: rangeBoundaryCounts.passed,
      total: rangeBoundaryCounts.total,
      status: rangeBoundaryCounts.passed === rangeBoundaryCounts.total ? 'PASS' : 'FAIL',
      subDenominators: {
        '6A_loading_wait': rangeBoundaryCounts['6A_loading_wait'],
        '6A_unknown_terminal_preserved': rangeBoundaryCounts['6A_unknown_terminal_preserved'],
        '6B_bottom_terminal_stopped': rangeBoundaryCounts['6B_bottom_terminal_stopped'],
        'BP11b_non_bottom_terminal_stopped': rangeBoundaryCounts['BP11b_non_bottom_terminal_stopped'],
      },
    },
    N_B_S1_counterexample_probes: {
      passed: probeChecksPassed,
      total: probeChecksTotal,
      status: probeChecksPassed === probeChecksTotal ? 'PASS' : 'FAIL',
    },
    N_B_S1_native_e2e: {
      passed: nativeCdpStatus === 'READY' ? nativeE2ePassed : 0,
      total: nativeE2eTotal,
      status: nativeCdpStatus !== 'READY'
        ? 'UNVERIFIED'
        : (nativeE2ePassed === nativeE2eTotal && nativeProbeChecks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL'),
    },
    N_B_S1_historical_regression: {
      passed: null,
      total: null,
      status: 'EXTERNAL_SUITE',
    },
  };

  const hasAnyFailure = failedCases.length > 0;
  const allSyntheticAndConsumerPass = denominators.N_B_S1_input_policy.status === 'PASS'
    && denominators.N_B_S1_query_relation.status === 'PASS'
    && denominators.N_B_S1_step_policy.status === 'PASS'
    && denominators.N_B_S1_range_boundary_6A_6B.status === 'PASS'
    && denominators.N_B_S1_counterexample_probes.status === 'PASS';
  const outcome = computeIndependentEvaluationOutcome({
    hasAnyFailure,
    allSyntheticAndConsumerPass,
    nativeCdpStatus,
    nativeE2eStatus: denominators.N_B_S1_native_e2e.status,
  });

  return {
    mode: 'evaluate-candidate',
    status: outcome.overallStatus,
    localSuiteStatus: outcome.localSuiteStatus,
    localSuitePassed: outcome.localSuitePassed,
    candidateEvaluated: true,
    oneShotHoldoutConsumed: true,
    candidateDir: candidate.candidateDir,
    files: candidate.files,
    decisionBinding: {
      id: candidate.decision.id,
      source: candidate.decision.source,
    },
    denominators,
    ledgers: {
      syntheticProjectionCascade: {
        status: ledgerARows.every((r) => r.status === 'PASS') ? 'PASS' : 'FAIL',
        rows: ledgerARows,
      },
      publicConsumerEpisodeEvaluation: {
        status: ledgerBRows.every((r) => r.status === 'PASS')
          && syntheticProbeResults.every((p) => p.status === 'PASS') ? 'PASS' : 'FAIL',
        rows: ledgerBRows,
        probes: syntheticProbeResults,
      },
      nativeCdpCandidateTrajectory: {
        status: denominators.N_B_S1_native_e2e.status,
        nativeCdpStatus,
        unverifiedReason,
        trajectories: nativeTrajectories,
        probes: nativeProbeChecks,
      },
    },
    failedCases,
    firstFailure: failedCases[0] ?? null,
    unknownFactCases,
    nativeCdpStatus,
    unverifiedReason,
    fullyVerified: outcome.fullyVerified,
    unseenFeatureCapabilityVerified: outcome.unseenFeatureCapabilityVerified,
  };
}

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

async function main() {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
