import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyCandidateStage, checkCandidates, createFocusSpec, loadSavedObservation, observeCandidates, splitCandidates, validateCandidateRequest } from "../dist/browser.js";

const fixture = JSON.parse(readFileSync(new URL("../playground/browser/observation.fixture.json", import.meta.url), "utf8"));
function evaluate(observation, focus = {}, nodeRefs) {
  const spec = createFocusSpec(focus);
  return checkCandidates(splitCandidates(observeCandidates(validateCandidateRequest({ observation, ...(nodeRefs === undefined ? {} : { nodeRefs }) }))), spec);
}
function oneNode(changes = {}) {
  return { viewport: { x: 0, y: 0, width: 100, height: 100 }, nodes: [{ nodeRef: "n", parentRef: null, tag: "button", role: "button", rect: { x: 0, y: 0, width: 100, height: 10 }, fragments: [{ x: 0, y: 0, width: 100, height: 10 }], clippedRect: { x: 0, y: 0, width: 100, height: 10 }, ...changes }] };
}

test("fragments cannot bridge blank space or escape actual clipping", () => {
  const snapshot = oneNode({ fragments: [{ x: 0, y: 0, width: 10, height: 10 }, { x: 90, y: 0, width: 10, height: 10 }] });
  const region = { x: 40, y: 0, width: 10, height: 10 };
  assert.deepEqual(evaluate(snapshot, { region }).candidateRefs, []);
  assert.equal(evaluate(snapshot, { region }).slots[0].status, "filtered_out");
  assert.deepEqual(evaluate(oneNode({ clippedRect: { x: 110, y: 0, width: 10, height: 10 } })).candidateRefs, []);
});

test("region is idempotent through config validation and only narrows viewport", () => {
  const spec = createFocusSpec({ region: { x: 90, y: 0, width: 30, height: 10 } });
  assert.deepEqual(createFocusSpec(spec), spec);
  assert.deepEqual(evaluate(oneNode(), spec).candidateRefs, ["n"]);
  assert.deepEqual(evaluate(oneNode(), { region: { x: 100, y: 0, width: 10, height: 10 } }).candidateRefs, []);
});

test("conditions use AND within objects, OR across objects, and unknown for absent measurements", () => {
  assert.deepEqual(evaluate(oneNode(), { allow: [{ tag: "button", role: "link" }, { nodeRef: "n" }] }).candidateRefs, ["n"]);
  assert.deepEqual(evaluate(oneNode(), { allow: [{ tag: "button", role: "link" }] }).candidateRefs, []);
  const unknown = evaluate(oneNode(), { deny: [{ attributes: { disabled: true } }] });
  assert.equal(unknown.slots[0].status, "unknown");
  assert.deepEqual(evaluate(oneNode({ attributes: { disabled: false } }), { allow: [{ attributes: { disabled: false } }] }).candidateRefs, ["n"]);
});

test("page split traverses DOM preorder even when saved array is interleaved", () => {
  const n = oneNode().nodes[0];
  const snapshot = { viewport: fixture.viewport, nodes: [{ ...n, nodeRef: "a" }, { ...n, nodeRef: "b" }, { ...n, nodeRef: "child", parentRef: "a" }] };
  assert.deepEqual(evaluate(snapshot).slots.map(slot => slot.nodeRef), ["a", "child", "b"]);
  assert.deepEqual(evaluate(snapshot, {}, ["b", "a", "b"]).slots.map(slot => slot.nodeRef), ["b", "a", "b"]);
});

test("saved numeric indices resolve forward parents without inventing scroll offsets", () => {
  const n = oneNode().nodes[0];
  const snapshot = { viewport: fixture.viewport, documentScroll: { x: 0, y: 1000 }, nodes: [{ ...n, nodeRef: "child", index: 1, parentRef: undefined, parent: 2 }, { ...n, nodeRef: "parent", index: 2 }] };
  const loaded = loadSavedObservation(snapshot);
  assert.equal(loaded.nodes[0].parentRef, "parent");
  assert.equal(loaded.nodes[0].rect.y, 0);
  assert.deepEqual(evaluate(snapshot).candidateRefs, ["parent", "child"]);
});

test("within subtree retains excluded slots and limits only candidate targets", () => {
  const result = evaluate(fixture, { within: "offscreen-parent", scopeMode: "subtree" });
  assert.deepEqual(result.candidateRefs, ["visible-child"]);
  assert.equal(result.slots.length, fixture.nodes.length);
});

test("final evaluation retains prior filtered and unknown verdicts", () => {
  const batch = observeCandidates(validateCandidateRequest({ observation: fixture, nodeRefs: ["partial", "unknown-clipping"] }));
  const denied = applyCandidateStage(batch, createFocusSpec({ deny: [{ nodeRef: "partial" }] }), "deny");
  const result = checkCandidates(denied, createFocusSpec({ allow: [{ nodeRef: "partial" }] }));
  assert.deepEqual(result.slots.map(slot => slot.status), ["filtered_out", "unknown"]);
});

test("invalid refs and malformed parent graphs are rejected at the observation boundary", () => {
  assert.throws(() => validateCandidateRequest({ observation: fixture, nodeRefs: [12] }), /nodeRefs/);
  assert.throws(() => loadSavedObservation(oneNode({ parentRef: "n" })), /cycle/);
});

test("incomplete node coordinates stay unknown instead of assuming zero or crashing the batch", () => {
  const missingWidth = evaluate(oneNode({ rect: { x: 0, y: 0, height: 10 } }));
  assert.equal(missingWidth.slots[0].status, "unknown");
  const missingX = evaluate(oneNode({ rect: { y: 0, width: 10, height: 10 } }));
  assert.equal(missingX.slots[0].status, "unknown");
});

test("empty attribute conditions and nonfinite rule values are rejected", () => {
  assert.throws(() => createFocusSpec({ deny: [{ attributes: {} }] }), /empty/);
  assert.throws(() => createFocusSpec({ allow: [{ attributes: { tabindex: NaN } }] }), /finite/);
});
