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
  const requestState = document.querySelector(sel.requestState);
  const collection = document.querySelector(sel.collection);
  const attr = (el, name) => {
    const value = el && el.getAttribute(name);
    return value == null || value === '' ? null : value;
  };
  const omitRefs = !!(config.projection && config.projection.omitRequestRefs);
  const unread = new Set((config.projection && config.projection.unreadItemIndexes) || []);
  const elements = collection ? Array.from(collection.querySelectorAll(sel.mainItems)) : [];
  const items = elements.map((el, index) => ({
    index,
    text: unread.has(index) ? null : (el.textContent || '').trim(),
  }));
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
    items,
  };
}

function buildObservation(raw, revision) {
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
  const items = raw.items.map((item, index) => ({
    ref: `${raw.collectionRef}-item-${index}`,
    collectionRef: raw.collectionRef,
    role: 'main',
    text: item.text === null || item.text === ''
      ? { status: 'unknown', reason: 'not_read' }
      : { status: 'observed', value: item.text, evidenceRefs: [mark(`item.${index}`, { value: item.text })] },
  }));
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
    evidence,
  };
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

export async function createResources() {
  const target = await createOwnTarget();
  let cdp = null;
  const state = {
    revision: 0,
    first: null,
    latest: null,
    dispatched: false,
    submitted: false,
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
      const observation = buildObservation(raw, state.revision);
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
      const observation = await observe();
      if (observation.request !== 'loading' && observation.display !== 'partial') return observation;
      // Observe the visible result region so an early aside/main change is not
      // collapsed into a later settled request state.
      await evaluate(`(${waitFn.toString()})(${JSON.stringify(config.selectors.waitRoot)}, ${READ_TIMEOUT_MS})`, true);
      return observe();
    };
    const nativeInputText = async (invocation) => {
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
      const receipt = await performSubmit();
      state.mutationReceipts.push({ action: 'submit', dispatchState: 'dispatched', ...receipt });
      state.dispatched = true;
      state.submitted = true;
      if (config.projection.throwAfterSubmit) throw new Error('injected: transport error after native submit dispatch');
      return receipt;
    };

    state.cdp = cdp;
    globalThis.__bSearchState = state;
    return {
      grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
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
    const finalObservation = buildObservation(raw, state.revision + 1);
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
