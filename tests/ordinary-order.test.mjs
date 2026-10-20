import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCandidates,
  createFocusSpec,
  createStableNodeRefRegistry,
  observeCandidates,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 1265, height: 720 };
const XHTML = "http://www.w3.org/1999/xhtml";
const orderStyle = {
  display: "block",
  visibility: "visible",
  transform: "none",
  transformStyle: "flat",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "",
  backdropFilter: "none",
  webkitBackdropFilter: "",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  containerType: "normal",
  willChange: "auto",
  contentVisibility: "visible",
  pointerEvents: "auto",
  boxShadow: "none",
  textShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
  borderImageSource: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
};

function element({
  refKey,
  tagName = "DIV",
  parentElement = null,
  rect = viewport,
  text = null,
  native = { modal: false, popover: false },
  animations = null,
}) {
  const childNodes = text === null ? [] : [{ nodeType: 3, textContent: text }];
  return {
    nodeType: 1,
    refKey,
    tagName,
    namespaceURI: XHTML,
    parentElement,
    children: [],
    childNodes,
    childElementCount: 0,
    id: "",
    classList: [],
    clientLeft: 0,
    clientTop: 0,
    clientWidth: Math.round(rect.width),
    clientHeight: Math.round(rect.height),
    scrollLeft: 0,
    scrollTop: 0,
    getAttribute: () => null,
    hasAttribute: () => false,
    matches: selector => selector === ":modal" ? native.modal
      : selector === ":popover-open" ? native.popover
        : (() => { throw new Error(`unsupported selector ${selector}`); })(),
    ...(animations === null ? {} : { getAnimations: () => animations }),
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
  };
}

function attach(parent, children) {
  parent.children = children;
  parent.childNodes = children;
  parent.childElementCount = children.length;
  for (const child of children) child.parentElement = parent;
}

function span408Fixture({
  targetStyle = {},
  targetParentStyle = {},
  positiveContextStyle = {},
  bodyStyle = {},
  coverRect = { x: 152.5, y: 465.390625, width: 654, height: 120 },
  targetNative = { modal: false, popover: false },
  positiveContextNative = { modal: false, popover: false },
  targetBranchFirst = true,
  hitMode = "target-absent",
  pseudoContent = {},
  fullscreenCapability = true,
} = {}) {
  const html = element({ refKey: "html", tagName: "HTML" });
  const body = element({ refKey: "body", tagName: "BODY", parentElement: html });
  const targetBranch = element({ refKey: "targetBranch", parentElement: body });
  const targetParent = element({ refKey: "targetParent", tagName: "SPAN", parentElement: targetBranch, rect: { x: 152.5, y: 465.390625, width: 654, height: 120 } });
  const target = element({
    refKey: "target",
    tagName: "SPAN",
    parentElement: targetParent,
    rect: { x: 152.5, y: 465.390625, width: 654, height: 120 },
    text: "covered target",
    native: targetNative,
  });
  const coverBranch = element({ refKey: "coverBranch", parentElement: body });
  const positiveContext = element({
    refKey: "positiveContext",
    parentElement: coverBranch,
    rect: viewport,
    native: positiveContextNative,
  });
  const cover = element({
    refKey: "cover",
    parentElement: positiveContext,
    rect: coverRect,
  });
  attach(html, [body]);
  attach(body, targetBranchFirst ? [targetBranch, coverBranch] : [coverBranch, targetBranch]);
  attach(targetBranch, [targetParent]);
  attach(targetParent, [target]);
  attach(coverBranch, [positiveContext]);
  attach(positiveContext, [cover]);

  const styles = {
    html: orderStyle,
    body: { ...orderStyle, overflowX: "auto", overflowY: "auto", ...bodyStyle },
    targetBranch: orderStyle,
    targetParent: { ...orderStyle, display: "inline", position: "relative", ...targetParentStyle },
    target: { ...orderStyle, display: "inline", ...targetStyle },
    coverBranch: orderStyle,
    positiveContext: { ...orderStyle, display: "flex", position: "fixed", zIndex: "203", overflowX: "hidden", overflowY: "auto", ...positiveContextStyle },
    cover: { ...orderStyle, position: "absolute", zIndex: "0", backgroundColor: "rgb(255, 255, 255)" },
  };
  const center = { x: 479.5, y: 525.390625 };
  const contains = (rect, x, y) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  const ancestors = [targetBranch, body, html];
  const document = {
    compatMode: "CSS1Compat",
    documentElement: html,
    body,
    scrollingElement: html,
    baseURI: "https://fixture.test/page",
    fullscreenElement: undefined,
    ...(fullscreenCapability ? { querySelectorAll: selector => {
      assert.equal(selector, ":fullscreen");
      return [];
    } } : {}),
    elementsFromPoint: (x, y) => {
      if (hitMode === "target-before-cover" && contains(coverRect, x, y)) return [target, cover, ...ancestors];
      if (contains(coverRect, x, y)) return [cover, ...ancestors];
      if (contains(target.getBoundingClientRect(), x, y)) return [target, ...ancestors];
      return [html];
    },
  };
  return {
    document, styles, target, cover, targetParent, positiveContext, targetBranch, body, html, center,
    pseudoContent,
  };
}

function observe(fixture) {
  const registry = createStableNodeRefRegistry("ordinary-order");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (node, pseudo) => pseudo
        ? { content: fixture.pseudoContent[node.refKey]?.[pseudo] ?? "none" }
        : fixture.styles[node.refKey],
    },
    registry,
    excludeRoot: null,
    snapshotRef: "ordinary-order",
    documentRef: "fixture",
  });
  const node = snapshot.observation.nodes.find(candidate => candidate.nodeRef === stableNodeRefFor(registry, fixture.target));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  const slot = candidates.slots.find(candidate => candidate.nodeRef === node?.nodeRef);
  return { snapshot, node, slot };
}

