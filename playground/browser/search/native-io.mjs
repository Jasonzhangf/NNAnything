import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CDP_HTTP = process.env.BSEARCH_CDP_URL ?? '';
const FIXTURE_ORIGIN = process.env.BSEARCH_FIXTURE_ORIGIN ?? '';
const CASE_DIR = process.env.BSEARCH_CASE_DIR ?? '';
const READ_TIMEOUT_MS = Number(process.env.BSEARCH_READ_TIMEOUT_MS ?? 1000);

if (!CASE_DIR) throw new Error('BSEARCH_CASE_DIR is required');
if (!Number.isFinite(READ_TIMEOUT_MS) || READ_TIMEOUT_MS <= 0) {
  throw new Error('BSEARCH_READ_TIMEOUT_MS must be a positive number');
}
const config = JSON.parse(await readFile(resolve(CASE_DIR, 'case.json'), 'utf8'));

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function createOwnTarget() {
  if (!CDP_HTTP) throw new Error('BSEARCH_CDP_URL is required');
  const url = new URL('/json/new', CDP_HTTP);
  url.searchParams.set('url', 'about:blank');
  const response = await fetch(url, { method: 'PUT' });
  if (!response.ok) throw new Error(`create target failed: HTTP ${response.status}`);
  return response.json();
}

