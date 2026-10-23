// Host-side capture for fixture-a.html.
//
// This script is intentionally not run inside the restricted worker sandbox.
// It opens one owned tab over CDP, uses real CDP mouse/keyboard events to move
// focus, runs the production observeLiveDom adapter, and writes one JSON file.
// It never calls element.focus(), element.click(), or writes observation
// fields. The fixture is only allowed to establish normal HTML initial state.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CDP_HTTP = "http://127.0.0.1:9333";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const CONSTRUCTIONS = ["button", "svg", "image", "link", "text_span", "nested_button"];
const STATES = ["S1", "S2", "S3"];

const CAPTURE_ENTRY_SOURCE = String.raw`
import { createStableNodeRefRegistry, observeLiveDom } from "../../lib/adapters/browser/live-dom.js";
import { extractBasicKindWires } from "../../lib/filters/basic-kinds.js";

const registry = createStableNodeRefRegistry("capture-a");
const SIGNATURE_WIRES = [
  "neutral_single_child",
  "neutral_single_element_wrapper",
  "neutral_single_positive_wrapper",
  "neutral_focusable_control",
  "neutral_actual_focus",
  "own_focus_target",
  "own_pointer_boundary",
];

function rectOf(element) {
  if (!(element instanceof Element)) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function describe(element) {
  if (!(element instanceof Element)) return null;
  const section = element.closest("[data-case]");
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    caseId: section ? section.getAttribute("data-case") : null,
    dataConstruction: element.getAttribute("data-construction"),
    dataState: element.getAttribute("data-state"),
    dataTarget: element.getAttribute("data-target"),
    hasOwnControl: element.hasAttribute("data-own-control"),
    tabindexAttribute: element.getAttribute("tabindex"),
    tabIndexProperty: element.tabIndex,
    isActive: document.activeElement === element,
    isConnected: element.isConnected,
    rect: rectOf(element),
  };
}

function findCase(construction, state) {
  const selector = '[data-construction="' + construction + '"][data-state="' + state + '"]';
  const wrapper = document.querySelector(selector);
  if (!(wrapper instanceof Element)) throw new Error("missing wrapper for " + construction + "-" + state);
  const section = wrapper.closest("[data-case]");
  const control = section ? section.querySelector("[data-own-control]") : null;
  const child = wrapper.querySelector(':scope > [data-target="child"]');
  const leaf = wrapper.querySelector('[data-target="leaf"]');
  return { caseId: construction + "-" + state, wrapper, section, control, child, leaf };
}

function inspectCase(construction, state) {
  const found = findCase(construction, state);
  return {
    caseId: found.caseId,
    wrapper: describe(found.wrapper),
    control: describe(found.control),
    child: describe(found.child),
    leaf: describe(found.leaf),
    activeElement: describe(document.activeElement),
  };
}

function rowFor(snapshot, ref) {
  if (ref === null) return null;
  const properties = snapshot.properties.get(ref);
  return properties === undefined ? null : { nodeRef: ref, ...properties };
}

function evidenceFor(snapshot, ref) {
  if (ref === null) return null;
  return snapshot.evidence.get(ref) ?? null;
}

function pickWires(snapshot, ref) {
  if (ref === null) return null;
  const properties = snapshot.properties.get(ref);
  if (properties === undefined) return null;
  const wires = extractBasicKindWires(properties);
  const result = {};
  for (const name of SIGNATURE_WIRES) result[name] = wires[name];
  return result;
}

window.__captureA = {
  inspect: function (construction, state) {
    return inspectCase(construction, state);
  },
  snapshot: function (construction, state) {
    const found = findCase(construction, state);
    const snapshot = observeLiveDom({
      document: document,
      window: window,
      registry: registry,
      excludeRoot: null,
      snapshotRef: "fixture-a/" + found.caseId,
      documentRef: "fixture-a",
    });
    const wrapperRef = registry.refByElement.get(found.wrapper) ?? null;
    const controlRef = found.control instanceof Element ? registry.refByElement.get(found.control) ?? null : null;
    const childRef = found.child instanceof Element ? registry.refByElement.get(found.child) ?? null : null;
    const leafRef = found.leaf instanceof Element ? registry.refByElement.get(found.leaf) ?? null : null;
    const sectionRef = found.section instanceof Element ? registry.refByElement.get(found.section) ?? null : null;
    const nodesByRef = new Map(snapshot.observation.nodes.map(function (node) {
      return [node.nodeRef, node];
    }));
    const nodeFor = function (ref) {
      return ref === null ? null : nodesByRef.get(ref) ?? null;
    };
    return {
      schemaVersion: "browser-foundation-focus-ignore-capture-a.snapshot.v1",
      caseId: found.caseId,
      construction: construction,
      state: state,
      snapshotRef: snapshot.snapshotRef,
      documentRef: snapshot.documentRef,
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
        activeElement: describe(document.activeElement),
        wrapper: describe(found.wrapper),
        control: describe(found.control),
        child: describe(found.child),
        leaf: describe(found.leaf),
      },
      objectRefs: {
        wrapper: wrapperRef,
        control: controlRef,
        child: childRef,
        leaf: leafRef,
        section: sectionRef,
        parent: found.wrapper.parentElement instanceof Element
          ? registry.refByElement.get(found.wrapper.parentElement) ?? null
          : null,
      },
      wrapperRow: rowFor(snapshot, wrapperRef),
      childRow: rowFor(snapshot, childRef),
      leafRow: rowFor(snapshot, leafRef),
      wrapperEvidence: evidenceFor(snapshot, wrapperRef),
      childEvidence: evidenceFor(snapshot, childRef),
      observationNodes: {
        wrapper: nodeFor(wrapperRef),
        control: nodeFor(controlRef),
        child: nodeFor(childRef),
        leaf: nodeFor(leafRef),
        section: nodeFor(sectionRef),
        parent: found.wrapper.parentElement instanceof Element
          ? nodeFor(registry.refByElement.get(found.wrapper.parentElement) ?? null)
          : null,
      },
      wireProbe: {
        wrapper: pickWires(snapshot, wrapperRef),
        child: pickWires(snapshot, childRef),
        leaf: pickWires(snapshot, leafRef),
      },
      properties: Array.from(snapshot.properties, function (entry) {
        return { nodeRef: entry[0], ...entry[1] };
      }),
      itemObservations: snapshot.itemObservations,
      coverage: snapshot.coverage,
      observationCoverage: snapshot.observation.coverage,
      observationViewport: snapshot.observation.viewport,
    };
  },
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

async function createOwnTarget() {
  const url = new URL("/json/new", CDP_HTTP);
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

async function closeOwnTarget(targetId) {
  const url = `${CDP_HTTP}/json/close/${encodeURIComponent(targetId)}`;
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(url, { method });
      if (response.ok || response.status === 404) return;
    } catch {
      // The target may already be gone. Closing is best effort only after the
      // owned tab has been used.
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

async function centerOf(evaluate, selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof Element)) return null;
    const r = element.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  })()`);
  if (point === null) throw new Error(`missing element for ${selector}`);
  return point;
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
  await delay(80);
}

