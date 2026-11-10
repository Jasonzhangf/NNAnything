import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { build } from "esbuild";
import {
  createBA1RealSiteCdpRuntime,
} from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";

const actionCounterScript = `
  for (const name of ["mousedown", "mouseup", "click", "keydown", "keyup", "input", "beforeinput", "change"]) {
    document.addEventListener(name, () => {
      void fetch("/action-event?name=" + encodeURIComponent(name)).catch(() => undefined);
    }, true);
  }
`;
const positiveHtml = `
  <div id="scope">
    <form method="get" action="/target">
      <input id="search" type="search" name="q" aria-label="Search" value="old text">
      <button type="submit" aria-label="Submit">Go</button>
    </form>
  </div>
  <script>${actionCounterScript}</script>
`;
const targetHtml = '<div id="scope"><input id="result" type="search" aria-label="Search"></div>';
const staleHtml = `
  <div id="scope"><input id="search" type="search" aria-label="Search"></div>
  <script>${actionCounterScript}</script>
`;
const staleReplacementHtml = `
  <div id="scope"><input id="search" type="search" aria-label="Search"></div>
  <script>
    ${actionCounterScript}
    fetch("/deferred-replace").then(() => {
      const element = document.getElementById("search");
      if (element !== null) {
        element.replaceWith(Object.assign(document.createElement("input"), {
          id: "search-replaced",
          type: "search",
          "aria-label": "Search",
        }));
      }
      return fetch("/replace-done");
    }).catch(() => undefined);
  </script>
`;
const replacedHtml = `
  <div id="scope"><input id="other" type="search" aria-label="Search"></div>
  <script>${actionCounterScript}</script>
`;
const ambiguousHtml = `
  <div id="scope">
    <button class="trigger" aria-label="Submit">Go</button>
    <button class="trigger" aria-label="Submit">Go</button>
  </div>
`;
const singleTriggerHtml = `
  <div id="scope"><button class="trigger" aria-label="Submit">Go</button></div>
`;
const absentScopeHtml = `
  <div id="scope"><button id="open" class="trigger" aria-label="Open">Open</button></div>
  <script>
    document.getElementById("open").addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="dialog"><input type="search" aria-label="Search"></div>');
    });
  </script>
`;
const ambiguousScopeHtml = `
  <div id="scope"><input id="search" type="search" aria-label="Search"></div>
  <div id="dialog"></div>
  <div id="dialog"></div>
`;
const mismatchedScopeHtml = `
  <div id="scope"><input id="search" type="search" aria-label="Search"></div>
  <div id="dialog"></div>
`;
const sameDocumentHtml = `
  <div id="scope">
    <input id="search" type="search" aria-label="Search" value="query">
    <button id="transition" aria-label="Transition">Transition</button>
    <div id="result"></div>
  </div>
  <script>
    document.getElementById("transition").addEventListener("click", () => {
      history.pushState({}, "", "/same-document-next");
      document.getElementById("result").textContent = "same document";
    });
  </script>
`;
const inPlaceRerenderHtml = `
  <div id="scope">
    <input id="search" type="search" aria-label="Search" value="query">
    <button id="rerender" aria-label="Rerender">Rerender</button>
  </div>
  <script>
    document.getElementById("rerender").addEventListener("click", () => {
      const scope = document.getElementById("scope");
      const result = Object.assign(document.createElement("input"), {
        type: "search",
        "aria-label": "Search",
        value: "result"
      });
      scope.replaceChildren(result);
    });
  </script>
`;
const rootReplacementHtml = `
  <div id="scope">
    <input id="search" type="search" aria-label="Search" value="query">
    <button id="replace-root" aria-label="Replace root">Replace root</button>
  </div>
  <script>
    document.getElementById("replace-root").addEventListener("click", () => {
      const scope = document.getElementById("scope");
      const replacement = Object.assign(document.createElement("div"), { id: "scope" });
      replacement.append(Object.assign(document.createElement("input"), {
        id: "search-replaced",
        type: "search",
        "aria-label": "Search",
        value: "replacement"
      }));
      scope.replaceWith(replacement);
    });
  </script>
`;
const unrelatedMutationHtml = `
  <div id="scope"><input id="search" type="search" aria-label="Search"></div>
  <button id="outside" aria-label="Outside">Outside</button>
  <div id="outside-result"></div>
  <script>
    document.getElementById("outside").addEventListener("click", () => {
      document.getElementById("outside-result").textContent = "outside";
    });
  </script>
`;

