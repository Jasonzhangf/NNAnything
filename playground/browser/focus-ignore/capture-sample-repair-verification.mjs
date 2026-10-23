// Host-side capture for fixture-sample-repair-verification.html.
//
// This script is intentionally not run inside the restricted worker sandbox.
// It opens one owned tab over CDP, uses real native mouse events to move focus,
// runs the production observeLiveDom adapter, and writes one JSON file. Script
// code never invokes a focus or click API, writes observation fields, or lets a
// page script move focus. The fixture only establishes normal HTML initial
// state.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const DEFAULT_FIXTURE = resolve(HERE, "fixture-sample-repair-verification.html");
const DEFAULT_PORT = 9444;

export const POSITIVE_CASES = Object.freeze([
  { caseId: "w1-minus", construction: "W1", tabindex: "-1" },
  { caseId: "w1-zero", construction: "W1", tabindex: "0" },
  { caseId: "w2-minus", construction: "W2", tabindex: "-1" },
  { caseId: "w2-zero", construction: "W2", tabindex: "0" },
  { caseId: "w3-minus", construction: "W3", tabindex: "-1" },
  { caseId: "w3-zero", construction: "W3", tabindex: "0" },
]);
export const IGNORE_CASES = Object.freeze([
  { caseId: "w1-ignore", construction: "W1", descendant: "w1-ignore-open" },
  { caseId: "w2-ignore", construction: "W2", descendant: "w2-ignore-open" },
  { caseId: "w3-ignore", construction: "W3", descendant: "w3-ignore-open" },
]);
export const POSITIVE_STATES = Object.freeze(["initial", "focused", "blurred", "refocused"]);
export const IGNORE_STATES = Object.freeze(["unfocused", "focused"]);

export function buildStatePlan() {
  const rows = [];
  for (const item of POSITIVE_CASES) {
    for (const state of POSITIVE_STATES) {
      rows.push({
        kind: "positive",
        caseId: item.caseId,
        construction: item.construction,
        tabindex: item.tabindex,
        state,
        gold: "container",
      });
    }
  }
  for (const item of IGNORE_CASES) {
    for (const state of IGNORE_STATES) {
      rows.push({
        kind: "ignore",
        caseId: item.caseId,
        construction: item.construction,
        descendant: item.descendant,
        state,
        gold: "ignore",
      });
    }
  }
  return Object.freeze(rows);
}

