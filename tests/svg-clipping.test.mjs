import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";
import {
  certifyAxisReflectedSvgViewport,
  certifyContainedSvgOverflow,
} from "../dist/adapters/browser/svg-clipping.js";

const BASE_STYLE = {
  display: "block",
  visibility: "visible",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  contain: "none",
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
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  content: "none",
};

// The fixture mirrors the observed Weibo verified-badge chain: a 16x16 outer
// svg wrapping a nested svg with native 100x100 dimensions, a clipped <g>, and
// a single rectangular clipPath resource.
function buildSvgFixture({
  outerViewBox = "0 0 100 100",
  nestedViewBox = "0 0 100 100",
  nestedX = null,
  outerTransform = "none",
  nestedTransform = "none",
  clipPathUnits = null,
  clipPathPathD = "M0 0h100v100H0z",
  clipPathRect = null,
  duplicates = false,
  duplicatePathD = "M0 0h50v50H0z",
  duplicateRect = null,
  includeClipPath = true,
  gClipPath = true,
  gTransform = "none",
  missingNestedTransform = false,
  outerStyle = {},
} = {}) {
  const document = { documentElement: null, body: null, baseURI: "https://fixture.test/svg" };
  const styleOverrides = new Map();
  const missingTransform = new WeakSet();
  const allElements = [];
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle(element, pseudo) {
      if (pseudo) return { ...BASE_STYLE, content: "none" };
      const style = { ...BASE_STYLE, ...(styleOverrides.get(element) ?? {}) };
      if (missingTransform.has(element)) delete style.transform;
      return style;
    },
  };

  const make = (tag, { parent = null, rect = { x: 0, y: 0, width: 0, height: 0 }, attrs = {}, client = null, native = null } = {}) => {
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      parentElement: parent,
      children: [],
      childNodes: [],
      childElementCount: 0,
      id: attrs.id ?? "",
      classList: [],
      ownerDocument: document,
      shadowRoot: null,
      isConnected: true,
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
      querySelectorAll() {
        return [];
      },
    };
    element.clientWidth = client?.width ?? 0;
    element.clientHeight = client?.height ?? 0;
    element.clientLeft = client?.left ?? 0;
    element.clientTop = client?.top ?? 0;
    if (native) {
      element.x = { baseVal: { value: native.x ?? 0 } };
      element.y = { baseVal: { value: native.y ?? 0 } };
      element.width = { baseVal: { value: native.width } };
      element.height = { baseVal: { value: native.height } };
    }
    allElements.push(element);
    return element;
  };

  const attach = (parent, children) => {
    parent.children = children;
    parent.childNodes = children;
    parent.childElementCount = children.length;
    for (const child of children) child.parentElement = parent;
  };

  const html = make("html", {
    rect: { x: 0, y: 0, width: 800, height: 600 },
    client: { left: 0, top: 0, width: 800, height: 600 },
  });
  html.namespaceURI = XHTML_NAMESPACE;
  html.scrollLeft = 0;
  html.scrollTop = 0;
  const outer = make("svg", {
    parent: html,
    rect: { x: 288.5, y: 389, width: 16, height: 16 },
    client: { width: 16, height: 16 },
    attrs: outerViewBox === null ? {} : { viewBox: outerViewBox },
  });
  const nested = make("svg", {
    parent: outer,
    rect: { x: 288.5, y: 389, width: 16, height: 16 },
    client: { width: 0, height: 0 },
    attrs: {
      ...(nestedViewBox === null ? {} : { viewBox: nestedViewBox }),
      ...(nestedX === null ? {} : { x: nestedX }),
    },
    native: { width: 100, height: 100, x: 0, y: 0 },
  });
  const g = make("g", {
    parent: nested,
    rect: { x: 288.5, y: 389, width: 16, height: 16 },
    attrs: gClipPath ? { "clip-path": 'url("#a")' } : {},
  });
  const shape = make("path", {
    parent: g,
    rect: { x: 288.5, y: 389, width: 16, height: 16 },
    attrs: { d: "M0 0h100v100H0z" },
  });

  const makeClipPath = (id, childTag, childAttrs) => {
    const clipPath = make("clipPath", {
      parent: nested,
      attrs: { id, ...(clipPathUnits === null ? {} : { clipPathUnits }) },
    });
    const child = make(childTag, { parent: clipPath, attrs: childAttrs });
    attach(clipPath, [child]);
    return clipPath;
  };

  const clipPaths = [];
  if (includeClipPath) {
    clipPaths.push(clipPathRect === null
      ? makeClipPath("a", "path", { d: clipPathPathD })
      : makeClipPath("a", "rect", clipPathRect));
  }
  if (duplicates) {
    clipPaths.push(duplicateRect === null
      ? makeClipPath("a", "path", { d: duplicatePathD })
      : makeClipPath("a", "rect", duplicateRect));
  }

  attach(html, [outer]);
  attach(outer, [nested]);
  attach(nested, [g, ...clipPaths]);
  attach(g, [shape]);

  document.documentElement = html;
  document.body = html;
  document.compatMode = "CSS1Compat";
  document.scrollingElement = html;
  document.querySelectorAll = (selector) => {
    if (String(selector).toLowerCase() === "clippath") {
      return allElements.filter(element => element.tagName.toLowerCase() === "clippath");
    }
    return [];
  };

  styleOverrides.set(html, {
    overflowX: "auto",
    overflowY: "auto",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    zoom: "1",
    borderTopWidth: "0px",
    borderLeftWidth: "0px",
    paddingTop: "0px",
    paddingLeft: "0px",
  });
  styleOverrides.set(outer, { ...outerStyle, overflowX: "hidden", overflowY: "hidden", transform: outerTransform });
  styleOverrides.set(nested, { overflowX: "hidden", overflowY: "hidden", transform: nestedTransform });
  styleOverrides.set(g, { ...(gClipPath ? { clipPath: 'url("#a")' } : {}), transform: gTransform });
  if (missingNestedTransform) missingTransform.add(nested);

  return { document, window, html, outer, nested, g, shape, clipPaths };
}

