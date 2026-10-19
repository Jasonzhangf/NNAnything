import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  checkCandidates,
  createFocusSpec,
  observeCandidates,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";
import { certifySvgAtomicViewport } from "../dist/adapters/browser/svg-clipping.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const VIEWPORT = { x: 0, y: 0, width: 1440, height: 900 };
const BASE_STYLE = {
  display: "block",
  visibility: "visible",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  zoom: "1",
  transformStyle: "flat",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  contain: "none",
  willChange: "auto",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  stroke: "none",
  strokeWidth: "0px",
  markerStart: "none",
  markerMid: "none",
  markerEnd: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  pointerEvents: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  content: "none",
  boxShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
};

function buildAtomicSvgPublicFixture({
  rootStyle = {},
  targetStyle = {},
  targetRect = { x: 104, y: 104, width: 16, height: 16 },
  targetTag = "path",
  targetNamespace = SVG_NAMESPACE,
  targetAttrs = { d: "M4 4H20V20H4Z" },
  targetChildren = 0,
  targetPseudoContent = "none",
  rootRect = { x: 100, y: 100, width: 32, height: 32 },
  coverRect = null,
  viewBox = "0 0 32 32",
  wrapForeignObject = false,
  includeSibling = true,
  rootParentStyle = null,
  clipPathRect = null,
  duplicateClipPathRect = null,
  clipPathUnits = null,
} = {}) {
  const document = {
    documentElement: null,
    body: null,
    baseURI: "https://fixture.test/atomic-svg",
  };
  const styleOverrides = new Map();
  const pseudoOverrides = new Map();
  const window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    getComputedStyle(element, pseudo) {
      const style = { ...BASE_STYLE, ...(styleOverrides.get(element) ?? {}) };
      if (pseudo) return { ...style, ...(pseudoOverrides.get(element) ?? {}) };
      style.getPropertyValue = property => {
        const key = String(property).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return style[key] === undefined || style[key] === null ? "" : String(style[key]);
      };
      return style;
    },
  };
  const make = (tag, {
    parent = null,
    namespace = XHTML_NAMESPACE,
    rect = { x: 0, y: 0, width: 0, height: 0 },
    client = null,
    attrs = {},
  } = {}) => {
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      namespaceURI: namespace,
      parentElement: parent,
      children: [],
      childNodes: [],
      childElementCount: 0,
      id: attrs.id ?? "",
      classList: [],
      ownerDocument: document,
      shadowRoot: null,
      isConnected: true,
      matches() { return false; },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name);
      },
      getBoundingClientRect() {
        return { ...rect };
      },
      getClientRects() {
        return [{ ...rect }];
      },
      querySelectorAll(selector) {
        if (String(selector) !== "*") return [];
        const descendants = [];
        const visit = current => {
          for (const child of current.children ?? []) {
            descendants.push(child);
            visit(child);
          }
        };
        visit(element);
        return descendants;
      },
    };
    element.clientWidth = client?.width ?? 0;
    element.clientHeight = client?.height ?? 0;
    element.clientLeft = client?.left ?? 0;
    element.clientTop = client?.top ?? 0;
    return element;
  };
  const attach = (parent, children) => {
    parent.children = children;
    parent.childNodes = children;
    parent.childElementCount = children.length;
    for (const child of children) child.parentElement = parent;
  };
  const inRect = (point, rect) => point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;

  const html = make("html", { rect: VIEWPORT, client: { width: VIEWPORT.width, height: VIEWPORT.height } });
  const cover = make("div", {
    parent: html,
    rect: coverRect ?? rootRect,
    client: { width: (coverRect ?? rootRect).width, height: (coverRect ?? rootRect).height },
  });
  const rootParent = rootParentStyle === null
    ? html
    : make("div", {
      parent: html,
      rect: rootRect,
      client: { width: rootRect.width, height: rootRect.height },
    });
  const root = make("svg", {
    parent: rootParent,
    namespace: SVG_NAMESPACE,
    rect: rootRect,
    client: { width: rootRect.width, height: rootRect.height },
    attrs: {
      ...(viewBox === null ? {} : { viewBox }),
      width: String(rootRect.width),
      height: String(rootRect.height),
    },
  });
  const foreignObject = wrapForeignObject
    ? make("foreignObject", {
      parent: root,
      namespace: SVG_NAMESPACE,
      rect: rootRect,
    })
    : null;
  const target = make(targetTag, {
    parent: foreignObject ?? root,
    namespace: targetNamespace,
    rect: targetRect,
    attrs: targetAttrs,
  });
  const targetChild = targetChildren > 0
    ? make("path", { parent: target, namespace: SVG_NAMESPACE, rect: targetRect, attrs: { d: "M0 0H1V1H0Z" } })
    : null;
  const sibling = includeSibling
    ? make("path", {
      parent: root,
      namespace: SVG_NAMESPACE,
      rect: { x: rootRect.x + 12, y: rootRect.y + 12, width: 16, height: 16 },
      attrs: { d: "M12 12H28V28H12Z" },
    })
    : null;
  const makeClip = (id, rect) => {
    if (rect === null) return null;
    const clipPath = make("clipPath", {
      parent: root,
      namespace: SVG_NAMESPACE,
      attrs: { id, ...(clipPathUnits === null ? {} : { clipPathUnits }) },
    });
    const clipRect = make("rect", {
      parent: clipPath,
      namespace: SVG_NAMESPACE,
      attrs: rect,
    });
    attach(clipPath, [clipRect]);
    return clipPath;
  };
  const clipPath = makeClip("atomic-clip", clipPathRect);
  const duplicateClipPath = makeClip("atomic-clip", duplicateClipPathRect);
  if (foreignObject) {
    attach(foreignObject, [target, ...(targetChild === null ? [] : [targetChild])]);
    attach(root, [foreignObject, ...(sibling === null ? [] : [sibling])]);
  } else {
    attach(target, targetChild === null ? [] : [targetChild]);
    attach(root, [
      target,
      ...(sibling === null ? [] : [sibling]),
      ...(clipPath === null ? [] : [clipPath]),
      ...(duplicateClipPath === null ? [] : [duplicateClipPath]),
    ]);
  }
  if (rootParentStyle === null) {
    attach(html, [cover, root]);
  } else {
    attach(rootParent, [root]);
    attach(html, [cover, rootParent]);
  }

  document.documentElement = html;
  document.compatMode = "CSS1Compat";
  document.scrollingElement = html;
  html.scrollLeft = 0;
  html.scrollTop = 0;
  document.body = html;
  document.elementsFromPoint = (x, y) => inRect({ x, y }, coverRect ?? rootRect)
    ? [cover, root, html]
    : [root, html];
  const allElements = [];
  const collect = element => {
    allElements.push(element);
    for (const child of element.children ?? []) collect(child);
  };
  collect(html);
  document.querySelectorAll = selector => String(selector).toLowerCase() === "clippath"
    ? allElements.filter(element => element.tagName.toLowerCase() === "clippath")
    : [];

  styleOverrides.set(html, { overflowX: "auto", overflowY: "auto" });
  styleOverrides.set(cover, {
    backgroundColor: "rgb(20, 20, 24)",
    position: "relative",
    zIndex: "2",
  });
  styleOverrides.set(root, {
    width: `${rootRect.width}px`,
    height: `${rootRect.height}px`,
    overflowX: "hidden",
    overflowY: "hidden",
    transform: "none",
    ...rootStyle,
  });
  if (rootParentStyle !== null) {
    styleOverrides.set(rootParent, { ...rootParentStyle });
  }
  styleOverrides.set(target, {
    backgroundColor: "rgba(0, 0, 0, 0)",
    fill: "rgb(20, 20, 24)",
    ...targetStyle,
  });
  pseudoOverrides.set(target, { content: targetPseudoContent });
  if (targetChild !== null) {
    styleOverrides.set(targetChild, { backgroundColor: "rgba(0, 0, 0, 0)", fill: "rgb(20, 20, 24)" });
  }
  if (sibling !== null) {
    styleOverrides.set(sibling, {
      backgroundColor: "rgba(0, 0, 0, 0)",
      fill: "rgb(20, 20, 24)",
    });
  }

  return {
    document, window, html, cover, rootParent, root, foreignObject, target, targetChild, sibling,
    clipPath, duplicateClipPath,
  };
}

