#!/usr/bin/env node
// Host-side capture for the independent dev-family focus fixture.
//
// The worker that authored this file never ran it and never connected to a
// browser. The host runs it while Chrome listens on CDP (--cdp, default
// http://127.0.0.1:9444):
//
//   node playground/browser/focus-ignore/capture-sample-repair-dev.mjs \
//     --fixture <absolute fixture-sample-repair-dev.html> \
//     --out <absolute sample-repair-dev-capture.json>
//
// Only real CDP Input.dispatchMouseEvent streams move focus. The page side
// never synthesizes focus or clicks and never rewrites observation fields.
// The production observeLiveDom adapter is the only observer used.

import { build } from "esbuild";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 90;

const CASE_IDS = [
  "positive-w1-neg1",
  "positive-w1-zero",
  "positive-w2-neg1",
  "positive-w2-zero",
  "positive-w3-neg1",
  "positive-w3-zero",
  "ignore-w1",
  "ignore-w2",
  "ignore-w3",
];

const EXPECTED = {
  "positive-w1-neg1": { construction: "W1", kind: "positive", tabindex: "-1" },
  "positive-w1-zero": { construction: "W1", kind: "positive", tabindex: "0" },
  "positive-w2-neg1": { construction: "W2", kind: "positive", tabindex: "-1" },
  "positive-w2-zero": { construction: "W2", kind: "positive", tabindex: "0" },
  "positive-w3-neg1": { construction: "W3", kind: "positive", tabindex: "-1" },
  "positive-w3-zero": { construction: "W3", kind: "positive", tabindex: "0" },
  "ignore-w1": { construction: "W1", kind: "ignore", tabindex: null },
  "ignore-w2": { construction: "W2", kind: "ignore", tabindex: null },
  "ignore-w3": { construction: "W3", kind: "ignore", tabindex: null },
};

const IGNORE_STATES = ["descendant-initial", "descendant-focused"];

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const usage = "usage: node playground/browser/focus-ignore/capture-sample-repair-dev.mjs --fixture <absolute fixture> --out <absolute capture.json> [--port 9444 | --cdp <http://127.0.0.1:9444>]";
const fixtureArg = arg("--fixture");
const outArg = arg("--out");
if (fixtureArg === undefined || outArg === undefined) {
  console.error(usage);
  process.exit(2);
}
const portValue = arg("--port", "9444");
if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
  console.error(`invalid --port: ${portValue}`);
  process.exit(2);
}
const fixture = isAbsolute(fixtureArg) ? fixtureArg : resolve(process.cwd(), fixtureArg);
const out = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
await access(fixture, fsConstants.R_OK);
const cdmHttp = arg("--cdp", `http://127.0.0.1:${portValue}`);

