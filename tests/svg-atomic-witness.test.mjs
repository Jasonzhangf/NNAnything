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
  contentVisibility: "visible",
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
  targetAttrs = targetTag === "use"
    ? { href: "#local-symbol" }
    : { d: "M4 4H20V20H4Z" },
  targetChildren = 0,
  targetPseudoContent = "none",
  rootRect = { x: 100, y: 100, width: 32, height: 32 },
  coverRect = null,
  extraCoverRects = [],
  viewBox = "0 0 32 32",
  wrapForeignObject = false,
  includeSibling = true,
  rootParentStyle = null,
  rootParentPseudoStyle = {},
  rootClientRects = null,
  clipPathRect = null,
  duplicateClipPathRect = null,
  clipPathUnits = null,
  localUseSymbol = targetTag === "use"
    ? {
      id: "local-symbol",
      children: [{ tag: "path", attrs: { d: "M-20 -20H60V60H-20Z" } }],
    }
    : null,
  duplicateLocalUseSymbol = null,
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
  const extraCovers = extraCoverRects.map(rect => make("div", {
    parent: html,
    rect,
    client: { width: rect.width, height: rect.height },
  }));
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
  if (rootClientRects !== null) {
    root.getClientRects = () => rootClientRects.map(rect => ({ ...rect }));
  }
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
  const makeLocalUseNode = (spec, parent) => {
    const element = make(spec.tag, {
      parent,
      namespace: spec.namespace ?? SVG_NAMESPACE,
      rect: spec.rect ?? { x: 0, y: 0, width: 0, height: 0 },
      attrs: spec.attrs ?? {},
    });
    styleOverrides.set(element, { ...BASE_STYLE, ...(spec.style ?? {}) });
    const children = (spec.children ?? []).map(child => makeLocalUseNode(child, element));
    attach(element, children);
    return element;
  };
  const makeLocalUseSymbol = (spec, id) => {
    if (spec === null) return null;
    const symbol = make("symbol", {
      parent: null,
      namespace: SVG_NAMESPACE,
      attrs: { id, ...(spec.attrs ?? {}) },
    });
    styleOverrides.set(symbol, { ...BASE_STYLE, ...(spec.style ?? {}) });
    const children = (spec.children ?? []).map(child => makeLocalUseNode(child, symbol));
    attach(symbol, children);
    return symbol;
  };
  const symbol = makeLocalUseSymbol(localUseSymbol, localUseSymbol?.id ?? "local-symbol");
  const duplicateSymbol = makeLocalUseSymbol(
    duplicateLocalUseSymbol,
    duplicateLocalUseSymbol?.id ?? localUseSymbol?.id ?? "local-symbol",
  );
  const defs = symbol === null ? null : make("defs", {
    parent: root,
    namespace: SVG_NAMESPACE,
  });
  if (defs !== null && symbol !== null) {
    attach(defs, [symbol, ...(duplicateSymbol === null ? [] : [duplicateSymbol])]);
  }
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
      ...(defs === null ? [] : [defs]),
    ]);
  }
  if (rootParentStyle === null) {
    attach(html, [cover, root, ...extraCovers]);
  } else {
    attach(rootParent, [root]);
    attach(html, [cover, rootParent, ...extraCovers]);
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
  document.getElementById = id => allElements.find(element => (element.getAttribute("id") ?? element.id) === id) ?? null;
  document.querySelectorAll = selector => String(selector).toLowerCase() === "clippath"
    ? allElements.filter(element => element.tagName.toLowerCase() === "clippath")
    : selector === "*" ? allElements : [];

  styleOverrides.set(html, { overflowX: "auto", overflowY: "auto" });
  styleOverrides.set(cover, {
    backgroundColor: "rgb(20, 20, 24)",
    position: "relative",
    zIndex: "2",
  });
  for (const extraCover of extraCovers) {
    styleOverrides.set(extraCover, {
      backgroundColor: "rgb(20, 20, 24)",
      position: "relative",
      zIndex: "2",
    });
  }
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
  if (rootParentStyle !== null) {
    pseudoOverrides.set(rootParent, { content: "none", ...rootParentPseudoStyle });
  }
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
    document, window, html, cover, extraCovers, rootParent, root, foreignObject, target, targetChild, sibling,
    clipPath, duplicateClipPath, defs, symbol, duplicateSymbol,
  };
}

function buildLocalUsePublicFixture(options = {}) {
  return buildAtomicSvgPublicFixture({
    targetTag: "use",
    targetRect: { x: 108, y: 108, width: 16, height: 16 },
    includeSibling: false,
    ...options,
  });
}

const OUTLINE_ONLY_PARENT_STYLE = {
  display: "flex",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderImageSource: "none",
  boxShadow: "none",
  textShadow: "none",
  outlineStyle: "solid",
  outlineWidth: "1px",
  outlineOffset: "-1px",
  outlineColor: "rgba(255, 255, 255, 0.08)",
  borderTopLeftRadius: "16px",
  borderTopRightRadius: "16px",
  borderBottomLeftRadius: "16px",
  borderBottomRightRadius: "16px",
  transform: "matrix(1, 0, 0, 1, 24, -8)",
};

const ABSENT_PSEUDO_PAINT = {
  content: "none",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderImageSource: "none",
  boxShadow: "none",
  textShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineOffset: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
};

function buildOutlineOnlyUsePublicFixture({ parentStyle = {}, parentPseudoStyle = {} } = {}) {
  const rootRect = { x: 500, y: 200, width: 160, height: 230 };
  const targetRect = { x: 640, y: 240, width: 16, height: 16 };
  return buildLocalUsePublicFixture({
    rootRect,
    targetRect,
    includeSibling: false,
    rootStyle: { overflowX: "hidden", overflowY: "hidden", transform: "none" },
    rootParentStyle: { ...OUTLINE_ONLY_PARENT_STYLE, ...parentStyle },
    rootParentPseudoStyle: { ...ABSENT_PSEUDO_PAINT, ...parentPseudoStyle },
  });
}

