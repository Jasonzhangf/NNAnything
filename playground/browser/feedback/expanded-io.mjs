import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import {
  BROWSER_STRATEGY_EVALUATOR_ID,
  BROWSER_STRATEGY_SELECTOR_ID,
  createBrowserStrategyInitialObservation,
} from 'nnanything/browser-strategy';
import { createZeroFeedbackProfile, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { createZeroBrowserSingleActionProfile, validateBrowserSingleActionProfile } from 'nnanything/browser-single-action';
import { createZeroBrowserStrategyProfile, validateBrowserStrategyProfile } from 'nnanything/browser-strategy';
import { explicitRejectionReceipt } from './fixtures/receipts.mjs';
import { renderFamilyA } from './fixtures/family-a.mjs';
import { renderFamilyB } from './fixtures/family-b.mjs';

const CDP_HTTP = process.env.B_FEEDBACK_CDP ?? process.env.BFEEDBACK_CDP_URL ?? 'http://127.0.0.1:9333';
const CONFIG_PATH = process.env.B_FEEDBACK_CASE_CONFIG;
if (!CONFIG_PATH) throw new Error('B_FEEDBACK_CASE_CONFIG is required');
const config = JSON.parse(await readFile(resolve(CONFIG_PATH), 'utf8'));

const REQUEST_SCHEMA = 'nnanything.recursive-goal.request.v1';
const NATIVE_SKILL = 'browser.expand.native';
const ROLE_SKILL = 'browser.expand.role';

const family = config.family === 'A' ? 'A' : 'B';
const render = family === 'A' ? renderFamilyA : renderFamilyB;
const selectors = family === 'A'
  ? { scope: '#workspace', goal: '#goal-panel', primary: '#primary-control', secondary: '#secondary-control' }
  : { scope: '#shell', goal: '#panel-region', primary: '#run-primary', secondary: '#run-secondary' };

const bundled = await build({
  entryPoints: [resolve(import.meta.dirname, 'expanded-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  logLevel: 'silent',
});
const entryCode = bundled.outputFiles[0].text;

function controlOf(snapshot) {
  return { documentRef: snapshot.documentRef, observationId: snapshot.observationId, revision: snapshot.revision };
}

async function profile(path, validate, fallback) {
  if (path) return validate(JSON.parse(await readFile(resolve(path), 'utf8')));
  return fallback();
}

function diagnosticStrategyProfile(kind) {
  const zero = createZeroBrowserStrategyProfile();
  const choose = zero.heads.indexOf('choose');
  const wire = name => zero.wires.indexOf(name);
  const weights = zero.weights.map(row => [...row]);
  if (kind === 'tie') {
    return validateBrowserStrategyProfile({ ...zero, weights });
  }
  weights[choose][wire('nativeButton')] = 2;
  weights[choose][wire('explicitRoleButton')] = -1;
  return validateBrowserStrategyProfile({ ...zero, weights });
}

async function loadProfiles() {
  const feedbackProfile = await profile(
    process.env.B_FEEDBACK_F1_PROFILE ?? process.env.BFEEDBACK_FEEDBACK_PROFILE,
    validateFeedbackProfile, createZeroFeedbackProfile,
  );
  const atomicProfile = await profile(
    process.env.B_FEEDBACK_ATOMIC_PROFILE ?? process.env.BFEEDBACK_ATOMIC_PROFILE,
    validateBrowserSingleActionProfile, createZeroBrowserSingleActionProfile,
  );
  let strategyProfile;
  if (config.diagnostic === 'tie' || config.diagnostic === 'non-positive-secondary') {
    strategyProfile = diagnosticStrategyProfile(config.diagnostic);
  } else {
    strategyProfile = await profile(
      process.env.B_FEEDBACK_STRATEGY_PROFILE ?? process.env.BFEEDBACK_F2_INITIAL,
      validateBrowserStrategyProfile, createZeroBrowserStrategyProfile,
    );
  }
  return { feedbackProfile, atomicProfile, strategyProfile };
}

async function createOwnTarget() {
  const url = new URL('/json/new', CDP_HTTP);
  url.searchParams.set('url', 'about:blank');
  const response = await fetch(url, { method: 'PUT' });
  if (!response.ok) throw new Error(`create target failed: HTTP ${response.status}`);
  return await response.json();
}

async function attachTarget(targetId) {
  const response = await fetch(`${CDP_HTTP}/json/list`);
  if (!response.ok) throw new Error(`list targets failed: HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find(entry => entry.id === targetId);
  if (!target) throw new Error(`target ${targetId} not found`);
  return target;
}

async function closeOwnTarget(targetId) {
  try {
    await fetch(`${CDP_HTTP}/json/close/${encodeURIComponent(targetId)}`, { method: 'PUT' });
  } catch {
    // best effort
  }
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const opened = new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message || JSON.stringify(message.error)}`));
    else waiter.resolve(message.result ?? {});
  });
  const call = (method, params = {}) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method}: timeout`)); }, 15000);
      pending.set(id, { resolve: res, reject: rej, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (response.exceptionDetails) {
      const text = response.exceptionDetails.text || JSON.stringify(response.exceptionDetails);
      throw new Error(`Runtime.evaluate failed: ${text}`);
    }
    return response.result?.value;
  };
  return { socket, opened, call, evaluate, close: () => socket.close() };
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function pageHtml() {
  return render({ caseId: config.caseId, mode: config.mode });
}

export async function createBrowserStrategyRun() {
  const profiles = await loadProfiles();
  let target;
  let ownsTarget = false;
  if (config.targetId) {
    target = await attachTarget(config.targetId);
  } else {
    target = await createOwnTarget();
    ownsTarget = true;
  }
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  if (ownsTarget || config.rerender) {
    const frameTree = await cdp.call('Page.getFrameTree', {});
    const frameId = frameTree.frameTree.frame.id;
    await cdp.call('Page.setDocumentContent', { frameId, html: pageHtml() });
    await delay(300);
  }
  await cdp.evaluate(entryCode);
  await delay(120);
  if (!await cdp.evaluate("typeof window.__bFeedbackCollect === 'function'")) {
    throw new Error('expanded live collector did not install');
  }

  const state = {
    cdp,
    targetId: target.id,
    revision: config.continuation?.state?.browser?.revision ?? 0,
    firstObs: null,
    latestObs: null,
    dispatched: false,
    clicks: [],
    refs: null,
  };

  const collect = async () => {
    const revision = state.revision;
    const result = await state.cdp.evaluate(`window.__bFeedbackCollect(${JSON.stringify({
      scopeSelector: selectors.scope,
      goalSelector: selectors.goal,
      targetSelectors: [selectors.primary, selectors.secondary],
      documentRef: config.documentRef,
      observationId: `${config.documentRef}:${revision}`,
      revision,
    })})`);
    return result;
  };

  const observe = async () => {
    if (config.observeFailAfterDispatch && state.dispatched) {
      throw new Error('injected post-input read failure');
    }
    if (config.stalePost && state.dispatched) {
      return structuredClone(state.firstObs);
    }
    state.revision += 1;
    const result = await collect();
    state.latestObs = result.snapshot;
    if (state.refs === null) state.refs = result;
    if (state.firstObs === null) state.firstObs = result.snapshot;
    return result.snapshot;
  };

  const nativeClick = async invocation => {
    const selector = invocation.targetRef === state.refs.targetRefs[selectors.primary] ? selectors.primary : selectors.secondary;
    if (config.mode === 'explicit-rejection-no-message') {
      // A typed explicit rejection is a not-dispatched receipt with no error
      // text. The contract requires not-dispatched receipts to carry
      // effectKnowledge=none, so "unknown effects" belongs to C05 instead.
      return explicitRejectionReceipt();
    }
    const point = await state.cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('target geometry unavailable');
    for (const event of [
      { type: 'mouseMoved', button: 'none', buttons: 0, x: point.x, y: point.y },
      { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: point.x, y: point.y },
      { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: point.x, y: point.y },
    ]) {
      await state.cdp.call('Input.dispatchMouseEvent', event);
    }
    await delay(80);
    state.dispatched = true;
    state.clicks.push({ targetRef: invocation.targetRef, selector, kind: 'cdp.Input' });
    if (config.mode === 'dispatch-then-throw' || config.mode === 'achieved-then-throw' || config.mode === 'execution-and-observation-fail') {
      const error = new Error('transport error after native dispatch');
      error.dispatched = true;
      throw error;
    }
    if (config.mode === 'effects-unknown') {
      return { dispatched: true, ok: true, effectKnowledge: 'unknown', source: 'cdp.Input', error: null };
    }
    if (config.mode === 'other-effect') {
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'cdp.Input', error: null };
    }
    return { dispatched: true, ok: true, effectKnowledge: 'none', source: 'cdp.Input', error: null };
  };

  const initial = await observe();
  const resources = {
    profile: profiles.strategyProfile,
    atomicProfile: profiles.atomicProfile,
    feedbackProfile: profiles.feedbackProfile,
    registry: [
      {
        strategyRef: 'strategy-primary',
        skillId: NATIVE_SKILL,
        targetRef: state.refs.targetRefs[selectors.primary],
        goalRegionRef: state.refs.goalRegionRef,
        equivalenceSetRef: 'same-expansion-effect',
        documentRef: config.documentRef,
        scopeRef: state.refs.scopeRef,
        operation: 'CLICK',
        evidenceRefs: ['proof:equivalence:primary'],
      },
      {
        strategyRef: 'strategy-secondary',
        skillId: ROLE_SKILL,
        targetRef: state.refs.targetRefs[selectors.secondary],
        goalRegionRef: state.refs.goalRegionRef,
        equivalenceSetRef: 'same-expansion-effect',
        documentRef: config.documentRef,
        scopeRef: state.refs.scopeRef,
        operation: 'CLICK',
        evidenceRefs: ['proof:equivalence:secondary'],
      },
    ],
    grantedEffects: new Set(config.revokePermission ? [] : ['browser.nativeClick', 'filesystem.write']),
    observe,
    currentControl: () => controlOf(state.latestObs ?? state.firstObs),
    nativeClick,
    collectAtomic: async () => {},
    collectStep: async () => {},
    proveNoEffect: input => {
      if (config.mode === 'other-effect' || config.mode === 'effects-unknown') return null;
      const post = input.result.newState;
      if (post === null) return null;
      return {
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
    collectRoot: async () => ({ receiptId: 'b-feedback-root-collection' }),
    cleanupRoot: async () => ({ receiptId: 'b-feedback-root-cleanup' }),
  };

  const bindings = {
    documentRef: config.documentRef,
    scopeRef: state.refs.scopeRef,
    goalRegionRef: state.refs.goalRegionRef,
    equivalenceSetRef: 'same-expansion-effect',
  };
  const policy = {
    kind: 'bounded_strategy_retry.v1',
    selectorId: BROWSER_STRATEGY_SELECTOR_ID,
    strategySkillIds: [NATIVE_SKILL, ROLE_SKILL],
    sameFailureLimit: config.sameFailureLimit ?? 2,
    maxAtomicAttempts: config.maxAtomicAttempts ?? 4,
  };
  if (config.tamper === 'policy') policy.sameFailureLimit = 3;

  const request = {
    schema: REQUEST_SCHEMA,
    requestId: `b-feedback-${config.caseId}-${family}`,
    rootGoal: { kind: 'SetExpanded', regionRef: state.refs.goalRegionRef, desired: true },
    satisfactionThreshold: 100,
    rootBindings: bindings,
    state: { browser: initial, history: [] },
    rootEvaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
    rootSelectorId: BROWSER_STRATEGY_SELECTOR_ID,
    limits: { maxTransitions: 32, maxDepth: 4, maxDerivedGoals: 4 },
    initialObservation: createBrowserStrategyInitialObservation(
      `b-feedback-${config.caseId}-${family}-initial`,
      { browser: initial, history: [] },
      state.refs.goalRegionRef,
    ),
    retryPolicy: policy,
    invocation: { maxAtomicDispatches: 1 },
  };
  if (config.continuation) {
    request.state = config.continuation.state;
    request.continuation = config.continuation.continuation;
    delete request.initialObservation;
  }

  return {
    mode: 'external',
    source: `b-feedback-${family}-${config.caseId}`,
    request,
    resources,
    targetId: target.id,
    clicks: state.clicks,
    close: async () => {
      cdp.close();
      if (ownsTarget && config.keepTarget !== true) await closeOwnTarget(target.id);
    },
  };
}
