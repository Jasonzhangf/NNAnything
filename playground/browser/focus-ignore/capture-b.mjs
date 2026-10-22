#!/usr/bin/env node
// Host-side capture for the independent B focus/wrapper fixture.
//
// The worker that authored this file did not run it and did not connect to a
// browser. The host runs it while Chrome is listening on CDP 9333:
//
//   node playground/browser/focus-ignore/capture-b.mjs \
//     --fixture <absolute fixture-b.html> \
//     --out <absolute b/capture-b.json>
//
// Focus changes are real CDP Input events. The page is never focused or
// clicked through element.focus() or element.click(), and observation fields
// are never rewritten.

import { build } from "esbuild";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const cdp = process.env.B_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const VIEWPORT = { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 90;

const CONSTRUCTIONS = [
  { id: "button", child: "button" },
  { id: "svg", child: "svg" },
  { id: "image", child: "img" },
  { id: "link", child: "a" },
  { id: "text-span", child: "span" },
  { id: "nested-button", child: "div+button" },
];

const STATES = [
  { id: "s1", label: "S1", expectedActive: true, expectedTabIndex: true, expectedLabel: "container" },
  { id: "s2", label: "S2", expectedActive: false, expectedTabIndex: true, expectedLabel: "container" },
  { id: "s3", label: "S3", expectedActive: false, expectedTabIndex: false, expectedLabel: "ignore" },
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const usage = "usage: node playground/browser/focus-ignore/capture-b.mjs --fixture <absolute fixture-b.html> --out <absolute capture-b.json>";
const fixtureArg = arg("--fixture");
const outArg = arg("--out");
if (fixtureArg === undefined || outArg === undefined) {
  console.error(usage);
  process.exit(2);
}

const fixture = isAbsolute(fixtureArg) ? fixtureArg : resolve(process.cwd(), fixtureArg);
const out = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
await access(fixture, fsConstants.R_OK);

// The page side entry is bundled once and installed on the fixture page. It
// calls the production observeLiveDom adapter and returns one serializable
// snapshot per state. Nothing here classifies or predicts a label.
const entrySource = `
import { createStableNodeRefRegistry, observeLiveDom } from "./lib/adapters/browser/live-dom.js";
import { extractBasicKindWires } from "./lib/filters/basic-kinds.js";

function runB(stateKey) {
  const registry = createStableNodeRefRegistry("b");
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef: "b-" + stateKey,
    documentRef: "b-" + stateKey,
    readContent: false,
  });
  const nodes = snapshot.observation.nodes.map((node) => ({
    nodeRef: node.nodeRef,
    parentRef: node.parentRef,
    tag: node.tag,
    role: node.role,
    attributes: node.attributes,
    rect: node.rect,
    fragments: node.fragments,
    clippedRect: node.clippedRect,
    foreground: node.foreground ?? null,
    exposedRects: node.exposedRects ?? null,
    currentView: node.currentView ?? null,
  }));
  const properties = [...snapshot.properties].map(([nodeRef, value]) => ({ nodeRef, ...value }));
  const wires = [...snapshot.properties].map(([nodeRef, value]) => ({
    nodeRef,
    wires: extractBasicKindWires(value),
  }));
  const objectReferences = [];
  for (const node of snapshot.observation.nodes) {
    const element = snapshot.resolveElement(node.nodeRef);
    if (!element) continue;
    const data = (element as HTMLElement).dataset;
    if (data.bKey === undefined) continue;
    objectReferences.push({
      key: data.bKey,
      role: data.bRole ?? null,
      construction: data.bConstruction ?? null,
      stateId: data.bState ?? null,
      nodeRef: node.nodeRef,
      tag: node.tag,
      attributes: node.attributes,
    });
  }
  const active = document.activeElement;
  const activeElement = active instanceof Element ? active : null;
  const activeRef = activeElement ? registry.refByElement.get(activeElement) ?? null : null;
  const activeData = activeElement instanceof HTMLElement ? activeElement.dataset : null;
  const counts = (() => {
    let activeTrue = 0;
    let activeFalse = 0;
    let activeNull = 0;
    let tabTrue = 0;
    let tabFalse = 0;
    let tabNull = 0;
    for (const row of properties) {
      if (row.activeElementFocus === true) activeTrue++;
      else if (row.activeElementFocus === false) activeFalse++;
      else activeNull++;
      if (row.tabIndexFocus === true) tabTrue++;
      else if (row.tabIndexFocus === false) tabFalse++;
      else tabNull++;
    }
    return { activeTrue, activeFalse, activeNull, tabTrue, tabFalse, tabNull };
  })();
  return {
    schemaVersion: "browser-focus-ignore-capture-b.page.v1",
    stateKey,
    capturedAt: new Date().toISOString(),
    viewport: snapshot.observation.viewport,
    page: {
      origin: location.origin,
      pathname: location.pathname,
      hash: location.hash,
      title: document.title,
      readyState: document.readyState,
    },
    coverage: {
      live: snapshot.coverage,
      observation: snapshot.observation.coverage,
    },
    focus: {
      activeElementRef: activeRef,
      activeElementKey: activeData?.bKey ?? null,
      activeElementTag: activeElement ? activeElement.tagName.toLowerCase() : null,
      activeElementIsBody: activeElement === document.body,
      counts,
    },
    nodes,
    itemObservations: snapshot.itemObservations,
    properties,
    wires,
    objectReferences,
  };
}

if (typeof window !== "undefined") {
  window.__bRunB = runB;
}
`;

const INITIAL_PAGE_EXPRESSION = `(() => {
  const wrappers = [...document.querySelectorAll("[data-b-role='wrapper']")].map((el) => {
    const directText = [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join("");
    return {
      key: el.dataset.bKey ?? null,
      construction: el.dataset.bConstruction ?? null,
      stateId: el.dataset.bState ?? null,
      tabindex: el.getAttribute("tabindex"),
      childElementCount: el.childElementCount,
      firstChildTag: el.firstElementChild ? el.firstElementChild.tagName.toLowerCase() : null,
      directTextPresent: Boolean(directText.trim()),
      directTextNonFormat: /[^\\p{Cf}\\s]/u.test(directText),
    };
  });
  return {
    readyState: document.readyState,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    activeElementTag: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
    activeElementKey: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.bKey ?? null : null,
    bodyIsActive: document.activeElement === document.body,
    wrapperCount: wrappers.length,
    wrappers,
  };
})()`;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function directChildTagFor(constructionId) {
  switch (constructionId) {
    case "button": return "button";
    case "svg": return "svg";
    case "image": return "img";
    case "link": return "a";
    case "text-span": return "span";
    case "nested-button": return "div";
    default: throw new Error(`unknown construction ${constructionId}`);
  }
}

function childTagFor(constructionId) {
  switch (constructionId) {
    case "button": return "button";
    case "svg": return "svg";
    case "image": return "img";
    case "link": return "a";
    case "text-span": return "span";
    case "nested-button": return "button";
    default: throw new Error(`unknown construction ${constructionId}`);
  }
}

function signatureEvidenceOf(props) {
  return {
    tag: props?.tag ?? null,
    role: props?.role ?? null,
    contentEditable: props?.contentEditable ?? null,
    childElementCount: props?.childElementCount ?? null,
    positiveAreaChildCount: props?.positiveAreaChildCount ?? null,
    directTextPresent: props?.directTextPresent ?? null,
    nonFormatDirectTextPresent: props?.nonFormatDirectTextPresent ?? null,
    beforeContentPresent: props?.beforeContentPresent ?? null,
    afterContentPresent: props?.afterContentPresent ?? null,
    backgroundImagePresent: props?.backgroundImagePresent ?? null,
    maskImagePresent: props?.maskImagePresent ?? null,
    tabIndexFocus: props?.tabIndexFocus ?? null,
    pointerCursor: props?.pointerCursor ?? null,
    parentPointerCursor: props?.parentPointerCursor ?? null,
  };
}

async function buildPageBundle() {
  const bundled = await build({
    stdin: {
      contents: entrySource,
      resolveDir: repo,
      loader: "ts",
      sourcefile: "capture-b-page-entry.ts",
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

async function newTarget(url) {
  const response = await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`CDP /json/new failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function closeTarget(targetId) {
  try {
    const response = await fetch(`${cdp}/json/close/${encodeURIComponent(targetId)}`);
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

async function measureTarget(call, key) {
  const measured = await evaluate(call, `(() => {
    const el = document.querySelector(${JSON.stringify(`[data-b-key="${key}"]`)});
    if (!el) return { error: "missing target" };
    const before = { x: scrollX, y: scrollY };
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const after = { x: scrollX, y: scrollY };
    const scrolled = before.x !== after.x || before.y !== after.y;
    const scrollInfo = { before, after, scrolled };
    const r = el.getBoundingClientRect();
    const first = el.firstElementChild;
    const c = first ? first.getBoundingClientRect() : null;
    return {
      scrollInfo,
      wrapper: { x: r.x, y: r.y, width: r.width, height: r.height },
      child: c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  if (measured === null || measured === undefined || measured.error) {
    throw new Error(`measure ${key} failed: ${JSON.stringify(measured)}`);
  }
  return measured;
}

async function readActive(call) {
  return await evaluate(call, `(() => ({
    tag: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
    key: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.bKey ?? null : null,
    id: document.activeElement ? document.activeElement.id || null : null,
  }))()`);
}

async function clickAt(call, x, y) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(SETTLE_MS);
}

function pickWrapperPoints(wrapper, child, viewport) {
  const inset = 6;
  const margin = 2;
  const raw = [
    [wrapper.x + inset, wrapper.y + inset],
    [wrapper.x + wrapper.width - inset, wrapper.y + inset],
    [wrapper.x + inset, wrapper.y + wrapper.height - inset],
    [wrapper.x + wrapper.width - inset, wrapper.y + wrapper.height - inset],
    [wrapper.x + wrapper.width / 2, wrapper.y + inset],
    [wrapper.x + inset, wrapper.y + wrapper.height / 2],
    [wrapper.x + wrapper.width - inset, wrapper.y + wrapper.height / 2],
    [wrapper.x + wrapper.width / 2, wrapper.y + wrapper.height - inset],
  ];
  const insideWrapper = (x, y) => x >= wrapper.x + 1 && x <= wrapper.x + wrapper.width - 1
    && y >= wrapper.y + 1 && y <= wrapper.y + wrapper.height - 1;
  const insideViewport = (x, y) => x >= 0 && y >= 0 && x < viewport.width && y < viewport.height;
  const outsideChild = (x, y) => !child
    || x <= child.x - margin || x >= child.x + child.width + margin
    || y <= child.y - margin || y >= child.y + child.height + margin;
  const points = [];
  const seen = new Set();
  for (const [x, y] of raw) {
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!insideWrapper(x, y) || !insideViewport(x, y) || !outsideChild(x, y)) continue;
    points.push({ x, y });
  }
  return points;
}

async function focusWrapper(call, wrapperKey) {
  const measured = await measureTarget(call, wrapperKey);
  if (measured.scrollInfo.scrolled) {
    throw new Error(`wrapper ${wrapperKey} needed a scroll before focus; the fixture must fit the viewport: ${JSON.stringify(measured.scrollInfo)}`);
  }
  const points = pickWrapperPoints(measured.wrapper, measured.child, measured.viewport);
  if (points.length === 0) {
    throw new Error(`no clear wrapper padding point for ${wrapperKey}: ${JSON.stringify(measured)}`);
  }
  const attempts = [];
  for (const point of points.slice(0, 6)) {
    await clickAt(call, point.x, point.y);
    const active = await readActive(call);
    const matched = active.key === wrapperKey;
    attempts.push({ x: point.x, y: point.y, activeKey: active.key, activeTag: active.tag, matched });
    if (matched) {
      return {
        kind: "mouse",
        target: "wrapper",
        targetKey: wrapperKey,
        clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
        selected: point,
        attempts,
        observedActiveKey: active.key,
        settleMs: SETTLE_MS,
      };
    }
  }
  throw new Error(`wrapper click did not focus ${wrapperKey}: ${JSON.stringify(attempts)}`);
}

async function focusParking(call) {
  const measured = await measureTarget(call, "b-parking");
  const point = {
    x: measured.wrapper.x + measured.wrapper.width / 2,
    y: measured.wrapper.y + measured.wrapper.height / 2,
  };
  await clickAt(call, point.x, point.y);
  const active = await readActive(call);
  if (active.key !== "b-parking") {
    throw new Error(`parking click did not focus b-parking: ${JSON.stringify(active)}`);
  }
  return {
    kind: "mouse",
    target: "parking-control",
    targetKey: "b-parking",
    clickSequence: ["mouseMoved", "mousePressed", "mouseReleased"],
    selected: point,
    attempts: [{ x: point.x, y: point.y, activeKey: active.key, activeTag: active.tag, matched: true }],
    observedActiveKey: active.key,
    settleMs: SETTLE_MS,
  };
}

async function captureState(call, stateKey) {
  const raw = await evaluate(call, `JSON.stringify(window.__bRunB(${JSON.stringify(stateKey)}))`, 30000);
  if (typeof raw !== "string") {
    throw new Error(`observeLiveDom returned a non-string payload for ${stateKey}`);
  }
  return JSON.parse(raw);
}

function verifyState(payload, construction, state) {
  const stateKey = `${construction.id}-${state.id}`;
  const wrapperKey = `b-wrapper-${stateKey}`;
  const childKey = `b-child-${stateKey}`;
  const middleKey = construction.id === "nested-button" ? `b-middle-${stateKey}` : null;
  const refs = new Map(payload.objectReferences.map((ref) => [ref.key, ref]));
  const props = new Map(payload.properties.map((row) => [row.nodeRef, row]));
  const nodes = new Map(payload.nodes.map((row) => [row.nodeRef, row]));
  const wires = new Map(payload.wires.map((row) => [row.nodeRef, row.wires]));
  const wrapperRef = refs.get(wrapperKey) ?? null;
  const childRef = refs.get(childKey) ?? null;
  const middleRef = middleKey ? refs.get(middleKey) ?? null : null;
  const wrapperProps = wrapperRef ? props.get(wrapperRef.nodeRef) ?? null : null;
  const childProps = childRef ? props.get(childRef.nodeRef) ?? null : null;
  const wrapperNode = wrapperRef ? nodes.get(wrapperRef.nodeRef) ?? null : null;
  const childNode = childRef ? nodes.get(childRef.nodeRef) ?? null : null;
  const middleNode = middleRef ? nodes.get(middleRef.nodeRef) ?? null : null;
  const wrapperWires = wrapperRef ? wires.get(wrapperRef.nodeRef) ?? null : null;
  const declaredTabIndex = wrapperRef?.attributes?.tabindex ?? null;
  const expectedActiveKey = state.expectedActive ? wrapperKey : "b-parking";
  const expectedChildTag = childTagFor(construction.id);
  const signature = wrapperWires ? {
    neutral_single_element_wrapper: wrapperWires.neutral_single_element_wrapper ?? null,
    neutral_single_positive_wrapper: wrapperWires.neutral_single_positive_wrapper ?? null,
    neutral_single_child: wrapperWires.neutral_single_child ?? null,
    neutral_focusable_control: wrapperWires.neutral_focusable_control ?? null,
    neutral_actual_focus: wrapperWires.neutral_actual_focus ?? null,
    own_pointer_boundary: wrapperWires.own_pointer_boundary ?? null,
  } : null;
  const signatureHit = signature !== null
    && (signature.neutral_single_element_wrapper === 1 || signature.neutral_single_positive_wrapper === 1);
  const checks = {
    wrapperReference: { expected: true, actual: Boolean(wrapperRef), matched: Boolean(wrapperRef) },
    childReference: { expected: true, actual: Boolean(childRef), matched: Boolean(childRef) },
    middleReference: { expected: Boolean(middleKey), actual: Boolean(middleRef), matched: Boolean(middleKey) === Boolean(middleRef) },
    wrapperProperties: { expected: true, actual: Boolean(wrapperProps), matched: Boolean(wrapperProps) },
    childProperties: { expected: true, actual: Boolean(childProps), matched: Boolean(childProps) },
    wrapperTag: { expected: "div", actual: wrapperNode?.tag ?? null, matched: wrapperNode?.tag === "div" },
    middleTag: {
      expected: middleKey ? "div" : null,
      actual: middleNode?.tag ?? null,
      matched: middleKey ? middleNode?.tag === "div" : true,
    },
    activeElementFocus: {
      expected: state.expectedActive,
      actual: wrapperProps?.activeElementFocus ?? null,
      matched: wrapperProps?.activeElementFocus === state.expectedActive,
    },
    tabIndexFocus: {
      expected: state.expectedTabIndex,
      actual: wrapperProps?.tabIndexFocus ?? null,
      matched: wrapperProps?.tabIndexFocus === state.expectedTabIndex,
    },
    declaredTabIndex: {
      expected: state.expectedTabIndex ? "0" : null,
      actual: declaredTabIndex,
      matched: declaredTabIndex === (state.expectedTabIndex ? "0" : null),
    },
    activeElementKey: {
      expected: expectedActiveKey,
      actual: payload.focus.activeElementKey,
      matched: payload.focus.activeElementKey === expectedActiveKey,
    },
    wrapperChildCount: {
      expected: 1,
      actual: wrapperProps?.childElementCount ?? null,
      matched: wrapperProps?.childElementCount === 1,
    },
    wrapperPositiveChildCount: {
      expected: 1,
      actual: wrapperProps?.positiveAreaChildCount ?? null,
      matched: wrapperProps?.positiveAreaChildCount === 1,
    },
    wrapperNoDirectText: {
      expected: false,
      actual: wrapperProps?.nonFormatDirectTextPresent ?? null,
      matched: wrapperProps?.nonFormatDirectTextPresent === false,
    },
    childPreserved: {
      expected: true,
      actual: Boolean(childProps && childNode),
      matched: Boolean(childProps && childNode),
    },
    childTag: {
      expected: expectedChildTag,
      actual: childNode?.tag ?? null,
      matched: childNode?.tag === expectedChildTag,
    },
  };
  return {
    matched: Object.values(checks).every((check) => check.matched),
    checks,
    signature,
    signatureHit,
    signatureEvidence: signatureEvidenceOf(wrapperProps),
    references: {
      wrapper: wrapperRef,
      child: childRef,
      middle: middleRef,
    },
  };
}

async function writeCapture(value, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 1));
}

const bundleCode = await buildPageBundle();

const capture = {
  schemaVersion: "browser-focus-ignore-capture-b.v1",
  status: "running",
  fixture: {
    path: fixture,
    fileUrl: pathToFileURL(fixture).href,
  },
  oracle: {
    path: resolve(dirname(out), "oracle-b.json"),
    note: "Labels are derived from the shared contract; this capture does not predict labels.",
  },
  cdp: {
    endpoint: cdp,
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
  if (capture.initialPage.wrapperCount !== CONSTRUCTIONS.length * STATES.length) {
    throw new Error(`expected ${CONSTRUCTIONS.length * STATES.length} wrappers, found ${capture.initialPage.wrapperCount}`);
  }
  if (!capture.initialPage.bodyIsActive) {
    throw new Error(`fixture must start with body as activeElement, found ${JSON.stringify(capture.initialPage.activeElementKey)}`);
  }
  const expectedWrapperKeys = new Set(CONSTRUCTIONS.flatMap((construction) => STATES.map((state) => `b-wrapper-${construction.id}-${state.id}`)));
  const actualWrapperKeys = new Set(capture.initialPage.wrappers.map((wrapper) => wrapper.key));
  for (const key of expectedWrapperKeys) {
    if (!actualWrapperKeys.has(key)) throw new Error(`initial page is missing wrapper ${key}`);
  }
  for (const wrapper of capture.initialPage.wrappers) {
    if (wrapper.childElementCount !== 1) {
      throw new Error(`wrapper ${wrapper.key} must have exactly one element child, found ${wrapper.childElementCount}`);
    }
    if (wrapper.directTextNonFormat !== false) {
      throw new Error(`wrapper ${wrapper.key} must not contain direct non-format text`);
    }
    const expectedTabIndex = wrapper.stateId === "s3" ? null : "0";
    if (wrapper.tabindex !== expectedTabIndex) {
      throw new Error(`wrapper ${wrapper.key} declares tabindex ${JSON.stringify(wrapper.tabindex)}, expected ${JSON.stringify(expectedTabIndex)}`);
    }
    const expectedFirstChildTag = directChildTagFor(wrapper.construction);
    if (wrapper.firstChildTag !== expectedFirstChildTag) {
      throw new Error(`wrapper ${wrapper.key} first child is ${wrapper.firstChildTag}, expected ${expectedFirstChildTag}`);
    }
  }

  await evaluate(call, bundleCode, 30000);

  for (const construction of CONSTRUCTIONS) {
    for (const state of STATES) {
      const stateKey = `${construction.id}-${state.id}`;
      const stimulus = state.expectedActive
        ? await focusWrapper(call, `b-wrapper-${stateKey}`)
        : await focusParking(call);
      const payload = await captureState(call, stateKey);
      const verification = verifyState(payload, construction, state);
      const record = {
        construction: construction.id,
        state: state.label,
        stateId: state.id,
        stateKey,
        expectedLabel: state.expectedLabel,
        stimulus,
        verification,
        page: payload.page,
        viewport: payload.viewport,
        focus: payload.focus,
        coverage: payload.coverage,
        nodes: payload.nodes,
        itemObservations: payload.itemObservations,
        properties: payload.properties,
        wires: payload.wires,
        objectReferences: payload.objectReferences,
      };
      capture.states.push(record);
      if (!verification.matched) {
        throw new Error(`state ${stateKey} verification failed: ${JSON.stringify(verification.checks)}`);
      }
    }
  }

  const s3States = capture.states.filter((row) => row.stateId === "s3");
  const hits = s3States.filter((row) => row.verification.signatureHit);
  const firstMiss = s3States.find((row) => !row.verification.signatureHit);
  capture.defectSignature = {
    criterion: "S3 wrapper wires: neutral_single_element_wrapper === 1 or neutral_single_positive_wrapper === 1",
    hitCount: hits.length,
    reproduced: hits.length > 0,
    hits: hits.map((row) => ({
      construction: row.construction,
      state: row.state,
      signature: row.verification.signature,
    })),
    note: hits.length > 0
      ? "At least one S3 state hit the defect wrapper signature."
      : "Not reproduced. Inspect the S3 signatureEvidence and checks; no gold was changed and no S3 state was relabelled.",
    firstMissEvidence: firstMiss ? {
      construction: firstMiss.construction,
      state: firstMiss.state,
      signature: firstMiss.verification.signature,
      evidence: firstMiss.verification.signatureEvidence,
    } : null,
  };
  if (!capture.defectSignature.reproduced) {
    console.error("warning: S3 defect wrapper signature not reproduced; see capture.defectSignature");
  }

  capture.status = "complete";
  capture.completedAt = new Date().toISOString();
  await writeCapture(capture, out);
  console.log(JSON.stringify({
    out,
    status: capture.status,
    states: capture.states.length,
    defectSignatureHits: capture.defectSignature.hitCount,
    viewport: capture.initialPage.viewport,
  }));
} catch (error) {
  capture.status = "failed";
  capture.error = error instanceof Error ? error.message : String(error);
  capture.failedAt = new Date().toISOString();
  try {
    await writeCapture(capture, out);
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