test("atomic SVG certificate accepts a target with two direct PATH siblings", () => {
  const fixture = buildAtomicSvgPublicFixture();
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 100, y: 100, width: 32, height: 32 });
});

test("atomic SVG certificate rejects unsupported containment facts", () => {
  const cases = [
    ["unclipped viewport", { rootStyle: { overflowX: "visible" } }],
    ["root effect", { rootStyle: { filter: "blur(1px)" } }],
    ["root opacity", { rootStyle: { opacity: "0.6" } }],
    ["root clip", { rootStyle: { clipPath: "url(#atomic-clip)" } }],
    ["target effect", { targetStyle: { filter: "blur(1px)" } }],
    ["foreignObject", { wrapForeignObject: true, targetTag: "div", targetNamespace: XHTML_NAMESPACE }],
    ["missing root mapping", { viewBox: null }],
    ["visible root permits target escape", { rootStyle: { overflowX: "visible", overflowY: "visible" }, targetRect: { x: 116, y: 104, width: 20, height: 16 } }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildAtomicSvgPublicFixture(options);
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("atomic SVG certificate requires known absence of top-layer escape", () => {
  const missing = buildAtomicSvgPublicFixture();
  delete missing.target.matches;
  assert.equal(certifySvgAtomicViewport(missing.target, missing.window), null);
  const missingRoot = buildAtomicSvgPublicFixture();
  delete missingRoot.root.matches;
  assert.equal(certifySvgAtomicViewport(missingRoot.target, missingRoot.window), null);
  const fullscreen = buildAtomicSvgPublicFixture();
  fullscreen.target.matches = selector => selector === ":fullscreen";
  assert.equal(certifySvgAtomicViewport(fullscreen.target, fullscreen.window), null);
  const throwing = buildAtomicSvgPublicFixture();
  throwing.target.matches = () => {
    throw new Error("unsupported selector");
  };
  assert.equal(certifySvgAtomicViewport(throwing.target, throwing.window), null);
});

function observeTarget(fixture) {
  const registry = createStableNodeRefRegistry("svg-atomic-public");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-atomic-public",
    documentRef: "fixture",
  });
  const targetRef = stableNodeRefFor(registry, fixture.target);
  const targetNode = snapshot.observation.nodes.find(node => node.nodeRef === targetRef);

  return { registry, targetRef, targetNode, snapshot };
}

function assertPublicOcclusion(fixture, elements = [fixture.target]) {
  const { registry, targetRef, snapshot } = observeTarget(fixture);
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  for (const element of elements) {
    const ref = stableNodeRefFor(registry, element);
    assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === ref));
    const slot = candidates.slots.find(candidate => candidate.nodeRef === ref);
    assert.ok(slot);
    assert.equal(slot.status, "filtered_out");
    assert.deepEqual(slot.reasons, ["occluded"]);
  }
}

