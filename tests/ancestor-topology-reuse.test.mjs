import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 1200, height: 900 };
const xhtml = "http://www.w3.org/1999/xhtml";

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

const selectedConsumers = [
  "at clippedBox ",
  "at roundedClippingAncestor ",
  "at ancestorRoundedClearCorners ",
];

function prototypeRect(rect) {
  const prototype = {};
  for (const [key, value] of Object.entries(rect)) {
    Object.defineProperty(prototype, key, { get: () => value, enumerable: false });
  }
  return Object.create(prototype);
}

function makeFixture() {
  let selectedAncestorReads = 0;
  const byKey = new Map();
  const styles = new Map();

  const element = (key, tagName, rect, parentKey = null, options = {}) => {
    const candidate = {
      nodeType: 1,
      tagName,
      namespaceURI: xhtml,
      children: [],
      childNodes: options.text ? [{ nodeType: 3, textContent: options.text }] : [],
      childElementCount: 0,
      clientWidth: rect.width,
      clientHeight: rect.height,
      clientLeft: 0,
      clientTop: 0,
      id: options.id ?? "",
      classList: [],
      isContentEditable: false,
      isConnected: true,
      tabIndex: -1,
      getAttribute: name => options.attributes?.[name] ?? null,
      hasAttribute: name => Object.hasOwn(options.attributes ?? {}, name),
      matches: () => false,
      getBoundingClientRect: options.prototypeRect
        ? () => prototypeRect(rect)
        : () => ({ ...rect }),
      getClientRects: () => [{ ...rect }],
      querySelectorAll: () => [],
      key,
      rect,
    };
    byKey.set(key, candidate);
    styles.set(candidate, { ...baseStyle, ...(options.style ?? {}) });
    Object.defineProperty(candidate, "parentElement", {
      get: () => {
        const stack = new Error().stack ?? "";
        if (selectedConsumers.some(fragment => stack.includes(fragment))) selectedAncestorReads += 1;
        return parentKey === null ? null : byKey.get(parentKey);
      },
    });
    return candidate;
  };

  const html = element("html", "HTML", viewport);
  const body = element("body", "BODY", viewport, "html");
  const tool = element("tool", "DIV", { x: 0, y: 0, width: 10, height: 10 }, "body", {
    id: "codex-browser-sidebar-comments-root",
  });
  const toolChild = element("tool-child", "SPAN", { x: 0, y: 0, width: 10, height: 10 }, "tool");
  tool.children = [toolChild];
  tool.childNodes = [toolChild];
  tool.childElementCount = 1;
  tool.querySelectorAll = () => [toolChild];

  const branch = (name, rootRect, leafRect, depth, style) => {
    const root = element(`${name}-root`, "SECTION", rootRect, "body", { style });
    let parent = root;
    const wrappers = [root];
    for (let index = 1; index < depth; index++) {
      const wrapper = element(`${name}-${index}`, "SPAN", rootRect, parent.key);
      parent.children = [wrapper];
      parent.childNodes = [wrapper];
      parent.childElementCount = 1;
      wrappers.push(wrapper);
      parent = wrapper;
    }
    const leaf = element(
      `${name}-leaf`,
      "SPAN",
      leafRect,
      parent.key,
      {
        text: name,
        style: { position: "relative", backgroundColor: "rgb(190, 40, 40)" },
        prototypeRect: name === "a",
      },
    );
    parent.children = [leaf];
    parent.childNodes = [leaf];
    parent.childElementCount = 1;
    wrappers.push(leaf);
    return { root, wrappers, leaf };
  };

  const branchA = branch(
    "a",
    { x: 40, y: 80, width: 220, height: 300 },
    { x: 20, y: 60, width: 260, height: 340 },
    16,
    {
      position: "relative",
      overflowX: "hidden",
      overflowY: "hidden",
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
      borderTopLeftRadius: "5px",
      borderTopRightRadius: "5px",
      borderBottomRightRadius: "5px",
      borderBottomLeftRadius: "5px",
    },
  );
  const branchC = branch(
    "c",
    { x: 540, y: 80, width: 180, height: 220 },
    { x: 560, y: 100, width: 120, height: 44 },
    8,
    {},
  );

  body.children = [branchA.root, branchB.root, branchC.root];
  body.childNodes = body.children;
  body.childElementCount = body.children.length;
  html.children = [body, tool];
  html.childNodes = html.children;
  html.childElementCount = html.children.length;

  const document = {
    documentElement: html,
    body,
    baseURI: "https://fixture.test/page",
    compatMode: "CSS1Compat",
    scrollingElement: html,
    designMode: "off",
    activeElement: branchB.leaf,
    elementsFromPoint: (x, y) => {
      const leaves = [branchA.leaf, branchB.leaf, branchC.leaf];
      const leaf = leaves.find(candidate => x >= candidate.rect.x && x < candidate.rect.x + candidate.rect.width
        && y >= candidate.rect.y && y < candidate.rect.y + candidate.rect.height);
      return leaf ? [leaf, html] : [html];
    },
  };
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    devicePixelRatio: 1,
    visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
    getComputedStyle: (candidate, pseudo) => pseudo ? { content: "none" } : styles.get(candidate) ?? baseStyle,
  };

  return {
    document,
    window,
    html,
    body,
    tool,
    branchA,
    branchB,
    branchC,
    expectedElements: [html, body, ...branchA.wrappers, ...branchB.wrappers, ...branchC.wrappers],
    selectedReadCount: () => selectedAncestorReads,
  };
}