async function pressTab(call) {
  await call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: 0,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: 0,
  });
  await delay(80);
}

async function pressShiftTab(call) {
  await call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: 8,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: 8,
  });
  await delay(80);
}

function assertControlFocus(inspect, construction, state) {
  const active = inspect && inspect.activeElement;
  if (!active || active.hasOwnControl !== true || active.caseId !== `${construction}-${state}`) {
    throw new Error(`expected own control focus for ${construction}-${state}, got ${JSON.stringify(active)}`);
  }
}

function assertWrapperFocus(inspect, construction, state) {
  const active = inspect && inspect.activeElement;
  if (!active
    || active.caseId !== `${construction}-${state}`
    || active.dataConstruction !== construction
    || active.dataState !== state) {
    throw new Error(`expected wrapper focus for ${construction}-${state}, got ${JSON.stringify(active)}`);
  }
}

function assertWrapperState(inspect, construction, state) {
  const wrapper = inspect && inspect.wrapper;
  if (!wrapper) throw new Error(`missing wrapper state for ${inspect && inspect.caseId}`);
  if (!inspect.control) throw new Error(`missing own control for ${inspect.caseId}`);
  if (!inspect.child) throw new Error(`missing child for ${inspect.caseId}`);
  if (construction === "nested_button" && !inspect.leaf) {
    throw new Error(`missing nested leaf for ${inspect.caseId}`);
  }
  if (state === "S3") {
    if (wrapper.tabindexAttribute !== null) {
      throw new Error(`S3 wrapper must not have tabindex: ${JSON.stringify(wrapper)}`);
    }
  } else if (wrapper.tabindexAttribute !== "0") {
    throw new Error(`${state} wrapper must have tabindex=0: ${JSON.stringify(wrapper)}`);
  }
}