function buildStrokedPathPublicFixture({ targetStyle = {}, ...options } = {}) {
  return buildAtomicSvgPublicFixture({
    includeSibling: false,
    ...options,
    targetStyle: {
      fill: "none",
      stroke: "rgba(255, 255, 255, 0.84)",
      strokeWidth: "2.93333px",
      ...targetStyle,
    },
  });
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
    ["stroked PATH visible overflow", {
      includeSibling: false,
      targetStyle: { fill: "none", stroke: "rgba(255, 255, 255, 0.84)", strokeWidth: "2.93333px" },
      rootStyle: { overflowX: "visible", overflowY: "visible" },
    }],
    ["stroked PATH root filter", {
      includeSibling: false,
      targetStyle: { fill: "none", stroke: "rgba(255, 255, 255, 0.84)", strokeWidth: "2.93333px" },
      rootStyle: { filter: "blur(1px)" },
    }],
    ["stroked PATH missing mapping", {
      includeSibling: false,
      targetStyle: { fill: "none", stroke: "rgba(255, 255, 255, 0.84)", strokeWidth: "2.93333px" },
      viewBox: null,
    }],
    ["stroked PATH outer filter", {
      includeSibling: false,
      targetStyle: { fill: "none", stroke: "rgba(255, 255, 255, 0.84)", strokeWidth: "2.93333px" },
      rootParentStyle: { filter: "blur(1px)" },
    }],
    ["stroked PATH marker", {
      includeSibling: false,
      targetStyle: {
        fill: "none",
        stroke: "rgba(255, 255, 255, 0.84)",
        strokeWidth: "2.93333px",
        markerEnd: 'url("#marker")',
      },
    }],
    ["stroked PATH unresolved clip", {
      includeSibling: false,
      targetAttrs: { d: "M4 4H20V20H4Z", "clip-path": "url(#atomic-clip)" },
      targetStyle: {
        fill: "none",
        stroke: "rgba(255, 255, 255, 0.84)",
        strokeWidth: "2.93333px",
        clipPath: "url(#atomic-clip)",
      },
    }],
    ["stroked PATH is not a leaf", {
      includeSibling: false,
      targetChildren: 1,
      targetStyle: { fill: "none", stroke: "rgba(255, 255, 255, 0.84)", strokeWidth: "2.93333px" },
    }],
    ["stroked PATH fixed positioning", {
      includeSibling: false,
      targetStyle: {
        fill: "none",
        stroke: "rgba(255, 255, 255, 0.84)",
        strokeWidth: "2.93333px",
        position: "fixed",
      },
    }],
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
  const strokedFullscreen = buildStrokedPathPublicFixture();
  strokedFullscreen.target.matches = selector => selector === ":fullscreen";
  assert.equal(certifySvgAtomicViewport(strokedFullscreen.target, strokedFullscreen.window), null);
  const throwing = buildAtomicSvgPublicFixture();
  throwing.target.matches = () => {
    throw new Error("unsupported selector");
  };
  assert.equal(certifySvgAtomicViewport(throwing.target, throwing.window), null);
});

function inPublicRect(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

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

function observeTargetWithProbes(fixture) {
  const registry = createStableNodeRefRegistry("svg-atomic-public");
  const targetRef = stableNodeRefFor(registry, fixture.target);
  const probes = [];
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-atomic-public",
    documentRef: "fixture",
    diagnostic: {
      selectedRefs: new Set([targetRef]),
      callback(event) {
        if (event.phase === "point_probe") {
          probes.push({ point: event.point, remainingRect: event.remainingRect, exposed: event.exposed });
        }
      },
    },
  });
  const targetNode = snapshot.observation.nodes.find(node => node.nodeRef === targetRef);

  return { registry, targetRef, targetNode, snapshot, probes };
}

function observeOutlineSurface(fixture, { includeTarget = true } = {}) {
  const registry = createStableNodeRefRegistry("svg-atomic-outline");
  const targetRef = stableNodeRefFor(registry, fixture.target);
  const outlineRef = stableNodeRefFor(registry, fixture.rootParent);
  const events = [];
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.html];
    const target = fixture.target.getBoundingClientRect();
    const inTarget = inPublicRect({ x, y }, target);
    return includeTarget && inTarget
      ? [fixture.rootParent, fixture.rootParent, fixture.target, fixture.root, fixture.html]
      : [fixture.rootParent, fixture.rootParent, fixture.root, fixture.html];
  };
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-atomic-outline",
    documentRef: "fixture",
    diagnostic: {
      selectedRefs: new Set([targetRef, outlineRef]),
      callback(event) {
        events.push(event);
      },
    },
  });
  const targetNode = snapshot.observation.nodes.find(node => node.nodeRef === targetRef);
  const outlineInitial = events.find(event => event.phase === "initial" && event.targetRef === outlineRef);
  return { registry, targetRef, outlineRef, targetNode, snapshot, events, outlineInitial };
}

const fixedPointCross = rect => [
  { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.1 },
  { x: rect.x + rect.width * 0.9, y: rect.y + rect.height * 0.5 },
  { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.9 },
  { x: rect.x + rect.width * 0.1, y: rect.y + rect.height * 0.5 },
];

const fixedPointPerimeter = rect => {
  const points = [];
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      if (fx === 0.1 || fx === 0.9 || fy === 0.1 || fy === 0.9) {
        points.push({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
      }
    }
  }
  return points;
};

const samePoint = (a, b) => a.x === b.x && a.y === b.y;

function centerHoleHits(fixture, center, cross, crossStack) {
  return (x, y) => {
    if (x < 0 || x >= VIEWPORT.width || y < 0 || y >= VIEWPORT.height) return [];
    if (samePoint({ x, y }, center)) return [fixture.sibling, fixture.root, fixture.html];
    if (cross.some(point => samePoint({ x, y }, point))) return crossStack;
    return [fixture.root, fixture.html];
  };
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
  const fixture = buildStrokedPathPublicFixture();
  const coverRect = { x: 104, y: 104, width: 16, height: 16 };
  fixture.cover.getBoundingClientRect = () => coverRect;
  fixture.cover.getClientRects = () => [coverRect];
  fixture.document.elementsFromPoint = (x, y) => x >= 104 && x < 120 && y >= 104 && y < 120
    ? [fixture.cover, fixture.root, fixture.html] : [fixture.root, fixture.html];
  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});

test("direct stroked PATH uses the complete hidden-root domain with no target hit", () => {
  const fixture = buildStrokedPathPublicFixture({
    includeSibling: true,
    rootParentStyle: { boxShadow: "rgba(255, 255, 255, 0.12) 0px 4px 40px 0px" },
  });
  fixture.root.children.reverse();
  fixture.root.childNodes = fixture.root.children;
  assert.notEqual(fixture.root.children[0], fixture.target);
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);
  const { targetNode } = observeTarget(fixture);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, { x: 100, y: 100, width: 32, height: 32 });
  assert.deepEqual(certificate?.paintDomain, { x: 100, y: 100, width: 32, height: 32 });
  assert.equal(targetNode?.foreground, "occluded");
  assert.deepEqual(targetNode?.exposedRects, []);
});