async function closeOwnTarget(targetId) {
  try {
    await fetch(`${CDP_HTTP}/json/close/${encodeURIComponent(targetId)}`, { method: 'PUT' });
  } catch {
    // best effort; the target may already be gone
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
  const eventWaiters = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message || JSON.stringify(message.error)}`));
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
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`${method}: timeout`));
      }, 15000);
      pending.set(id, { resolve: res, reject: rej, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const once = (method) => new Promise((res) => eventWaiters.set(method, res));
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (response.exceptionDetails) {
      const text = response.exceptionDetails.text || JSON.stringify(response.exceptionDetails);
      throw new Error(`Runtime.evaluate failed: ${text}`);
    }
    return response.result?.value;
  };
  return { socket, opened, call, once, evaluate, close: () => socket.close() };
}

function observeFn(config) {
  const sel = config.selectors;
  const input = document.querySelector(sel.input);
  const submission = document.querySelector(sel.submittedState);
  const requestState = document.querySelector(config.selectors?.requestState ?? '#request-state');
  const collection = document.querySelector(config.selectors?.collection ?? '#catalog-table, #split-main-list');
  const attr = (el, name) => {
    const value = el && el.getAttribute(name);
    return value == null || value === '' ? null : value;
  };
  const omitRefs = !!(config.projection && config.projection.omitRequestRefs);
  const unread = new Set((config.projection && config.projection.unreadItemIndexes) || []);
  const elements = collection ? Array.from(collection.querySelectorAll(sel.mainItems)) : [];
  const scrollBox = document.querySelector('#result-scroll-box');
  // Range geometry is measured only on the contract-bound #result-scroll-box.
  // Never fall back to document.scrollingElement/documentElement: an absent
  // container and a failed measurement are distinct honest unknowns.
  let atGeometryBoundary = null;
  let geometryReason = null;
  if (scrollBox) {
    const clientHeight = scrollBox.clientHeight;
    const scrollHeight = scrollBox.scrollHeight;
    const scrollTop = scrollBox.scrollTop;
    if (Number.isFinite(clientHeight) && Number.isFinite(scrollHeight) && Number.isFinite(scrollTop)
      && clientHeight > 0 && scrollHeight > 0) {
      atGeometryBoundary = scrollTop + clientHeight >= scrollHeight - 1;
    } else {
      geometryReason = 'scroll_container_geometry_measurement_failed';
    }
  } else {
    geometryReason = 'scroll_container_absent';
  }
  // hasMore comes only from real explicit terminal evidence: data-has-more on
  // the request state, the collection terminal banner, or the load-more control.
  // Absent controls never synthesize a false terminal.
  let hasMore = null;
  const requestHasMore = attr(requestState, 'data-has-more');
  if (requestHasMore === 'true' || requestHasMore === 'false') {
    hasMore = requestHasMore === 'true';
  } else {
    const terminalBanner = document.querySelector('#collection-terminal-banner');
    const loadMore = document.querySelector('#load-more');
    const bannerHasMore = attr(terminalBanner, 'data-has-more');
    const bannerTerminal = attr(terminalBanner, 'data-terminal');
    if (bannerHasMore === 'false' || bannerTerminal === 'true') {
      hasMore = false;
    } else if (attr(loadMore, 'data-has-more') === 'true') {
      hasMore = true;
    }
  }
  const items = elements.map((el, index) => ({
    index,
    text: unread.has(index) ? null : (el.textContent || '').trim(),
  }));
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
  };
  const positive = (r) => r.width > 0 && r.height > 0;
  // Exposed rectangle = element box clipped by scrolling ancestors and the viewport,
  // then the top hit is taken from document.elementsFromPoint (single-action semantics).
  const exposedRectOf = (el) => {
    let rect = rectOf(el);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const style = getComputedStyle(a);
      if ([style.overflow, style.overflowX, style.overflowY].some(v => v && v !== 'visible')) {
        rect = intersect(rect, rectOf(a));
      }
    }
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    return intersect(rect, { x: 0, y: 0, width, height });
  };
  const hitCandidates = (rect) => {
    const points = [];
    const seen = new Set();
    const fractions = [[0.5, 0.5], [0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5],
      [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
    for (const [fx, fy] of fractions) {
      const point = { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
      const key = `${point.x},${point.y}`;
      if (!seen.has(key)) { seen.add(key); points.push(point); }
    }
    return points;
  };
  const measureHit = (el) => {
    if (typeof document.elementsFromPoint !== 'function') {
      return { hit: { status: 'unknown', reason: 'elementsFromPoint_unavailable' },
        point: { status: 'unknown', reason: 'native_hit_point_unavailable' } };
    }
    const exposed = exposedRectOf(el);
    if (!positive(exposed)) {
      return { hit: { status: 'observed', value: false }, point: { status: 'unknown', reason: 'no_hit_point' } };
    }
    for (const point of hitCandidates(exposed)) {
      let hits;
      try {
        hits = Array.from(document.elementsFromPoint(point.x, point.y));
      } catch {
        return { hit: { status: 'unknown', reason: 'elementsFromPoint_failed' },
          point: { status: 'unknown', reason: 'native_hit_point_unavailable' } };
      }
      const top = hits[0];
      if (top && (top === el || el.contains(top))) {
        return { hit: { status: 'observed', value: true }, point: { status: 'observed', value: point } };
      }
    }
    return { hit: { status: 'observed', value: false }, point: { status: 'unknown', reason: 'no_hit_point' } };
  };
  const measureTarget = () => {
    if (!input) return { present: false, reason: 'input_missing' };
    const tag = input.tagName.toLowerCase();
    const host = tag === 'input' || tag === 'textarea' ? tag
      : (input.isContentEditable || input.getAttribute('contenteditable') === 'true') ? 'contenteditable' : 'unknown';
    const type = tag === 'input' ? (input.getAttribute('type') || 'text') : tag;
    const ariaValue = (el, name) => {
      const raw = el.getAttribute(name);
      return raw === 'true' ? true : raw === 'false' ? false : null;
    };
    const ariaDisabled = ariaValue(input, 'aria-disabled');
    const ariaReadonly = ariaValue(input, 'aria-readonly');
    const nativeReadonly = input.readOnly === true;
    const readonlyState = nativeReadonly ? (ariaReadonly === false ? 'conflict' : 'readonly')
      : ariaReadonly === true ? 'conflict' : 'editable';
    const active = document.activeElement === input;
    const hitFacts = measureHit(input);
    return {
      present: true,
      ref: config.bindings.inputRef,
      connected: input.isConnected === true,
      currentRef: config.bindings.inputRef,
      host,
      contentEditable: host === 'contenteditable' || input.getAttribute('contenteditable') === 'true',
      type,
      value: type === 'password' || type === 'file' ? null : input.value,
      placeholder: input.getAttribute('placeholder'),
      nativeDisabled: input.disabled === true,
      ariaDisabled,
      nativeReadonly,
      ariaReadonly,
      readonlyState,
      editable: !(input.disabled || input.readOnly),
      activeElementRef: active ? config.bindings.inputRef : null,
      activeElementFocus: active,
      hit: hitFacts.hit,
      point: hitFacts.point,
    };
  };
  return {
    documentRef: config.bindings.documentRef,
    scopeRef: config.bindings.scopeRef,
    inputRef: config.bindings.inputRef,
    submitRef: config.bindings.submitRef,
    collectionRef: config.bindings.collectionRef,
    resultScopeRef: config.bindings.resultScopeRef,
    inputTag: input ? input.tagName.toLowerCase() : null,
    inputType: input ? (input.getAttribute('type') || 'text') : 'text',
    inputValue: input ? input.value : null,
    editable: input ? !(input.disabled || input.readOnly) : null,
    submittedQuery: attr(submission, 'data-submitted-query'),
    submittedRequestRef: omitRefs ? null : attr(submission, 'data-submitted-request-ref'),
    resultsQuery: attr(requestState, 'data-results-query'),
    resultsRequestRef: omitRefs ? null : attr(requestState, 'data-results-request-ref'),
    collectionRequestRef: omitRefs ? null : attr(requestState, 'data-results-request-ref'),
    batch: omitRefs ? null : attr(requestState, 'data-batch-ref'),
    request: attr(requestState, 'data-request-status') || 'unknown',
    display: attr(requestState, 'data-display') || 'unknown',
    access: attr(requestState, 'data-access') || 'unknown',
    atGeometryBoundary,
    geometryReason,
    hasMore,
    items,
    target: measureTarget(),
  };
}

export function buildObservation(raw, revision, rangeEffect = 'not_attempted') {
  const observationId = `search-observation-${revision}`;
  const evidence = [];
  const mark = (key, fact) => {
    const id = `${observationId}:${key}`;
    evidence.push({ id, source: 'cdp.read-only.observation', fact });
    return id;
  };
  const stringFact = (value, key) => {
    const id = mark(key, { value });
    if (value === null || value === undefined || value === '') return { status: 'unknown', reason: 'not_observable' };
    return { status: 'observed', value, evidenceRefs: [id] };
  };
  const boolFact = (value, key) => {
    const id = mark(key, { value });
    if (value === null || value === undefined) return { status: 'unknown', reason: 'not_observable' };
    return { status: 'observed', value: Boolean(value), evidenceRefs: [id] };
  };
  const rangeRequestState = ['loading', 'settled', 'error'].includes(raw.request)
    ? { status: 'observed', value: raw.request, evidenceRefs: [mark('range.requestState', { value: raw.request })] }
    : { status: 'unknown', reason: 'no_positive_request_state_source' };
  const rangeGeometry = raw.atGeometryBoundary === null || raw.atGeometryBoundary === undefined
    ? { status: 'unknown', reason: raw.geometryReason ?? 'not_measured' }
    : { status: 'observed', value: Boolean(raw.atGeometryBoundary), evidenceRefs: [mark('range.geometry', { value: raw.atGeometryBoundary })] };
  const rangeHasMore = boolFact(raw.hasMore, 'range.hasMore');
  const items = raw.items.map((item, index) => ({
    ref: `${raw.collectionRef}-item-${index}`,
    collectionRef: raw.collectionRef,
    role: 'main',
    text: item.text === null || item.text === ''
      ? { status: 'unknown', reason: 'not_read' }
      : { status: 'observed', value: item.text, evidenceRefs: [mark(`item.${index}`, { value: item.text })] },
  }));
  const observedTargetFact = (key, value) => {
    const id = mark(`target.${key}`, { value });
    return { status: 'observed', value, evidenceRefs: [id] };
  };
  const unknownTargetFact = (reason) => ({ status: 'unknown', reason });
  const nullableTargetFact = (key, value) => value === null || value === undefined
    ? observedTargetFact(key, null) : observedTargetFact(key, value);
  const buildTarget = (t) => {
    if (!t || t.present !== true) return undefined;
    return {
      ref: t.ref,
      connected: observedTargetFact('connected', t.connected === true),
      currentRef: observedTargetFact('currentRef', t.currentRef),
      host: observedTargetFact('host', t.host),
      contentEditable: observedTargetFact('contentEditable', t.contentEditable === true),
      type: observedTargetFact('type', t.type),
      value: t.value === null || t.value === undefined
        ? unknownTargetFact('value_not_observable') : observedTargetFact('value', String(t.value)),
      placeholder: nullableTargetFact('placeholder', t.placeholder),
      nativeDisabled: observedTargetFact('nativeDisabled', t.nativeDisabled === true),
      ariaDisabled: nullableTargetFact('ariaDisabled', t.ariaDisabled),
      nativeReadonly: observedTargetFact('nativeReadonly', t.nativeReadonly === true),
      ariaReadonly: nullableTargetFact('ariaReadonly', t.ariaReadonly),
      readonlyState: observedTargetFact('readonlyState', t.readonlyState),
      editable: observedTargetFact('editable', t.editable === true),
      activeElementRef: nullableTargetFact('activeElementRef', t.activeElementRef),
      activeElementFocus: observedTargetFact('activeElementFocus', t.activeElementFocus === true),
      executableHit: t.hit && t.hit.status === 'observed'
        ? observedTargetFact('executableHit', t.hit.value === true)
        : unknownTargetFact(t.hit && t.hit.reason ? t.hit.reason : 'native_hit_unassessed'),
      point: t.point && t.point.status === 'observed' && t.point.value
        ? observedTargetFact('point', { x: t.point.value.x, y: t.point.value.y })
        : unknownTargetFact(t.point && t.point.reason ? t.point.reason : 'native_hit_point_unavailable'),
    };
  };
  const target = buildTarget(raw.target);
  return {
    documentRef: raw.documentRef,
    scopeRef: raw.scopeRef,
    observationId,
    revision,
    input: {
      ref: raw.inputRef,
      tag: ['input', 'textarea', 'contenteditable', 'unknown'].includes(raw.inputTag) ? raw.inputTag : 'unknown',
      type: raw.inputType,
      value: stringFact(raw.inputValue, 'input.value'),
      editable: boolFact(raw.editable, 'input.editable'),
    },
    submitRef: raw.submitRef,
    submittedQuery: stringFact(raw.submittedQuery, 'submitted.query'),
    resultsFor: stringFact(raw.resultsQuery, 'results.query'),
    submittedRequestRef: stringFact(raw.submittedRequestRef, 'submitted.requestRef'),
    resultsRequestRef: stringFact(raw.resultsRequestRef, 'results.requestRef'),
    request: ['loading', 'settled', 'error', 'unknown'].includes(raw.request) ? raw.request : 'unknown',
    display: ['none', 'old', 'current', 'empty', 'partial', 'unknown'].includes(raw.display) ? raw.display : 'unknown',
    access: ['available', 'login_required', 'challenge', 'unknown'].includes(raw.access) ? raw.access : 'unknown',
    collection: {
      ref: raw.collectionRef,
      scopeRef: raw.resultScopeRef,
      requestRef: stringFact(raw.collectionRequestRef, 'collection.requestRef'),
      batch: stringFact(raw.batch, 'collection.batch'),
      items,
    },
    rangeExpansion: {
      actionMechanicalEffect: rangeEffect,
      atGeometryBoundary: rangeGeometry,
      requestState: rangeRequestState,
      hasMore: rangeHasMore,
      collectionTerminal: false,
    },
    ...(target === undefined ? {} : { target }),
    evidence,
  };
}

export function classifyRangeEffect(before, after) {
  const beforeScrollTop = before?.scrollTop ?? null;
  const afterScrollTop = after?.scrollTop ?? null;
  const beforeBatch = before?.batch ?? null;
  const afterBatch = after?.batch ?? null;
  const beforeRequestStatus = before?.requestStatus ?? null;
  const afterRequestStatus = after?.requestStatus ?? null;

  const displaced = beforeScrollTop !== null && afterScrollTop !== null
    && afterScrollTop !== beforeScrollTop;
  const batchChanged = beforeBatch !== null && afterBatch !== null
    && afterBatch !== beforeBatch;
  const loadingTriggered = beforeRequestStatus !== null && beforeRequestStatus !== 'loading'
    && afterRequestStatus === 'loading';
  const hasMechanicalEffect = displaced || batchChanged || loadingTriggered;
  const factsComplete = beforeScrollTop !== null && afterScrollTop !== null
    && beforeBatch !== null && afterBatch !== null
    && beforeRequestStatus !== null && afterRequestStatus !== null;

  if (hasMechanicalEffect) {
    return { hasMechanicalEffect, factsComplete, rangeEffect: 'displaced_or_triggered', effectKnowledge: 'known' };
  }
  if (!factsComplete) {
    return { hasMechanicalEffect, factsComplete, rangeEffect: 'not_attempted', effectKnowledge: 'unknown' };
  }
  return { hasMechanicalEffect, factsComplete, rangeEffect: 'no_change', effectKnowledge: 'none' };
}

function waitFn(selector, timeoutMs) {
  return new Promise((resolveWait) => {
    const target = document.querySelector(selector) || document.body;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolveWait(true);
    };
    const observer = new MutationObserver(finish);
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-request-status', 'data-display', 'data-access', 'data-results-request-ref', 'data-batch-ref', 'data-late-request-ref'],
      childList: true,
      subtree: true,
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function clickPoint(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('target geometry unavailable');
  for (const event of [
    { type: 'mouseMoved', button: 'none', buttons: 0 },
    { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 },
  ]) {
    await cdp.call('Input.dispatchMouseEvent', { ...event, x: point.x, y: point.y });
  }
}

// Default native IO grant for a single search batch: read/input/submit/write.
// Browser range expansion is an explicit opt-in only; callers that need it
// pass browser.nativeExpandRange through options.grantedEffects.
const DEFAULT_GRANTED_EFFECTS = ['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write'];

export function createGrantedEffects(options = {}) {
  const explicit = options?.grantedEffects;
  const extra = explicit == null ? [] : [...explicit];
  return new Set([...DEFAULT_GRANTED_EFFECTS, ...extra]);
}

export async function createResources(options = {}) {
  const target = await createOwnTarget();
  let cdp = null;
  const state = {
    revision: 0,
    first: null,
    latest: null,
    dispatched: false,
    submitted: false,
    rangeEffect: 'not_attempted',
    preludeReceipts: [],
    mutationReceipts: [],
    targetId: target.id,
  };
  try {
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    const targetUrl = new URL(config.path, FIXTURE_ORIGIN);
    for (const [key, value] of Object.entries(config.params ?? {})) targetUrl.searchParams.set(key, value);
    const loadEvent = cdp.once('Page.loadEventFired');
    await cdp.call('Page.navigate', { url: targetUrl.toString() });
    await Promise.race([loadEvent, delay(5000)]);
    await delay(300);

    const evaluate = cdp.evaluate;
    const performInput = async (value) => {
      await clickPoint(cdp, config.selectors.input);
      await delay(60);
      const focused = await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(config.selectors.input)})`);
      if (!focused) {
        return { dispatched: true, ok: true, effectKnowledge: 'none', source: 'cdp.Input', error: null, focus: 'other', textWriteCount: 0, events: [] };
      }
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
      await cdp.call('Input.insertText', { text: value });
      await delay(config.postInputDelayMs ?? 120);
      return { dispatched: true, ok: true, effectKnowledge: 'unknown', source: 'cdp.Input', error: null, focus: 'target', textWriteCount: 1, events: [] };
    };
    const performSubmit = async (mode = config.submitMode) => {
      if (mode === 'click') {
        await clickPoint(cdp, config.selectors.submit);
      } else {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
      await delay(100);
      return { dispatched: true, ok: true, effectKnowledge: 'unknown', source: 'cdp.Input', error: null, events: [] };
    };

    if (config.prelude && config.prelude.query) {
      state.preludeReceipts.push(await performInput(config.prelude.query));
      await delay(60);
      state.preludeReceipts.push(await performSubmit(config.prelude.submitMode ?? 'enter'));
      await delay(100);
    }

    const observe = async () => {
      if (config.projection.observeFailAfterDispatch && state.dispatched) throw new Error('injected post-action read failure');
      if (config.projection.observeFailAfterSubmit && state.submitted) throw new Error('injected: post-submit read failure');
      state.revision += 1;
      const raw = await evaluate(`(${observeFn.toString()})(${JSON.stringify(config)})`);
      const observation = buildObservation(raw, state.revision, state.rangeEffect);
      state.rangeEffect = 'not_attempted';
      state.latest = observation;
      if (!state.first) state.first = observation;
      if (config.projection.stalePost && state.dispatched) {
        state.latest = state.first;
        return state.first;
      }
      return observation;
    };
    const currentControl = () => {
      if (!state.latest) throw new Error('search observation unavailable before read');
      return { documentRef: state.latest.documentRef, observationId: state.latest.observationId, revision: state.latest.revision };
    };
    const readResults = async () => {
      state.rangeEffect = 'not_attempted';
      const observation = await observe();
      if (observation.request !== 'loading' && observation.display !== 'partial') return observation;
      // Observe the visible result region so an early aside/main change is not
      // collapsed into a later settled request state.
      await evaluate(`(${waitFn.toString()})(${JSON.stringify(config.selectors.waitRoot)}, ${READ_TIMEOUT_MS})`, true);
      return observe();
    };
    const nativeInputText = async (invocation) => {
      state.rangeEffect = 'not_attempted';
      if (config.projection.rejectInputWithoutBody) {
        return { dispatched: false, ok: false, effectKnowledge: 'none', source: 'cdp.Input', error: null };
      }
      const receipt = await performInput(invocation.value);
      state.mutationReceipts.push({ action: 'input', dispatchState: 'dispatched', ...receipt });
      state.dispatched = true;
      if (config.projection.throwAfterDispatch) throw new Error('transport error after native dispatch');
      return receipt;
    };
    const nativeSubmit = async () => {
      state.rangeEffect = 'not_attempted';
      const receipt = await performSubmit();
      state.mutationReceipts.push({ action: 'submit', dispatchState: 'dispatched', ...receipt });
      state.dispatched = true;
      state.submitted = true;
      if (config.projection.throwAfterSubmit) throw new Error('injected: transport error after native submit dispatch');
      return receipt;
    };
    const nativeExpandRange = async () => {
      state.rangeEffect = 'not_attempted';
      const readExpandSnapshot = () =>
        evaluate(`(() => {
          const s = document.querySelector('#result-scroll-box');
          const req = document.querySelector(${JSON.stringify(config.selectors?.requestState ?? '#request-state')});
          const attr = (el, name) => {
            const v = el && el.getAttribute(name);
            return v == null || v === '' ? null : v;
          };
          const rawStatus = attr(req, 'data-request-status');
          let geometryReason = null;
          let atGeometryBoundary = null;
          if (s) {
            const clientHeight = s.clientHeight;
            const scrollHeight = s.scrollHeight;
            const scrollTop = s.scrollTop;
            if (Number.isFinite(clientHeight) && Number.isFinite(scrollHeight) && Number.isFinite(scrollTop)
              && clientHeight > 0 && scrollHeight > 0) {
              atGeometryBoundary = scrollTop + clientHeight >= scrollHeight - 1;
            } else {
              geometryReason = 'scroll_container_geometry_measurement_failed';
            }
          } else {
            geometryReason = 'scroll_container_absent';
          }
          return {
            scrollTop: atGeometryBoundary === null ? null : s ? s.scrollTop : null,
            batch: attr(req, 'data-batch-ref'),
            requestStatus: ['loading', 'settled', 'error'].includes(rawStatus) ? rawStatus : null,
            atGeometryBoundary,
            geometryReason,
          };
        })()`);
      const before = await readExpandSnapshot();
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 480, y: 420, deltaX: 0, deltaY: 640,
      });
      await delay(config.postExpandDelayMs ?? 160);
      state.dispatched = true;
      try {
        const after = await readExpandSnapshot();
        const classified = classifyRangeEffect(before, after);
        state.rangeEffect = classified.rangeEffect;
        const receipt = {
          dispatched: true, ok: true, effectKnowledge: classified.effectKnowledge,
          source: 'cdp.Input', error: null,
        };
        state.mutationReceipts.push({ action: 'expand_range', dispatchState: 'dispatched', ...receipt });
        return receipt;
      } catch (err) {
        state.rangeEffect = 'not_attempted';
        const receipt = {
          dispatched: true, ok: false, effectKnowledge: 'unknown', source: 'cdp.Input',
          error: { code: 'native_expand_failed', message: err instanceof Error ? err.message : String(err) },
        };
        state.mutationReceipts.push({ action: 'expand_range', dispatchState: 'unknown', ...receipt });
        return receipt;
      }
    };

    state.cdp = cdp;
    globalThis.__bSearchState = state;
    return {
      grantedEffects: createGrantedEffects(options),
      decision: {
        id: 'browser.search.handwired.v1',
        source: 'handwired',
        select: ({ goal }) => ({ kind: 'selected', action: goal.phase === 'input' ? 'input' : goal.phase === 'submitted' ? 'submit' : 'read' }),
      },
      observe,
      readResults,
      currentControl,
      nativeInputText,
      nativeSubmit,
      nativeExpandRange,
      collect: async () => {},
      collectRoot: async () => {},
    };
  } catch (error) {
    if (cdp) cdp.close();
    await closeOwnTarget(target.id);
    throw error;
  }
}

