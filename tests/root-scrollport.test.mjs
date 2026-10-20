import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

// Observed document-scroll facts. The HTML element is the real root scroller:
// CSS1Compat, document.scrollingElement === document.documentElement, and
// overflow auto/auto. The viewport is 1222x1878 while the root client box is
// 1207x1878, so the 15px difference stays outside the root scrollport.
const VIEWPORT = { x: 0, y: 0, width: 1222, height: 1878 };
const ROOT_RECT = { x: 0, y: -595, width: 1207, height: 1878 };
const ROOT_CLIENT = { left: 0, top: 0, width: 1207, height: 1878 };
const TARGET_RECT = { x: 100, y: 1600, width: 100, height: 100 };

// Explicit strict facts for the accepted root-scrollport subset. Missing or
// non-baseline facts are tested separately and must not be defaulted.
const BASE_STYLE = {
  display: "block",
  visibility: "visible",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  zoom: "1",
  filter: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  contain: "none",
  willChange: "auto",
  contentVisibility: "visible",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  pointerEvents: "auto",
  cursor: "auto",
  boxShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
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

function makeElement(styles, tagName, rect, parent = null, overrides = {}) {
  const {
    style: styleOverride = {},
    clientLeft = 0,
    clientTop = 0,
    clientWidth = rect.width,
    clientHeight = rect.height,
    ...elementOverrides
  } = overrides;
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: parent,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    isConnected: true,
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
    ...elementOverrides,
  };
  element.clientLeft = clientLeft;
  element.clientTop = clientTop;
  element.clientWidth = clientWidth;
  element.clientHeight = clientHeight;
  styles.set(element, { ...BASE_STYLE, ...styleOverride });
  return element;
}

function append(parent, ...children) {
  parent.children = children;
  parent.childNodes = children;
  parent.childElementCount = children.length;
  for (const child of children) child.parentElement = parent;
}

function makeFixture({
  rootStyle = {},
  rootClient = ROOT_CLIENT,
  compatMode = "CSS1Compat",
  scrollingElement = "root",
  targetRect = TARGET_RECT,
  nested = null,
} = {}) {
  const styles = new Map();
  const html = makeElement(styles, "HTML", ROOT_RECT, null, {
    clientLeft: rootClient.left,
    clientTop: rootClient.top,
    clientWidth: rootClient.width,
    clientHeight: rootClient.height,
    scrollLeft: 0,
    scrollTop: 595,
    scrollWidth: rootClient.width,
    scrollHeight: 6917,
    style: {
      overflowX: "auto",
      overflowY: "auto",
      ...rootStyle,
    },
  });
  const body = makeElement(styles, "BODY", { x: 0, y: -595, width: rootClient.width, height: 6917 }, html, {
    clientWidth: rootClient.width,
    clientHeight: 6917,
    style: { overflowX: "visible", overflowY: "visible" },
  });
  const nestedElement = nested === null ? null : makeElement(styles, "DIV", nested.rect, body, {
    clientLeft: nested.clientLeft ?? 0,
    clientTop: nested.clientTop ?? 0,
    clientWidth: nested.clientWidth ?? nested.rect.width,
    clientHeight: nested.clientHeight ?? nested.rect.height,
    style: {
      position: "relative",
      overflowX: "hidden",
      overflowY: "hidden",
      ...(nested.style ?? {}),
    },
  });
  const parent = nestedElement ?? body;
  const target = makeElement(styles, "DIV", targetRect, parent, {
    style: { position: "static" },
  });
  append(html, body);
  if (nestedElement === null) {
    append(body, target);
  } else {
    append(body, nestedElement);
    append(nestedElement, target);
  }

  const scrolling = scrollingElement === "body"
    ? body
    : scrollingElement === "missing" ? null : html;
  const document = {
    documentElement: html,
    body,
    compatMode,
    scrollingElement: scrolling,
    baseURI: "https://fixture.test/root-scrollport",
  };
  const window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    getComputedStyle: (element, pseudo) => pseudo
      ? { ...BASE_STYLE, content: "none" }
      : styles.get(element),
  };
  return { html, body, nested: nestedElement, target, document, window };
}