const CAPTURE_ENTRY_SOURCE = String.raw`
import { createStableNodeRefRegistry, observeLiveDom } from "../../lib/adapters/browser/live-dom.js";
import { extractBasicKindWires } from "../../lib/filters/basic-kinds.js";

const registry = createStableNodeRefRegistry("sample-repair-verification");
const SIGNATURE_WIRES = [
  "neutral_single_child",
  "neutral_single_element_wrapper",
  "neutral_single_positive_wrapper",
  "neutral_multi_child",
  "div_multi_child",
  "neutral_focusable_control",
  "neutral_actual_focus",
  "own_focus_target",
  "own_pointer_boundary",
  "neutral_same_rect_wrapper",
  "neutral_inherited_pointer_wrapper",
  "composite_descendant_text",
  "neutral_structural_peers",
  "neutral_structural_heterogeneity",
  "neutral_child_multiplicity",
];

function rectOf(element) {
  if (!(element instanceof Element)) return null;
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function describe(element) {
  if (!(element instanceof Element)) return null;
  const holder = element.closest("[data-v-case]");
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id === "" ? null : element.id,
    caseId: holder === null ? null : holder.getAttribute("data-v-case"),
    descendantId: element.getAttribute("data-v-descendant"),
    parking: element.hasAttribute("data-v-parking"),
    construction: element.getAttribute("data-v-construction"),
    gold: element.getAttribute("data-v-gold"),
    shape: element.getAttribute("data-v-shape"),
    purpose: element.getAttribute("data-v-purpose"),
    tabindexAttribute: element.getAttribute("tabindex"),
    tabIndexProperty: element.tabIndex,
    isActive: document.activeElement === element,
    isConnected: element.isConnected,
    rect: rectOf(element),
  };
}

function caseElement(caseId) {
  const element = document.querySelector('[data-v-case="' + caseId + '"]');
  if (!(element instanceof Element)) throw new Error("missing case " + caseId);
  return element;
}

function descendantElement(caseId, descendantId) {
  const holder = caseElement(caseId);
  const element = holder.querySelector('[data-v-descendant="' + descendantId + '"]');
  if (!(element instanceof Element)) throw new Error("missing descendant " + descendantId + " in " + caseId);
  return element;
}

function parkingElement() {
  const element = document.querySelector("[data-v-parking]");
  if (!(element instanceof Element)) throw new Error("missing parking control");
  return element;
}

function legalPointFor(element) {
  if (!(element instanceof Element)) return null;
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return null;
  const inset = Math.min(6, Math.max(2, Math.min(rect.width, rect.height) / 10));
  const candidates = [];
  const xs = [rect.left + inset, rect.left + rect.width / 2, rect.right - inset];
  const ys = [rect.top + inset, rect.top + rect.height / 2, rect.bottom - inset];
  for (const y of ys) for (const x of xs) candidates.push([x, y]);
  for (let index = 1; index <= 8; index++) {
    for (let other = 1; other <= 8; other++) {
      candidates.push([
        rect.left + (rect.width * index) / 9,
        rect.top + (rect.height * other) / 9,
      ]);
    }
  }
  for (const point of candidates) {
    const x = point[0], y = point[1];
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    if (document.elementFromPoint(x, y) === element) {
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        hitTag: element.tagName.toLowerCase(),
      };
    }
  }
  return null;
}

function factsFor(snapshot, element) {
  const empty = { ref: null, row: null, node: null, evidence: null, wires: null, allWires: null };
  if (!(element instanceof Element)) return empty;
  const ref = registry.refByElement.get(element) ?? null;
  if (ref === null) return empty;
  const row = snapshot.properties.get(ref) ?? null;
  const node = snapshot.observation.nodes.find(function (item) { return item.nodeRef === ref; }) ?? null;
  const evidence = snapshot.evidence.get(ref) ?? null;
  const allWires = row === null ? null : extractBasicKindWires(row);
  const wires = {};
  if (allWires !== null) {
    for (const name of SIGNATURE_WIRES) wires[name] = allWires[name];
  }
  return { ref: ref, row: row, node: node, evidence: evidence, wires: allWires === null ? null : wires, allWires: allWires };
}

function snapshot(caseId, state, kind, descendantId = undefined) {
  const target = caseElement(caseId);
  const descendant = descendantId === undefined
    ? target.querySelector("[data-v-descendant]")
    : descendantElement(caseId, descendantId);
  const parking = parkingElement();
  const observed = observeLiveDom({
    document: document,
    window: window,
    registry: registry,
    excludeRoot: null,
    snapshotRef: "sample-repair-verification/" + caseId + "/" + state,
    documentRef: "sample-repair-verification",
  });
  const targetFacts = factsFor(observed, target);
  const descendantFacts = descendant instanceof Element ? factsFor(observed, descendant) : null;
  const parkingFacts = factsFor(observed, parking);
  return {
    schemaVersion: "browser-focus-sample-repair-verification.snapshot.v1",
    kind: kind,
    caseId: caseId,
    construction: target.getAttribute("data-v-construction"),
    gold: target.getAttribute("data-v-gold"),
    shape: target.getAttribute("data-v-shape"),
    purpose: target.getAttribute("data-v-purpose"),
    state: state,
    snapshotRef: observed.snapshotRef,
    documentRef: observed.documentRef,
    pageState: {
      readyState: document.readyState,
      url: location.href,
      viewport: {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      scroll: { x: window.scrollX, y: window.scrollY },
      activeElement: describe(document.activeElement),
      parking: describe(parking),
    },
    activeElement: describe(document.activeElement),
    target: describe(target),
    descendant: describe(descendant instanceof Element ? descendant : null),
    rect: rectOf(target),
    connected: target.isConnected,
    tabindexAttribute: target.getAttribute("tabindex"),
    tabIndexProperty: target.tabIndex,
    targetRef: targetFacts.ref,
    descendantRef: descendantFacts === null ? null : descendantFacts.ref,
    parkingRef: parkingFacts.ref,
    targetProperties: targetFacts.row,
    descendantProperties: descendantFacts === null ? null : descendantFacts.row,
    targetNode: targetFacts.node,
    targetEvidence: targetFacts.evidence,
    wires: targetFacts.wires,
    targetWires: targetFacts.allWires,
    descendantWires: descendantFacts === null ? null : descendantFacts.wires,
    descendantAllWires: descendantFacts === null ? null : descendantFacts.allWires,
    parkingWires: parkingFacts.wires,
    properties: Array.from(observed.properties, function (entry) {
      return { nodeRef: entry[0], ...entry[1] };
    }),
    itemObservations: observed.itemObservations,
    observationNodes: observed.observation.nodes,
    observationCoverage: observed.observation.coverage,
    observationViewport: observed.observation.viewport,
    coverage: observed.coverage,
  };
}

window.__captureRepairVerification = {
  caseElement: caseElement,
  descendantElement: descendantElement,
  parkingElement: parkingElement,
  describe: describe,
  legalPointFor: legalPointFor,
  snapshot: snapshot,
};
`;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function requireAbsolute(path, label) {
  if (!path) throw new Error(`missing ${label}`);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  return resolve(path);
}