test("ordinary static SPAN behind a later fixed positive cover branch is occluded", () => {
  const fixture = span408Fixture({ targetStyle: { outlineWidth: "3px" } });
  const { node, slot } = observe(fixture);
  assert.ok(node, "the target observation must remain present");
  assert.equal(node.foreground, "occluded");
  assert.deepEqual(slot?.reasons, ["occluded"]);
});

test("retained zero contexts do not require an animation-absence assumption", () => {
  const retainedContext = [{ effect: { getComputedTiming: () => ({ fill: "forwards" }) } }];
  const fixture = span408Fixture();
  fixture.targetParent.getAnimations = () => retainedContext;
  fixture.positiveContext.getAnimations = () => retainedContext;
  const { node } = observe(fixture);
  assert.equal(node.foreground, "occluded");
});

test("partial ordinary-order coverage keeps the exposed strip", () => {
  const fixture = span408Fixture({
    coverRect: { x: 152.5, y: 465.390625, width: 327, height: 120 },
  });
  const { node, slot } = observe(fixture);
  assert.equal(node.foreground, "visible");
  assert.ok(Array.isArray(node.exposedRects) && node.exposedRects.length > 0);
  assert.ok(node.exposedRects.every(rect => rect.x >= 479.5));
  assert.notEqual(slot?.status, "filtered_out");
});

test("a positive target itself is not forced behind the cover", () => {
  const fixture = span408Fixture({
    targetStyle: { position: "relative", zIndex: "300" },
    hitMode: "target-before-cover",
  });
  const { node, slot } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
  assert.notEqual(slot?.status, "filtered_out");
});

test("an earlier cover zero branch prevents the later-branch certificate", () => {
  const retainedContext = [{ effect: { getComputedTiming: () => ({ fill: "forwards" }) } }];
  const fixture = span408Fixture({
    targetBranchFirst: false,
  });
  fixture.styles.coverBranch = { ...fixture.styles.coverBranch, opacity: "1", transform: "none" };
  fixture.positiveContext.getAnimations = () => retainedContext;
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("shared flex and grid order reversals are unsupported", () => {
  for (const display of ["flex", "grid"]) {
    const fixture = span408Fixture({
      bodyStyle: { display },
    });
    fixture.styles.targetBranch = { ...fixture.styles.targetBranch, order: "2" };
    fixture.styles.coverBranch = { ...fixture.styles.coverBranch, order: "1" };
    const { node } = observe(fixture);
    assert.notEqual(node.foreground, "occluded", display);
  }
});

test("top-layer state prevents the ordinary-order certificate", () => {
  const fixture = span408Fixture({
    targetNative: { modal: true, popover: false },
  });
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("3D transform style prevents the ordinary-order certificate", () => {
  const fixture = span408Fixture({
    targetParentStyle: { transformStyle: "preserve-3d" },
  });
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("missing native fullscreen capability prevents the certificate", () => {
  const fixture = span408Fixture({ fullscreenCapability: false });
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("missing required CSS facts prevent the certificate", () => {
  const fixture = span408Fixture();
  fixture.styles.targetParent = { ...fixture.styles.targetParent };
  delete fixture.styles.targetParent.transformStyle;
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("a visible own outline prevents the certificate even with outline width", () => {
  const fixture = span408Fixture({
    targetStyle: { outlineStyle: "solid", outlineWidth: "3px", outlineColor: "rgb(255, 0, 0)" },
  });
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("generated pseudo content prevents the certificate", () => {
  const fixture = span408Fixture();
  fixture.pseudoContent.target = { "::before": "\"generated\"" };
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("a target before the cover in native order denies the certificate", () => {
  const fixture = span408Fixture({ hitMode: "target-before-cover" });
  const { node } = observe(fixture);
  assert.notEqual(node.foreground, "occluded");
});

test("an escaping positive child stays independently visible", () => {
  const fixture = span408Fixture();
  const childRect = { x: 439.5, y: 505.390625, width: 80, height: 40 };
  const child = element({
    refKey: "targetChild",
    tagName: "SPAN",
    parentElement: fixture.target,
    rect: childRect,
    text: "visible child",
  });
  attach(fixture.target, [child]);
  fixture.styles.targetChild = {
    ...orderStyle,
    display: "inline",
    position: "relative",
    zIndex: "300",
    backgroundColor: "rgb(10, 120, 80)",
  };
  fixture.document.elementsFromPoint = (x, y) => {
    const inside = (rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
    if (inside(childRect)) return [child, fixture.cover, fixture.targetBranch, fixture.body, fixture.html];
    if (inside(fixture.cover.getBoundingClientRect())) return [fixture.cover, fixture.targetBranch, fixture.body, fixture.html];
    return [fixture.html];
  };
  const registry = createStableNodeRefRegistry("ordinary-order-child");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (node, pseudo) => pseudo ? { content: "none" } : fixture.styles[node.refKey],
    },
    registry,
    excludeRoot: null,
    snapshotRef: "ordinary-order-child",
    documentRef: "fixture",
  });
  const targetNode = snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, fixture.target));
  const childNode = snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, child));
  assert.equal(targetNode.foreground, "occluded");
  assert.equal(childNode.foreground, "visible");
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  assert.deepEqual(candidates.slots.find(slot => slot.nodeRef === targetNode.nodeRef)?.reasons, ["occluded"]);
  assert.equal(candidates.slots.find(slot => slot.nodeRef === childNode.nodeRef)?.status, "ok");
});