function observe(fixture) {
  const registry = createStableNodeRefRegistry("root-scrollport");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "root-scrollport",
    documentRef: "fixture",
  });
  const refFor = element => stableNodeRefFor(registry, element);
  return {
    snapshot,
    rectFor: element => snapshot.evidence.get(refFor(element))?.rect,
    clippedRectFor: element => snapshot.evidence.get(refFor(element))?.clippedRect,
    hasNode: element => snapshot.observation.nodes.some(node => node.nodeRef === refFor(element)),
  };
}

test("scrolled HTML root uses the viewport-anchored client scrollport", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const clipped = observed.clippedRectFor(fixture.target);

  assert.ok(observed.hasNode(fixture.target), "target node must stay in the observation");
  assert.deepEqual(observed.rectFor(fixture.target), TARGET_RECT);
  assert.deepEqual(
    clipped,
    { x: 100, y: 1600, width: 100, height: 100 },
    `clippedRect=${JSON.stringify(clipped)}; root rect y=-595 with client height 1878 must not clamp the target at 1283`,
  );
  assert.ok(clipped.y >= 0 && clipped.y + clipped.height <= VIEWPORT.height);
});

function hiddenRootFixture(options = {}) {
  const fixture = makeFixture({
    rootStyle: { overflowX: "hidden", overflowY: "hidden", ...(options.rootStyle ?? {}) },
    rootClient: { left: 0, top: 0, width: 1280, height: 720 },
    targetRect: { x: 100, y: 690, width: 240, height: 80 },
    ...options,
  });
  fixture.window.innerWidth = 1280;
  fixture.window.innerHeight = 720;
  fixture.html.scrollTop = 0;
  fixture.html.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1280, height: 3533.984375 });
  return fixture;
}

const ACTUAL_ROOT_WINDOW = { width: 1280, height: 720 };
const ACTUAL_ROOT_CLIENT = { left: 0, top: 0, width: 1265, height: 720 };
const ACTUAL_ROOT_TARGET = { x: 1260, y: 710, width: 40, height: 40 };

function mixedRootFixture({ overflowX, overflowY, targetRect = ACTUAL_ROOT_TARGET }) {
  const fixture = makeFixture({
    rootStyle: { overflowX, overflowY },
    rootClient: ACTUAL_ROOT_CLIENT,
    targetRect,
  });
  fixture.window.innerWidth = ACTUAL_ROOT_WINDOW.width;
  fixture.window.innerHeight = ACTUAL_ROOT_WINDOW.height;
  fixture.html.scrollLeft = 0;
  fixture.html.scrollTop = 595;
  fixture.html.getBoundingClientRect = () => ({ x: 0, y: -595, width: 1265, height: 3533.984375 });
  return fixture;
}

test("actual auto/scroll root clips to the native client scrollport", () => {
  const fixture = mixedRootFixture({ overflowX: "auto", overflowY: "scroll" });
  const result = observe(fixture);

  assert.deepEqual(result.clippedRectFor(fixture.body), { x: 0, y: 0, width: 1265, height: 720 });
  assert.deepEqual(result.rectFor(fixture.target), ACTUAL_ROOT_TARGET);
  assert.deepEqual(result.clippedRectFor(fixture.target), {
    x: 1260,
    y: 710,
    width: 5,
    height: 10,
  });
});

test("mixed root axis order and hidden/auto use the same client scrollport", () => {
  for (const [label, overflowX, overflowY] of [
    ["reverse mixed axes", "scroll", "auto"],
    ["hidden/auto", "hidden", "auto"],
  ]) {
    const fixture = mixedRootFixture({ overflowX, overflowY });
    assert.deepEqual(observe(fixture).clippedRectFor(fixture.target), {
      x: 1260,
      y: 710,
      width: 5,
      height: 10,
    }, label);
  }
});

test("actual hidden HTML root clips a crossing descendant to the client viewport", () => {
  const fixture = hiddenRootFixture();
  const result = observe(fixture);
  assert.deepEqual(result.rectFor(fixture.target), { x: 100, y: 690, width: 240, height: 80 });
  assert.deepEqual(result.clippedRectFor(fixture.target), { x: 100, y: 690, width: 240, height: 30 });
});

test("hidden root remains viewport-anchored after programmatic scrolling", () => {
  const fixture = hiddenRootFixture();
  fixture.html.scrollTop = 950;
  fixture.html.getBoundingClientRect = () => ({ x: 0, y: -950, width: 1280, height: 3533.984375 });
  assert.deepEqual(observe(fixture).clippedRectFor(fixture.target), { x: 100, y: 690, width: 240, height: 30 });
});

