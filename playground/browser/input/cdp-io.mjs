import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { renderFamilyA } from "./fixtures/family-a.mjs";
import { renderFamilyB } from "./fixtures/family-b.mjs";

const CDP_HTTP = process.env.B_INPUT_CDP || "http://127.0.0.1:9333";
const CASE_FILE = process.env.B_INPUT_CASE_FILE;

if (!CASE_FILE) throw new Error("B_INPUT_CASE_FILE is required");

const config = JSON.parse(await readFile(resolve(CASE_FILE), "utf8"));
const family = config.family === "A" ? "A" : "B";

const bundled = await build({
  entryPoints: [resolve(import.meta.dirname, "live-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  write: false,
  logLevel: "silent",
});
const entryCode = bundled.outputFiles[0].text;

let active = null;

async function createOwnTarget() {
  const url = new URL("/json/new", CDP_HTTP);
  url.searchParams.set("url", "about:blank");
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) throw new Error(`create target failed: HTTP ${response.status}`);
  return await response.json();
}

async function closeOwnTarget(targetId) {
  try {
    await fetch(`${CDP_HTTP}/json/close/${encodeURIComponent(targetId)}`, { method: "PUT" });
  } catch {
    // best effort; target may already be gone
  }
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const opened = new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`${waiter.method}: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      waiter.resolve(message.result ?? {});
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
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
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
  return family === "A" ? renderFamilyA(config) : renderFamilyB(config);
}

function targetConfig() {
  return {
    documentRef: config.documentRef,
    scopeRef: config.scopeRef,
    targetRef: config.targetRef,
    targetSelector: config.targetSelector,
    host: config.host,
    type: config.type,
    sensitive: config.sensitive,
    editableUnprobed: config.editableUnprobed,
    neighborRefs: config.neighborRefs,
  };
}

function controlOf(observation) {
  return {
    documentRef: observation.documentRef,
    scopeRef: observation.scopeRef,
    observationId: observation.observationId,
    revision: observation.revision,
  };
}

async function evaluateObservation(revision) {
  const expression = `window.__bInputObserve(${JSON.stringify(targetConfig())}, ${revision})`;
  return active.cdp.evaluate(expression);
}

export async function createResources(request) {
  const target = await createOwnTarget();
  let cdp = null;
  try {
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    const frameTree = await cdp.call("Page.getFrameTree", {});
    const frameId = frameTree.frameTree.frame.id;
    await cdp.call("Page.setDocumentContent", { frameId, html: pageHtml() });
    await delay(350);
    await cdp.evaluate(entryCode);
    if (await cdp.evaluate("typeof window.__bInputObserve !== 'function'")) {
      throw new Error("b-input live entry did not install");
    }

    const state = {
      cdp,
      targetId: target.id,
      config,
      revision: 0,
      firstObs: null,
      latestObs: null,
      dispatched: false,
      controlCalls: 0,
      replaced: false,
    };
    active = state;

    const resources = {
      grantedEffects: new Set(config.grantedEffects),
      observe: async () => {
        if (config.observeFailAfterDispatch && state.dispatched) {
          throw new Error("injected post-input read failure");
        }
        if (config.stalePost && state.dispatched) {
          return structuredClone(state.firstObs);
        }
        state.revision += 1;
        const observation = await evaluateObservation(state.revision);
        state.latestObs = observation;
        if (!state.firstObs) state.firstObs = observation;
        return observation;
      },
      currentControl: async () => {
        state.controlCalls += 1;
        if (config.behavior === "replaceOnCommand" && state.controlCalls >= 2 && !state.replaced) {
          state.replaced = true;
          await state.cdp.evaluate("window.__bInputReplaceTarget()");
          state.revision += 1;
          state.latestObs = await evaluateObservation(state.revision);
        }
        return controlOf(state.latestObs);
      },
      nativeInputText: async invocation => {
        const point = await state.cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(config.targetSelector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw new Error("target geometry unavailable");
        }
        const events = [
          { type: "mouseMoved", targetRef: invocation.targetRef, detail: null },
          { type: "mousePressed", targetRef: invocation.targetRef, detail: null },
          { type: "mouseReleased", targetRef: invocation.targetRef, detail: null },
        ];
        for (const event of [
          { type: "mouseMoved", button: "none", buttons: 0 },
          { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
          { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
        ]) {
          await state.cdp.call("Input.dispatchMouseEvent", { ...event, x: point.x, y: point.y });
        }
        await delay(80);
        const focused = await state.cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(config.targetSelector)});
          return !!(el && document.activeElement === el);
        })()`);
        if (!focused) {
          return {
            dispatched: true,
            ok: true,
            effectKnowledge: "none",
            source: "cdp.Input",
            error: null,
            events,
            textWriteCount: 0,
            focus: "other",
          };
        }
        await state.cdp.call("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: 4,
          commands: ["selectAll"],
        });
        await state.cdp.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: 4,
        });
        events.push(
          { type: "rawKeyDown", targetRef: invocation.targetRef, detail: "a" },
          { type: "keyUp", targetRef: invocation.targetRef, detail: "a" },
          { type: "insertText", targetRef: invocation.targetRef, detail: invocation.value },
        );
        await state.cdp.call("Input.insertText", { text: invocation.value });
        state.dispatched = true;
        if (config.throwAfterDispatch) {
          const error = new Error("transport error after native dispatch");
          error.dispatched = true;
          error.textWriteCount = 1;
          throw error;
        }
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: "unknown",
          source: "cdp.Input",
          error: null,
          events,
          textWriteCount: 1,
          focus: "target",
        };
      },
    };
    return resources;
  } catch (error) {
    if (cdp) cdp.close();
    await closeOwnTarget(target.id);
    throw error;
  }
}

export async function close() {
  if (!active) return { sideEffects: null, closeErrors: [] };
  const state = active;
  active = null;
  let sideEffects = null;
  const closeErrors = [];
  try {
    sideEffects = await state.cdp.evaluate(`(() => {
      const cfg = ${JSON.stringify(targetConfig())};
      const read = el => el && (el.type !== "password" && el.type !== "file") ? el.value : null;
      const target = document.querySelector(cfg.targetSelector);
      const neighbor = document.querySelector(cfg.neighborRefs[0].selector);
      return {
        targetPresent: !!target,
        targetValue: cfg.sensitive ? null : read(target),
        neighborPresent: !!neighbor,
        neighborValue: read(neighbor),
        activeElementIsTarget: !!(target && document.activeElement === target),
      };
    })()`);
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
