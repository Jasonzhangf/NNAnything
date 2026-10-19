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

const viewport = { x: 0, y: 0, width: 1280, height: 720 };
const mainRect = { x: 164, y: 0, width: 1116, height: 720 };
const sidebarRect = { x: 12, y: 32, width: 140, height: 35 };

// These facts are explicit for the viewport-fixed proof. Missing facts are
// tested separately and must not be interpreted as absence.
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

function contains(rect, x, y) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function makeElement(styles, tagName, rect, parent = null, overrides = {}) {
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
    ...overrides,
  };
  element.clientLeft = 0;
  element.clientTop = 0;
  element.clientWidth = rect.width;
  element.clientHeight = rect.height;
  styles.set(element, { ...baseStyle, ...(overrides.style ?? {}) });
  delete element.style;
  return element;
}

function append(parent, ...children) {
  parent.children = children;
  parent.childNodes = children;
  parent.childElementCount = children.length;
}

function observeFixture(fixture) {
  const registry = createStableNodeRefRegistry("fixed-overflow");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "fixed-overflow",
    documentRef: "fixture",
  });
  const nodeFor = element => snapshot.observation.nodes.find(
    node => node.nodeRef === stableNodeRefFor(registry, element),
  );
  const evidenceFor = element => snapshot.evidence.get(stableNodeRefFor(registry, element));
  const candidates = checkCandidates(
    observeCandidates({ observation: snapshot.observation }),
    createFocusSpec(),
  );
  return { snapshot, registry, nodeFor, evidenceFor, candidates };
}

function makeMaskFixture({
  outerStyle = {},
  maskStyle = {},
  targetStyle = {},
  missingOuterFacts = [],
} = {}) {
  const styles = new Map();
  const html = makeElement(styles, "HTML", viewport, null, {
    style: { overflowX: "visible", overflowY: "visible" },
  });
  const shell = makeElement(styles, "DIV", viewport, html, {
    style: { overflowX: "visible", overflowY: "visible" },
  });
  const main = makeElement(styles, "DIV", mainRect, shell, {
    style: {
      position: "relative",
      overflowX: "hidden",
      overflowY: "scroll",
      ...outerStyle,
    },
  });
  const mask = makeElement(styles, "DIV", viewport, main, {
    style: {
      position: "fixed",
      overflowX: "auto",
      overflowY: "auto",
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      ...maskStyle,
    },
  });
  const sidebar = makeElement(styles, "A", sidebarRect, html, {
    style: { position: "static", ...targetStyle },
    getAttribute: name => name === "href" ? "/fixture" : null,
    hasAttribute: name => name === "href",
  });
  append(html, sidebar, shell);
  append(shell, main);
  append(main, mask);

  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => {
      const hits = [];
      if (contains(viewport, x, y)) hits.push(mask);
      if (contains(sidebarRect, x, y)) hits.push(sidebar);
      if (contains(viewport, x, y)) hits.push(html);
      return hits;
    },
  };
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    getComputedStyle: (element, pseudo) => {
      if (pseudo) return { content: "none" };
      const style = { ...styles.get(element) };
      if (element === main) {
        for (const key of missingOuterFacts) delete style[key];
      }
      return style;
    },
  };
  return { html, shell, main, mask, sidebar, document, window };
}

test("viewport-fixed mask retains the full viewport and occludes the sidebar", () => {
  const fixture = makeMaskFixture();
  const observed = observeFixture(fixture);
  const maskEvidence = observed.evidenceFor(fixture.mask);
  const sidebarEvidence = observed.evidenceFor(fixture.sidebar);
  const sidebarRef = stableNodeRefFor(observed.registry, fixture.sidebar);
  const sidebarNode = observed.nodeFor(fixture.sidebar);
  const sidebarSlot = observed.candidates.slots.find(slot => slot.nodeRef === sidebarRef);

  assert.deepEqual(observed.evidenceFor(fixture.main).rect, mainRect);
  assert.equal(fixture.main.clientWidth, 1116);
  assert.equal(fixture.main.clientHeight, 720);
  assert.deepEqual(maskEvidence.rect, viewport);
  assert.deepEqual(sidebarEvidence.rect, sidebarRect);
  assert.deepEqual(
    maskEvidence.clippedRect,
    viewport,
    `mask clippedRect=${JSON.stringify(maskEvidence.clippedRect)} sidebar foreground=${sidebarNode.foreground}`,
  );
  assert.equal(sidebarNode.foreground, "occluded");
  assert.deepEqual(sidebarNode.exposedRects, []);
  assert.equal(sidebarSlot.nodeRef, sidebarRef);
  assert.equal(sidebarSlot.status, "filtered_out");
  assert.deepEqual(sidebarSlot.reasons, ["occluded"]);
  assert.equal(observed.candidates.candidateRefs.includes(sidebarRef), false);
});

test("a fixed anchor's own overflow does not clip its box, but still clips ordinary descendants", () => {
  const styles = new Map();
  const html = makeElement(styles, "HTML", viewport);
  const anchor = makeElement(styles, "DIV", mainRect, html, {
    style: {
      position: "fixed",
      overflowX: "hidden",
      overflowY: "scroll",
    },
  });
  const descendant = makeElement(styles, "DIV", viewport, anchor);
  append(html, anchor);
  append(anchor, descendant);
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: () => [],
  };
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    getComputedStyle: (element, pseudo) => pseudo
      ? { content: "none" }
      : styles.get(element),
  };
  const observed = observeFixture({ document, window });

  assert.deepEqual(observed.evidenceFor(anchor).clippedRect, mainRect);
  assert.deepEqual(observed.evidenceFor(descendant).clippedRect, mainRect);
});

test("non-baseline containing-block facts leave the fixed mask clippedRect unknown", () => {
  for (const [label, outerStyle] of [
    ["identity transform", { transform: "matrix(1, 0, 0, 1, 0, 0)" }],
    ["external filter", { filter: "blur(1px)" }],
    ["contain layout", { contain: "layout" }],
    ["will-change transform", { willChange: "transform" }],
    ["content-visibility auto", { contentVisibility: "auto" }],
  ]) {
    const fixture = makeMaskFixture({ outerStyle });
    const observed = observeFixture(fixture);
    assert.equal(observed.evidenceFor(fixture.mask).clippedRect, null, label);
  }
});

test("missing fixed-containing-block facts leave the fixed mask clippedRect unknown", () => {
  for (const [label, missingOuterFacts] of [
    ["missing will-change", ["willChange"]],
    ["missing content-visibility", ["contentVisibility"]],
  ]) {
    const fixture = makeMaskFixture({ missingOuterFacts });
    const observed = observeFixture(fixture);
    assert.equal(observed.evidenceFor(fixture.mask).clippedRect, null, label);
  }
});

test("ordinary overflow still clips a non-fixed descendant", () => {
  const fixture = makeMaskFixture({
    maskStyle: { position: "static" },
  });
  const observed = observeFixture(fixture);

  assert.deepEqual(observed.evidenceFor(fixture.mask).clippedRect, mainRect);
});

test("explicit legacy clipping remains in effect for a fixed mask", () => {
  const fixture = makeMaskFixture({
    outerStyle: {
      position: "absolute",
      clip: "rect(0px, 0px, 0px, 0px)",
    },
  });
  const observed = observeFixture(fixture);

  assert.deepEqual(observed.evidenceFor(fixture.mask).clippedRect, {
    x: viewport.x,
    y: viewport.y,
    width: 0,
    height: 0,
  });
});