test("local USE physical viewport does not require a root viewBox", () => {
  const rootRect = { x: 100, y: 100, width: 24, height: 24 };
  const fixture = buildLocalUsePublicFixture({
    rootRect,
    coverRect: rootRect,
    viewBox: null,
    targetRect: { x: 103, y: 103, width: 18, height: 18 },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.physicalViewport, rootRect);
  assert.deepEqual(certificate?.paintDomain, rootRect);
  assertPublicOcclusion(fixture);
});

test("local USE whole-root coverage proves occlusion from the conservative bound", () => {
  const fixture = buildLocalUsePublicFixture();
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.ok(certificate, "missing local USE certificate");
  assert.equal(certificate.rootElement, fixture.root);
  assert.deepEqual(certificate?.paintDomain, { x: 100, y: 100, width: 32, height: 32 });
  assertPublicOcclusion(fixture);
});

const LOCAL_USE_VIEWPORT_STRADDLE_CASES = [
  {
    edge: "bottom",
    rootRect: { x: 100, y: 892, width: 32, height: 16 },
    targetRect: { x: 108, y: 892, width: 16, height: 8 },
    fullCoverRect: { x: 100, y: 892, width: 32, height: 8 },
    partialCoverRect: { x: 100, y: 892, width: 32, height: 4 },
    partialTargetStrip: { x: 108, y: 896, width: 16, height: 4 },
  },
  {
    edge: "right",
    rootRect: { x: 1432, y: 100, width: 16, height: 32 },
    targetRect: { x: 1432, y: 108, width: 8, height: 16 },
    fullCoverRect: { x: 1432, y: 100, width: 8, height: 32 },
    partialCoverRect: { x: 1432, y: 100, width: 4, height: 32 },
    partialTargetStrip: { x: 1436, y: 108, width: 4, height: 16 },
  },
];

function setLocalUseBoundaryHits(fixture, coverRect) {
  fixture.document.elementsFromPoint = (x, y) => {
    if (x < 0 || x >= VIEWPORT.width || y < 0 || y >= VIEWPORT.height) return [];
    return inPublicRect({ x, y }, coverRect)
      ? [fixture.cover, fixture.root, fixture.html]
      : [fixture.root, fixture.html];
  };
}

function setLocalUsePartialTargetHits(fixture, coverRect, targetRect) {
  fixture.document.elementsFromPoint = (x, y) => {
    if (x < 0 || x >= VIEWPORT.width || y < 0 || y >= VIEWPORT.height) return [];
    if (inPublicRect({ x, y }, coverRect)) return [fixture.cover, fixture.root, fixture.html];
    return inPublicRect({ x, y }, targetRect)
      ? [fixture.target, fixture.root, fixture.html]
      : [fixture.root, fixture.html];
  };
}

for (const { edge, rootRect, targetRect, fullCoverRect, partialCoverRect, partialTargetStrip } of LOCAL_USE_VIEWPORT_STRADDLE_CASES) {
  test(`local USE ${edge} viewport straddle consumes the certified bound inside the observation viewport`, () => {
    const full = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: fullCoverRect });
    const fullCertificate = certifySvgAtomicViewport(full.target, full.window);
    setLocalUseBoundaryHits(full, fullCoverRect);
    assert.deepEqual(fullCertificate?.paintDomain, rootRect, `${edge} certificate`);
    assertPublicOcclusion(full);

    const partial = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: partialCoverRect });
    setLocalUseBoundaryHits(partial, partialCoverRect);
    const partialNode = observeTarget(partial).targetNode;
    assert.equal(partialNode.foreground, "unassessed", `${edge} partial cover`);
    assert.equal(partialNode.exposedRects, null, `${edge} partial cover exposure`);

    const external = buildLocalUsePublicFixture({
      rootRect,
      targetRect,
      coverRect: fullCoverRect,
      targetAttrs: { href: "external.svg#local-symbol" },
    });
    const externalCertificate = certifySvgAtomicViewport(external.target, external.window);
    assert.ok(externalCertificate, `${edge} external certificate missing`);
    assert.deepEqual(externalCertificate.paintDomain, rootRect, `${edge} external certificate`);
    setLocalUseBoundaryHits(external, fullCoverRect);
    assert.equal(observeTarget(external).targetNode.foreground, "occluded", `${edge} external USE`);
  });

  test(`local USE ${edge} viewport straddle keeps a real target-strip hit visible`, () => {
    const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: partialCoverRect });
    setLocalUsePartialTargetHits(fixture, partialCoverRect, targetRect);
    const { targetRef, targetNode, snapshot } = observeTarget(fixture);

    assert.equal(targetNode?.foreground, "visible", `${edge} partial target hit`);
    assert.deepEqual(targetNode?.exposedRects, [partialTargetStrip], `${edge} partial target strip`);
    assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef), `${edge} target node presence`);
    assert.deepEqual(targetNode?.clippedRect, targetRect, `${edge} target geometry`);
    const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
    assert.ok(candidates.candidateRefs.includes(targetRef), `${edge} target remains qualified`);
  });
}

for (const { width, height } of [
  { width: 16, height: 16 },
  { width: 8, height: 12 },
]) {
  test(`local USE ${width}x${height} center hole admits a fixed off-center target cross`, () => {
    const rootRect = { x: 100, y: 100, width: 32, height: 32 };
    const targetRect = {
      x: rootRect.x + (rootRect.width - width) / 2,
      y: rootRect.y + (rootRect.height - height) / 2,
      width,
      height,
    };
    const fixture = buildLocalUsePublicFixture({
      rootRect,
      targetRect,
      coverRect: rootRect,
      includeSibling: true,
    });
    const center = { x: targetRect.x + width / 2, y: targetRect.y + height / 2 };
    const cross = fixedPointCross(targetRect);
    const targetStack = [fixture.sibling, fixture.target, fixture.root, fixture.html];
    fixture.document.elementsFromPoint = centerHoleHits(fixture, center, cross, targetStack);

    const { registry, targetRef, targetNode, snapshot, probes } = observeTargetWithProbes(fixture);
    const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());

    assert.equal(targetNode?.foreground, "visible");
    assert.deepEqual(targetNode?.exposedRects, [targetRect]);
    assert.deepEqual(targetNode?.rect, targetRect);
    assert.deepEqual(targetNode?.clippedRect, targetRect);
    assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));
    assert.ok(candidates.slots.some(slot => slot.nodeRef === targetRef));
    assert.deepEqual(probes.map(probe => probe.point), [center, cross[0]]);
    assert.deepEqual(probes.map(probe => probe.exposed), [false, true]);
    assert.equal(registry.refByElement.get(fixture.target), targetRef);
  });
}

test("local USE center hole does not revive root-only additional points", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: rootRect, includeSibling: true });
  const center = { x: 116, y: 116 };
  const cross = fixedPointCross(targetRect);
  fixture.document.elementsFromPoint = centerHoleHits(fixture, center, cross, [fixture.root, fixture.html]);

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.deepEqual(probes.slice(0, 5).map(probe => probe.point), [center, ...cross]);
  assert.equal(probes.length, 17);
  assert.ok(probes.every(probe => probe.exposed === false));
});