function parsePort(raw) {
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return port;
}

async function createOwnTarget(cdpHttp) {
  const url = new URL("/json/new", cdpHttp);
  url.searchParams.set("url", "about:blank");
  let lastError = null;
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(url, { method });
      if (response.ok) return await response.json();
      lastError = new Error(`create target failed: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("create target failed");
}

async function closeOwnTarget(cdpHttp, targetId) {
  const url = `${cdpHttp}/json/close/${encodeURIComponent(targetId)}`;
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(url, { method });
      if (response.ok || response.status === 404) return;
    } catch {
      // Closing is best effort only after the owned tab has been used.
    }
  }
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error !== undefined) {
      const details = message.error && typeof message.error.message === "string"
        ? message.error.message
        : JSON.stringify(message.error);
      waiter.reject(new Error(`${waiter.method}: ${details}`));
    } else {
      waiter.resolve(message.result ?? {});
    }
  });

  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`${method}: timeout`));
      }, 15000);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression, options = {}) => {
    const response = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise === true,
    });
    if (response.exceptionDetails !== undefined) {
      const details = response.exceptionDetails && response.exceptionDetails.text
        ? response.exceptionDetails.text
        : JSON.stringify(response.exceptionDetails);
      throw new Error(`Runtime.evaluate failed: ${details}`);
    }
    return response.result ? response.result.value : undefined;
  };

  return {
    call,
    evaluate,
    close: () => socket.close(),
  };
}

async function waitFor(predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`timeout waiting for ${description}`);
}

async function clickPoint(call, point, label) {
  if (!point || ![point.x, point.y].every(Number.isFinite)) {
    throw new Error(`invalid click geometry for ${label}: ${JSON.stringify(point)}`);
  }
  if (point.x < 0 || point.y < 0 || point.x >= 1440 || point.y >= 900) {
    throw new Error(`click point outside viewport for ${label}: ${JSON.stringify(point)}`);
  }
  await call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    buttons: 0,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(120);
}

function targetExpression(caseId) {
  return `window.__captureRepairVerification.caseElement(${JSON.stringify(caseId)})`;
}

function descendantExpression(caseId, descendantId) {
  return `window.__captureRepairVerification.descendantElement(${JSON.stringify(caseId)}, ${JSON.stringify(descendantId)})`;
}

function parkingExpression() {
  return "window.__captureRepairVerification.parkingElement()";
}

async function legalPoint(cdp, expression, label) {
  const point = await cdp.evaluate(`window.__captureRepairVerification.legalPointFor(${expression})`);
  if (point === null || point === undefined) return null;
  const hit = await cdp.evaluate(`document.elementFromPoint(${point.x}, ${point.y}) === (${expression})`);
  if (hit !== true) return null;
  return point;
}

async function assertActive(cdp, expression, label) {
  const active = await cdp.evaluate(`${expression} === document.activeElement`);
  if (active !== true) {
    const descriptor = await cdp.evaluate("window.__captureRepairVerification.describe(document.activeElement)");
    throw new Error(`activeElement mismatch for ${label}: ${JSON.stringify(descriptor)}`);
  }
}

function wireValue(snapshot, name) {
  return snapshot && snapshot.wires ? snapshot.wires[name] : undefined;
}

function assertPositiveTargetWires(row, snapshot) {
  const properties = snapshot.targetProperties;
  if (properties === null) throw new Error(`missing target properties for ${row.caseId}`);
  if (snapshot.connected !== true) throw new Error(`target disconnected for ${row.caseId}`);
  if (snapshot.tabindexAttribute !== row.tabindex) {
    throw new Error(`tabindex mismatch for ${row.caseId}: ${snapshot.tabindexAttribute}`);
  }
  if (properties.tabIndexFocus !== (row.tabindex === "0")) {
    throw new Error(`tabIndexFocus mismatch for ${row.caseId}: ${properties.tabIndexFocus}`);
  }
  if (wireValue(snapshot, "neutral_focusable_control") !== (row.tabindex === "0" ? 1 : 0)) {
    throw new Error(`neutral_focusable_control mismatch for ${row.caseId}`);
  }
  if (row.construction === "W3") {
    if (wireValue(snapshot, "neutral_multi_child") !== 1) throw new Error(`W3 neutral_multi_child mismatch for ${row.caseId}`);
    if (wireValue(snapshot, "div_multi_child") !== 1) throw new Error(`W3 div_multi_child mismatch for ${row.caseId}`);
    if (wireValue(snapshot, "neutral_single_child") !== 0) throw new Error(`W3 neutral_single_child mismatch for ${row.caseId}`);
  } else {
    if (wireValue(snapshot, "neutral_single_child") !== 1) throw new Error(`${row.construction} neutral_single_child mismatch for ${row.caseId}`);
    if (row.tabindex === "-1") {
      if (wireValue(snapshot, "neutral_single_element_wrapper") !== 1) {
        throw new Error(`${row.construction} single_element_wrapper mismatch for ${row.caseId}`);
      }
      if (wireValue(snapshot, "neutral_single_positive_wrapper") !== 1) {
        throw new Error(`${row.construction} single_positive_wrapper mismatch for ${row.caseId}`);
      }
    } else {
      // Those two wires explicitly encode a wrapper without a non-negative tabindex.
      if (wireValue(snapshot, "neutral_single_element_wrapper") !== 0) {
        throw new Error(`${row.construction} focusable single_element_wrapper must be 0 for ${row.caseId}`);
      }
      if (wireValue(snapshot, "neutral_single_positive_wrapper") !== 0) {
        throw new Error(`${row.construction} focusable single_positive_wrapper must be 0 for ${row.caseId}`);
      }
    }
  }
  if (row.state === "focused" || row.state === "refocused") {
    if (properties.activeElementFocus !== true) throw new Error(`activeElementFocus must be true for ${row.caseId}/${row.state}`);
    if (wireValue(snapshot, "neutral_actual_focus") !== 1) throw new Error(`neutral_actual_focus must be 1 for ${row.caseId}/${row.state}`);
    if (wireValue(snapshot, "own_focus_target") !== 1) throw new Error(`own_focus_target must be 1 for ${row.caseId}/${row.state}`);
  } else {
    if (properties.activeElementFocus !== false) throw new Error(`activeElementFocus must be false for ${row.caseId}/${row.state}`);
    if (wireValue(snapshot, "neutral_actual_focus") !== 0) throw new Error(`neutral_actual_focus must be 0 for ${row.caseId}/${row.state}`);
  }
}

function assertIgnoreWires(row, snapshot) {
  const properties = snapshot.targetProperties;
  if (properties === null) throw new Error(`missing ignore properties for ${row.caseId}`);
  if (snapshot.connected !== true) throw new Error(`ignore wrapper disconnected for ${row.caseId}`);
  if (snapshot.tabindexAttribute !== null) throw new Error(`ignore wrapper must not have tabindex for ${row.caseId}`);
  if (properties.tabIndexFocus !== false) throw new Error(`ignore wrapper tabIndexFocus must be false for ${row.caseId}`);
  if (properties.activeElementFocus !== false) throw new Error(`ignore wrapper activeElementFocus must be false for ${row.caseId}`);
  if (wireValue(snapshot, "own_focus_target") !== 0) throw new Error(`ignore own_focus_target must be 0 for ${row.caseId}`);
  if (row.construction === "W3") {
    if (wireValue(snapshot, "neutral_multi_child") !== 1) throw new Error(`W3 ignore neutral_multi_child mismatch for ${row.caseId}`);
    if (wireValue(snapshot, "div_multi_child") !== 1) throw new Error(`W3 ignore div_multi_child mismatch for ${row.caseId}`);
  } else {
    if (wireValue(snapshot, "neutral_single_child") !== 1) throw new Error(`${row.construction} ignore neutral_single_child mismatch for ${row.caseId}`);
    if (wireValue(snapshot, "neutral_single_element_wrapper") !== 1) {
      throw new Error(`${row.construction} ignore single_element_wrapper mismatch for ${row.caseId}`);
    }
    if (wireValue(snapshot, "neutral_single_positive_wrapper") !== 1) {
      throw new Error(`${row.construction} ignore single_positive_wrapper mismatch for ${row.caseId}`);
    }
  }
  const descendant = snapshot.descendantProperties;
  if (descendant === null) throw new Error(`missing ignore descendant for ${row.caseId}`);
  if (row.state === "focused") {
    if (descendant.activeElementFocus !== true) throw new Error(`ignore descendant must be active for ${row.caseId}`);
  } else if (descendant.activeElementFocus !== false) {
    throw new Error(`ignore descendant must be inactive for ${row.caseId}`);
  }
}

async function main() {
  const fixture = arg("--fixture") === undefined ? DEFAULT_FIXTURE : requireAbsolute(arg("--fixture"), "--fixture");
  const out = requireAbsolute(arg("--out"), "--out");
  const port = parsePort(arg("--port"));
  const cdpHttp = `http://127.0.0.1:${port}`;
  const fixtureUrl = pathToFileURL(fixture).href;

  const bundled = await build({
    stdin: {
      contents: CAPTURE_ENTRY_SOURCE,
      resolveDir: resolve(REPO, "playground/browser"),
      sourcefile: "capture-sample-repair-verification-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  });
  const bundleCode = bundled.outputFiles[0].text;

  const target = await createOwnTarget(cdpHttp);
  let cdp;
  const states = [];
  const invalidConstructions = [];

  try {
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable", {});
    await cdp.call("Runtime.enable", {});
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 900,
    });
    await cdp.call("Page.navigate", { url: fixtureUrl });
    await cdp.call("Page.bringToFront", {});
    await waitFor(async () => {
      try {
        const state = await cdp.evaluate("({ ready: document.readyState, href: location.href })");
        return state !== undefined && state.ready === "complete" && state.href === fixtureUrl;
      } catch {
        return false;
      }
    }, "fixture load");
    await delay(150);
    await cdp.evaluate(`${bundleCode}\n;typeof window.__captureRepairVerification === "object"`);
    await waitFor(async () => await cdp.evaluate('typeof window.__captureRepairVerification === "object"'), "capture bundle");

    const viewport = await cdp.evaluate("({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })");
    if (viewport.width !== 1440 || viewport.height !== 900) {
      throw new Error(`viewport mismatch: ${JSON.stringify(viewport)}`);
    }
    if (viewport.scrollX !== 0 || viewport.scrollY !== 0) {
      throw new Error(`fixture must not scroll: ${JSON.stringify(viewport)}`);
    }

    const parkingPoint = await legalPoint(cdp, parkingExpression(), "parking");
    if (parkingPoint === null) throw new Error("fixture invalid: parking control has no legal hit point");

    const targetPoints = new Map();
    for (const item of POSITIVE_CASES) {
      const point = await legalPoint(cdp, targetExpression(item.caseId), `${item.caseId} target`);
      if (point === null) {
        invalidConstructions.push({
          caseId: item.caseId,
          construction: item.construction,
          object: "target",
          reason: "invalid-construction: no legal hit point for container",
        });
      } else {
        targetPoints.set(item.caseId, point);
      }
    }

    const ignorePoints = new Map();
    for (const item of IGNORE_CASES) {
      const wrapperPoint = await legalPoint(cdp, targetExpression(item.caseId), `${item.caseId} wrapper`);
      if (wrapperPoint === null) {
        invalidConstructions.push({
          caseId: item.caseId,
          construction: item.construction,
          object: "wrapper",
          reason: "invalid-construction: no legal hit point for wrapper",
        });
        continue;
      }
      const descendantPoint = await legalPoint(cdp, descendantExpression(item.caseId, item.descendant), `${item.caseId} descendant`);
      if (descendantPoint === null) {
        invalidConstructions.push({
          caseId: item.caseId,
          construction: item.construction,
          object: "descendant",
          reason: "invalid-construction: no legal hit point for focusable descendant",
        });
        continue;
      }
      ignorePoints.set(item.caseId, { wrapperPoint, descendantPoint });
    }

    const invalidCaseIds = new Set(invalidConstructions.map(item => item.caseId));
    const plan = buildStatePlan();

    const positiveStateActions = {
      initial: { point: null, activeExpression: parkingExpression(), expectedActive: "parking" },
      focused: { point: "target", activeExpression: null, expectedActive: "target" },
      blurred: { point: null, activeExpression: parkingExpression(), expectedActive: "parking" },
      refocused: { point: "target", activeExpression: null, expectedActive: "target" },
    };

    for (const row of plan) {
      if (invalidCaseIds.has(row.caseId)) continue;

      if (row.kind === "positive") {
        const targetPoint = targetPoints.get(row.caseId);
        if (targetPoint === undefined) throw new Error(`missing target point for ${row.caseId}`);
        const action = positiveStateActions[row.state];
        if (action === undefined) throw new Error(`unexpected positive state ${row.state} for ${row.caseId}`);

        if (action.point === "target") {
          await clickPoint(cdp.call, targetPoint, `${row.caseId} ${row.state}`);
          await assertActive(cdp, targetExpression(row.caseId), `${row.caseId} ${row.state}`);
        } else {
          await clickPoint(cdp.call, parkingPoint, `${row.caseId} ${row.state} parking`);
          await assertActive(cdp, action.activeExpression, `${row.caseId} ${row.state} parking`);
        }
        const snapshot = await cdp.evaluate(`window.__captureRepairVerification.snapshot(${JSON.stringify(row.caseId)}, ${JSON.stringify(row.state)}, "positive")`);
        snapshot.hostAssertions = {
          hitTestMatches: true,
          activeElementMatches: true,
          expectedActive: action.expectedActive,
        };
        assertPositiveTargetWires(row, snapshot);
        states.push(snapshot);
      } else {
        const points = ignorePoints.get(row.caseId);
        if (points === undefined) throw new Error(`missing ignore points for ${row.caseId}`);
        if (row.state === "unfocused") {
          await clickPoint(cdp.call, parkingPoint, `${row.caseId} unfocused parking`);
          await assertActive(cdp, parkingExpression(), `${row.caseId} unfocused parking`);
        } else {
          await clickPoint(cdp.call, points.descendantPoint, `${row.caseId} descendant`);
          await assertActive(cdp, descendantExpression(row.caseId, row.descendant), `${row.caseId} descendant`);
        }
        const snapshot = await cdp.evaluate(`window.__captureRepairVerification.snapshot(${JSON.stringify(row.caseId)}, ${JSON.stringify(row.state)}, "ignore", ${JSON.stringify(row.descendant)})`);
        snapshot.hostAssertions = {
          hitTestMatches: true,
          activeElementMatches: true,
          expectedActive: row.state === "unfocused" ? "parking" : "descendant",
        };
        assertIgnoreWires(row, snapshot);
        states.push(snapshot);
      }
    }

    const result = {
      schemaVersion: "browser-focus-sample-repair-verification.capture.v1",
      fixture: { path: fixture, url: fixtureUrl },
      cdp: cdpHttp,
      port,
      targetId: target.id,
      capturedAt: new Date().toISOString(),
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      plan: {
        positiveCases: POSITIVE_CASES,
        ignoreCases: IGNORE_CASES,
        positiveStates: POSITIVE_STATES,
        ignoreStates: IGNORE_STATES,
        expectedStates: plan.length,
      },
      invalidConstructions,
      states,
    };

    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({
      out,
      states: states.length,
      invalidConstructions: invalidConstructions.length,
      cases: states.map(item => item.caseId),
    }));
    if (invalidConstructions.length > 0 || states.length !== plan.length) {
      process.exitCode = 1;
    }
  } finally {
    if (cdp !== undefined) cdp.close();
    await closeOwnTarget(cdpHttp, target.id);
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