test("hidden root viewport bounds an actual-shaped subpixel protruding fill", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: { x: 810.671875, y: 22.375, width: 15, height: 15 },
    viewBox: "0 0 100 100",
    targetRect: { x: 810.671875, y: 22.359649658203125, width: 15.0150146484375, height: 15.030349731445312 },
    includeSibling: false,
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);
  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 810.671875, y: 22.375, width: 15, height: 15 });
  assertPublicOcclusion(fixture);
});

test("hidden root bounds large fill overflow without a separate descendant clip", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: { x: 100, y: 100, width: 15, height: 15 },
    viewBox: "0 0 100 100",
    targetRect: { x: 98.5, y: 98.5, width: 18, height: 18 },
    targetAttrs: { d: "M-10 -10H110V110H-10Z" },
    includeSibling: false,
  });
  assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window)?.rootElement, fixture.root);
  assertPublicOcclusion(fixture);
});

test("hidden overflow admission preserves genuine escape and expanded clip rejection", () => {
  for (const rootStyle of [
    { overflowX: "visible", overflowY: "visible" },
    { overflowX: "clip", overflowY: "clip", overflowClipMargin: "4px" },
  ]) {
    const fixture = buildAtomicSvgPublicFixture({
      rootRect: { x: 100, y: 100, width: 15, height: 15 },
      viewBox: "0 0 100 100",
      targetRect: { x: 98.5, y: 98.5, width: 18, height: 18 },
      targetAttrs: { d: "M-10 -10H110V110H-10Z" },
      rootStyle,
      includeSibling: false,
    });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null);
    assert.notEqual(observeTarget(fixture).targetNode.foreground, "occluded");
  }
});

const G_CLIP_TARGET_RECT = {
  x: 623.6651611328125,
  y: 684.5042724609375,
  width: 16.61181640625,
  height: 16.6126708984375,
};
const G_CLIP_ROOT_RECT = {
  x: 623.390625,
  y: 684.59375,
  width: 16.796875,
  height: 16.796875,
};

test("atomic SVG certificate accepts a locally clipped G whose raw bounds protrude", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: G_CLIP_ROOT_RECT,
    viewBox: "0 0 20 20",
    targetTag: "g",
    targetRect: G_CLIP_TARGET_RECT,
    targetAttrs: {
      "clip-path": "url(#atomic-clip)",
      d: null,
    },
    targetStyle: { clipPath: "url(#atomic-clip)" },
    targetChildren: 1,
    clipPathRect: { x: "0", y: "0", width: "20", height: "20" },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, G_CLIP_ROOT_RECT);
  assertPublicOcclusion(fixture, [fixture.target, fixture.targetChild]);
});