const entrySource = String.raw`
import { createStableNodeRefRegistry, observeLiveDom } from "./lib/adapters/browser/live-dom.js";
import { extractBasicKindWires } from "./lib/filters/basic-kinds.js";

const registry = createStableNodeRefRegistry("sample-repair-dev");
const SIGNATURE_WIRES = [
  "neutral_single_child",
  "neutral_single_element_wrapper",
  "neutral_single_positive_wrapper",
  "neutral_same_rect_wrapper",
  "neutral_multi_child",
  "neutral_actual_focus",
  "neutral_focusable_control",
  "own_focus_target",
  "own_pointer_boundary",
  "composite_descendant_text",
];

function describe(element) {
  if (!(element instanceof Element)) return null;
  const slot = element.closest("[data-dev-case]");
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    caseId: slot ? slot.getAttribute("data-dev-case") : null,
    role: element.getAttribute("data-dev-target") ?? null,
    ownControl: element.hasAttribute("data-dev-own-control") || null,
    tabindexAttribute: element.getAttribute("tabindex"),
    tabIndexProperty: element.tabIndex,
    isActive: document.activeElement === element,
    isConnected: element.isConnected,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

function locateInCase(caseId, role) {
  const slot = document.querySelector('[data-dev-case="' + caseId + '"]');
  if (!(slot instanceof Element)) throw new Error("missing slot " + caseId);
  const element = slot.querySelector('[data-dev-target="' + role + '"]');
  if (!(element instanceof Element)) throw new Error("missing " + role + " in " + caseId);
  return element;
}

function locateGlobal(role) {
  const element = document.querySelector('[data-dev-target="' + role + '"]');
  if (!(element instanceof Element)) throw new Error("missing global " + role);
  return element;
}

function locateDescendant(caseId) {
  const element = document.querySelector('[data-dev-case="' + caseId + '"] [data-dev-focus-descendant="true"]');
  return element instanceof Element ? describe(element) : null;
}

function snapshotPage(caseId, state) {
  const slot = document.querySelector('[data-dev-case="' + caseId + '"]');
  if (!(slot instanceof Element)) throw new Error("missing slot " + caseId);
  const container = slot.querySelector('[data-dev-target="container"]');
  const children = Array.from(slot.querySelectorAll('[data-dev-target="child"], [data-dev-target="descendant"]'));
  const snapshotRef = "sample-repair-dev/" + caseId + "/" + state;
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef,
    documentRef: "sample-repair-dev",
    readContent: false,
  });
  const refFor = (element) => registry.refByElement.get(element) ?? null;
  const nodeByRef = new Map(snapshot.observation.nodes.map((node) => [node.nodeRef, node]));
  const rowFor = (element) => {
    const ref = refFor(element);
    if (ref === null) return null;
    const properties = snapshot.properties.get(ref);
    if (properties === undefined) return null;
    return { nodeRef: ref, ...properties };
  };
  const wireFor = (element) => {
    const ref = refFor(element);
    if (ref === null) return null;
    const properties = snapshot.properties.get(ref);
    if (properties === undefined) return null;
    const wires = extractBasicKindWires(properties);
    const result = {};
    for (const name of SIGNATURE_WIRES) result[name] = wires[name];
    return result;
  };
  const active = document.activeElement;
  const activeElement = active instanceof Element ? active : null;
  const activeRef = activeElement ? registry.refByElement.get(activeElement) ?? null : null;
  const containerRef = refFor(container);
  const childrenRefs = children.map((element) => ({
    role: element.getAttribute("data-dev-target"),
    nodeRef: refFor(element),
  }));
  return {
    schemaVersion: "browser-focus-sample-repair.capture-dev.snapshot.v1",
    caseId,
    construction: slot.getAttribute("data-dev-construction"),
    kind: slot.getAttribute("data-dev-kind"),
    state,
    snapshotRef,
    documentRef: snapshot.documentRef,
    frameRef: snapshot.frameRef,
    pageState: {
      readyState: document.readyState,
      url: location.href,
      title: document.title,
      viewport: {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      activeElement: describe(activeElement),
      activeElementRef: activeRef,
      parkingRef: registry.refByElement.get(document.querySelector('[data-dev-target="parking"]')) ?? null,
      container: describe(container),
    },
    objectRefs: {
      container: containerRef,
      activeElement: activeRef,
      children: childrenRefs,
    },
    target: {
      tabindexAttribute: container.getAttribute("tabindex"),
      connected: container.isConnected,
      rect: describe(container).rect,
    },
    focusChecks: {
      activeElementRef: activeRef,
      containerRef,
      sameObject: activeRef === containerRef || activeRef === null,
      targetIsActive: document.activeElement === container,
    },
    containerRow: rowFor(container),
    childRows: children.map(rowFor),
    containerWires: wireFor(container),
    childWires: children.map(wireFor),
    properties: Array.from(snapshot.properties, (entry) => ({ nodeRef: entry[0], ...entry[1] })),
    wires: Array.from(snapshot.properties, (entry) => ({ nodeRef: entry[0], wires: extractBasicKindWires(entry[1]) })),
    evidence: snapshot.evidence ? Array.from(snapshot.evidence, (entry) => ({ nodeRef: entry[0], ...entry[1] })) : null,
    observationNodes: { container: nodeByRef.get(containerRef) ?? null },
    observation: {
      viewport: snapshot.observation.viewport,
      coverage: snapshot.observation.coverage,
    },
    liveCoverage: snapshot.coverage,
    captureCoverage: {
      frameContent: "captured",
      directChildren: "complete",
    },
  };
}

function hitProbe(caseId, role, kind) {
  const element = caseId === null ? locateGlobal(role) : locateInCase(caseId, role);
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return {
      ok: false,
      reason: "zero-size",
      element: describe(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }
  const candidates = [
    { label: "center", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    { label: "quarter", x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.75 },
    { label: "wide-quarter", x: rect.x + rect.width * 0.75, y: rect.y + rect.height * 0.25 },
  ];
  for (const candidate of candidates) {
    const px = Math.round(candidate.x) + 0.5;
    const py = Math.round(candidate.y) + 0.5;
    if (px >= 0 && py >= 0 && px < window.innerWidth && py < window.innerHeight) {
      const hit = document.elementFromPoint(px, py);
      if (hit === element) {
        return {
          ok: true,
          label: candidate.label,
          x: px,
          y: py,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          hitObject: describe(hit),
          hitTag: hit ? hit.tagName.toLowerCase() : null,
        };
      }
    }
  }
  const seen = candidates.map((candidate) => {
    const px = Math.round(candidate.x) + 0.5;
    const py = Math.round(candidate.y) + 0.5;
    const hit = document.elementFromPoint(px, py);
    return {
      label: candidate.label,
      x: px,
      y: py,
      hitTag: hit ? hit.tagName.toLowerCase() : null,
      hitRole: hit && hit.getAttribute ? hit.getAttribute("data-dev-target") : null,
    };
  });
  return { ok: false, reason: "no-container-hit", element: describe(element), candidates: seen };
}

function initialProbe() {
  const active = document.activeElement;
  return {
    activeElementTag: active ? active.tagName.toLowerCase() : null,
    activeElementIsBody: active === document.body,
    activeElementId: active && active.id ? active.id : null,
    activeElementRole: active && active.getAttribute ? active.getAttribute("data-dev-target") : null,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

if (typeof window !== "undefined") {
  const api = {
    snapshotPage,
    hitProbe,
    initialProbe,
    locate: (caseId, role) => describe(locateInCase(caseId, role)),
    locateGlobal: (role) => describe(locateGlobal(role)),
    locateDescendant,
  };
  window.__sampleRepairDev = api;
}
`;

