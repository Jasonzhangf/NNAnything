import assert from "node:assert/strict";
import { test } from "node:test";

import { createStableNodeRefRegistry, observeLiveDom, resolveStableNodeRef } from "nnanything/browser-classify";
import * as atomicPolicy from "../dist/filters/browser-single-action-policy.js";
import * as feedbackPolicy from "../dist/filters/browser-feedback.js";
import * as strategyPublic from "../dist/browser-strategy.js";

// F14 posterior currency: a valid-looking posterior that changes scope or
// object identity must be rejected, never silently rebound. The control triple
// comes from an explicit resource, not from a log.

const EPISODE_ID = "strategy-native-preference-00";

function episodeFixture() {
  const episode = strategyPublic.makeStrategySamples().find(item => item.id === EPISODE_ID);
  assert.ok(episode, `missing episode ${EPISODE_ID}`);
  return structuredClone(episode);
}

function controlOf(state) {
  return { documentRef: state.documentRef, observationId: state.observationId, revision: state.revision };
}

function cloneObservation(state, observationId, revision) {
  const next = structuredClone(state);
  next.observationId = observationId;
  next.revision = revision;
  return next;
}

function atomicProfile() {
  const zero = atomicPolicy.createZeroBrowserSingleActionProfile();
  const relationWeights = zero.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  const capabilityWeights = zero.capabilityWeights.map(row => [...row]);
  const click = zero.capabilityHeads.indexOf("CLICK");
  capabilityWeights[click][zero.capabilityWires.indexOf("bias")] = 2;
  capabilityWeights[click][zero.capabilityWires.indexOf("providers.zero")] = -4;
  capabilityWeights[click][zero.capabilityWires.indexOf("providers.one")] = 4;
  return atomicPolicy.validateBrowserSingleActionProfile({ ...zero, relationWeights, capabilityWeights });
}

function strategyProfile() {
  const zero = strategyPublic.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  const choose = zero.heads.indexOf("choose");
  const wire = name => zero.wires.indexOf(name);
  weights[choose][wire("nativeButton")] = 4;
  weights[choose][wire("explicitRoleButton")] = 1;
  return strategyPublic.validateBrowserStrategyProfile({ ...zero, weights });
}

function createResources(episode, observations) {
  const queue = [...observations];
  const clicks = [];
  let live = controlOf(episode.input.request.state);
  return {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackPolicy.createZeroFeedbackProfile(),
    registry: episode.registry,
    selection: episode.selection,
    selectedSkillId: episode.teacher.selectedSkillId,
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    async observe() {
      const next = queue.shift();
      if (next === undefined) throw new Error("observation queue exhausted");
      live = controlOf(next);
      return next;
    },
    currentControl: () => live,
    liveControl: () => live,
    async nativeClick(invocation) { clicks.push(invocation); return { dispatched: true, ok: true, effectKnowledge: "known", source: "f14-fixture", error: null }; },
    async collectAtomic() {},
    async collectStep() {},
    proveNoEffect() { return null; },
    clicks,
  };
}

test("a posterior that changes scope is rejected and takes zero input", async () => {
  const episode = episodeFixture();
  const preflight = structuredClone(episode.input.request.state);
  const pre = structuredClone(episode.input.request.state);
  const post = cloneObservation(pre, "f14-scope-post", pre.revision + 1);
  // Same document, same provisional revision bump, but a different scope object.
  const otherRef = post.elements.map(element => element.ref).find(ref => ref !== post.scopeRef && ref !== pre.scopeRef);
  assert.ok(otherRef, "fixture needs a second observed element");
  post.scopeRef = otherRef;
  const resources = createResources(episode, [preflight, pre, post]);

  const module = await import(new URL("../dist/nodes/browser-strategy.js", import.meta.url).href);
  const result = await module.runBrowserStrategyStep(episode.input, resources);

  // The scope change is only visible after the post-action observation. The
  // episode must reject the posterior rather than treat a different scope as a
  // fresh same-object fact. A structurally invalid scope fails the snapshot
  // contract first, which is also a rejection, never a silent rebind.
  assert.ok(["invalid_binding", "post_observation_failed"].includes(result.atomic?.error?.code ?? ""), `unexpected code ${result.atomic?.error?.code}`);
  assert.equal(result.atomic?.satisfaction, null);
  assert.equal(result.atomic?.achieved, false);
  assert.equal(result.atomic?.dispatchState, "dispatched");
});

test("a rebuilt DOM object gets a new ref and the old ref resolves to nothing", () => {
  const style = {
    display: "block", visibility: "visible", position: "static", transform: "none", translate: "none",
    rotate: "none", scale: "none", perspective: "none", overflowX: "visible", overflowY: "visible",
    clipPath: "none", clip: "auto", opacity: "1", zIndex: "auto", pointerEvents: "auto", cursor: "auto",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)", borderBottomColor: "rgba(0, 0, 0, 0)",
    borderLeftColor: "rgba(0, 0, 0, 0)", borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
    borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px", backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none", backgroundClip: "border-box", maskImage: "none", webkitMaskImage: "none",
    backdropFilter: "none", webkitBackdropFilter: "none", filter: "none", mixBlendMode: "normal",
    isolation: "auto", contain: "none", content: "none",
  };
  const make = overrides => ({
    nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: "target", classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    isConnected: true,
    ...overrides,
  });
  const registry = createStableNodeRefRegistry("f14-rebuild");
  const html = make({ tagName: "HTML", id: "", getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
  const first = make({});
  const second = make({});
  html.children = [first]; html.childNodes = [first]; html.childElementCount = 1; first.parentElement = html;
  const document = { documentElement: html, body: html, baseURI: "https://f14.test/p", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };

  const one = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f14-one", documentRef: "f14" });
  const firstRef = one.observation.nodes.find(node => node.tag === "div").nodeRef;

  // Rebuild: the document now holds a different Element with the same id and text.
  first.isConnected = false;
  second.parentElement = html;
  html.children = [second]; html.childNodes = [second];
  const two = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f14-two", documentRef: "f14" });
  const secondRef = two.observation.nodes.find(node => node.tag === "div").nodeRef;

  assert.notEqual(firstRef, secondRef);
  assert.equal(resolveStableNodeRef(registry, firstRef), null);
  assert.equal(resolveStableNodeRef(registry, secondRef), second);
});

test("iframe interiors are counted as unassessed instead of silently covered", () => {
  const style = { display: "block", visibility: "visible", position: "static", transform: "none", translate: "none", rotate: "none", scale: "none", perspective: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", opacity: "1", zIndex: "auto", pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)", borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)", borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundClip: "border-box", maskImage: "none", webkitMaskImage: "none", backdropFilter: "none", webkitBackdropFilter: "none", filter: "none", mixBlendMode: "normal", isolation: "auto", contain: "none", content: "none" };
  const make = (tagName, overrides = {}) => ({
    nodeType: 1, tagName, namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: "", classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    ...overrides,
  });
  const html = make("HTML", { getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
  const frame = make("IFRAME");
  html.children = [frame]; html.childNodes = [frame]; html.childElementCount = 1; frame.parentElement = html;
  const document = { documentElement: html, body: html, baseURI: "https://f14.test/p", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f14-frame");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f14-frame", documentRef: "f14" });
  assert.equal(snapshot.coverage.unassessedIframeCount, 1);
});