async function main() {
  const fixture = requireAbsolute(arg("--fixture"), "--fixture");
  const out = requireAbsolute(arg("--out"), "--out");
  const fixtureUrl = pathToFileURL(fixture).href;

  const bundled = await build({
    stdin: {
      contents: CAPTURE_ENTRY_SOURCE,
      resolveDir: resolve(REPO, "playground/browser"),
      sourcefile: "capture-a-entry.ts",
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

  const target = await createOwnTarget();
  let cdp;
  const states = [];

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
        // Navigation can replace the execution context while the fixture loads.
        return false;
      }
    }, "fixture load");
    await delay(150);

    await cdp.evaluate(`${bundleCode}\n;typeof window.__captureA === "object"`);
    await waitFor(async () => await cdp.evaluate('typeof window.__captureA === "object"'), "capture bundle");

    for (const construction of CONSTRUCTIONS) {
      for (const state of STATES) {
        const caseId = `${construction}-${state}`;
        const caseSelector = `[data-case="${caseId}"]`;
        const controlSelector = `${caseSelector} [data-own-control]`;

        await cdp.evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(caseSelector)});
          if (element) element.scrollIntoView({ block: "center", inline: "center" });
        })()`);
        await delay(80);

        const preClick = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
        assertWrapperState(preClick, construction, state);

        const controlPoint = await centerOf(cdp.evaluate, controlSelector);
        await clickPoint(cdp.call, controlPoint, `${caseId} own control`);
        const afterClick = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
        assertControlFocus(afterClick, construction, state);

        const stimulus = {
          caseId,
          steps: [{
            type: "mouse",
            action: "click",
            target: "own-control",
            point: controlPoint,
          }],
          expectedFocus: "control",
        };

        if (state === "S1") {
          await pressTab(cdp.call);
          const afterTab = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
          assertWrapperFocus(afterTab, construction, state);
          stimulus.steps.push({
            type: "key",
            action: "Tab",
            target: "wrapper",
            key: "Tab",
            code: "Tab",
          });
          stimulus.expectedFocus = "wrapper";
        } else if (state === "S2") {
          await pressTab(cdp.call);
          const afterTab = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
          assertWrapperFocus(afterTab, construction, state);
          await pressShiftTab(cdp.call);
          const afterShiftTab = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
          assertControlFocus(afterShiftTab, construction, state);
          stimulus.steps.push({
            type: "key",
            action: "Tab",
            target: "wrapper",
            key: "Tab",
            code: "Tab",
          }, {
            type: "key",
            action: "Shift+Tab",
            target: "own-control",
            key: "Tab",
            code: "Tab",
            modifiers: ["Shift"],
          });
        }

        const preObservation = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
        const snapshot = await cdp.evaluate(`window.__captureA.snapshot(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);
        const postObservation = await cdp.evaluate(`window.__captureA.inspect(${JSON.stringify(construction)}, ${JSON.stringify(state)})`);

        snapshot.stimulus = stimulus;
        snapshot.preObservation = preObservation;
        snapshot.postObservation = postObservation;
        states.push(snapshot);
        console.log(`captured ${caseId}`);
      }
    }

    const result = {
      schemaVersion: "browser-foundation-focus-ignore-capture-a.v1",
      fixture: {
        path: fixture,
        url: fixtureUrl,
      },
      cdp: CDP_HTTP,
      targetId: target.id,
      capturedAt: new Date().toISOString(),
      viewport: {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
      },
      states,
    };

    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({
      out,
      states: states.length,
      cases: states.map(item => item.caseId),
    }));
  } finally {
    if (cdp !== undefined) cdp.close();
    await closeOwnTarget(target.id);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