test("hidden root does not bypass identity, transform or leading-offset proof", () => {
  const cases = [
    { compatMode: "BackCompat" },
    { scrollingElement: "body" },
    { rootStyle: { overflowX: "hidden", overflowY: "hidden", transform: "matrix(2, 0, 0, 2, 0, 0)" } },
    { rootStyle: { overflowX: "hidden", overflowY: "hidden", zoom: "2" } },
    { rootClient: { left: 1, top: 0, width: 1280, height: 720 } },
  ];
  for (const options of cases) {
    const fixture = hiddenRootFixture(options);
    assert.equal(observe(fixture).clippedRectFor(fixture.target), null, JSON.stringify(options));
  }
});

test("clip and visible root overflow stay unknown when the root would clip", () => {
  for (const [label, rootStyle] of [
    ["clip", { overflowX: "clip", overflowY: "hidden" }],
    ["visible", { overflowX: "visible", overflowY: "hidden" }],
  ]) {
    const fixture = hiddenRootFixture({ rootStyle });
    assert.equal(observe(fixture).clippedRectFor(fixture.target), null, label);
  }
});

test("visible/visible root keeps the existing no-root-clip path", () => {
  const fixture = hiddenRootFixture({ rootStyle: { overflowX: "visible", overflowY: "visible" } });
  assert.deepEqual(observe(fixture).clippedRectFor(fixture.target), { x: 100, y: 690, width: 240, height: 80 });
});

test("root client width stays narrower than the inner viewport", () => {
  // y stays inside the original root rect so this case isolates the width rule.
  const targetRect = { x: 1210, y: 400, width: 100, height: 100 };
  const fixture = makeFixture({ targetRect });
  const observed = observe(fixture);

  assert.deepEqual(observed.clippedRectFor(fixture.target), {
    x: 1210,
    y: 400,
    width: 0,
    height: 100,
  });
});

test("ordinary nested scroll keeps its shifted own client box", () => {
  const fixture = makeFixture({
    nested: { rect: { x: 100, y: 200, width: 400, height: 300 } },
    targetRect: { x: 120, y: 450, width: 100, height: 100 },
  });
  const observed = observe(fixture);

  assert.deepEqual(observed.clippedRectFor(fixture.target), {
    x: 120,
    y: 450,
    width: 100,
    height: 50,
  });
});

test("positive nested scale is not reset by the root scrollport correction", () => {
  const fixture = makeFixture({
    nested: {
      rect: { x: 100, y: 200, width: 800, height: 600 },
      clientWidth: 400,
      clientHeight: 300,
      style: { transform: "matrix(2, 0, 0, 2, 0, 0)" },
    },
    targetRect: { x: 120, y: 750, width: 100, height: 100 },
  });
  const observed = observe(fixture);

  assert.deepEqual(observed.clippedRectFor(fixture.target), {
    x: 120,
    y: 750,
    width: 100,
    height: 50,
  });
});

test("non-baseline root transform and zoom stay unknown when root overflow would clip", () => {
  for (const [label, rootStyle] of [
    ["identity matrix", { transform: "matrix(1, 0, 0, 1, 0, 0)" }],
    ["positive scale matrix", { transform: "matrix(1.25, 0, 0, 1.25, 0, 0)" }],
    ["non-unit zoom", { zoom: "2" }],
  ]) {
    const fixture = makeFixture({ rootStyle });
    assert.equal(observe(fixture).clippedRectFor(fixture.target), null, label);
  }
});

test("unknown root identity stays unknown when root overflow would clip", () => {
  for (const [label, options] of [
    ["quirks compat mode", { compatMode: "BackCompat" }],
    ["missing compat mode", { compatMode: null }],
    ["body scrolling element", { scrollingElement: "body" }],
    ["missing scrolling element", { scrollingElement: "missing" }],
  ]) {
    const fixture = makeFixture(options);
    assert.equal(observe(fixture).clippedRectFor(fixture.target), null, label);
  }
});

test("leading root client offsets stay unknown when root overflow would clip", () => {
  for (const [label, rootClient] of [
    ["clientTop", { ...ROOT_CLIENT, top: 15 }],
    ["clientLeft", { ...ROOT_CLIENT, left: 15 }],
  ]) {
    const fixture = makeFixture({ rootClient });
    assert.equal(observe(fixture).clippedRectFor(fixture.target), null, label);
  }
});