test("atomic SVG certificate reuses the reflected direct-path physical viewport", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: { x: 782.5, y: 681, width: 24, height: 24 },
    viewBox: "0 0 24 24",
    rootStyle: { transform: "matrix(-1, 0, 0, -1, 0, 0)" },
    targetRect: { x: 788.579345703125, y: 689.791259765625, width: 11.84320068359375, height: 5.08441162109375 },
    includeSibling: false,
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 782.5, y: 681, width: 24, height: 24 });
  assertPublicOcclusion(fixture);
});

test("atomic SVG certificate accepts explicit target opacity attenuation", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: { x: 1106.5, y: 524.65625, width: 16, height: 8 },
    viewBox: "0 0 16 8",
    targetRect: { x: 1106.5001220703125, y: 524.656494140625, width: 15.280029296875, height: 7.52001953125 },
    targetStyle: { opacity: "0.6" },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 1106.5, y: 524.65625, width: 16, height: 8 });
  assertPublicOcclusion(fixture);
});

test("atomic SVG certificate accepts known positive-axis ancestor transforms", () => {
  const fixture = buildAtomicSvgPublicFixture({
    rootRect: { x: 1191, y: 646, width: 32, height: 32 },
    viewBox: "0 0 24 24",
    rootParentStyle: { transform: "matrix(1, 0, 0, 1, 0, 0)", transformStyle: "flat" },
    targetRect: { x: 1195.6292724609375, y: 649.3796997070312, width: 22.74267578125, height: 25.24029541015625 },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 1191, y: 646, width: 32, height: 32 });
  assertPublicOcclusion(fixture);
});