test("local USE center hole rejects a target behind a lawful opaque owner", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: rootRect, includeSibling: true });
  const center = { x: 116, y: 116 };
  const cross = fixedPointCross(targetRect);
  fixture.document.elementsFromPoint = centerHoleHits(
    fixture,
    center,
    cross,
    [fixture.cover, fixture.target, fixture.root, fixture.html],
  );

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.equal(probes.length, 17);
  assert.ok(probes.every(probe => probe.exposed === false));
});

test("local USE successful center probe adds no geometric points", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect: rootRect, includeSibling: true });
  fixture.document.elementsFromPoint = () => [fixture.sibling, fixture.target, fixture.root, fixture.html];

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "visible");
  assert.deepEqual(targetNode?.exposedRects, [targetRect]);
  assert.deepEqual(probes.map(probe => probe.point), [{ x: 116, y: 116 }]);
});

test("outline-only interior preserves duplicate native hits and admits strict USE self witness", () => {
  const fixture = buildOutlineOnlyUsePublicFixture();
  const { targetNode, outlineInitial } = observeOutlineSurface(fixture);

  assert.ok(outlineInitial?.surface, "outline initial diagnostic missing");
  assert.deepEqual(outlineInitial.surface, {
    kind: "uncertain",
    proven: false,
    passThrough: false,
    relevant: true,
    clearInterior: { x: 518, y: 218, width: 124, height: 194 },
  });
  assert.equal(targetNode?.foreground, "visible");
  assert.deepEqual(targetNode?.exposedRects, [{ x: 640, y: 240, width: 16, height: 16 }]);
});

test("outline-only clear interior never substitutes ancestor or SVG-root hits", () => {
  const fixture = buildOutlineOnlyUsePublicFixture();
  const { targetNode, outlineInitial } = observeOutlineSurface(fixture, { includeTarget: false });

  assert.ok(outlineInitial?.surface?.clearInterior, "outline proof unexpectedly unavailable");
  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
});

test("outline-only interior refuses painted or missing pseudo facts", () => {
  const cases = [
    ["content", { content: "counter(item)" }],
    ["background", { backgroundColor: "rgba(20, 20, 24, 0.5)" }],
    ["border", { borderTopWidth: "1px", borderTopStyle: "solid" }],
    ["outline", { outlineStyle: "solid", outlineWidth: "1px" }],
    ["shadow", { boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 2px" }],
    ["missing", { backgroundColor: undefined }],
  ];
  for (const [name, pseudo] of cases) {
    const fixture = buildOutlineOnlyUsePublicFixture({ parentPseudoStyle: pseudo });
    const { outlineInitial } = observeOutlineSurface(fixture);
    assert.equal(outlineInitial?.surface?.clearInterior, null, name);
  }
});

test("outline-only interior refuses unsupported mapping and offset", () => {
  const cases = [
    ["zoom", { zoom: "2" }],
    ["offset", { outlineOffset: undefined }],
    ["offset-percent", { outlineOffset: "1%" }],
    ["transform", { transform: "matrix(1, 0.2, 0, 1, 0, 0)" }],
    ["radius", { borderTopRightRadius: "8px" }],
    ["radius-ellipse", { borderTopLeftRadius: "16px 8px" }],
  ];
  for (const [name, parentStyle] of cases) {
    const fixture = buildOutlineOnlyUsePublicFixture({ parentStyle });
    const { outlineInitial } = observeOutlineSurface(fixture);
    assert.equal(outlineInitial?.surface?.clearInterior, null, name);
  }
});

test("outline-only rounded guard excludes corner and inset boundaries", () => {
  const fixture = buildOutlineOnlyUsePublicFixture();
  const { outlineInitial } = observeOutlineSurface(fixture);
  const clear = outlineInitial?.surface?.clearInterior;
  assert.deepEqual(clear, { x: 518, y: 218, width: 124, height: 194 });
  const strictlyInside = point => point.x > clear.x && point.x < clear.x + clear.width
    && point.y > clear.y && point.y < clear.y + clear.height;
  assert.equal(strictlyInside({ x: 508, y: 208 }), false, "rounded corner");
  assert.equal(strictlyInside({ x: 518, y: 250 }), false, "inset boundary");
  assert.equal(strictlyInside({ x: 530, y: 250 }), true, "strict interior");
});

test("outline-only proof cannot create negative occlusion", () => {
  const fixture = buildOutlineOnlyUsePublicFixture();
  const { targetNode } = observeOutlineSurface(fixture, { includeTarget: false });

  assert.notEqual(targetNode?.foreground, "occluded");
  assert.equal(targetNode?.exposedRects, null);
});

test("local USE sparse perimeter recovers a target after legacy probes miss", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { x: 100, y: 100, width: 8, height: 32 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect, includeSibling: true });
  const witness = {
    x: targetRect.x + targetRect.width * 0.1,
    y: targetRect.y + targetRect.height * 0.3,
  };
  fixture.document.elementsFromPoint = (x, y) => {
    if (inPublicRect({ x, y }, coverRect)) return [fixture.cover, fixture.root, fixture.html];
    if (samePoint({ x, y }, witness)) return [fixture.target, fixture.root, fixture.html];
    return [fixture.root, fixture.html];
  };

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "visible");
  assert.deepEqual(targetNode?.exposedRects, [targetRect]);
  assert.ok(probes.slice(0, 5).every(probe => !probe.exposed));
  assert.ok(probes.some(probe => samePoint(probe.point, witness) && probe.exposed));
});

test("local USE sparse perimeter also applies when the atomic certificate is unavailable", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { ...targetRect };
  const fixture = buildLocalUsePublicFixture({
    rootRect,
    targetRect,
    coverRect,
    includeSibling: true,
    rootStyle: { overflowX: "visible", overflowY: "visible" },
  });
  const witness = {
    x: targetRect.x + targetRect.width * 0.1,
    y: targetRect.y + targetRect.height * 0.3,
  };
  fixture.document.elementsFromPoint = (x, y) => {
    if (samePoint({ x, y }, witness)) return [fixture.target, fixture.root, fixture.html];
    // The opaque HTML underlay owns empty points. At the painted perimeter
    // the target itself is before that underlay in the native stack.
    if (inPublicRect({ x, y }, coverRect)) return [fixture.cover, fixture.root, fixture.html];
    return [fixture.root, fixture.html];
  };

  assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null);
  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "visible");
  assert.deepEqual(targetNode?.exposedRects, [targetRect]);
  assert.ok(probes.some(probe => samePoint(probe.point, witness) && probe.exposed));
});

