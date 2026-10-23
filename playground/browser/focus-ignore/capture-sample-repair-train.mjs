// Host-side capture for the sample-repair-train fixture.
//
// The authoring worker does not run this script and does not connect to a
// browser. The host runs it against an owned Chrome tab over CDP. All focus
// changes use real CDP mouse events. The script never calls element.focus(),
// element.click(), or dispatchEvent, and never rewrites observation fields.
// The page entry bundles the production observeLiveDom adapter and the public
// extractBasicKindWires extractor, so af/fc and all other wires come from
// production code, never from the declared tabindex attribute.
import { build } from "esbuild";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const CDP_HTTP = process.env.TRAIN_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 90;

const WRAPPER_TYPES = ["W1", "W2", "W3"];
const POSITIVE_TABINDEX = [-1, 0];
const POSITIVE_STATES = ["initial", "focused", "blurred", "refocused"];
const IGNORE_STATES = ["before", "after"];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const usage = "usage: node playground/browser/focus-ignore/capture-sample-repair-train.mjs --fixture <absolute fixture.html> --out <absolute capture.json>";
const fixtureArg = arg("--fixture");
const outArg = arg("--out");
if (fixtureArg === undefined || outArg === undefined) {
  console.error(usage);
  process.exit(2);
}
const fixture = isAbsolute(fixtureArg) ? fixtureArg : resolve(process.cwd(), fixtureArg);
const out = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
await access(fixture, fsConstants.R_OK);

// The page-side entry is bundled once and installed on the fixture page. It
// creates one stable ref registry for the whole episode so the same object
// keeps the same nodeRef across all four states.
const entrySource = `
import { createStableNodeRefRegistry, observeLiveDom } from "./lib/adapters/browser/live-dom.js";
import { extractBasicKindWires } from "./lib/filters/basic-kinds.js";

const registry = createStableNodeRefRegistry("sample-repair-train");

function inspectTarget(key) {
  const element = document.querySelector('[data-train-key="' + key + '"]');
  if (!(element instanceof Element)) return { missing: true, key };
  const rect = element.getBoundingClientRect();
  const active = document.activeElement;
  return {
    key,
    tag: element.tagName.toLowerCase(),
    tabindexAttribute: element.getAttribute("tabindex"),
    isConnected: element.isConnected,
    isActive: active === element,
    activeTag: active instanceof Element ? active.tagName.toLowerCase() : null,
    activeKey: active instanceof HTMLElement ? active.getAttribute("data-train-key") : null,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

function pointHitsTarget(key, x, y) {
  const element = document.querySelector('[data-train-key="' + key + '"]');
  if (!(element instanceof Element)) return { ok: false, reason: "missing" };
  const hit = document.elementFromPoint(x, y);
  return { ok: hit === element, hitTag: hit instanceof Element ? hit.tagName.toLowerCase() : null, hitKey: hit instanceof HTMLElement ? hit.getAttribute("data-train-key") : null };
}

function describeElement(element) {
  if (!(element instanceof Element)) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    key: element instanceof HTMLElement ? element.getAttribute("data-train-key") : null,
    dataObject: element instanceof HTMLElement ? element.getAttribute("data-train-object") : null,
    isBody: element === document.body,
    isConnected: element.isConnected,
    tabindexAttribute: element.getAttribute("tabindex"),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

function snapshotState(stateKey, targetKey) {
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef: "sample-repair-train/" + stateKey,
    documentRef: "sample-repair-train",
  });
  const target = document.querySelector('[data-train-key="' + targetKey + '"]');
  const targetRef = target instanceof Element ? registry.refByElement.get(target) ?? null : null;
  const nodes = snapshot.observation.nodes.map((node) => ({
    nodeRef: node.nodeRef,
    parentRef: node.parentRef,
    tag: node.tag,
    role: node.role,
    attributes: node.attributes,
    rect: node.rect,
    fragments: node.fragments,
    clippedRect: node.clippedRect,
  }));
  const properties = [...snapshot.properties].map(([nodeRef, value]) => ({ nodeRef, ...value }));
  const wires = [...snapshot.properties].map(([nodeRef, value]) => ({
    nodeRef,
    wires: extractBasicKindWires(value),
  }));
  const wrapperRow = targetRef === null ? null
    : (snapshot.properties.get(targetRef) ? { nodeRef: targetRef, ...snapshot.properties.get(targetRef) } : null);
  const wrapperWires = targetRef === null ? null
    : (snapshot.properties.get(targetRef) ? extractBasicKindWires(snapshot.properties.get(targetRef)) : null);
  const active = document.activeElement;
  const activeRef = active instanceof Element ? registry.refByElement.get(active) ?? null : null;
  return {
    schemaVersion: "browser-focus-sample-repair.snapshot.v1",
    snapshotRef: snapshot.snapshotRef,
    documentRef: snapshot.documentRef,
    frameRef: snapshot.frameRef,
    pageState: {
      readyState: document.readyState,
      url: location.href,
      viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      activeElement: describeElement(active),
      target: describeElement(target),
    },
    targetRef,
    activeRef,
    connected: target instanceof Element ? target.isConnected : false,
    tabindexAttribute: target instanceof Element ? target.getAttribute("tabindex") : null,
    rect: target instanceof Element ? describeElement(target).rect : null,
    wrapperRow,
    wrapperWires,
    properties,
    wires,
    nodes,
    itemObservations: snapshot.itemObservations,
    coverage: snapshot.coverage,
    observationCoverage: snapshot.observation.coverage,
    observationViewport: snapshot.observation.viewport,
  };
}

if (typeof window !== "undefined") {
  window.__sampleRepairTrain = {
    inspectTarget,
    pointHitsTarget,
    snapshotState,
    describeElement,
  };
}
`;