async function createOwnTarget(http) {
  const url = new URL("/json/new", http);
  url.searchParams.set("url", "about:blank");
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`create target failed: HTTP ${response.status}`);
  }
  return await response.json();
}

async function closeOwnTarget(http, targetId) {
  const url = `${http}/json/close/${encodeURIComponent(targetId)}`;
  try {
    await fetch(url, { method: "PUT" });
  } catch {
    // Best effort only; the owned target may already be gone.
  }
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  return new Promise((resolveConnect, rejectConnect) => {
    socket.addEventListener("open", () => {
      let nextId = 1;
      const pending = new Map();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id === undefined) return;
        const waiter = pending.get(message.id);
        if (waiter === undefined) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error !== undefined) {
          const text = message.error && typeof message.error.message === "string"
            ? message.error.message
            : JSON.stringify(message.error);
          waiter.reject(new Error(`${waiter.method}: ${text}`));
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
      const evaluate = async (expression) => {
        const response = await call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (response.exceptionDetails !== undefined) {
          const details = response.exceptionDetails && response.exceptionDetails.text
            ? response.exceptionDetails.text
            : JSON.stringify(response.exceptionDetails);
          const ex = response.exceptionDetails?.exception?.description
            ?? response.exceptionDetails?.exception?.value
            ?? response.exceptionDetails?.exception?.text
            ?? "";
          throw new Error(`Runtime.evaluate failed: ${details} :: ${ex}`);
        }
        return response.result ? response.result.value : undefined;
      };
      resolveConnect({ call, evaluate, close: () => socket.close() });
    });
    socket.addEventListener("error", rejectConnect, { once: true });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${description}`);
}

async function clickPoint(call, point, label) {
  if (![point.x, point.y, point.width, point.height].every(Number.isFinite)
    || point.width <= 0 || point.height <= 0) {
    throw new Error(`invalid click geometry for ${label}: ${JSON.stringify(point)}`);
  }
  if (point.x < 0 || point.y < 0 || point.x >= point.viewportWidth || point.y >= point.viewportHeight) {
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
  await sleep(SETTLE_MS);
}

async function main() {
  const bundled = await build({
    stdin: {
      contents: entrySource,
      resolveDir: repo,
      sourcefile: "capture-sample-repair-dev-entry.ts",
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
  const fixtureUrl = pathToFileURL(fixture).href;

  const target = await createOwnTarget(cdmHttp);
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(`create target failed on ${cdmHttp}`);
  }
  let cdp;
  const states = [];
  const hitRecords = [];
  const invalidConstructions = [];
  try {
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable", {});
    await cdp.call("Runtime.enable", {});
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      mobile: VIEWPORT.mobile,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
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
    await sleep(150);

    await cdp.evaluate(`${bundleCode}\n;typeof window.__sampleRepairDev === "object"`);
    await waitFor(
      async () => await cdp.evaluate('typeof window.__sampleRepairDev === "object"'),
      "capture bundle",
    );

    const initial = await cdp.evaluate("window.__sampleRepairDev.initialProbe()");
    if (initial.activeElementIsBody !== true) {
      throw new Error(`fixture must start with body active: ${JSON.stringify(initial)}`);
    }

    for (const caseId of CASE_IDS) {
      const meta = await cdp.evaluate(`(() => {
        const slot = document.querySelector('[data-dev-case=${JSON.stringify(caseId)}]');
        const container = slot instanceof Element
          ? slot.querySelector('[data-dev-target="container"]')
          : null;
        return slot instanceof Element ? {
          construction: slot.getAttribute("data-dev-construction"),
          kind: slot.getAttribute("data-dev-kind"),
          tabindex: container instanceof Element ? container.getAttribute("tabindex") : null,
          ownControl: container instanceof Element ? container.getAttribute("data-dev-own-control") : null,
        } : null;
      })()`);
      if (meta === null) throw new Error(`missing slot ${caseId}`);
      const kind = meta.kind;
      const expected = EXPECTED[caseId];
      if (expected === undefined
        || meta.construction !== expected.construction
        || meta.kind !== expected.kind
        || meta.tabindex !== expected.tabindex
        || (expected.kind === "positive" && meta.ownControl !== "true")
        || (expected.kind === "ignore" && meta.ownControl !== null)) {
        throw new Error(`matrix mismatch for ${caseId}: ${JSON.stringify(meta)}`);
      }

      const containerProbe = await cdp.evaluate(
        `window.__sampleRepairDev.hitProbe(${JSON.stringify(caseId)}, "container")`,
      );
      hitRecords.push({ caseId, kind, probe: containerProbe });
      if (containerProbe.ok !== true) {
        invalidConstructions.push({ caseId, kind, reason: "container-hit", probe: containerProbe });
        continue;
      }

      const parkingProbe = await cdp.evaluate(
        'window.__sampleRepairDev.hitProbe(null, "parking")',
      );
      if (parkingProbe.ok !== true) {
        invalidConstructions.push({ caseId, kind, reason: "parking-hit", probe: parkingProbe });
        continue;
      }

      if (kind === "positive") {
        const stateSequence = [
          { state: "initial", action: null },
          { state: "focused", action: "target" },
          { state: "blurred", action: "parking" },
          { state: "refocused", action: "target" },
        ];
        await clickPoint(cdp.call, parkingProbe, `${caseId} initial parking`);
        const parked = await cdp.evaluate(
          '(() => { const e = document.activeElement; return e === document.querySelector("[data-dev-target=parking]"); })()',
        );
        if (parked !== true) throw new Error(`${caseId} could not park focus before initial`);
        for (const step of stateSequence) {
          if (step.action === "parking") {
            await clickPoint(cdp.call, parkingProbe, `${caseId} parking`);
          } else if (step.action === "target") {
            await clickPoint(cdp.call, containerProbe, `${caseId} container`);
          }
          const inspection = await cdp.evaluate(
            `window.__sampleRepairDev.locate(${JSON.stringify(caseId)}, "container")`,
          );
          if (inspection.isConnected !== true) {
            throw new Error(`${caseId} container disconnected for ${step.state}`);
          }
          if (step.action === "target" && inspection.isActive !== true) {
            throw new Error(`${caseId} container did not receive focus at ${step.state}`);
          }
          if (step.action === "parking") {
            const active = await cdp.evaluate(
              '(() => { const e = document.activeElement; return e ? { tag: e.tagName.toLowerCase(), role: e.getAttribute ? e.getAttribute("data-dev-target") : null, isParking: e === document.querySelector("[data-dev-target=parking]") } : null; })()',
            );
            if (!active || active.isParking !== true) {
              throw new Error(`${caseId} parking did not receive focus at ${step.state}`);
            }
          }
          const snapshot = await cdp.evaluate(
            `window.__sampleRepairDev.snapshotPage(${JSON.stringify(caseId)}, ${JSON.stringify(step.state)})`,
          );
          const row = snapshot.containerRow;
          const wires = snapshot.containerWires;
          if (snapshot.focusChecks.activeElementRef === null && snapshot.pageState.activeElement !== null) {
            throw new Error(`${caseId} active element unmappable at ${step.state}`);
          }
          if (step.action === "target" && snapshot.focusChecks.sameObject !== true) {
            throw new Error(`${caseId} active element ref differs from container ref at ${step.state}`);
          }
          if (row.activeElementFocus === null) {
            throw new Error(`${caseId} activeElementFocus unmeasured at ${step.state}`);
          }
          const expectActive = step.action === "target";
          if (row.activeElementFocus !== expectActive) {
            throw new Error(`${caseId} activeElementFocus mismatch at ${step.state}`);
          }
          const expectTabIndex = meta.tabindex === "0";
          if (row.tabIndexFocus !== expectTabIndex) {
            throw new Error(`${caseId} tabIndexFocus mismatch at ${step.state}`);
          }
          if (expectActive) {
            if (wires.own_focus_target !== 1 || wires.neutral_actual_focus !== 1) {
              throw new Error(`${caseId} focus wires not present at ${step.state}`);
            }
            if (meta.tabindex === "-1" && wires.neutral_focusable_control !== 0) {
              throw new Error(`${caseId} fc wire expected 0 at ${step.state}`);
            }
            if (meta.tabindex === "0" && wires.neutral_focusable_control !== 1) {
              throw new Error(`${caseId} fc wire expected 1 at ${step.state}`);
            }
          }
          snapshot.stimulus = {
            action: step.action,
            point: step.action === "parking" ? parkingProbe : containerProbe,
          };
          states.push(snapshot);
          console.log(`captured ${caseId} ${step.state}`);
        }
      } else if (kind === "ignore") {
        const descendant = await cdp.evaluate(
          `window.__sampleRepairDev.locateDescendant(${JSON.stringify(caseId)})`,
        );
        if (descendant === null) throw new Error(`${caseId} missing focus descendant`);
        const descendantProbe = await cdp.evaluate(
          `(() => {
            const element = document.querySelector('[data-dev-case=${JSON.stringify(caseId)}] [data-dev-focus-descendant="true"]');
            const r = element.getBoundingClientRect();
            const x = Math.round(r.x + r.width / 2) + 0.5;
            const y = Math.round(r.y + r.height / 2) + 0.5;
            const hit = document.elementFromPoint(x, y);
            return {
              ok: hit === element,
              label: "center",
              x,
              y,
              width: r.width,
              height: r.height,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
              hitTag: hit ? hit.tagName.toLowerCase() : null,
              hitRole: hit && hit.getAttribute ? hit.getAttribute("data-dev-target") : null,
            };
          })()`,
        );
        if (descendantProbe.ok !== true) {
          throw new Error(`invalid-construction for ${caseId} descendant: ${JSON.stringify(descendantProbe)}`);
        }
        await clickPoint(cdp.call, parkingProbe, `${caseId} initial parking`);
        const ignoreParked = await cdp.evaluate(
          '(() => { const e = document.activeElement; return e === document.querySelector("[data-dev-target=parking]"); })()',
        );
        if (ignoreParked !== true) throw new Error(`${caseId} could not park focus before initial`);
        for (const ignoreState of IGNORE_STATES) {
          if (ignoreState === "descendant-focused") {
            await clickPoint(cdp.call, descendantProbe, `${caseId} descendant`);
          }
          const active = await cdp.evaluate(
            `(() => { const e = document.activeElement; const caseEl = e && e.closest ? e.closest("[data-dev-case]") : null; return e ? { tag: e.tagName.toLowerCase(), role: e.getAttribute ? e.getAttribute("data-dev-target") : null, caseId: caseEl && caseEl.getAttribute ? caseEl.getAttribute("data-dev-case") : null } : null; })()`,
          );
          if (ignoreState === "descendant-focused" && (!active || active.role !== "descendant")) {
            throw new Error(`${caseId} descendant did not receive focus: ${JSON.stringify(active)}`);
          }
          const containerState = await cdp.evaluate(
            `window.__sampleRepairDev.locate(${JSON.stringify(caseId)}, "container")`,
          );
          if (containerState.isActive === true) {
            throw new Error(`${caseId} wrapper itself holds focus at ${ignoreState}`);
          }
          const snapshot = await cdp.evaluate(
            `window.__sampleRepairDev.snapshotPage(${JSON.stringify(caseId)}, ${JSON.stringify(ignoreState)})`,
          );
          if (snapshot.containerRow.activeElementFocus !== false) {
            throw new Error(`${caseId} wrapper activeElementFocus expected false at ${ignoreState}`);
          }
          if (snapshot.containerRow.tabIndexFocus !== false) {
            throw new Error(`${caseId} wrapper tabIndexFocus expected false at ${ignoreState}`);
          }
          if (snapshot.containerWires.own_focus_target !== 0) {
            throw new Error(`${caseId} wrapper own_focus_target expected 0 at ${ignoreState}`);
          }
          snapshot.stimulus = {
            action: ignoreState === "descendant-focused" ? "descendant" : "none",
            point: ignoreState === "descendant-focused" ? descendantProbe : null,
          };
          states.push(snapshot);
          console.log(`captured ${caseId} ${ignoreState}`);
        }
        await clickPoint(cdp.call, containerProbe, `${caseId} wrapper no-focus probe`);
        const wrapperProbe = await cdp.evaluate(
          `window.__sampleRepairDev.locate(${JSON.stringify(caseId)}, "container")`,
        );
        if (wrapperProbe.isActive === true) {
          throw new Error(`${caseId} wrapper took focus from a blank click`);
        }
        hitRecords[hitRecords.length - 1].wrapperBlankClick = {
          activeElement: await cdp.evaluate(
            `(() => { const e = document.activeElement; const caseEl = e && e.closest ? e.closest("[data-dev-case]") : null; return e ? { tag: e.tagName.toLowerCase(), role: e.getAttribute ? e.getAttribute("data-dev-target") : null, caseId: caseEl && caseEl.getAttribute ? caseEl.getAttribute("data-dev-case") : null } : null; })()`,
          ),
          wrapperIsActive: wrapperProbe.isActive,
        };
      } else {
        throw new Error(`unexpected kind ${kind} for ${caseId}`);
      }
    }

    const result = {
      schemaVersion: "browser-focus-sample-repair.capture-dev.v1",
      family: "sample-repair-dev",
      fixture: { path: fixture, url: fixtureUrl },
      cdp: cdmHttp,
      viewport: VIEWPORT,
      targetId: target.id,
      capturedAt: new Date().toISOString(),
      initial,
      hitRecords,
      objectCount: 9,
      stateCount: states.length,
      invalidConstructions,
      complete: states.length === 30 && invalidConstructions.length === 0,
      states,
    };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2));
    if (invalidConstructions.length > 0) {
      console.error(`invalid-construction records: ${JSON.stringify(invalidConstructions)}`);
      process.exitCode = 2;
    }
    if (states.length !== 30) {
      console.error(`expected 30 states, captured ${states.length}`);
      process.exitCode = 2;
    }
    console.log(JSON.stringify({
      out,
      states: states.length,
      objectCount: result.objectCount,
      hitValid: hitRecords.filter((record) => record.probe.ok === true).length,
      cases: states.map((item) => item.caseId),
    }));
  } finally {
    if (cdp !== undefined) cdp.close();
    await closeOwnTarget(cdmHttp, target.id);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