test("local USE perimeter stays unassessed for root-only hits and queries each point once", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { x: 100, y: 100, width: 8, height: 32 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect, includeSibling: true });
  const perimeter = fixedPointPerimeter(targetRect);
  const rawPerimeterQueries = [];
  fixture.document.elementsFromPoint = (x, y) => {
    if (perimeter.some(point => samePoint({ x, y }, point))) rawPerimeterQueries.push({ x, y });
    if (inPublicRect({ x, y }, coverRect)) return [fixture.cover, fixture.root, fixture.html];
    return [fixture.root, fixture.html];
  };

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.equal(probes.length, 17);
  assert.ok(perimeter.every(point => probes.some(probe => samePoint(probe.point, point))));
  assert.ok(rawPerimeterQueries.length <= 32);
  assert.ok(perimeter.every(point => rawPerimeterQueries.filter(query => samePoint(query, point)).length === 1));
});

test("local USE perimeter rejects an opaque owner before the target", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { x: 100, y: 100, width: 8, height: 32 };
  const behind = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect, includeSibling: true });
  const behindPerimeter = fixedPointPerimeter(targetRect);
  behind.document.elementsFromPoint = (x, y) => {
    if (behindPerimeter.some(point => samePoint({ x, y }, point))) {
      return [behind.cover, behind.target, behind.root, behind.html];
    }
    if (inPublicRect({ x, y }, coverRect)) return [behind.cover, behind.root, behind.html];
    return [behind.root, behind.html];
  };
  const behindNode = observeTargetWithProbes(behind).targetNode;
  assert.equal(behindNode?.foreground, "unassessed");
  assert.equal(behindNode?.exposedRects, null);

  const front = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect, includeSibling: true });
  const witness = {
    x: targetRect.x + targetRect.width * 0.1,
    y: targetRect.y + targetRect.height * 0.1,
  };
  front.document.elementsFromPoint = (x, y) => {
    if (samePoint({ x, y }, witness)) return [front.target, front.cover, front.root, front.html];
    if (inPublicRect({ x, y }, coverRect)) return [front.cover, front.target, front.root, front.html];
    return [front.root, front.html];
  };
  const frontNode = observeTargetWithProbes(front).targetNode;
  assert.equal(frontNode?.foreground, "visible");
  assert.deepEqual(frontNode?.exposedRects, [targetRect]);
});

test("local USE perimeter stops after an unavailable native point", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { x: 100, y: 100, width: 8, height: 32 };
  const fixture = buildLocalUsePublicFixture({ rootRect, targetRect, coverRect, includeSibling: true });
  const firstPerimeter = fixedPointPerimeter(targetRect)[0];
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.root, fixture.html];
    if (samePoint({ x, y }, firstPerimeter)) return null;
    if (inPublicRect({ x, y }, coverRect)) return [fixture.cover, fixture.root, fixture.html];
    return [fixture.root, fixture.html];
  };

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.equal(probes.length, 6);
  assert.deepEqual(probes.at(-1).point, firstPerimeter);
});

test("local USE perimeter skips unknown clipped geometry", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const coverRect = { x: 100, y: 100, width: 8, height: 32 };
  const fixture = buildLocalUsePublicFixture({
    rootRect,
    targetRect,
    coverRect,
    includeSibling: true,
    targetStyle: { transform: "rotate(20deg)" },
  });
  fixture.document.elementsFromPoint = () => [fixture.root, fixture.html];

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.equal(probes.length, 0);
});

test("local USE preserves every legacy center and cross query before perimeter probes", () => {
  const rootRect = { x: 100, y: 100, width: 60, height: 32 };
  const targetRect = rootRect;
  const coverRect = { x: 200, y: 200, width: 1, height: 1 };
  const extraCoverRects = Array.from({ length: 25 }, (_, index) => ({
    x: 101 + index * 2,
    y: 100,
    width: 1,
    height: 32,
  }));
  const fixture = buildLocalUsePublicFixture({
    rootRect,
    targetRect,
    coverRect,
    includeSibling: false,
    extraCoverRects,
  });
  const lastRegionWitness = { x: 155, y: 116 };
  fixture.document.elementsFromPoint = (x, y) => {
    if (extraCoverRects.some(rect => inPublicRect({ x, y }, rect))) {
      return [fixture.extraCovers.find(cover => inPublicRect({ x, y }, cover.getBoundingClientRect())), fixture.target, fixture.root, fixture.html];
    }
    if (samePoint({ x, y }, lastRegionWitness)) return [fixture.target, fixture.root, fixture.html];
    return [fixture.root, fixture.html];
  };

  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "visible");
  assert.deepEqual(targetNode?.exposedRects, [{ x: 150, y: 100, width: 10, height: 32 }]);
  assert.ok(probes.length > 25);
  assert.ok(probes.some(probe => samePoint(probe.point, lastRegionWitness) && probe.exposed));
});

test("local USE uncertified paint domain still uses the fixed perimeter", () => {
  const rootRect = { x: 100, y: 100, width: 32, height: 32 };
  const targetRect = { x: 108, y: 108, width: 16, height: 16 };
  const fixture = buildLocalUsePublicFixture({
    rootRect,
    targetRect,
    coverRect: rootRect,
    includeSibling: true,
    rootStyle: { overflowX: "visible", overflowY: "visible" },
    targetAttrs: { href: "external.svg#local-symbol" },
  });
  const center = { x: 116, y: 116 };
  const cross = fixedPointCross(targetRect);
  fixture.document.elementsFromPoint = (x, y) => {
    if (samePoint({ x, y }, center)) return [fixture.cover, fixture.root, fixture.html];
    if (cross.some(point => samePoint({ x, y }, point))) {
      // The sibling does not cover every cross point. Use the actual full
      // opaque cover so this stack represents the claimed occlusion.
      return [fixture.cover, fixture.target, fixture.root, fixture.html];
    }
    return [fixture.root, fixture.html];
  };

  assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null);
  const { targetNode, probes } = observeTargetWithProbes(fixture);

  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
  assert.equal(probes.length, 17);
  assert.deepEqual(probes[0].point, center);
});

