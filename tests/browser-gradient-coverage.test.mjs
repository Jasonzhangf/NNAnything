import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

// These fixtures use the accepted ZH geometry and CSS facts. They are synthetic
// public-observer fixtures, not native witness captures.
const VIEWPORT = { x: 0, y: 0, width: 1280, height: 720 };
const RAMP_PAINTER = { x: 752.5, y: 485.609375, width: 74, height: 49 };
const RAMP_TARGET = { x: 759.5625, y: 502.609375, width: 8.796875, height: 17 };
const SPLIT_PAINTER = { x: 752.5, y: 60.5, width: 74, height: 49 };
const SPLIT_TARGET = { x: 757.5625, y: 60.5, width: 48.796875, height: 1.5 };
const GRADIENT =
  "linear-gradient(to left, rgb(255, 255, 255) 0px, rgb(255, 255, 255) 56px, rgba(255, 255, 255, 0) 100%)";

const baseStyle = {
  display: "block",
  visibility: "visible",
  transform: "none",
  transformStyle: "flat",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  zoom: "1",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundOrigin: "padding-box",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundPositionX: "0%",
  backgroundPositionY: "0%",
  backgroundRepeat: "repeat",
  backgroundClip: "border-box",
  backgroundAttachment: "scroll",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  boxShadow: "none",
  textShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
  borderImageSource: "none",
  borderImageSlice: "100%",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  contentVisibility: "visible",
  willChange: "auto",
  pointerEvents: "auto",
  cursor: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)",
  borderRightColor: "rgba(0, 0, 0, 0)",
  borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  content: "none",
};

function fixtureElement(refKey, tagName, rect, parent = null, options = {}) {
  const attributes = options.attributes ?? {};
  const text = options.text ?? null;
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    tagName,
    refKey,
    parentElement: parent,
    children: [],
    childNodes: text === null ? [] : [{ nodeType: 3, textContent: text }],
    childElementCount: 0,
    id: "",
    classList: [],
    isConnected: true,
    getAttribute: key => attributes[key] ?? null,
    hasAttribute: key => Object.hasOwn(attributes, key),
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
  };
}

function observeGradientScene({
  targetRect,
  painterRect,
  targetStyle = {},
  painterStyle = {},
  pointerAuto,
  withNativeHit = false,
}) {
  const root = fixtureElement("root", "HTML", VIEWPORT);
  const target = fixtureElement("target", "SPAN", targetRect, root, { text: "8" });
  const painter = fixtureElement("painter", "DIV", painterRect, root, { text: "\u200b" });
  root.children = [target, painter];
  root.childNodes = [target, painter];
  root.childElementCount = 2;

  const styles = new Map([
    [root, baseStyle],
    [target, { ...baseStyle, position: "relative", pointerEvents: pointerAuto ? "auto" : "none", ...targetStyle }],
    [painter, {
      ...baseStyle,
      position: "absolute",
      pointerEvents: pointerAuto ? "auto" : "none",
      backgroundImage: GRADIENT,
      ...painterStyle,
    }],
  ]);
  const selection = { target: null, painter: null };
  const document = {
    documentElement: root,
    body: root,
    baseURI: "https://fixture.test/gradient",
    elementsFromPoint: (x, y) => {
      if (x === 0 && y === 0) return [root];
      if (!withNativeHit) return [];
      return x >= targetRect.x && x <= targetRect.x + targetRect.width
        && y >= targetRect.y && y <= targetRect.y + targetRect.height
        ? [painter, target, root]
        : [];
    },
  };
  const window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    devicePixelRatio: 1,
    visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
    getComputedStyle: (element, pseudo) => pseudo
      ? { content: painterStyle.pseudoContent ?? "none" }
      : styles.get(element) ?? baseStyle,
  };
  const registry = createStableNodeRefRegistry("gradient-public");
  selection.target = stableNodeRefFor(registry, target);
  selection.painter = stableNodeRefFor(registry, painter);
  const events = [];
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef: "gradient-public",
    documentRef: "fixture",
    diagnostic: {
      selectedRefs: new Set([selection.target]),
      callback: event => events.push(event),
    },
  });
  return {
    events,
    selection,
    node: snapshot.observation.nodes.find(node => node.nodeRef === selection.target),
  };
}

test("pointer-auto full positive gradient coverage occludes the target", () => {
  const result = observeGradientScene({
    targetRect: RAMP_TARGET,
    painterRect: RAMP_PAINTER,
    pointerAuto: true,
    withNativeHit: true,
  });
  assert.equal(result.node.foreground, "occluded", `foreground=${result.node.foreground}`);
  assert.deepEqual(result.node.exposedRects, []);

  const blocker = result.events.find(event => event.phase === "blocker"
    && event.targetRef === result.selection.target && event.blockerRef === result.selection.painter);
  assert.ok(blocker);
  assert.equal(blocker.kind, "blocker");
  assert.equal(blocker.proven, true);
  assert.equal(blocker.remainingAfter, 0);
  assert.equal(blocker.provenRemainingAfter, 0);
});

test("pointer-none split gradient subtracts only the opaque band and keeps the ramp unassessed without a witness", () => {
  const result = observeGradientScene({
    targetRect: SPLIT_TARGET,
    painterRect: SPLIT_PAINTER,
    pointerAuto: false,
  });
  const blocker = result.events.find(event => event.phase === "blocker"
    && event.targetRef === result.selection.target && event.blockerRef === result.selection.painter);
  assert.ok(blocker);
  assert.equal(blocker.kind, "blocker");
  assert.equal(blocker.proven, true);
  assert.equal(blocker.remainingBefore, 1);
  assert.equal(blocker.remainingAfter, 1);
  assert.equal(blocker.provenRemainingAfter, 1);

  const pointProbe = result.events.find(event => event.phase === "point_probe"
    && event.targetRef === result.selection.target);
  assert.ok(pointProbe);
  assert.deepEqual(pointProbe.remainingRect, {
    x: 757.5625,
    y: 60.5,
    width: 12.9375,
    height: 1.5,
  });
  assert.equal(pointProbe.exposed, false);
  assert.equal(pointProbe.chosenOwnerRef, null);
  assert.equal(result.node.foreground, "unassessed", `foreground=${result.node.foreground}`);
  assert.equal(result.node.exposedRects, null);
});

test("unsupported or additional own paint keeps the gradient surface uncertain", async (t) => {
  const cases = [
    ["missing positioning", { backgroundOrigin: undefined }],
    ["mask", { maskImage: "linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))" }],
    ["filter", { filter: "blur(1px)" }],
    ["border", { borderLeftWidth: "1px", borderLeftStyle: "solid", borderLeftColor: "rgb(0, 0, 0)" }],
    ["rounded own box", { borderTopLeftRadius: "4px" }],
    ["pseudo content", { pseudoContent: '"x"' }],
  ];
  for (const [name, painterStyle] of cases) {
    await t.test(name, () => {
      const result = observeGradientScene({
        targetRect: RAMP_TARGET,
        painterRect: RAMP_PAINTER,
        pointerAuto: true,
        withNativeHit: true,
        painterStyle,
      });
      assert.equal(result.node.foreground, "unassessed", `foreground=${result.node.foreground}`);
      const blocker = result.events.find(event => event.phase === "blocker"
        && event.targetRef === result.selection.target && event.blockerRef === result.selection.painter);
      assert.ok(blocker);
      assert.equal(blocker.kind, "uncertain");
      assert.equal(blocker.proven, false);
    });
  }
});