test("atomic clip admission keeps paint-expanding effects rejected", () => {
  const cases = [
    ["filter", { targetStyle: { filter: "blur(1px)" } }],
    ["mask", { targetStyle: { maskImage: 'url("mask")' } }],
    ["stroke", { targetStyle: { stroke: "rgb(10, 10, 10)" } }],
    ["marker", { targetStyle: { markerEnd: 'url("#marker")' } }],
    ["shadow", { targetStyle: { boxShadow: "0 0 2px black" } }],
    ["outline", { targetStyle: { outlineStyle: "solid" } }],
    ["pseudo content", { targetPseudoContent: "counter(item)" }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildAtomicSvgPublicFixture({
      rootRect: G_CLIP_ROOT_RECT,
      viewBox: "0 0 20 20",
      targetTag: "g",
      targetRect: G_CLIP_TARGET_RECT,
      targetAttrs: { "clip-path": "url(#atomic-clip)", d: null },
      targetStyle: { clipPath: "url(#atomic-clip)" },
      targetChildren: 1,
      clipPathRect: { x: "0", y: "0", width: "20", height: "20" },
      ...options,
    });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("atomic clip admission rejects unresolved and unsupported resources", () => {
  const cases = [
    ["missing resource", { clipPathRect: null }],
    ["conflicting duplicate", {
      clipPathRect: { x: "0", y: "0", width: "20", height: "20" },
      duplicateClipPathRect: { x: "0", y: "0", width: "10", height: "10" },
    }],
    ["object bounding box", {
      clipPathRect: { x: "0", y: "0", width: "20", height: "20" },
      clipPathUnits: "objectBoundingBox",
    }],
    ["rounded geometry", { clipPathRect: { x: "0", y: "0", width: "20", height: "20", rx: "2" } }],
    ["nonintersecting clip under clip overflow", {
      clipPathRect: { x: "100", y: "100", width: "20", height: "20" },
      rootStyle: { overflowX: "clip", overflowY: "clip" },
    }],
    ["invalid root mapping", {
      clipPathRect: { x: "0", y: "0", width: "20", height: "20" },
      rootStyle: { transform: "matrix(0.999857, 0.016916, -0.016916, 0.999857, 0, 0)" },
    }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildAtomicSvgPublicFixture({
      rootRect: G_CLIP_ROOT_RECT,
      viewBox: "0 0 20 20",
      targetTag: "g",
      targetRect: G_CLIP_TARGET_RECT,
      targetAttrs: { "clip-path": "url(#atomic-clip)", d: null },
      targetStyle: { clipPath: "url(#atomic-clip)" },
      targetChildren: 1,
      ...options,
    });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("atomic opacity admission accepts only finite positive attenuation", () => {
  for (const [name, opacity] of [
    ["missing", undefined],
    ["blank", ""],
    ["whitespace", " "],
    ["nonnumeric", "NaN"],
    ["infinite", "Infinity"],
    ["negative", "-0.1"],
    ["greater than one", "1.1"],
    ["zero", "0"],
  ]) {
    const fixture = buildAtomicSvgPublicFixture({ targetStyle: { opacity } });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("atomic root transforms stay outside both positive and reflected mappings", () => {
  const transforms = [
    "rotate(20deg)",
    "skewX(10deg)",
    "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
  ];
  for (const transform of transforms) {
    const fixture = buildAtomicSvgPublicFixture({ rootStyle: { transform } });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, transform);
  }
});

test("atomic ancestor transform admission stays positive-axis and flat", () => {
  const cases = [
    ["singular", { transform: "matrix(0, 0, 0, 1, 0, 0)" }],
    ["negative", { transform: "matrix(-1, 0, 0, 1, 0, 0)" }],
    ["angled", { transform: "matrix(0.999857, 0.016916, -0.016916, 0.999857, 0, 0)" }],
    ["missing", { transform: undefined }],
    ["independent translate", { transform: "matrix(1, 0, 0, 1, 0, 0)", translate: "1px" }],
    ["preserve-3d", { transform: "matrix(1, 0, 0, 1, 0, 0)", transformStyle: "preserve-3d" }],
  ];
  for (const [name, rootParentStyle] of cases) {
    const fixture = buildAtomicSvgPublicFixture({ rootParentStyle });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("atomic reflected viewport reuse remains direct-leaf-path only", () => {
  const cases = [
    ["G target", { targetTag: "g", targetChildren: 1 }],
    ["multiple direct paths", { includeSibling: true }],
    ["non-leaf direct path", { targetChildren: 1 }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildAtomicSvgPublicFixture({
      rootRect: { x: 782.5, y: 681, width: 24, height: 24 },
      viewBox: "0 0 24 24",
      rootStyle: { transform: "matrix(-1, 0, 0, -1, 0, 0)" },
      targetRect: { x: 788.579345703125, y: 689.791259765625, width: 11.84320068359375, height: 5.08441162109375 },
      includeSibling: false,
      ...options,
    });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }
});

test("public reader proves a clipped PATH inside an outer SVG atomic witness", () => {
  const { targetRef, targetNode, snapshot } = observeTarget(buildAtomicSvgPublicFixture());
  assert.equal(targetNode?.foreground, "occluded");
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  const slot = candidates.slots.find(slot => slot.nodeRef === targetRef);
  assert.equal(slot.status, "filtered_out");
  assert.ok(slot.reasons.includes("occluded"));
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));
});

test("atomic order never overrides a native target or boundary in front of the cover", () => {
  const targetFirst = buildAtomicSvgPublicFixture();
  targetFirst.document.elementsFromPoint = () => [targetFirst.target, targetFirst.cover, targetFirst.root, targetFirst.html];
  assert.equal(observeTarget(targetFirst).targetNode.foreground, "visible");
  const rootFirst = buildAtomicSvgPublicFixture();
  rootFirst.document.elementsFromPoint = () => [rootFirst.root, rootFirst.cover, rootFirst.html];
  assert.notEqual(observeTarget(rootFirst).targetNode.foreground, "occluded");
});

test("atomic order preserves the uncovered strip rather than propagating full occlusion", () => {
  const fixture = buildAtomicSvgPublicFixture();
  const coverRect = { x: 100, y: 100, width: 12, height: 32 };
  fixture.cover.getBoundingClientRect = () => coverRect;
  fixture.cover.getClientRects = () => [coverRect];
  fixture.document.elementsFromPoint = (x, y) => x < 112 && y >= 100 && y < 132
    ? [fixture.cover, fixture.root, fixture.html] : [fixture.root, fixture.html];
  const { targetNode } = observeTarget(fixture);
  assert.equal(targetNode.foreground, "visible");
  assert.deepEqual(targetNode.exposedRects, [{ x: 112, y: 104, width: 8, height: 16 }]);
});

test("SVG stroke paint outside target bounds is not certified as fully covered", () => {
  const fixture = buildAtomicSvgPublicFixture({ targetStyle: { stroke: "rgb(10, 10, 10)", strokeWidth: "4px" } });
  const coverRect = { x: 104, y: 104, width: 16, height: 16 };
  fixture.cover.getBoundingClientRect = () => coverRect;
  fixture.cover.getClientRects = () => [coverRect];
  fixture.document.elementsFromPoint = (x, y) => x >= 104 && x < 120 && y >= 104 && y < 120
    ? [fixture.cover, fixture.root, fixture.html] : [fixture.root, fixture.html];
  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});