const CONTAINED_PATH_ATTR = "M12 4C8 4 4 8 4 12C4 16 8 20 12 20C16 20 20 16 20 12C20 8 16 4 12 4ZM8 8C8 8 16 8 16 12C16 16 8 16 8 12Z";
const CONTAINED_PATH_CSS = 'path("M 12 4 C 8 4 4 8 4 12 C 4 16 8 20 12 20 C 16 20 20 16 20 12 C 20 8 16 4 12 4 Z M 8 8 C 8 8 16 8 16 12 C 16 16 8 16 8 12 Z")';

// Synthetic outer-svg/direct-path fixture. The attributes stay 24x24 while
// the computed physical viewport is 24x5.32812, matching the observed shape of
// the unsupported root rotation without embedding site data.
function buildContainedSvgFixture({
  attrD = CONTAINED_PATH_ATTR,
  computedD = null,
  rootStyle = {},
  pathStyle = {},
  parentStyle = {},
  preserveAspectRatio = null,
  extraChild = false,
  wrapInGroup = false,
  ancestorSvg = false,
  pathChildren = 0,
  missingComputedD = false,
} = {}) {
  const document = { documentElement: null, body: null, baseURI: "https://fixture.test/contained-svg" };
  const styleOverrides = new Map();
  const computedDByElement = new Map();
  const allElements = [];
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle(element, pseudo) {
      const base = { ...BASE_STYLE, ...(styleOverrides.get(element) ?? {}) };
      if (pseudo) return base;
      if (computedDByElement.has(element)) base.d = computedDByElement.get(element);
      base.getPropertyValue = property => {
        const key = String(property).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return base[key] === undefined || base[key] === null ? "" : String(base[key]);
      };
      return base;
    },
  };
  const make = (tag, { parent = null, rect = { x: 0, y: 0, width: 0, height: 0 }, attrs = {}, client = null } = {}) => {
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      namespaceURI: tag === "html" ? "http://www.w3.org/1999/xhtml" : "http://www.w3.org/2000/svg",
      parentElement: parent,
      children: [],
      childNodes: [],
      childElementCount: 0,
      id: attrs.id ?? "",
      classList: [],
      ownerDocument: document,
      shadowRoot: null,
      isConnected: true,
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
      querySelectorAll() {
        return [];
      },
    };
    element.clientWidth = client?.width ?? 0;
    element.clientHeight = client?.height ?? 0;
    element.clientLeft = client?.left ?? 0;
    element.clientTop = client?.top ?? 0;
    allElements.push(element);
    return element;
  };
  const attach = (parent, children) => {
    parent.children = children;
    parent.childNodes = children;
    parent.childElementCount = children.length;
    for (const child of children) child.parentElement = parent;
  };

  const html = make("html", {
    rect: { x: 0, y: 0, width: 800, height: 600 },
    client: { left: 0, top: 0, width: 800, height: 600 },
  });
  html.scrollLeft = 0;
  html.scrollTop = 0;
  const rootParent = ancestorSvg
    ? make("svg", {
      parent: html,
      rect: { x: 100, y: 100, width: 24, height: 5.73333740234375 },
      client: { width: 24, height: 5 },
      attrs: { viewBox: "0 0 24 24", width: "24", height: "24" },
    })
    : html;
  const root = make("svg", {
    parent: rootParent,
    rect: { x: 100, y: 100, width: 24.086669921875, height: 5.73333740234375 },
    client: { width: 24, height: 5 },
    attrs: {
      viewBox: "0 0 24 24",
      width: "24",
      height: "24",
      ...(preserveAspectRatio === null ? {} : { preserveAspectRatio }),
    },
  });
  const path = make("path", {
    parent: root,
    rect: { x: 100, y: 100, width: 3.99932861328125, height: 4.106414794921875 },
    attrs: { d: attrD },
  });
  const group = wrapInGroup
    ? make("g", { parent: root, rect: { x: 100, y: 100, width: 24, height: 5.73333740234375 } })
    : null;
  const extra = extraChild
    ? make("rect", { parent: root, rect: { x: 0, y: 0, width: 24, height: 24 } })
    : null;
  if (group) {
    path.parentElement = group;
    attach(group, [path]);
    attach(root, extra ? [group, extra] : [group]);
  } else {
    attach(root, extra ? [path, extra] : [path]);
  }
  if (ancestorSvg) {
    attach(rootParent, [root]);
    attach(html, [rootParent]);
  } else {
    attach(html, [root]);
  }
  for (let index = 0; index < pathChildren; index++) {
    path.children.push(make("animate", { parent: path }));
  }

  document.documentElement = html;
  document.body = html;
  document.compatMode = "CSS1Compat";
  document.scrollingElement = html;
  document.querySelectorAll = () => [];
  styleOverrides.set(html, {
    overflowX: "auto",
    overflowY: "auto",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    zoom: "1",
    borderTopWidth: "0px",
    borderLeftWidth: "0px",
    paddingTop: "0px",
    paddingLeft: "0px",
    ...parentStyle,
  });
  if (ancestorSvg) {
    styleOverrides.set(rootParent, {
      overflowX: "hidden",
      overflowY: "hidden",
      transform: "none",
      ...parentStyle,
    });
  }
  styleOverrides.set(root, {
    width: "24px",
    height: "5.32812px",
    overflowX: "hidden",
    overflowY: "hidden",
    transform: "matrix(0.999857, 0.016916, -0.016916, 0.999857, 0, 0)",
    ...rootStyle,
  });
  styleOverrides.set(path, {
    transform: "none",
    stroke: "none",
    strokeWidth: "0px",
    markerStart: "none",
    markerMid: "none",
    markerEnd: "none",
    filter: "none",
    clipPath: "none",
    maskImage: "none",
    webkitMaskImage: "none",
    ...pathStyle,
  });
  if (!missingComputedD) computedDByElement.set(path, computedD ?? `path("${attrD}")`);

  return { document, window, html, rootParent, root, path, group, extra };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const OUTER_FRAME = {
  rect: { x: 100, y: 100, width: 24, height: 24 },
  client: { width: 24, height: 24 },
};