test("local USE outer-ancestor shadow does not widen the child paint domain", () => {
  const fixture = buildLocalUsePublicFixture({
    rootParentStyle: { boxShadow: "rgba(255, 255, 255, 0.12) 0px 4px 40px 0px" },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.paintDomain, { x: 100, y: 100, width: 32, height: 32 });
  assertPublicOcclusion(fixture);
});

test("local USE outer-ancestor outline and positive translation keep the root bound", () => {
  const fixture = buildLocalUsePublicFixture({
    rootParentStyle: {
      outlineStyle: "solid",
      transform: "matrix(1, 0, 0, 1, 12, 8)",
    },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.equal(certificate?.rootElement, fixture.root);
  assert.deepEqual(certificate?.paintDomain, { x: 100, y: 100, width: 32, height: 32 });
  assertPublicOcclusion(fixture);
});

test("local USE BCR-only coverage does not eliminate the full hidden-root bound", () => {
  const fixture = buildLocalUsePublicFixture({
    targetStyle: { stroke: "rgb(10, 10, 10)", strokeWidth: "8px" },
    coverRect: { x: 108, y: 108, width: 16, height: 16 },
  });

  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});

test("local USE visible overflow cannot prove BCR-only full occlusion", () => {
  const fixture = buildLocalUsePublicFixture({
    rootStyle: { overflowX: "visible", overflowY: "visible" },
    targetStyle: { stroke: "rgb(10, 10, 10)", strokeWidth: "8px" },
    coverRect: { x: 108, y: 108, width: 16, height: 16 },
  });
  assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null);
  fixture.document.elementsFromPoint = (x, y) => x >= 108 && x < 124 && y >= 108 && y < 124
    ? [fixture.cover, fixture.target, fixture.root, fixture.html]
    : [fixture.root, fixture.html];

  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});

test("local USE external resource BCR-only cover stays unassessed under the hidden root bound", () => {
  const fixture = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
    coverRect: { x: 108, y: 108, width: 16, height: 16 },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);
  assert.ok(certificate, "missing external USE certificate");
  assert.deepEqual(certificate.paintDomain, { x: 100, y: 100, width: 32, height: 32 });
  fixture.document.elementsFromPoint = (x, y) => x >= 108 && x < 124 && y >= 108 && y < 124
    ? [fixture.cover, fixture.target, fixture.root, fixture.html]
    : [fixture.root, fixture.html];

  const targetNode = observeTarget(fixture).targetNode;
  assert.equal(targetNode.foreground, "unassessed");
  assert.equal(targetNode.exposedRects, null);
});

test("local USE partial bound is not published as target exposure", () => {
  const fixture = buildLocalUsePublicFixture({
    targetRect: { x: 104, y: 108, width: 8, height: 16 },
    coverRect: { x: 100, y: 100, width: 16, height: 32 },
  });

  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});

test("local USE atomic order preserves a target or root ahead of the blocker", () => {
  const targetFirst = buildLocalUsePublicFixture();
  targetFirst.document.elementsFromPoint = () => [
    targetFirst.target,
    targetFirst.cover,
    targetFirst.root,
    targetFirst.html,
  ];
  assert.equal(observeTarget(targetFirst).targetNode.foreground, "visible");

  const rootFirst = buildLocalUsePublicFixture();
  rootFirst.document.elementsFromPoint = () => [rootFirst.root, rootFirst.cover, rootFirst.html];
  assert.notEqual(observeTarget(rootFirst).targetNode.foreground, "occluded");
});

test("local USE pointer-none blocker keeps lawful paint order", () => {
  const fixture = buildLocalUsePublicFixture();
  fixture.document.elementsFromPoint = () => [fixture.root, fixture.html];
  fixture.window.getComputedStyle = ((base) => element => {
    const style = base(element);
    return element === fixture.cover ? { ...style, pointerEvents: "none" } : style;
  })(fixture.window.getComputedStyle);

  assertPublicOcclusion(fixture);
});

test("local USE pointer-none BCR-only coverage does not eliminate the full bound", () => {
  const fixture = buildLocalUsePublicFixture({
    coverRect: { x: 108, y: 108, width: 16, height: 16 },
  });
  fixture.document.elementsFromPoint = () => [fixture.root, fixture.html];
  fixture.window.getComputedStyle = ((base) => element => {
    const style = base(element);
    return element === fixture.cover ? { ...style, pointerEvents: "none" } : style;
  })(fixture.window.getComputedStyle);

  assert.equal(observeTarget(fixture).targetNode.foreground, "unassessed");
});

test("local USE certificate rejects unsupported content and root facts", () => {
  const cases = [
    ["visible root overflow", { rootStyle: { overflowX: "visible" } }],
    ["mixed root overflow", { rootStyle: { overflowY: "visible" } }],
    ["root filter", { rootStyle: { filter: "blur(1px)" } }],
    ["root mask", { rootStyle: { maskImage: 'url("mask")' } }],
    ["root clip path", { rootStyle: { clipPath: 'url("#atomic-clip")' } }],
    ["root containment", { rootStyle: { contain: "paint" } }],
    ["root shadow", { rootStyle: { boxShadow: "0 0 2px black" } }],
    ["root outline", { rootStyle: { outlineStyle: "solid" } }],
    ["outer filter", { rootParentStyle: { filter: "blur(1px)" } }],
    ["outer mask", { rootParentStyle: { maskImage: 'url("mask")' } }],
    ["outer clip path", { rootParentStyle: { clipPath: 'url("#atomic-clip")' } }],
    ["outer backdrop filter", { rootParentStyle: { backdropFilter: "blur(1px)" } }],
    ["missing root bounds", { rootRect: { x: undefined, y: 100, width: 24, height: 24 } }],
    ["invalid root bounds", { rootRect: { x: 100, y: 100, width: Infinity, height: 24 } }],
    ["root border", { rootStyle: { borderTopWidth: "1px" } }],
    ["root padding", { rootStyle: { paddingTop: "1px" } }],
    ["nonpositive root bounds", { rootRect: { x: 100, y: 100, width: 0, height: 24 } }],
    ["missing root transform", { rootStyle: { transform: undefined } }],
    ["unsupported root transform", { rootStyle: { transform: "rotate(20deg)" } }],
    ["reflected root", { rootStyle: { transform: "matrix(-1, 0, 0, 1, 0, 0)" } }],
    ["multiple root fragments", {
      rootClientRects: [
        { x: 100, y: 100, width: 32, height: 32 },
        { x: 132, y: 100, width: 32, height: 32 },
      ],
    }],
    ["missing symbol", { localUseSymbol: null, targetAttrs: { href: "#missing" } }],
    ["duplicate symbol id", {
      duplicateLocalUseSymbol: {
        id: "local-symbol",
        children: [{ tag: "path", attrs: { d: "M0 0H1V1H0Z" } }],
      },
    }],
    ["recursive USE", {
      localUseSymbol: {
        id: "local-symbol",
        children: [{ tag: "use", attrs: { href: "#local-symbol" } }],
      },
    }],
    ["foreignObject content", {
      localUseSymbol: {
        id: "local-symbol",
        children: [{
          tag: "foreignObject",
          children: [{ tag: "div", namespace: XHTML_NAMESPACE }],
        }],
      },
    }],
    ["unknown USE child", { targetChildren: 1 }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildLocalUsePublicFixture(options);
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }

  const topLayer = buildLocalUsePublicFixture();
  topLayer.target.matches = selector => selector === ":fullscreen";
  assert.equal(certifySvgAtomicViewport(topLayer.target, topLayer.window), null);
});

test("external USE occlusion is proven from the hidden outer SVG bound and lawful root order", () => {
  const fixture = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
  });
  const certificate = certifySvgAtomicViewport(fixture.target, fixture.window);

  assert.ok(certificate, "missing external USE certificate");
  assert.equal(certificate.rootElement, fixture.root);
  assert.deepEqual(certificate.physicalViewport, { x: 100, y: 100, width: 32, height: 32 });
  assert.deepEqual(certificate.paintDomain, { x: 100, y: 100, width: 32, height: 32 });

  const { registry, targetRef, targetNode, snapshot } = observeTarget(fixture);
  assert.equal(targetNode?.foreground, "occluded");
  assert.deepEqual(targetNode?.exposedRects, []);
  assert.deepEqual(targetNode?.rect, { x: 108, y: 108, width: 16, height: 16 });

  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  const slot = candidates.slots.find(candidate => candidate.nodeRef === targetRef);
  assert.equal(slot.status, "filtered_out");
  assert.deepEqual(slot.reasons, ["occluded"]);
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));

  const symbolRef = stableNodeRefFor(registry, fixture.symbol);
  const symbolPathRef = stableNodeRefFor(registry, fixture.symbol.children[0]);
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === symbolRef));
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === symbolPathRef));
  assert.ok(candidates.slots.some(candidate => candidate.nodeRef === symbolPathRef));
});

