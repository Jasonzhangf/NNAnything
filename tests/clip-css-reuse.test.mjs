import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const xhtml = "http://www.w3.org/1999/xhtml";
const viewport = { x: 0, y: 0, width: 1200, height: 900 };
const clipCssKeys = [
  "translate",
  "rotate",
  "scale",
  "perspective",
  "transform",
  "contain",
  "clipPath",
  "overflowX",
  "overflowY",
];
const baseStyle = {
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
  transformStyle: "flat",
  zoom: "1",
  overflowX: "visible",
  overflowY: "visible",
  overflowClipMargin: "0px",
  clip: "auto",
  clipPath: "none",
  contain: "none",
  willChange: "auto",
  contentVisibility: "visible",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "",
  filter: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "",
  mixBlendMode: "normal",
  isolation: "auto",
  pointerEvents: "auto",
  boxShadow: "none",
  textShadow: "none",
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
  borderImageSource: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  objectFit: "fill",
  objectPosition: "50% 50%",
  cursor: "auto",
  content: "none",
};

function readScope() {
  const frames = new Error().stack?.split("\n") ?? [];
  const getterIndex = frames.findIndex(frame => frame.includes("Object.get [as "));
  const frame = frames[getterIndex + 1]?.trim() ?? "";
  const caller = /^at\s+([^\s(]+)/.exec(frame)?.[1] ?? "";
  const underClippedBox = frames.some(line => /^\s*at clippedBox \(/.test(line));
  const throughReader = frames.some(line => /^\s*at readClippedBoxCss \(/.test(line));
  return underClippedBox && (caller === "clippedBox" || throughReader) ? "clippedBox" : "other";
}

function styleAcquisitionScope() {
  const frames = new Error().stack?.split("\n") ?? [];
  if (frames.some(line => /^\s*at readClippedBoxCss \(/.test(line))) return "reader";
  if (frames.some(line => /^\s*at clippedBox \(/.test(line))) return "clippedBox";
  return "other";
}

function trackedStyle(elementKey, values, reads) {
  const style = { ...values };
  for (const key of clipCssKeys) {
    Object.defineProperty(style, key, {
      configurable: true,
      enumerable: true,
      get() {
        const scope = readScope();
        const byElement = reads.get(key) ?? new Map();
        const count = byElement.get(elementKey) ?? { clippedBox: 0, other: 0 };
        count[scope] += 1;
        byElement.set(elementKey, count);
        reads.set(key, byElement);
        return values[key];
      },
      set(value) {
        values[key] = value;
      },
    });
  }
  return { style, values };
}

function makeFixture() {
  const byKey = new Map();
  const keyByElement = new Map();
  const styles = new Map();
  const valueByElement = new Map();
  const reads = new Map(clipCssKeys.map(key => [key, new Map()]));
  const hitCalls = [];

  const element = (key, tagName, rect, parentKey = null, options = {}) => {
    const candidate = {
      nodeType: 1,
      tagName,
      namespaceURI: options.namespaceURI ?? xhtml,
      ownerDocument: undefined,
      children: [],
      childNodes: options.text ? [{ nodeType: 3, textContent: options.text }] : [],
      childElementCount: 0,
      clientWidth: rect.width,
      clientHeight: rect.height,
      clientLeft: options.clientLeft ?? 0,
      clientTop: options.clientTop ?? 0,
      scrollLeft: 0,
      scrollTop: 0,
      id: options.id ?? "",
      classList: options.classList ?? [],
      isContentEditable: false,
      isConnected: true,
      tabIndex: -1,
      key,
      rect,
      getAttribute: name => options.attributes?.[name] ?? null,
      hasAttribute: name => Object.hasOwn(options.attributes ?? {}, name),
      matches: () => false,
      getBoundingClientRect: () => ({ ...rect }),
      getClientRects: () => (options.fragments ?? [{ ...rect }]).map(fragment => ({ ...fragment })),
      querySelectorAll: () => [],
      ...(options.element ?? {}),
    };
    candidate.parentElement = parentKey === null ? null : byKey.get(parentKey);
    byKey.set(key, candidate);
    keyByElement.set(candidate, key);
    const values = { ...baseStyle, ...(options.style ?? {}) };
    const tracked = trackedStyle(key, values, reads);
    styles.set(candidate, tracked.style);
    valueByElement.set(key, tracked.values);
    return candidate;
  };

  const html = element("html", "HTML", viewport, null, {
    style: { overflowX: "visible", overflowY: "visible" },
  });
  const body = element("body", "BODY", viewport, "html");

  const branch = (name, rootRect, leafRect, depth, rootStyle, leafStyle = {}) => {
    const root = element(`${name}-root`, "SECTION", rootRect, "body", { style: rootStyle });
    const wrappers = [root];
    let parent = root;
    for (let index = 1; index < depth; index++) {
      const wrapper = element(`${name}-${index}`, "SPAN", rootRect, parent.key);
      parent.children = [wrapper];
      parent.childNodes = [wrapper];
      parent.childElementCount = 1;
      wrappers.push(wrapper);
      parent = wrapper;
    }
    const leaf = element(`${name}-leaf`, "DIV", leafRect, parent.key, {
      text: name,
      style: { position: "relative", backgroundColor: "rgb(190, 40, 40)", ...leafStyle },
    });
    parent.children = [leaf];
    parent.childNodes = [leaf];
    parent.childElementCount = 1;
    wrappers.push(leaf);
    return { root, wrappers, leaf };
  };

  const branchA = branch(
    "a",
    { x: 40, y: 80, width: 220, height: 300 },
    { x: 60, y: 100, width: 80, height: 40 },
    16,
    {
      position: "fixed",
      overflowX: "visible",
      overflowY: "visible",
      borderTopLeftRadius: "12px",
      borderTopRightRadius: "12px",
      borderBottomRightRadius: "12px",
      borderBottomLeftRadius: "12px",
    },
  );
  const branchB = branch(
    "b",
    { x: 300, y: 80, width: 200, height: 260 },
    { x: 280, y: 60, width: 240, height: 300 },
    16,
    {
      position: "relative",
      overflowX: "clip",
      overflowY: "clip",
      overflowClipMargin: "content-box",
    },
  );
  const branchC = branch(
    "c",
    { x: 540, y: 80, width: 180, height: 220 },
    { x: 560, y: 100, width: 120, height: 44 },
    8,
    {},
    { transform: "matrix(-1, 0, 0, -1, 700, 0)" },
  );

  const tool = element("tool", "DIV", { x: 0, y: 0, width: 10, height: 10 }, "body", {
    id: "codex-browser-sidebar-comments-root",
  });
  const toolChild = element("tool-child", "SPAN", { x: 0, y: 0, width: 10, height: 10 }, "tool");
  tool.children = [toolChild];
  tool.childNodes = [toolChild];
  tool.childElementCount = 1;
  tool.querySelectorAll = () => [toolChild];

  body.children = [branchA.root, branchB.root, branchC.root, tool];
  body.childNodes = body.children;
  body.childElementCount = body.children.length;
  html.children = [body];
  html.childNodes = html.children;
  html.childElementCount = 1;

  const hitOrder = [branchA.leaf, branchB.leaf, branchC.leaf, body, html];
  const contains = (candidate, x, y) => {
    const rect = candidate.rect;
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  };
  const document = {
    documentElement: html,
    body,
    baseURI: "https://fixture.test/clip-css-reuse",
    compatMode: "CSS1Compat",
    scrollingElement: html,
    designMode: "off",
    activeElement: branchB.leaf,
    elementsFromPoint: (x, y) => {
      const hits = hitOrder.filter(candidate => contains(candidate, x, y));
      hitCalls.push({ x, y, order: hits.map(candidate => keyByElement.get(candidate)) });
      return hits;
    },
  };
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    devicePixelRatio: 1,
    visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
    getComputedStyle: (candidate, pseudo) => pseudo
      ? { content: "none" }
      : styles.get(candidate) ?? baseStyle,
  };

  return {
    document,
    window,
    html,
    body,
    branchA,
    branchB,
    branchC,
    tool,
    expectedElements: [html, body, ...branchA.wrappers, ...branchB.wrappers, ...branchC.wrappers],
    reads,
    hitCalls,
    keyByElement,
    styleFor: key => styles.get(byKey.get(key)),
    valuesFor: key => valueByElement.get(key),
  };
}

function clipReadCount(fixture, scope = "clippedBox") {
  const counts = new Map();
  for (const [key, byElement] of fixture.reads) {
    let total = 0;
    for (const count of byElement.values()) total += count[scope];
    counts.set(key, total);
  }
  return counts;
}

function encode(value) {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Map) {
    return {
      $type: "Map",
      entries: Array.from(value, ([key, entry]) => [encode(key), encode(entry)]),
    };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  }
  return value;
}

function projectSnapshot(fixture, registry, snapshot) {
  const resolveElements = snapshot.observation.nodes.map(node => {
    const element = snapshot.resolveElement(node.nodeRef);
    return {
      nodeRef: node.nodeRef,
      resolvedKey: element === null ? null : fixture.keyByElement.get(element) ?? "unknown",
    };
  });
  return {
    snapshot: encode({
      snapshotRef: snapshot.snapshotRef,
      documentRef: snapshot.documentRef,
      frameRef: snapshot.frameRef,
      pageRef: snapshot.pageRef,
      observation: snapshot.observation,
      itemObservations: snapshot.itemObservations,
      properties: snapshot.properties,
      evidence: snapshot.evidence,
      coverage: snapshot.coverage,
      explorationInputs: snapshot.explorationInputs,
    }),
    resolveElements,
    expectedResolveElements: fixture.expectedElements.map(element => ({
      nodeRef: stableNodeRefFor(registry, element),
      resolvedKey: fixture.keyByElement.get(element),
    })),
    nativeHitCalls: fixture.hitCalls,
  };
}

function observeFixture(fixture) {
  const registry = createStableNodeRefRegistry("clip-css-reuse");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "clip-css-reuse",
    documentRef: "fixture",
  });
  return { registry, snapshot };
}

test("public snapshot projection is complete and deterministic", () => {
  const fixture = makeFixture();
  const { registry, snapshot } = observeFixture(fixture);
  const projection = projectSnapshot(fixture, registry, snapshot);
  assert.deepEqual(projection.resolveElements, projection.expectedResolveElements);
  assert.ok(projection.nativeHitCalls.length > 0);
  assert.ok(projection.nativeHitCalls.every(call => Array.isArray(call.order)));
  assert.deepEqual(
    snapshot.observation.nodes.map(node => node.nodeRef),
    fixture.expectedElements.map(element => stableNodeRefFor(registry, element)),
  );
  const expectedPath = process.env.CSS_CANDIDATE_EXPECTED_SNAPSHOT;
  if (expectedPath) {
    assert.deepEqual(projection, JSON.parse(readFileSync(expectedPath, "utf8")));
  }
  const outputPath = process.env.CSS_CANDIDATE_SNAPSHOT_OUT;
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`);
});

test("clippedBox CSS reuse consumes its acquired computed style", () => {
  const fixture = makeFixture();
  const getComputedStyle = fixture.window.getComputedStyle;
  const acquisitions = { clippedBox: 0, reader: 0, other: 0 };
  fixture.window.getComputedStyle = function countingGetComputedStyle(element, pseudo) {
    acquisitions[styleAcquisitionScope()] += 1;
    return getComputedStyle(element, pseudo);
  };

  observeFixture(fixture);

  assert.ok(acquisitions.clippedBox > 0, "fixture must exercise clippedBox style acquisition");
  assert.equal(
    acquisitions.reader,
    0,
    `readClippedBoxCss reacquired computed style ${acquisitions.reader} times`,
  );
});

test("nine clippedBox CSS fields are read at most once per element", () => {
  const fixture = makeFixture();
  const { registry, snapshot } = observeFixture(fixture);
  const nodeFor = element => snapshot.observation.nodes.find(
    node => node.nodeRef === stableNodeRefFor(registry, element),
  );

  const repeated = [];
  for (const [key, byElement] of fixture.reads) {
    for (const [elementKey, counts] of byElement) {
      if (counts.clippedBox > 1) repeated.push(`${elementKey}.${key}=${counts.clippedBox}`);
    }
  }
  assert.deepEqual(repeated, [], `clippedBox repeated CSS reads: ${repeated.join(", ")}`);

  const totals = clipReadCount(fixture);
  for (const key of clipCssKeys) assert.ok((totals.get(key) ?? 0) > 0, `${key} was not reached`);
  assert.ok(clipReadCount(fixture, "other").values().some(count => count > 0));

  assert.equal(snapshot.observation.nodes.length, fixture.expectedElements.length);
  assert.deepEqual(nodeFor(fixture.branchA.leaf).clippedRect, { x: 60, y: 100, width: 80, height: 40 });
  assert.deepEqual(nodeFor(fixture.branchB.leaf).clippedRect, { x: 300, y: 80, width: 200, height: 260 });
  assert.deepEqual(nodeFor(fixture.branchC.leaf).clippedRect, { x: 560, y: 100, width: 120, height: 44 });
});

test("missing, undefined, null, and empty clip CSS values stay uninterpreted", () => {
  const cases = [
    ["missing", (style) => delete style.transform],
    ["undefined", (_style, values) => { values.transform = undefined; }],
    ["null", (_style, values) => { values.transform = null; }],
    ["empty", (_style, values) => { values.transform = ""; }],
  ];
  for (const [name, apply] of cases) {
    const fixture = makeFixture();
    apply(fixture.styleFor("b-root"), fixture.valuesFor("b-root"));
    const { registry, snapshot } = observeFixture(fixture);
    const leafNode = snapshot.observation.nodes.find(
      node => node.nodeRef === stableNodeRefFor(registry, fixture.branchB.leaf),
    );
    assert.equal(leafNode.clippedRect, null, `${name} transform must not gain a default`);
    if (name !== "missing") {
      assert.equal(fixture.reads.get("transform").get("b-root").clippedBox, 1,
        `${name} transform must keep one cache entry`);
    }
  }
});

test("a getter error propagates unchanged and does not store a successful value", () => {
  const fixture = makeFixture();
  const original = new Error("clip getter failed");
  let calls = 0;
  Object.defineProperty(fixture.styleFor("b-root"), "transform", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      throw original;
    },
  });
  assert.throws(() => observeFixture(fixture), error => error === original);
  assert.equal(calls, 1);
});

test("unreached clip CSS fields are not pre-read", () => {
  const fixture = makeFixture();
  fixture.valuesFor("b-root").translate = "translateX(1px)";
  observeFixture(fixture);
  for (const key of ["transform", "contain", "clipPath", "overflowX", "overflowY"]) {
    assert.equal(fixture.reads.get(key).get("b-root")?.clippedBox ?? 0, 0,
      `${key} was read after translate made the chain unknown`);
  }
});

test("a changing field uses its first value inside one invocation", () => {
  const fixture = makeFixture();
  const style = fixture.styleFor("c-root");
  let clippedBoxReads = 0;
  Object.defineProperty(style, "transform", {
    configurable: true,
    enumerable: true,
    get() {
      if (readScope() !== "clippedBox") return "none";
      clippedBoxReads += 1;
      return clippedBoxReads === 1 ? "none" : "matrix(1, 1, 0, 1, 0, 0)";
    },
  });
  fixture.valuesFor("c-leaf").transform = "none";
  const { registry, snapshot } = observeFixture(fixture);
  const leafNode = snapshot.observation.nodes.find(
    node => node.nodeRef === stableNodeRefFor(registry, fixture.branchC.leaf),
  );
  assert.equal(clippedBoxReads, 1);
  assert.deepEqual(leafNode.clippedRect, { x: 560, y: 100, width: 120, height: 44 });
});

test("a new invocation rereads the same element and style handle", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("clip-css-cross-invocation");
  const observe = snapshotRef => observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef,
    documentRef: "fixture",
  });
  const leafRef = stableNodeRefFor(registry, fixture.branchB.leaf);
  const first = observe("first");
  assert.deepEqual(first.observation.nodes.find(node => node.nodeRef === leafRef).clippedRect,
    { x: 300, y: 80, width: 200, height: 260 });
  const readsAfterFirst = fixture.reads.get("transform").get("b-root").clippedBox;

  fixture.valuesFor("b-root").transform = "matrix(1, 1, 0, 1, 0, 0)";
  const second = observe("second");
  const readsAfterSecond = fixture.reads.get("transform").get("b-root").clippedBox;
  assert.ok(readsAfterSecond > readsAfterFirst);
  assert.equal(second.observation.nodes.find(node => node.nodeRef === leafRef).clippedRect, null);
});