// Portable synthetic fixture for the narrow axis-reflected SVG viewport
// certificate. The direct path uses lines/arcs, not the cubic subset.
function buildAxisReflectedSvgFixture({
  rootStyle = {},
  pathStyle = {},
  parentStyle = {},
  rootRect = { x: 100, y: 100, width: 24, height: 24 },
  pathRect = { x: 108, y: 110, width: 8, height: 6 },
  pathD = "M6 9L12 15L18 9Z",
  rootTransform = "matrix(-1, 0, 0, -1, 0, 0)",
  pathTransform = "none",
  outerFrame = null,
  ancestorSvg = false,
  extraChild = false,
  wrapInGroup = false,
  pathChildren = 0,
  rootNamespace = SVG_NAMESPACE,
  pathNamespace = SVG_NAMESPACE,
  missingRootTransform = false,
  missingPathTransform = false,
  missingAncestorTransform = false,
} = {}) {
  const document = { documentElement: null, body: null, baseURI: "https://fixture.test/reflected-svg" };
  const styleOverrides = new Map();
  const missingTransform = new WeakSet();
  const allElements = [];
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle(element, pseudo) {
      const base = { ...BASE_STYLE, ...(styleOverrides.get(element) ?? {}) };
      if (missingTransform.has(element)) delete base.transform;
      if (pseudo) return base;
      base.getPropertyValue = property => {
        const key = String(property).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return base[key] === undefined || base[key] === null ? "" : String(base[key]);
      };
      return base;
    },
  };
  const make = (tag, {
    parent = null,
    rect = { x: 0, y: 0, width: 0, height: 0 },
    attrs = {},
    client = null,
    namespace = XHTML_NAMESPACE,
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
      querySelectorAll() {
        return [];
      },
    };
    element.clientWidth = client?.width ?? 0;
    element.clientHeight = client?.height ?? 0;
    element.clientLeft = client?.left ?? 0;
    element.clientTop = client?.top ?? 0;
    allElements.push(element);
    return element;
  };
  const attach = (parent, children) => {
    parent.children = children;
    parent.childNodes = children;
    parent.childElementCount = children.length;
    for (const child of children) child.parentElement = parent;
  };

  const html = make("html", {
    rect: { x: 0, y: 0, width: 800, height: 600 },
    client: { left: 0, top: 0, width: 800, height: 600 },
  });
  html.scrollLeft = 0;
  html.scrollTop = 0;
  const bridge = outerFrame !== null || ancestorSvg
    ? make(ancestorSvg ? "svg" : "div", {
      parent: html,
      rect: outerFrame?.rect ?? rootRect,
      client: outerFrame?.client ?? null,
      namespace: ancestorSvg ? SVG_NAMESPACE : XHTML_NAMESPACE,
    })
    : null;
  const root = make("svg", {
    parent: bridge ?? html,
    rect: rootRect,
    client: { width: rootRect.width, height: rootRect.height },
    attrs: { viewBox: "0 0 24 24", width: "24", height: "24" },
    namespace: rootNamespace,
  });
  const path = make("path", {
    parent: root,
    rect: pathRect,
    attrs: { d: pathD },
    namespace: pathNamespace,
  });
  const group = wrapInGroup
    ? make("g", { parent: root, rect: rootRect, namespace: SVG_NAMESPACE })
    : null;
  const extra = extraChild
    ? make("rect", { parent: root, rect: rootRect, namespace: SVG_NAMESPACE })
    : null;
  if (group) {
    path.parentElement = group;
    attach(group, [path]);
    attach(root, extra ? [group, extra] : [group]);
  } else {
    attach(root, extra ? [path, extra] : [path]);
  }
  if (bridge) {
    attach(bridge, [root]);
    attach(html, [bridge]);
  } else {
    attach(html, [root]);
  }
  for (let index = 0; index < pathChildren; index++) {
    path.children.push(make("animate", { parent: path, namespace: SVG_NAMESPACE }));
  }

  document.documentElement = html;
  document.body = html;
  document.compatMode = "CSS1Compat";
  document.scrollingElement = html;
  document.querySelectorAll = () => [];
  styleOverrides.set(html, {
    overflowX: "auto",
    overflowY: "auto",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    zoom: "1",
    borderTopWidth: "0px",
    borderLeftWidth: "0px",
    paddingTop: "0px",
    paddingLeft: "0px",
    transform: "none",
    ...(bridge === null ? parentStyle : {}),
  });
  if (bridge !== null) {
    styleOverrides.set(bridge, {
      overflowX: "hidden",
      overflowY: "hidden",
      transform: "none",
      ...parentStyle,
    });
  }
  styleOverrides.set(root, {
    width: "24px",
    height: "24px",
    overflowX: "hidden",
    overflowY: "hidden",
    transform: rootTransform,
    ...rootStyle,
  });
  styleOverrides.set(path, {
    transform: pathTransform,
    stroke: "none",
    strokeWidth: "1px",
    markerStart: "none",
    markerMid: "none",
    markerEnd: "none",
    filter: "none",
    clipPath: "none",
    maskImage: "none",
    webkitMaskImage: "",
    ...pathStyle,
  });
  if (missingRootTransform) missingTransform.add(root);
  if (missingPathTransform) missingTransform.add(path);
  if (missingAncestorTransform) missingTransform.add(bridge ?? html);

  return { document, window, html, bridge, root, path, group, extra, allElements };
}

