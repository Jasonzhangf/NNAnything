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

async function buildProjectionScript() {
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
globalThis.__nnanythingBA1RealSiteAction = BA1Projection.handleBA1RealSiteBrowserActionRequest;`;
}

async function startFixtureServer() {
  let origin = "";
  const actionEvents = [];
  let replaceDone = false;
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
    const pages = new Map([
      ["/blank", "<div id=\"scope\"></div>"],
      ["/positive", positiveHtml],
      ["/target", targetHtml],
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

function controlOf(operation) {
  return { identity: operation.identity, generation: operation.generation };
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
    });
    assert.equal(mismatchedTransition.observation, "ambiguous_scope");
    assert.equal(mismatchedTransition.next, null);
  });
});