export async function close() {
  const state = globalThis.__bSearchState;
  if (!state || !state.cdp) return { sideEffects: null, closeErrors: [] };
  const closeErrors = [];
  let sideEffects = null;
  try {
    if (config.scenario === 'race') {
      await state.cdp.evaluate(`(${waitFn.toString()})(${JSON.stringify('#late-state')}, ${Math.max(READ_TIMEOUT_MS, 2000)})`, true);
    }
    const raw = await state.cdp.evaluate(`(${observeFn.toString()})(${JSON.stringify(config)})`);
    const finalObservation = buildObservation(raw, state.revision + 1, state.rangeEffect);
    const neighborValue = await state.cdp.evaluate(`document.querySelector(${JSON.stringify(config.neighborSelector)})?.value ?? null`);
    const lateValue = await state.cdp.evaluate(`document.querySelector('#late-state')?.getAttribute('data-late-request-ref') ?? ''`);
    sideEffects = {
      finalObservation,
      neighborValue,
      lateValue,
      preludeReceipts: state.preludeReceipts,
      mutationReceipts: state.mutationReceipts,
    };
  } catch (error) {
    closeErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    state.cdp.close();
  } catch (error) {
    closeErrors.push(error instanceof Error ? error.message : String(error));
  }
  await closeOwnTarget(state.targetId);
  return { sideEffects, closeErrors };
}