function buildNegativeScaleHtmlFixture() {
  const document = { documentElement: null, body: null, baseURI: "https://fixture.test/negative-html" };
  const styleOverrides = new Map();
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle(element, pseudo) {
      const base = { ...BASE_STYLE, ...(styleOverrides.get(element) ?? {}) };
      if (pseudo) return base;
      base.getPropertyValue = property => {
        const key = String(property).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return base[key] === undefined || base[key] === null ? "" : String(base[key]);
      };
      return base;
    },
  };
  const make = (tag, { parent = null, rect = { x: 0, y: 0, width: 0, height: 0 }, client = null } = {}) => {
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      namespaceURI: XHTML_NAMESPACE,
      parentElement: parent,
      children: [],
      childNodes: [],
      childElementCount: 0,
      id: "",
      classList: [],
      ownerDocument: document,
      shadowRoot: null,
      isConnected: true,
      getAttribute() {
        return null;
      },
      hasAttribute() {
        return false;
      },
      getBoundingClientRect() {
        return { ...rect };
      },
      getClientRects() {
        return [{ ...rect }];
      },
      querySelectorAll() {
        return [];
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
  const html = make("html", {
    rect: { x: 0, y: 0, width: 800, height: 600 },
    client: { width: 800, height: 600 },
  });
  const div = make("div", {
    parent: html,
    rect: { x: 100, y: 100, width: 24, height: 24 },
    client: { width: 24, height: 24 },
  });
  attach(html, [div]);
  document.documentElement = html;
  document.body = html;
  document.querySelectorAll = () => [];
  styleOverrides.set(html, { overflowX: "hidden", overflowY: "hidden" });
  styleOverrides.set(div, {
    overflowX: "hidden",
    overflowY: "hidden",
    transform: "matrix(-1, 0, 0, -1, 0, 0)",
  });
  return { document, window, html, div };
}

function clippedRects(fixture) {
  const registry = createStableNodeRefRegistry("svg-clipping-test");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-clipping",
    documentRef: "fixture",
  });
  return element => snapshot.evidence.get(stableNodeRefFor(registry, element)).clippedRect;
}