function slowSubmitHtml(delayMs) {
  return `
    <div id="scope">
      <form id="slow-form" method="get" action="/slow-target">
        <input id="search" type="search" aria-label="Search" value="delayed query">
        <button type="submit" aria-label="Submit">Go</button>
      </form>
    </div>
    <input type="hidden" name="delay" value="${delayMs}" form="slow-form">
    <script>${actionCounterScript}</script>
  `;
}

function slowTargetHtml(delayMs) {
  return `
    <div id="scope"><input id="result" type="search" aria-label="Search"></div>
    <script src="/slow-resource?delay=${delayMs}"></script>
  `;
}

function assertNoActionFields(candidate) {
  for (const forbidden of [
    "element",
    "geometry",
    "focused",
    "value",
    "elementRef",
    "actionToken",
    "nodeType",
    "ownerDocument",
  ]) {
    assert.equal(Object.hasOwn(candidate, forbidden), false, `candidate.${forbidden} must be absent`);
  }
}

async function buildProjectionScript(options = {}) {
  const bundle = await build({
    entryPoints: [new URL("../lib/adapters/browser/b-a1-real-site-browser-projection.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BA1Projection",
    platform: "browser",
    target: "es2022",
  });
  return `${bundle.outputFiles[0].text}
globalThis.__nnanythingBA1RealSiteProjection = BA1Projection.handleBA1RealSiteBrowserProjectionRequest;
globalThis.__nnanythingBA1RealSiteAction = BA1Projection.handleBA1RealSiteBrowserActionRequest;
${options.invalidObserverResult === true ? `
const validActionHandler = globalThis.__nnanythingBA1RealSiteAction;
globalThis.__nnanythingBA1RealSiteAction = request => {
  if (request && request.op === "await-scope-observer") {
    return Promise.resolve({
      schema: "nnanything.b-a1.real-site-browser-action-response.v1",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "scope_observer_result",
        appeared: "invalid",
        scopeCount: 1,
        eligibleInputCount: 1,
        url: location.href
      }
    });
  }
  return validActionHandler(request);
};` : ""}`;
}

async function startFixtureServer() {
  let origin = "";
  const actionEvents = [];
  let replaceDone = false;
  let slowTargetRequestCount = 0;
  const deferredReplace = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin === "" ? "http://127.0.0.1" : origin);
    if (url.pathname === "/action-event") {
      actionEvents.push(url.searchParams.get("name") ?? "unknown");
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/deferred-replace") {
      deferredReplace.push(response);
      return;
    }
    if (url.pathname === "/replace-done") {
      replaceDone = true;
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/slow-resource") {
      const delayMs = Math.max(0, Math.min(5_000, Number(url.searchParams.get("delay") ?? 0)));
      setTimeout(() => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        response.end("");
      }, delayMs);
      return;
    }
    if (url.pathname === "/slow-submit") {
      const delayMs = Math.max(0, Math.min(5_000, Number(url.searchParams.get("delay") ?? 0)));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(slowSubmitHtml(delayMs));
      return;
    }
    if (url.pathname === "/slow-target") {
      const delayMs = Math.max(0, Math.min(5_000, Number(url.searchParams.get("delay") ?? 0)));
      slowTargetRequestCount += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(slowTargetHtml(delayMs));
      return;
    }
    const pages = new Map([
      ["/blank", "<div id=\"scope\"></div>"],
      ["/positive", positiveHtml],
      ["/target", targetHtml],
      ["/same-document", sameDocumentHtml],
      ["/in-place", inPlaceRerenderHtml],
      ["/root-replacement", rootReplacementHtml],
      ["/unrelated", unrelatedMutationHtml],
    ]);
    const body = pages.get(url.pathname);
    if (body !== undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    events: () => actionEvents.slice(),
    clearEvents: () => { actionEvents.length = 0; },
    releaseReplace: () => {
      for (const response of deferredReplace.splice(0)) {
        response.writeHead(204);
        response.end();
      }
    },
    replaceDone: () => replaceDone,
    slowTargetRequestCount: () => slowTargetRequestCount,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTransportLossAfterFirstInput(callback) {
  const NativeWebSocket = globalThis.WebSocket;
  let inputEventCount = 0;
  let closeAfterInput = false;
  class LossyWebSocket extends NativeWebSocket {
    send(data) {
      const message = typeof data === "string" ? JSON.parse(data) : {};
      if (!closeAfterInput && typeof message.method === "string" && message.method.startsWith("Input.")) {
        closeAfterInput = true;
        inputEventCount += 1;
        super.send(data);
        this.close();
        return;
      }
      return super.send(data);
    }
  }
  globalThis.WebSocket = LossyWebSocket;
  try {
    await callback();
    return inputEventCount;
  } finally {
    globalThis.WebSocket = NativeWebSocket;
  }
}

async function withTransportLossAfterBoundary(callback) {
  const NativeWebSocket = globalThis.WebSocket;
  let enabled = false;
  let boundarySeen = false;
  class BoundaryLossWebSocket extends NativeWebSocket {
    addEventListener(type, listener, options) {
      if (type !== "message" || typeof listener !== "function") {
        return super.addEventListener(type, listener, options);
      }
      return super.addEventListener(type, event => {
        let closeAfterMessage = false;
        if (enabled && !boundarySeen) {
          try {
            const message = JSON.parse(String(event.data));
            if (message.method === "Page.frameNavigated"
              || message.method === "Runtime.executionContextsCleared") {
              boundarySeen = true;
              closeAfterMessage = true;
            }
          } catch {
            // Non-JSON frames are not CDP events.
          }
        }
        listener.call(this, event);
        if (closeAfterMessage) {
          setTimeout(() => {
            try {
              this.close();
            } catch {
              // The transport may already be closing.
            }
          }, 0);
        }
      }, options);
    }
  }
  globalThis.WebSocket = BoundaryLossWebSocket;
  try {
    await callback({ enable: () => { enabled = true; } });
    return boundarySeen;
  } finally {
    globalThis.WebSocket = NativeWebSocket;
  }
}

function controlOf(operation) {
  return { identity: operation.identity, generation: operation.generation };
}

function projectedTarget(operation, projection, scopeSelector = "#scope") {
  return {
    kind: "projected-candidate",
    control: controlOf(operation),
    scopeSelector,
    candidateRef: projection.candidates[0].ref,
  };
}

function recipeTarget(operation, selector, accessibleName) {
  return {
    kind: "unique-recipe-selector",
    control: controlOf(operation),
    selector,
    expectedTag: "button",
    expectedRole: "button",
    expectedAccessibleName: accessibleName,
  };
}

test("B-A1 typed native action on the local Chrome public consumer", async t => {
  const fixture = await startFixtureServer();
  const projectionScript = await buildProjectionScript();
  const runtime = await createBA1RealSiteCdpRuntime();
  t.after(async () => {
    await runtime.close();
    await fixture.close();
  });
  await runtime.installProjectionBundle(projectionScript);

  await t.test("positive replace-text and submit navigation keep action evidence", async () => {
    await runtime.navigate(`${fixture.origin}/positive`, "doc-action-positive");
    const first = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(first.projection.candidates.length, 1);
    assertNoActionFields(first.projection.candidates[0]);

    const replaceReceipt = await runtime.executeNativeAction({
      target: {
        kind: "projected-candidate",
        control: controlOf(first.operation),
        scopeSelector: "#scope",
        candidateRef: first.projection.candidates[0].ref,
      },
      action: { action: "replace-text", text: "hello world" },
    });
    assert.equal(replaceReceipt.schema, "nnanything.b-a1.real-site-action-receipt.v1");
    assert.equal(replaceReceipt.dispatch, "complete");
    assert.equal(replaceReceipt.focus, "target");
    assert.equal(replaceReceipt.readback.status, "exact");
    assert.equal(replaceReceipt.readback.value, "hello world");
    assert.equal(replaceReceipt.effectKnowledge, "text_written");
    assert.equal(replaceReceipt.error, null);
    assert.ok(fixture.events().length > 0, "native events must reach the fixture instrumentation");

    const refreshed = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(refreshed.operation),
      scopeSelector: "#scope",
    });
    const submitReceipt = await runtime.executeNativeAction({
      target: {
        kind: "projected-candidate",
        control: controlOf(refreshed.operation),
        scopeSelector: "#scope",
        candidateRef: refreshed.projection.candidates[0].ref,
      },
      action: { action: "submit-enter", expectedText: "hello world" },
    });
    assert.equal(submitReceipt.dispatch, "complete");
    assert.equal(submitReceipt.effectKnowledge, "submitted");
    assert.equal(submitReceipt.focus, "target");

    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: submitReceipt.actionId,
      transitionSignalDeadlineMs: 15_000,
      readinessDeadlineMs: 10_000,
    });
    assert.equal(transition.schema, "nnanything.b-a1.real-site-transition-receipt.v1");
    assert.equal(transition.observation, "document_transition");
    assert.notEqual(transition.next?.documentRef, refreshed.operation.identity.documentRef);
    assert.equal(transition.actionReceiptRef, submitReceipt.actionId);

    const afterNavigation = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(afterNavigation.projection.candidates.length, 1);
    assert.equal(afterNavigation.projection.identity.documentRef, transition.next?.documentRef);
  });

  await t.test("same-document replacement stays stale before dispatch with zero writes", async () => {
    await runtime.navigate(`${fixture.origin}/blank`, "doc-action-stale-same");
    await runtime.setDocumentContent(staleReplacementHtml, "doc-action-stale-same");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    fixture.releaseReplace();
    await waitUntil(() => fixture.replaceDone(), "fixture replacement did not complete");
    fixture.clearEvents();
    const receipt = await runtime.executeNativeAction({
      target: {
        kind: "projected-candidate",
        control: controlOf(projection.operation),
        scopeSelector: "#scope",
        candidateRef: projection.projection.candidates[0].ref,
      },
      action: { action: "click" },
    });
    assert.equal(receipt.dispatch, "not_sent");
    assert.equal(receipt.error?.code, "STALE_BEFORE_DISPATCH");
    assert.deepEqual(fixture.events(), []);
  });

  await t.test("cross-document replacement stays stale before dispatch with zero writes", async () => {
    await runtime.navigate(`${fixture.origin}/blank`, "doc-action-stale-cross-1");
    await runtime.setDocumentContent(staleHtml, "doc-action-stale-cross-1");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await runtime.setDocumentContent(replacedHtml, "doc-action-stale-cross-2");
    fixture.clearEvents();
    const receipt = await runtime.executeNativeAction({
      target: {
        kind: "projected-candidate",
        control: controlOf(projection.operation),
        scopeSelector: "#scope",
        candidateRef: projection.projection.candidates[0].ref,
      },
      action: { action: "click" },
    });
    assert.equal(receipt.dispatch, "not_sent");
    assert.equal(receipt.error?.code, "STALE_BEFORE_DISPATCH");
    assert.deepEqual(fixture.events(), []);
  });

  await t.test("unique recipe selector is ambiguous-safe and can click one exact trigger", async () => {
    await runtime.setDocumentContent(ambiguousHtml, "doc-action-ambiguous");
    const ambiguousProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const ambiguousReceipt = await runtime.executeNativeAction({
      target: {
        kind: "unique-recipe-selector",
        control: controlOf(ambiguousProjection.operation),
        selector: ".trigger",
        expectedTag: "button",
        expectedRole: "button",
        expectedAccessibleName: "Submit",
      },
      action: { action: "click" },
    });
    assert.equal(ambiguousReceipt.dispatch, "not_sent");
    assert.equal(ambiguousReceipt.error?.code, "AMBIGUOUS_TARGET");

    await runtime.setDocumentContent(singleTriggerHtml, "doc-action-recipe");
    const recipeProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const clickReceipt = await runtime.executeNativeAction({
      target: {
        kind: "unique-recipe-selector",
        control: controlOf(recipeProjection.operation),
        selector: ".trigger",
        expectedTag: "button",
        expectedRole: "button",
        expectedAccessibleName: "Submit",
      },
      action: { action: "click" },
    });
    assert.equal(clickReceipt.dispatch, "complete");
    assert.equal(clickReceipt.error, null);
  });

  await t.test("absent scope appearance and ambiguous scope are reported without retry", async () => {
    await runtime.setDocumentContent(absentScopeHtml, "doc-action-scope");
    const scopeProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(scopeProjection.operation),
      scopeSelector: "#dialog",
    });
    const openReceipt = await runtime.executeNativeAction({
      target: {
        kind: "unique-recipe-selector",
        control: controlOf(scopeProjection.operation),
        selector: "#open",
        expectedTag: "button",
        expectedRole: "button",
        expectedAccessibleName: "Open",
      },
      action: { action: "click" },
    });
    assert.equal(openReceipt.dispatch, "complete");
    const appeared = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: openReceipt.actionId,
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(appeared.observation, "scope_appeared");
    assert.equal(appeared.next?.documentRef, "doc-action-scope");
    assert.equal(appeared.detail.scopeCount, 1);
    assert.equal(appeared.detail.eligibleInputCount, 1);

    await runtime.setDocumentContent(ambiguousScopeHtml, "doc-action-scope-ambiguous");
    const ambiguousScopeProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const ambiguous = await runtime.armPostDispatchObservation({
      control: controlOf(ambiguousScopeProjection.operation),
      scopeSelector: "#dialog",
    });
    const ambiguousTransition = await runtime.awaitPostDispatchObservation({
      settleId: ambiguous.settleId,
      actionReceiptRef: "receipt-scope-ambiguous",
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(ambiguousTransition.observation, "ambiguous_scope");
    assert.equal(ambiguousTransition.next, null);

    await runtime.setDocumentContent(mismatchedScopeHtml, "doc-action-scope-mismatch");
    const mismatchedScopeProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const mismatched = await runtime.armPostDispatchObservation({
      control: controlOf(mismatchedScopeProjection.operation),
      scopeSelector: "#dialog",
    });
    const mismatchedTransition = await runtime.awaitPostDispatchObservation({
      settleId: mismatched.settleId,
      actionReceiptRef: "receipt-scope-mismatch",
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(mismatchedTransition.observation, "ambiguous_scope");
    assert.equal(mismatchedTransition.next, null);
  });

  await t.test("same-document URL change is reported as transition evidence only", async () => {
    await runtime.navigate(`${fixture.origin}/same-document`, "doc-action-same");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    const click = await runtime.executeNativeAction({
      target: recipeTarget(projection.operation, "#transition", "Transition"),
      action: { action: "click" },
    });
    assert.equal(click.dispatch, "complete");
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: click.actionId,
      transitionSignalDeadlineMs: 2_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(transition.observation, "same_document");
    assert.equal(transition.next, null);
    assert.equal(transition.detail.requiresFreshProjection, true);
    assert.ok(transition.detail.beforeUrl.endsWith("/same-document"));
    assert.ok(transition.detail.afterUrl.endsWith("/same-document-next"));
  });

  await t.test("same-URL scoped rerender requires a fresh projection", async () => {
    await runtime.navigate(`${fixture.origin}/in-place`, "doc-action-rerender");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    const click = await runtime.executeNativeAction({
      target: recipeTarget(projection.operation, "#rerender", "Rerender"),
      action: { action: "click" },
    });
    assert.equal(click.dispatch, "complete");
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: click.actionId,
      transitionSignalDeadlineMs: 2_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(transition.observation, "rerender_no_url_change");
    assert.equal(transition.next, null);
    assert.equal(transition.detail.requiresFreshProjection, true);
    assert.ok(transition.detail.beforeUrl.endsWith("/in-place"));
    assert.ok(transition.detail.afterUrl.endsWith("/in-place"));
  });

  await t.test("same-URL scope root replacement settles before await and rebinds the fresh input", async () => {
    await runtime.navigate(`${fixture.origin}/root-replacement`, "doc-action-root-replace");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    const click = await runtime.executeNativeAction({
      target: recipeTarget(projection.operation, "#replace-root", "Replace root"),
      action: { action: "click" },
    });
    assert.equal(click.dispatch, "complete");
    // The observer settles during this gap between arm and await; it must not be lost.
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: click.actionId,
      transitionSignalDeadlineMs: 2_000,
      readinessDeadlineMs: 1_000,
    });
    assert.equal(transition.observation, "rerender_no_url_change");
    assert.equal(transition.next, null);
    assert.equal(transition.detail.requiresFreshProjection, true);
    assert.ok(transition.detail.beforeUrl.endsWith("/root-replacement"));
    assert.ok(transition.detail.afterUrl.endsWith("/root-replacement"));

    const reprojection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(reprojection.projection.candidates.length, 1);
    const rebound = await runtime.executeNativeAction({
      target: projectedTarget(reprojection.operation, reprojection.projection),
      action: { action: "replace-text", text: "replacement query" },
    });
    assert.equal(rebound.dispatch, "complete");
    assert.equal(rebound.readback.status, "exact");
    assert.equal(rebound.readback.value, "replacement query");
  });

  await t.test("out-of-scope mutation does not resolve a rerender", async () => {
    await runtime.navigate(`${fixture.origin}/unrelated`, "doc-action-unrelated");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    const click = await runtime.executeNativeAction({
      target: recipeTarget(projection.operation, "#outside", "Outside"),
      action: { action: "click" },
    });
    assert.equal(click.dispatch, "complete");
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: click.actionId,
      transitionSignalDeadlineMs: 200,
      readinessDeadlineMs: 100,
    });
    assert.equal(transition.observation, "timeout");
    assert.equal(transition.next, null);
  });

  await t.test("delayed cross-document readiness can still produce the next control", async () => {
    await runtime.navigate(`${fixture.origin}/slow-submit?delay=300`, "doc-action-slow-ready");
    const initial = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const replace = await runtime.executeNativeAction({
      target: projectedTarget(initial.operation, initial.projection),
      action: { action: "replace-text", text: "delayed query" },
    });
    assert.equal(replace.dispatch, "complete");
    const refreshed = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(refreshed.operation),
      scopeSelector: "#scope",
    });
    const submit = await runtime.executeNativeAction({
      target: projectedTarget(refreshed.operation, refreshed.projection),
      action: { action: "submit-enter", expectedText: "delayed query" },
    });
    assert.equal(submit.dispatch, "complete");
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: submit.actionId,
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 3_000,
    });
    assert.equal(transition.observation, "document_transition");
    assert.equal(transition.detail.readiness, "ready");
    assert.notEqual(transition.next, null);
  });

  await t.test("cross-document readiness timeout preserves the boundary event", async () => {
    await runtime.navigate(`${fixture.origin}/slow-submit?delay=1500`, "doc-action-slow-timeout");
    const initial = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const replace = await runtime.executeNativeAction({
      target: projectedTarget(initial.operation, initial.projection),
      action: { action: "replace-text", text: "delayed query" },
    });
    assert.equal(replace.dispatch, "complete");
    const refreshed = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(refreshed.operation),
      scopeSelector: "#scope",
    });
    const submit = await runtime.executeNativeAction({
      target: projectedTarget(refreshed.operation, refreshed.projection),
      action: { action: "submit-enter", expectedText: "delayed query" },
    });
    assert.equal(submit.dispatch, "complete");
    const transition = await runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: submit.actionId,
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 250,
    });
    assert.equal(transition.observation, "document_transition");
    assert.equal(transition.detail.readiness, "timeout");
    assert.equal(transition.detail.code, "NAVIGATION_READINESS_TIMEOUT");
    assert.equal(transition.next, null);
  });

  await t.test("abandon during delayed readiness rejects instead of returning a receipt", async () => {
    await runtime.navigate(`${fixture.origin}/slow-submit?delay=1500`, "doc-action-abandon-readiness");
    const initial = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const replace = await runtime.executeNativeAction({
      target: projectedTarget(initial.operation, initial.projection),
      action: { action: "replace-text", text: "delayed query" },
    });
    assert.equal(replace.dispatch, "complete");
    const refreshed = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(refreshed.operation),
      scopeSelector: "#scope",
    });
    const slowTargetCount = fixture.slowTargetRequestCount();
    const submit = await runtime.executeNativeAction({
      target: projectedTarget(refreshed.operation, refreshed.projection),
      action: { action: "submit-enter", expectedText: "delayed query" },
    });
    assert.equal(submit.dispatch, "complete");
    const pending = runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: submit.actionId,
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 5_000,
    });
    const observed = pending.then(
      () => ({ status: "resolved" }),
      error => ({ status: "rejected", error }),
    );
    await waitUntil(
      () => fixture.slowTargetRequestCount() > slowTargetCount,
      "the delayed readiness document did not start loading",
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    await runtime.abandonPostDispatchObservation({ settleId: settle.settleId });
    const outcome = await withTimeout(
      observed,
      1_000,
      "abandonment during readiness did not reject the pending wait",
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error?.name, "BA1RealSiteCdpRuntimeError");
    assert.equal(outcome.error?.code, "invalid_request");
    assert.match(outcome.error?.message ?? "", /post-dispatch settle abandoned/);
  });

  await t.test("transport loss after the boundary is not rewritten as a readiness timeout", async () => {
    const boundarySeen = await withTransportLossAfterBoundary(async controller => {
      const lossyRuntime = await createBA1RealSiteCdpRuntime();
      let closeIssued = false;
      try {
        await lossyRuntime.installProjectionBundle(projectionScript);
        await lossyRuntime.navigate(`${fixture.origin}/slow-submit?delay=1500`, "doc-action-boundary-loss");
        const initial = await lossyRuntime.beginProjection({
          scopeSelector: "#scope",
          requestedRole: "search-input-host",
          access: "available",
        });
        const replace = await lossyRuntime.executeNativeAction({
          target: projectedTarget(initial.operation, initial.projection),
          action: { action: "replace-text", text: "delayed query" },
        });
        assert.equal(replace.dispatch, "complete");
        const refreshed = await lossyRuntime.beginProjection({
          scopeSelector: "#scope",
          requestedRole: "search-input-host",
          access: "available",
        });
        const settle = await lossyRuntime.armPostDispatchObservation({
          control: controlOf(refreshed.operation),
          scopeSelector: "#scope",
        });
        const slowTargetCount = fixture.slowTargetRequestCount();
        controller.enable();
        const submit = await lossyRuntime.executeNativeAction({
          target: projectedTarget(refreshed.operation, refreshed.projection),
          action: { action: "submit-enter", expectedText: "delayed query" },
        });
        assert.equal(submit.dispatch, "complete");
        const pending = lossyRuntime.awaitPostDispatchObservation({
          settleId: settle.settleId,
          actionReceiptRef: submit.actionId,
          transitionSignalDeadlineMs: 5_000,
          readinessDeadlineMs: 3_000,
        });
        const observed = pending.then(
          () => ({ status: "resolved" }),
          error => ({ status: "rejected", error }),
        );
        await waitUntil(
          () => fixture.slowTargetRequestCount() > slowTargetCount,
          "the delayed readiness document did not start loading",
        );
        const outcome = await withTimeout(
          observed,
          3_000,
          "transport loss during readiness did not reject the pending wait",
        );
        assert.equal(outcome.status, "rejected");
        assert.equal(outcome.error?.name, "BA1RealSiteCdpRuntimeError");
        assert.equal(outcome.error?.code, "cdp_failure");
        assert.doesNotMatch(outcome.error?.message ?? "", /NAVIGATION_READINESS_TIMEOUT/);
      } finally {
        if (!closeIssued) await lossyRuntime.close();
        closeIssued = true;
      }
    });
    assert.equal(boundarySeen, true);
  });

  await t.test("close during delayed readiness rejects with the CDP error", async () => {
    const readinessRuntime = await createBA1RealSiteCdpRuntime();
    let closeIssued = false;
    try {
      await readinessRuntime.installProjectionBundle(projectionScript);
      await readinessRuntime.navigate(`${fixture.origin}/slow-submit?delay=1500`, "doc-action-close-readiness");
      const initial = await readinessRuntime.beginProjection({
        scopeSelector: "#scope",
        requestedRole: "search-input-host",
        access: "available",
      });
      const replace = await readinessRuntime.executeNativeAction({
        target: projectedTarget(initial.operation, initial.projection),
        action: { action: "replace-text", text: "delayed query" },
      });
      assert.equal(replace.dispatch, "complete");
      const refreshed = await readinessRuntime.beginProjection({
        scopeSelector: "#scope",
        requestedRole: "search-input-host",
        access: "available",
      });
      const settle = await readinessRuntime.armPostDispatchObservation({
        control: controlOf(refreshed.operation),
        scopeSelector: "#scope",
      });
      const slowTargetCount = fixture.slowTargetRequestCount();
      const submit = await readinessRuntime.executeNativeAction({
        target: projectedTarget(refreshed.operation, refreshed.projection),
        action: { action: "submit-enter", expectedText: "delayed query" },
      });
      assert.equal(submit.dispatch, "complete");
      const pending = readinessRuntime.awaitPostDispatchObservation({
        settleId: settle.settleId,
        actionReceiptRef: submit.actionId,
        transitionSignalDeadlineMs: 5_000,
        readinessDeadlineMs: 5_000,
      });
      const observed = pending.then(
        () => ({ status: "resolved" }),
        error => ({ status: "rejected", error }),
      );
      await waitUntil(
        () => fixture.slowTargetRequestCount() > slowTargetCount,
        "the delayed readiness document did not start loading",
      );
      await readinessRuntime.close();
      closeIssued = true;
      const outcome = await withTimeout(
        observed,
        1_000,
        "close during readiness did not reject the pending wait",
      );
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.error?.name, "BA1RealSiteCdpRuntimeError");
      assert.equal(outcome.error?.code, "cdp_failure");
      assert.doesNotMatch(outcome.error?.message ?? "", /NAVIGATION_READINESS_TIMEOUT/);
    } finally {
      if (!closeIssued) await readinessRuntime.close();
    }
  });

  await t.test("observer failure rejects with its original typed error", async () => {
    const invalidObserverRuntime = await createBA1RealSiteCdpRuntime();
    try {
      await invalidObserverRuntime.installProjectionBundle(
        await buildProjectionScript({ invalidObserverResult: true }),
      );
      await invalidObserverRuntime.navigate(`${fixture.origin}/positive`, "doc-action-observer-error");
      const projection = await invalidObserverRuntime.beginProjection({
        scopeSelector: "#scope",
        requestedRole: "search-input-host",
        access: "available",
      });
      const settle = await invalidObserverRuntime.armPostDispatchObservation({
        control: controlOf(projection.operation),
        scopeSelector: "#scope",
      });
      const pending = invalidObserverRuntime.awaitPostDispatchObservation({
        settleId: settle.settleId,
        actionReceiptRef: "receipt-observer-error",
        transitionSignalDeadlineMs: 300,
        readinessDeadlineMs: 100,
      });
      const observed = pending.then(
        () => ({ status: "resolved" }),
        error => ({ status: "rejected", error }),
      );
      const outcome = await withTimeout(
        observed,
        1_000,
        "observer failure did not reject the pending wait",
      );
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.error?.name, "BA1RealSiteCdpRuntimeError");
      assert.equal(outcome.error?.code, "action_failed");
      assert.doesNotMatch(outcome.error?.message ?? "", /NAVIGATION_READINESS_TIMEOUT/);
    } finally {
      await invalidObserverRuntime.close();
    }
  });

  await t.test("transport loss after input handoff is unknown and is not retried", async () => {
    const inputEventCount = await withTransportLossAfterFirstInput(async () => {
      const lossyRuntime = await createBA1RealSiteCdpRuntime();
      try {
        await lossyRuntime.installProjectionBundle(projectionScript);
        await lossyRuntime.navigate(`${fixture.origin}/positive`, "doc-action-transport-loss");
        const projection = await lossyRuntime.beginProjection({
          scopeSelector: "#scope",
          requestedRole: "search-input-host",
          access: "available",
        });
        const receipt = await lossyRuntime.executeNativeAction({
          target: projectedTarget(projection.operation, projection.projection),
          action: { action: "click" },
        });
        assert.equal(receipt.dispatch, "unknown");
        assert.equal(receipt.error?.code, "UNKNOWN_DISPATCH");
        assert.ok(receipt.error?.message.length > 0, "the original transport error message must be retained");
      } finally {
        await lossyRuntime.close();
      }
    });
    assert.equal(inputEventCount, 1);
  });

  await t.test("abandonment retires the settle without clearing current targets", async () => {
    await runtime.navigate(`${fixture.origin}/in-place`, "doc-action-abandon");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    await runtime.abandonPostDispatchObservation({ settleId: settle.settleId });
    await assert.rejects(
      runtime.awaitPostDispatchObservation({
        settleId: settle.settleId,
        actionReceiptRef: "receipt-abandoned",
        transitionSignalDeadlineMs: 100,
        readinessDeadlineMs: 100,
      }),
      /unknown post-dispatch settle/,
    );
    const click = await runtime.executeNativeAction({
      target: projectedTarget(projection.operation, projection.projection),
      action: { action: "click" },
    });
    assert.equal(click.dispatch, "complete");
  });

  await t.test("close rejects a live settle waiter and clears bounded lifecycle state", async () => {
    await runtime.navigate(`${fixture.origin}/in-place`, "doc-action-close-settle");
    const projection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const settle = await runtime.armPostDispatchObservation({
      control: controlOf(projection.operation),
      scopeSelector: "#scope",
    });
    const pending = runtime.awaitPostDispatchObservation({
      settleId: settle.settleId,
      actionReceiptRef: "receipt-close",
      transitionSignalDeadlineMs: 5_000,
      readinessDeadlineMs: 5_000,
    });
    const observed = pending.then(
      () => ({ status: "resolved" }),
      error => ({ status: "rejected", error }),
    );
    await runtime.close();
    const closeOutcome = await withTimeout(
      observed,
      1_000,
      "close did not reject the active settle waiter",
    );
    assert.equal(closeOutcome.status, "rejected");
  });
});