test("external USE root-only positive partial cover stays unknown", () => {
  const coverRect = { x: 100, y: 100, width: 16, height: 32 };
  const fixture = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
    coverRect,
  });
  fixture.document.elementsFromPoint = (x, y) => {
    if (x < 0 || x >= VIEWPORT.width || y < 0 || y >= VIEWPORT.height) return [];
    return inPublicRect({ x, y }, coverRect)
      ? [fixture.cover, fixture.root, fixture.html]
      : [fixture.root, fixture.html];
  };
  assert.ok(certifySvgAtomicViewport(fixture.target, fixture.window), "missing external USE certificate");

  const { targetNode } = observeTarget(fixture);
  assert.equal(targetNode?.foreground, "unassessed");
  assert.equal(targetNode?.exposedRects, null);
});

test("external USE atomic order rejects a target or root ahead of the blocker", () => {
  const targetFirst = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
  });
  targetFirst.document.elementsFromPoint = () => [
    targetFirst.target,
    targetFirst.cover,
    targetFirst.root,
    targetFirst.html,
  ];
  assert.equal(observeTarget(targetFirst).targetNode.foreground, "visible");

  const rootFirst = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
  });
  rootFirst.document.elementsFromPoint = () => [rootFirst.root, rootFirst.cover, rootFirst.html];
  assert.notEqual(observeTarget(rootFirst).targetNode.foreground, "occluded");
});

test("external USE certificate keeps unsupported outer facts rejected", () => {
  const cases = [
    ["visible root overflow", { rootStyle: { overflowX: "visible" } }],
    ["mixed root overflow", { rootStyle: { overflowY: "visible" } }],
    ["root filter", { rootStyle: { filter: "blur(1px)" } }],
    ["root backdrop filter", { rootStyle: { backdropFilter: "blur(1px)" } }],
    ["root mask", { rootStyle: { maskImage: 'url("mask")' } }],
    ["root 3D transform", { rootStyle: { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" } }],
    ["outer filter", { rootParentStyle: { filter: "blur(1px)" } }],
    ["outer backdrop filter", { rootParentStyle: { backdropFilter: "blur(1px)" } }],
    ["outer mask", { rootParentStyle: { maskImage: 'url("mask")' } }],
    ["fixed position", { targetStyle: { position: "fixed" } }],
    ["sticky position", { targetStyle: { position: "sticky" } }],
  ];
  for (const [name, options] of cases) {
    const fixture = buildLocalUsePublicFixture({
      ...options,
      targetAttrs: { href: "external.svg#local-symbol" },
    });
    assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null, name);
  }

  const topLayer = buildLocalUsePublicFixture({
    targetAttrs: { href: "external.svg#local-symbol" },
  });
  topLayer.target.matches = selector => selector === ":fullscreen";
  assert.equal(certifySvgAtomicViewport(topLayer.target, topLayer.window), null);
});

test("local USE occlusion preserves raw USE, symbol, descendant, and candidate slots", () => {
  const fixture = buildLocalUsePublicFixture();
  const { registry, targetRef, snapshot } = observeTarget(fixture);
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  const symbolRef = stableNodeRefFor(registry, fixture.symbol);
  const symbolPathRef = stableNodeRefFor(registry, fixture.symbol.children[0]);

  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === symbolRef));
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === symbolPathRef));
  assert.ok(candidates.slots.some(slot => slot.nodeRef === targetRef));
  assert.ok(candidates.slots.some(slot => slot.nodeRef === symbolPathRef));
});

// A filled leaf PATH inside a rotated outermost SVG keeps the atomic
// positive-axis certificate unavailable. The bounded negative seed may still
// recover actual target order from the fixed 5x5 lattice when the shape-hole
// center misses the target.
const ROTATED_LEAF_PATH_D = "M8 8 C10 8 22 8 24 8 C24 10 24 22 24 24 C22 24 10 24 8 24 C8 22 8 10 8 8 Z";
const ROTATED_LEAF_PATH_RECT = { x: 104, y: 104, width: 16, height: 16 };

function buildRotatedLeafPathPublicFixture(options = {}) {
  return buildAtomicSvgPublicFixture({
    rootRect: { x: 100, y: 100, width: 32, height: 32 },
    viewBox: "0 0 32 32",
    targetRect: ROTATED_LEAF_PATH_RECT,
    includeSibling: false,
    rootStyle: { transform: "matrix(0.9396926, 0.3420201, -0.3420201, 0.9396926, 0, 0)" },
    targetAttrs: { d: ROTATED_LEAF_PATH_D },
    targetStyle: { d: `path("${ROTATED_LEAF_PATH_D}")`, textShadow: "none" },
    ...options,
  });
}

function pathNativeStack(fixture, x, y, holeCenter = null, holeHalf = 2) {
  const inRect = rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const targetRect = fixture.target.getBoundingClientRect();
  const center = holeCenter ?? { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };
  const inHole = Math.abs(x - center.x) < holeHalf && Math.abs(y - center.y) < holeHalf;
  const coverHere = inRect(fixture.cover.getBoundingClientRect());
  const targetHere = inRect(targetRect) && !inHole;
  const { target, cover, root, html } = fixture;
  if (coverHere && targetHere) return [cover, target, root, html];
  if (coverHere) return [cover, root, html];
  if (targetHere) return [target, root, html];
  return [root, html];
}