test("existing DFS ancestry is reused by clipping and rounded-clipping consumers", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("ancestor-topology-reuse");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "ancestor-topology-reuse",
    documentRef: "fixture",
  });

  const selectedReads = fixture.selectedReadCount();
  assert.ok(selectedReads <= 64,
    `selected consumers performed ${selectedReads} live parentElement reads; reuse the DFS ancestry instead`);
  const nodeFor = candidate => snapshot.observation.nodes.find(
    node => node.nodeRef === stableNodeRefFor(registry, candidate),
  );
  assert.deepEqual(nodeFor(fixture.branchA.leaf).rect, { x: 20, y: 60, width: 260, height: 340 });
  assert.deepEqual(nodeFor(fixture.branchA.leaf).clippedRect, { x: 40, y: 80, width: 220, height: 300 });
  assert.deepEqual(nodeFor(fixture.branchB.leaf).clippedRect, { x: 300, y: 80, width: 200, height: 260 });
  assert.deepEqual(nodeFor(fixture.branchC.leaf).clippedRect, { x: 560, y: 100, width: 120, height: 44 });
  assert.equal(snapshot.coverage.excludedElementCount, 2);
  assert.ok(snapshot.observation.nodes.every(node => snapshot.properties.has(node.nodeRef)
    && snapshot.evidence.has(node.nodeRef)
    && snapshot.itemObservations.some(item => item.nodeRef === node.nodeRef)
    && snapshot.explorationInputs?.has(node.nodeRef)));
  assert.deepEqual(
    snapshot.observation.nodes.map(node => node.nodeRef),
    fixture.expectedElements.map(candidate => stableNodeRefFor(registry, candidate)),
  );
});

test("sibling branches retain their own ancestor clip domains", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("ancestor-branch-isolation");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "ancestor-branch-isolation",
    documentRef: "fixture",
  });
  const nodeFor = candidate => snapshot.observation.nodes.find(
    node => node.nodeRef === stableNodeRefFor(registry, candidate),
  );
  assert.notDeepEqual(nodeFor(fixture.branchA.leaf).clippedRect, nodeFor(fixture.branchB.leaf).clippedRect);
  assert.deepEqual(nodeFor(fixture.branchA.leaf).foreground, "visible");
  assert.deepEqual(nodeFor(fixture.branchB.leaf).foreground, "visible");
});