const INITIAL_PAGE_EXPRESSION = `(() => {
  const targetKeys = [...document.querySelectorAll('[data-train-role="target"]')].map((el) => el.getAttribute("data-train-key"));
  const ignoreKeys = [...document.querySelectorAll('[data-train-role="ignore-wrapper"]')].map((el) => el.getAttribute("data-train-key"));
  const parking = document.querySelector('[data-train-key="train-parking"]');
  return {
    readyState: document.readyState,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    bodyIsActive: document.activeElement === document.body,
    activeKey: document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-train-key") : null,
    targetKeys,
    ignoreKeys,
    parkingExists: parking instanceof Element,
  };
})()`;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function newTarget(url) {
  const response = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`CDP /json/new failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function closeTarget(targetId) {
  try {
    const response = await fetch(`${CDP_HTTP}/json/close/${encodeURIComponent(targetId)}`);
    if (!response.ok) {
      console.error(`warning: CDP /json/close failed: ${response.status}`);
    }
  } catch (error) {
    console.error(`warning: CDP /json/close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openSocket(socket) {
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 10000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket open failed"));
    }, { once: true });
  });
}

function createCdp(socket) {
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      const waiters = eventWaiters.get(message.method);
      if (waiters && waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(message.params);
      }
    }
  });
  const call = (method, params = {}, timeoutMs = 20000) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const waitForEvent = (method, timeoutMs = 20000) => new Promise((resolvePromise, reject) => {
    const waiters = eventWaiters.get(method) ?? [];
    const waiter = { resolve: resolvePromise, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const current = eventWaiters.get(method);
      if (current) {
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
      }
      reject(new Error(`${method} event timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.push(waiter);
    eventWaiters.set(method, waiters);
  });
  return { call, waitForEvent };
}

async function evaluate(call, expression, timeoutMs = 20000) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails !== undefined) {
    throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 1200)}`);
  }
  return result.result ? result.result.value : undefined;
}

async function buildPageBundle() {
  const bundled = await build({
    stdin: {
      contents: entrySource,
      resolveDir: repo,
      loader: "ts",
      sourcefile: "capture-sample-repair-train-page-entry.ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  });
  return bundled.outputFiles[0].text;
}

function pickTargetPoints(rect, viewport) {
  const inset = 4;
  const margin = 2;
  const raw = [
    [rect.x + inset, rect.y + inset],
    [rect.x + rect.width - inset, rect.y + inset],
    [rect.x + inset, rect.y + rect.height - inset],
    [rect.x + rect.width - inset, rect.y + rect.height - inset],
    [rect.x + rect.width / 2, rect.y + inset],
    [rect.x + inset, rect.y + rect.height / 2],
    [rect.x + rect.width - inset, rect.y + rect.height / 2],
    [rect.x + rect.width / 2, rect.y + rect.height - inset],
  ];
  const insideTarget = (x, y) => x >= rect.x + 1 && x <= rect.x + rect.width - 1
    && y >= rect.y + 1 && y <= rect.y + rect.height - 1;
  const insideViewport = (x, y) => x >= 0 && y >= 0 && x < viewport.width && y < viewport.height;
  const points = [];
  const seen = new Set();
  for (const [x, y] of raw) {
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!insideTarget(x, y) || !insideViewport(x, y)) continue;
    points.push({ x, y });
  }
  return points;
}

async function readActive(call) {
  return await evaluate(call, `(() => ({
    tag: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
    key: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.trainKey ?? null : null,
    isBody: document.activeElement === document.body,
  }))()`);
}

async function clickAt(call, x, y) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(SETTLE_MS);
}

async function findTargetPoint(call, key) {
  const measured = await evaluate(call, `(() => {
    const element = document.querySelector('[data-train-key="${key}"]');
    if (!(element instanceof Element)) return { error: "missing" };
    const r = element.getBoundingClientRect();
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  if (measured.error) throw new Error(`measure ${key} failed: ${JSON.stringify(measured)}`);
  const candidates = pickTargetPoints(measured.rect, measured.viewport);
  const checks = [];
  for (const point of candidates) {
    const hit = await evaluate(call, `window.__sampleRepairTrain.pointHitsTarget(${JSON.stringify(key)}, ${point.x}, ${point.y})`);
    checks.push({ ...point, ...hit });
    if (hit.ok === true) return { point, rect: measured.rect, viewport: measured.viewport, attempts: checks };
  }
  throw new Error(`no hit point for ${key}: ${JSON.stringify(checks)}`);
}

async function focusTarget(call, key) {
  const found = await findTargetPoint(call, key);
  await clickAt(call, found.point.x, found.point.y);
  const active = await readActive(call);
  if (active.key !== key) {
    throw new Error(`click did not focus target ${key}: ${JSON.stringify(active)}`);
  }
  return {
    kind: "mouse",
    target: key,
    clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
    point: found.point,
    hitChecks: found.attempts,
    observedActiveKey: active.key,
    settleMs: SETTLE_MS,
  };
}

async function clickParking(call) {
  const found = await findTargetPoint(call, "train-parking");
  await clickAt(call, found.point.x, found.point.y);
  const active = await readActive(call);
  if (active.key !== "train-parking") {
    throw new Error(`parking click did not focus train-parking: ${JSON.stringify(active)}`);
  }
  return {
    kind: "mouse",
    target: "train-parking",
    clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
    point: found.point,
    hitChecks: found.attempts,
    observedActiveKey: active.key,
    settleMs: SETTLE_MS,
  };
}

// Each positive episode must start from the clean initial page state where
// document.activeElement is body. A previous episode leaves its target focused,
// so a real native click on an empty body point restores that state without
// reloading the page (the stable ref registry must stay valid for the run).
async function resetFocusToBody(call) {
  const spot = await evaluate(call, `(() => {
    const vw = innerWidth, vh = innerHeight;
    const step = 16;
    for (let y = 8; y < vh; y += step) {
      for (let x = 8; x < vw; x += step) {
        const el = document.elementFromPoint(x, y);
        if (el === document.body) return { x, y };
      }
    }
    return null;
  })()`);
  if (spot === null) throw new Error("no empty body point to reset focus");
  await clickAt(call, spot.x, spot.y);
  const active = await readActive(call);
  if (active.isBody !== true) {
    throw new Error(`reset click did not restore body focus: ${JSON.stringify({ spot, active })}`);
  }
  return {
    kind: "mouse",
    target: "body",
    clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
    point: { x: spot.x, y: spot.y },
    observedActiveKey: active.key,
    settleMs: SETTLE_MS,
  };
}

async function clickChild(call, key) {
  const found = await findTargetPoint(call, key);
  await clickAt(call, found.point.x, found.point.y);
  const active = await readActive(call);
  if (active.key !== key) {
    throw new Error(`child click did not focus action child ${key}: ${JSON.stringify(active)}`);
  }
  return {
    kind: "mouse",
    target: key,
    clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
    point: found.point,
    hitChecks: found.attempts,
    observedActiveKey: active.key,
    settleMs: SETTLE_MS,
  };
}

function positiveObjectKey(wrapperType, tabindex) {
  return `positive-${wrapperType.toLowerCase()}-${tabindex === -1 ? "neg1" : "zero"}`;
}

function positiveCaseId(wrapperType, tabindex, state) {
  return `${wrapperType.toLowerCase()}-${tabindex === -1 ? "neg1" : "zero"}-${state}`;
}

function ignoreObjectKey(wrapperType) {
  return `ignore-${wrapperType.toLowerCase()}`;
}

function ignoreActionKey(wrapperType) {
  return `${ignoreObjectKey(wrapperType)}-action`;
}

function recordFor(state, stateName, key, wrapperType, tabindex, gold, stimulus) {
  const snapshot = state;
  const wrapperRow = snapshot.wrapperRow;
  const wrapperWires = snapshot.wrapperWires;
  if (wrapperRow === null || typeof wrapperRow !== "object") {
    throw new Error(`${key} ${stateName} has no wrapperRow`);
  }
  return {
    schemaVersion: "browser-focus-sample-repair.snapshot.v1",
    family: "sample-repair-train",
    caseId: stateName === "before" || stateName === "after"
      ? `${key}-${stateName}`
      : positiveCaseId(wrapperType, tabindex, stateName),
    sampleId: stateName === "before" || stateName === "after"
      ? `sample-repair-train:${key}:${stateName}`
      : `sample-repair-train:${positiveObjectKey(wrapperType, tabindex)}:${stateName}`,
    objectId: key,
    wrapperType,
    construction: wrapperType.toLowerCase(),
    tabindex,
    state: stateName,
    stateName,
    snapshotRef: `sample-repair-train/${key}/${stateName}`,
    documentRef: "sample-repair-train",
    stimulus,
    gold,
    activeElement: snapshot.pageState.activeElement,
    target: snapshot.pageState.target,
    rect: snapshot.rect,
    connected: snapshot.connected,
    tabindexAttribute: snapshot.tabindexAttribute,
    targetRef: snapshot.targetRef,
    activeRef: snapshot.activeRef,
    wrapperRow,
    wrapperWires,
    properties: snapshot.properties,
    wires: snapshot.wires,
    nodes: snapshot.nodes,
    itemObservations: snapshot.itemObservations,
    coverage: snapshot.coverage,
    observationCoverage: snapshot.observationCoverage,
    observationViewport: snapshot.observationViewport,
  };
}

function verifyFocusWires(record, wrapperType, tabindex, stateName) {
  const row = record.wrapperRow;
  const wires = record.wrapperWires;
  if (stateName !== "focused" && stateName !== "refocused") return { ok: true, checks: {} };
  const w1RepairWires = {};
  if (wrapperType === "W1" && tabindex === -1) {
    w1RepairWires.neutralSingleChildOne = wires.neutral_single_child === 1;
    w1RepairWires.neutralSingleElementWrapperOne = wires.neutral_single_element_wrapper === 1;
    w1RepairWires.neutralSinglePositiveWrapperOne = wires.neutral_single_positive_wrapper === 1;
  }
  const checks = {
    activeElementRefMatches: record.activeRef === record.targetRef,
    connected: record.connected === true,
    activeElementFocusTrue: row.activeElementFocus === true,
    tabIndexFocusMatchesDeclared: row.tabIndexFocus === (tabindex === 0),
    neutralActualFocusOne: wires.neutral_actual_focus === 1,
    neutralFocusableControlMatchesDeclared: wires.neutral_focusable_control === (tabindex === 0 ? 1 : 0),
    ownFocusTargetOne: wires.own_focus_target === 1,
    ...w1RepairWires,
  };
  return {
    ok: Object.values(checks).every(value => value === true),
    checks,
  };
}

async function capturePositiveEpisode(call, wrapperType, tabindex) {
  const key = positiveObjectKey(wrapperType, tabindex);
  const resetStimulus = await resetFocusToBody(call);
  const initialStimulus = { kind: "none", note: "clean initial page state", reset: resetStimulus };
  const initial = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/initial`)}, ${JSON.stringify(key)})`);
  const initialRecord = recordFor(initial, "initial", key, wrapperType, tabindex, "container", initialStimulus);
  if (initialRecord.activeElement?.isBody !== true) {
    throw new Error(`${key} initial active element must be body: ${JSON.stringify(initialRecord.activeElement)}`);
  }

  const focusStimulus = await focusTarget(call, key);
  const focusState = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/focused`)}, ${JSON.stringify(key)})`);
  const focusRecord = recordFor(focusState, "focused", key, wrapperType, tabindex, "container", focusStimulus);
  const focusVerify = verifyFocusWires(focusRecord, wrapperType, tabindex, "focused");
  if (!focusVerify.ok) throw new Error(`${key} focused verification failed: ${JSON.stringify(focusVerify.checks)}`);

  const blurStimulus = await clickParking(call);
  const blurState = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/blurred`)}, ${JSON.stringify(key)})`);
  const blurRecord = recordFor(blurState, "blurred", key, wrapperType, tabindex, "container", blurStimulus);
  if (blurRecord.connected !== true || blurRecord.activeElement?.isBody !== false) {
    throw new Error(`${key} blurred state must stay connected and leave target focus: ${JSON.stringify({ connected: blurRecord.connected, activeElement: blurRecord.activeElement })}`);
  }

  const refocusStimulus = await focusTarget(call, key);
  const refocusState = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/refocused`)}, ${JSON.stringify(key)})`);
  const refocusRecord = recordFor(refocusState, "refocused", key, wrapperType, tabindex, "container", refocusStimulus);
  const refocusVerify = verifyFocusWires(refocusRecord, wrapperType, tabindex, "refocused");
  if (!refocusVerify.ok) throw new Error(`${key} refocused verification failed: ${JSON.stringify(refocusVerify.checks)}`);
  if (initialRecord.targetRef !== focusRecord.targetRef || focusRecord.targetRef !== refocusRecord.targetRef) {
    throw new Error(`${key} target ref changed across states: ${JSON.stringify([initialRecord.targetRef, focusRecord.targetRef, refocusRecord.targetRef])}`);
  }
  return [initialRecord, focusRecord, blurRecord, refocusRecord];
}

async function captureIgnoreEpisode(call, wrapperType) {
  const key = ignoreObjectKey(wrapperType);
  const actionKey = ignoreActionKey(wrapperType);
  // The previous positive episode leaves its target focused. Park first so the
  // before state has a known baseline and never inherits the earlier focus.
  const beforeStimulus = await clickParking(call);
  const before = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/before`)}, ${JSON.stringify(key)})`);
  const beforeRecord = recordFor(before, "before", key, wrapperType, null, "ignore", beforeStimulus);
  if (beforeRecord.wrapperWires.own_focus_target !== 0) {
    throw new Error(`${key} before state must have no own focus target: ${JSON.stringify(beforeRecord.wrapperWires)}`);
  }
  if (beforeRecord.activeElement?.key !== "train-parking") {
    throw new Error(`${key} before state must start from parking: ${JSON.stringify(beforeRecord.activeElement)}`);
  }

  const childStimulus = await clickChild(call, actionKey);
  const after = await evaluate(call, `window.__sampleRepairTrain.snapshotState(${JSON.stringify(`${key}/after`)}, ${JSON.stringify(key)})`);
  const afterRecord = recordFor(after, "after", key, wrapperType, null, "ignore", childStimulus);
  if (afterRecord.activeElement?.key !== actionKey) {
    throw new Error(`${key} after state must focus the action child: ${JSON.stringify(afterRecord.activeElement)}`);
  }
  if (afterRecord.wrapperWires.own_focus_target !== 0) {
    throw new Error(`${key} after state must keep wrapper without own focus target: ${JSON.stringify(afterRecord.wrapperWires)}`);
  }
  if (beforeRecord.targetRef !== afterRecord.targetRef) {
    throw new Error(`${key} target ref changed across states`);
  }
  return [beforeRecord, afterRecord];
}

const bundleCode = await buildPageBundle();

const capture = {
  schemaVersion: "browser-focus-sample-repair-capture.v1",
  family: "sample-repair-train",
  status: "running",
  fixture: {
    path: fixture,
    fileUrl: pathToFileURL(fixture).href,
  },
  cdp: {
    endpoint: CDP_HTTP,
    targetId: null,
    viewport: VIEWPORT,
  },
  generatedAt: new Date().toISOString(),
  initialPage: null,
  states: [],
};

let target = null;
let socket = null;

try {
  target = await newTarget("about:blank");
  capture.cdp.targetId = target.id;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await openSocket(socket);
  const { call, waitForEvent } = createCdp(socket);

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", VIEWPORT);

  const loaded = waitForEvent("Page.loadEventFired", 20000);
  const navigation = await call("Page.navigate", { url: capture.fixture.fileUrl }, 20000);
  if (navigation.errorText) throw new Error(`Page.navigate failed: ${navigation.errorText}`);
  await loaded;
  await sleep(150);

  capture.initialPage = await evaluate(call, INITIAL_PAGE_EXPRESSION);
  if (!capture.initialPage.bodyIsActive) {
    throw new Error(`fixture must start with body as activeElement, found ${JSON.stringify(capture.initialPage.activeKey)}`);
  }
  if (!capture.initialPage.parkingExists) {
    throw new Error("fixture must provide train-parking");
  }
  const expectedTargetKeys = new Set(WRAPPER_TYPES.flatMap((wrapperType) =>
    POSITIVE_TABINDEX.map((tabindex) => positiveObjectKey(wrapperType, tabindex))));
  const expectedIgnoreKeys = new Set(WRAPPER_TYPES.map((wrapperType) => ignoreObjectKey(wrapperType)));
  const actualTargetKeys = new Set(capture.initialPage.targetKeys);
  const actualIgnoreKeys = new Set(capture.initialPage.ignoreKeys);
  for (const key of expectedTargetKeys) {
    if (!actualTargetKeys.has(key)) throw new Error(`initial page is missing target ${key}`);
  }
  for (const key of expectedIgnoreKeys) {
    if (!actualIgnoreKeys.has(key)) throw new Error(`initial page is missing ignore wrapper ${key}`);
  }
  for (const key of capture.initialPage.targetKeys) {
    if (!expectedTargetKeys.has(key)) throw new Error(`unexpected target ${key}`);
  }
  for (const key of capture.initialPage.ignoreKeys) {
    if (!expectedIgnoreKeys.has(key)) throw new Error(`unexpected ignore wrapper ${key}`);
  }

  await evaluate(call, bundleCode, 30000);
  await evaluate(call, 'typeof window.__sampleRepairTrain === "object"', 5000);

  for (const wrapperType of WRAPPER_TYPES) {
    for (const tabindex of POSITIVE_TABINDEX) {
      const records = await capturePositiveEpisode(call, wrapperType, tabindex);
      capture.states.push(...records);
      console.log(`captured positive ${wrapperType} ${tabindex}`);
    }
    const records = await captureIgnoreEpisode(call, wrapperType);
    capture.states.push(...records);
    console.log(`captured ignore ${wrapperType}`);
  }

  const positiveFocused = capture.states.filter(state => state.gold === "container" && (state.stateName === "focused" || state.stateName === "refocused"));
  const negativeFocused = positiveFocused.filter(state => state.tabindex === -1);
  const zeroFocused = positiveFocused.filter(state => state.tabindex === 0);
  const ignores = capture.states.filter(state => state.gold === "ignore");
  const summary = {
    states: capture.states.length,
    objects: new Set(capture.states.map(state => state.objectId)).size,
    positiveStates: capture.states.filter(state => state.gold === "container").length,
    ignoreStates: ignores.length,
    negativeFocused: negativeFocused.length,
    negativeFocusedAfFc: negativeFocused.every(state => state.wrapperRow.activeElementFocus === true && state.wrapperRow.tabIndexFocus === false),
    zeroFocused: zeroFocused.length,
    zeroFocusedAfFc: zeroFocused.every(state => state.wrapperRow.activeElementFocus === true && state.wrapperRow.tabIndexFocus === true),
  };
  if (summary.states !== 30 || summary.objects !== 9 || summary.positiveStates !== 24 || summary.ignoreStates !== 6) {
    throw new Error(`capture matrix incomplete: ${JSON.stringify(summary)}`);
  }
  if (!summary.negativeFocusedAfFc || !summary.zeroFocusedAfFc) {
    throw new Error(`focused wire matrix failed: ${JSON.stringify(summary)}`);
  }

  capture.status = "complete";
  capture.completedAt = new Date().toISOString();
  capture.summary = summary;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(capture, null, 2));
  console.log(JSON.stringify({
    out,
    status: capture.status,
    states: capture.states.length,
    objects: summary.objects,
    negativeFocusedAfFc: summary.negativeFocusedAfFc,
    zeroFocusedAfFc: summary.zeroFocusedAfFc,
  }));
} catch (error) {
  capture.status = "failed";
  capture.error = error instanceof Error ? error.message : String(error);
  capture.failedAt = new Date().toISOString();
  try {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(capture, null, 2));
  } catch {
    // The original error is the actionable one.
  }
  throw error;
} finally {
  try {
    socket?.close();
  } catch {
    // Closing a socket that never opened is not an error.
  }
  if (target?.id) await closeTarget(target.id);
}