function latticePoints(rect) {
  const points = [];
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      points.push({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
    }
  }
  return points;
}

test("rotated filled leaf PATH center hole recovers off-center target order", () => {
  const fixture = buildRotatedLeafPathPublicFixture();
  assert.equal(certifySvgAtomicViewport(fixture.target, fixture.window), null);
  const queries = [];
  fixture.document.elementsFromPoint = (x, y) => {
    queries.push([x, y]);
    if (x === 0 && y === 0) return [fixture.html];
    return pathNativeStack(fixture, x, y);
  };
  const { registry, targetRef, targetNode, snapshot } = observeTarget(fixture);
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());

  assert.equal(targetNode?.foreground, "occluded", `foreground=${targetNode?.foreground}`);
  assert.deepEqual(targetNode?.exposedRects, []);
  assert.deepEqual(targetNode?.rect, ROTATED_LEAF_PATH_RECT);
  assert.deepEqual(targetNode?.clippedRect, ROTATED_LEAF_PATH_RECT);
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === targetRef));
  const slot = candidates.slots.find(candidate => candidate.nodeRef === targetRef);
  assert.equal(slot.status, "filtered_out");
  assert.deepEqual(slot.reasons, ["occluded"]);

  // Center result is reused; the added search is exactly the 24 other points.
  const center = { x: ROTATED_LEAF_PATH_RECT.x + ROTATED_LEAF_PATH_RECT.width / 2,
    y: ROTATED_LEAF_PATH_RECT.y + ROTATED_LEAF_PATH_RECT.height / 2 };
  const added = latticePoints(ROTATED_LEAF_PATH_RECT).filter(point => !samePoint(point, center));
  assert.equal(added.length, 24);
  for (const point of added) {
    const count = queries.filter(([x, y]) => x === point.x && y === point.y).length;
    assert.equal(count, 1, `lattice ${point.x},${point.y} queries=${count}`);
  }
});

test("rotated filled leaf PATH target-absent samples supply no bounded witness", () => {
  const fixture = buildRotatedLeafPathPublicFixture();
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.html];
    const cover = fixture.cover.getBoundingClientRect();
    const inCover = x >= cover.x && x < cover.x + cover.width && y >= cover.y && y < cover.y + cover.height;
    return inCover ? [fixture.cover, fixture.root, fixture.html] : [fixture.root, fixture.html];
  };
  const { targetNode } = observeTarget(fixture);

  assert.equal(targetNode?.foreground, "unassessed", `foreground=${targetNode?.foreground}`);
  assert.equal(targetNode?.exposedRects, null);
});

test("rotated filled leaf PATH reverse order at any sample rejects the seed", () => {
  const fixture = buildRotatedLeafPathPublicFixture();
  const reversePoint = { x: ROTATED_LEAF_PATH_RECT.x + ROTATED_LEAF_PATH_RECT.width * 0.3,
    y: ROTATED_LEAF_PATH_RECT.y + ROTATED_LEAF_PATH_RECT.height * 0.3 };
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.html];
    if (samePoint({ x, y }, reversePoint)) {
      return [fixture.target, fixture.cover, fixture.root, fixture.html];
    }
    return pathNativeStack(fixture, x, y);
  };
  const { targetNode } = observeTarget(fixture);

  assert.notEqual(targetNode?.foreground, "occluded", `foreground=${targetNode?.foreground}`);
  assert.equal(targetNode?.exposedRects, null);
});

test("rotated filled leaf PATH recovered seed still requires the corner probes", () => {
  const fixture = buildRotatedLeafPathPublicFixture();
  const failingCorner = { x: ROTATED_LEAF_PATH_RECT.x + 1, y: ROTATED_LEAF_PATH_RECT.y + 1 };
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.html];
    if (samePoint({ x, y }, failingCorner)) return [fixture.target, fixture.root, fixture.html];
    return pathNativeStack(fixture, x, y);
  };
  const { targetNode } = observeTarget(fixture);

  assert.equal(targetNode?.foreground, "unassessed", `foreground=${targetNode?.foreground}`);
  assert.equal(targetNode?.exposedRects, null);
});

test("rotated filled leaf PATH partial cover keeps the uncovered region exposed", () => {
  const coverRect = { x: 104, y: 104, width: 8, height: 16 };
  const fixture = buildRotatedLeafPathPublicFixture({ coverRect });
  fixture.document.elementsFromPoint = (x, y) => {
    if (x === 0 && y === 0) return [fixture.html];
    return pathNativeStack(fixture, x, y);
  };
  const { targetNode } = observeTarget(fixture);

  assert.equal(targetNode?.foreground, "visible", `foreground=${targetNode?.foreground}`);
  assert.deepEqual(targetNode?.exposedRects, [{ x: 112, y: 104, width: 8, height: 16 }]);
});

test("rotated PATH without the contained-fill facts stays outside the bounded seed", () => {
  const cases = [
    ["stroke", buildStrokedPathPublicFixture({
      rootRect: { x: 100, y: 100, width: 32, height: 32 },
      viewBox: "0 0 32 32",
      targetRect: ROTATED_LEAF_PATH_RECT,
      includeSibling: false,
      rootStyle: { transform: "matrix(0.9396926, 0.3420201, -0.3420201, 0.9396926, 0, 0)" },
    })],
    ["marker", buildRotatedLeafPathPublicFixture({ targetStyle: { markerEnd: 'url("#marker")' } })],
    ["filter", buildRotatedLeafPathPublicFixture({ targetStyle: { filter: "blur(1px)" } })],
    ["non-leaf", buildRotatedLeafPathPublicFixture({ targetChildren: 1 })],
    ["unsupported path", buildRotatedLeafPathPublicFixture({
      targetAttrs: { d: "M4 4H20V20H4Z" },
      targetStyle: { d: 'path("M4 4H20V20H4Z")', textShadow: "none" },
    })],
    ["missing computed path", buildRotatedLeafPathPublicFixture({
      targetStyle: { textShadow: "none" },
    })],
  ];
  for (const [name, fixture] of cases) {
    fixture.document.elementsFromPoint = (x, y) => {
      if (x === 0 && y === 0) return [fixture.html];
      return pathNativeStack(fixture, x, y);
    };
    const { targetNode } = observeTarget(fixture);
    assert.notEqual(targetNode?.foreground, "occluded", `${name} foreground=${targetNode?.foreground}`);
  }
});
