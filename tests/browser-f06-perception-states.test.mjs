import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCandidates, createFocusSpec, createStableNodeRefRegistry, observeCandidates, observeLiveDom, stableNodeRefFor } from "nnanything/browser-classify";

// F06 perception facts: one object must keep the same ref while it moves through
// visible, offscreen, partially exposed and fully occluded states. The states
// are chained in one registry, so this is an identity continuity claim and not
// four independent observations.

const viewport = { x: 0, y: 0, width: 800, height: 600 };
const targetRect = { x: 100, y: 100, width: 200, height: 40 };

const baseStyle = {
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

const opaqueCoverStyle = { ...baseStyle, backgroundColor: "rgb(255, 255, 255)", position: "relative", zIndex: "2" };

function makeElement(tagName, key, overrides = {}) {
  return {
    nodeType: 1, tagName, namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: key, classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...targetRect }),
    getClientRects: () => [{ ...targetRect }],
    refKey: key,
    ...overrides,
  };
}

function fixture() {
  const html = makeElement("HTML", "html", {
    getBoundingClientRect: () => ({ ...viewport }), getClientRects: () => [{ ...viewport }],
  });
  const target = makeElement("BUTTON", "target", { childNodes: [{ nodeType: 3, textContent: "目标" }] });
  const cover = makeElement("DIV", "cover");
  target.parentElement = html;
  cover.parentElement = html;
  html.children = [target, cover];
  html.childNodes = [target, cover];
  html.childElementCount = 2;
  return { html, target, cover };
}

const nativeEnvironment = { devicePixelRatio: 1, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } };

function observe(refs, registry, options = {}) {
  const styles = options.hideCover
    ? { target: baseStyle, cover: { ...baseStyle, display: "none" } }
    : { target: baseStyle, cover: opaqueCoverStyle };
  const snapshot = observeLiveDom({
    document: {
      documentElement: refs.html, body: refs.html, baseURI: "https://f06.test/page",
      ...(options.activeElement === undefined ? {} : { activeElement: options.activeElement }),
      elementsFromPoint: options.elementsFromPoint ?? ((x, y) => (x === 0 && y === 0 ? [refs.html] : [refs.target, refs.html])),
    },
    window: {
      innerWidth: viewport.width, innerHeight: viewport.height, ...nativeEnvironment,
      getComputedStyle: (element, pseudo) => (pseudo ? { content: "none" } : styles[element.refKey] ?? baseStyle),
    },
    registry,
    excludeRoot: null,
    snapshotRef: "f06-states",
    documentRef: "f06",
  });
  return { snapshot, ref: stableNodeRefFor(registry, refs.target) };
}

function nodeOf(snapshot, ref) {
  return snapshot.observation.nodes.find(node => node.nodeRef === ref);
}

test("one object keeps its ref while it moves through visible, offscreen, partial and fully occluded", () => {
  const refs = fixture();
  const registry = createStableNodeRefRegistry("f06-states");

  const visible = observe(refs, registry);
  const visibleNode = nodeOf(visible.snapshot, visible.ref);
  assert.equal(visibleNode.foreground, "visible");
  assert.ok(visibleNode.exposedRects.length > 0, "a fully visible target exposes at least one rect");

  // Move the same Element below the viewport.
  refs.target.getBoundingClientRect = () => ({ x: 100, y: 700, width: 200, height: 40 });
  refs.target.getClientRects = () => [{ x: 100, y: 700, width: 200, height: 40 }];
  const offscreen = observe(refs, registry, { elementsFromPoint: (x, y) => (x === 0 && y === 0 ? [refs.html] : []) });
  const offscreenNode = nodeOf(offscreen.snapshot, offscreen.ref);
  assert.equal(offscreen.ref, visible.ref, "identity survives leaving the viewport");
  assert.deepEqual(offscreenNode.exposedRects, [], "nothing is exposed outside the viewport");
  // The candidate filter still rejects it by geometry, so empty exposure cannot
  // turn an offscreen object into a candidate.
  const offscreenCandidates = checkCandidates(observeCandidates({ observation: offscreen.snapshot.observation }), createFocusSpec());
  const offscreenSlot = offscreenCandidates.slots.find(slot => slot.nodeRef === offscreen.ref);
  assert.notEqual(offscreenSlot?.status, "ok", `offscreen slot status was ${offscreenSlot?.status}`);

  // Partially exposed: the lower part sticks into the viewport.
  refs.target.getBoundingClientRect = () => ({ x: 100, y: 590, width: 200, height: 40 });
  refs.target.getClientRects = () => [{ x: 100, y: 590, width: 200, height: 40 }];
  const partial = observe(refs, registry);
  const partialNode = nodeOf(partial.snapshot, partial.ref);
  assert.equal(partial.ref, visible.ref, "identity survives partial exposure");
  assert.equal(partialNode.foreground, "visible");
  assert.ok(partialNode.exposedRects.length > 0);
  const exposedArea = partialNode.exposedRects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  assert.ok(exposedArea < targetRect.width * targetRect.height, `exposed area ${exposedArea} is not smaller than the full rect`);

  // Fully occluded by an opaque cover over the same rect.
  refs.target.getBoundingClientRect = () => ({ ...targetRect });
  refs.target.getClientRects = () => [{ ...targetRect }];
  const occluded = observe(refs, registry, {
    elementsFromPoint: (x, y) => (x === 0 && y === 0 ? [refs.html] : [refs.cover, refs.target, refs.html]),
  });
  const occludedNode = nodeOf(occluded.snapshot, occluded.ref);
  assert.equal(occluded.ref, visible.ref, "identity survives full occlusion");
  assert.equal(occludedNode.foreground, "occluded");
  assert.deepEqual(occludedNode.exposedRects, []);
});

test("a plain button keeps its focus fact in properties even without a currentView record", () => {
  const refs = fixture();
  const registry = createStableNodeRefRegistry("f06-focus");
  const observed = observe(refs, registry, { activeElement: refs.target, hideCover: true });
  const properties = observed.snapshot.properties.get(observed.ref);
  assert.equal(properties?.activeElementFocus, true);
  // Declared gap: currentView is only written for div, object and supported SVG,
  // so a button has no currentView record. The scoring path still sees the fact.
  assert.equal(observed.snapshot.observation.nodes.find(node => node.nodeRef === observed.ref)?.currentView, undefined);
});