test("contained cubic fill certificate accepts the actual unused stroke width and absent mask alias", () => {
  for (const options of [
    { pathStyle: { strokeWidth: "1px" } },
    { rootStyle: { webkitMaskImage: "" }, pathStyle: { webkitMaskImage: "" }, parentStyle: { webkitMaskImage: "" } },
    { pathStyle: { strokeWidth: "1px", webkitMaskImage: "" }, rootStyle: { webkitMaskImage: "" }, computedD: CONTAINED_PATH_CSS },
  ]) {
    const f = buildContainedSvgFixture(options);
    assert.equal(certifyContainedSvgOverflow(f.root, f.window)?.root, f.root);
    assert.equal(certifyContainedSvgOverflow(f.path, f.window)?.targetKind, "directPath");
  }
});

test("contained cubic certificate rejects malformed paths and unproved geometry", () => {
  const badPaths = [
    CONTAINED_PATH_ATTR.toLowerCase(), CONTAINED_PATH_ATTR + "Z", CONTAINED_PATH_ATTR.slice(0, -1),
    CONTAINED_PATH_ATTR + "garbage", CONTAINED_PATH_ATTR.replace("M12 4", "M12,,4"),
    CONTAINED_PATH_ATTR.replace("C8 4 4 8 4 12", "L4 12"),
    CONTAINED_PATH_ATTR.replace("M12 4", "M24 4"), CONTAINED_PATH_ATTR.replace("M12 4", "M24.1 4"),
  ];
  for (const attrD of badPaths) {
    const f = buildContainedSvgFixture({ attrD });
    assert.equal(certifyContainedSvgOverflow(f.path, f.window), null, attrD);
  }
  for (const options of [
    { missingComputedD: true }, { rootStyle: { width: undefined } },
    { rootStyle: { translate: undefined } }, { pathStyle: { translate: "1px" } },
    { rootStyle: { contain: "strict" } }, { preserveAspectRatio: "xMidYMid slice" },
    { preserveAspectRatio: "none" }, { preserveAspectRatio: "xMidYMid meet trailing" },
    { rootStyle: { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" } },
    { rootStyle: { transform: "matrix(1e308,0,0,1e308,0,0)" } },
    { rootStyle: { transform: "matrix(1e308,1e308,1e308,1e308,0,0)" } },
    { pathStyle: { stroke: "rgb(0, 0, 0)" } }, { pathStyle: { markerEnd: 'url("marker")' } },
    { pathStyle: { filter: "blur(1px)" } }, { pathStyle: { maskImage: 'url("mask")' } },
    { extraChild: true }, { wrapInGroup: true }, { ancestorSvg: true }, { pathChildren: 1 },
    { parentStyle: { transform: "matrix(2,0,0,2,0,0)" } },
  ]) {
    const f = buildContainedSvgFixture(options);
    assert.equal(certifyContainedSvgOverflow(f.path, f.window), null, JSON.stringify(options));
  }
  const foreign = buildContainedSvgFixture();
  foreign.root.namespaceURI = "http://www.w3.org/1999/xhtml";
  assert.equal(certifyContainedSvgOverflow(foreign.root, foreign.window), null);
});

test("certified rotated root and cubic fill retain measured bounds through the public observer", () => {
  const f = buildContainedSvgFixture();
  const clipped = clippedRects(f);
  assert.deepEqual(clipped(f.root), f.root.getBoundingClientRect());
  assert.deepEqual(clipped(f.path), f.path.getBoundingClientRect());
});

test("contained fill certificate preserves an outer ancestor clip", () => {
  const f = buildContainedSvgFixture();
  f.html.clientWidth = 102;
  const clipped = clippedRects(f);
  assert.deepEqual(clipped(f.root), { ...f.root.getBoundingClientRect(), width: 2 });
  assert.deepEqual(clipped(f.path), { ...f.path.getBoundingClientRect(), width: 2 });
});

test("observed nested SVG viewport and rectangular clipPath resolve to exact screen clip", () => {
  const fixture = buildSvgFixture();
  const clipped = clippedRects(fixture);
  assert.deepEqual(clipped(fixture.g), { x: 288.5, y: 389, width: 16, height: 16 });
  assert.deepEqual(clipped(fixture.shape), { x: 288.5, y: 389, width: 16, height: 16 });
});

test("complete clip children remain usable when childElementCount is not exposed", () => {
  const fixture = buildSvgFixture();
  for (const clip of fixture.clipPaths) delete clip.childElementCount;
  assert.deepEqual(clippedRects(fixture)(fixture.shape), { x: 288.5, y: 389, width: 16, height: 16 });
});

test("a rectangular clipPath smaller than the element shrinks the clipped box", () => {
  const fixture = buildSvgFixture({ clipPathPathD: "M25 25h50v50H25z" });
  const clipped = clippedRects(fixture);
  assert.deepEqual(clipped(fixture.g), { x: 292.5, y: 393, width: 8, height: 8 });
});

test("a rectangular clipPath <rect> child is supported", () => {
  const fixture = buildSvgFixture({ clipPathRect: { x: "25", y: "25", width: "50", height: "50" } });
  const clipped = clippedRects(fixture);
  assert.deepEqual(clipped(fixture.g), { x: 292.5, y: 393, width: 8, height: 8 });
});

test("path clip requires cyclic axis-aligned nonzero rectangle edges", () => {
  for (const [name, path] of [
    ["bowtie", "M0 0L100 100L0 100L100 0Z"],
    ["diagonal edge", "M0 0L100 0L100 50L0 100Z"],
  ]) {
    const fixture = buildSvgFixture({ clipPathPathD: path });
    assert.equal(clippedRects(fixture)(fixture.g), null, name);
  }
});

test("both rectangle path windings are accepted", () => {
  for (const path of ["M0 0h100v100H0z", "M0 0v100h100V0z"]) {
    const fixture = buildSvgFixture({ clipPathPathD: path });
    assert.deepEqual(clippedRects(fixture)(fixture.g), { x: 288.5, y: 389, width: 16, height: 16 });
  }
});

test("path clip rejects malformed or unsupported command grammar", () => {
  for (const [name, path] of [
    ["unmatched character", "M0 0h100v100H0z!"],
    ["double close", "M0 0h100v100H0zz"],
    ["command after close", "M0 0h100v100H0zL0 0"],
    ["second move", "M0 0h100v100H0zM5 5"],
  ]) {
    const fixture = buildSvgFixture({ clipPathPathD: path });
    assert.equal(clippedRects(fixture)(fixture.g), null, name);
  }
});

test("rect clip rejects malformed attributes and unsupported rounding", () => {
  for (const [name, attrs] of [
    ["invalid x", { x: "bad", y: "0", width: "100", height: "100" }],
    ["percentage x", { x: "50%", y: "0", width: "100", height: "100" }],
    ["invalid y", { x: "0", y: "bad", width: "100", height: "100" }],
    ["invalid rx", { x: "0", y: "0", width: "100", height: "100", rx: "bad" }],
    ["invalid ry", { x: "0", y: "0", width: "100", height: "100", ry: "bad" }],
    ["positive rx", { x: "0", y: "0", width: "100", height: "100", rx: "1" }],
    ["positive ry", { x: "0", y: "0", width: "100", height: "100", ry: "1" }],
  ]) {
    const fixture = buildSvgFixture({ clipPathRect: attrs });
    assert.equal(clippedRects(fixture)(fixture.g), null, name);
  }
});

test("rect clip treats absent x and y as zero", () => {
  const fixture = buildSvgFixture({ clipPathRect: { width: "50", height: "50" } });
  assert.deepEqual(clippedRects(fixture)(fixture.g), { x: 288.5, y: 389, width: 8, height: 8 });
});

test("SVG overflow clip uses the physical viewport, not letterboxed viewBox content", () => {
  const fixture = buildSvgFixture({
    nestedViewBox: "0 0 200 100",
    gClipPath: false,
    includeClipPath: false,
  });
  const clipped = clippedRects(fixture);
  assert.deepEqual(clipped(fixture.shape), { x: 288.5, y: 389, width: 16, height: 16 });
});

test("SVG mapping stays unknown for unsupported transforms and root border box", () => {
  for (const [name, options] of [
    ["translated intervening group", { gTransform: "matrix(1, 0, 0, 1, 10, 20)" }],
    ["scaled nested svg", { nestedTransform: "matrix(2, 0, 0, 2, 0, 0)" }],
    ["missing nested transform fact", { missingNestedTransform: true }],
    ["empty nested transform fact", { nestedTransform: "" }],
    ["percentage nested x", { nestedX: "100%" }],
    ["root border", { outerStyle: {
      borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
      borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
      borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)",
      borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
    } }],
    ["root padding", { outerStyle: {
      paddingTop: "1px", paddingRight: "1px", paddingBottom: "1px", paddingLeft: "1px",
    } }],
  ]) {
    const fixture = buildSvgFixture(options);
    assert.equal(clippedRects(fixture)(fixture.shape), null, name);
  }
});

test("geometrically different duplicate clip definitions stay unknown", () => {
  for (const [name, options] of [
    ["path definitions", { duplicates: true, duplicatePathD: "M0 0h100.0000005v100H0z" }],
    ["rect definitions", {
      clipPathRect: { x: "0", y: "0", width: "100", height: "100" },
      duplicates: true,
      duplicateRect: { x: "0", y: "0", width: "100.0000005", height: "100" },
    }],
  ]) {
    const fixture = buildSvgFixture(options);
    assert.equal(clippedRects(fixture)(fixture.g), null, name);
  }
});

test("unsupported SVG clip resources remain unknown", () => {
  for (const [name, options] of [
    ["triangle path", { clipPathPathD: "M0 0 L100 0 L50 100 Z" }],
    ["conflicting duplicate ids", { duplicates: true }],
    ["objectBoundingBox units", { clipPathUnits: "objectBoundingBox" }],
    ["missing resource", { includeClipPath: false }],
    ["rotated nested svg", { nestedTransform: "matrix(-0.882686, 0.469962, -0.469962, -0.882686, 0, 0)" }],
    ["nested svg without viewBox", { nestedViewBox: null }],
  ]) {
    const fixture = buildSvgFixture(options);
    const clipped = clippedRects(fixture);
    assert.equal(clipped(fixture.shape), null, name);
  }
});

test("axis-reflected svg certificate accepts an outermost reflected root with one non-cubic direct path", () => {
  const f = buildAxisReflectedSvgFixture();
  const rootCertificate = certifyAxisReflectedSvgViewport(f.root, f.window);
  assert.equal(rootCertificate?.root, f.root);
  assert.equal(rootCertificate?.targetKind, "root");
  assert.deepEqual(rootCertificate?.viewport, { x: 100, y: 100, width: 24, height: 24 });

  const pathCertificate = certifyAxisReflectedSvgViewport(f.path, f.window);
  assert.equal(pathCertificate?.root, f.root);
  assert.equal(pathCertificate?.targetKind, "directPath");
  assert.deepEqual(pathCertificate?.viewport, { x: 100, y: 100, width: 24, height: 24 });

  // A path crossing the viewport still certifies only the physical viewport;
  // clipping is the consumer's job, not this helper's.
  const crossing = buildAxisReflectedSvgFixture({
    pathRect: { x: 96, y: 102, width: 32, height: 10 },
  });
  assert.deepEqual(
    certifyAxisReflectedSvgViewport(crossing.path, crossing.window)?.viewport,
    { x: 100, y: 100, width: 24, height: 24 },
  );

  // Positive axis-aligned outer transforms keep the viewport rectangular.
  const scaledOuter = buildAxisReflectedSvgFixture({
    outerFrame: OUTER_FRAME,
    parentStyle: { transform: "matrix(2, 0, 0, 2, 0, 0)" },
  });
  assert.equal(certifyAxisReflectedSvgViewport(scaledOuter.root, scaledOuter.window)?.targetKind, "root");
});

test("axis-reflected svg certificate rejects missing and unsupported facts", () => {
  const cases = [
    ["missing root transform", { missingRootTransform: true }],
    ["positive-only root transform", { rootTransform: "matrix(1, 0, 0, 1, 0, 0)" }],
    ["angled root transform", { rootTransform: "matrix(0.999857, 0.016916, -0.016916, 0.999857, 0, 0)" }],
    ["zero diagonal root transform", { rootTransform: "matrix(-1, 0, 0, 0, 0, 0)" }],
    ["matrix3d root transform", { rootTransform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" }],
    ["root translate", { rootStyle: { translate: "1px" } }],
    ["root rotate", { rootStyle: { rotate: "1deg" } }],
    ["root filter", { rootStyle: { filter: "blur(1px)" } }],
    ["root mask", { rootStyle: { maskImage: 'url("mask")' } }],
    ["root clip-path", { rootStyle: { clipPath: 'url("#a")' } }],
    ["root contain", { rootStyle: { contain: "strict" } }],
    ["root border", { rootStyle: { borderTopWidth: "1px" } }],
    ["root padding", { rootStyle: { paddingTop: "1px" } }],
    ["missing root width", { rootStyle: { width: undefined } }],
    ["percentage root width", { rootStyle: { width: "100%" } }],
    ["zero root width", { rootStyle: { width: "0px" } }],
    ["missing path transform", { missingPathTransform: true }],
    ["path translate", { pathStyle: { translate: "1px" } }],
    ["path transform", { pathTransform: "matrix(-1, 0, 0, -1, 0, 0)" }],
    ["path stroke", { pathStyle: { stroke: "rgb(0, 0, 0)" } }],
    ["path marker", { pathStyle: { markerEnd: 'url("#m")' } }],
    ["path filter", { pathStyle: { filter: "blur(1px)" } }],
    ["path mask", { pathStyle: { maskImage: 'url("mask")' } }],
    ["path clip-path", { pathStyle: { clipPath: 'url("#a")' } }],
    ["extra child", { extraChild: true }],
    ["group wrapper", { wrapInGroup: true }],
    ["nested svg ancestor", { ancestorSvg: true }],
    ["path children", { pathChildren: 1 }],
    ["foreign root namespace", { rootNamespace: XHTML_NAMESPACE }],
    ["foreign path namespace", { pathNamespace: XHTML_NAMESPACE }],
    ["angled outer transform", {
      outerFrame: OUTER_FRAME,
      parentStyle: { transform: "matrix(0.999857, 0.016916, -0.016916, 0.999857, 0, 0)" },
    }],
    ["missing outer transform", { outerFrame: OUTER_FRAME, missingAncestorTransform: true }],
    ["outer independent transform", { outerFrame: OUTER_FRAME, parentStyle: { scale: "0.5" } }],
  ];
  for (const [name, options] of cases) {
    const f = buildAxisReflectedSvgFixture(options);
    assert.equal(certifyAxisReflectedSvgViewport(f.root, f.window), null, name);
    assert.equal(certifyAxisReflectedSvgViewport(f.path, f.window), null, name);
  }
});

test("negative-scale HTML remains unknown through the public observer", () => {
  const f = buildNegativeScaleHtmlFixture();
  assert.equal(certifyAxisReflectedSvgViewport(f.div, f.window), null);
  assert.equal(clippedRects(f)(f.div), null);
});

test("reflected svg root and crossing path stay measured through the public observer (pending live-dom integration)", () => {
  const f = buildAxisReflectedSvgFixture({
    pathRect: { x: 96, y: 102, width: 32, height: 10 },
  });
  const clipped = clippedRects(f);
  assert.deepEqual(clipped(f.root), { x: 100, y: 100, width: 24, height: 24 });
  assert.deepEqual(clipped(f.path), { x: 100, y: 102, width: 24, height: 10 });
});

test("reflected svg preserves outer ancestor clipping through the public observer (pending live-dom integration)", () => {
  const f = buildAxisReflectedSvgFixture({
    outerFrame: {
      rect: { x: 100, y: 100, width: 24, height: 24 },
      client: { width: 12, height: 24 },
    },
  });
  const clipped = clippedRects(f);
  assert.deepEqual(clipped(f.root), { x: 100, y: 100, width: 12, height: 24 });
  assert.deepEqual(clipped(f.path), { x: 108, y: 110, width: 4, height: 6 });
});
